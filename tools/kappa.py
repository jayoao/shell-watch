"""算兩個人的標註一致率（Cohen's kappa）。

    python -m tools.kappa data/link_review.csv data/link_review_nicole.csv
    python -m tools.kappa data/parse_review.csv data/parse_review_nicole.csv --by 型態

────────────────────────────────────────────────────────────────
為什麼要算 kappa 而不是直接算「答案一樣的比例」
────────────────────────────────────────────────────────────────
如果 90% 的配對兩個人都答「是」，那麼**隨便亂猜**也會有很高的相同比例。
kappa 把「碰巧一致」扣掉：

    kappa = (實際一致率 - 隨機一致率) / (1 - 隨機一致率)

    0.00–0.20  幾乎沒有一致性
    0.21–0.40  低
    0.41–0.60  中等
    0.61–0.80  好　　　← 論文與簡報可以用的水準
    0.81–1.00  非常好

kappa 低不代表誰標錯了，而是**判準不清楚**。
低的時候要做的是回去把規則書寫清楚、重標，不是改資料。

────────────────────────────────────────────────────────────────
⚠ 整體 kappa 低的時候，先按類別拆開看（--by）
────────────────────────────────────────────────────────────────
2026-09-14 的實例：T3 欄位解析整體 kappa 只有 0.231，看起來像兩個人
標得亂七八糟。按「型態」拆開之後：

    系統有拆出結果的 150 筆   一致 150/150   kappa 1.000
    系統說「拆不開」的 50 筆   一致   6/50    kappa 0.000

一致性沒有問題，問題是**題目問錯了**。「拆得對嗎」對「拆不開」這種
輸出沒有定義：一個人讀成「系統老實承認拆不開，判斷正確」，另一個讀成
「這其實拆得開，沒拆就是錯」。兩種都站得住。

**混在一起算的那個 0.231 沒有任何意義** —— 它把一個滿分的精確率
跟一個定義爭議平均成一個中間值。拆開才看得到真相。
"""
from __future__ import annotations

import csv
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout            # noqa: E402

COL_ID = "編號"

# ⚠⚠ 「編號」只是列號，**不是身分**。兩份標註檔的 L001 有可能是兩家
#    完全不同的公司 —— 2026-09-14 真的發生了：兩個人各自跑
#    `make_review.py` 產生自己的檔案，100 組裡只有 2 個負責人重疊。
#    那兩份檔案算出來的「kappa」是拿 A 的答案去比 B 的另一道題目，
#    數字會長得很正常，但完全沒有意義。
#
#    `make_review.py` 有固定 SEED，但**固定 seed 不等於固定樣本**：
#    來源資料一變（重抓、修解析器），抽出來的池子就變了。
#    正確做法是**產生一次、把檔案傳給對方**，不是兩個人各跑一次。
#
#    所以這裡要先驗「兩份檔案在講同一批東西」。下面這些欄位只要有，
#    就拿來當身分指紋比對。
IDENTITY_COLS = ("負責人姓名", "原始欄位", "違反內容", "事業單位")

# 三份標註檔的判斷欄名稱不一樣。不要寫死一個，也不要用「最後一欄」之類的
# 猜測 —— 猜錯會安靜地讀到「理由」欄，然後算出一個看起來很正常的 kappa。
LABEL_COLS = (
    "判斷（是/可能/否/無法判斷）",              # T6 配對
    "嚴重度（輕微/中度/重大/無法判斷）",          # T7 嚴重度
    "拆得對嗎（對/錯）",                      # T3 欄位解析
)


def label_col(fieldnames) -> str:
    for c in LABEL_COLS:
        if c in (fieldnames or ()):
            return c
    raise SystemExit(
        "這個檔案沒有認得出來的判斷欄。支援的欄名：\n  "
        + "\n  ".join(LABEL_COLS))


# ⚠ 標註者會寫出選項以外的東西，那通常代表**選項不夠用**，不是他做錯。
#   2026-09-14 的 T6：一位標註者有 10 筆寫成「資料不全」「資料不全（傾向可能）」
#   「可能（部分證據很強）」。她想表達的是「無法判斷，而且是因為欄位缺值」
#   與「可能，但偏強」—— 四個選項確實裝不下。
#
#   ⚠ 收斂規則要**寫死在程式裡並印出來**，不可以私下手動改標註檔。
#     改檔案等於替對方重新作答，而且事後沒有人知道改了什麼。
#     寫在這裡，任何人重跑都會看到同一條規則。
NORMALIZE = (
    ("資料不全", "無法判斷"),      # 缺欄位導致無法判斷 → 無法判斷
    ("可能", "可能"),              # 「可能（部分證據很強）」→ 可能
    ("無法判斷", "無法判斷"),
)


