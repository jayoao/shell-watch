"""把標註檔裡重複的描述收成一組，標完再展開回去。

    python -m tools.label_helper --collapse data/severity_review.csv
    （標 data/severity_review_grouped.csv）
    python -m tools.label_helper --expand   data/severity_review.csv

────────────────────────────────────────────────────────────────
為什麼可以這樣做
────────────────────────────────────────────────────────────────
一模一樣的描述本來就該得到一樣的判斷。150 筆裡有 13 句是重複的
（「雇主未按時繳納勞工退休金致加徵滯納金」出現 17 次），
一句一句重讀只是在浪費時間，而且**同一句標成不同等級才是錯的**。

實測 150 筆 → 105 組，省下 45 次判斷。

⚠ 這不是抄捷徑，是避免自相矛盾。隊友回傳的第一版就有
   同一句「未符合規定之必要安全衛生設備及措施」標成兩種等級的情形。

────────────────────────────────────────────────────────────────
⚠ 排序會讓你更快，但也更容易恍神
────────────────────────────────────────────────────────────────
收攏後的檔案依「法規 → 出現次數」排序，同一部法規的排在一起，
判斷的腦子不用一直切換。但那也表示連續好幾筆長得很像 ——
**還是要真的讀過每一句**，不要看到「勞工退休金」就自動填上一格。

一句標錯會連帶影響好幾筆（那 17 筆是同一個判斷）。
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                    # noqa: E402

LABEL_COLS = ("嚴重度（輕微/中度/重大/無法判斷）",
              "判斷（是/可能/否/無法判斷）",
              "拆得對嗎（對/錯）")
TEXT_COLS = ("違反內容", "原始欄位")


def norm(v: str) -> str:
    """比對用：把空白與標點拿掉，只看文字本身。"""
    return re.sub(r"[\s　／;；,，。．、]+", "", v or "")


def pick(names, cols) -> str:
    for c in cols:
        if c in (names or ()):
            return c
    raise SystemExit(f"這個檔案沒有認得出來的欄位。需要其中之一：{cols}")


def grouped_path(src: Path) -> Path:
    return src.with_name(src.stem + "_grouped.csv")


def collapse(src: Path, force: bool) -> int:
    with src.open(encoding="utf-8-sig", newline="") as f:
        rd = csv.DictReader(f)
        rows = list(rd)
        names = rd.fieldnames or []
    lab = pick(names, LABEL_COLS)
    txt = pick(names, TEXT_COLS)
    law = "違反法規" if "違反法規" in names else None

    out = grouped_path(src)
    if out.exists() and not force:
        print(f"{out} 已經存在。覆蓋會讓已經標好的東西作廢，確定的話加 --force",
              file=sys.stderr)
        return 1

    groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        groups[norm(r[txt])].append(r)

    items = []
    for k, rs in groups.items():
        items.append({
            "代表編號": rs[0]["編號"],
            "出現次數": len(rs),
            "涵蓋編號": " ".join(r["編號"] for r in rs),
            **{c: rs[0].get(c, "") for c in names if c not in ("編號",)},
        })
    # 同一部法規排在一起，判斷的腦子不用一直切換；次數多的排前面，先解決高價值的。
    items.sort(key=lambda x: ((x.get(law) or "") if law else "",
                              -x["出現次數"], len(x.get(txt) or "")))

    cols = ["代表編號", "出現次數", "涵蓋編號"] + [c for c in names if c != "編號"]
    with out.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(items)

    dup = sum(1 for x in items if x["出現次數"] > 1)
    print(f"{len(rows)} 筆 → {len(items)} 組　→ {out}")
    print(f"  其中 {dup} 組是重複的，涵蓋 "
          f"{sum(x['出現次數'] for x in items if x['出現次數'] > 1)} 筆")
    print(f"  ⇒ 只要判斷 {len(items)} 次，省下 {len(rows) - len(items)} 次\n")
    print(f"標「{lab}」和「理由」兩欄，標完跑：")
    print(f"  python -m tools.label_helper --expand {src.as_posix()}")
    print("""
⚠ 排序把同一部法規排在一起，會快很多，但也更容易恍神。
   **還是要真的讀過每一句** —— 一句標錯會連帶影響好幾筆。""")
    return 0


def expand(src: Path, force: bool) -> int:
    out = grouped_path(src)
    if not out.exists():
        print(f"找不到 {out}，要先跑 --collapse", file=sys.stderr)
        return 1
    with out.open(encoding="utf-8-sig", newline="") as f:
        rd = csv.DictReader(f)
        items = list(rd)
        gnames = rd.fieldnames or []
    lab = pick(gnames, LABEL_COLS)

    missing = [x["代表編號"] for x in items if not (x.get(lab) or "").strip()]
    if missing:
        print(f"還有 {len(missing)} 組沒標：{' '.join(missing[:10])}"
              f"{' …' if len(missing) > 10 else ''}", file=sys.stderr)
        print("全部標完再展開，免得寫回去的是半成品。", file=sys.stderr)
        return 1

    by_id = {}
    for x in items:
        for i in (x.get("涵蓋編號") or "").split():
            by_id[i] = x

    with src.open(encoding="utf-8-sig", newline="") as f:
        rd = csv.DictReader(f)
        rows = list(rd)
        names = rd.fieldnames or []

    already = sum(1 for r in rows if (r.get(lab) or "").strip())
    if already and not force:
        print(f"{src} 已經有 {already} 筆填過了。覆蓋的話加 --force", file=sys.stderr)
        return 1

    n = 0
    for r in rows:
        x = by_id.get(r["編號"])
        if x:
            r[lab] = x.get(lab, "")
            if "理由" in names:
                r["理由"] = x.get("理由", "")
            n += 1
    with src.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=names)
        w.writeheader()
        w.writerows(rows)

    from collections import Counter
    c = Counter(r[lab] for r in rows if (r.get(lab) or "").strip())
    print(f"{n} 筆寫回 {src}")
    print("  " + "　".join(f"{k} {v}" for k, v in c.most_common()))
    if len(c) < 2:
        print("\n⚠ 只有一個等級。驗收標準是三個等級都要出現 ——"
              "全部標成同一級代表判準要重新討論。")
    print(f"\n接下來：python -m tools.kappa {src.as_posix()} "
          f"data/severity_review_nicole.csv")
    return 0


def main(argv=None) -> int:
    use_utf8_stdout()
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--collapse", action="store_true", help="把重複的收成一組")
    g.add_argument("--expand", action="store_true", help="標完之後展開回原檔")
    ap.add_argument("src", type=Path)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    if not a.src.exists():
        print(f"找不到 {a.src}", file=sys.stderr)
        return 1
    return collapse(a.src, a.force) if a.collapse else expand(a.src, a.force)


if __name__ == "__main__":
    raise SystemExit(main())
