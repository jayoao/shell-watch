"""去重 —— 同一筆處分會出現兩次。

實測發現（2026-09-02）：

    勞動關1字第1130146624A號  ┐ 同日期、同單位、同對象、同法條
    勞動關1字第1130146624 號  ┘ 處分字號只差一個「A」

不去重的話「累犯次數」會被系統性高估，而累犯次數是這個專題的核心指標。
"""
from __future__ import annotations

from dataclasses import dataclass


def levenshtein(a: str, b: str) -> int:
    """兩個字串的編輯距離。處分字號通常只差一兩個字元。"""
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


@dataclass(frozen=True)
class Record:
    disposition_date: str
    unit: str
    employer: str
    law: str
    doc_no: str


def is_duplicate(a: Record, b: Record, max_doc_distance: int = 2) -> bool:
    """五個條件全部成立才算重複。

    刻意設得嚴格：寧可留下重複，也不要把兩件真的不同的處分合併掉。
    合併錯了會低估累犯次數，那個方向的錯誤比較難被發現。
    """
    return (
        a.disposition_date == b.disposition_date
        and a.unit == b.unit
        and a.employer == b.employer
        and a.law == b.law
        and levenshtein(a.doc_no, b.doc_no) <= max_doc_distance
    )


def dedupe(records: list[Record], max_doc_distance: int = 2) -> tuple[list[Record], list[tuple[Record, Record]]]:
    """回傳 (去重後的清單, 被判為重複的配對)。

    配對要留著 —— 決賽問「你們怎麼確定沒有重複計算」時，這就是答案。
    """
    kept: list[Record] = []
    dupes: list[tuple[Record, Record]] = []
    # 先用可雜湊的四個欄位分桶，桶內才做編輯距離比對，不然是 O(n²)
    buckets: dict[tuple[str, str, str, str], list[Record]] = {}
    for r in records:
        key = (r.disposition_date, r.unit, r.employer, r.law)
        bucket = buckets.setdefault(key, [])
        hit = next((k for k in bucket if is_duplicate(k, r, max_doc_distance)), None)
        if hit:
            dupes.append((hit, r))
        else:
            bucket.append(r)
            kept.append(r)
    return kept, dupes


if __name__ == "__main__":
    rows = [
        Record("114/01/07", "勞動部", "國立臺灣大學醫學院附設醫院", "工會法第35條第1項第5款", "勞動關1字第1130146624A號"),
        Record("114/01/07", "勞動部", "國立臺灣大學醫學院附設醫院", "工會法第35條第1項第5款", "勞動關1字第1130146624號"),
        Record("114/01/08", "新北市", "揚智國際有限公司", "性別平等工作法第13條第2項", "新北府勞業字第1132134386號"),
    ]
    kept, dupes = dedupe(rows)
    print(f"原始 {len(rows)} 筆 → 去重後 {len(kept)} 筆，判為重複 {len(dupes)} 組")
    for a, b in dupes:
        print(f"  · {a.doc_no}  ≡  {b.doc_no}")
