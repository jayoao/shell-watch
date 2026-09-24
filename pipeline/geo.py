"""把違規紀錄按公司的「商工登記地址」聚合到鄉鎮市區，給地圖頁用。

    python -m pipeline.geo

要先有：
    data/records.csv    ← python -m pipeline.build
    data/gcis.duckdb    ← python -m gcis.fetch && python -m gcis.load
    pipeline/centroids.json

產出 web/public/data/osha_district.json（同時複製一份到 web/src/data/）。

────────────────────────────────────────────────────────────────
⚠ 這張圖畫的是【登記地址】，不是【事故發生地點】
────────────────────────────────────────────────────────────────
職安法 74,658 筆裡只有 189 筆填了發生地點（0.25%）—— 全台可用的
座標大約只有 200 個，用發生地點畫圖做不出來。

所以我們退而求其次，用公司在商工登記的**登記地址**。這是一個
真實的、可查證的欄位，但它回答的是另一個問題：

    發生地點 → 「哪裡出事」          ← 做不到
    登記地址 → 「被處分的事業單位登記在哪」  ← 這是我們畫的

兩者在營造業特別容易差很遠（公司登記在台北、工地在桃園）。
**頁面上必須寫明白**，不能讓使用者以為那是職災地圖。
寫不清楚的話，這張圖就是一張看起來很專業的錯誤資訊。

────────────────────────────────────────────────────────────────
座標從哪來
────────────────────────────────────────────────────────────────
pipeline/centroids.json 是 377 個鄉鎮市區的幾何中心，從 g0v/twgeojson
的鄉鎮市區界線算出來的（取每個區面積最大的那一圈的形心，避免離島
小島把中心點拉到海裡）。桃園縣的 13 個鄉鎮市已改成桃園市的區。

⚠ 形心是「這個區的中間」，不是任何一筆紀錄的實際位置。
   圓點畫在區的中心，代表的是整個區的量，不是一個點的量。
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                 # noqa: E402
from gcis.constants import CLOSED_STATUS                           # noqa: E402
from pipeline.hazard import classify, is_fatal                     # noqa: E402
from pipeline.join import mask_match, norm_addr, norm_name         # noqa: E402

RECORDS = Path("data/records.csv")
DB = Path("data/gcis.duckdb")
CENTROIDS = Path(__file__).with_name("centroids.json")
OUT = Path("web/public/data/osha_district.json")
OUT_SRC = Path("web/src/data/osha_district.json")

# 行政救濟尚未終結 —— 跟 web 端 OshaMap.tsx 的 APPEAL_PENDING 同一份判準。
PENDING = ("訴願中", "審理中", "行政救濟中", "提起訴願", "訴訟中", "尚未確定")


def load_centroids() -> tuple[dict[str, list[float]], dict[str, list[str]]]:
    cent = json.loads(CENTROIDS.read_text(encoding="utf-8"))
    by_county: dict[str, list[str]] = defaultdict(list)
    for key in cent:
        by_county[key[:3]].append(key[3:])
    # 長的先試 —— 「東區」與「東勢區」共存時不能先吃到短的
    for towns in by_county.values():
        towns.sort(key=len, reverse=True)
    return cent, dict(by_county)


# ⚠⚠ 行政區改制對照。**兩個方向都要有**，因為錯位是雙向的：
#
#   桃園縣 → 桃園市      2014 升格。**地址是舊的**（商工登記沒有跟著改），
#                        我們的區名是新的 —— 89 家對不到。
#   員林鎮 → 員林市      2015 升格。**地址是新的**，我們的區名是舊的
#   頭份鎮 → 頭份市      （界線檔來自 g0v/twgeojson，沿用改制前名稱）
#                        —— 206 家對不到。
#
# ⚠ 這不是模糊比對。每一條都是一次有公告依據的行政區改制，
#   一對一、可查證，跟「名字看起來很像」是兩回事。
# ⚠ 升格成直轄市時，底下的縣轄市／鄉／鎮**同時**改制為區
#   —— 桃園市→桃園區、中壢市→中壢區、蘆竹鄉→蘆竹區…
#   只換縣市名不夠，89 家的地址是「桃園縣桃園市…」，
#   換完縣市會變成「桃園市」配「桃園市…」，還是對不到。
COUNTY_ALIAS = {"桃園縣": "桃園市"}
UPGRADED = set(COUNTY_ALIAS.values())      # 這些縣市底下要試舊的市／鄉／鎮寫法
TOWN_ALIAS = {
    ("彰化縣", "員林鎮"): "員林市",
    ("苗栗縣", "頭份鎮"): "頭份市",
}
# 反向：地址寫新名，而我們的鍵是舊名時用
TOWN_ALIAS_REV = {(c, new): old for (c, old), new in TOWN_ALIAS.items()}

# ⚠ 園區不是行政區。「新竹科學園區新竹市東區力行路11號」的前三字是
#   「新竹科」，不是縣市 —— 81 家因此整批落空。真正的縣市區就寫在
#   後面，把前綴剝掉就對得到了。
PARK_PREFIX = re.compile(
    r"^(?:[^市縣]{0,6}?(?:科學工業園區|科學園區|加工出口區|工業區|科技園區))")


def to_district(addr: str, by_county: dict[str, list[str]]) -> str:
    """「新北市中和區安和路7號」→「新北市中和區」。對不到回空字串。

    ⚠ 不做模糊比對。對不到就是對不到，寧可少算也不要把紀錄放到錯的區 ——
      地圖上一個放錯位置的圓點，比一個不存在的圓點更難發現。

    ⚠⚠ 但「對不到」不可以是安靜的。實測 25,635 家裡有 540 家落空、
      涉及 1,088 筆職安法裁處，其中 245 家**同時出現在點位圖層** ——
      同一張地圖的兩個圖層對同一家公司說法不一致。
      成因查清楚之後，三類是可以救的（見上面的對照表），
      剩下「有縣市但沒寫區」那一類救不了，那就要**數出來報給使用者**，
      不是當作不存在。
    """
    if len(addr) < 6:
        return ""
    a = PARK_PREFIX.sub("", addr, count=1)
    if len(a) < 6:
        a = addr
    county = COUNTY_ALIAS.get(a[:3], a[:3])
    towns = by_county.get(county)
    if not towns:
        return ""
    rest = a[3:]
    upgraded = county in UPGRADED
    for t in towns:
        if rest.startswith(t):
            return county + t
        # 地址寫改制後的名字，而我們的鍵還是改制前的（員林市／頭份市）
        alias = TOWN_ALIAS.get((county, t))
        if alias and rest.startswith(alias):
            return county + t
        # 地址寫改制前的名字，而我們的鍵是改制後的「區」（桃園）
        if upgraded and t.endswith("區"):
            stem = t[:-1]
            if any(rest.startswith(stem + suf) for suf in ("市", "鄉", "鎮")):
                return county + t
    return ""


def main() -> int:
    use_utf8_stdout()
    try:
        import duckdb
        import pandas as pd
    except ImportError:
        print("需要 duckdb 與 pandas", file=sys.stderr)
        return 1

    if not RECORDS.exists() or not DB.exists():
        print("缺 data/records.csv 或 data/gcis.duckdb", file=sys.stderr)
        return 1

    cent, by_county = load_centroids()
    print(f"鄉鎮市區座標 {len(cent)} 個")

    rec = pd.read_csv(RECORDS, low_memory=False)
    print(f"裁處紀錄 {len(rec):,} 筆")

    # ── 公司名 → 商工登記地址 ────────────────────────────────
    principals: dict[str, set[str]] = defaultdict(set)
    for co, pr in zip(rec["company"], rec["principal"]):
        if isinstance(co, str) and isinstance(pr, str):
            principals[co].add(pr)
    names = sorted(set(c for c in rec["company"] if isinstance(c, str)))

    con = duckdb.connect(str(DB), read_only=True)
    df = pd.DataFrame([(norm_name(c), c) for c in names],
                      columns=["name_norm", "raw"])
    con.execute("CREATE TEMP TABLE mol AS SELECT * FROM df")
    hits = con.execute("""
        SELECT m.raw, e.rep_masked, e.address
        FROM mol m JOIN entity e USING(name_norm)
    """).fetchall()

    cands: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for raw, rep, addr in hits:
        cands[raw].append((rep or "", addr or ""))

    addr_of: dict[str, str] = {}
    for name, options in cands.items():
        if len(options) > 1:
            # 同名多統編 —— 用遮罩姓名消歧，消不掉就不猜（見 join.py）
            ok = [o for o in options
                  if any(mask_match(o[0], p) for p in principals.get(name, ()))]
            if len(ok) != 1:
                continue
            options = ok
        a = norm_addr(options[0][1])
        if a:
            addr_of[name] = a

    print(f"公司名 {len(names):,} → 對到商工登記且有可用地址 {len(addr_of):,}"
          f"（{100 * len(addr_of) / len(names):.1f}%）")

    # ── 分母：每個區現存的登記事業單位數 ──────────────────────
    # ⚠ 沒有分母的話，這張圖畫出來的其實是「哪裡公司多」——
    #   那是一張人口密度圖，不是防災圖。台北市中山區排第一
    #   只是因為全台最多公司把總部登記在那裡。
    #   分母排除已解散／歇業者（占全國 55%），留下現存的。
    closed = "', '".join(CLOSED_STATUS)
    base_rows = con.execute(
        f"SELECT address FROM entity "
        f"WHERE address <> '' AND coalesce(status,'') NOT IN ('{closed}')"
    ).fetchall()
    base: Counter = Counter()
    for (a,) in base_rows:
        d = to_district(norm_addr(a), by_county)
        if d:
            base[d] += 1
    print(f"現存登記事業單位 {sum(base.values()):,} 家可歸到鄉鎮市區"
          f"（分母，已排除解散／歇業）")

    # ── 地址 → 鄉鎮市區 ──────────────────────────────────────
    district_of: dict[str, str] = {}
    for name, a in addr_of.items():
        d = to_district(a, by_county)
        if d:
            district_of[name] = d
    print(f"  其中解析得到鄉鎮市區 {len(district_of):,}"
          f"（{100 * len(district_of) / max(1, len(addr_of)):.1f}%）")

    # ── 聚合 ────────────────────────────────────────────────
    agg: dict[str, dict] = {}
    companies: dict[str, set[str]] = defaultdict(set)
    matched_all = matched_osha = total_osha = 0
    # ⚠⚠ 沒上圖的公司要分成**兩個**數字，不可以合成一個。
    #   一、商工登記對不到地址（串接率的問題，第一版寫成一個數字時是
    #       29,049 家 —— 那其實是已知的 86.5% 串接率，不是新發現）
    #   二、有地址但地址沒寫區（實測 192 家：新竹市 163、嘉義市 26…），
    #       這一類是從文字救不回來的
    #   合成一個數字的話，第二類（真正的缺口）會被第一類淹掉，
    #   而讀的人會以為是同一個問題。這跟「把裁處和得獎相減」是同一種錯。
    no_addr_co: set[str] = set()
    no_addr_osha = 0
    # ⚠ 公司名是空的那一批也要數。原本直接 continue 跳過，於是
    #   四個數字加起來比總數少 2,050 筆 —— 讀的人沒辦法自己核對，
    #   而「加不起來的統計」比「數字難看的統計」更傷信任。
    no_company_osha = 0
    addr_unmapped_co: set[str] = set()
    addr_unmapped_osha = 0

    for row in rec.itertuples(index=False):
        osha = row.group == "osha"
        total_osha += osha          # ⚠ 分母要含「公司名是空的」那些，否則涵蓋率是灌水的
        co = row.company
        if not isinstance(co, str):
            no_company_osha += osha
            continue
        d = district_of.get(co)
        if not d:
            if co in addr_of:
                addr_unmapped_co.add(co)      # 有地址，但地址對不到區
                addr_unmapped_osha += osha
            else:
                no_addr_co.add(co)            # 商工登記根本對不到地址
                no_addr_osha += osha
            continue
        matched_all += 1
        cell = agg.setdefault(d, {"n": 0, "all": 0, "fatal": 0, "pending": 0,
                                  "haz": Counter(), "hazf": Counter(),
                                  "hazp": Counter(), "yr": Counter()})
        cell["all"] += 1
        companies[d].add(co)
        if not osha:
            continue
        matched_osha += 1
        cell["n"] += 1
        v = row.violation if isinstance(row.violation, str) else ""
        fatal = is_fatal(v)
        if fatal:
            cell["fatal"] += 1
        rm = row.remark if isinstance(row.remark, str) else ""
        pending = any(k in rm for k in PENDING)
        if pending:
            cell["pending"] += 1
        for code in classify(v):
            cell["haz"][code] += 1
            # ⚠ 每個危害型態各自的死亡筆數也要留。
            #   不留的話，前端一旦篩「只看感電」，畫面上的
            #   「其中 N 筆涉及死亡災害」還是全部危害型態的 N ——
            #   數字沒錯，但它回答的已經不是使用者看到的那個問題了。
            if fatal:
                cell["hazf"][code] += 1
            if pending:
                cell["hazp"][code] += 1
        # ⚠⚠ disposition_date 是**民國**（"114/12/31"）。
        #   原本寫 dd[:4] 會拿到 "114/"，isdigit() 為假 ——
        #   所以這個計數器**從來沒有進過任何一筆**，365 列的 yr 全是 {}。
        #   不會報錯、不會壞畫面，只是一個型別上宣告了卻永遠空著的欄位
        #   （web/src/types/geo.ts 第 33 行）。這種錯最難發現。
        dd = row.disposition_date
        if isinstance(dd, str):
            y = dd.split("/")[0]
            if y.isdigit():
                cell["yr"][str(int(y) + 1911)] += 1

    rows = []
    for d, cell in agg.items():
        lat, lng = cent[d]
        rows.append({
            "k": d, "lat": lat, "lng": lng,
            "n": cell["n"], "all": cell["all"],
            "fatal": cell["fatal"], "pending": cell["pending"],
            "co": len(companies[d]),
            "base": base.get(d, 0),
            # ⚠ 15 種全帶，不是只帶前 5 名 —— 前端要能用危害型態篩選，
            #   只給前 5 名的話「只看感電」在多數區會查不到東西，
            #   而畫面上看起來就像那些區沒有感電案件。
            "haz": dict(cell["haz"].most_common()),
            "hazf": {k: cell["hazf"][k] for k in cell["haz"] if cell["hazf"][k]},
            "hazp": {k: cell["hazp"][k] for k in cell["haz"] if cell["hazp"][k]},
            "yr": dict(sorted(cell["yr"].items())),
        })
    rows.sort(key=lambda r: -r["n"])

    out = {
        "schema": 1,
        "generated_at": date.today().isoformat(),
        "basis": "登記地址",
        "note": ("圓點位置是事業單位的商工登記地址所在鄉鎮市區的幾何中心，"
                 "不是事故發生地點。職安法 74,658 筆裡只有 189 筆填了發生地點。"),
        "source": "勞動部違反勞動法令事業單位（雇主）查詢系統、經濟部商工登記公示資料",
        "districts": len(rows),
        "osha_total": total_osha,
        "osha_mapped": matched_osha,
        "all_mapped": matched_all,
        # ⚠ 這兩個數字要在畫面上出現。地圖少掉的公司跟「那裡沒有違規」
        #   長得一模一樣，而後者是這個站最不能讓人誤會的事。
        # ⚠ 下面四個相加必須等於 osha_total。等不了就是漏數了一類。
        "no_company_osha": no_company_osha,
        "no_addr_companies": len(no_addr_co),
        "no_addr_osha": no_addr_osha,
        "addr_unmapped_companies": len(addr_unmapped_co),
        "addr_unmapped_osha": addr_unmapped_osha,
    }
    out["rows"] = rows

    # ⚠⚠ 這條不變式要在**程式裡**擋，不能只寫在註解裡。
    #   「四者相加等於總數，讀者可自行核對」這句話已經印在畫面上，
    #   一旦哪天多了一種落空的成因而沒有被數到，畫面就會開始說謊。
    #   寧可讓管線在這裡停掉，也不要產生一份加不起來的資料檔。
    parts = (matched_osha, no_company_osha, no_addr_osha, addr_unmapped_osha)
    if sum(parts) != total_osha:
        raise SystemExit(
            f"涵蓋率四分類加不起來：{' + '.join(f'{x:,}' for x in parts)}"
            f" = {sum(parts):,}，但 osha_total = {total_osha:,}"
            f"（差 {total_osha - sum(parts):,}）。"
            "多半是新增了一種『沒上圖』的成因而沒有計數。")

    for p in (OUT, OUT_SRC):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")),
                     encoding="utf-8")

    print(f"\n鄉鎮市區 {len(rows)} 個")
    print(f"職安法 {matched_osha:,} / {total_osha:,} 筆上得了圖"
          f"（{100 * matched_osha / max(1, total_osha):.1f}%）")
    print(f"全部法規 {matched_all:,} 筆")
    def rate(r: dict) -> float:
        return 1000 * r["n"] / r["base"] if r["base"] >= 500 else 0.0

    print(f"\n  前 10 名（職安法筆數）—— 這一欄基本上是「哪裡公司多」")
    for r in rows[:10]:
        print(f"    {r['k']:<12} {r['n']:>6,}  死亡 {r['fatal']:>4}"
              f"  登記家數 {r['base']:>7,}  每千家 {rate(r):>6.1f}")
    print(f"\n  前 10 名（每千家登記事業單位的職安法裁處件數，"
          f"只看登記 500 家以上的區）")
    for r in sorted(rows, key=lambda x: -rate(x))[:10]:
        print(f"    {r['k']:<12} {rate(r):>6.1f}  = {r['n']:>5,} / {r['base']:>7,}"
              f"  死亡 {r['fatal']:>4}")
    print(f"\n→ {OUT}")
    print(f"→ {OUT_SRC}")

    print("\n⚠ 頁面上一定要寫「登記地址，不是發生地點」。")
    print("   營造業的公司登記在台北、工地在桃園是常態，")
    print("   寫不清楚這張圖就是一張看起來很專業的錯誤資訊。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
