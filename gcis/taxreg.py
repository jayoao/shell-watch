"""財政部「全國營業(稅籍)登記資料集」→ data/taxreg.duckdb。

    （部署工具\\fetch_taxreg.bat 會先用 curl.exe 下載，再跑這支）
    python -m gcis.taxreg

────────────────────────────────────────────────────────────────
為什麼要多一份登記資料
────────────────────────────────────────────────────────────────
2026-10-29 全面實測：商工登記快照（g0v 鏡像，2026-09-03）有兩個缺口。

  1. **缺大公司**：家福股份有限公司、統一星巴克、來來超商 都不在鏡像的索引裡。
     使用者查得到裁處紀錄，卻看不到統編與登記現況；沒被罰過的話，連「這家公司存在」
     都說不出來，只能講「查無」。
  2. **會過時**：青菜豐商行 在快照裡是「核准設立」，官方系統已經是「停業」。

財政部這份是**每日更新**、只收「營業中」的營業人（公司、行號、分支機構都有）。
它沒有負責人、沒有登記現況，所以**取代不了**商工登記（負責人關聯全靠商工登記），
只用來補兩件事：
  - 商工登記快照裡沒有的名稱 → 至少能說「財政部稅籍登記為營業中」
  - 快照說核准設立、稅籍卻沒列為營業中 → 提醒使用者快照可能過時

資料集：https://data.gov.tw/dataset/9400（BGMOPEN1.zip，政府資料開放授權條款第 1 版）

⚠ 這裡只做「解析＋存檔」，不連網。下載交給 curl.exe：Python 的 urllib 常常卡在
  政府網站憑證鏈不完整（CERTIFICATE_VERIFY_FAILED），Windows 的 curl 走系統憑證庫沒有這個問題。
⚠ 欄位用**欄名**對，不要用位置對。來源改過欄位順序的話，用位置對會把地址當成名稱，
  而且不會報錯。
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
import time
import zipfile
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                      # noqa: E402
from gcis.load import norm_name                         # noqa: E402

ZIP = Path("data/taxreg/BGMOPEN1.zip")
DB = Path("data/taxreg.duckdb")
META = Path("data/taxreg_meta.json")

# 欄名 → 我們的欄位。⚠ 第一個「名稱」是行業名稱（緊跟在「行業代號」後面），不是公司名。
WANT = {
    "統一編號": "id", "總機構統一編號": "hq", "營業人名稱": "name",
    "營業地址": "address", "資本額": "capital", "設立日期": "est",
    "組織別名稱": "org",
}


def est_year(s: str) -> int:
    """設立日期 → 西元年。來源是民國 yyyMMdd（7 碼，例 0750312）；也接受 8 碼西元與 yyy/MM/dd。"""
    t = re.sub(r"\D", "", s or "")
    if len(t) == 7:
        y = int(t[:3]) + 1911
    elif len(t) == 6:                       # 民國 99 年以前有時少一個前導 0
        y = int(t[:2]) + 1911
    elif len(t) == 8:
        y = int(t[:4])
        if y < 1800:                        # 0yyyMMdd 這種補成 8 碼的民國年
            y = int(t[1:4]) + 1911
    else:
        return 0
    return y if 1850 <= y <= date.today().year else 0


def money(s: str) -> int:
    t = re.sub(r"[^\d]", "", s or "")
    return int(t) if t else 0


def main(argv: list[str]) -> int:
    use_utf8_stdout()
    t0 = time.time()
    if not ZIP.exists():
        print(f"⚠ 找不到 {ZIP}。先跑 部署工具\\fetch_taxreg.bat（它會下載）。", file=sys.stderr)
        return 1
    zf = zipfile.ZipFile(ZIP)
    members = [m for m in zf.infolist() if m.filename.lower().endswith((".csv", ".txt"))]
    if not members:
        print(f"⚠ 壓縮檔裡沒有 csv：{[m.filename for m in zf.infolist()]}", file=sys.stderr)
        return 1
    m = max(members, key=lambda x: x.file_size)
    data_date = "%04d-%02d-%02d" % m.date_time[:3]
    print(f"{ZIP} → {m.filename}　{m.file_size / 1e6:.0f} MB　檔案日期 {data_date}")

    import codecs

    import duckdb
    import pandas as pd

    head = zf.open(m).read(1 << 16)
    enc = "utf-8-sig"
    for e in ("utf-8-sig", "cp950", "big5hkscs"):
        try:
            codecs.getincrementaldecoder(e)().decode(head, final=False)
            enc = e
            break
        except UnicodeDecodeError:
            continue
    # ⚠ 串流讀，不要整份 decode 進記憶體（解壓後數百 MB，轉成 Python 字串再翻倍）。
    f = io.TextIOWrapper(zf.open(m), encoding=enc, errors="replace", newline="")
    reader = csv.reader(f)
    # 表頭不一定在第一行（有些版本第一行是標題或資料日期）。找前 10 行裡同時有兩個欄名的那一行。
    header: list[str] | None = None
    seen_lines = []
    for _ in range(10):
        r = next(reader, None)
        if r is None:
            break
        seen_lines.append(r)
        joined = ",".join(r)
        if "統一編號" in joined and "營業人名稱" in joined:
            header = [h.strip().lstrip("\ufeff") for h in r]
            break
    if header is None:
        print("⚠ 前 10 行找不到表頭（統一編號、營業人名稱）。前三行：", file=sys.stderr)
        for r in seen_lines[:3]:
            print("   " + ",".join(r)[:200], file=sys.stderr)
        return 1
    col: dict[str, int] = {}
    for i, h in enumerate(header):
        if h in WANT and WANT[h] not in col:
            col[WANT[h]] = i
    if "id" not in col or "name" not in col:
        print(f"⚠ 缺必要欄位（統一編號／營業人名稱）。表頭：{header}", file=sys.stderr)
        return 1
    print(f"編碼 {enc}　欄位 {header}")

    def g(r: list[str], k: str) -> str:
        i = col.get(k)
        return r[i].strip() if i is not None and i < len(r) else ""

    tmp = DB.with_suffix(".tmp.duckdb")
    if tmp.exists():
        tmp.unlink()
    con = duckdb.connect(str(tmp))
    con.execute("""CREATE TABLE tax(id VARCHAR, hq VARCHAR, name VARCHAR, name_norm VARCHAR,
                   address VARCHAR, capital BIGINT, est INTEGER, org VARCHAR)""")
    cols = ["id", "hq", "name", "name_norm", "address", "capital", "est", "org"]
    buf: list[tuple] = []
    n = bad = with_year = branches = 0
    sample: list[tuple] = []

    def flush() -> None:
        if buf:
            df = pd.DataFrame(buf, columns=cols)     # noqa: F841（duckdb 用變數名讀）
            con.execute("INSERT INTO tax SELECT * FROM df")
            buf.clear()

    for r in reader:
        if not r or len(r) < 3:
            continue
        tid = re.sub(r"\D", "", g(r, "id"))
        name = g(r, "name")
        if not tid or not name or len(tid) > 8:
            bad += 1
            continue
        tid = tid.zfill(8)
        hq = re.sub(r"\D", "", g(r, "hq"))
        hq = hq.zfill(8) if hq else ""
        if hq == tid:
            hq = ""
        y = est_year(g(r, "est"))
        row = (tid, hq, name, norm_name(name), g(r, "address"),
               money(g(r, "capital")), y, g(r, "org"))
        if len(sample) < 3:
            sample.append(row)
        buf.append(row)
        n += 1
        with_year += bool(y)
        branches += bool(hq)
        if len(buf) >= 200_000:
            flush()
    flush()
    print(f"{n:,} 筆　（略過 {bad:,} 筆缺統編或名稱）　分支機構 {branches:,}　"
          f"有設立年 {with_year / max(n, 1):.1%}")
    print(f"   前三筆（檢查欄位有沒有對歪）：{[(x[0], x[2], x[6], x[7]) for x in sample]}")

    # ⚠ 健全性檢查：數字不對就停，不要把半份資料寫進索引。
    #   營業中的營業人約 160 萬；設立日期幾乎每筆都有。
    problems = []
    if n < 800_000:
        problems.append(f"筆數只有 {n:,}（預期 100 萬以上）")
    if with_year / max(n, 1) < 0.9:
        problems.append(f"設立年解析成功率 {with_year / max(n, 1):.1%}（預期 90% 以上）")
    if problems:
        con.close()
        for p in problems:
            print("⚠ " + p, file=sys.stderr)
        return 1
    con.execute("CREATE INDEX idx_tax_id ON tax(id)")
    con.execute("CREATE INDEX idx_tax_name ON tax(name_norm)")
    con.close()
    if DB.exists():
        DB.unlink()
    tmp.rename(DB)

    meta = {"data_date": data_date, "fetched": date.today().isoformat(), "rows": n,
            "branches": branches, "source": "https://data.gov.tw/dataset/9400"}
    META.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {DB}　{META}　共 {time.time() - t0:.0f} 秒")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
