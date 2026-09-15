"""產生人話對照表的複核清單 → data/plainlaw_review.csv。

    python -m tools.plainlaw_review

════════════════════════════════════════════════════════════════
這份表在做什麼
════════════════════════════════════════════════════════════════
pipeline/plainlaw.py 的 28 條法條翻譯，加上 pipeline/hazard.py 的
15 句職安危害型態句式標籤，總共 43 句中文，現在正掛在每一家公司的
頁面上告訴使用者「這家公司被罰的是什麼」。

⚠⚠ **翻錯一句，就是我們對一家具名公司做出不實陳述。**
   這是法律文字，寫的人不該是唯一的一關。

所以把它輸出成一份可以在 Excel 裡逐列看的表，兩個人各自過一次。

════════════════════════════════════════════════════════════════
怎麼複核（三十分鐘的事）
════════════════════════════════════════════════════════════════
1. 用 Excel 開 data/plainlaw_review.csv（UTF-8 BOM，直接開就對）。
2. **由上往下看**，表已經照筆數由多到少排好 —— 第一列影響 45 萬筆，
   最後幾列只影響一百多筆。時間不夠就先顧上面。
3. 看兩欄就好：
       我們寫的標籤   ← 使用者會在畫面上看到的那句話
       來源實際文字   ← 勞動部公告裡真正寫的違反內容
   問一個問題：**一個不懂法律的人看到左邊，會不會誤解右邊？**
4. 在「判定」欄填 OK 或 改；要改的話在「改成什麼」欄寫新的句子。
5. ⚠ 優先欄標「⚠無樣本」的那幾列**一定要兩個人都看**。
   那些條項在我們的資料裡沒有實際案例，標籤是照法條寫的，沒有來源文字
   可以對照 —— 是整份表最可能出錯的地方。

⚠ 不用查法條全文也能做大部分的判斷：對照來源文字就夠了。
  真的要查的話，全國法規資料庫（law.moj.gov.tw）搜法規名稱就找得到。

════════════════════════════════════════════════════════════════
⚠ 判準：什麼叫「翻對了」
════════════════════════════════════════════════════════════════
✅ 對的：把法律用語換成日常用語，意思不變、範圍不變
     「延長工作時間超過法定上限」→「加班超過法定上限」

❌ 錯的三種，每一種都看過真實案例：
  1. **範圍變大**：「未依約定日期給付工資」→「欠薪」
     （沒有按約定日期發，跟完全不發，是兩件事）
  2. **加了評價**：「工資未全額給付」→「惡意苛扣薪水」
     （公告說的是事實，沒有說動機）
  3. **主詞跑掉**：雇主義務那一欄寫成「這家公司沒有……」
     （那一欄是教育內容，講的是法規要求所有雇主做什麼，
       不是對這一家公司的認定。一律寫「法規要求雇主……」）
"""
from __future__ import annotations

import csv
import io
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                    # noqa: E402
from pipeline.hazard import HAZARDS, HAZARD_PHRASE, classify          # noqa: E402
from pipeline.plainlaw import PLAIN, _LAW_ALIAS, _norm_article        # noqa: E402

RECORDS = Path("data/records.csv")
OUT = Path("data/plainlaw_review.csv")

_SHORT_TO_LAW = {v: k for k, v in _LAW_ALIAS.items()}


def stars(n: int) -> str:
    return "★★★" if n >= 100_000 else "★★" if n >= 10_000 else "★"


def main() -> int:
    use_utf8_stdout()
    if not RECORDS.exists():
        print(f"⚠ 找不到 {RECORDS}", file=sys.stderr)
        return 1

    # 每個對照條項實際涵蓋幾筆，以及一筆真實的來源文字
    count: Counter = Counter()
    haz_count: Counter = Counter()
    sample: dict = {}
    with RECORDS.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            law = (r["law"] or "").split(";")[0].strip()
            content = (r.get("violation") or "").strip().replace("\n", " ")
            if law == "職業安全衛生法":
                for c in classify(content):
                    haz_count[c] += 1
                    sample.setdefault("H:" + c, content[:80])
                continue
            short = _LAW_ALIAS.get(law)
            if not short:
                continue
            key = (short, _norm_article(law, r.get("law_article", "")))
            if key in PLAIN:
                count[key] += 1
                sample.setdefault(key, content[:80])

    rows = []
    for key, (topic, label, duty, see) in PLAIN.items():
        n = count.get(key, 0)
        src = sample.get(key, "")
        rows.append({
            "優先": "⚠無樣本" if not src else stars(n),
            "涵蓋筆數": n,
            "法規": _SHORT_TO_LAW.get(key[0], key[0]),
            "條項": key[1],
            "主題": topic,
            "我們寫的標籤": label,
            "我們寫的雇主義務": duty,
            "來源實際文字": src or f"（資料裡沒有樣本。表內填的是：{see}）",
            "判定": "",
            "改成什麼": "",
        })
    for code, name, _p, duty in HAZARDS:
        n = haz_count.get(code, 0)
        rows.append({
            "優先": stars(n) if n else "⚠無樣本",
            "涵蓋筆數": n,
            "法規": "職業安全衛生法",
            "條項": f"（危害型態 {code}）",
            "主題": "職業安全",
            "我們寫的標籤": HAZARD_PHRASE.get(code, name),
            "我們寫的雇主義務": duty,
            "來源實際文字": sample.get("H:" + code, "（沒有樣本）"),
            "判定": "",
            "改成什麼": "",
        })

    # ⚠ 照涵蓋筆數由多到少排。時間不夠的時候，先顧影響 45 萬筆的那一列，
    #   不要從第一個想到的開始改。
    rows.sort(key=lambda r: -r["涵蓋筆數"])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    total = sum(r["涵蓋筆數"] for r in rows)
    nosample = sum(1 for r in rows if r["優先"] == "⚠無樣本")
    print(f"{len(rows)} 列 → {OUT}")
    print(f"  涵蓋 {total:,} 筆紀錄")
    print(f"  ⚠ 其中 {nosample} 列沒有實際樣本，標籤是照法條寫的 —— "
          f"**那幾列兩個人都要看**")
    print("\n前 8 列（影響最大的）：")
    for r in rows[:8]:
        print(f"  {r['優先']:<6}{r['涵蓋筆數']:>8,}  {r['我們寫的標籤']}")
    print(f"""
用 Excel 開 {OUT}，在「判定」欄填 OK 或 改。
由上往下看就好 —— 第一列影響 {rows[0]['涵蓋筆數']:,} 筆，
最後一列只影響 {rows[-1]['涵蓋筆數']:,} 筆。""")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
