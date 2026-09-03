"""把「換殼」與「集團」分開，並把大型企業擋在換殼名單外。

    python -m pipeline.shell

先跑過 python -m pipeline.build（要有 data/records.csv）。

────────────────────────────────────────────────────────────────
為什麼需要這一支
────────────────────────────────────────────────────────────────
rarity.py 的分數在量「這個關聯有多難得」，它做對了 —— 分數最高的幾組
是統一、遠東、統聯這些真實集團，系統在沒有任何先驗知識的情況下把它們
拼了回來。但那是**正確的辨識、錯誤的目標**：求職者不需要一個 app
告訴他統一超商的老闆也開統一企業。

要擋掉大企業，最直接的作法是看實收資本額、設立年份、董監事人數 ——
那些在經濟部商工登記裡，是第二階段的事。這一支用**現在手上就有的資訊**
先做出可用的分辨。

────────────────────────────────────────────────────────────────
四個訊號（都不需要外部資料）
────────────────────────────────────────────────────────────────
1. **時間樣態**　集團同時經營、換殼先後接續。這是定義上的差別。
2. **公司名相似度**　集團共用字根（統一超商／統一企業／統昶行銷、
   遠東百貨／遠百企業／遠傳電信）；換殼通常刻意改名，名稱不相關。
3. **組織型態**　集團是股份有限公司；換殼多是有限公司、企業社、
   工程行、獨資商號 —— 資本額門檻低、開關容易。
4. **公司數**　名下 10 家以上幾乎必然是集團，不是一個人輪流換殼。

判定用規則不用模型：這件事會影響公司名譽，每一條都要能逐條說明理由。

────────────────────────────────────────────────────────────────
自我檢查
────────────────────────────────────────────────────────────────
程式最後會驗一件事：**已知的大集團有沒有被正確擋在換殼名單外。**
檢查名單用的是公司名（法人），不是自然人姓名。
這一項失敗就代表規則有洞，不要用輸出。
"""
from __future__ import annotations

import csv
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                # noqa: E402
from pipeline.rarity import NameModel, poisson_tail               # noqa: E402
from pipeline.signal import CENTRAL_UNITS, MIN_GAP_DAYS, _days    # noqa: E402

RECORDS = Path("data/records.csv")
OUT_SHELL = Path("data/shell_candidates.csv")
OUT_GROUP = Path("data/corporate_groups.csv")

# 已知的大型集團，用來驗規則有沒有把它們擋掉。
# 用公司名（法人）不用自然人姓名 —— 這份檔案會進 git。
KNOWN_GROUP_COMPANIES = [
    "統一企業股份有限公司", "統一超商股份有限公司",
    "遠東百貨股份有限公司", "遠傳電信股份有限公司",
    "統聯汽車客運股份有限公司", "中華電信股份有限公司",
    "台灣電力股份有限公司",
]

# 組織型態。換殼的成本跟這個直接相關 ——
# 股份有限公司要股東會、要董監事；企業社、工程行一個人就能開。
BIG_FORM = ("股份有限公司",)
SMALL_FORM = ("有限公司", "企業社", "企業行", "工程行", "工程社", "商行",
              "商號", "工作室", "土木包工業", "實業社", "加工所", "行", "社")

_FORM_STRIP = ("股份有限公司", "有限公司", "企業社", "企業行", "工程行",
               "工程社", "商行", "商號", "工作室", "土木包工業", "實業社",
               "加工所", "股份公司", "公司")

GROUP_MIN_COMPANIES = 8          # 名下這麼多家，一個人輪流換殼不現實
SIM_THRESHOLD = 0.5              # 名稱相似度（共用字根的比例）


def core_name(name: str) -> str:
    """去掉組織型態字尾，留下「字號」。統一超商股份有限公司 → 統一超商。"""
    s = name.strip()
    for suffix in _FORM_STRIP:
        if s.endswith(suffix):
            s = s[: -len(suffix)]
            break
    # 去掉常見的地區與分支修飾
    for w in ("台灣", "臺灣", "股份", "國際", "實業", "科技", "企業"):
        s = s.replace(w, "")
    return s.strip()


