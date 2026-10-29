"""時序型換殼：把「一人多公司」跟「收掉再開一間」分開來數。

    python -m tools.succession

輸入：data/ranked.csv、data/records.csv、data/gcis.duckdb
輸出：data/succession.csv（逐案）＋ 一張分層表（stdout）

════════════════════════════════════════════════════════════════
為什麼要有這支程式
════════════════════════════════════════════════════════════════
2026-09-15 外部檢視的第一題：

    「你的首頁寫『公司收掉重開，紀錄就留在舊公司』。請給我一個實際案例：
      舊公司登記現況是解散或歇業，同一負責人的新公司設立日在舊公司裁處日
      之後，新公司又被裁處。」

我們答不出來。網站上沒有任何地方呈現時序，而抽樣顯示有連結的公司
**69% 兩家都還在營業** —— 那不是換殼，是一個人開兩家公司。
首頁的敘事跟資料呈現的東西對不上，這是創新性最容易被戳穿的地方。

這支程式就是去把那個案例找出來，或者誠實承認找不到。

════════════════════════════════════════════════════════════════
⚠⚠ 方法：兩層，不可以合併成一個分數
════════════════════════════════════════════════════════════════
CLAUDE.md 的規矩：**先用身分訊號決定連結可不可信，再用樣態訊號決定
是換殼還是集團。** 把兩種訊號加進同一個分數，等於把兩個不同的問題
混成一個答案。

    第一層（身分）  這幾家公司是不是同一個人的？
                    用姓名罕見度、同縣市分層；同地址不參與分層，
                    留著當獨立的校準尺。
    第二層（樣態）  這個樣子像不像換殼？
                    舊公司已停業 + 新公司設立在舊公司最後一次裁處之後。

⚠ 「先前的公司都已停業」這個訊號在身分那把尺上實測是 **0.98 倍**，
  完全沒有效果。那不代表它沒用 —— 它回答的是**另一個問題**。
  所以它只能出現在第二層，不能拿去支持「這幾家是同一個人」。

════════════════════════════════════════════════════════════════
⚠⚠ 這支程式算出來的數字可以怎麼講、不可以怎麼講
════════════════════════════════════════════════════════════════
    ❌ 「我們找出了 N 個換殼案例」
    ✅ 「有 N 組同時符合：身分可信 + 舊公司已停業 + 新公司設立於
         舊公司最後裁處之後」

差別不是修辭。我們沒有身分證字號，永遠無法判定是同一個人；
而「符合這個樣態」跟「就是換殼」之間還隔著動機與事實認定，
那是主管機關的事，不是我們的。

⚠ 另一個一定要附的數字：**同樣的樣態在身分不可信的組裡出現得多不多。**
  如果 A 層跟 D 層的比例差不多，那這個樣態就只是「台灣公司壽命短」的
  背景現象，不是我們找到了什麼。單獨報 N 而不報這個對照 = 誤導。
"""
from __future__ import annotations

import csv
import io
import math
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                    # noqa: E402
from pipeline.join import norm_name                                   # noqa: E402

RANKED = Path("data/ranked.csv")
RECORDS = Path("data/records.csv")
DB = Path("data/gcis.duckdb")
OUT = Path("data/succession.csv")

# 登記現況屬於「已經不在營業」。
# ⚠ 「核准停業」不算 —— 停業是暫時的，公司還在。
CLOSED = {"解散", "歇業", "撤銷", "廢止", "歇業/撤銷", "解散已清算完結"}


def roc_to_ad(d: str) -> int:
    """「YYY/MM/DD」→ 西元年。拆不出來回 0。"""
    head = (d or "").split("/")[0].strip()
    return int(head) + 1911 if head.isdigit() and 80 <= int(head) <= 200 else 0


def two_se(k: int, n: int) -> float:
    """比例的 2 個標準誤（百分點）。

    ⚠ 這個專案已經在三個地方踩過「沒跟抽樣誤差比就宣稱有差異」的坑
      （refine.py 的門檻挑選、rarity.py 的分層判定、rank.py 的分層驗證）。
      任何比例都要附這個，不附就不要報。
    """
    if n == 0:
        return 0.0
    p = k / n
    return 200.0 * math.sqrt(p * (1 - p) / n)


