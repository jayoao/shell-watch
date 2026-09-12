"""算兩個人的標註一致率（Cohen's kappa）。

    python -m tools.kappa data/link_review_我.csv data/link_review_她.csv

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
"""
from __future__ import annotations

import csv
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout            # noqa: E402

COL_ID = "編號"

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


def read(path: Path) -> tuple[dict[str, str], str]:
    out: dict[str, str] = {}
    with path.open(encoding="utf-8-sig", newline="") as f:
        rd = csv.DictReader(f)
        col = label_col(rd.fieldnames)
        for r in rd:
            rid = (r.get(COL_ID) or "").strip()
            lab = (r.get(col) or "").strip()
            if rid and lab:
                out[rid] = lab
    return out, col


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


def main(argv: list[str]) -> int:
    use_utf8_stdout()
    if len(argv) != 2:
        print(__doc__.strip().split("\n")[2], file=sys.stderr)
        return 1
    pa, pb = Path(argv[0]), Path(argv[1])
    for p in (pa, pb):
        if not p.exists():
            print(f"找不到 {p}", file=sys.stderr)
            return 1
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
