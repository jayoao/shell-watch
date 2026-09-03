"""最終排序：身分可信度 × 換殼樣態，兩層分開算。

    python -m pipeline.rank

要先有 data/joined.csv 與 data/gcis.duckdb。
輸出 data/ranked.csv —— 這是人工標註與前端展示的母體。

────────────────────────────────────────────────────────────────
為什麼要分兩層
────────────────────────────────────────────────────────────────
2026-09-03 用商工登記的同地址當獨立量尺，實測發現訊號分成兩種，
它們回答的是**不同的問題**：

    身分訊號   姓名稀有度（3.24×）、同縣市（1.49×）、同地址（274×）
               → 「這幾家公司是不是同一個人的」
    樣態訊號   先前的公司已停業、時間依序、組織型態、公司數
               → 「這個樣子像不像換殼」

「先前的公司都已停業」在身分這把尺上是 **0.98 倍** —— 完全沒有效果。
那不是因為它沒用，是因為它回答的是另一個問題
（而且全國本來就有 55% 的登記已經解散／歇業，它接近基準率）。

**把兩種訊號加進同一個分數，等於把兩個問題混成一個答案。**
所以這裡分開算：先判斷「可不可信」，再判斷「是什麼樣態」。

────────────────────────────────────────────────────────────────
身分層怎麼定，以及怎麼避免循環論證
────────────────────────────────────────────────────────────────
分層只用**姓名稀有度**與**同縣市**兩個訊號，
然後用**同地址**去校準每一層 —— 同地址沒有參與分層，所以校準是獨立的。

同地址本身是最強的單一證據（隨機機率 0.0158%，候選是 274 倍），
它不參與分層，而是在分完層之後**直接把該組升到最高層**。
"""
from __future__ import annotations

import csv
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                          # noqa: E402
from pipeline.join import norm_addr, norm_name              # noqa: E402
from pipeline.refine import load_facts, same_address        # noqa: E402

JOINED = Path("data/joined.csv")
DB = Path("data/gcis.duckdb")
OUT = Path("data/ranked.csv")

# 身分層。分數門檻是從 rarity.py 的分層驗證來的
# （同縣市比例 31%→59% 的那條曲線，3 分之後才明顯拉開）。
TIERS = [
    ("A 姓名罕見＋同縣市", lambda score, county: score >= 3 and county),
    ("B 姓名罕見", lambda score, county: score >= 3),
    ("C 同縣市", lambda score, county: county),
    ("D 兩者都沒有", lambda score, county: True),
]


