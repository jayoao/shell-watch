"""姓名稀有度：把「這個連結有多可信」變成一個可解釋、可稽核的分數。

    python -m pipeline.rarity

先跑過 python -m pipeline.build（要有 data/records.csv）。

────────────────────────────────────────────────────────────────
問題
────────────────────────────────────────────────────────────────
「陳志明名下有 2 家違法公司」跟「歐陽承翰名下有 2 家違法公司」，
在 signal.py 裡是同一級。但前者幾乎確定是巧合，後者幾乎確定是同一人。
差別是**姓名的稀有度**，而 signal.py 只用了「幾個字」這個粗糙的代理。

────────────────────────────────────────────────────────────────
做法：不用外部資料，從 135,090 個姓名自己估
────────────────────────────────────────────────────────────────
把姓名拆成「姓 + 名」，分別估機率再相乘：

    P(歐陽承翰) = P(姓=歐陽) × P(名=承翰 | 名長 2)

**為什麼要拆開**：如果直接數出現次數，「歐陽承翰」出現 2 次 → p = 2/N，
反而看起來不稀有 —— 這是循環論證，我們要判斷的就是那 2 次是不是巧合。
拆開之後，P(歐陽) 很小、P(承翰) 也不大，乘起來得到一個**不依賴這 2 次觀測**
的機率估計。這是這支程式的核心，也是簡報上「技術怎麼證明」的主軸。

然後算「照機率，這個名字本來預期會出現在幾家公司上」：

    λ = 全部公司數 × P(姓名)

再用 Poisson 上尾算「實際看到 k 家」有多不尋常：

    p_value = P(X ≥ k | λ)        score = -log10(p_value)

    score 0–1   照機率本來就會這樣，不是證據
    score 1–3   有點不尋常
    score ≥ 3   一千次裡不到一次，這個連結值得看

────────────────────────────────────────────────────────────────
這個分數自己有沒有效？程式會自己驗
────────────────────────────────────────────────────────────────
如果稀有度分數真的在量「是不是同一人」，那**分數越高的組，
名下公司落在同一縣市的比例應該越高**（同一個人不會為了換殼跨半個台灣，
但兩個同名的陌生人落在哪個縣市是獨立的）。

程式會把候選依分數分層，印出每一層的同縣市比例。
單調上升 = 分數有效。持平 = 分數沒用，要重想。
**這張表就是簡報上證明技術有效的那張圖。**

────────────────────────────────────────────────────────────────
誠實揭露（文件與簡報都要寫）
────────────────────────────────────────────────────────────────
1. 機率是用**違法雇主**的姓名分布估的，不是全國人口。違法雇主以
   營造、製造業居多，姓名分布可能跟全國有偏差。正確的分母是經濟部
   商工登記的全國負責人姓名分布（g0v 有），那是第二階段要接的。
2. 姓名獨立性假設（P(姓名) = P(姓)×P(名)）不完全成立 ——
   有些名字跟姓有搭配習慣。這會讓罕見組合的機率被低估一點，
   也就是分數**偏高**。所以門檻要抓保守。
3. **分數高不等於是同一人。** 它量的是「這個巧合有多難得」，
   不是「這是同一人」。最終仍然要人工標註 + Cohen's kappa。
"""
from __future__ import annotations

import csv
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                     # noqa: E402
from pipeline.signal import CENTRAL_UNITS, MIN_GAP_DAYS, _days   # noqa: E402

RECORDS = Path("data/records.csv")
OUT = Path("data/candidates_scored.csv")

# 台灣的複姓（含冠夫姓的雙姓）。沒有這張表，「范姜」會被當成姓范名姜○，
# 機率估歪一個量級。
COMPOUND_SURNAMES = {
    "歐陽", "司馬", "諸葛", "上官", "皇甫", "尉遲", "澹臺", "澹台", "公孫",
    "慕容", "長孫", "宇文", "司徒", "司空", "夏侯", "東方", "獨孤", "令狐",
    "范姜", "張簡", "張廖", "陳黃", "郭李", "吳李", "林陳", "黃陳", "李陳",
    "王陳", "劉陳", "蔡陳", "楊陳", "許陳", "鄭陳", "謝陳", "洪陳", "曾陳",
}

SMOOTH = 0.5          # 加法平滑，避免沒看過的名字機率變成 0


