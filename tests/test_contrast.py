"""tokens.css 的對比度。

    python tests/test_contrast.py

⚠ 這支測試是 2026-09-25 加霓虹主題時寫的。在那之前對比度都是「看起來
  應該夠」—— 而第一次真的算下去就發現**現行線上主題**的 --rule-2
  （輸入框與可點邊界）只有 2.59:1，低於 WCAG 1.4.11 對 UI 元件的 3.0。
  沒有人回報過，因為它的症狀是「有點難看清楚」而不是「壞掉」。

⚠ 門檻分兩種，不可以混用：
    1.4.3  文字         4.5（大字 3.0，本站正文都不算大字）
    1.4.11 UI 元件邊界   3.0
  列與列之間的**裝飾性**分隔線（--rule）不在規範範圍內，
  硬套 3.0 會逼出一堆把版面切碎的粗線。所以它標 EXEMPT 而不是放寬門檻 ——
  「這條不適用」跟「這條我們沒做到」是兩件事，不可以寫成同一個數字。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from common import use_utf8_stdout                                   # noqa: E402

TOKENS = ROOT / "web" / "src" / "styles" / "tokens.css"

# (標籤, 前景 token, 背景 token, 門檻)　門檻 0 = 規範不適用
PAIRS = [
    ("主要文字 / 底",     "--ink",             "--paper",       4.5),
    ("次要文字 / 底",     "--ink-2",           "--paper",       4.5),
    ("輔助說明 / 底",     "--ink-3",           "--paper",       4.5),
    ("主要文字 / 區塊",   "--ink",             "--sheet",       4.5),
    ("輔助說明 / 區塊",   "--ink-3",           "--sheet",       4.5),
    ("連結 / 底",         "--link",            "--paper",       4.5),
    ("按鈕字 / 按鈕",     "--on-accent",       "--accent-fill", 4.5),
    ("死亡標籤",          "--fatal-ink",       "--fatal-soft",  4.5),
    ("死亡標記",          "--fatal-tag-fg",    "--fatal-tag-bg", 4.5),
    ("死亡色 / 底",       "--fatal",           "--paper",       4.5),
    ("救濟標籤",          "--pending-ink",     "--pending-soft", 4.5),
    ("救濟色 / 底",       "--pending",         "--paper",       4.5),
    ("強調軟底上的字",    "--on-accent-soft",  "--accent-soft", 4.5),
    ("good 軟底上的字",   "--on-good-soft",    "--good-soft",   4.5),
    ("輸入框邊 / 區塊",   "--rule-2",          "--sheet",       3.0),  # 1.4.11
    ("地圖陸 / 海",       "--map-land",        "--map-sea",     0),    # 見下
    ("分隔線 / 底",       "--rule",            "--paper",       0),    # 裝飾，不適用
]

THEMES = {
    "報紙亮色（:root）":      r":root\s*\{(.*?)\n\}",
    "暖灰深色（dark）":       r':root\[data-theme="dark"\]\s*\{(.*?)\n\}',
    "霓虹深色（neon）":       r':root\[data-theme="neon"\]\s*\{(.*?)\n\}',
}

# ⚠ token 可以是 `--accent-fill: var(--link);`。只抓 # 開頭的話，
#   這一類會被當成「缺 token」而整組檢查被跳過 —— 那比 FAIL 更糟，
#   因為畫面上看起來是「沒有問題」。所以 var() 要展開。
VAR = re.compile(r"(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{3,8}|var\(\s*--[a-z0-9-]+\s*\))\s*;")
REF = re.compile(r"var\(\s*(--[a-z0-9-]+)\s*\)")


def resolve(vals: dict[str, str]) -> dict[str, str]:
    """把 var(--x) 展開成色碼。循環參照直接丟掉，不要無限迴圈。"""
    out = dict(vals)
    for _ in range(8):
        changed = False
        for k, v in list(out.items()):
            m = REF.fullmatch(v.strip())
            if m and m.group(1) in out:
                nv = out[m.group(1)]
                if nv != v:
                    out[k] = nv
                    changed = True
        if not changed:
            break
    return {k: v for k, v in out.items() if v.startswith("#")}


def parse() -> dict[str, dict[str, str]]:
    css = TOKENS.read_text(encoding="utf-8")
    base: dict[str, str] = {}
    out: dict[str, dict[str, str]] = {}
    for name, pat in THEMES.items():
        m = re.search(pat, css, re.S)
        if not m:
            print(f"⚠ 找不到主題區塊：{name}")
            continue
        vals = dict(VAR.findall(m.group(1)))
        if not base:
            base = dict(vals)          # :root 當底，其餘主題只覆蓋部分 token
        out[name] = resolve({**base, **vals})
    return out


def _lin(c: float) -> float:
    c /= 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def lum(hex_: str) -> float:
    h = hex_.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def ratio(a: str, b: str) -> float:
    la, lb = lum(a), lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def main() -> int:
    use_utf8_stdout()
    themes = parse()
    bad = 0
    for name, vals in themes.items():
        print(f"\n── {name} " + "─" * (44 - len(name)))
        for label, fg, bg, need in PAIRS:
            if fg not in vals or bg not in vals:
                print(f"  ?     {label:<16} 缺 token（{fg} / {bg}）")
                bad += 1
                continue
            r = ratio(vals[fg], vals[bg])
            if need == 0:
                print(f"  --    {label:<16} {r:5.2f}:1   規範不適用")
                continue
            ok = r >= need
            bad += not ok
            print(f"  {'ok  ' if ok else 'FAIL'}  {label:<16} {r:5.2f}:1"
                  f"   門檻 {need}")
    print("\n全部通過。" if not bad else f"\n⚠ {bad} 項未通過。")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
