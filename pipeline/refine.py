"""用商工登記的事實做大企業排除，並且**先量效果再決定要不要用**。

    python -m pipeline.refine

要先有 data/joined.csv（python -m pipeline.join）與 data/gcis.duckdb。

────────────────────────────────────────────────────────────────
為什麼不是直接設門檻就好
────────────────────────────────────────────────────────────────
`exclude.py` 裡的門檻（資本額一億、設立滿 20 年、董監事 7 人以上）
是在還沒有商工登記資料的時候憑常識寫的。現在有真資料了，
那些門檻**該被檢驗，不是被沿用**。

檢驗的方法：一個好的排除條件應該同時做到兩件事 ——

    1. 濾掉一批候選
    2. **讓剩下的候選「同地址」比例上升**

第二點是關鍵。同地址是獨立於資本額、設立年、董監事人數的證據
（來自不同欄位、不同邏輯）。如果濾掉大企業之後同地址比例上升，
代表濾掉的確實是雜訊；如果比例不動甚至下降，那個條件就是在亂砍。

這支程式會把每個條件的效果單獨列出來，讓門檻是選出來的不是猜的。

⚠ 「設立滿 20 年」這條要特別小心：換殼的人也可能經營一家公司 20 年才收掉。
   它比較像「這家公司很穩定」的訊號，不是「這是大企業」。看數字再決定。
"""
from __future__ import annotations

import csv
import math
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                      # noqa: E402
from pipeline.join import norm_addr, norm_name          # noqa: E402

JOINED = Path("data/joined.csv")
DB = Path("data/gcis.duckdb")
OUT = Path("data/final_candidates.csv")

CURRENT_YEAR = 2026
SHARED_ADDR_LIMIT = 10


def load_facts(con, wanted: set[str]) -> tuple[dict[str, dict], dict[str, int]]:
    """公司名（正規化）→ 商工登記事實。同名取資本額最大的那一家。

    ⚠ **只查需要的那幾萬家，不要全表掃。** 第一版寫成
      `SELECT ..., (SELECT count(*) FROM director d WHERE d.id = e.id) FROM entity e`
      —— 對 427 萬筆跑相關子查詢，再把結果全部塞進 Python dict，
      直接被 OOM killer 砍掉（exit 137，而且什麼訊息都沒有）。
      候選只用到幾萬家，先把名單丟進暫存表再 JOIN，差好幾個數量級。
    """
    import pandas as pd
    con.execute("CREATE TEMP TABLE want(name_norm VARCHAR)")
    df = pd.DataFrame(sorted(wanted), columns=["name_norm"])   # noqa: F841
    con.execute("INSERT INTO want SELECT * FROM df")

    facts: dict[str, dict] = {}
    rows = con.execute("""
        SELECT e.name_norm, e.id, e.kind, e.capital, e.established,
               e.status, e.address, coalesce(d.n, 0)
        FROM entity e
        JOIN want w USING(name_norm)
        LEFT JOIN (SELECT id, count(*) AS n FROM director
                   -- ⚠ 只算真的董監事。director 表裡也有「合夥人」，
                   --   那是小商號的出資人 —— 一家 21 萬資本額的商行有 9 個
                   --   合夥人是很正常的事，不代表它是大企業。
                   --   混在一起算，「董監事 ≥ 5 人」就會去砍小吃店。
                   WHERE title <> '合夥人' GROUP BY 1) d
               ON d.id = e.id
    """).fetchall()
    for name, eid, kind, cap, est, status, addr, ndir in rows:
        cur = facts.get(name)
        if cur is None or (cap or 0) > (cur["capital"] or 0):
            facts[name] = {"id": eid, "kind": kind, "capital": cap,
                           "established": est, "status": status or "",
                           "addr": addr or "", "directors": ndir}

    # 地址的使用家數也只查候選用到的那些地址
    addrs = sorted({f["addr"] for f in facts.values() if f["addr"]})
    addr_users: dict[str, int] = defaultdict(int)
    if addrs:
        con.execute("CREATE TEMP TABLE want_addr(address VARCHAR)")
        da = pd.DataFrame(addrs, columns=["address"])          # noqa: F841
        con.execute("INSERT INTO want_addr SELECT * FROM da")
        for a, c in con.execute(
                "SELECT e.address, count(*) FROM entity e "
                "JOIN want_addr a USING(address) GROUP BY 1").fetchall():
            na = norm_addr(a)
            if na:
                addr_users[na] += c
    return facts, addr_users


