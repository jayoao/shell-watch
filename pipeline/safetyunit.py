"""把安衛單位(人員)備查名冊整理成一張可以掛到公司頁的表。

    python -m pipeline.safetyunit

輸入：data/moldata/safety.csv（crawler/moldata.py --only safety 抓的）
輸出：data/safety.csv

════════════════════════════════════════════════════════════════
這份資料在職安履歷裡的位置
════════════════════════════════════════════════════════════════
我們原有的五個面向 —— 違規、職災、得獎、驗證、登記現況 —— **全部是事後的**，
講的是已經發生過的事。

安衛人員備查講的是：這家公司有沒有把職安法要求的安全衛生管理人員設上、
設了幾位、什麼等級。**它是目前唯一一個事前訊號。**
組別的主題是「職安視覺化**防災**」，防災的重點本來就在事前。

════════════════════════════════════════════════════════════════
⚠⚠ 一、只能顯示「有」，永遠不能顯示「無」
════════════════════════════════════════════════════════════════
職安法只要求**達到一定規模**的事業單位設置安衛人員，小公司本來就不用設。
所以「沒有出現在這份名冊上」有三種可能：

    1. 依法不需要設（最常見）
    2. 該設而沒設（違法）
    3. 設了但這份名冊沒收到／我們沒對上

**我們分不出是哪一種。** 畫面上沒有這一塊，就是沒有這一塊，不加任何說明、
不寫「未設置」、不寫「查無」。把「不適用」寫成「不合規」，是對具名公司的
不實陳述 —— 性質跟把 A 公司的違規掛到 B 公司身上一樣，只是方向相反。

════════════════════════════════════════════════════════════════
⚠⚠ 二、備查是「場所級」的，不是「公司級」的
════════════════════════════════════════════════════════════════
來源長這樣：

    和樂家居股份有限公司台中大墩分公司
    凌巨科技股份有限公司八德廠
    大陸工程股份有限公司（36 列，不同時間不同案件）

台中大墩分公司有一位甲種業務主管，**不代表和樂家居每個門市都有**。
所以跟 credential.py 同一條規矩：

    unit_raw（原始全名）一定要留著並且顯示出來
    name_norm 只用來 join，**絕對不可以拿去當顯示文字**

拿 legal_name() 收斂到母公司再把分支的人數寫成整家公司的，
就是往有利的方向誤導。

════════════════════════════════════════════════════════════════
⚠ 三、為什麼用名稱 join 而不是用統一編號
════════════════════════════════════════════════════════════════
2026-09-17 實測：登錄編號的前 8 碼是統一編號（99.72% 通過檢核碼），
而 data.gov.tw 的欄位說明沒有宣告這件事。

按 credential.py 的規矩「有統編就只用統編對」，看起來應該用統編。**但不行**：

    名冊裡的統編是**分支自己的**統編，跟母公司的統編不同。
    我們的裁處紀錄是掛在母公司身上的。
    用統編直接對，27% 以上的分支與廠區紀錄會整批掉光。

所以統編在這裡的用途改成**佐證**而不是 join 鍵：
    tax_id 照樣輸出，publish 端拿它跟該公司商工登記的統編比，
    相同 → 這一列講的是公司本身
    不同 → 這一列講的是某個分支或廠區（畫面要標出來）

⚠ 這是對 credential.py 那條規矩的**刻意例外**，理由寫在上面。
  不是忘記，也不是偷懶。
"""
from __future__ import annotations

import csv
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                    # noqa: E402
from pipeline.credential import legal_name                            # noqa: E402
from pipeline.join import norm_name                                   # noqa: E402

SRC = Path("data/moldata/safety.csv")
OUT = Path("data/safety.csv")

# 六個人數欄，輸出時的短名。順序＝畫面上的顯示順序（專責在前、業務主管在後）。
COUNTS = (
    ("勞工安全衛生管理員人數", "mgr"),
    ("勞工安全管理師人數", "safe"),
    ("勞工衛生管理師人數", "health"),
    ("甲種勞工安全衛生業務主管人數", "a"),
    ("乙種勞工安全衛生業務主管人數", "b"),
    ("丙種勞工安全衛生業務主管人數", "c"),
)

