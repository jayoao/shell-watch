"""把職安法裁處聚合到「每一家事業單位」，產出地圖點位圖層。

    python -m pipeline.points            # 產出 web/src/data/points.json
    python -m pipeline.points --check    # 只比對，不覆寫（拿現有檔案當驗收標準）

要先有：
    data/records.csv     ← python -m pipeline.build
    data/addr_osha.csv   ← python -m pipeline.geo --export-addr
    data/geocode.csv     ← python -m tools.geocode

────────────────────────────────────────────────────────────────
這支為什麼是補寫的
────────────────────────────────────────────────────────────────
⚠⚠ points.json 原本是**沒有產生器**的。commit ce2395e 只加了資料檔
   與前端（web/src/data/points.json、OshaClusters.tsx、points.ts），
   repo 裡沒有任何程式含 `exact_n` 或 `haz_order`。

   那讓 1.76 MB、23,815 個點的整個圖層變成一份無法重跑、無法驗證的
   資料，也直接牴觸系統概述文件寫的「所有統計數字均由版本控制中的
   程式產生」與「整套產出可被第三方重現與驗證」。

   這一支把那個缺口補回來。判準全部對齊 pipeline/geo.py ——
   它是同一批資料的兄弟輸出（聚合到鄉鎮市區），兩邊用不同的判準
   會讓地圖的兩個圖層互相矛盾。

────────────────────────────────────────────────────────────────
與 geo.py 共用的判準（不要各寫一份）
────────────────────────────────────────────────────────────────
    職安法        row.group == "osha"
    涉及死亡      pipeline.hazard.is_fatal(violation)
    行政救濟中    remark 含 pipeline.geo.PENDING 任一關鍵字
    危害型態      pipeline.hazard.classify(violation)
    年份          disposition_date[:4]（西元）
"""
from __future__ import annotations

import csv
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline.geo import PENDING                      # noqa: E402
from pipeline.join import norm_name                   # noqa: E402
from pipeline.hazard import HAZARDS, classify, is_fatal  # noqa: E402

RECORDS = Path("data/records.csv")
ADDR = Path("data/addr_osha.csv")
GEOCODE = Path("data/geocode.csv")
OUT = Path("web/src/data/points.json")

# ⚠ 位元順序就是 HAZARDS 的順序。前端用檔案裡的 haz_order 解讀，
#   兩邊對齊的隱性契約 —— 不要在任何一邊另外寫死一份。
HAZ_ORDER = [h[0] for h in HAZARDS]
HAZ_BIT = {code: 1 << i for i, code in enumerate(HAZ_ORDER)}

csv.field_size_limit(10 ** 7)


def load_coords() -> dict[str, tuple[float, float, int]]:
    """公司名 → (lat, lng, exact)。地址對不到座標的公司直接不在裡面。"""
    geo: dict[str, tuple[str, str, str]] = {}
    with GEOCODE.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            geo[r["address"]] = (r["lat"], r["lng"], r["level"])

    out: dict[str, tuple[float, float, int]] = {}
    with ADDR.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            g = geo.get(r["address"])
            if not g:
                continue
            # ⚠ 5 位小數。原始檔是 6 位，但 5 位已經是約 1 公尺，
            #   而這份資料 20.3% 只到路名級 —— 多留一位是假的精度，
            #   而且 23,815 筆每筆多兩個字元就是白白多 46 KB。
            out[r["company"]] = (round(float(g[0]), 5), round(float(g[1]), 5),
                                 1 if g[2] == "門牌" else 0)
    return out


def aggregate() -> dict[str, dict]:
    """公司 → 職安法裁處的統計。"""
    agg: dict[str, dict] = defaultdict(
        lambda: {"n": 0, "fatal": 0, "pending": 0, "haz": Counter(), "year": 0})
    with RECORDS.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            if row.get("group") != "osha":
                continue
            co = row.get("company") or ""
            if not co:
                continue
            cell = agg[co]
            v = row.get("violation") or ""
            cell["n"] += 1
            fatal = is_fatal(v)
            if fatal:
                cell["fatal"] += 1
            if any(k in (row.get("remark") or "") for k in PENDING):
                cell["pending"] += 1
            for code in classify(v):
                cell["haz"][code] += 1
            # ⚠⚠ disposition_date 是**民國**（"114/12/31"），不是西元。
            #   前端的 year 欄位要的是西元年，所以要 +1911。
            #   直接取 dd[:4] 會拿到 "114/"，isdigit() 為假，整欄變 0 ——
            #   而且不會報錯，只會安靜地全部歸零。
            #   ⚠ pipeline/geo.py 的 yr 計數器有同樣的寫法，那是一個還沒修的 bug。
            dd = (row.get("disposition_date") or "").split("/")[0]
            if dd.isdigit():
                # 「最近一次裁處的西元年」—— 取最大，不是取最常出現的那一年。
                cell["year"] = max(cell["year"], int(dd) + 1911)
    return agg


