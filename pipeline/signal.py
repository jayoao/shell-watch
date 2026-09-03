"""把「同名多公司」分級，並檢定它是不是同名巧合造成的。

    python -m pipeline.signal

先跑過 python -m pipeline.build（要有 data/records.csv）。

────────────────────────────────────────────────────────────────
為什麼要有這支：build.py 印的數字不能用
────────────────────────────────────────────────────────────────
build.py 說「1,158 個名字，各公司違法期間不重疊」。那個數字被高估了，
有兩個原因：

1. **稀疏資料的算術必然。** 如果一個名字底下兩家公司各只有 1 筆違法，
   那就是兩個時間點，只要不同天就一定「不重疊」。
   「不重疊」在這種情況下不代表任何事。
   → 這裡要求**至少一家有 2 筆以上**（span 要真的是一段期間），
     而且兩段之間要有 **90 天以上的間隔**（換家公司重開需要時間）。

2. **同名。** 「陳志明」名下有兩家公司，跟「歐陽承翰」名下有兩家公司，
   證據強度差好幾個量級。build.py 一視同仁。

────────────────────────────────────────────────────────────────
同名巧合的檢定（不需要外部資料，用手上的資料就能做）
────────────────────────────────────────────────────────────────
如果「同名 = 同一人」，那同一個人開的公司**應該集中在同一個縣市**
（人不會為了換殼特地跨半個台灣）。如果只是同名巧合，兩家公司落在
哪個縣市應該互相獨立。

所以比較兩個數字：

    實際  這些名字的多家公司「全部在同一縣市」的比例
    期望  依各縣市的公司數分布，隨機抽兩家落在同縣市的機率

實際 >> 期望 → 這些連結不是巧合，同名多公司確實帶訊號。
實際 ≈ 期望 → 訊號就是同名雜訊，換殼追蹤要重新考慮。

⚠ 這個檢定證明的是「整體上有訊號」，不是「這一組是同一人」。
   個別配對還是要人工標註 + 一致率（Cohen's kappa）。
   簡報上只能說「這批連結整體顯著偏離隨機」，
   **不能說「我們找出了 N 個換殼案例」。**
"""
from __future__ import annotations

import csv
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout            # noqa: E402

RECORDS = Path("data/records.csv")
OUT = Path("data/candidates.csv")

MIN_GAP_DAYS = 90          # 兩家公司違法期間之間至少要隔這麼久
SEED = 20260902

# ⚠ 這些不是縣市，是中央機關與園區管理局，管轄範圍跨全台。
#    「兩家公司同屬職業安全衛生署」在地理上不代表任何事 ——
#    可能一家在屏東、一家在基隆。而職安署一個單位就占職安法資料的 53%，
#    光「兩家都落在職安署」的機率就有 0.28，會把同縣市檢定的分子與分母
#    同時灌水，結果是真實訊號被往 1 壓。
#    所以要另外算一次「只看真縣市」的版本，那個才是乾淨的讀數。
CENTRAL_UNITS = {
    "職業安全衛生署", "勞動部",
    "勞動部勞工保險局", "勞動部勞動基金運用局",
    "產業園區管理局", "新竹科學園區", "中部科學園區", "南部科學園區",
}


def _days(roc: str) -> int | None:
    """民國 115/08/05 → 從民國元年起算的天數（粗略，用來比大小與算間隔）。"""
    try:
        y, m, d = (int(x) for x in roc.split("/"))
    except (ValueError, AttributeError):
        return None
    return (y + 1911) * 365 + m * 30 + d


def load() -> list[dict]:
    if not RECORDS.exists():
        print(f"找不到 {RECORDS}，先跑 python -m pipeline.build", file=sys.stderr)
        raise SystemExit(1)
    with RECORDS.open(encoding="utf-8-sig", newline="") as f:
        return [r for r in csv.DictReader(f) if r.get("principal") and r.get("company")]


