"""把下載回來的商工登記打包檔整理進 DuckDB。

    python -m gcis.load

產出 data/gcis.duckdb，三張表：

    entity    每一個統編一列（公司、分公司、商業登記）
    director  董監事與合夥人（一個統編可能多列）
    fts       名稱正規化後的查詢用表（勞動部的公司名要靠它對到統編）

⚠ 打包檔的姓名是遮罩的（黃_斌）。這裡照實存成 name_masked，
   **不要把它當成完整姓名用**。完整姓名要另外用 API 查（見 constants.py）。

⚠ 不要用 pandas 一次載入 —— 解開後好幾 GB。這裡是逐行串流。
"""
from __future__ import annotations

import gzip
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                  # noqa: E402
from gcis.constants import (CLOSED_STATUS, MAX_YEAR, MIN_YEAR,
                            SHARDS, SUSPENDED_STATUS)                    # noqa: E402

SRC = Path("data/gcis")
DB = Path("data/gcis.duckdb")
BATCH = 20_000


# 每種欄位型別異常各留幾個樣本，跑完印出來 —— 不然只知道「有問題」，
# 不知道問題長什麼樣子，下次還是得再跑一次。
ODDITIES: dict[str, list[str]] = {}


ODD_COUNT: dict[str, int] = {}


def _note(field: str, value) -> None:
    key = f"{field}: {type(value).__name__}"
    ODD_COUNT[key] = ODD_COUNT.get(key, 0) + 1
    box = ODDITIES.setdefault(key, [])
    if len(box) < 3:
        box.append(repr(value)[:120])


def as_text(v, field: str = "") -> str:
    """把任何東西變成字串。

    ⚠ 真實資料的型別不一致：`公司名稱` 有時候是 list 不是 str。
      直接 .strip() 會炸掉，而且是在跑到一半、幾十萬筆之後才炸。
      這裡一律轉成字串，並記下來是哪個欄位出現什麼型別。
    """
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if field:
        _note(field, v)
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, list):
        for x in v:
            if isinstance(x, str) and x.strip():
                return x
        return " ".join(str(x) for x in v if x) if v else ""
    if isinstance(v, dict):
        for k in ("name", "value", "text"):
            if isinstance(v.get(k), str):
                return v[k]
        return ""
    return str(v)


def clean_status(v) -> str:
    """公司狀況欄位很髒：「解散」後面常黏著換行與文號。取第一行就好。

    不清的話「解散」會被拆成幾十種不同的值，統計全部失真。
    """
    t = as_text(v, "狀況")
    t = t.split("\n")[0].split("\r")[0].strip()
    # 全形斜線統一成半形：「歇業／撤銷」與「歇業/撤銷」是同一個狀態，
    # 實測分別有 123,598 與 52,008 筆。不統一就會漏掉 17 萬筆。
    return t.replace("／", "/")


def money(v) -> int | None:
    """「280,500,000,000」→ 280500000000。空的回 None，不要回 0 ——
    沒填跟資本額為零是兩件事。"""
    # 合夥商號的出資額寫成 {'張_芳': '200000', '李_黛': '1000000'} ——
    # 資本額是各人出資的總和，直接丟掉等於漏掉這家的資本額。
    if isinstance(v, dict):
        total = 0
        for x in v.values():
            xs = str(x).replace(",", "").strip()
            if xs.isdigit():
                total += int(xs)
        return total or None
    t = as_text(v, "金額").replace(",", "").strip()
    return int(t) if t.isdigit() else None


def year(v) -> int | None:
    """核准設立日期是 {"year":1976,"month":10,"day":29}（西元）。"""
    if isinstance(v, list):          # 有些紀錄包成 list
        v = v[0] if v else None
    if isinstance(v, dict):
        try:
            y = int(v.get("year") or 0)
        except (TypeError, ValueError):
            return None
        if not y:
            return None
        if not (MIN_YEAR <= y <= MAX_YEAR):
            # 實測有 2821 這種值。留著會讓「設立未滿 N 年」的判斷整個歪掉。
            _note("設立年份超出範圍", y)
            return None
        return y
    return None


def norm_name(s: str) -> str:
    """名稱正規化，給勞動部的公司名對接用。

    勞動部寫「台灣積體電路製造股份有限公司」，商工登記寫「台灣積體電路製造股份有限公司」，
    但台／臺、全形括號、空白到處都不一致。
    """
    t = as_text(s, "名稱").strip().replace(" ", "").replace("　", "")
    if not t:
        return ""
    t = t.replace("臺", "台").replace("（", "(").replace("）", ")")
    return t


