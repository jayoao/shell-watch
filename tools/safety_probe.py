"""驗證安衛人員備查名冊的「登錄編號前 8 碼＝統一編號」這個假設。

    python -m tools.safety_probe

輸入：data/moldata/safety.csv、data/gcis.duckdb、data/records.csv
輸出：只有 stdout（不寫檔）。這支是**確認假設**，不是產出資料。

════════════════════════════════════════════════════════════════
為什麼要有這一支
════════════════════════════════════════════════════════════════
data.gov.tw 宣告這個資料集的欄位是：

    登錄編號、登錄日期、事業單位名稱（工程名稱）、來文字號、來函日期、
    勞工安全衛生管理員人數、勞工安全管理師人數、勞工衛生管理師人數、
    甲種／乙種／丙種勞工安全衛生業務主管人數

**沒有統一編號。**但實際抓下來的 24,944 筆裡，登錄編號長這樣：

    54733826 20260821 0001     振泰檢驗科技股份有限公司
    83549519 20260827 0001     萬世盛工程顧問股份有限公司台北分公司
    └統編?┘ └西元日期┘ └序號┘

2026-09-17 實測：**前 8 碼有 99.72%（24,874 / 24,944）通過統一編號的
檢核碼演算法**。隨機八位數通過的機率大約是五分之一，所以這不是巧合。

⚠ 但「通過檢核碼」只證明它是一個**格式正確**的統編，不證明它就是
  **這一列這家公司**的統編。這支程式就是去確認後面那件事。

════════════════════════════════════════════════════════════════
⚠⚠ 為什麼這件事值得先確認，不能邊做邊修
════════════════════════════════════════════════════════════════
安衛人員備查是**正面訊號**（「這家公司有依法設置安全衛生管理人員」）。

    把 A 公司的違規顯示成 B 公司的 → 名譽損害。
    把 A 公司的安衛人員顯示成 B 公司的 → **幫一家沒設的公司背書**，
    求職者可能因此去了一個沒有專責安衛人員的工地。

crawler/moldata.py 與 pipeline/credential.py 的規矩：
    有統一編號的 → 只用統編對
    沒有統編的   → 只接受正規化後完全相同的名稱，不做模糊比對

所以「到底有沒有統編」決定了整個串接策略。猜錯的代價不是重寫程式，
是對具名公司做出不實的正面陳述。

════════════════════════════════════════════════════════════════
這支程式回答三個問題
════════════════════════════════════════════════════════════════
  一、登錄編號前 8 碼，在商工登記裡查得到幾筆？
  二、查得到的那些，商工登記的名稱跟這一列寫的名稱**一樣嗎**？
      → 一致率高 ⇒ 假設成立，可以用統編對
      → 一致率低 ⇒ 那 8 碼是別的東西（例如受理機關的代碼），只能用名稱對
  三、兩種對法各自能對到我們幾家有裁處紀錄的公司？

⚠ 第二題印出來的不一致範例**要用眼睛看**。分公司（統編不同於總公司）
  與更名過的公司會合理地不一致，那跟「前 8 碼根本不是統編」是兩回事。
"""
from __future__ import annotations

import csv
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                    # noqa: E402
from pipeline.join import norm_name                                   # noqa: E402

SAFETY = Path("data/moldata/safety.csv")
RECORDS = Path("data/records.csv")
DB = Path("data/gcis.duckdb")

# 統一編號檢核碼。權數固定，逐位相乘後取各位數字相加，總和被 5 整除即通過；
# 第 7 位是 7 的時候另有一條例外（該位可貢獻 0 或 1）。
_W = (1, 2, 1, 2, 1, 2, 4, 1)


def _digit_sum(n: int) -> int:
    return n // 10 + n % 10


def valid_tax_id(s: str) -> bool:
    if len(s) != 8 or not s.isdigit():
        return False
    total = sum(_digit_sum(int(c) * w) for c, w in zip(s, _W))
    if total % 5 == 0:
        return True
    return s[6] == "7" and (total + 1) % 5 == 0


