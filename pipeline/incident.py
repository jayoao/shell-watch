"""重大職業災害公開網 → data/incident.csv。

    python -m pipeline.incident

輸入：data/moldata/incident.json（crawler/moldata.py 抓的）
輸出：data/incident.csv

────────────────────────────────────────────────────────────────
為什麼這份資料重要
────────────────────────────────────────────────────────────────
**一、它有真正的發生地點。** 職安法裁處公告 74,658 筆裡只有 189 筆
（0.25%）填了發生地點，所以我們的地圖畫的是**商工登記地址**。
這份資料的「場所（肇災處）」是災害真的發生的地方。

**二、它有統一編號。** 這是整個專案第一次拿到精確的識別鍵 ——
勞動部的裁處公告只有「事業單位名稱(負責人)」，沒有統編，
所以我們一路都在用姓名比對加獨立佐證去逼近「是不是同一個人」。
這裡 85% 的列有統編，可以直接對，不用猜。

⚠ 代價是量少：500 筆、涵蓋約兩年（2024-07 起）。
  它補的是「精確」，不是「完整」。兩張圖要並存，不是取代：
      登記地址層  23,815 個事業單位   量大、位置是近似的
      肇災處層      約 300 個災害點   量小、位置是真的
  簡報上這個對比本身就是一個論點，不要把它講成「我們的地圖現在準了」。

────────────────────────────────────────────────────────────────
⚠ 比對規則
────────────────────────────────────────────────────────────────
統編優先，名稱只當備援，而且備援一律標記出來（match=name），
下游要能分辨哪一筆是精確對上的、哪一筆是靠名字猜的。
"""
from __future__ import annotations

import csv
import io
import json
import sys
from collections import Counter
from dataclasses import dataclass, asdict, fields
from pathlib import Path

from common import use_utf8_stdout
from pipeline.join import norm_name

SRC = Path("data/moldata/incident.json")
OUT = Path("data/incident.csv")


@dataclass
class Incident:
    tax_id: str          # 事業單位統一編號（可能為空）
    unit: str
    match_key: str       # norm_name(unit)，統編對不到時的備援鍵
    industry: str
    disaster: str        # 災害類型（官方分類，不是我們規則歸類的危害型態）
    casualties: int
    owner: str           # 業主（營造工程的定作人）
    owner_tax_id: str
    project: str
    site: str            # 場所（肇災處）
    address: str         # ⚠ 這是**發生地點**，不是登記地址
    agency: str
    year: str
    date: str            # YYYYMMDD
    on_map: str


def load() -> list[dict]:
    if not SRC.exists():
        print(f"⚠ 找不到 {SRC}，先跑 python -m crawler.moldata", file=sys.stderr)
        return []
    d = json.load(io.open(SRC, encoding="utf-8-sig"))
    return d if isinstance(d, list) else (d.get("data") or d.get("result") or [])


def g(r: dict, *names: str) -> str:
    """來源欄名含全形括號（「罹災人數（數量）」），而且以後可能會變。
    ⚠ 取不到就回空字串，不要 KeyError —— 政府網站改欄名不該讓整條管線掛掉。"""
    for n in names:
        v = r.get(n)
        if v not in (None, ""):
            return str(v).strip()
    return ""


def main() -> int:
    use_utf8_stdout()
    raw = load()
    if not raw:
        return 1

    out: list[Incident] = []
    for r in raw:
        unit = g(r, "事業單位")
        if not unit:
            continue
        tax = g(r, "事業單位統一編號")
        if not (len(tax) == 8 and tax.isdigit()):
            tax = ""
        try:
            cas = int(float(g(r, "罹災人數（數量）", "罹災人數") or 0))
        except ValueError:
            cas = 0
        out.append(Incident(
            tax_id=tax, unit=unit, match_key=norm_name(unit),
            industry=g(r, "行業別"), disaster=g(r, "災害類型"), casualties=cas,
            owner=g(r, "業主"), owner_tax_id=g(r, "業主統一編號"),
            project=g(r, "工程名稱"), site=g(r, "場所（肇災處）", "場所"),
            address=g(r, "地址"), agency=g(r, "勞動檢查機構"),
            year=g(r, "年度"), date=g(r, "發生日期"),
            on_map=g(r, "是否顯示於地圖"),
        ))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=[x.name for x in fields(Incident)])
        w.writeheader()
        for i in out:
            w.writerow(asdict(i))

    has_tax = sum(1 for i in out if i.tax_id)
    has_addr = sum(1 for i in out if i.address)
    ds = Counter(i.disaster for i in out if i.disaster)
    yr = Counter(i.year for i in out if i.year)
    print(f"{len(out):,} 筆 → {OUT}")
    print(f"  有統一編號　{has_tax:,}（{has_tax / len(out) * 100:.1f}%）← 精確比對用")
    print(f"  有發生地址　{has_addr:,}（{has_addr / len(out) * 100:.1f}%）"
          f"← ⚠ 是肇災處，不是登記地址")
    print(f"  罹災人數合計　{sum(i.casualties for i in out):,} 人")
    print(f"  年度　{dict(sorted(yr.items()))}")
    print("  災害類型前 6：")
    for k, v in ds.most_common(6):
        print(f"    {k:<16}{v:>4}（{v / len(out) * 100:.1f}%）")
    print("\n⚠ 只有兩年、500 筆。它補的是「位置精確」，不是「涵蓋完整」，")
    print("   跟登記地址那層是並存關係，不要說成『地圖現在準了』。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
