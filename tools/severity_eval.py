"""拿模型的嚴重度分級跟人工標準答案比。

    python -m tools.severity_eval data/severity_llm.csv data/severity_review_nicole.csv

────────────────────────────────────────────────────────────────
這支算的不是 kappa
────────────────────────────────────────────────────────────────
Cohen's kappa 量的是**兩個人**的獨立判斷有多一致，用途是檢查判準寫清楚了沒有。
這支量的是**模型對不對** —— 人工標註是標準答案，模型是被評的那一方。
兩個數字不能互相取代，文件裡也不能混著寫。

  · 人 vs 人   → kappa　　→ 判準夠不夠清楚　　→ tools/kappa.py
  · 模型 vs 人 → 準確率　→ 模型能不能用　　　→ 這一支

────────────────────────────────────────────────────────────────
⚠ 只看整體準確率會看走眼
────────────────────────────────────────────────────────────────
一個把每一筆都標成「中信心」的模型，整體準確率可以很漂亮，
但它把 100% 的工作都丟回給人 —— 那等於沒做。

所以一定要分開看兩個數字：

    高信心那一格的準確率　→ 可以直接採用的部分，準不準
    送人工的比例　　　　　→ 幫上了多少忙

產品上真正有意義的是「高信心且正確」佔全部的比例 ——
那是這個模組實際省下的人力。
"""
from __future__ import annotations

import csv
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout            # noqa: E402

HUMAN_COLS = ("嚴重度（輕微/中度/重大/無法判斷）", "嚴重度（輕微/中度/重大）")
LEVELS = ("輕微", "中度", "重大", "無法判斷")


def read_model(p: Path) -> tuple[dict, dict]:
    lvl, conf = {}, {}
    with p.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            i = (r.get("編號") or "").strip()
            if i and (r.get("模型分級") or "").strip():
                lvl[i] = r["模型分級"].strip()
                conf[i] = (r.get("信心") or "").strip()
    return lvl, conf


def read_human(p: Path) -> dict:
    with p.open(encoding="utf-8-sig", newline="") as f:
        rd = csv.DictReader(f)
        col = next((c for c in HUMAN_COLS if c in (rd.fieldnames or ())), None)
        if not col:
            raise SystemExit(f"{p} 裡找不到嚴重度欄位。")
        return {(r.get("編號") or "").strip(): (r.get(col) or "").strip()
                for r in rd
                if (r.get("編號") or "").strip() and (r.get(col) or "").strip()}


def table(title: str, pairs: list[tuple[str, str]]) -> None:
    """pairs = [(人工, 模型), ...]"""
    n = len(pairs)
    if not n:
        print(f"\n{title}：沒有可比對的資料")
        return
    ok = sum(1 for h, m in pairs if h == m)
    print(f"\n{title}　{ok}/{n} = {100 * ok / n:.1f}%")
    m = Counter(pairs)
    print(f"  {'人工↓／模型→':<14}" + "".join(f"{x:>9}" for x in LEVELS))
    for h in LEVELS:
        if not any(k[0] == h for k in m):
            continue
        print(f"  {h:<16}" + "".join(f"{m.get((h, x), 0):>9}" for x in LEVELS))


def main(argv: list[str]) -> int:
    use_utf8_stdout()
    if len(argv) != 2:
        print("用法：python -m tools.severity_eval 模型檔.csv 人工標註檔.csv",
              file=sys.stderr)
        return 1
    pm, ph = Path(argv[0]), Path(argv[1])
    for p in (pm, ph):
        if not p.exists():
            print(f"找不到 {p}", file=sys.stderr)
            return 1

    mlvl, mconf = read_model(pm)
    human = read_human(ph)
    ids = sorted(set(mlvl) & set(human))
    if not ids:
        print("兩份檔案沒有共同的編號。模型檔是不是跑在別份樣本上？",
              file=sys.stderr)
        return 1

    print(f"共同 {len(ids)} 筆")
    table("整體一致率", [(human[i], mlvl[i]) for i in ids])

    hi = [i for i in ids if mconf.get(i) == "高"]
    lo = [i for i in ids if mconf.get(i) in ("中", "低")]
    table("【高信心】—— 可以直接採用的那一批", [(human[i], mlvl[i]) for i in hi])
    table("【中／低信心】—— 會送人工複核的那一批", [(human[i], mlvl[i]) for i in lo])

    hi_ok = sum(1 for i in hi if human[i] == mlvl[i])
    n = len(ids)
    print("\n" + "═" * 58)
    print(f"  可直接採用　　{len(hi):>4} / {n}　{100 * len(hi) / n:>5.1f}%")
    print(f"  其中正確　　　{hi_ok:>4} / {len(hi) if hi else 0}"
          f"　{100 * hi_ok / len(hi) if hi else 0:>5.1f}%")
    print(f"  送人工複核　　{len(lo):>4} / {n}　{100 * len(lo) / n:>5.1f}%")
    print(f"\n  實際省下的人力＝高信心且正確 ＝ {hi_ok}/{n} = {100 * hi_ok / n:.1f}%")
    print("═" * 58)

    dis = Counter((human[i], mlvl[i]) for i in ids if human[i] != mlvl[i])
    if dis:
        print("\n最常見的不一致（人工 → 模型）：")
        for (h, m), v in dis.most_common(5):
            print(f"  {v:>3} 筆：人工「{h}」，模型「{m}」")
        print("""
→ 這些要一筆一筆看。可能是模型錯，也可能是判準沒寫清楚，
   還可能是人工標錯 —— **不要預設人工一定對**。
   判準要改的話，人跟模型兩邊要同步改（RUBRIC 與判準 PDF 是同一份）。""")

    print("""
⚠ 這個數字是「模型 vs 人工標準答案」的準確率，**不是 Cohen's kappa**。
   kappa 量的是兩個人的獨立判斷，用途是檢查判準夠不夠清楚。
   文件裡兩個數字要分開寫，不能互相取代。""")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