def rows_of(obj: dict) -> tuple[dict | None, list[dict]]:
    """一筆 JSON → (entity 一列, director 多列)。三種型態欄位不同。"""
    eid = as_text(obj.get("id"), "id").strip()
    if not eid:
        return None, []

    if obj.get("公司名稱"):
        name = as_text(obj.get("公司名稱"), "公司名稱")
        ent = {
            "id": eid, "kind": "公司", "name": name, "name_norm": norm_name(name),
            "rep_masked": as_text(obj.get("代表人姓名"), "代表人姓名"),
            "address": as_text(obj.get("公司所在地"), "公司所在地"),
            "capital": money(obj.get("實收資本額(元)") or obj.get("資本總額(元)")),
            "established": year(obj.get("核准設立日期")),
            "status": clean_status(obj.get("公司狀況") or obj.get("登記現況")),
            "registry": as_text(obj.get("登記機關"), "登記機關"),
            "parent": "",
        }
        dirs = []
        for d in (obj.get("董監事名單") or []):
            if not isinstance(d, dict):
                _note("董監事名單元素", d)
                continue
            nm = as_text(d.get("姓名"), "董監事姓名").strip()
            if not nm:
                continue
            rep = d.get("所代表法人")
            # 「所代表法人」有兩種寫法：空字串，或 [統編, 法人名稱]
            rep_name = rep[-1] if isinstance(rep, list) and rep else as_text(rep)
            dirs.append({"id": eid, "name_masked": nm,
                         "title": as_text(d.get("職稱")),
                         "represents": as_text(rep_name)})
        return ent, dirs

    if obj.get("商業名稱"):
        name = as_text(obj.get("商業名稱"), "商業名稱")
        ent = {
            "id": eid, "kind": "商業登記", "name": name, "name_norm": norm_name(name),
            "rep_masked": as_text(obj.get("負責人姓名"), "負責人姓名"),
            "address": as_text(obj.get("地址"), "地址"),
            "capital": money(obj.get("資本額(元)") or obj.get("出資額(元)")),
            "established": year(obj.get("核准設立日期")),
            "status": clean_status(obj.get("現況") or obj.get("登記現況")),
            "registry": as_text(obj.get("登記機關"), "登記機關"),
            "parent": "",
        }
        dirs = []
        # ⚠ 合夥人姓名可能是字串（"王_美、李_華"）也可能是 list（["王_美","李_華"]）。
        #   用 as_text 會只拿到第一個，另一個合夥人就憑空消失了。
        partners = obj.get("合夥人姓名")
        if isinstance(partners, list):
            partners = "、".join(as_text(x) for x in partners)
        else:
            partners = as_text(partners, "合夥人姓名")
        names = {nm.strip() for nm in partners.replace("、", ",").split(",")
                 if nm.strip()}
        # 出資額若是 {姓名: 金額}，key 就是合夥人名單（免費多一份來源）
        contrib = obj.get("出資額(元)")
        if isinstance(contrib, dict):
            names |= {k.strip() for k in contrib if k and k.strip()}
        for nm in sorted(names):
            dirs.append({"id": eid, "name_masked": nm,
                         "title": "合夥人", "represents": ""})
        return ent, dirs

    if obj.get("分公司名稱"):
        name = as_text(obj.get("分公司名稱"), "分公司名稱")
        return {
            "id": eid, "kind": "分公司", "name": name, "name_norm": norm_name(name),
            "rep_masked": as_text(obj.get("分公司經理姓名"), "分公司經理姓名"),
            "address": as_text(obj.get("分公司所在地"), "分公司所在地"),
            "capital": None, "established": None,
            "status": clean_status(obj.get("分公司狀況")),
            "registry": "", "parent": as_text(obj.get("總(本)公司統一編號")),
        }, []

    return None, []


