"""商工登記存在性索引 → web/public/data/g/。

    python -m pipeline.registry

────────────────────────────────────────────────────────────────
為什麼需要這個索引
────────────────────────────────────────────────────────────────
2026-09-15 指導老師拿他合作的廠商「保吉生化學股份有限公司」來查，
得到「查無」，結論是「你們的搜尋不夠聰明，應該加 LLM 自動糾錯」。

實際查下去：他**一個字都沒有打錯**。

    商工登記   保吉生化學股份有限公司　統編 12342636　核准設立　設立 1981 年
    勞動部裁處  0 筆

全庫搜「保吉」只有一家「保吉早午餐」。那家公司在民國 100–115 年間
一次都沒有被裁罰過 —— 這是關於他合作廠商的**好消息**，
而我們把它講成了一次失敗，第一句話還問他「名稱是完整的法定名稱嗎？」。

⚠⚠ 所以這個索引要修的不是搜尋，是**答案**。
   再厲害的模糊比對或語言模型都救不了這一題 ——
   資料庫裡沒有的東西，猜不出來。能修的只有「我們怎麼說這件事」。

────────────────────────────────────────────────────────────────
做法
────────────────────────────────────────────────────────────────
把商工登記 370 萬個相異名稱的「存在 + 登記現況 + 設立年」切成 4096 片，
分片規則跟裁處分片一模一樣（FNV-1a % N），所以**不需要索引檔**，
前端算得出要抓哪一片。查不到的時候多抓一片（約 26 KB）就能分辨：

    登記查得到、裁處 0 筆   → 「這家公司登記存在，本站涵蓋範圍內沒有裁處紀錄」
    登記也查不到            → 「可能打錯了」，才給相近名稱

⚠ 這份索引**只在商工登記快照更新時才要重跑**，不是每次 publish 都跑。
  它有 4096 個檔、約 107 MB，但內容不變的話 Cloudflare 不會重複上傳。

⚠ 刻意不放統一編號與地址：加上去會從 107 MB 變成 425 MB，
  而「這家公司存在嗎、還在營業嗎、開多久了」這三個問題不需要它們。
  真的要看統編與地址的人，會去經濟部商工登記查詢系統 —— 我們該做的是
  把他導過去，不是把整個商工登記搬過來。
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                    # noqa: E402
from pipeline.publish import REGISTRY_SHARDS, fnv1a                   # noqa: E402

DB = Path("data/gcis.duckdb")
OUT = Path("web/public/data/g")

# 登記現況 → 代碼。⚠ 前端 lookup.ts 有一份一模一樣的對照表。
#   存成數字是為了體積：370 萬筆，每筆省 3 個中文字就是 30 MB。
STATUS_CODE: dict[str, int] = {
    "核准設立": 1,
    "核准停業": 2,
    "歇業": 3,
    "解散": 4,
    "撤銷": 5,
    "廢止": 6,
    "歇業/撤銷": 7,
    "解散已清算完結": 8,
    # ⚠ 9 不是商工登記的現況：商工快照裡沒有這個名稱，只在財政部稅籍登記（每日更新、
    #   只收營業中）查得到。見 gcis/taxreg.py。
    "營業中": 9,
}

TAX_DB = Path("data/taxreg.duckdb")
ACTIVE = "('核准設立','核准登記','核准報備','營業中')"


def pack(status: str, established: int | None, tax: int = 0) -> int:
    """(稅籍, 登記現況, 設立年) 壓成一個整數 = 稅籍 * 100000 + 代碼 * 10000 + 西元年。

    稅籍：0 = 沒有稅籍資料可比、1 = 財政部稅籍列為營業中、2 = 稅籍沒有列為營業中。
    ⚠ 前端 lookup.ts 的 unpackReg() 要同步。舊的前端會把 1xxxxx 當成代碼 1x，
      所以這份索引跟前端**一定要同一次部署**（deploy_taxreg.bat 就是這樣排的）。
    ⚠ 設立年缺漏時放 0，不要放 1911 或 9999 之類的哨兵值 ——
      那種值會在別的地方被當成真的年份拿去算「開了幾年」。
    """
    return int(tax) * 100000 + STATUS_CODE.get(status or "", 0) * 10000 + int(established or 0)


def registry_rows(con, min_len: int = 1) -> tuple[list[tuple], bool]:
    """每個相異正規化名稱一列：(name_norm, packed, capital)，營業中優先、資本額大優先。

    ⚠ 同名多筆時挑哪一筆：**先挑營業中的**，再挑資本額最大的。
      這份索引只用在「沒有裁處紀錄」那一頁，那裡沒有負責人可以對，所以不能用
      refine.load_facts() 的代表人規則。2026-10-28 實測：同名多筆的 27.6 萬個名稱裡，
      20 萬個各筆現況不一致；原本挑資本額最大，會把有營業中登記的名稱顯示成
      「解散」並跳出紅色警告 —— 使用者在應徵的那一家很可能就是營業中的那一筆。

    有 data/taxreg.duckdb（gcis/taxreg.py）時多做兩件事：
      - 名稱底下任何一筆的**統編**在稅籍裡 → 稅籍旗標 1，否則 2（用統編對，不用名稱對）
      - 商工快照裡沒有、稅籍有的名稱 → 補一列，現況「營業中」（代碼 9）

    ⚠ 2026-10-29 實測（稅籍 171.5 萬筆）：只在稅籍查得到的有 24.6 萬個名稱（四個字以上），
      多半是診所、小吃店、分公司 —— 正好是勞動部公告裡商工登記對不到的那一群。
    ⚠ 商工「核准設立」裡有 21.5% 稅籍沒列營業中。資本額前幾名是博達科技、萬客隆、東貝光電 ——
      早就倒閉、只是沒辦解散登記的公司。所以這個旗標抓的是真的東西，不是比對誤差。
    ⚠ 設立年**不補**（放 0）：稅籍的「設立日期」是辦稅籍登記的日期，不是公司設立日。
      保吉生化學 商工 1981、稅籍 1991。寫上去就是一個看起來很精確的錯誤。
    ⚠ 三個字以內的稅籍名稱不補：獨資行號常直接用負責人姓名當名稱（「王○○」），
      補進來等於讓人名查得到東西，違反「不提供人名查詢入口」。
    ⚠ 家福、統一星巴克、來來超商**不是**這裡補得到的：它們是改了名（家福 → 康達盛通生活事業），
      商工與稅籍都只有新名稱，勞動部公告用的是舊名稱。改名要另外處理。
    """
    has_tax = TAX_DB.exists()
    if has_tax:
        con.execute(f"ATTACH IF NOT EXISTS '{TAX_DB.as_posix()}' AS tx (READ_ONLY)")
        taxed = """, taxed AS (
              SELECT DISTINCT e.name_norm FROM entity e
              JOIN tx.tax t ON t.id = lpad(e.id, 8, '0'))"""
        flag = "CASE WHEN tz.name_norm IS NOT NULL THEN 1 ELSE 2 END"
        join = "LEFT JOIN taxed tz ON tz.name_norm = r.name_norm"
        extra = f"""
        UNION ALL
        SELECT name_norm, '營業中', 0, cap, 1
        FROM (SELECT name_norm, coalesce(capital, 0) AS cap,
                     row_number() OVER (PARTITION BY name_norm
                                        ORDER BY coalesce(capital, 0) DESC, id) AS rn
              FROM tx.tax
              WHERE name_norm IS NOT NULL AND length(name_norm) >= greatest({min_len}, 4)
                AND name_norm NOT IN (SELECT name_norm FROM entity WHERE name_norm IS NOT NULL))
        WHERE rn = 1"""
    else:
        taxed, flag, join, extra = "", "0", "", ""
    rows = con.execute(f"""
        WITH rep AS (
              SELECT name_norm, status, established, coalesce(capital, 0) AS cap,
                     row_number() OVER (PARTITION BY name_norm
                                        ORDER BY (status IN {ACTIVE}) DESC,
                                                 coalesce(capital, 0) DESC, id) AS rn
              FROM entity
              WHERE name_norm IS NOT NULL AND length(name_norm) >= {min_len}){taxed}
        SELECT name_norm, status, established, cap, tax FROM (
            SELECT r.name_norm, r.status, r.established, r.cap, {flag} AS tax
            FROM rep r {join}
            WHERE r.rn = 1{extra})
        ORDER BY (status IN {ACTIVE}) DESC, cap DESC, name_norm
    """).fetchall()
    return [(n, pack(st, est, tx), cap) for n, st, est, cap, tx in rows], has_tax


def tax_summary(rows: list[tuple]) -> str:
    """給 log 看的稅籍對照統計。⚠ 「核准設立但稅籍沒列」的比例太高的話，旗標不能拿來提醒使用者。"""
    active = sum(1 for _, p, _ in rows if (p // 10000) % 10 == 1)
    unlisted = sum(1 for _, p, _ in rows if (p // 10000) % 10 == 1 and p // 100000 == 2)
    only = sum(1 for _, p, _ in rows if (p // 10000) % 10 == 9)
    return (f"稅籍：只在稅籍查得到（補進來）{only:,} 個名稱；"
            f"商工「核准設立」{active:,} 個名稱裡稅籍沒列營業中 {unlisted:,}"
            f"（{unlisted / max(active, 1):.1%}）")


def main() -> int:
    use_utf8_stdout()
    t0 = time.time()
    if not DB.exists():
        print(f"⚠ 找不到 {DB}", file=sys.stderr)
        return 1
    import duckdb

    con = duckdb.connect(str(DB), read_only=True)

    # 同一個正規化名稱可能對到多家（4,267,888 筆 → 3,703,647 個相異名稱）。挑法見 registry_rows()。
    rows, has_tax = registry_rows(con)
    print(f"商工登記{'＋稅籍' if has_tax else ''}　{len(rows):,} 個相異名稱　（{time.time() - t0:.0f} 秒）")
    if has_tax:
        print("  " + tax_summary(rows))

    shards: list[dict[str, int]] = [{} for _ in range(REGISTRY_SHARDS)]
    for name, packed, _cap in rows:
        shards[fnv1a(name) % REGISTRY_SHARDS][name] = packed

    if OUT.exists():
        try:
            shutil.rmtree(OUT)
        except OSError as e:
            print(f"清不掉舊的 {OUT}：{e}", file=sys.stderr)
            return 1
    OUT.mkdir(parents=True, exist_ok=True)

    sizes = []
    for i, sh in enumerate(shards):
        body = json.dumps(sh, ensure_ascii=False, separators=(",", ":"))
        (OUT / f"{i}.json").write_text(body, encoding="utf-8")
        sizes.append(len(body.encode()))

    mb = sum(sizes) / 1024 / 1024
    print(f"{len(rows):,} 個名稱寫進 {REGISTRY_SHARDS} 片　共 {mb:.0f} MB")
    print(f"  每片 {min(sizes) / 1024:.0f}–{max(sizes) / 1024:.0f} KB，"
          f"平均 {sum(sizes) / len(sizes) / 1024:.0f} KB"
          f"（⚠ 查不到時要下載的量）")
    print(f"  → {OUT}（不進 git，部署時直接上傳）")
    print(f"\n共 {time.time() - t0:.0f} 秒")
    print("""
⚠ 這份索引只在商工登記快照更新時才要重跑。
   內容沒變的話 Cloudflare 不會重複上傳，所以不用怕它 107 MB。""")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