def main() -> int:
    use_utf8_stdout()
    rows = load()

    # 負責人 → 公司 → (縣市集合, 處分日期清單)
    tree: dict[str, dict[str, dict]] = defaultdict(lambda: defaultdict(
        lambda: {"units": set(), "dates": []}))
    for r in rows:
        cell = tree[r["principal"]][r["company"]]
        cell["units"].add(r["unit"])
        d = _days(r["disposition_date"])
        if d is not None:
            cell["dates"].append(d)

    multi = {p: cs for p, cs in tree.items() if len(cs) >= 2}

    tiers: Counter[str] = Counter()
    same_unit_hits = 0
    out_rows = []

    for principal, companies in multi.items():
        spans = []
        for name, cell in companies.items():
            if not cell["dates"]:
                continue
            spans.append((min(cell["dates"]), max(cell["dates"]),
                          len(cell["dates"]), name, cell["units"]))
        if len(spans) < 2:
            continue
        spans.sort()

        # 全部公司都在同一個縣市／單位？
        all_units = set().union(*(s[4] for s in spans))
        same_unit = len(all_units) == 1
        same_unit_hits += same_unit

        # 依序排開、每一段之間有真的間隔
        sequential = all(spans[i][1] + MIN_GAP_DAYS <= spans[i + 1][0]
                         for i in range(len(spans) - 1))
        # 至少一家有 2 筆以上，span 才是「一段期間」而不是一個點
        has_span = any(s[2] >= 2 for s in spans)
        # 名字越長，同名機率越低。2 字名基本上不能當證據。
        name_len = len(principal)

        if sequential and has_span and same_unit and name_len >= 3:
            tier = "A 同縣市＋依序＋有期間"
        elif sequential and same_unit and name_len >= 3:
            tier = "B 同縣市＋依序（各家只有單筆）"
        elif sequential and name_len >= 3:
            tier = "C 跨縣市（同名疑慮高）"
        elif name_len <= 2:
            tier = "D 二字姓名（同名率過高，排除）"
        else:
            tier = "E 期間重疊（同時經營，非換殼）"
        tiers[tier] += 1

        if tier.startswith(("A", "B")):
            out_rows.append({
                "principal": principal,
                "companies": len(spans),
                "records": sum(s[2] for s in spans),
                "unit": next(iter(all_units)),
                "tier": tier[0],
                "company_list": " → ".join(s[3] for s in spans),
            })

    # ── 同名巧合的對照：隨機抽同樣多家公司，有多少組會全落在同一縣市 ──
    unit_of_company: dict[str, str] = {}
    for r in rows:
        unit_of_company.setdefault(r["company"], r["unit"])

    def coincidence_test(only_counties: bool) -> tuple[int, float, int]:
        """回傳 (實際全同縣市組數, 隨機期望值, 納入檢定的組數)。"""
        pool = [u for u in unit_of_company.values()
                if not only_counties or u not in CENTRAL_UNITS]
        if not pool:
            return 0, 0.0, 0

        actual, sizes = 0, []
        for companies in multi.values():
            units = [next(iter(c["units"])) for c in companies.values()
                     if c["dates"] and c["units"]]
            if only_counties:
                if any(u in CENTRAL_UNITS for u in units):
                    continue          # 只要沾到中央機關就整組不算
            if len(units) < 2:
                continue
            sizes.append(len(units))
            actual += len(set(units)) == 1

        rng = random.Random(SEED)
        trials = 400
        hits = sum(len({rng.choice(pool) for _ in range(k)}) == 1
                   for _ in range(trials) for k in sizes)
        return actual, hits / trials, len(sizes)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["principal", "companies", "records",
                                          "unit", "tier", "company_list"])
        w.writeheader()
        w.writerows(sorted(out_rows, key=lambda r: (r["tier"], -r["records"])))

    total = sum(tiers.values())
    print(f"同名多公司  {total:,} 組\n")
    for tier, n in sorted(tiers.items()):
        print(f"  {tier:<28} {n:>6,}   {100 * n / total:5.1f}%")
    print(f"\n→ A + B 共 {len(out_rows):,} 組寫到 {OUT}"
          f"（人工標註就從這裡抽樣）")

    print(f"\n── 同名巧合檢定 ──")
    ratio = 0.0
    for label, only_counties in (("全部單位（含職安署等中央機關）", False),
                                 ("只看真縣市（排除中央機關）", True)):
        act, exp, n = coincidence_test(only_counties)
        if not n:
            print(f"\n  {label}：沒有可用的組")
            continue
        r = act / exp if exp else float("inf")
        print(f"\n  {label}　（{n:,} 組）")
        print(f"    實際全同縣市   {act:>6,}  = {100 * act / n:5.1f}%")
        print(f"    隨機期望值     {exp:>6,.0f}  = {100 * exp / n:5.1f}%")
        print(f"    倍數           {r:>6.1f}×")
        if only_counties:
            ratio = r                 # 以乾淨的讀數作結論

    print()
    if ratio >= 2:
        print("\n  → 顯著高於隨機。同名多公司確實帶訊號，換殼追蹤站得住。")
    elif ratio >= 1.3:
        print("\n  → 高於隨機但不算強。可以做，但要老實講清楚不確定性。")
    else:
        print("\n  → 跟隨機差不多。這批連結很可能就是同名雜訊，")
        print("     建議走第二層退路（慣性違法雇主圖譜，不需要跨公司連結）。")

    print("\n  結論以「只看真縣市」那一列為準 —— 職安署管轄跨全台，")
    print("  兩家公司同屬職安署在地理上不代表任何事。")
    print("\n⚠ 這個檢定說的是「整體偏離隨機」，不是「這一組是同一人」。")
    print("   個別配對還是要人工標註 + Cohen's kappa。")
    print("   簡報不可以寫「我們找出 N 個換殼案例」。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
