"""商工登記前綴索引 → web/public/data/rp/。

    python -m pipeline.registry_prefix

────────────────────────────────────────────────────────────────
為什麼需要這個索引
────────────────────────────────────────────────────────────────
2026-10-29：查「保吉生」什麼都沒有，Google 一查就是「保吉生化學股份有限公司」。

存在性索引（g/）只認**完整名稱**；簡稱比對（x/）只掃**有裁處紀錄**的公司。
所以「沒被罰過的公司，使用者只打了前幾個字」這個求職者最常見的情形，
兩條路都走不到 —— 而沒被罰過正是大多數公司的狀態。

────────────────────────────────────────────────────────────────
做法
────────────────────────────────────────────────────────────────
用名稱的**前三個字**當鍵，FNV-1a % 8192 分片。前端算得出要抓哪一片，
不需要索引檔。實測 370 萬個相異名稱、286 萬個相異前綴，
最大的前綴「香港商」5,229 個名稱，其餘 99% 的前綴不到 5 個。

每一片：{前三字: [[其餘字, 登記現況代碼*10000+設立年], ...]}
  ⚠ 只存「前三字之後」的字，省下 370 萬 × 3 個字。
  ⚠ 每個前綴底下依「營業中優先、資本額大優先」排序，前端取前幾個就是最可能的那幾家。
  ⚠ 打不到三個字的查詢不走這個索引（兩個字的前綴動輒上萬家，沒有意義）。

⚠ 這是**前綴**比對，不是全文搜尋：「生化學」找不到「保吉生化學」。
⚠ 跟 g/ 一樣，只在商工登記快照更新時才要重跑。
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                    # noqa: E402
from pipeline.publish import fnv1a                                    # noqa: E402
from pipeline.registry import registry_rows, tax_summary             # noqa: E402

DB = Path("data/gcis.duckdb")
DATA = Path("web/public/data")
PREFIX_SHARDS = 8192      # ⚠ 前端 lookup.ts 讀 meta.json 的 rp_shards；這裡寫進去
PREFIX_LEN = 3


def main(argv: list[str]) -> int:
    use_utf8_stdout()
    out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else DATA / "rp"
    t0 = time.time()
    if not DB.exists():
        print(f"⚠ 找不到 {DB}", file=sys.stderr)
        return 1
    import duckdb

    con = duckdb.connect(str(DB), read_only=True)
    # ⚠ 同名多筆時挑哪一筆、排序，都跟 pipeline/registry.py 同一個函式（營業中優先，再看資本額）。
    #   有 data/taxreg.duckdb 時，商工快照沒有、財政部稅籍有的名稱也會進來（現況「營業中」）。
    rows, has_tax = registry_rows(con, PREFIX_LEN)
    print(f"商工登記{'＋稅籍' if has_tax else ''}　{len(rows):,} 個相異名稱　（{time.time() - t0:.0f} 秒）")
    if has_tax:
        print("  " + tax_summary(rows))

    shards: list[dict[str, list]] = [{} for _ in range(PREFIX_SHARDS)]
    for name, packed, _cap in rows:
        p = name[:PREFIX_LEN]
        shards[fnv1a(p) % PREFIX_SHARDS].setdefault(p, []).append([name[PREFIX_LEN:], packed])

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)
    sizes = []
    for i, sh in enumerate(shards):
        body = json.dumps(sh, ensure_ascii=False, separators=(",", ":"))
        (out / f"{i}.json").write_text(body, encoding="utf-8")
        sizes.append(len(body.encode()))

    # meta.json 補上 rp_shards（publish.py 之後重跑也會寫）。
    meta_p = DATA / "meta.json"
    if "--out" not in argv and meta_p.exists():
        meta = json.loads(meta_p.read_text(encoding="utf-8"))
        meta["rp_shards"] = PREFIX_SHARDS
        meta_p.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

    mb = sum(sizes) / 1024 / 1024
    print(f"{len(rows):,} 個名稱寫進 {PREFIX_SHARDS} 片　共 {mb:.0f} MB")
    print(f"  每片 {min(sizes) / 1024:.0f}–{max(sizes) / 1024:.0f} KB，平均 {sum(sizes) / len(sizes) / 1024:.0f} KB")
    print(f"  → {out}（不進 git，部署時直接上傳）　共 {time.time() - t0:.0f} 秒")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
