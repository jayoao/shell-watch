"""勞動部「違反勞動法令事業單位（雇主）查詢系統」爬蟲。

    python -m crawler.mol                 # 全部跑（30 單位 × 10 法規 = 300 次）
    python -m crawler.mol --law 職業安全衛生法
    python -m crawler.mol --unit 台北市 --law 勞動基準法
    python -m crawler.mol --force         # 重抓已存在的檔

────────────────────────────────────────────────────────────────────
這個網站怎麼運作（2026-09-02 直接讀表單原始碼＋實際打過驗證的）
────────────────────────────────────────────────────────────────────

沒有 API。畫面上的查詢與下載都是同一個 form 打出去的 POST：

    查詢  POST /            → 回 HTML，五組表格各自分頁，一頁 10 筆
    下載  POST /Download/   → 回 CSV，**完整結果，沒有分頁**

所以不要去爬 HTML 表格、不要處理分頁 —— 直接打 /Download/ 就好。
這是這支爬蟲最重要的一件事，可以省掉九成的工。

⚠ 畫面上顯示的「最近 3 年內總筆數」不等於下載到的筆數。
   台北市職安法：畫面寫 3,391 筆，下載回來 16,708 筆（103/10 ~ 115/08）。
   下載的是**全部年份**。這對我們是好事，多了 4 倍資料。

必要參數：
  _csrf_token   要先 GET / 拿。同一個 session 內可以重複用，但會過期。
  CITYNO        單位代碼（constants.UNIT_CODES）
  REGNUMBER     法規代碼（constants.LAW_CODES）
  downloadType  1=ODS 2=EXCEL 3=CSV
  Page1..Page5  五組表格各自的頁碼，下載時填 1 就好

⚠ 不能空查詢：CITYNO/UNITNAME/REGNUMBER/REGNO/FINE/日期 全空會被擋。
   我們固定給 CITYNO + REGNUMBER，所以不會踩到。

⚠ 偶爾會回傳 HTML 錯誤頁而不是 CSV，但 HTTP 狀態碼還是 200、
   content-type 還是寫 text/csv。實測 2026-09-02 台北市×勞工退休金條例
   第一次回 HTML、第二次就正常。**一定要驗內容，不能只看狀態碼。**

⚠ HTTP header 寫 charset=ANSII，那是錯的，實際是 UTF-8 with BOM。

政府網站，不要打太快。預設每次間隔 2 秒。
"""
from __future__ import annotations

import argparse
import csv
import io
import random
import re
import sys
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

import requests

from common import use_utf8_stdout

from .constants import (
    BASE_URL,
    CSV_TITLE_ROW,
    DOWNLOAD_TYPE_CSV,
    DOWNLOAD_URL,
    LAW_CODES,
    LAWS,
    UNIT_CODES,
    UNITS,
    law_group,
)

RAW_DIR = Path("data/raw")
COVERAGE_PATH = Path("data/coverage.csv")

# ⚠ HTTP header 只能放 latin-1，**不能有中文**。
#    放了中文會在 http.client.putheader() 掛掉：
#      values[i] = one_value.encode('latin-1')
#      UnicodeEncodeError: 'latin-1' codec can't encode characters
#    而且是在送出第一個請求時就掛，訊息又完全看不出跟 User-Agent 有關。
USER_AGENT = (
    "shell-watch/0.1 (student research project; "
    "InnoServe 2026 contest; 2s delay between requests)"
)

DEFAULT_DELAY = 2.0
MAX_RETRIES = 3

_TOKEN_RE = re.compile(r'name="_csrf_token"\s+value="([^"]+)"')


class NoNetwork(RuntimeError):
    """連不到勞動部網站。這不是資料問題，重試也沒用，直接停。"""



# ─────────────────────────── session ───────────────────────────


