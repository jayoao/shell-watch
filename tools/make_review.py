"""產生人工標註用的檔案。

    python -m tools.make_review

產出：
    data/link_review.csv    100 組配對，判斷「是不是同一人」（任務 T6）
    data/parse_review.csv   200 筆雇主欄位，檢查拆解對不對（任務 T3）

────────────────────────────────────────────────────────────────
兩件事一定要做對，不然標了也沒用
────────────────────────────────────────────────────────────────

1. **不要把系統的判斷給標註者看。**
   分數、分級、`why` 欄位一律不放進去。看到「分數 12.3、A 級」，
   標註者會傾向同意機器，一致率就會虛高 —— 那個數字沒有意義。
   只給原始證據，讓人自己判斷。

2. **兩個人要各自獨立標同一份，中間不能討論。**
   Cohen's kappa 量的是兩個獨立判斷的一致程度。
   討論過再標，等於量同一個判斷兩次。

⚠ 這兩個檔案**含真實公司名與真實人名**。
   `.gitignore` 已經擋掉 `*_review.csv`，但也不要貼到雲端硬碟、
   聊天群組或任何公開的地方。標完就留在本機。

────────────────────────────────────────────────────────────────
抽樣方式
────────────────────────────────────────────────────────────────
分層抽樣，不是抽最像的 100 組。理由：如果只抽證據最強的，
兩個人都會答「是」，kappa 會因為缺乏變異而失真（甚至算不出來）。
要有難有易，分布才有意義。
"""
from __future__ import annotations

import argparse
import csv
import random
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                    # noqa: E402
from pipeline.parse import parse_employer             # noqa: E402

JOINED = Path("data/joined.csv")
RANKED = Path("data/ranked.csv")
SHELLS = Path("data/shell_candidates.csv")
RECORDS = Path("data/records.csv")
UNPARSED = Path("data/unparsed.csv")
OUT_LINK = Path("data/link_review.csv")
OUT_PARSE = Path("data/parse_review.csv")

SEED = 20260903
N_LINK = 100
N_PARSE = 200


def strata(r: dict) -> str:
    """依**兩層排序的身分層**分層，不是舊的單一分數。

    ⚠ 這裡改過一次，而且是 rank.py 自己的輸出提醒的：
      舊版是從 joined.csv 抽、用「同地址／先前皆停業／分數」自己分層。
      但最終產品的排序是 rank.py 的兩層結果，母體不一樣 ——
      標註驗證的東西跟使用者看到的東西對不上，那個 kappa 就沒有意義。

    同地址升層的那一批單獨成一層：它們是靠獨立佐證進 A 的，
    跟「姓名罕見＋同縣市」進 A 的性質不同，混在一起看不出差別。
    """
    tier = (r.get("identity_tier") or "")[:1]
    if tier == "A":
        return "A·同地址" if r.get("tier_upgraded_by_address") == "1" else "A·罕見＋同縣市"
    return {"B": "B·姓名罕見", "C": "C·同縣市"}.get(tier, "D·兩者都沒有")


# 每一層要抽幾組。刻意保留「兩者都沒有」那一層 ——
# 沒有反例的話，兩個人都會答「是」，kappa 會因為缺乏變異而算不出來。
QUOTA = {
    "A·同地址": 25,
    "A·罕見＋同縣市": 15,
    "B·姓名罕見": 20,
    "C·同縣市": 15,
    "D·兩者都沒有": 25,
}
assert sum(QUOTA.values()) == N_LINK, "T6 是 100 組（工作說明書）"


def flat(v: str) -> str:
    """把換行壓成「／」。

    ⚠ 含換行的儲存格用 Excel 開了再存會整格跑掉 —— 實測隊友回傳的
      severity 檔就有三列因此錯位，標籤對到別筆的內容。
      標註檔寧可難看一點，也不要讓資料在傳遞過程中悄悄變形。
    """
    return re.sub(r"\s*\n\s*", "／", (v or "").strip())