def load_last_violation() -> dict[str, int]:
    """公司（正規化名）→ 最後一次裁處的西元年。"""
    last: dict[str, int] = {}
    with RECORDS.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            y = roc_to_ad(r.get("disposition_date", ""))
            if not y:
                continue
            k = norm_name(r["company"])
            if y > last.get(k, 0):
                last[k] = y
    return last


def load_facts(names: set[str], principals: dict[str, set[str]] | None = None,
               ) -> dict[str, tuple[str, int]]:
    """公司（正規化名）→ (登記現況, 設立西元年)。同名取資本額最大的。

    ⚠⚠ **平手時一定要有確定的順序。**
      第一版寫成「資本額比目前這筆大就換掉」，同名又同資本額的時候
      留下來的是 DuckDB 先吐出來的那一筆 —— 而 SQL 沒有保證列的順序。
      症狀是：同一份資料、同一支程式，跑兩次得到 590 組跟 589 組。
      2026-09-15 真的發生了（A 層 45 vs 46）。

      一份要拿去投稿的統計，**數字必須可以重現**。評審重跑一次得到
      不一樣的數字，比數字難看嚴重得多。所以平手時用統一編號排序
      —— 那是唯一一個保證唯一且穩定的鍵。
    """
    import duckdb
    import pandas as pd

    con = duckdb.connect(str(DB), read_only=True)
    con.execute("CREATE TEMP TABLE want(name_norm VARCHAR)")
    df = pd.DataFrame(sorted(names), columns=["name_norm"])          # noqa: F841
    con.execute("INSERT INTO want SELECT * FROM df")
    rows = con.execute("""
        SELECT name_norm, status, established, coalesce(capital, 0) AS cap, id,
               coalesce(rep_masked, '') AS rep
        FROM entity JOIN want USING(name_norm)
    """).fetchall()
    # ⚠⚠ 2026-10-28：同名多筆時**先挑代表人對得上的那一筆**。原本只看資本額，
    #   「朋馳有限公司」接到的是 1989 年已解散的那一家，而裁處其實屬於 2023 年
    #   設立、仍在營業的另一家 —— 一個同時經營兩家公司的人被算成「收掉再開」，
    #   588 組裡有 39 組是這樣，而且會顯示在網站的「時序」框裡。
    from pipeline.join import mask_match
    best: dict[str, tuple[tuple, str, int]] = {}
    for name, status, est, cap, eid, rep in rows:
        hit = bool(principals) and any(
            mask_match(rep, p) is True for p in principals.get(name, ()))
        # 排序鍵 = (代表人對得上的優先, 資本額大的優先, 統編小的優先)。最後一項只是為了穩定，
        # 沒有任何意義 —— 但「沒有意義而穩定」勝過「有意義而隨機」。
        key = (not hit, -int(cap), str(eid or ""))
        cur = best.get(name)
        if cur is None or key < cur[0]:
            best[name] = (key, status or "", int(est or 0))
    return {k: (v[1], v[2]) for k, v in best.items()}


