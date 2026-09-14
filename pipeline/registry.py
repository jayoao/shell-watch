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
}


def pack(status: str, established: int | None) -> int:
    """(登記現況, 設立年) 壓成一個整數 = 代碼 * 10000 + 西元年。

    ⚠ 設立年缺漏時放 0，不要放 1911 或 9999 之類的哨兵值 ——
      那種值會在別的地方被當成真的年份拿去算「開了幾年」。
    """
    return STATUS_CODE.get(status or "", 0) * 10000 + int(established or 0)


def main() -> int:
    use_utf8_stdout()
    t0 = time.time()
    if not DB.exists():
        print(f"⚠ 找不到 {DB}", file=sys.stderr)
        return 1
    import duckdb

    con = duckdb.connect(str(DB), read_only=True)

    # 同一個正規化名稱可能對到多家（4,267,888 筆 → 3,703,647 個相異名稱）。
    # ⚠ 挑**資本額最大**的那一家，跟 pipeline/refine.py 的 load_facts() 同一條規則。
    #   兩邊用不同規則的話，同一個名字在查詢頁與查無頁會顯示不同的登記現況，
    #   而且不會報錯。
    rows = con.execute("""
        SELECT name_norm, status, established
        FROM (SELECT name_norm, status, established,
                     row_number() OVER (PARTITION BY name_norm
                                        ORDER BY coalesce(capital, 0) DESC) AS rn
              FROM entity
              WHERE name_norm IS NOT NULL AND name_norm <> '')
        WHERE rn = 1
    """).fetchall()
    print(f"商工登記　{len(rows):,} 個相異名稱　（{time.time() - t0:.0f} 秒）")

    shards: list[dict[str, int]] = [{} for _ in range(REGISTRY_SHARDS)]
    for name, status, est in rows:
        shards[fnv1a(name) % REGISTRY_SHARDS][name] = pack(status, est)

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