def canon(label: str) -> str:
    t = (label or "").strip()
    if t in ("是", "可能", "否", "無法判斷"):
        return t
    for prefix, to in NORMALIZE:
        if t.startswith(prefix):
            return to
    return t                       # 認不出來就原樣留著，讓它在矩陣裡現形


def read(path: Path) -> tuple[dict[str, str], str]:
    out: dict[str, str] = {}
    with path.open(encoding="utf-8-sig", newline="") as f:
        rd = csv.DictReader(f)
        col = label_col(rd.fieldnames)
        for r in rd:
            rid = (r.get(COL_ID) or "").strip()
            lab = canon(r.get(col) or "")
            if rid and lab:
                out[rid] = lab
    return out, col


def fingerprints(path: Path) -> tuple[dict[str, str], str] | tuple[None, None]:
    """{編號: 身分指紋}。找不到可用的身分欄位就回 (None, None)。"""
    with path.open(encoding="utf-8-sig", newline="") as f:
        rd = csv.DictReader(f)
        col = next((c for c in IDENTITY_COLS if c in (rd.fieldnames or ())), None)
        if not col:
            return None, None
        out: dict[str, str] = {}
        cur = None
        for r in rd:
            rid = (r.get(COL_ID) or "").strip()
            if rid:
                cur = rid
                out[rid] = (r.get(col) or "").strip()
            elif cur and not out.get(cur):
                # 一組佔好幾列時，身分欄可能只填在第一列
                out[cur] = (r.get(col) or "").strip()
    return out, col


def check_same_sample(pa: Path, pb: Path) -> None:
    """⚠ 兩份檔案不是同一批樣本就直接停。理由見 IDENTITY_COLS 的說明。"""
    fa, ca = fingerprints(pa)
    fb, cb = fingerprints(pb)
    if fa is None or fb is None or ca != cb:
        print("（找不到共同的身分欄位，跳過樣本一致性檢查）", file=sys.stderr)
        return
    both = [k for k in fa if k in fb and fa[k] and fb[k]]
    if not both:
        return
    same = sum(1 for k in both if fa[k] == fb[k])
    if same == len(both):
        return
    print(f"\n⚠⚠ 這兩份檔案標的**不是同一批樣本**，不能算 kappa。\n"
          f"      以「{ca}」比對 {len(both)} 個編號，只有 {same} 個相同"
          f"（{100 * same / len(both):.0f}%）。\n"
          f"      例如：", file=sys.stderr)
    shown = 0
    for k in both:
        if fa[k] != fb[k]:
            print(f"        {k}　{pa.name} = {fa[k]}　／　{pb.name} = {fb[k]}",
                  file=sys.stderr)
            shown += 1
            if shown >= 3:
                break
    print("\n      「編號」只是列號，不是身分。兩個人各跑一次 make_review.py\n"
          "      會得到兩批不同的樣本（固定 seed 也一樣，因為來源資料會變）。\n"
          "      正確做法：**產生一次，把檔案傳給對方**，兩個人標同一個檔。\n",
          file=sys.stderr)
    raise SystemExit(2)


def kappa(a: dict[str, str], b: dict[str, str]) -> tuple[float, int, dict]:
    ids = sorted(set(a) & set(b))
    n = len(ids)
    if not n:
        return float("nan"), 0, {}
    labels = sorted({a[i] for i in ids} | {b[i] for i in ids})
    agree = sum(1 for i in ids if a[i] == b[i])
    po = agree / n
    ca, cb = Counter(a[i] for i in ids), Counter(b[i] for i in ids)
    pe = sum((ca[l] / n) * (cb[l] / n) for l in labels)
    k = (po - pe) / (1 - pe) if pe < 1 else float("nan")
    matrix = {(a[i], b[i]): 0 for i in ids}
    for i in ids:
        matrix[(a[i], b[i])] += 1
    return k, n, matrix


def read_col(path: Path, col: str) -> dict[str, str]:
    """讀任意一欄（給 --by 用）。"""
    out: dict[str, str] = {}
    with path.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            rid = (r.get(COL_ID) or "").strip()
            if rid:
                out[rid] = (r.get(col) or "").strip()
    return out