def split_name(name: str) -> tuple[str, str]:
    """姓名 → (姓, 名)。拆不開就整個當「名」，機率會估得很小（保守）。"""
    if len(name) >= 3 and name[:2] in COMPOUND_SURNAMES:
        return name[:2], name[2:]
    if len(name) >= 2:
        return name[:1], name[1:]
    return "", name


def poisson_tail(k: int, lam: float) -> float:
    """P(X ≥ k | Poisson(lam))。

    ⚠ 直接累加會在 lam 大於約 745 時爆掉 —— math.exp(-lam) 下溢成 0.0，
      結果變成 p=1.0，分數 0，把該標注的組默默漏掉。
      常見姓名的 lam 真的會到幾百，所以這裡分兩條路走。
    """
    if lam <= 0:
        return 0.0 if k > 0 else 1.0
    if k <= 0:
        return 1.0
    if lam > 500:                       # 常態近似，避免下溢
        z = (k - 0.5 - lam) / math.sqrt(lam)
        return 0.5 * math.erfc(z / math.sqrt(2))
    cum, term = 0.0, math.exp(-lam)
    for i in range(k):
        if i:
            term *= lam / i
        cum += term
    return max(0.0, min(1.0, 1.0 - cum))


class NameModel:
    """P(姓名) = P(姓) × P(名 | 名的長度)。"""

    def __init__(self, names: list[str]):
        self.surname = Counter()
        self.given: dict[int, Counter] = defaultdict(Counter)
        for n in names:
            s, g = split_name(n)
            self.surname[s] += 1
            self.given[len(g)][g] += 1
        self.n = len(names)
        self.len_share = Counter(len(split_name(n)[1]) for n in names)

    def prob(self, name: str) -> float:
        s, g = split_name(name)
        p_s = (self.surname[s] + SMOOTH) / (self.n + SMOOTH * len(self.surname))
        bucket = self.given[len(g)]
        total = sum(bucket.values())
        # 名的空間有多大：用觀察到的種類數當下界，再放寬一個數量級，
        # 免得罕見名字的機率被高估（高估 = 分數偏低 = 保守，可接受）
        space = max(len(bucket) * 10, 1)
        p_g = (bucket[g] + SMOOTH) / (total + SMOOTH * space)
        p_len = (self.len_share[len(g)] + SMOOTH) / (self.n + SMOOTH * 4)
        return p_s * p_g * p_len