class MolSession:
    """管 cookie 與 _csrf_token。token 會過期，過期就重拿。"""

    def __init__(self, delay: float = DEFAULT_DELAY):
        self.s = requests.Session()
        headers = {"User-Agent": USER_AGENT}
        for k, v in headers.items():
            try:
                v.encode("latin-1")
            except UnicodeEncodeError:
                raise ValueError(
                    f"HTTP header {k!r} 含有非 latin-1 字元（例如中文），"
                    "requests 送不出去。header 只能用英數字。"
                ) from None
        self.s.headers.update(headers)
        self.delay = delay
        self.token: str | None = None

    def _sleep(self) -> None:
        # 加一點抖動，不要每次都剛好整秒
        time.sleep(self.delay + random.uniform(0, 0.5))

    def refresh_token(self) -> str:
        r = self.s.get(BASE_URL, timeout=30)
        r.raise_for_status()
        m = _TOKEN_RE.search(r.text)
        if not m:
            raise RuntimeError(
                "首頁抓不到 _csrf_token —— 網站改版了，去看 crawler/mol.py 的說明"
            )
        self.token = m.group(1)
        return self.token

    def download(self, unit_code: str, law_code: str) -> bytes:
        """回傳 CSV 原始 bytes。內容驗過才回，不然重試。"""
        last_err = ""
        for attempt in range(1, MAX_RETRIES + 1):
            if self.token is None:
                try:
                    self.refresh_token()
                except requests.RequestException as e:
                    # 連不上首頁就拿不到 token。這通常不是程式的問題，
                    # 是網路／Proxy／防火牆，所以要講清楚，不要吐 traceback。
                    raise NoNetwork(
                        f"連不上 {BASE_URL}：{e.__class__.__name__}\n"
                        "      這通常是網路或公司/學校 Proxy 擋掉了，不是程式問題。\n"
                        "      先用瀏覽器開一次 https://announcement.mol.gov.tw/ 確認開得起來。"
                    ) from None
                self._sleep()

            form = {
                "_csrf_token": self.token,
                "CITYNO": unit_code,
                "UNITNAME": "",
                "DOCstartDate": "",
                "DOCEndDate": "",
                "REGNUMBER": law_code,
                "REGNO": "",
                "FINE": "",
                "downloadType": DOWNLOAD_TYPE_CSV,
                "Page1": "1", "Page2": "1", "Page3": "1",
                "Page4": "1", "Page5": "1",
            }
            try:
                r = self.s.post(DOWNLOAD_URL, data=form, timeout=180)
            except requests.RequestException as e:
                last_err = f"連線失敗：{e}"
            else:
                body = r.content
                ok, why = _looks_like_csv(body)
                if r.status_code == 200 and ok:
                    return body
                last_err = f"HTTP {r.status_code}，{why}"
                # 多半是 token 過期或伺服器暫時吐錯頁，兩種都靠重拿 token 解
                self.token = None

            if attempt < MAX_RETRIES:
                backoff = self.delay * (2 ** attempt)
                print(f"      重試 {attempt}/{MAX_RETRIES - 1}（{last_err}），"
                      f"等 {backoff:.0f} 秒", file=sys.stderr)
                time.sleep(backoff)

        raise RuntimeError(f"抓不到（試了 {MAX_RETRIES} 次）：{last_err}")


def _looks_like_csv(body: bytes) -> tuple[bool, str]:
    """驗內容。狀態碼 200 不代表拿到 CSV —— 實測會回 HTML 錯誤頁。"""
    if not body:
        return False, "空回應"
    text = body[:200].decode("utf-8", errors="replace").lstrip("﻿")
    if text.lstrip().lower().startswith(("<!doctype", "<html")):
        return False, "回傳的是 HTML 錯誤頁，不是 CSV"
    if CSV_TITLE_ROW not in text:
        return False, f"開頭沒有「{CSV_TITLE_ROW}」，內容是：{text[:60]!r}"
    return True, ""


# ─────────────────────────── 讀檔 ───────────────────────────


def read_rows(body: bytes) -> tuple[list[str], list[list[str]]]:
    """把下載檔拆成 (欄位名, 資料列)。

    檔案結構：
        第 1 列   "違反雇主清冊"                 ← 標題，丟掉
        第 2 列   "編號","縣市／單位別",...       ← 欄位名
        第 3 列起 資料

    ⚠ 每一列資料的欄位數比標題列**多 1**（行尾多一個逗號）。
      不要用 len(row) == len(header) 過濾，會把全部資料丟光。
    ⚠ 欄位名「事業單位名稱(負責人)\\n自然人姓名」裡面真的有換行字元。
    """
    text = body.decode("utf-8-sig", errors="replace")
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) < 2:
        return [], []
    header = rows[1]
    data = [r for r in rows[2:] if len(r) >= len(header)]
    return header, data