def make_link() -> int:
    if not RANKED.exists():
        print(f"找不到 {RANKED}，先跑 python -m pipeline.rank", file=sys.stderr)
        return 0
    with RANKED.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    # 各公司的裁處摘要，給標註者看的原始證據
    detail: dict[str, dict] = defaultdict(
        lambda: {"units": set(), "first": "", "last": "", "n": 0, "laws": set()})
    if RECORDS.exists():
        with RECORDS.open(encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                c = r.get("company", "").strip()
                if not c:
                    continue
                d = detail[c]
                d["units"].add(r["unit"])
                d["laws"].add(r["law"])
                d["n"] += 1
                dd = r.get("disposition_date", "")
                if dd:
                    d["first"] = min(d["first"] or dd, dd)
                    d["last"] = max(d["last"], dd)

    buckets: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        buckets[strata(r)].append(r)

    rng = random.Random(SEED)
    picked: list[tuple[str, dict]] = []
    for name, quota in QUOTA.items():
        pool = buckets.get(name, [])
        rng.shuffle(pool)
        take = pool[:quota]
        picked += [(name, r) for r in take]
        if len(take) < quota:
            print(f"  ⚠ 「{name}」只有 {len(take)} 組，不足 {quota}")

    rng.shuffle(picked)          # 打散，不要讓同一層排在一起

    fields = ["編號", "負責人姓名", "事業單位", "裁處單位", "違法期間", "裁處筆數",
              "商工登記現況", "設立年", "登記地址",
              "判斷（是/可能/否/無法判斷）", "理由"]
    OUT_LINK.parent.mkdir(parents=True, exist_ok=True)
    with OUT_LINK.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(fields)
        for i, (layer, r) in enumerate(picked, 1):
            names = r["company_list"].split(" → ")
            addrs = (r.get("addresses") or "").split(" ｜ ")
            sts = (r.get("statuses") or "").split("／")
            for j, cname in enumerate(names):
                d = detail.get(cname, {})
                w.writerow([
                    f"L{i:03d}" if j == 0 else "",
                    r["principal"] if j == 0 else "",
                    cname,
                    "／".join(sorted(d.get("units", []))) or "",
                    f"{d.get('first','')}~{d.get('last','')}" if d.get("first") else "",
                    d.get("n", ""),
                    sts[j] if j < len(sts) else "",
                    r.get("min_established", "") if j == 0 else "",
                    addrs[j] if j < len(addrs) else "",
                    "", "",
                ])
            w.writerow([""] * len(fields))     # 每組之間空一列，好讀
    # ⚠ 分層標籤只寫給我們自己看，不寫進標註檔 —— 那會洩漏系統的判斷
    key = OUT_LINK.with_name("link_review_key.csv")
    with key.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["編號", "分層", "系統分數", "同地址", "先前皆停業"])
        for i, (layer, r) in enumerate(picked, 1):
            w.writerow([f"L{i:03d}", layer, r.get("score", ""),
                        r.get("same_address", ""), r.get("all_earlier_closed", "")])
    print(f"  {OUT_LINK}　{len(picked)} 組")
    print(f"  {key}　← 分層答案卡，**標註前不要看**")
    return len(picked)


def make_parse() -> int:
    """雇主欄位解析的抽查。拆得開的抽 150，拆不開的全放（最多 50）。"""
    rows: list[tuple[str, str, str, str]] = []
    if RECORDS.exists():
        with RECORDS.open(encoding="utf-8-sig", newline="") as f:
            seen = set()
            for r in csv.DictReader(f):
                raw = r.get("raw_employer", "")
                if raw and raw not in seen:
                    seen.add(raw)
                    rows.append((raw, r.get("company", ""),
                                 r.get("principal", ""), r.get("kind", "")))
    rng = random.Random(SEED)
    rng.shuffle(rows)
    sample = rows[:N_PARSE - 50]

    bad: list[tuple[str, str, str, str]] = []
    if UNPARSED.exists():
        with UNPARSED.open(encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f):
                bad.append((r.get("raw_employer", ""), "", "", "拆不開"))
    rng.shuffle(bad)
    sample += bad[:50]
    rng.shuffle(sample)

    with OUT_PARSE.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["編號", "原始欄位", "系統拆出的事業單位", "系統拆出的負責人",
                    "型態", "拆得對嗎（對/錯）", "正確答案（拆錯才填）"])
        for i, (raw, co, pr, kind) in enumerate(sample, 1):
            w.writerow([f"P{i:03d}", raw, co, pr, kind, "", ""])
    print(f"  {OUT_PARSE}　{len(sample)} 筆")
    return len(sample)


def main(argv=None) -> int:
    use_utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["link", "parse"],
                    help="只產生其中一份（另一份已經有人在標的時候用）")
    ap.add_argument("--force", action="store_true",
                    help="覆蓋已存在的標註檔（⚠ 已標好的內容會全部作廢）")
    a = ap.parse_args(argv)

    # ⚠ 這個守門是踩出來的：`make_review` 原本一次重產兩個檔案。
    #   隊友的 T3（parse_review）標完之後再跑一次，她的 200 筆就沒了。
    #   標註是人花幾小時換來的，重產前一定要先問。
    for want, path in (("link", OUT_LINK), ("parse", OUT_PARSE)):
        if a.only and a.only != want:
            continue
        if path.exists() and not a.force:
            print(f"{path} 已經存在。重新產生會讓已經標好的東西全部作廢。\n"
                  f"確定要重來的話加 --force；只想重產另一份就用 --only。",
                  file=sys.stderr)
            return 1

    print("產生標註檔：")
    n1 = make_link() if a.only != "parse" else 0
    n2 = make_parse() if a.only != "link" else 0
    print(f"\n完成。配對 {n1} 組、解析 {n2} 筆。")
    print("\n⚠ 這兩個檔案含真實公司名與真實人名。")
    print("   不要進 git（.gitignore 已擋）、不要貼到雲端硬碟或聊天群組。")
    print("\n⚠ 兩個人要**各自獨立**標同一份，中間不要討論 ——")
    print("   討論過再標，kappa 就只是量同一個判斷兩次。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
