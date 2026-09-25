"""簡稱查詢的候選比對與排序。

    python tests/test_abbrev.py

⚠ 這支測試是 2026-09-25 的 bug 逼出來的。原本 subseqScore() 用 -1 當
  「對不上」的哨兵值，而**前綴完全吻合算出來也是 -1**，於是每一個前綴吻合
  的候選都被當成沒對上丟掉 —— 索引裡 176,359 家公司有 176,344 家
  「打自己名字的前 2–4 個字反而查不到」。

  它沒有被發現的原因是「台積電」剛好會過（不連續子序列，sc=1）。
  難的那種會、簡單的那種不會，所以手動試的時候永遠試不出來。

⚠ 這裡的函式是 web/src/lib/lookup.ts 的 subseqScore() 與 searchAbbrev()
  排序的**對拍**。改任何一邊都要改另一邊，然後跑這支。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from common import use_utf8_stdout                                   # noqa: E402

X_DIR = ROOT / "web" / "public" / "data" / "x"
X_SHARDS = 256
NO_MATCH = -999
ABBREV_LIMIT = 12


def fnv1a(s: str) -> int:
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def subseq_score(q: str, name: str) -> int:
    """⚠ 對拍 lookup.ts 的 subseqScore()。哨兵值不可以是 -1。"""
    i = 0
    last = -1
    for j, ch in enumerate(name):
        if i < len(q) and ch == q[i]:
            i += 1
            last = j
    return (last - len(q)) if i == len(q) else NO_MATCH


def rank(q: str, names: list[str]) -> list[str]:
    """⚠ 對拍 searchAbbrev() 的排序。分級要用 max(0, sc)。"""
    scored = []
    for pos, name in enumerate(names):
        sc = subseq_score(q, name)
        if sc == NO_MATCH:
            continue
        scored.append((min(2, max(0, sc) >> 1), pos, len(name), name))
    scored.sort()
    return [t[3] for t in scored[:ABBREV_LIMIT]]


# ── 1. 純函式：哨兵值不可以與合法回傳值撞號 ──────────────────────
UNIT = [
    # (查詢, 公司名, 要不要進候選)
    ("保吉", "保吉早午餐", True),          # 前綴完全吻合 → sc = -1，不是「對不上」
    ("國城", "國城營造有限公司", True),
    ("台積電", "台灣積體電路製造股份有限公司", True),
    ("台積電", "台積電股份有限公司", True),
    ("保吉", "保信吉商行", True),          # 不連續，本來就會過
    ("保吉", "大同股份有限公司", False),   # 真的對不上
]

# ── 2. 排序：這幾家一定要是第一名 ────────────────────────────────
#    ⚠ 「台電」是影片在用的 demo。加上 max(0, sc) 之前，第一名會被
#      「台電馬鞍山冰品部」搶走（前綴吻合自成更前面的等級）。
FIRST = [
    ("台電", "台灣電力股份有限公司"),
    ("台積電", "台灣積體電路製造股份有限公司"),
    ("國城", "國城營造有限公司"),          # 搜尋框的範例就是這家
]

# ── 3. 出現即可（不要求名次）──────────────────────────────────
PRESENT = [
    ("保吉", "保吉早午餐"),
]


def main() -> int:
    use_utf8_stdout()
    bad = 0

    for q, name, want in UNIT:
        got = subseq_score(q, name) != NO_MATCH
        ok = got == want
        bad += not ok
        print(f"{'ok  ' if ok else 'FAIL'}  「{q}」vs「{name}」"
              f"　sc={subseq_score(q, name)}　進候選={got}（期望 {want}）")

    if not X_DIR.exists():
        print(f"\n⚠ 找不到 {X_DIR}，跳過需要分片的檢查。"
              f"\n  分片不進 git，要先跑 python -m pipeline.publish。")
        return 1 if bad else 0

    def bucket(ch: str) -> list[str]:
        p = X_DIR / f"{fnv1a(ch) % X_SHARDS}.json"
        return json.loads(p.read_text(encoding="utf-8")).get(ch, [])

    print()
    for q, want in FIRST:
        got = rank(q, bucket(q[0]))
        ok = bool(got) and got[0] == want
        bad += not ok
        print(f"{'ok  ' if ok else 'FAIL'}  「{q}」第一名 = "
              f"{got[0] if got else '（無候選）'}　期望 {want}")

    for q, want in PRESENT:
        got = rank(q, bucket(q[0]))
        ok = want in got
        bad += not ok
        print(f"{'ok  ' if ok else 'FAIL'}  「{q}」候選含「{want}」= {ok}")

    # ── 4. 回歸：打自己名字的前 2–4 個字，一定找得到自己 ──────────
    total = miss = 0
    for p in X_DIR.glob("*.json"):
        for names in json.loads(p.read_text(encoding="utf-8")).values():
            for nm in names:
                total += 1
                if any(len(nm) > k and subseq_score(nm[:k], nm) == NO_MATCH
                       for k in (2, 3, 4)):
                    miss += 1
    ok = miss == 0
    bad += not ok
    print(f"\n{'ok  ' if ok else 'FAIL'}  索引 {total:,} 家，"
          f"「打自己名字前 2–4 字找不到自己」的有 {miss:,} 家（期望 0）")

    print("\n全部通過。" if not bad else f"\n⚠ {bad} 項未通過。")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