def name_similarity(names: list[str]) -> float:
    """一組公司名有多像。共用字根越多越像。

    統一超商／統一企業／統昶行銷 → 高（都有「統」）
    奉茶美食館／米塔政大／二雪映月 → 低
    """
    cores = [core_name(n) for n in names if core_name(n)]
    if len(cores) < 2:
        return 0.0
    # 每一家跟其他家的最長共同前綴（>=1 字就算），取平均命中率
    hits = 0
    pairs = 0
    for i in range(len(cores)):
        for j in range(i + 1, len(cores)):
            pairs += 1
            a, b = cores[i], cores[j]
            common = 0
            for x, y in zip(a, b):
                if x != y:
                    break
                common += 1
            # 前綴沒中，看有沒有共用的 2-gram
            if common >= 1:
                hits += 1
            else:
                ga = {a[k:k + 2] for k in range(len(a) - 1)}
                gb = {b[k:k + 2] for k in range(len(b) - 1)}
                if ga & gb:
                    hits += 1
    return hits / pairs if pairs else 0.0


def is_branch(name: str) -> bool:
    """外國公司的台灣分公司、或本國公司的分公司／營業所。

    「香港商亞洲博聞有限公司台灣分公司」→「香港商亞洲英富曼會展有限公司台灣分公司」
    看起來像換殼，其實是同一家外商改名。分公司不是獨立法人，換不了殼。
    """
    return bool(re.search(r"(分公司|營業所|辦事處|分處|分店)$", name)) or bool(
        re.match(r"^(薩摩亞|香港|日|美|英|法|德|韓|新加坡|開曼群島|"
                 r"英屬維京群島|荷|瑞士|馬來西亞|泰|義|加拿大|澳)商", name))


def same_core(names: list[str]) -> str | None:
    """有沒有兩家的「字號」完全相同 —— 那是改組織型態或更名，不是換殼。

        菜豚屋餐飲有限公司 → 菜豚屋餐飲股份有限公司
    兩家的字號都是「菜豚屋餐飲」。這是同一家公司變更組織，
    如果當成換殼放進名單，等於指控一家正常公司規避責任。
    """
    seen: dict[str, str] = {}
    for n in names:
        c = core_name(n)
        if len(c) >= 2 and c in seen:
            return c
        seen[c] = n
    return None


def contains_relation(names: list[str]) -> tuple[str, str] | None:
    """有沒有一家的名字完整包含另一家 —— 那是本店與分店，不是兩家公司。

        訪寶得有限公司　　　　　　　　←  這一家
        訪寶得有限公司大墩營業所　　　←  是它的營業所

    same_core() 抓不到這種，因為「…大墩營業所」不以組織型態字尾結尾，
    去不掉字尾就比不出字號相同。
    """
    for i, a in enumerate(names):
        for j, b in enumerate(names):
            if i == j or len(a) < 4:
                continue
            if a in b:
                return a, b
    return None


def form_of(name: str) -> str:
    if any(name.endswith(f) for f in BIG_FORM):
        return "股份"
    if any(name.endswith(f) for f in SMALL_FORM):
        return "小型"
    return "其他"


def classify(names: list[str], sequential: bool, n_companies: int) -> tuple[str, str]:
    """回傳 (分類, 理由)。規則有先後順序，先中先算。"""
    forms = Counter(form_of(n) for n in names)
    big_share = forms["股份"] / n_companies
    sim = name_similarity(names)

    contained = contains_relation(names)
    if contained:
        a, b = contained
        return "同一公司", f"「{b}」包含「{a}」，是本店與分支不是兩家公司"
    core = same_core(names)
    if core:
        return "組織變更", f"「{core}」字號相同，是變更組織型態或更名，不是換殼"
    if all(is_branch(n) for n in names):
        return "分支機構", "全部是分公司或外商在台分支，不是獨立法人"
    if n_companies >= GROUP_MIN_COMPANIES:
        return "集團", f"名下 {n_companies} 家，超過換殼的合理範圍"
    if not sequential:
        return "集團", "各公司違法期間重疊，是同時經營不是先後接續"
    if big_share >= 0.6 and n_companies >= 3:
        return "集團", f"{forms['股份']}/{n_companies} 家是股份有限公司"
    if sim >= SIM_THRESHOLD and n_companies >= 3:
        return "集團", f"公司名共用字根（相似度 {sim:.0%}），像同一個品牌"
    if big_share == 1.0 and n_companies == 2:
        return "存疑", "兩家都是股份有限公司，可能是集團也可能是換殼"
    return "換殼候選", f"依序接續、{forms['小型']}/{n_companies} 家是小型組織"


