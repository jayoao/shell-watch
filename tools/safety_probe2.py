"""把 safety_probe 的 4,461 筆「名稱不一致」分類，判斷有沒有真正配錯的。

    python -m tools.safety_probe2

════════════════════════════════════════════════════════════════
⚠ 先說清楚：上一支程式的判準是我訂錯的
════════════════════════════════════════════════════════════════
safety_probe 印了「一致率 >90% ⇒ 假設成立」，實測 71.5%，看起來是不成立。
但把它印出來的 12 個不一致例子逐個看完，**12 個全部都是對的**：

    名冊「富利餐飲股份有限公司高雄岡山分公司」 商工登記「高雄岡山分公司」
    名冊「元大證券股份有限公司新竹分公司」     商工登記「新竹分公司」
    名冊「凌巨科技股份有限公司八德廠」         商工登記「凌巨科技股份有限公司」

商工登記把分公司的名稱只存分支那一段，名冊寫的是「母公司＋分支」全名；
廠區則相反，名冊多一個廠區後綴。統編是對的，是**我拿字串完全相等當判準**
—— 那個判準對這份資料本來就量不到想量的東西。

⚠ 所以這支不是「換個標準再試一次直到過關」。它問的是一個不一樣、
  而且可以否證的問題：**那 4,461 筆裡，有沒有「兩個名稱根本不相干」的？**
  有的話那才是配錯，數量就是我們的錯誤率；沒有的話假設成立。

════════════════════════════════════════════════════════════════
分四桶，第四桶全部印出來用眼睛看
════════════════════════════════════════════════════════════════
  A 母公司＋分支：名冊名 以 商工登記名 結尾（富利餐飲…高雄岡山分公司）
  B 廠區後綴　　：名冊名 以 商工登記名 開頭（凌巨科技…八德廠）
  C 共同前綴　　：兩者前 4 個字以上相同（更名、簡寫）
  D 其他　　　　：**這一桶就是風險**，全部印出來

⚠ D 桶不是零也不一定代表假設不成立 —— 但它的大小就是我們在文件裡
  必須揭露的錯誤率，而且要逐筆看過才知道是哪一種錯。
"""
from __future__ import annotations

import csv
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                    # noqa: E402
from pipeline.join import norm_name                                   # noqa: E402
from pipeline.credential import legal_name                            # noqa: E402

SAFETY = Path("data/moldata/safety.csv")
RECORDS = Path("data/records.csv")
DB = Path("data/gcis.duckdb")

_W = (1, 2, 1, 2, 1, 2, 4, 1)


def valid_tax_id(s: str) -> bool:
    if len(s) != 8 or not s.isdigit():
        return False
    t = sum((int(c) * w) // 10 + (int(c) * w) % 10 for c, w in zip(s, _W))
    return t % 5 == 0 or (s[6] == "7" and (t + 1) % 5 == 0)


def main() -> int:
    use_utf8_stdout()
    for p in (SAFETY, RECORDS, DB):
        if not p.exists():
            print(f"⚠ 找不到 {p}", file=sys.stderr)
            return 1

    rows = list(csv.DictReader(SAFETY.open(encoding="utf-8-sig", newline="")))
    cand: dict[str, str] = {}
    for r in rows:
        head = (r.get("登錄編號") or "")[:8]
        if valid_tax_id(head):
            cand.setdefault(head, (r.get("事業單位名稱（工程名稱）") or "").strip())

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
    bestkey: dict[str, tuple[int, str]] = {}
    best: dict[str, str] = {}
    for eid, nm, cap in hits:
        key = (-int(cap or 0), str(nm))
        if eid not in bestkey or key < bestkey[eid]:
            bestkey[eid] = key
            best[eid] = str(nm)

    bucket: Counter = Counter()
    others: list[tuple[str, str, str]] = []
    for eid, gcis in best.items():
        ours = norm_name(cand[eid])
        if ours == gcis:
            bucket["相同"] += 1
        elif gcis and ours.endswith(gcis):
            bucket["A 母公司＋分支"] += 1
        elif gcis and ours.startswith(gcis):
            bucket["B 廠區後綴"] += 1
        elif len(ours) >= 4 and len(gcis) >= 4 and ours[:4] == gcis[:4]:
            bucket["C 共同前綴"] += 1
        else:
            bucket["D 其他"] += 1
            others.append((eid, cand[eid], gcis))

    tot = sum(bucket.values())
    print(f"統編在商工登記查得到的　{tot:,} 個\n")
    for k in ("相同", "A 母公司＋分支", "B 廠區後綴", "C 共同前綴", "D 其他"):
        n = bucket.get(k, 0)
        print(f"  {k:<14}{n:>7,}　{n / tot * 100:5.1f}%")
    ok = tot - bucket.get("D 其他", 0)
    print(f"\n  ⚠⚠ 可解釋（相同＋A＋B＋C）　{ok:,} / {tot:,}"
          f"（{ok / tot * 100:.2f}%）")
    print(f"     不可解釋（D）　　　　　　 {bucket.get('D 其他', 0):,} 筆"
          f" ← 這個數字就是要寫進文件的錯誤率")

    if others:
        print(f"\n  D 桶全部（{len(others):,} 筆），逐筆看：")
        for eid, a, b in others[:60]:
            print(f"    {eid}  名冊「{a}」　商工登記「{b}」")
        if len(others) > 60:
            print(f"    …還有 {len(others) - 60:,} 筆")

    # ── 用 credential.py 的 legal_name() 掛到母公司 ──────────────
    # ⚠ 這是刻意重用既有的、已經複核過的函式，不是另外寫一套規則。
    #   顯示一律用名冊原文（unit_raw 的規矩），legal_name 只用來 join。
    our: set[str] = set()
    with RECORDS.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            c = (r.get("company") or "").strip()
            if c:
                our.add(norm_name(c))

    attach: dict[str, list] = defaultdict(list)
    for r in rows:
        raw = (r.get("事業單位名稱（工程名稱）") or "").strip()
        key = norm_name(legal_name(raw))
        if key in our:
            attach[key].append(r)
    nrow = sum(len(v) for v in attach.values())
    print(f"\n  用 legal_name() 掛到有裁處紀錄的公司　{len(attach):,} 家"
          f"（{len(attach) / len(our) * 100:.1f}%），涉及 {nrow:,} 列")
    per = Counter(len(v) for v in attach.values())
    print(f"    一家一列的 {per.get(1, 0):,} 家；"
          f"最多的一家有 {max(per) if per else 0} 列")

    # 附上的那些列，人數欄長什麼樣子
    cols = [c for c in rows[0] if c.endswith("人數")]
    tot_p: Counter = Counter()
    for v in attach.values():
        for r in v:
            for c in cols:
                try:
                    tot_p[c] += int((r.get(c) or "0").strip() or 0)
                except ValueError:
                    pass
    print("\n  掛上去的那些列，各類人數合計：")
    for c in cols:
        print(f"    {c:<22}{tot_p[c]:>8,}")
    con.close()
    print("""
把整段貼回對話。⚠ 重點是 D 桶：
  D 接近 0  ⇒ 統編假設成立，可以開始寫 safetyunit.py
  D 不小    ⇒ 逐筆看是哪一種錯，再決定要不要用這份資料""")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
