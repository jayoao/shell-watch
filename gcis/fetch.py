"""下載 g0v 的商工登記打包檔。

    python -m gcis.fetch            # 索引 + 20 個明細分片，約 610 MB
    python -m gcis.fetch --index    # 只抓索引（50 MB），先看看

已經抓過的檔案會跳過（比對檔案大小），所以中斷了直接再跑一次就好。

⚠ 這是別人自費架的鏡像站，不是政府的。**不要平行下載、不要重複抓。**
   正式文件裡引用資料來源要寫經濟部商業司，不是這個鏡像。
"""
from __future__ import annotations

import argparse
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                      # noqa: E402
from gcis.constants import BASE, INDEX_FILE, SHARDS     # noqa: E402

OUT = Path("data/gcis")
UA = ("shell-watch/0.1 (student research project; "
      "InnoServe 2026 contest; sequential download)")
CHUNK = 1 << 20


def _remote_sizes(path: str) -> dict[str, int]:
    """從目錄頁抓每個檔案的大小，用來判斷抓完了沒。"""
    url = f"{BASE}/{path}index.html" if path else f"{BASE}/index.html"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        html = r.read().decode("utf-8", errors="replace")
    out: dict[str, int] = {}
    for m in re.finditer(r"<td[^>]*>([^<]+?\.(?:gz))</td>.*?<td[^>]*>(\d+)</td>",
                         html, re.S):
        out[m.group(1).strip()] = int(m.group(2))
    return out


def download(name: str, sub: str, expect: int | None) -> bool:
    dest = OUT / name
    if dest.exists() and expect and dest.stat().st_size == expect:
        print(f"  {name:<34} 已有（{expect / 1e6:.0f} MB），跳過")
        return True
    tmp = dest.with_suffix(dest.suffix + ".part")
    url = f"{BASE}/{sub}{name}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    got = 0
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r, tmp.open("wb") as f:
            total = int(r.headers.get("Content-Length") or expect or 0)
            while True:
                buf = r.read(CHUNK)
                if not buf:
                    break
                f.write(buf)
                got += len(buf)
                if total:
                    pct = 100 * got / total
                    print(f"\r  {name:<34} {pct:5.1f}%  "
                          f"{got / 1e6:6.0f}/{total / 1e6:.0f} MB", end="")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"\r  {name:<34} 失敗：{e}")
        tmp.unlink(missing_ok=True)
        return False
    # 先寫 .part、完成才改名 —— 中斷留下的半套檔案不會被當成抓好了
    tmp.replace(dest)
    print(f"\r  {name:<34} 完成  {got / 1e6:6.0f} MB  "
          f"（{time.time() - t0:.0f} 秒）      ")
    return True


def main(argv: list[str] | None = None) -> int:
    use_utf8_stdout()
    p = argparse.ArgumentParser(description="下載 g0v 商工登記打包檔")
    p.add_argument("--index", action="store_true", help="只抓名稱索引")
    a = p.parse_args(argv)

    OUT.mkdir(parents=True, exist_ok=True)
    try:
        root = _remote_sizes("")
        files = {} if a.index else _remote_sizes("files/")
    except Exception as e:
        print(f"連不上 {BASE}：{e}\n"
              "      先用瀏覽器開一次確認站台還在。", file=sys.stderr)
        return 1

    todo = [(INDEX_FILE, "", root.get(INDEX_FILE))]
    if not a.index:
        todo += [(s, "files/", files.get(s)) for s in SHARDS]

    plan = sum(sz or 0 for _, _, sz in todo)
    have = sum((OUT / n).stat().st_size for n, _, _ in todo if (OUT / n).exists())
    print(f"要抓 {len(todo)} 個檔案，共 {plan / 1e6:.0f} MB"
          f"（已有 {have / 1e6:.0f} MB）\n")

    ok = 0
    for name, sub, size in todo:
        if download(name, sub, size):
            ok += 1
        time.sleep(1)          # 別人自費架的站，慢一點

    print(f"\n{ok}/{len(todo)} 完成 → {OUT}")
    if ok < len(todo):
        print("有檔案沒抓完，直接再跑一次，已完成的會跳過。")
        return 1
    print("接著跑 python -m gcis.load")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
