"""把 data/raw/ 的原始 CSV 整理成一張表，並直接回答 M0 的第一個問題。

    python -m pipeline.build

輸出：
    data/records.csv    整理過的違法紀錄（去重、已拆出負責人）
    data/unparsed.csv   拆不出來的，交人工標註（任務 T3）
    data/principals.csv 每個負責人名下有幾家公司、幾筆違法

────────────────────────────────────────────────────────────────
M0 的閘門問題：「同一個負責人名下有多家違法公司」這件事到底有多少？
────────────────────────────────────────────────────────────────
這個問題不能用設計繞過，只能量。這支程式跑完會直接印出答案：

    有 N 位負責人名下有 2 家以上的違法事業單位
    其中 M 位，這些公司的違法時間**沒有重疊**（先一家、再另一家）
      ← 這是「換殼」的訊號，M 就是本專案的立足點

⚠ 同名不等於同一人。「陳志明」在全台有 467 家公司。
   這支程式算的是**名字**，不是人。它是上界，不是答案。
   真正的判斷要靠實體解析（縣市、地址、時間、產業的獨立佐證），
   而且要人工標註量測一致率。這裡印的數字**不可以直接寫進簡報當結論**，
   只能當「值不值得繼續做」的判斷依據。
"""
from __future__ import annotations

import csv
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import use_utf8_stdout                             # noqa: E402
from crawler.constants import LAW_CODES, UNIT_CODES, law_group   # noqa: E402
from crawler.mol import read_rows                                # noqa: E402
from pipeline.dedupe import Record, is_duplicate                 # noqa: E402
from pipeline.exclude import screen                              # noqa: E402
from pipeline.parse import parse_employer                        # noqa: E402

RAW_DIR = Path("data/raw")
OUT = Path("data")

_UNIT_BY_CODE = {v: k for k, v in UNIT_CODES.items()}
_LAW_BY_CODE = {v: k for k, v in LAW_CODES.items()}

FIELDS = [
    "unit", "law", "group", "announced_date", "disposition_date", "doc_no",
    "raw_employer", "company", "principal", "kind", "note",
    "law_article", "violation", "fine", "casualties",
    "incident_date", "incident_place", "remark",
]


def _col(header: list[str], row: list[str], name: str) -> str:
    try:
        return row[header.index(name)].strip()
    except (ValueError, IndexError):
        return ""


def _money(s: str) -> int | None:
    """「20,000」→ 20000。空的或 0 都回 None ——
    很多縣市根本沒填金額（台北市職安法 16,708 筆全部是 0），
    把「沒填」當成「罰 0 元」會讓統計整個歪掉。"""
    t = (s or "").replace(",", "").strip()
    if not t or t == "0":
        return None
    try:
        return int(float(t))
    except ValueError:
        return None


def load_all() -> tuple[list[dict], list[dict]]:
    rows: list[dict] = []
    unparsed: list[dict] = []

    files = sorted(RAW_DIR.glob("*.csv"))
    if not files:
        print(f"{RAW_DIR} 裡沒有檔案。先跑 python -m crawler.mol", file=sys.stderr)
        return [], []

    for path in files:
        unit_code, _, law_code = path.stem.partition("_")
        unit = _UNIT_BY_CODE.get(unit_code, unit_code)
        law = _LAW_BY_CODE.get(law_code, law_code)
        header, data = read_rows(path.read_bytes())
        if not header:
            continue
        emp_col = next((c for c in header if "事業單位名稱" in c), None)

        for r in data:
            raw_emp = _col(header, r, emp_col) if emp_col else ""
            p = parse_employer(raw_emp)
            rec = {
                "unit": unit,
                "law": law,
                "group": law_group(law) if law in LAW_CODES else "",
                "announced_date": _col(header, r, "公告日期"),
                "disposition_date": _col(header, r, "處分日期"),
                "doc_no": _col(header, r, "處分字號"),
                "raw_employer": raw_emp,
                "company": p.company or "",
                "principal": p.principal or "",
                "kind": p.kind,
                "note": p.note,
                "law_article": _col(header, r, "違反法規條款"),
                "violation": _col(header, r, "法條敘述"),
                "fine": _money(_col(header, r, "罰鍰金額")
                               or _col(header, r, "處分金額／滯納金")),
                "casualties": _col(header, r, "職業災害之罹災人數"),
                "incident_date": _col(header, r, "職業災害之發生日期"),
                "incident_place": _col(header, r, "職業災害之發生地點"),
                "remark": _col(header, r, "備註"),
            }
            (rows if p.ok else unparsed).append(
                rec if p.ok else {**rec, "reason": p.reason})

    return rows, unparsed


