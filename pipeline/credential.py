"""把「得獎與驗證」四份名單整理成一張表。

    python -m pipeline.credential

輸入：data/moldata/{toshms,perf,star5,national}.csv（crawler/moldata.py 抓的）
輸出：data/credential.csv

────────────────────────────────────────────────────────────────
為什麼要有這個
────────────────────────────────────────────────────────────────
LaborOD 的開發方向寫的是「企業**職安履歷**（得獎、驗證、違規與職災紀錄）」。
我們原本只做違規那一樣，畫面看起來就像在指控。把得獎與驗證放進來之後，
同一頁同時呈現好的與壞的，系統才真的是「呈現紀錄」而不是「抓壞人」。

────────────────────────────────────────────────────────────────
⚠⚠ 這批資料錯了是「背書」，方向跟違規相反、嚴重度一樣
────────────────────────────────────────────────────────────────
把 A 公司的違規顯示成 B 公司的 → 名譽損害。
把 A 公司的 TOSHMS 驗證顯示成 B 公司的 → **幫一家沒通過驗證的公司背書**，
求職者可能因此去了一個不安全的職場。所以規則比違規那邊更嚴。

**⚠ 一、「目前狀態」欄不可信，一律看截止日期。**
  實測績效審查那份 86 筆**全部寫「通過」**，但按截止日期算只有 35 筆還在
  有效期內，其餘 51 筆早就到期（最早 2025-03-07）。照著狀態欄顯示，
  就是幫 51 家過期的公司掛上「通過審查」。

**⚠⚠ 二、驗證是「廠區級」的，不是「公司級」的。**
  來源長這樣：
      台灣積體電路製造股份有限公司十二廠七期
      聯華電子股份有限公司Fab8E
      信鼎技術服務股份有限公司(臺南市城西垃圾焚化廠)
  十二廠七期通過審查，**不代表台積電每個廠都通過**。
  所以 unit_raw（原始全名）一定要留著並且顯示出來，
  unit_legal 只用來 join，**絕對不可以拿 unit_legal 當顯示文字** ——
  那會把一個廠區的證書寫成整家公司的證書，往有利的方向誤導。

**⚠ 三、得獎沒有有效期，驗證有。**
  得獎是歷史事實（「114 年獲國家職業安全衛生獎」永遠為真）；
  驗證是一個會過期的狀態。兩者不能用同一個欄位表達。
"""
from __future__ import annotations

import csv
import io
import re
import sys
from dataclasses import dataclass, asdict, fields
from datetime import date
from pathlib import Path

from common import use_utf8_stdout
from pipeline.join import norm_name

SRC = Path("data/moldata")
OUT = Path("data/credential.csv")

# 民國年轉西元，用來跟 TOSHMS 的「證書有效日期」（1180715）比
TODAY = date.today()
TODAY_AD = TODAY.year * 10000 + TODAY.month * 100 + TODAY.day
TODAY_ROC = (TODAY.year - 1911) * 10000 + TODAY.month * 100 + TODAY.day

# 廠區／分支的括號後綴：(總公司)、(臺南市城西垃圾焚化廠)
_PAREN_TAIL = re.compile(r"[(（][^()（）]{1,24}[)）]\s*$")
# 法人字尾。取到最後一個為止，後面接的是廠區名（Fab8E、十二廠七期、桃園印刷廠）
_ORG = re.compile(r"(股份有限公司|有限公司|企業社|商行|工程行|事務所|"
                  r"合作社|基金會|協會|工會)")


def legal_name(raw: str) -> str:
    """原始全名 → 拿來 join 的法人名稱。

    ⚠ 回傳值**只用於比對**，不可以拿去顯示。顯示一律用原始全名。
    """
    s = raw.strip()
    prev = None
    while prev != s:                      # 「…公司(總公司)(北廠)」要剝乾淨
        prev = s
        s = _PAREN_TAIL.sub("", s).strip()
    m = list(_ORG.finditer(s))
    return s[:m[-1].end()] if m else s


def _int(s: str) -> int | None:
    s = (s or "").strip()
    return int(s) if s.isdigit() and len(s) in (7, 8) else None


def roc(s: str) -> str:
    """把日期統一成「民國 YYY/MM/DD」。

    ⚠ 來源用兩套紀年，而且混在同一個畫面上：
        TOSHMS 證書有效日期  1180715  ← 7 碼，民國
        績效審查 截止日期     20250324 ← 8 碼，西元
      不統一的話畫面會同時出現「有效至 1171012」與「有效至 20261212」，
      使用者沒辦法比較哪一個比較晚。

    ⚠ 這裡**換算**而不只是標示（跟設立年份那次的處理不同）。理由：
      位數本身就分得出來（民國年 3 碼、西元年 4 碼），換算是 ±1911 的
      精確算術，不是猜測；而且這個欄位的用途就是跟「今天」比大小，
      兩套紀年並存會讓比較失效。設立年份那次沒有比較需求，所以只標示。
    """
    t = (s or "").strip()
    if not t.isdigit():
        return ""
    if len(t) == 8:                      # 西元 YYYYMMDD
        y, m, d = int(t[:4]) - 1911, t[4:6], t[6:]
    elif len(t) == 7:                    # 民國 YYYMMDD
        y, m, d = int(t[:3]), t[3:5], t[5:]
    else:
        return ""
    return f"民國 {y}/{m}/{d}"


