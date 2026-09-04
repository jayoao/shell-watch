"""產生「違法情節嚴重度」的人工標註檔（任務 T7）。

    python -m tools.make_severity_review

產出：
    data/severity_review.csv      100 筆，只有違規描述，給人判斷嚴重度
    data/severity_review_key.csv  對照用（罰鍰、處分字號、系統目前的判斷）

────────────────────────────────────────────────────────────────
順序要反過來：先有人的答案，再量機器
────────────────────────────────────────────────────────────────
原本的計畫是「LLM 分級 → 人工驗證」。但那個順序有問題：
先看過機器的答案再標，人會傾向同意機器，一致率就虛高。

所以改成 **先建標準答案，再拿機器去比**。這樣做多了兩個好處：

  1. 現在就能量 `pipeline/export.py` 的 `severity_of()` 準不準
     —— 那是純規則（罰鍰級距），不需要等 LLM 建好。
  2. LLM 建好之後，用同一份標準答案量，
     兩個方法可以**直接比較**，而不是各說各話。

────────────────────────────────────────────────────────────────
⚠ 標註者不能看到罰鍰金額
────────────────────────────────────────────────────────────────
這是整支程式最重要的一行設計。

系統目前的嚴重度**就是從罰鍰級距推出來的**（≥30 萬重大、≥5 萬中度）。
如果把罰鍰給標註者看，他們會照著金額標，
那量出來的不是「系統判得準不準」，是「人會不會套用我們自己的門檻」。
那不是驗證，是同義反覆。

所以標註檔只給：法規、法條、違反內容。**罰鍰、處分字號、公司名都不給。**

副作用是好的：這個檔案裡**完全沒有公司名與人名**，
比另外兩個標註檔安全得多。但還是不要進 git（`.gitignore` 已擋 `*_review.csv`）。

────────────────────────────────────────────────────────────────
分層抽樣
────────────────────────────────────────────────────────────────
不能只抽罰得重的。人工標註要有難有易、輕重都有，
否則兩個人都答「重大」，kappa 會因為缺乏變異而算不出來
（這個坑在 `tools/make_review.py` 已經踩過一次，QUOTA 就是為此保留的）。
"""
from __future__ import annotations

import csv
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                     # noqa: E402
from pipeline.hazard import classify, is_fatal         # noqa: E402

RECORDS = Path("data/records.csv")
OUT = Path("data/severity_review.csv")
OUT_KEY = Path("data/severity_review_key.csv")

SEED = 20260904
N = 100

# 分層 → 要抽幾筆。刻意讓輕重都有，也刻意保留「沒有罰鍰金額」那一層 ——
# 那一層佔全部的 78.6%，是系統最沒把握的地方，最需要人的判斷。
QUOTA = {
    "職安·死亡災害": 15,
    "職安·高額罰鍰": 12,
    "職安·無金額": 25,
    "職安·一般": 18,
    "其他法規·有金額": 15,
    "其他法規·無金額": 15,
}


def layer(r: dict) -> str:
    osha = "職業安全衛生" in (r.get("law") or "")
    try:
        fine = int(r.get("fine") or 0)
    except ValueError:
        fine = 0
    if osha:
        if is_fatal(r.get("violation", "")):
            return "職安·死亡災害"
        if fine >= 300_000:
            return "職安·高額罰鍰"
        return "職安·無金額" if fine == 0 else "職安·一般"
    return "其他法規·無金額" if fine == 0 else "其他法規·有金額"


def rule_severity(fine: int, violation: str) -> str:
    """系統目前的判斷。⚠ 這一份寫進 key 檔，標註檔裡絕對不能出現。"""
    if fine:
        if fine >= 300_000:
            return "重大"
        if fine >= 50_000:
            return "中度"
        return "輕微"
    if any(k in violation for k in ("死亡", "罹災", "墜落", "感電", "捲夾")):
        return "重大"
    return "輕微"


def main() -> int:
    use_utf8_stdout()
    if not RECORDS.exists():
        print(f"找不到 {RECORDS}", file=sys.stderr)
        return 1
    if OUT.exists():
        print(f"{OUT} 已經存在。重新產生會讓已經標好的東西全部作廢。\n"
              f"確定要重來的話，先手動把舊檔改名或刪掉。", file=sys.stderr)
        return 1

    buckets: dict[str, list[dict]] = defaultdict(list)
    with RECORDS.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            v = (r.get("violation") or "").strip()
            # 太短的描述（「未依規定辦理」）沒有東西可以判斷，排除
            if len(v) < 12:
                continue
            buckets[layer(r)].append(r)

    rng = random.Random(SEED)
    picked: list[dict] = []
    for name, quota in QUOTA.items():
        pool = buckets.get(name, [])
        if len(pool) < quota:
            print(f"⚠ 分層「{name}」只有 {len(pool)} 筆，少於配額 {quota}",
                  file=sys.stderr)
        rng.shuffle(pool)
        for r in pool[:quota]:
            r["_layer"] = name
            picked.append(r)
    rng.shuffle(picked)          # 打散，不要讓同一層連在一起影響判斷

    # ── 標註檔：只有描述，沒有金額、沒有公司名、沒有系統判斷 ──
    with OUT.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["編號", "違反法規", "法規法條", "違反內容",
                    "嚴重度（輕微/中度/重大）", "理由"])
        for i, r in enumerate(picked, 1):
            w.writerow([f"S{i:03d}", r.get("law", ""),
                        r.get("law_article", ""),
                        (r.get("violation") or "").strip(), "", ""])

    # ── 對照檔：⚠ 標註完成前不要打開 ──
    with OUT_KEY.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["編號", "分層", "罰鍰", "處分字號",
                    "系統判斷", "危害型態", "涉及死亡災害"])
        for i, r in enumerate(picked, 1):
            try:
                fine = int(r.get("fine") or 0)
            except ValueError:
                fine = 0
            v = (r.get("violation") or "").strip()
            w.writerow([f"S{i:03d}", r["_layer"], fine, r.get("doc_no", ""),
                        rule_severity(fine, v),
                        "、".join(classify(v)) if "職業安全衛生" in (r.get("law") or "") else "",
                        "是" if is_fatal(v) else ""])

    print(f"{len(picked)} 筆 → {OUT}")
    for k, n in Counter(r["_layer"] for r in picked).most_common():
        print(f"  {k:<16}{n:>4}")
    print(f"\n對照檔 → {OUT_KEY}")
    print("""
⚠ 兩件事一定要做對，不然標了也沒用：

  1. **不要打開 severity_review_key.csv。** 裡面有罰鍰金額與系統的判斷。
     系統的嚴重度就是從罰鍰級距推出來的 —— 看過金額再標，
     量到的是「人會不會套用我們自己的門檻」，不是「系統準不準」。

  2. **兩個人各自獨立標同一份，中間不要討論。**
     Cohen's kappa 量的是兩個獨立判斷的一致程度。

標完之後跑 `python -m tools.kappa`（要先加上 severity 模式）。""")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
