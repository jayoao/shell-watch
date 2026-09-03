"""跨平台的小工具。目前只有一件事：把輸出強制轉成 UTF-8。

Windows 的主控台預設是 cp950（繁中）。這個專案的輸出裡有中文，也有
✗ ⚠ 這類符號，cp950 編不出來，程式會在 print 的時候丟 UnicodeEncodeError
而掛掉 —— 而且是在跑到一半、資料已經抓了一半的時候掛，特別討厭。

每個進入點（if __name__ == "__main__"）第一行呼叫 use_utf8_stdout()。
"""
from __future__ import annotations

import sys


def use_utf8_stdout() -> None:
    for stream in (sys.stdout, sys.stderr):
        enc = (getattr(stream, "encoding", "") or "").lower().replace("-", "")
        if enc == "utf8":
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")   # Python 3.7+
        except Exception:
            pass       # 轉不了就算了，errors="replace" 至少不會讓程式掛掉