_W = (1, 2, 1, 2, 1, 2, 4, 1)


def valid_tax_id(s: str) -> bool:
    """統一編號檢核碼。第 7 位是 7 的時候該位可貢獻 0 或 1。"""
    if len(s) != 8 or not s.isdigit():
        return False
    t = sum((int(c) * w) // 10 + (int(c) * w) % 10 for c, w in zip(s, _W))
    return t % 5 == 0 or (s[6] == "7" and (t + 1) % 5 == 0)


def to_int(s: str) -> int:
    try:
        return int((s or "0").strip() or 0)
    except ValueError:
        return 0


def main() -> int:
    use_utf8_stdout()
    if not SRC.exists():
        print(f"⚠ 找不到 {SRC}\n"
              f"  先跑：python -m crawler.moldata --only safety", file=sys.stderr)
        return 1

    rows = list(csv.DictReader(SRC.open(encoding="utf-8-sig", newline="")))
    print(f"讀進 {len(rows):,} 列")

    # ── 同一個場所會報備很多次，只留最新的那一次 ──────────────
    # ⚠ 這是**備查紀錄**不是現況快照：同一個單位每次人員異動就報一次。
    #   全部列出來會讓一家公司出現幾十列一模一樣的東西，
    #   而且舊的那幾列講的是已經不成立的人數。一律取登錄日期最新的。
    #   平手（同一天報兩次）用登錄編號排序 —— 那個鍵沒有意義，
    #   但它唯一而且穩定，跟 refine.py / succession.py 同一條規矩。
    latest: dict[str, dict] = {}
    for r in rows:
        raw = (r.get("事業單位名稱（工程名稱）") or "").strip()
        if not raw:
            continue
        rid = (r.get("登錄編號") or "").strip()
        filed = to_int(r.get("登錄日期", ""))          # 民國 YYYMMDD
        key = raw
        cur = latest.get(key)
        if cur is None or (filed, rid) > (cur["_filed"], cur["_rid"]):
            latest[key] = {"_filed": filed, "_rid": rid, "_row": r, "_raw": raw}
    print(f"  去除重複報備後　{len(latest):,} 個場所"
          f"（原始 {len(rows):,} 列）")

    out: list[dict] = []
    no_tax = 0
    for raw, item in latest.items():
        r = item["_row"]
        head = item["_rid"][:8]
        tax = head if valid_tax_id(head) else ""
        if not tax:
            no_tax += 1
        counts = {short: to_int(r.get(col, "")) for col, short in COUNTS}
        if not any(counts.values()):
            # 六個欄位全是 0 的列在來源裡不存在（實測 0 筆），
            # 但真的出現的話不要寫進去 —— 顯示「有備查、0 人」沒有意義。
            continue
        out.append({
            "name_norm": norm_name(legal_name(raw)),
            "unit_raw": raw,
            "tax_id": tax,
            "filed": item["_filed"],
            **counts,
            "total": sum(counts.values()),
        })

    # 依公司分組後，場所多的排前面；同一家內部依登錄日期由新到舊。
    out.sort(key=lambda x: (x["name_norm"], -x["filed"], x["unit_raw"]))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
        w.writeheader()
        w.writerows(out)

    per = Counter(x["name_norm"] for x in out)
    tot = Counter()
    for x in out:
        for _, s in COUNTS:
            tot[s] += x[s]
    print(f"\n{len(out):,} 列 → {OUT}")
    print(f"  收斂到 {len(per):,} 個法人名稱")
    print(f"  ⚠ {no_tax:,} 列的登錄編號前 8 碼不是合法統編，tax_id 留空")
    print(f"  場所數最多的前 3：{per.most_common(3)}")
    print("\n各類人數合計：")
    for col, s in COUNTS:
        print(f"  {col:<24}{tot[s]:>8,}")
    print("""
⚠ 提醒 publish 端：
  一、沒有出現在這張表上 ≠ 沒有設置安衛人員。畫面上不要有「無」這個狀態。
  二、unit_raw 是顯示文字，name_norm 只能拿去 join。
  三、tax_id 跟該公司商工登記的統編**相同**才是「公司本身」，
      不同就是分支或廠區，畫面要標出來。""")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