@dataclass
class Cred:
    kind: str            # toshms / perf / star5 / national
    source: str          # 資料集名稱，文件要引用
    dataset: str         # data.gov.tw 編號
    unit_raw: str        # ⚠ 顯示用的原始全名（含廠區）
    unit_legal: str      # ⚠ 只用來 join
    match_key: str       # norm_name(unit_legal)
    detail: str          # 證書編號／獎別
    place: str
    valid_from: str      # 「民國 YYY/MM/DD」，空 = 無
    valid_to: str        # 同上。空 = 沒有有效期（得獎）
    valid_to_raw: str    # 來源原字串，留著給人對帳
    active: int          # 1 = 現在仍有效或為歷史得獎事實


def rows(name: str) -> list[dict]:
    p = SRC / name
    if not p.exists():
        print(f"⚠ 找不到 {p}，先跑 python -m crawler.moldata", file=sys.stderr)
        return []
    return list(csv.DictReader(io.open(p, encoding="utf-8-sig", newline="")))


def build() -> list[Cred]:
    out: list[Cred] = []

    def add(kind, source, dataset, raw, detail, place, vf, vt, active):
        raw = (raw or "").strip()
        if not raw:
            return
        legal = legal_name(raw)
        out.append(Cred(kind, source, dataset, raw, legal, norm_name(legal),
                        detail, place, roc(vf), roc(vt), (vt or "").strip(),
                        active))

    # ── TOSHMS 驗證（有證書有效日期，民國）────────────────────
    n_exp = 0
    for r in rows("toshms.csv"):
        vt = _int(r.get("證書有效日期"))
        ok = bool(vt and vt >= TODAY_ROC)
        n_exp += not ok
        add("toshms", "通過臺灣職業安全衛生管理系統(TOSHMS)驗證之事業單位名單",
            "6340", r.get("事業單位名稱"),
            f"證書編號 {(r.get('證書編號') or '').strip()}",
            (r.get("所在地") or "").strip(),
            (r.get("證書登錄日期") or "").strip(),
            (r.get("證書有效日期") or "").strip(), int(ok))
    print(f"TOSHMS 驗證　　{len(rows('toshms.csv')):>5} 筆，其中 {n_exp} 筆證書已過期")

    # ── 績效審查（有截止日期，西元）────────────────────────
    # ⚠ 不看「目前狀態」欄，它 86 筆全寫「通過」但半數已過期。
    n_exp = 0
    for r in rows("perf.csv"):
        vt = _int(r.get("截止日期"))
        ok = bool(vt and vt >= TODAY_AD)
        n_exp += not ok
        add("perf", "通過職業安全衛生管理系統績效審查且於有效期間之事業單位清單",
            "46106", r.get("事業單位名稱"),
            (r.get("備註及說明") or "").strip(),
            (r.get("地址") or "").strip(),
            (r.get("通過日期") or "").strip(),
            (r.get("截止日期") or "").strip(), int(ok))
    print(f"績效審查　　　{len(rows('perf.csv')):>5} 筆，其中 {n_exp} 筆已過期"
          f"（⚠ 來源的「目前狀態」欄全寫「通過」，不可信）")

    # ── 五星獎（得獎，沒有有效期）──────────────────────────
    for r in rows("star5.csv"):
        y = (r.get("頒獎年度") or "").strip()
        # ⚠ 得獎的「年度」是 114 這種三位數，不是日期，不可以丟進 roc()。
        #   得獎沒有有效期，所以 valid_from／valid_to 一律留空，
        #   年度寫在 detail 裡（「民國 114 年五星獎」）。
        add("star5", "職業安全衛生獎項推行職業安全衛生優良單位五星獎",
            "41460", r.get("五星獎單位名稱"),
            f"民國 {y} 年五星獎" if y else "五星獎",
            (r.get("推薦單位") or "").strip(), "", "", 1)
    print(f"五星獎　　　　{len(rows('star5.csv')):>5} 筆")

    # ── 國家職安獎（得獎，沒有有效期）────────────────────────
    for r in rows("national.csv"):
        y = (r.get("頒獎年度") or "").strip()
        award = (r.get("獎別") or "").strip() or "國家職業安全衛生獎"
        add("national", "職業安全衛生獎項國家職業安全衛生獎",
            "41459", r.get("單位名稱"),
            f"民國 {y} 年 {award}" if y else award, "", "", "", 1)
    print(f"國家職安獎　　{len(rows('national.csv')):>5} 筆")
    return out


def main() -> int:
    use_utf8_stdout()
    creds = build()
    if not creds:
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=[x.name for x in fields(Cred)])
        w.writeheader()
        for c in creds:
            w.writerow(asdict(c))

    act = sum(c.active for c in creds)
    print(f"\n共 {len(creds):,} 筆 → {OUT}")
    print(f"  現在仍有效／為歷史得獎事實　{act:,}")
    print(f"  已過期（會標示，不會當成有效）　{len(creds) - act:,}")
    diff = sum(1 for c in creds if c.unit_raw != c.unit_legal)
    print(f"\n⚠ {diff:,} 筆的原始名稱含廠區／分支（例如「…股份有限公司Fab8E」）。")
    print("   顯示時一定要用 unit_raw，不可以用 unit_legal ——")
    print("   一個廠區的證書不等於整家公司都通過。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