def main() -> int:
    use_utf8_stdout()
    for p in (JOINED, DB):
        if not p.exists():
            print(f"找不到 {p}", file=sys.stderr)
            return 1
    import duckdb

    with JOINED.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    wanted = {norm_name(n) for r in rows
              for n in r["company_list"].split(" → ") if n.strip()}
    con = duckdb.connect(str(DB), read_only=True)
    facts, addr_users = load_facts(con, wanted)

    def score_of(r) -> float:
        try:
            return float(r.get("score") or 0)
        except ValueError:
            return 0.0

    items = []
    for r in rows:
        names = r["company_list"].split(" → ")
        score = score_of(r)
        county = r.get("same_unit") == "1" and r.get("county_only") == "1"
        addr = same_address(names, facts, addr_users)
        tier = next(t for t, pred in TIERS if pred(score, county))
        items.append({"row": r, "score": score, "county": county,
                      "addr": addr, "tier": tier, "names": names})

    # ── 校準：每一層的同地址比例（同地址沒參與分層，所以是獨立的）──
    print("身分分層的校準")
    print("分層只用「姓名稀有度」與「同縣市」；")
    print("同地址沒有參與分層，拿來當獨立的驗證尺。\n")
    base = sum(1 for i in items if i["addr"]) / max(1, len(items))
    stats = []
    print(f"  {'層級':<20}{'組數':>8}{'同地址':>8}{'比例':>9}{'±2SE':>9}")
    for tier, _ in TIERS:
        grp = [i for i in items if i["tier"] == tier]
        if not grp:
            continue
        hit = sum(1 for i in grp if i["addr"])
        pr = hit / len(grp)
        se2 = 2 * math.sqrt(pr * (1 - pr) / len(grp)) * 100
        stats.append((tier, len(grp), 100 * pr, se2))
        print(f"  {tier:<20}{len(grp):>8,}{hit:>8,}"
              f"{100 * pr:>8.2f}%{se2:>8.2f}")
    print(f"\n  整體 {100 * base:.2f}%\n")

    # ⚠ 比較相鄰兩層時**一定要看樣本數**。
    #   C 層只有一百多組，2SE 是 ±4 個百分點，
    #   跟 B 層的區間大幅重疊 —— 那是「分不出來」不是「排錯了」。
    #   第一版寫成「比例沒遞減就判定分層失敗」，把雜訊當成錯誤。
    for (t1, n1, r1, s1), (t2, n2, r2, s2) in zip(stats, stats[1:]):
        d = r1 - r2
        pooled = math.sqrt((s1 / 2) ** 2 + (s2 / 2) ** 2)
        if d > 2 * pooled:
            print(f"  {t1[0]} > {t2[0]}　✓ 顯著（差 {d:+.2f}，2SE {2*pooled:.2f}）")
        elif d < -2 * pooled:
            print(f"  {t1[0]} < {t2[0]}　⚠ 反過來了，順序要調"
                  f"（差 {d:+.2f}，2SE {2*pooled:.2f}）")
        else:
            print(f"  {t1[0]} ≈ {t2[0]}　－ 分不出來"
                  f"（差 {d:+.2f}，2SE {2*pooled:.2f}"
                  f"{'，' + t2 + ' 只有 %d 組' % n2 if n2 < 400 else ''}）")

    # ── 同地址直接升到 A ──
    upgraded = 0
    for i in items:
        if i["addr"] and i["tier"] != "A 姓名罕見＋同縣市":
            i["tier"] = "A 姓名罕見＋同縣市"
            i["upgraded"] = True
            upgraded += 1
        else:
            i["upgraded"] = False
    print(f"\n同地址直接升到 A 層：{upgraded:,} 組")

    # ── 兩層交叉 ──
    kinds = ["換殼候選", "存疑", "組織變更", "同一公司", "分支機構", "集團"]
    matrix: dict[tuple[str, str], int] = Counter()
    for i in items:
        matrix[(i["tier"], i["row"].get("kind", "?"))] += 1

    present = [k for k in kinds if any(kk == k for _, kk in matrix)]
    print("\n" + "═" * 66)
    if len(present) > 1:
        print("身分可信度（能不能信這是同一人） × 樣態（像不像換殼）")
        print("═" * 66)
        print(f"\n  {'':<20}" + "".join(f"{k:>10}" for k in present))
        for tier, _ in TIERS:
            cells = "".join(f"{matrix.get((tier, k), 0):>10,}" for k in present)
            print(f"  {tier:<20}{cells}")
    else:
        # joined.csv 是從 shell_candidates.csv 來的，裡面只有換殼候選。
        # 樣態層在上游就篩過了，這裡只剩身分層要排。
        print(f"身分可信度分層（樣態已在 shell.py 篩成「{present[0]}」）")
        print("═" * 66)
        print(f"\n  {'層級':<22}{'組數':>9}{'同地址':>9}")
        for tier, _ in TIERS:
            grp = [i for i in items if i["tier"] == tier]
            if not grp:
                continue
            print(f"  {tier:<22}{len(grp):>9,}"
                  f"{sum(1 for i in grp if i['addr']):>9,}")
        print("\n  （同地址那一欄升層後全部集中在 A —— 那是設計如此，"
              "不是其他層沒有同地址的組）")

    key = [i for i in items
           if i["tier"].startswith("A") and i["row"].get("kind") == "換殼候選"]
    print(f"\n  左上角那一格 —— A 層 × 換殼候選：**{len(key):,} 組**")
    print("  那是「證據最足、樣態也對」的一批，人工標註與前端展示都從這裡出。")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    fields = list(rows[0]) + ["identity_tier", "gcis_same_address",
                              "tier_upgraded_by_address"]
    order = {t: n for n, (t, _) in enumerate(TIERS)}
    with OUT.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for i in sorted(items, key=lambda x: (order[x["tier"]],
                                              x["row"].get("kind") != "換殼候選",
                                              -x["score"])):
            w.writerow({**i["row"], "identity_tier": i["tier"],
                        "gcis_same_address": int(i["addr"]),
                        "tier_upgraded_by_address": int(i["upgraded"])})
    print(f"\n→ {OUT}")

    print("""
⚠ 三件事要記得：
  1. 這是**待查訊號**的排序，不是「這些人在換殼」的判定。
  2. 身分層與樣態層要分開呈現，不要合成一個「風險分數」——
     那會把兩個不同的問題混成一個答案。
  3. link_review.csv 是用舊的單層排序抽的，**要重抽**
     （python -m tools.make_review），不然標註的母體跟最終產品對不上。""")
    con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