def same_address(names: list[str], facts: dict, addr_users: dict) -> bool:
    addrs = [a for a in (norm_addr(facts.get(norm_name(n), {}).get("addr", ""))
                         for n in names) if a]
    return any(addrs.count(a) >= 2 and addr_users.get(a, 0) <= SHARED_ADDR_LIMIT
               for a in set(addrs))


def validate_signals(groups: list[dict], base: int, n: int) -> None:
    """反過來用：檢驗**每個訊號**是不是真的有用。

    ────────────────────────────────────────────────────────────
    同一套機器，換一個問法
    ────────────────────────────────────────────────────────────
    上面問的是「排除什麼可以讓剩下的更好」，答案是「什麼都不用排」。
    這裡問的是「哪些訊號真的跟『是同一人』有關」。

    做法一樣：拿**同地址**當獨立的量尺。同地址來自經濟部的登記地址，
    跟時間樣態、姓名稀有度、裁處縣市完全無關 —— 是不同資料、不同邏輯。

    如果一個訊號為真的那群，同地址比例顯著高於為假的那群，
    代表這兩個獨立的證據**指向同一件事**，那個訊號就是真的有用。

    ⚠ 同地址不能拿來驗證同地址自己。這裡只驗其他訊號。
    ⚠ 這是相關性不是因果，而且同地址本身也只是佐證不是答案。
       最終仍要靠人工標註與 kappa。
    """
    def score_of(g) -> float:
        try:
            return float(g["row"].get("score") or 0)
        except ValueError:
            return 0.0

    # ⚠ 這個尺量的是「**是不是同一人**」，不是「**像不像換殼**」。
    #   兩者是不同的問題，別用同一把尺去評所有訊號：
    #
    #     身分訊號  姓名稀有度、同縣市、同地址
    #               → 回答「這幾家公司是不是同一個人的」
    #     樣態訊號  先前的公司已停業、時間依序、組織型態
    #               → 回答「這個樣子像不像換殼」
    #
    #   一個樣態訊號在這把尺上沒有效果，**不代表它沒用** ——
    #   代表它回答的是另一個問題。實測「先前的公司都已停業」是 0.98 倍
    #   （3.70% vs 3.79%），完全沒差別，因為全國本來就有 55% 的登記
    #   已經是解散／歇業狀態，它接近基準率，對「是不是同一人」沒有資訊。
    SIGNALS = [
        ("先前的公司都已停業〔樣態〕", lambda g: g["row"].get("all_earlier_closed") == "1"),
        ("可信度分數 ≥ 3〔身分〕", lambda g: score_of(g) >= 3),
        ("可信度分數 ≥ 5〔身分〕", lambda g: score_of(g) >= 5),
        ("裁處單位都是同一縣市〔身分〕", lambda g: g["row"].get("same_unit") == "1"),
        ("只有 2 家公司〔樣態〕", lambda g: g["row"].get("companies") == "2"),
        ("資本額都低於 100 萬〔樣態〕", lambda g: 0 < g["max_capital"] < 1_000_000),
    ]

    print("\n" + "═" * 62)
    print("換個問法：哪些訊號真的跟「是同一人」有關？")
    print("═" * 62)
    print("""
拿**同地址**當獨立的量尺 —— 它來自經濟部的登記地址，
跟時間樣態、姓名稀有度、裁處縣市完全無關。
如果一個訊號為真的那群同地址比例明顯較高，
代表兩個獨立來源的證據指向同一件事。
""")
    print(f"  {'訊號':<22}{'符合':>7}{'同地址%':>9}"
          f"{'不符合':>8}{'同地址%':>9}{'倍數':>7}  顯著")
    for label, pred in SIGNALS:
        yes = [g for g in groups if pred(g)]
        no = [g for g in groups if not pred(g)]
        if len(yes) < 30 or len(no) < 30:
            continue
        py = sum(g["same_addr"] for g in yes) / len(yes)
        pn = sum(g["same_addr"] for g in no) / len(no)
        # 兩個比例差的標準誤
        se = math.sqrt(py * (1 - py) / len(yes) + pn * (1 - pn) / len(no))
        sig = abs(py - pn) > 2 * se
        lift = py / pn if pn else float("inf")
        print(f"  {label:<22}{len(yes):>7,}{100 * py:>8.2f}%"
              f"{len(no):>8,}{100 * pn:>8.2f}%{lift:>7.2f}  "
              f"{'✓' if sig else '－'}")

    print("""
  這把尺量的是「**是不是同一人**」，不是「**像不像換殼**」。

  〔身分〕訊號 ✓ → 有獨立證據支持，可以拿來排序可信度。
  〔樣態〕訊號 － → **不代表它沒用**，代表它回答的是另一個問題。
     「先前的公司都已停業」是 0.98 倍（3.70% vs 3.79%），完全沒差別 ——
     因為全國本來就有 55% 的登記處於解散／歇業狀態，它接近基準率。
     它的用途是**定義換殼的樣子**，不是判斷是不是同一個人。

  所以最終的排序要分兩層：
     先用〔身分〕訊號決定「這個連結可不可信」，
     再用〔樣態〕訊號決定「這是換殼還是集團」。
  把兩種訊號加在同一個分數裡，等於把兩個不同的問題混成一個答案。""")


