"""把勞動部的違法紀錄接上商工登記，替每個換殼候選找獨立佐證。

    python -m pipeline.join

要先有：
    data/records.csv    ← python -m pipeline.build
    data/gcis.duckdb    ← python -m gcis.fetch && python -m gcis.load

產出 data/joined.csv 與一份摘要。

────────────────────────────────────────────────────────────────
為什麼需要這一步
────────────────────────────────────────────────────────────────
signal.py 的同縣市檢定只能用在 12% 的資料上 —— 因為 82% 的裁處
出自勞保局、職安署這些全國性單位，沒有縣市。剩下那 82% 的連結
目前完全沒有獨立佐證。

商工登記補上三條新的佐證軸線，而且**都不需要完整姓名**（打包檔是遮罩的）：

    登記地址   兩家公司登記在同一個地址 → 很強的佐證
    登記現況   舊公司已解散／歇業 → 換殼的定義性特徵
    資本額     真正擋掉大企業，不再靠公司名猜

────────────────────────────────────────────────────────────────
遮罩姓名的用法
────────────────────────────────────────────────────────────────
打包檔的負責人是「黃_斌」，勞動部是「黃哲斌」。
遮罩保留了姓與末字，所以可以做**部分比對**：黃?斌 vs 黃哲斌 → 相符。

兩個用途：
1. 確認勞動部的公司名真的對到正確的統編（一個名字對到多個統編時用來消歧）
2. 一筆免費的佐證 —— 兩邊的負責人姓名對得起來

⚠ 相符不代表是同一人（「黃_斌」可能是黃哲斌也可能是黃志斌），
   但**不符**幾乎確定是對錯公司了。這是排除用的，不是確認用的。
"""
from __future__ import annotations

import csv
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                 # noqa: E402
from gcis.constants import CLOSED_STATUS                           # noqa: E402
from pipeline.signal import _days                                  # noqa: E402

RECORDS = Path("data/records.csv")
SHELLS = Path("data/shell_candidates.csv")
DB = Path("data/gcis.duckdb")
OUT = Path("data/joined.csv")

_FULLWIDTH = str.maketrans("０１２３４５６７８９", "0123456789")

# ⚠ 地址欄位裡有 5 萬筆寫著「臺北市資料空白」、1.7 萬筆是空白或全形空格。
#   不擋掉的話，這 6.8 萬家公司會兩兩互相「同地址」，製造出一大批假佐證。
_JUNK_ADDR = re.compile(r"(資料空白|不詳|無|未填|待補)$")

# ⚠ 記帳事務所、商務中心、虛擬辦公室會有幾百家公司掛同一個地址。
#   實測全國有 279 個地址掛了 100 家以上，合計 113,613 家。
#   這種地址相同**不是**佐證，是巧合。超過這個數字就不採計。
SHARED_ADDR_LIMIT = 10


def norm_name(s: str) -> str:
    t = (s or "").strip().replace(" ", "").replace("　", "")
    return t.replace("臺", "台").replace("（", "(").replace("）", ")")


def norm_addr(s: str) -> str:
    """地址正規化。

    同一個地址在兩筆登記裡可能寫成
        「臺北市中正區北平西路6號8樓之6」
        「台北市中正區北平西路６號８樓之６」
    不統一就對不起來，而「同地址」正是我們最想要的佐證。
    """
    t = (s or "").strip().translate(_FULLWIDTH)
    t = t.replace("臺", "台").replace(" ", "").replace("　", "")
    if len(t) < 8 or _JUNK_ADDR.search(t):
        return ""          # 太短或是「資料空白」這類佔位字，一律當成沒有地址
    return t


def mask_match(masked: str, full: str) -> bool | None:
    """遮罩姓名 vs 完整姓名。回 None 表示無法判斷。

        黃_斌  vs  黃哲斌   → True
        黃_斌  vs  陳志明   → False
        （空的）           → None
    """
    m, f = (masked or "").strip(), (full or "").strip()
    if not m or not f or "_" not in m:
        return None
    if len(m) != len(f):
        return False
    return all(a == "_" or a == b for a, b in zip(m, f))