def main() -> int:
    use_utf8_stdout()
    for p in (RANKED, RECORDS, DB):
        if not p.exists():
            print(f"⚠ 找不到 {p}", file=sys.stderr)
            return 1

    groups = list(csv.DictReader(io.open(RANKED, encoding="utf-8-sig", newline="")))
    names: set[str] = set()
    for g in groups:
        for c in g["company_list"].split(" → "):
            names.add(norm_name(c))
    print(f"候選組 {len(groups):,}　涉及 {len(names):,} 家公司")

    last = load_last_violation()
    principals: dict[str, set[str]] = defaultdict(set)
    for g in groups:
        for c in g["company_list"].split(" → "):
            principals[norm_name(c)].add(g["principal"])
    facts = load_facts(names, principals)
    print(f"  商工登記對到 {len(facts):,} 家（{len(facts) / len(names) * 100:.1f}%）")

    by_tier: dict[str, list[int]] = defaultdict(lambda: [0, 0])   # [符合, 總數]
    cases: list[dict] = []

    for g in groups:
        tier = g["identity_tier"]
        comps = [norm_name(c) for c in g["company_list"].split(" → ")]
        by_tier[tier][1] += 1

        # 這一組裡，有沒有任何一對 (舊, 新) 符合時序型樣態？
        hit = None
        for old in comps:
            st, _ = facts.get(old, ("", 0))
            if st not in CLOSED:
                continue
            old_last = last.get(old, 0)
            if not old_last:
                continue
            for new in comps:
                if new == old:
                    continue
                st2, est2 = facts.get(new, ("", 0))
                # ⚠ 設立只有「年」，沒有月日，所以 est2 == old_last 的那一年
                #   實際上可能發生在裁處之前。用 >= 會把那一年算進來 ——
                #   刻意用 >=（寧可寬），但輸出要標記 same_year，
                #   決賽被問到的時候才講得出「這 N 筆有一年的模糊」。
                if est2 and est2 >= old_last:
                    hit = {
                        "principal": g["principal"],
                        "identity_tier": tier,
                        "gcis_same_address": g.get("gcis_same_address", "0"),
                        "old_company": old,
                        "old_status": st,
                        "old_last_violation": old_last,
                        "new_company": new,
                        "new_status": st2,
                        "new_established": est2,
                        "same_year": int(est2 == old_last),
                        "gap_years": est2 - old_last,
                    }
                    break
            if hit:
                break
        if hit:
            by_tier[tier][0] += 1
            cases.append(hit)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(cases[0].keys()) if cases else
                           ["principal"])
        w.writeheader()
        for c in cases:
            w.writerow(c)

    print(f"\n符合時序型樣態的組：{len(cases):,} / {len(groups):,}"
          f"（{len(cases) / len(groups) * 100:.1f}%）　→ {OUT}")

    print("\n⚠⚠ 單獨報上面那個數字是誤導。要看的是**身分越可信、"
          "這個樣態有沒有越常出現**：")
    print(f"\n  {'身分層級':<16}{'組數':>7}{'符合':>7}{'比例':>9}{'±2SE':>8}")
    order = ["A 姓名罕見＋同縣市", "B 姓名罕見", "C 同縣市", "D 兩者都沒有"]
    for t in order:
        k, n = by_tier.get(t, [0, 0])
        if not n:
            continue
        print(f"  {t:<16}{n:>7,}{k:>7,}{k / n * 100:>8.1f}%{two_se(k, n):>7.1f}")

    # 同地址是獨立的校準尺（不參與分層），所以它是最乾淨的對照。
    sa = [0, 0]
    nsa = [0, 0]
    hit_keys = {(c["principal"], c["old_company"]) for c in cases}
    for g in groups:
        bucket = sa if g.get("gcis_same_address") == "1" else nsa
        bucket[1] += 1
        if any(k[0] == g["principal"] for k in hit_keys):
            bucket[0] += 1
    print(f"\n  {'同地址（獨立尺）':<16}{'組數':>7}{'符合':>7}{'比例':>9}{'±2SE':>8}")
    for label, b in (("是", sa), ("否", nsa)):
        if b[1]:
            print(f"  {label:<16}{b[1]:>7,}{b[0]:>7,}"
                  f"{b[0] / b[1] * 100:>8.1f}%{two_se(b[0], b[1]):>7.1f}")

    same_year = sum(c["same_year"] for c in cases)
    if cases:
        print(f"\n⚠ 其中 {same_year:,} 筆（{same_year / len(cases) * 100:.1f}%）"
              f"的新公司設立年與舊公司最後裁處年**相同**。")
        print("   商工登記的設立只有年份沒有月日，所以這些的先後順序"
              "有一年的模糊，不能當成乾淨的案例。")

    print("""
⚠⚠ 這個數字可以怎麼講：
    ✅ 「有 N 組同時符合：身分可信 + 舊公司已停業 + 新公司設立於
         舊公司最後裁處之後」
    ❌ 「我們找出了 N 個換殼案例」
   我們沒有身分證字號，永遠無法判定是同一個人；而「符合這個樣態」
   跟「就是換殼」之間還隔著動機與事實認定，那是主管機關的事。

⚠ 簡報要附的是上面那兩張分層表，不是單一個 N。
   如果各層比例差不多（差距在 2SE 之內），那這個樣態就只是
   「台灣公司壽命短」的背景現象，不是我們找到了什麼。""")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