def main(argv: list[str]) -> int:
    use_utf8_stdout()
    by = None
    if "--by" in argv:
        i = argv.index("--by")
        if i + 1 >= len(argv):
            print("--by 後面要接欄位名稱，例如 --by 型態", file=sys.stderr)
            return 1
        by = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    if len(argv) != 2:
        print(__doc__.strip().split("\n")[2], file=sys.stderr)
        return 1
    pa, pb = Path(argv[0]), Path(argv[1])
    for p in (pa, pb):
        if not p.exists():
            print(f"找不到 {p}", file=sys.stderr)
            return 1
    check_same_sample(pa, pb)
    (a, ca), (b, cb) = read(pa), read(pb)
    # ⚠ 兩份檔案讀到不同的判斷欄 = 拿配對標註去跟嚴重度標註比。
    #   那會算出一個看起來很正常、但毫無意義的數字。
    if ca != cb:
        print(f"兩份檔案的判斷欄不一樣：\n  {pa.name} → {ca}\n  {pb.name} → {cb}\n"
              f"這兩份不是同一份標註任務，不能算 kappa。", file=sys.stderr)
        return 1
    k, n, matrix = kappa(a, b)
    if not n:
        print("兩份檔案沒有共同的、都填了判斷的編號。", file=sys.stderr)
        return 1

    agree = sum(v for (x, y), v in matrix.items() if x == y)
    raw_a = {k: v for k, v in
             ((r[COL_ID].strip(), (r[ca] or "").strip())
              for r in csv.DictReader(pa.open(encoding="utf-8-sig", newline="")))
             if k}
    raw_b = {k: v for k, v in
             ((r[COL_ID].strip(), (r[cb] or "").strip())
              for r in csv.DictReader(pb.open(encoding="utf-8-sig", newline="")))
             if k}
    odd = sorted({v for v in list(raw_a.values()) + list(raw_b.values())
                  if v and v not in ("是", "可能", "否", "無法判斷")})
    if odd:
        print("⚠ 有選項以外的寫法，已依 tools/kappa.py 的 NORMALIZE 規則收斂：")
        for v in odd:
            print(f"    「{v}」→「{canon(v)}」")
        print()

    print(f"標註任務：{ca}")
    print(f"共同標註 {n} 組")
    print(f"直接一致 {agree}/{n} = {100 * agree / n:.1f}%")
    print(f"\nCohen's kappa = {k:.3f}", end="  ")
    print("（幾乎沒有一致性）" if k < 0.21 else
          "（低）" if k < 0.41 else
          "（中等）" if k < 0.61 else
          "（好，可以寫進簡報）" if k < 0.81 else "（非常好）")

    labels = sorted({x for x, _ in matrix} | {y for _, y in matrix})
    print(f"\n{'':<14}" + "".join(f"{l:<12}" for l in labels) + "  ← 第二位")
    for x in labels:
        row = "".join(f"{matrix.get((x, y), 0):<12}" for y in labels)
        print(f"{x:<14}{row}")
    print("← 第一位")

    dis = sorted(((v, x, y) for (x, y), v in matrix.items() if x != y),
                 reverse=True)
    if dis:
        print("\n最常見的不一致：")
        for v, x, y in dis[:5]:
            print(f"  {v:>3} 組：一個標「{x}」，另一個標「{y}」")
        print("\n→ 這些就是規則書沒寫清楚的地方。先改規則書，再重標，不要改資料。")

    # ⚠ 整體數字低的時候，一定要按類別拆開看一次。混在一起的 kappa
    #   會把「某一類完全一致」跟「某一類完全不一致」平均掉。
    if by:
        strata = read_col(pa, by)
        if not any(strata.values()):
            print(f"\n{pa.name} 沒有「{by}」這一欄，或整欄是空的。", file=sys.stderr)
            return 1
        print(f"\n── 按「{by}」拆開 ──")
        for g in sorted({v for k, v in strata.items() if k in a and k in b}):
            ids = {k for k, v in strata.items() if v == g}
            ka, kb = {k: v for k, v in a.items() if k in ids}, \
                     {k: v for k, v in b.items() if k in ids}
            kk, nn, mm = kappa(ka, kb)
            ag = sum(v for (x, y), v in mm.items() if x == y)
            print(f"  {g:<24} n={nn:<4} 一致 {ag:>3}/{nn:<4}"
                  f"（{100 * ag / nn:5.1f}%）  kappa={kk:.3f}")
        print("\n⚠ 如果某一類 kappa 接近 1、另一類接近 0，那不是標註品質問題，"
              "\n   是**題目對那一類沒有定義**。整體的 kappa 這時候不要引用。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