def main() -> int:
    use_utf8_stdout()
    for p in (RECORDS, DB):
        if not p.exists():
            print(f"找不到 {p}", file=sys.stderr)
            return 1
    try:
        import duckdb
        import pandas as pd
    except ImportError:
        print("需要 duckdb 與 pandas", file=sys.stderr)
        return 1

    with RECORDS.open(encoding="utf-8-sig", newline="") as f:
        rows = [r for r in csv.DictReader(f)]

    # 公司 → (勞動部登記的負責人, 處分日期清單)
    company: dict[str, dict] = defaultdict(
        lambda: {"principals": set(), "dates": [], "units": set()})
    for r in rows:
        c = r.get("company", "").strip()
        if not c:
            continue
        cell = company[c]
        if r.get("principal"):
            cell["principals"].add(r["principal"])
        cell["units"].add(r["unit"])
        d = _days(r.get("disposition_date", ""))
        if d is not None:
            cell["dates"].append(d)

    con = duckdb.connect(str(DB), read_only=True)
    df = pd.DataFrame([(norm_name(c), c) for c in company],
                      columns=["name_norm", "raw"])
    con.execute("CREATE TEMP TABLE mol AS SELECT * FROM df")

    hits = con.execute("""
        SELECT m.raw, e.id, e.kind, e.rep_masked, e.address,
               e.capital, e.established, e.status
        FROM mol m JOIN entity e USING(name_norm)
    """).fetchall()

    # 一個公司名可能對到多個統編（同名、或解散後名稱被重用）。
    # 用遮罩姓名消歧 —— 這正是遮罩資料還有用的地方。
    cands: dict[str, list[dict]] = defaultdict(list)
    for raw, eid, kind, rep, addr, cap, est, st in hits:
        cands[raw].append({"id": eid, "kind": kind, "rep": rep or "",
                           "addr": addr or "", "capital": cap,
                           "established": est, "status": st or ""})

    resolved: dict[str, dict] = {}
    stats = Counter()
    for name, options in cands.items():
        principals = company[name]["principals"]
        if len(options) == 1:
            resolved[name] = options[0]
            stats["唯一對應"] += 1
            continue
        # 多個候選：留下遮罩姓名對得起來的
        ok = [o for o in options
              if any(mask_match(o["rep"], p) for p in principals)]
        if len(ok) == 1:
            resolved[name] = ok[0]
            stats["靠遮罩姓名消歧"] += 1
        elif ok:
            resolved[name] = ok[0]
            stats["多個都符合，取第一個"] += 1
        else:
            stats["對到多個且無法消歧"] += 1   # 不猜，這些不用

    print(f"勞動部公司名 {len(company):,}")
    print(f"  對到商工登記 {len(cands):,}"
          f"（{100 * len(cands) / len(company):.1f}%）")
    for k, v in stats.most_common():
        print(f"    {k:<20} {v:>8,}")
    unmatched = len(company) - len(cands)
    print(f"  對不到 {unmatched:,}"
          f"（{100 * unmatched / len(company):.1f}%）"
          " ← 多是診所、補習班、協會、事務所，本來就不在商工登記")

    # ── 遮罩姓名的一致率（獨立驗證：對接對不對）──
    agree = dis = 0
    for name, ent in resolved.items():
        for p in company[name]["principals"]:
            v = mask_match(ent["rep"], p)
            if v is True:
                agree += 1
            elif v is False:
                dis += 1
    if agree + dis:
        print(f"\n── 遮罩姓名比對（勞動部負責人 vs 商工登記代表人）──")
        print(f"  相符 {agree:,}　不符 {dis:,}　"
              f"一致率 {100 * agree / (agree + dis):.1f}%")
        print("  ⚠ 不符不一定是對錯公司 —— 負責人本來就會換人。")
        print("     這個數字是對接品質的下界，不是上界。")

    # ── 把佐證寫進候選名單 ──
    if not SHELLS.exists():
        print(f"\n找不到 {SHELLS}，先跑 python -m pipeline.shell", file=sys.stderr)
        con.close()
        return 0

    with SHELLS.open(encoding="utf-8-sig", newline="") as f:
        shells = list(csv.DictReader(f))

    # 每個地址掛了幾家公司 —— 用來認出記帳事務所、商務中心這類共用地址
    addr_users: dict[str, int] = {}
    for a, c in con.execute(
            "SELECT address, count(*) FROM entity WHERE address<>'' "
            "GROUP BY 1 HAVING count(*) > 1").fetchall():
        na = norm_addr(a)
        if na:
            addr_users[na] = addr_users.get(na, 0) + c

    out_rows = []
    closed_set = set(CLOSED_STATUS)
    for s in shells:
        names = s["company_list"].split(" → ")
        ents = [resolved.get(n) for n in names]
        known = [e for e in ents if e]
        addrs = [a for a in (norm_addr(e["addr"]) for e in known) if a]
        # 只有「不是共用地址」的重複才算佐證
        dup = [a for a in set(addrs)
               if addrs.count(a) >= 2 and addr_users.get(a, 0) <= SHARED_ADDR_LIMIT]
        same_addr = bool(dup)
        shared_addr = bool([a for a in set(addrs) if addrs.count(a) >= 2]) and not dup
        # 「先倒一家、再開一家」：時間在前的那些已經停業
        earlier_closed = sum(1 for e in known[:-1] if e["status"] in closed_set)
        caps = [e["capital"] for e in known if e["capital"]]
        ests = [e["established"] for e in known if e["established"]]
        out_rows.append({
            **{k: s[k] for k in ("principal", "companies", "records", "score",
                                 "same_unit", "unit", "kind", "company_list")},
            "gcis_matched": len(known),
            "same_address": int(same_addr),
            "shared_service_address": int(shared_addr),
            "earlier_closed": earlier_closed,
            "all_earlier_closed": int(len(known) >= 2
                                      and earlier_closed == len(known) - 1),
            "max_capital": max(caps) if caps else "",
            "min_established": min(ests) if ests else "",
            "statuses": "／".join(e["status"] or "?" for e in known),
            "addresses": " ｜ ".join(e["addr"] for e in known if e["addr"]),
        })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(out_rows[0]))
        w.writeheader()
        w.writerows(sorted(out_rows, key=lambda r: (
            -r["same_address"], -r["all_earlier_closed"], -float(r["score"]))))

    full = [r for r in out_rows if r["gcis_matched"] >= 2]
    addr = [r for r in full if r["same_address"]]
    seq = [r for r in full if r["all_earlier_closed"]]
    both = [r for r in full if r["same_address"] and r["all_earlier_closed"]]

    print(f"\n── 換殼候選 {len(out_rows):,} 組的佐證 ──")
    print(f"  兩家以上都對到商工登記　{len(full):,}")
    print(f"  登記在同一個地址　　　　{len(addr):,}"
          f"（{100 * len(addr) / max(1, len(full)):.1f}%）")
    print(f"  先前的公司都已停業　　　{len(seq):,}"
          f"（{100 * len(seq) / max(1, len(full)):.1f}%）　← 換殼的定義性特徵")
    print(f"  兩者都成立　　　　　　　{len(both):,}　← 最強的一批")

    # ── 對照：隨機抽兩家公司，登記在同一地址的機率 ──
    #
    # ⚠ 一開始用「登記筆數 / 地址數」估，那等於假設公司平均分布在各地址上。
    #   實際上高度集中（279 個地址掛了 11 萬家），這樣算低估了 2,426 倍，
    #   跑出「722,875 倍」這種一看就不可信的數字。
    #   正確的算法是 Σ c(c-1) / N(N-1)，把集中度算進去。
    n_ent, n_addr, p = con.execute("""
        WITH a AS (SELECT address, count(*) c FROM entity
                   WHERE address<>'' GROUP BY 1),
             t AS (SELECT sum(c) n FROM a)
        SELECT (SELECT n FROM t), (SELECT count(*) FROM a),
               sum(c*(c-1))*1.0 / ((SELECT n FROM t)*((SELECT n FROM t)-1))
        FROM a""").fetchone()
    p_chance = 100 * p
    print(f"\n  對照：全國 {n_ent:,} 筆登記分布在 {n_addr:,} 個地址，"
          f"隨機兩家同地址的機率 {p_chance:.4f}%")
    if len(full):
        lift = (100 * len(addr) / len(full)) / max(1e-9, p_chance)
        print(f"  換殼候選的同地址比例是隨機的 {lift:,.0f} 倍")
    shared = [r for r in full if r["shared_service_address"]]
    print(f"  另有 {len(shared):,} 組是同地址但那個地址掛了 "
          f"{SHARED_ADDR_LIMIT} 家以上（記帳事務所等），不採計")

    print(f"\n→ {OUT}")
    print("\n⚠ 同地址仍不等於同一人 —— 只是把最明顯的共用地址排掉而已。"
          f"\n   門檻 {SHARED_ADDR_LIMIT} 家是人訂的，簡報要寫出來，"
          "並附上換不同門檻的結果。")
    con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