def main() -> int:
    use_utf8_stdout()
    for p in (JOINED, DB):
        if not p.exists():
            print(f"找不到 {p}", file=sys.stderr)
            return 1
    import duckdb

    with JOINED.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    wanted = {norm_name(n) for r in rows
              for n in r["company_list"].split(" → ") if n.strip()}
    con = duckdb.connect(str(DB), read_only=True)
    facts, addr_users = load_facts(con, wanted)
    print(f"候選涉及 {len(wanted):,} 家公司，"
          f"其中 {len(facts):,} 家對得到商工登記\n")

    # 每一組補上商工登記事實
    groups = []
    for r in rows:
        names = r["company_list"].split(" → ")
        fs = [facts.get(norm_name(n)) for n in names]
        known = [x for x in fs if x]
        if len(known) < 2:
            continue          # 對不到商工登記的沒辦法判斷，不列入評估
        groups.append({
            "row": r,
            "names": names,
            "max_capital": max((x["capital"] or 0) for x in known),
            "oldest": min((x["established"] or CURRENT_YEAR) for x in known),
            "max_directors": max(x["directors"] for x in known),
            "same_addr": same_address(names, facts, addr_users),
        })

    n = len(groups)
    base = sum(g["same_addr"] for g in groups)
    print(f"可評估的候選 {n:,} 組，其中同地址 {base:,}"
          f"（{100 * base / n:.2f}%）\n")

    # ── 逐條檢驗 ──────────────────────────────────────────
    #
    # 「量的是不是大企業」那一欄很重要。
    # 設立年份量的是「開了多久」，不是「有多大」 —— 一家資本額 5 萬、
    # 一個負責人的清潔社開了 25 年，它不是大企業。
    # 這種條件就算讓比例上升也不能用，因為它砍掉的正是我們要找的對象。
    CRITERIA = [
        ("資本額 ≥ 1 億", True, lambda g: g["max_capital"] >= 100_000_000),
        ("資本額 ≥ 3000 萬", True, lambda g: g["max_capital"] >= 30_000_000),
        ("資本額 ≥ 1000 萬", True, lambda g: g["max_capital"] >= 10_000_000),
        ("董監事 ≥ 7 人", True, lambda g: g["max_directors"] >= 7),
        ("董監事 ≥ 5 人", True, lambda g: g["max_directors"] >= 5),
        ("設立滿 30 年", False, lambda g: CURRENT_YEAR - g["oldest"] >= 30),
        ("設立滿 20 年", False, lambda g: CURRENT_YEAR - g["oldest"] >= 20),
    ]

    base_rate = 100 * base / n
    print("每個條件單獨看。「顯著」欄是跟抽樣誤差比 ——")
    print("同地址只有 3~4%，樣本一少，比例本來就會上下跳幾個 0.1 個百分點。")
    print("沒有超過 2 個標準誤的變化，就是雜訊，不能拿來選條件。\n")
    print(f"  {'條件':<15}{'量大企業':>9}{'濾掉':>8}{'剩下':>8}"
          f"{'同地址%':>9}{'變化':>8}{'2SE':>7}  顯著")
    keep_flags = []
    for label, targets_size, pred in CRITERIA:
        removed = [g for g in groups if pred(g)]
        left = [g for g in groups if not pred(g)]
        if not left or not removed:
            continue
        rate = 100 * sum(g["same_addr"] for g in left) / len(left)
        delta = rate - base_rate
        p = base / n
        se2 = 2 * math.sqrt(p * (1 - p) / len(left)) * 100
        sig = abs(delta) > se2
        keep_flags.append((label, targets_size, len(removed), delta, sig))
        print(f"  {label:<15}{'是' if targets_size else '否':>9}"
              f"{len(removed):>8,}{len(left):>8,}{rate:>8.2f}%"
              f"{delta:>+8.2f}{se2:>7.2f}  {'✓' if sig else '－'}")

    good = [l for l, t, k, d, sig in keep_flags if sig and d > 0 and t]
    noise = [l for l, t, k, d, sig in keep_flags if not sig]
    wrong = [l for l, t, k, d, sig in keep_flags if sig and d > 0 and not t]

    print()
    if noise:
        print("  雜訊（變化沒超過 2SE，不採用）：" + "、".join(noise))
    if wrong:
        print("  有效但量錯東西（不採用）：" + "、".join(wrong))
        print("    —— 這些條件量的是「開了多久」不是「有多大」。")
        print("       實測被它砍掉的包括資本額 5 萬的餐飲企業社、")
        print("       100 萬的清潔公司 —— 那正是我們要找的對象。")

    # ── 套用有效的組合 ──────────────────────────────────
    chosen = set(good)
    if not chosen:
        print("\n" + "─" * 62)
        print("結論：**沒有任何條件通過檢驗，不套用商工登記的大企業排除。**")
        print("─" * 62)
        print("""
這不是失敗，是一個要寫進簡報的結果：

  pipeline/shell.py 用「時間樣態＋公司名相似度＋組織型態＋公司數」
  這四個訊號做的分流，**已經把大企業處理掉了**。
  再用資本額、董監事人數去篩，剩下的效果小到跟抽樣誤差分不開。

  如果我們照第一版的做法「挑出讓比例上升的條件」全部套用，
  會砍掉 51% 的候選（3,342/6,529），換到的是 0.5 個百分點、
  而且是在雜訊範圍內的「改善」—— 那是純粹的損失。

商工登記在這個專案的價值不在排除，在**佐證**：
  · 同地址（join.py，274 倍於隨機）
  · 登記現況已解散／歇業（換殼的定義性特徵）
那兩個是實打實的，這一個不是。門檻要憑證據，沒有證據就不要加規則。""")
        validate_signals(groups, base, n)
        con.close()
        return 0

    def excluded(g) -> str:
        for label, _t, pred in CRITERIA:
            if label in chosen and pred(g):
                return label
        return ""

    kept = [g for g in groups if not excluded(g)]
    dropped = [(g, excluded(g)) for g in groups if excluded(g)]
    rate = 100 * sum(g["same_addr"] for g in kept) / max(1, len(kept))

    print(f"\n── 套用「{' 或 '.join(sorted(chosen))}」──")
    print(f"  排除 {len(dropped):,} 組，剩下 {len(kept):,} 組")
    print(f"  同地址比例 {100 * base / n:.2f}% → {rate:.2f}%")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    fields = list(rows[0]) + ["max_capital", "oldest_established",
                              "max_directors", "gcis_same_address"]
    with OUT.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for g in sorted(kept, key=lambda x: (-x["same_addr"],
                                             -float(x["row"]["score"] or 0))):
            w.writerow({**g["row"],
                        "max_capital": g["max_capital"] or "",
                        "oldest_established": g["oldest"],
                        "max_directors": g["max_directors"],
                        "gcis_same_address": int(g["same_addr"])})
    print(f"\n→ {OUT}")

    print("\n── 被排除的樣本（確認排對了）──")
    for g, why in dropped[:8]:
        print(f"  [{why}] 資本 {g['max_capital']:>13,}　"
              f"設立 {g['oldest']}　董監事 {g['max_directors']:>2}　"
              f"{g['row']['company_list'][:40]}")

    validate_signals(groups, base, n)
    print("\n⚠ 門檻是**從資料選出來的**，不是憑常識訂的 —— 這一點要寫進簡報。")
    print("   評審會問「為什麼是一億不是五千萬」，答案是上面那張表。")
    con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