def main() -> int:
    use_utf8_stdout()
    if not RECORDS.exists():
        print(f"找不到 {RECORDS}，先跑 python -m pipeline.build", file=sys.stderr)
        return 1
    with RECORDS.open(encoding="utf-8-sig", newline="") as f:
        rows = [r for r in csv.DictReader(f) if r.get("principal") and r.get("company")]

    tree: dict[str, dict[str, dict]] = defaultdict(
        lambda: defaultdict(lambda: {"units": set(), "dates": []}))
    for r in rows:
        cell = tree[r["principal"]][r["company"]]
        cell["units"].add(r["unit"])
        d = _days(r["disposition_date"])
        if d is not None:
            cell["dates"].append(d)

    # ⚠ 機率模型要用「**每家公司一筆**」的姓名來估，不是「每個不重複姓名一筆」。
    #
    #   一開始寫成用不重複姓名，結果是災難：P(名=明) 變成「有多少種名字含明」，
    #   而不是「有多少人叫明」。常見姓名的期望值 λ 被嚴重低估，於是
    #   「陳志明名下 29 家公司」被判成 99 分的重大發現 —— 而那正是 29 個不同的人。
    #   分數把最不可信的組排到最前面，完全反過來。
    #
    #   λ = 公司數 × P(姓名) 這個式子裡的 P 是「公司母體上的姓名分布」，
    #   所以估計也要在同一個母體上做。
    #
    #   會不會循環論證（用這個名字自己的出現次數去判斷它稀不稀有）？
    #   不會 —— 因為拆成姓與名之後，單一姓名對 P(姓)、P(名) 的貢獻
    #   是幾萬分之一，可以忽略。這就是要拆開的第二個理由。
    company_principal = {}
    for r in rows:
        company_principal.setdefault(r["company"], r["principal"])
    model = NameModel(list(company_principal.values()))
    n_companies = len(company_principal)

    print(f"姓名 {len(tree):,} 個　公司 {n_companies:,} 家　"
          f"姓氏 {len(model.surname):,} 種\n")

    scored = []
    for principal, companies in tree.items():
        if len(companies) < 2:
            continue
        spans = []
        for cname, cell in companies.items():
            if cell["dates"]:
                spans.append((min(cell["dates"]), max(cell["dates"]),
                              len(cell["dates"]), cname,
                              next(iter(cell["units"]))))
        if len(spans) < 2:
            continue
        spans.sort()

        k = len(spans)
        lam = n_companies * model.prob(principal)
        p = poisson_tail(k, lam)
        score = -math.log10(p) if p > 0 else 99.0

        units = [s[4] for s in spans]
        same_unit = len(set(units)) == 1
        county_only = not any(u in CENTRAL_UNITS for u in units)
        sequential = all(spans[i][1] + MIN_GAP_DAYS <= spans[i + 1][0]
                         for i in range(k - 1))
        overlapping = not sequential

        scored.append({
            "principal": principal,
            "companies": k,
            "records": sum(s[2] for s in spans),
            "expected_by_chance": round(lam, 3),
            "p_value": f"{p:.3g}",
            "score": round(score, 2),
            "pattern": "換殼（依序）" if sequential else "集團（同時）",
            "same_unit": int(same_unit),
            "county_only": int(county_only),
            "unit": units[0] if same_unit else "／".join(sorted(set(units))),
            "company_list": " → ".join(s[3] for s in spans),
        })

    scored.sort(key=lambda r: -r["score"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(scored[0]))
        w.writeheader()
        w.writerows(scored)

    # ── 驗證：分數越高，同縣市比例應該越高 ──
    county = [s for s in scored if s["county_only"]]
    print("── 分數有效性驗證（只用有縣市的組，中央機關沒有地理意義）──")
    print("   如果分數在量「是不是同一人」，同縣市比例應該隨分數單調上升。\n")
    print("   分數區間        組數    同縣市    比例")
    bands = [(0, 1), (1, 2), (2, 3), (3, 5), (5, 10), (10, 1e9)]
    rates = []
    MIN_BAND = 50            # 組數太少的層是雜訊，不能拿來判斷趨勢
    for lo, hi in bands:
        grp = [s for s in county if lo <= s["score"] < hi]
        if not grp:
            continue
        hit = sum(s["same_unit"] for s in grp)
        rate = hit / len(grp)
        label = f"{lo:>2}–{hi:<3.0f}" if hi < 1e9 else f"{lo:>2}+   "
        bar = "█" * round(rate * 30)
        thin = "" if len(grp) >= MIN_BAND else "   ← 組數太少，不列入判斷"
        print(f"   {label}      {len(grp):>6,}  {hit:>7,}   {100*rate:5.1f}%  {bar}{thin}")
        if len(grp) >= MIN_BAND:
            rates.append(rate)

    mono = all(b >= a - 0.02 for a, b in zip(rates, rates[1:]))
    print()
    if len(rates) >= 3 and mono and rates[-1] > rates[0] * 1.5:
        print("   → 單調上升。稀有度分數確實在量「是不是同一人」，可以用。")
    elif len(rates) >= 3 and rates[-1] > rates[0] * 1.5:
        print("   → 整體上升但不完全單調。方向對，門檻要抓保守一點。")
    else:
        print("   → 沒有明顯趨勢。這個分數沒有量到東西，不要用它當可信度。")

    print("\n── 依樣態與分數的候選數 ──")
    print("   分數 ≥3 表示「照機率一千次裡不到一次」\n")
    print("   樣態              分數≥3    其中同縣市")
    for pat in ("換殼（依序）", "集團（同時）"):
        hi = [s for s in scored if s["pattern"] == pat and s["score"] >= 3]
        hi_c = [s for s in hi if s["county_only"] and s["same_unit"]]
        print(f"   {pat:<16} {len(hi):>6,}    {len(hi_c):>6,}")

    print(f"\n全部 {len(scored):,} 組（含分數）寫到 {OUT}")
    print("\n── 分數最高的 10 組 ──")
    for s in scored[:10]:
        print(f"   {s['score']:>5.1f}  {s['principal']:<8} {s['companies']}家 "
              f"{s['pattern']}  {s['company_list'][:44]}")

    print("\n⚠ 分數高 = 這個巧合很難得，**不等於是同一人**。")
    print("   機率是用違法雇主的姓名分布估的，不是全國人口；")
    print("   正確的分母是經濟部商工登記（第二階段要接）。")
    print("   最終判定仍要人工標註 + Cohen's kappa。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