def main() -> int:
    use_utf8_stdout()
    for p in (SAFETY, RECORDS, DB):
        if not p.exists():
            print(f"⚠ 找不到 {p}", file=sys.stderr)
            return 1

    rows = list(csv.DictReader(SAFETY.open(encoding="utf-8-sig", newline="")))
    print(f"安衛備查名冊　{len(rows):,} 筆")

    # ── 一、前 8 碼的形狀 ──────────────────────────────────────
    cand: dict[str, str] = {}          # 統編 → 該列寫的名稱（取第一次出現）
    bad = 0
    for r in rows:
        head = (r.get("登錄編號") or "")[:8]
        if valid_tax_id(head):
            cand.setdefault(head, (r.get("事業單位名稱（工程名稱）") or "").strip())
        else:
            bad += 1
    print(f"  前 8 碼通過統編檢核碼　{len(rows) - bad:,} 筆"
          f"（{(len(rows) - bad) / len(rows) * 100:.2f}%），"
          f"相異統編 {len(cand):,} 個")
    if bad:
        print(f"  ⚠ {bad:,} 筆沒通過 —— 這些只能靠名稱，或者根本不該用")

    # ── 二、統編在商工登記裡對得到嗎？名稱一樣嗎？ ──────────────
    import duckdb
    import pandas as pd

    con = duckdb.connect(str(DB), read_only=True)
    con.execute("CREATE TEMP TABLE want(id VARCHAR)")
    df = pd.DataFrame(sorted(cand), columns=["id"])                  # noqa: F841
    con.execute("INSERT INTO want SELECT * FROM df")
    hits = con.execute("""
        SELECT e.id, e.name_norm, coalesce(e.capital, 0) AS cap
        FROM entity e JOIN want w USING(id)
    """).fetchall()

    # ⚠ 同一個統編理論上只會有一家，但商工登記的快照裡有更名歷程，
    #   同 id 可能出現多列。取資本額最大的，平手用名稱排序 ——
    #   跟 refine.py / succession.py 同一條規矩：
    #   「沒有意義而穩定」勝過「有意義而隨機」。
    #   ⚠ 比較鍵要連資本額一起記住。第一版寫成 `key < (-0, best[eid])`，
    #     等於拿「資本額 0」去跟新的一筆比，永遠是後來的那筆勝出 ——
    #     看起來會動，但結果取決於 SQL 吐列的順序，又是一個非決定性的坑。
    bestkey: dict[str, tuple[int, str]] = {}
    best: dict[str, str] = {}
    for eid, nm, cap in hits:
        key = (-int(cap or 0), str(nm))
        if eid not in bestkey or key < bestkey[eid]:
            bestkey[eid] = key
            best[eid] = str(nm)
    found = len(best)
    print(f"\n  在商工登記查得到的統編　{found:,} / {len(cand):,}"
          f"（{found / len(cand) * 100:.1f}%）")

    same = 0
    diff: list[tuple[str, str, str]] = []
    for eid, gcis_name in best.items():
        ours = norm_name(cand[eid])
        if ours == gcis_name:
            same += 1
        elif len(diff) < 12:
            diff.append((eid, cand[eid], gcis_name))
    print(f"  其中名稱正規化後**完全相同**　{same:,} / {found:,}"
          f"（{same / found * 100:.1f}%）")
    print("\n  ⚠⚠ 上面那個比例就是結論：")
    print("     高（>90%）⇒ 前 8 碼確實是這一列這家公司的統編，可以用統編對")
    print("     低        ⇒ 那 8 碼是別的東西，整個策略退回只用名稱對")
    if diff:
        print("\n  不一致的例子（用眼睛看：分公司與更名是合理的，"
              "完全不相干的才是問題）：")
        for eid, ours, theirs in diff:
            print(f"    {eid}  名冊「{ours}」　商工登記「{theirs}」")

    # ── 三、兩種對法各自對到我們幾家有裁處紀錄的公司 ────────────
    our_names: set[str] = set()
    with RECORDS.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            c = (r.get("company") or "").strip()
            if c:
                our_names.add(norm_name(c))
    print(f"\n  我們有裁處紀錄的公司　{len(our_names):,} 家")

    by_name = sum(1 for n in {norm_name(v) for v in cand.values()}
                  if n in our_names)
    by_taxid = sum(1 for eid in best if best[eid] in our_names)
    print(f"    只用名稱對得到　{by_name:,} 家")
    print(f"    經由統編再換成商工登記名稱後對得到　{by_taxid:,} 家")

    # 名稱裡沒有法人字尾的（機關、學校、鄉公所），不是工程名稱
    n_all = {(r.get("事業單位名稱（工程名稱）") or "").strip() for r in rows}
    print(f"\n  相異名稱 {len(n_all):,} 個")
    per = Counter((r.get("事業單位名稱（工程名稱）") or "").strip() for r in rows)
    print(f"  一家公司最多有 {max(per.values())} 列"
          f"（{per.most_common(1)[0][0]}）—— 串接時要決定取最新一列還是全部")
    con.close()
    print("""
把上面整段貼回對話。⚠ 在確認第二題的比例之前，不要開始寫 safetyunit.py ——
這是正面訊號，配錯等於幫一家沒設安衛人員的公司背書。""")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