@dataclass
class Coverage:
    unit: str
    unit_code: str
    law: str
    law_code: str
    group: str
    rows: int
    first_announced: str
    last_announced: str
    bytes: int
    fetched_at: str


def summarize(unit: str, law: str, body: bytes) -> Coverage:
    header, data = read_rows(body)
    dates = sorted({r[2].strip() for r in data if len(r) > 2 and r[2].strip()})
    return Coverage(
        unit=unit,
        unit_code=UNIT_CODES[unit],
        law=law,
        law_code=LAW_CODES[law],
        group=law_group(law),
        rows=len(data),
        first_announced=dates[0] if dates else "",
        last_announced=dates[-1] if dates else "",
        bytes=len(body),
        fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )


# ─────────────────────────── 主流程 ───────────────────────────


def raw_path(unit: str, law: str) -> Path:
    return RAW_DIR / f"{UNIT_CODES[unit]}_{LAW_CODES[law]}.csv"


def crawl(units: list[str], laws: list[str], *,
          force: bool = False, delay: float = DEFAULT_DELAY) -> list[Coverage]:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    sess = MolSession(delay=delay)
    coverage: list[Coverage] = []
    total = len(units) * len(laws)
    done = 0

    for unit in units:
        for law in laws:
            done += 1
            path = raw_path(unit, law)
            tag = f"[{done}/{total}] {unit} × {law}"

            if path.exists() and not force:
                body = path.read_bytes()
                cov = summarize(unit, law, body)
                coverage.append(cov)
                print(f"{tag} —— 已有檔案，跳過（{cov.rows} 筆）")
                continue

            try:
                body = sess.download(UNIT_CODES[unit], LAW_CODES[law])
            except NoNetwork as e:
                print(f"\n連不上勞動部網站，停止。\n      {e}", file=sys.stderr)
                return coverage
            except RuntimeError as e:
                # 單一組失敗不要讓整輪重來 —— 記下來，最後一起看
                print(f"{tag} —— 失敗：{e}", file=sys.stderr)
                continue

            # ⚠ 先原樣存檔，再處理。爬蟲掛掉時不用重來。
            path.write_bytes(body)
            cov = summarize(unit, law, body)
            coverage.append(cov)

            span = (f"{cov.first_announced}~{cov.last_announced}"
                    if cov.rows else "無資料")
            print(f"{tag} —— {cov.rows} 筆　{span}")
            sess._sleep()

    return coverage


def write_coverage(coverage: list[Coverage]) -> None:
    """涵蓋範圍表。

    這張表本身就是專題的一部分：各縣市的資料保存期間差很多
    （台北市勞基法涵蓋 12 年、台中不到 2 年），跨縣市比較一定要
    用「期間內的率」而不是絕對筆數，不然會把「資料被下架」講成
    「雇主比較守法」。這張表是那個換算的依據，簡報也要放。
    """
    COVERAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
    fields = list(Coverage.__annotations__)
    with COVERAGE_PATH.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for c in sorted(coverage, key=lambda c: (-c.rows, c.unit)):
            w.writerow(asdict(c))
    print(f"\n涵蓋範圍寫到 {COVERAGE_PATH}")


def main(argv: list[str] | None = None) -> int:
    use_utf8_stdout()
    p = argparse.ArgumentParser(description="勞動部違法雇主公告爬蟲")
    p.add_argument("--unit", action="append", choices=UNITS,
                   help="只抓這個單位（可重複）")
    p.add_argument("--law", action="append", choices=LAWS,
                   help="只抓這個法規（可重複）")
    p.add_argument("--force", action="store_true", help="重抓已存在的檔")
    p.add_argument("--delay", type=float, default=DEFAULT_DELAY,
                   help=f"每次請求間隔秒數（預設 {DEFAULT_DELAY}）")
    a = p.parse_args(argv)

    units = a.unit or UNITS
    laws = a.law or LAWS

    est = len(units) * len(laws) * (a.delay + 2)
    print(f"要抓 {len(units)} 單位 × {len(laws)} 法規 = "
          f"{len(units) * len(laws)} 次，大約 {est / 60:.0f} 分鐘\n")

    coverage = crawl(units, laws, force=a.force, delay=a.delay)
    write_coverage(coverage)

    got = sum(c.rows for c in coverage)
    empty = sum(1 for c in coverage if c.rows == 0)
    print(f"共 {got:,} 筆，其中 {empty} 組查無資料")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