def main() -> int:
    use_utf8_stdout()
    if not RECORDS.exists():
        print(f"找不到 {RECORDS}，先跑 python -m pipeline.build", file=sys.stderr)
        return 1
    with RECORDS.open(encoding="utf-8-sig", newline="") as f:
        rows = [r for r in csv.DictReader(f) if r.get("principal") and r.get("company")]

    tree: dict[str, dict[str, dict]] = defaultdict(
        lambda: defaultdict(lambda: {"units": set(), "dates": [], "laws": set()}))
    for r in rows:
        c = tree[r["principal"]][r["company"]]
        c["units"].add(r["unit"])
        c["laws"].add(r["law"])
        d = _days(r["disposition_date"])
        if d is not None:
            c["dates"].append(d)

    company_principal = {}
    for r in rows:
        company_principal.setdefault(r["company"], r["principal"])
    model = NameModel(list(company_principal.values()))
    n_all = len(company_principal)

    shells, groups = [], []
    buckets: Counter[str] = Counter()

    for principal, companies in tree.items():
        if len(companies) < 2:
            continue
        spans = []
        for cname, cell in companies.items():
            if cell["dates"]:
                spans.append((min(cell["dates"]), max(cell["dates"]),
                              len(cell["dates"]), cname, next(iter(cell["units"]))))
        if len(spans) < 2:
            continue
        spans.sort()
        k = len(spans)
        names = [s[3] for s in spans]
        units = [s[4] for s in spans]

        sequential = all(spans[i][1] + MIN_GAP_DAYS <= spans[i + 1][0]
                         for i in range(k - 1))
        kind, why = classify(names, sequential, k)
        buckets[kind] += 1

        lam = n_all * model.prob(principal)
        p = poisson_tail(k, lam)
        score = round(-math.log10(p), 2) if p > 0 else 99.0

        row = {
            "principal": principal,
            "companies": k,
            "records": sum(s[2] for s in spans),
            "score": score,
            "same_unit": int(len(set(units)) == 1),
            "county_only": int(not any(u in CENTRAL_UNITS for u in units)),
            "unit": units[0] if len(set(units)) == 1 else "／".join(sorted(set(units))),
            "name_similarity": round(name_similarity(names), 2),
            "forms": "／".join(f"{f}×{n}" for f, n in
                               Counter(form_of(n) for n in names).most_common()),
            "kind": kind,
            "why": why,
            "company_list": " → ".join(names),
        }
        (shells if kind == "換殼候選" else groups).append(row)

    for path, data in ((OUT_SHELL, shells), (OUT_GROUP, groups)):
        path.parent.mkdir(parents=True, exist_ok=True)
        if not data:
            continue
        with path.open("w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=list(data[0]))
            w.writeheader()
            w.writerows(sorted(data, key=lambda r: (-r["score"], -r["companies"])))

    total = sum(buckets.values())
    print(f"同名多公司 {total:,} 組，依規則分成：\n")
    for kind, n in buckets.most_common():
        print(f"  {kind:<8} {n:>7,}   {100 * n / total:5.1f}%")

    strong = [s for s in shells if s["score"] >= 3 and s["same_unit"] and s["county_only"]]
    print(f"\n  其中換殼候選 {len(shells):,} 組 → {OUT_SHELL}")
    print(f"  高可信度（分數≥3＋同縣市）{len(strong):,} 組  ← 人工標註從這裡抽樣")
    print(f"  集團 {len(groups):,} 組 → {OUT_GROUP}")

    # ── 自我檢查：已知大集團有沒有被擋在換殼名單外 ──
    print("\n── 自我檢查：已知大集團不應該出現在換殼名單 ──")
    shell_companies = {c for s in shells for c in s["company_list"].split(" → ")}
    all_companies = shell_companies | {c for g in groups
                                       for c in g["company_list"].split(" → ")}
    found = [co for co in KNOWN_GROUP_COMPANIES if co in all_companies]
    leaked = [co for co in found if co in shell_companies]
    if not found:
        print("  資料裡沒有檢查名單上的公司，這次無法驗證")
    elif leaked:
        print(f"  失敗：{len(leaked)}/{len(found)} 家漏進換殼名單")
        for co in leaked:
            print(f"    ✗ {co}")
        print("  → 規則有洞，先不要用這份輸出。")
    else:
        print(f"  通過：檢查名單上有 {len(found)} 家在資料裡，全部歸到集團。")

    print("\n── 換殼候選分數最高的 10 組 ──")
    for s in sorted(shells, key=lambda r: -r["score"])[:10]:
        tag = "同縣市" if s["same_unit"] else "跨縣市"
        print(f"  {s['score']:>5.1f} {s['principal']:<8} {s['companies']}家 "
              f"{tag} {s['forms']:<14} {s['company_list'][:38]}")

    print("\n⚠ 「換殼候選」是待查訊號，不是判定。這裡的規則只用手上的公開紀錄，")
    print("   真正要擋大企業需要實收資本額、設立年份、董監事人數 ——")
    print("   那些在經濟部商工登記，是第二階段要接的。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