def dedupe(rows: list[dict]) -> tuple[list[dict], int]:
    """同一處分被公告兩次（處分字號差一兩個字元）。不去重會高估累犯次數。"""
    buckets: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        buckets[(r["disposition_date"], r["unit"], r["raw_employer"], r["law"])].append(r)

    kept, dropped = [], 0
    for group in buckets.values():
        seen: list[dict] = []
        for r in group:
            rec = Record(r["disposition_date"], r["unit"], r["raw_employer"],
                         r["law"], r["doc_no"])
            if any(is_duplicate(rec, Record(s["disposition_date"], s["unit"],
                                            s["raw_employer"], s["law"], s["doc_no"]))
                   for s in seen):
                dropped += 1
                continue
            seen.append(r)
            kept.append(r)
    return kept, dropped


def write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def main() -> int:
    use_utf8_stdout()
    rows, unparsed = load_all()
    if not rows and not unparsed:
        return 1

    total = len(rows) + len(unparsed)
    rows, dropped = dedupe(rows)

    # 排除公部門與大企業（它們不會「換殼」，留著只會製造雜訊與誤指風險）
    kept, excluded = [], 0
    for r in rows:
        name = r["company"] or r["principal"]
        if screen(name).excluded:
            excluded += 1
            continue
        kept.append(r)
    rows = kept

    write_csv(OUT / "records.csv", rows, FIELDS)
    write_csv(OUT / "unparsed.csv", unparsed, FIELDS + ["reason"])

    # ── 負責人 → 事業單位 ──
    by_principal: dict[str, set[str]] = defaultdict(set)
    dates: dict[tuple[str, str], list[str]] = defaultdict(list)
    for r in rows:
        p, c = r["principal"], r["company"]
        if not p:
            continue
        if c:
            by_principal[p].add(c)
            dates[(p, c)].append(r["disposition_date"])

    multi = {p: cs for p, cs in by_principal.items() if len(cs) >= 2}

    # 「換殼」訊號：同一個名字底下，各家公司的違法期間**沒有重疊**
    sequential = 0
    for p, cs in multi.items():
        spans = sorted((min(dates[(p, c)]), max(dates[(p, c)])) for c in cs)
        if all(spans[i][1] < spans[i + 1][0] for i in range(len(spans) - 1)):
            sequential += 1

    write_csv(OUT / "principals.csv",
              [{"principal": p, "companies": len(cs),
                "company_list": "｜".join(sorted(cs))}
               for p, cs in sorted(multi.items(), key=lambda kv: -len(kv[1]))],
              ["principal", "companies", "company_list"])

    print(f"原始         {total:>8,} 筆")
    print(f"拆不出負責人 {len(unparsed):>8,} 筆"
          f"（{100 * len(unparsed) / total:.2f}%）→ data/unparsed.csv")
    print(f"重複公告     {dropped:>8,} 筆（已合併）")
    print(f"排除公部門等 {excluded:>8,} 筆")
    print(f"可用         {len(rows):>8,} 筆 → data/records.csv\n")

    print(f"有違法紀錄的負責人姓名   {len(by_principal):>7,} 個")
    print(f"名下有 2 家以上事業單位   {len(multi):>7,} 個"
          f"（{100 * len(multi) / max(1, len(by_principal)):.1f}%）")
    print(f"  其中各公司違法期間不重疊 {sequential:>7,} 個")
    print("\n⚠ 上面兩個數字都是**上界**，不能直接用：")
    print("   1. 這是「同名」的統計，不是「同一人」。同名不同人在台灣非常常見。")
    print("   2. 「期間不重疊」在稀疏資料下幾乎是算術必然 —— 兩家公司各只有")
    print("      一筆違法時，只要不同天就一定不重疊，那不代表任何事。")
    print("\n   要有意義的數字，跑 python -m pipeline.signal")
    print("   那支會分級、要求真的有時間間隔，並檢定這批連結是不是同名雜訊。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
