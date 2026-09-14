"""抓勞動部在 data.gov.tw 上的補充開放資料集。

    python -m crawler.moldata           # 全部抓
    python -m crawler.moldata --only toshms
    python -m crawler.moldata --list    # 只列出要抓什麼，不連網

⚠ 這支要連 apiservice.mol.gov.tw 與 pacs.osha.gov.tw。
  **本機的 Linux VM 與雲端容器都連不到政府網域，只能在 Windows 的 venv 跑。**

────────────────────────────────────────────────────────────────
為什麼要抓這些
────────────────────────────────────────────────────────────────
LaborOD 組的開發方向寫的是「企業**職安履歷**（得獎、驗證、違規與職災紀錄）」
—— 四樣。我們原本只做了「違規」一樣。

而且評分辦法寫明「使用『勞動部及其所屬機關開放資料』的數量與程度」
初賽佔 20%、決賽佔 30%，並且「使用越多者，評審委員將酌予加分」。

⚠ 經濟部商工登記**不算**（那是經濟部，不是勞動部），它是方法論的一部分
  但不能算進資料使用度。

────────────────────────────────────────────────────────────────
⚠⚠ 得獎與驗證是「正面認定」，比違規更不能配錯
────────────────────────────────────────────────────────────────
把 A 公司的違規顯示成 B 公司的，是名譽損害。
把 A 公司的 TOSHMS 驗證顯示成 B 公司的，是**幫一家沒通過驗證的公司背書**
—— 求職者可能因此去了一個不安全的職場。方向相反，嚴重度一樣。

所以這批資料的比對規則要**比違規更嚴**：
    有統一編號的 → 只用統編對，不用名稱
    沒有統編的   → 只接受正規化後完全相同的名稱，不做模糊比對
對不上就不顯示。寧可漏掉一家有驗證的公司，也不要給錯的公司掛上證書。
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import requests

from common import use_utf8_stdout

OUT = Path("data/moldata")
BASE = "https://apiservice.mol.gov.tw/OdService/download/"

USER_AGENT = ("shell-watch/0.1 (student research project; "
              "InnoServe 2026 contest)")


@dataclass(frozen=True)
class Source:
    key: str
    name: str
    dataset: str          # data.gov.tw 的資料集編號，文件要引用這個
    urls: tuple[str, ...]
    note: str = ""

    @property
    def page(self) -> str:
        return f"https://data.gov.tw/dataset/{self.dataset}"


# ⚠ 這些網址是 2026-09-14 從 data.gov.tw 的 API
#   （https://data.gov.tw/api/v2/rest/dataset/{id}）讀出來的。
#   政府平台換過網址就會 404，所以失敗時要回去重查，不要硬改這裡的字串。
SOURCES = (
    Source("incident", "重大職業災害公開網", "126835",
           ("https://pacs.osha.gov.tw/api/v1/getdangerocupation",),
           "另有 data.gov.tw 的逐年 CSV，欄位可能與 API 不同"),
    Source("toshms", "通過臺灣職業安全衛生管理系統(TOSHMS)驗證之事業單位名單", "6340",
           (BASE + "A17000000J-020056-sLA",)),
    Source("perf", "通過職業安全衛生管理系統績效審查且於有效期間之事業單位清單", "46106",
           (BASE + "A17000000J-030133-CGl",),
           "這個資料集有十幾個逐年資源，先抓第一個看欄位"),
    Source("star5", "職業安全衛生獎項推行職業安全衛生優良單位五星獎", "41460",
           (BASE + "A17000000J-030003-Cpt",)),
    Source("national", "職業安全衛生獎項國家職業安全衛生獎", "41459",
           (BASE + "A17000000J-030002-22X",)),
)


def fetch(url: str, tries: int = 3) -> bytes:
    """⚠ 政府網站會在 HTTP 200 的情況下回 HTML 錯誤頁（爬蟲那邊實測過）。
    所以一定要驗內容，不能只看狀態碼。"""
    last = ""
    for i in range(1, tries + 1):
        try:
            r = requests.get(url, timeout=180,
                             headers={"User-Agent": USER_AGENT})
            body = r.content
            head = body[:200].decode("utf-8", "replace").lstrip("﻿").lstrip()
            if r.status_code == 200 and body and not head.lower().startswith(
                    ("<!doctype", "<html")):
                return body
            last = f"HTTP {r.status_code}，開頭是 {head[:60]!r}"
        except requests.RequestException as e:
            last = f"{e.__class__.__name__}: {e}"
        if i < tries:
            print(f"      重試 {i}/{tries - 1}（{last}）", file=sys.stderr)
            time.sleep(3 * i)
    raise RuntimeError(last)


def describe(body: bytes, path: Path) -> None:
    """把抓到的東西印成人看得懂的樣子：欄位、筆數、第一筆。"""
    text = body.decode("utf-8-sig", "replace")
    stripped = text.lstrip()
    if stripped.startswith(("[", "{")):
        data = json.loads(text)
        rows = data if isinstance(data, list) else (
            data.get("data") or data.get("result") or [])
        print(f"      JSON　{len(rows):,} 筆")
        if rows:
            print(f"      欄位　{list(rows[0].keys())}")
            print(f"      首筆　{json.dumps(rows[0], ensure_ascii=False)[:260]}")
        return
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        print("      （空檔）")
        return
    # ⚠ 有些勞動部的 CSV 第一列是標題文字不是欄位名（爬蟲那邊踩過）。
    #   所以前三列都印出來，讓人自己看哪一列才是表頭。
    print(f"      CSV　{len(rows) - 1:,} 筆（扣掉第一列）")
    for i, r in enumerate(rows[:3]):
        print(f"      第 {i} 列　{r}")


def main(argv: list[str] | None = None) -> int:
    use_utf8_stdout()
    p = argparse.ArgumentParser(description="抓勞動部補充開放資料集")
    p.add_argument("--only", action="append", choices=[s.key for s in SOURCES])
    p.add_argument("--list", action="store_true", help="只列出，不連網")
    a = p.parse_args(argv)

    todo = [s for s in SOURCES if not a.only or s.key in a.only]

    if a.list:
        for s in todo:
            print(f"{s.key:10} {s.name}")
            print(f"           {s.page}")
        return 0

    OUT.mkdir(parents=True, exist_ok=True)
    ok = 0
    for s in todo:
        print(f"\n── {s.key}　{s.name}")
        print(f"   {s.page}")
        for i, url in enumerate(s.urls):
            try:
                body = fetch(url)
            except RuntimeError as e:
                print(f"   ✗ 抓不到：{e}", file=sys.stderr)
                continue
            ext = "json" if url.endswith("occupation") or body[:1] in (b"[", b"{") else "csv"
            path = OUT / (f"{s.key}.{ext}" if len(s.urls) == 1
                          else f"{s.key}_{i}.{ext}")
            path.write_bytes(body)          # ⚠ 先原樣存檔，再處理
            print(f"   → {path}　{len(body):,} bytes")
            describe(body, path)
            ok += 1
        if s.note:
            print(f"   ⚠ {s.note}")

    print(f"\n{ok}/{sum(len(s.urls) for s in todo)} 個資源抓到了 → {OUT}")
    print("\n把上面的欄位貼回對話，我照真實欄位寫解析（不要讓我猜 schema）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