def build() -> dict:
    coords = load_coords()
    agg = aggregate()

    # ── 臺／台 合併 ──────────────────────────────────────────
    # ⚠⚠ 舊的 points.json 沒有做這一步，所以台電是**兩個點**：
    #       台灣電力股份有限公司  214 筆・10 筆涉及死亡
    #       臺灣電力股份有限公司    5 筆・ 0 筆
    #   座標完全相同，地圖上兩根圖釘疊在一起，筆數也被切成兩半。
    #   全站 14 組，全部是台電、台酒、台泥、台塑、台化這一類
    #   **評審最可能拿來試**的公司。
    #
    # ⚠ 合併方式照 pipeline/publish.py 的慣例，不要另立一套：
    #     key      norm_name()（臺→台、全形括號）
    #     顯示名   取紀錄比較多的那個寫法（通常是主管機關慣用的寫法）
    #   查詢頁就是這樣合的 —— 兩邊不一致的話，查詢頁帶 ?c= 過來
    #   會對不到自己的點。
    merged: dict[str, dict] = {}
    for co, (lat, lng, exact) in coords.items():
        cell = agg.get(co)
        if not cell or cell["n"] == 0:
            continue
        key = norm_name(co)
        cur = merged.get(key)
        if cur is None:
            merged[key] = {"name": co, "lat": lat, "lng": lng, "exact": exact,
                           "n": cell["n"], "fatal": cell["fatal"],
                           "pending": cell["pending"], "haz": Counter(cell["haz"]),
                           "year": cell["year"], "top_n": cell["n"]}
            continue
        if cell["n"] > cur["top_n"]:      # 顯示名與座標跟著筆數多的那個寫法
            cur.update(name=co, lat=lat, lng=lng, exact=exact, top_n=cell["n"])
        cur["n"] += cell["n"]
        cur["fatal"] += cell["fatal"]
        cur["pending"] += cell["pending"]
        cur["haz"] += cell["haz"]
        cur["year"] = max(cur["year"], cell["year"])

    pts = []
    for cell in merged.values():
        co, lat, lng, exact = cell["name"], cell["lat"], cell["lng"], cell["exact"]
        haz = cell["haz"]
        # 最主要的危害型態。⚠ 平手時用 HAZARDS 的順序決勝，不要靠
        #   Counter 的插入順序 —— 那會讓同一份資料在不同機器上產出不同檔案。
        top = min(haz, key=lambda c: (-haz[c], HAZ_ORDER.index(c))) if haz else ""
        mask = 0
        for c in haz:
            mask |= HAZ_BIT[c]
        pts.append([co, lat, lng, exact, cell["n"], cell["fatal"],
                    cell["pending"], top, cell["year"], mask])

    # ⚠ 決定性排序：筆數多到少，同筆數用公司名。沒有第二個鍵的話，
    #   同一份資料重跑會得到不同的檔案，「可重現」就是空話。
    pts.sort(key=lambda p: (-p[4], p[0]))

    return {
        "schema": 1,
        "cols": ["name", "lat", "lng", "exact", "n", "fatal", "pending",
                 "haz", "year", "hazmask"],
        "haz_order": HAZ_ORDER,
        "basis": "商工登記地址",
        "note": "圖釘是事業單位的商工登記地址，不是職災的發生地點。",
        "exact_n": sum(1 for p in pts if p[3] == 1),
        "total": len(pts),
        "pts": pts,
    }


def check(new: dict) -> int:
    """拿現有的 points.json 當驗收標準，逐筆比對。"""
    if not OUT.exists():
        print("沒有現成的 points.json 可以比對", file=sys.stderr)
        return 2
    old = json.loads(OUT.read_text(encoding="utf-8"))

    bad = 0
    for k in ("schema", "cols", "haz_order", "basis", "note", "exact_n", "total"):
        if old.get(k) != new.get(k):
            print(f"✗ {k}\n    舊 {old.get(k)}\n    新 {new.get(k)}")
            bad += 1
    print(f"{'✓' if bad == 0 else '✗'} 表頭欄位")

    o = {p[0]: p for p in old["pts"]}
    n = {p[0]: p for p in new["pts"]}
    only_old = sorted(set(o) - set(n))
    only_new = sorted(set(n) - set(o))
    print(f"{'✓' if not only_old and not only_new else '✗'} 公司集合"
          f"（舊 {len(o):,}　新 {len(n):,}　只在舊 {len(only_old)}　只在新 {len(only_new)}）")
    for name in only_old[:5]:
        print("    只在舊：", name, o[name][1:])
    for name in only_new[:5]:
        print("    只在新：", name, n[name][1:])

    cols = old["cols"]
    diff = Counter()
    sample: dict[str, list] = defaultdict(list)
    for name in sorted(set(o) & set(n)):
        for i in range(1, len(cols)):
            if o[name][i] != n[name][i]:
                diff[cols[i]] += 1
                if len(sample[cols[i]]) < 3:
                    sample[cols[i]].append((name, o[name][i], n[name][i]))
    if not diff:
        print(f"✓ 逐筆欄位　{len(set(o) & set(n)):,} 家全部一致")
    else:
        for c, k in diff.most_common():
            print(f"✗ {c}　{k:,} 家不一致")
            for s in sample[c]:
                print(f"    {s[0]}　舊 {s[1]}　新 {s[2]}")
        bad += 1
    return 0 if bad == 0 else 1


def main() -> int:
    for p in (RECORDS, ADDR, GEOCODE):
        if not p.exists():
            print(f"缺 {p}", file=sys.stderr)
            return 2
    new = build()
    print(f"點位 {new['total']:,}　門牌級 {new['exact_n']:,}"
          f"（{100 * new['exact_n'] / new['total']:.1f}%）")

    if "--check" in sys.argv:
        return check(new)

    OUT.write_text(json.dumps(new, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print(f"→ {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
