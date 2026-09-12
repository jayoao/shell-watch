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


def to_district(addr: str, by_county: dict[str, list[str]]) -> str:
    """「新北市中和區安和路7號」→「新北市中和區」。對不到回空字串。

    ⚠ 不做模糊比對。對不到就是對不到，寧可少算也不要把紀錄放到錯的區 ——
      地圖上一個放錯位置的圓點，比一個不存在的圓點更難發現。
    """
    if len(addr) < 6:
        return ""
    county = addr[:3]
    towns = by_county.get(county)
    if not towns:
        return ""
    rest = addr[3:]
    for t in towns:
        if rest.startswith(t):
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

    for row in rec.itertuples(index=False):
        osha = row.group == "osha"
        total_osha += osha          # ⚠ 分母要含「公司名是空的」那些，否則涵蓋率是灌水的
        co = row.company
        if not isinstance(co, str):
            continue
        d = district_of.get(co)
        if not d:
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
        dd = row.disposition_date
        if isinstance(dd, str) and len(dd) >= 4 and dd[:4].isdigit():
            cell["yr"][dd[:4]] += 1

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
    }
    out["rows"] = rows

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