def main() -> int:
    use_utf8_stdout()
    try:
        import duckdb
    except ImportError:
        print("需要 duckdb：pip install duckdb", file=sys.stderr)
        return 1

    missing = [s for s in SHARDS if not (SRC / s).exists()]
    if missing:
        print(f"{SRC} 少了 {len(missing)} 個分片，先跑 python -m gcis.fetch",
              file=sys.stderr)
        return 1

    try:
        import pandas as pd
    except ImportError:
        print("需要 pandas：pip install pandas", file=sys.stderr)
        return 1

    DB.parent.mkdir(parents=True, exist_ok=True)
    DB.unlink(missing_ok=True)
    con = duckdb.connect(str(DB))
    # ⚠ **不要加 PRIMARY KEY。** 去重已經在 Python 的 seen 集合做掉了，
    #   PK 只是讓 DuckDB 每一列再做一次唯一性檢查。
    #   實測 20,000 列：有 PK 的逐列 INSERT 是 343 列/秒，300 萬列要 146 分鐘。
    con.execute("""
        CREATE TABLE entity(
            id VARCHAR, kind VARCHAR, name VARCHAR, name_norm VARCHAR,
            rep_masked VARCHAR, address VARCHAR, capital BIGINT,
            established INTEGER, status VARCHAR, registry VARCHAR, parent VARCHAR);
        CREATE TABLE director(
            id VARCHAR, name_masked VARCHAR, title VARCHAR, represents VARCHAR);
    """)

    ecols = ["id", "kind", "name", "name_norm", "rep_masked", "address",
             "capital", "established", "status", "registry", "parent"]
    dcols = ["id", "name_masked", "title", "represents"]
    ebuf, dbuf = [], []
    n_ent = n_dir = n_bad = 0
    seen: set[str] = set()

    def flush():
        """批次寫入。

        ⚠ **不要用 con.executemany() 一列一列塞。** DuckDB 是欄式分析資料庫，
          逐列 INSERT 是它最差的情況。實測（20,000 列）：

              PRIMARY KEY + executemany        343 列/秒 → 300 萬列 146 分鐘
              拿掉 PRIMARY KEY                1,490 列/秒 →           34 分鐘
              拿掉 PK ＋ DataFrame 批次     233,697 列/秒 →           13 秒

          差 680 倍。DuckDB 會直接把本地的 DataFrame 當成表來讀
          （replacement scan），所以 INSERT INTO ... SELECT * FROM df 幾乎零成本。
        """
        nonlocal ebuf, dbuf
        if ebuf:
            df_e = pd.DataFrame(ebuf, columns=ecols)          # noqa: F841
            con.execute("INSERT INTO entity SELECT * FROM df_e")
            ebuf = []
        if dbuf:
            df_d = pd.DataFrame(dbuf, columns=dcols)          # noqa: F841
            con.execute("INSERT INTO director SELECT * FROM df_d")
            dbuf = []

    t0 = time.time()
    for shard in SHARDS:
        path = SRC / shard
        got = 0
        size_mb = path.stat().st_size / 1e6
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
            for line in f:
                if got and got % 50_000 == 0:
                    # 最大的分片有 70 MB，沒有進度會讓人以為當掉了
                    print(f"\r  {shard:<30} {size_mb:5.0f}MB  {got:>8,} 筆…",
                          end="", flush=True)
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    n_bad += 1
                    continue
                try:
                    ent, dirs = rows_of(obj)
                except Exception as e:          # noqa: BLE001
                    # 一筆爛資料不該讓整趟重來 —— 這份要跑好幾分鐘
                    n_bad += 1
                    _note("rows_of 例外", f"{type(e).__name__}: {e}")
                    continue
                if not ent or ent["id"] in seen:
                    continue
                seen.add(ent["id"])
                ebuf.append([ent[c] for c in ecols])
                dbuf.extend([d[c] for c in dcols] for d in dirs)
                n_ent += 1
                n_dir += len(dirs)
                got += 1
                if len(ebuf) >= BATCH:
                    flush()
        flush()
        print(f"\r  {shard:<30} {size_mb:5.0f}MB  {got:>8,} 筆      ")

    flush()
    con.execute("CREATE INDEX idx_name ON entity(name_norm)")
    con.execute("CREATE INDEX idx_rep ON entity(rep_masked)")
    con.execute("CREATE INDEX idx_dir ON director(name_masked)")

    print(f"\n{time.time() - t0:.0f} 秒　"
          f"entity {n_ent:,} 筆　director {n_dir:,} 筆"
          f"{f'　（{n_bad:,} 行解析失敗）' if n_bad else ''}")

    kinds = con.execute(
        "SELECT kind, count(*) FROM entity GROUP BY 1 ORDER BY 2 DESC").fetchall()
    print("\n型態：" + "　".join(f"{k} {n:,}" for k, n in kinds))

    closed = con.execute(
        "SELECT count(*) FROM entity WHERE status IN "
        f"({','.join('?' * len(CLOSED_STATUS))})", list(CLOSED_STATUS)).fetchone()[0]
    susp = con.execute(
        "SELECT count(*) FROM entity WHERE status IN "
        f"({','.join('?' * len(SUSPENDED_STATUS))})",
        list(SUSPENDED_STATUS)).fetchone()[0]
    print(f"永久停止營業（解散／撤銷／廢止／歇業）：{closed:,} 筆"
          f"（{100 * closed / max(1, n_ent):.1f}%）　← 換殼的定義性特徵")
    print(f"暫時停業（可能復業，不算換殼）：　　　{susp:,} 筆"
          f"（{100 * susp / max(1, n_ent):.1f}%）")
    print("\n狀態分布：")
    for st, n in con.execute(
            "SELECT status, count(*) FROM entity WHERE status<>'' "
            "GROUP BY 1 ORDER BY 2 DESC LIMIT 10").fetchall():
        tag = ("停業" if st in SUSPENDED_STATUS
               else "已停業" if st in CLOSED_STATUS else "營業中")
        print(f"  {st:<16} {n:>9,}   {tag}")

    masked = con.execute(
        "SELECT count(*) FROM entity WHERE rep_masked LIKE '%\\_%' ESCAPE '\\'"
    ).fetchone()[0]
    has_rep = con.execute(
        "SELECT count(*) FROM entity WHERE rep_masked <> ''").fetchone()[0]
    print(f"負責人姓名遮罩率：{masked:,}/{has_rep:,} "
          f"（{100 * masked / max(1, has_rep):.1f}%）　"
          f"← 完整姓名要用 API，見 gcis/constants.py")

    if ODDITIES:
        print("\n── 欄位型別異常（資料本身就長這樣，已自動轉字串）──")
        for k, samples in sorted(ODDITIES.items(),
                                 key=lambda kv: -ODD_COUNT.get(kv[0], 0)):
            print(f"  {k}　{ODD_COUNT.get(k, 0):,} 次")
            for x in samples:
                print(f"      {x}")

    con.close()
    print(f"\n→ {DB}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
