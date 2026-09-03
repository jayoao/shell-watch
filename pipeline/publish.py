"""把全部查詢結果切成靜態分片，讓前端不需要後端就能查任何一家公司。

    python -m pipeline.publish

────────────────────────────────────────────────────────────────
為什麼是靜態分片，不是 API
────────────────────────────────────────────────────────────────
查詢頁在這之前只能查 12 筆去識別化樣本。那不是產品，是簡報用的假畫面。

實測（2026-09-03）：
    有裁處紀錄的公司   175,988 家
    裁處紀錄           633,846 筆
    全部序列化         229 MB，gzip 後 34 MB

34 MB 切 512 片，一片約 68 KB —— **一次查詢只下載一片**。
所以不需要資料庫、不需要伺服器、不需要付錢，
而且 demo 當天不會因為後端掛掉而開天窗。

考慮過 duckdb-wasm / sql.js-httpvfs（用 HTTP range 查遠端 SQLite），
程式碼會少一點，但多一個執行期相依。比賽現場的可靠度比程式碼行數重要。

────────────────────────────────────────────────────────────────
分片怎麼找：兩邊算同一個雜湊，不需要索引檔
────────────────────────────────────────────────────────────────
公司名正規化後算 FNV-1a，對 512 取餘數就是分片編號。
前端用同一個演算法算，直接 fetch `/data/c/{n}.json` —— **不需要索引檔**。
索引 175,988 個公司名本身就要好幾 MB，那才是真正的成本。

⚠ 這裡的 fnv1a() 和 web/src/lib/lookup.ts 的 fnv1a() **必須永遠一致**。
   改了一邊沒改另一邊，症狀是「有些公司查不到」而不是報錯 ——
   那種 bug 沒有測試會找很久。tests/test_publish.py 有跨語言的對拍。

────────────────────────────────────────────────────────────────
產出不進 git
────────────────────────────────────────────────────────────────
`web/public/data/` 在 .gitignore 裡。原因：
  · 229 MB 的產生物進 git，每次重新產生就是一次全量改寫，歷史會爆掉
  · 它是**衍生資料**，來源是 data/records.csv 和 data/ranked.csv，
    那兩個本來就沒進 git（裡面有真實姓名）

部署方式是本機產生、直接上傳（Cloudflare Pages 的 direct upload），
不走 git。文件要寫清楚，不然接手的人會找不到資料在哪。
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                   # noqa: E402
from pipeline.export import (HAZARDS, SOURCE_URL, WEIGHTS, appeal_of,  # noqa: E402
                             hazards_of, severity_of)
from pipeline.hazard import is_fatal                                 # noqa: E402
from pipeline.join import norm_addr, norm_name                       # noqa: E402
from pipeline.refine import load_facts                               # noqa: E402

RECORDS = Path("data/records.csv")
RANKED = Path("data/ranked.csv")
DB = Path("data/gcis.duckdb")
OUT = Path("web/public/data")

# 512 片的話平均一片 450 KB（gzip 後 ~70 KB），但**最大的那片**會拖到 2 MB 以上
# —— 有公司單獨就有 537 筆裁處。2048 片平均降到 112 KB（gzip 後 ~18 KB），
# 檔案數仍遠低於 Cloudflare Pages 的 20,000 上限。
# ⚠ 改這個數字要重新產生全部分片，前端會從 meta.json 讀，不用改程式。
SHARDS = 2048
SHARED_ADDR_LIMIT = 10          # 跟 join.py 同一個門檻：會計師事務所、商務中心


def fnv1a(s: str) -> int:
    """FNV-1a 32 位元。

    ⚠ 前端 web/src/lib/lookup.ts 有一份一模一樣的實作。
      選 FNV-1a 是因為它短到兩邊都不可能寫錯，而且沒有平台差異
      （Python 的內建 hash() 有 PYTHONHASHSEED，每次執行都不一樣，不能用）。
    """
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return h


def shard_of(company: str) -> int:
    return fnv1a(norm_name(company)) % SHARDS


# ── 核心名別名 ──────────────────────────────────────────────
# 沒有這一層，使用者必須一字不差打出「一允企業有限公司」才查得到。
# 現場沒有人會這樣打，他們會打「一允企業」，然後以為系統壞了。
#
# ⚠ 只砍**結尾的組織型態字尾**，而且是保守的清單。
#   砍太多會把不同公司併成同一個核心名（「大同」之類），
#   那不是查不到，是**查到別人**，比查不到嚴重。
#   所以核心名對應的是一份清單，撞名時前端要讓使用者自己選。
_ORG_TAIL = re.compile(
    r"(股份有限公司|有限公司|股份公司|企業社|實業社|商號|商行|工程行)$")


def core_name(company: str) -> str:
    """去掉組織型態字尾的核心名。砍不掉或砍完太短就回空字串。"""
    t = _ORG_TAIL.sub("", norm_name(company))
    return t if len(t) >= 2 and t != norm_name(company) else ""


def compact_violation(r: dict) -> list:
    """一筆裁處壓成陣列。

    用陣列不用物件，是因為 633,846 筆 × 8 個鍵名 ≈ 30 MB 純粹的鍵名字串。
    前端 lookup.ts 會把它還原成契約裡的 ViolationRef。
    ⚠ 欄位順序就是契約，改順序要同時改前端，而且要改 SCHEMA 版本。
    """
    try:
        fine = int(r.get("fine") or 0)
    except ValueError:
        fine = 0
    content = (r.get("violation") or "").strip()
    law = r.get("law_article") or r.get("law") or ""
    return [
        r.get("disposition_date", ""),
        law,
        content,
        fine,
        severity_of(fine, content),
        appeal_of(r.get("remark", "")),
        r.get("doc_no", ""),
        [h["code"] for h in hazards_of(r.get("law") or "", content)],
        1 if is_fatal(content) else 0,
    ]


def evidence_for(company: str, other: str, group: dict,
                 facts: dict, addr_users: dict) -> tuple[float, list]:
    """一對公司之間的證據與強度。

    ⚠ 逐一對計算，不是整組共用。三家公司的組裡可能只有其中兩家同地址；
      整組共用的話，畫面上會在沒有同地址的那一對底下寫
      「兩家公司登記在同一個地址」—— 那是會被使用者當真的誤導。
      （這個 bug 在 export.py 犯過一次，這裡不要再犯。）
    """
    me = facts.get(norm_name(company), {})
    of = facts.get(norm_name(other), {})
    my_addr = norm_addr(me.get("addr", ""))
    other_addr = norm_addr(of.get("addr", ""))
    tier = group.get("identity_tier", "")

    ev, conf = [], 0.0
    if my_addr and my_addr == other_addr and addr_users.get(my_addr, 0) <= SHARED_ADDR_LIMIT:
        ev.append(["same_address",
                   f"兩家公司都登記在「{my_addr}」。"
                   "全國隨機兩家公司同地址的機率是 0.0158%。"])
        conf += WEIGHTS["same_address"]
    if tier.startswith(("A", "B")):
        ev.append(["rare_name",
                   f"「{group['principal']}」在全國公司負責人裡屬於罕見姓名，"
                   "同名巧合的機率低於千分之一。"])
        conf += WEIGHTS["rare_name"]
    if group.get("same_unit") == "1" and group.get("county_only") == "1":
        ev.append(["same_county",
                   f"兩家公司的裁處都出自{group.get('unit', '')}，"
                   "屬於同一個縣市的管轄範圍。"])
        conf += WEIGHTS["same_county"]
    ev.append(["same_name",
               "勞動部公告的負責人姓名相同。"
               "⚠ 姓名相同不等於同一人，這只是查詢的起點。"])
    return round(min(1.0, conf), 2), ev


def merge_entry(prev: dict, new: dict) -> None:
    """兩個公司名正規化成同一個 key 時，把資料**合併**而不是覆蓋。

    ⚠ 這裡原本寫成 `bucket[key] = entry`，直接覆蓋。
      實測 90 組 key 撞在一起（180 個公司名），全部都是同一家公司的
      兩種寫法 —— 「臺南紡織」與「台南紡織」、全形空白多一個之類。
      覆蓋的結果是前面那個寫法的裁處紀錄**整批消失**，
      而且畫面上不會有任何異狀：使用者查到的是「這家公司只有 3 筆」，
      真相是 8 筆。查詢系統少報違規紀錄，是這個專案最不能犯的錯。

    顯示用的名稱取紀錄比較多的那個寫法 —— 那通常是主管機關慣用的寫法。
    """
    if len(new["v"]) > len(prev["v"]):
        prev["n"] = new["n"]
    prev["v"].extend(new["v"])
    for k in ("t", "s", "e", "a", "p"):
        if not prev.get(k) and new.get(k):
            prev[k] = new[k]
    if new.get("l"):
        by_name = {x[0]: x for x in prev.get("l", [])}
        for item in new["l"]:
            cur = by_name.get(item[0])
            # 撞到同一家關聯公司時留強度高的那一組證據
            if cur is None or item[1] > cur[1]:
                by_name[item[0]] = item
        prev["l"] = sorted(by_name.values(), key=lambda x: -x[1])


def main(argv=None) -> int:
    use_utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, help="只處理前 N 家（測試用）")
    ap.add_argument("--out", type=Path, default=OUT,
                    help="輸出目錄（測試用，預設 web/public/data）")
    a = ap.parse_args(argv)
    for p in (RECORDS, RANKED, DB):
        if not p.exists():
            print(f"找不到 {p}", file=sys.stderr)
            return 1
    t0 = time.time()

    # ── 1. 裁處紀錄依公司分組 ────────────────────────────────
    by_company: dict[str, list] = defaultdict(list)
    principal_of: dict[str, str] = {}
    with RECORDS.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            c = (r.get("company") or "").strip()
            if not c:
                continue
            by_company[c].append(compact_violation(r))
            if r.get("principal"):
                principal_of.setdefault(c, r["principal"])
    print(f"裁處紀錄依公司分組　{len(by_company):,} 家　"
          f"{sum(len(v) for v in by_company.values()):,} 筆　"
          f"（{time.time() - t0:.0f} 秒）")

    # ── 2. 商工登記事實 ──────────────────────────────────────
    import duckdb
    con = duckdb.connect(str(DB), read_only=True)
    facts, addr_users = load_facts(con, {norm_name(c) for c in by_company})
    con.close()
    print(f"商工登記對到　{len(facts):,} 家　"
          f"（{100 * len(facts) / len(by_company):.1f}%）")

    # ── 3. 換殼組 ────────────────────────────────────────────
    groups_of: dict[str, list[dict]] = defaultdict(list)
    with RANKED.open(encoding="utf-8-sig", newline="") as f:
        for g in csv.DictReader(f):
            for c in g["company_list"].split(" → "):
                groups_of[c].append(g)
    print(f"換殼組涵蓋　{len(groups_of):,} 家")

    # ── 4. 切片 ──────────────────────────────────────────────
    # e = 完整名稱 → 資料；a = 核心名 → 完整名稱清單
    shards: list[dict] = [{"e": {}, "a": {}} for _ in range(SHARDS)]
    names = sorted(by_company)
    merged = 0
    if a.limit:
        names = names[:a.limit]
    for company in names:
        fact = facts.get(norm_name(company), {})
        entry = {
            "n": company,
            "t": fact.get("id", ""),
            "s": fact.get("status", ""),
            "e": str(fact["established"]) if fact.get("established") else None,
            "a": fact.get("addr") or None,
            "v": by_company[company],
        }
        principal = principal_of.get(company, "")
        linked = []
        seen = set()
        for g in groups_of.get(company, []):
            for other in g["company_list"].split(" → "):
                if other == company or other in seen:
                    continue
                seen.add(other)
                conf, ev = evidence_for(company, other, g, facts, addr_users)
                linked.append([other, conf, ev])
        if principal:
            entry["p"] = principal
        if linked:
            # 強度高的排前面 —— 前端不必再排一次
            entry["l"] = sorted(linked, key=lambda x: -x[1])
        bucket = shards[shard_of(company)]["e"]
        key = norm_name(company)
        prev = bucket.get(key)
        if prev is None:
            bucket[key] = entry
        else:
            merge_entry(prev, entry)
            merged += 1
        core = core_name(company)
        if core:
            shards[fnv1a(core) % SHARDS]["a"].setdefault(core, []).append(company)

    # ── 5. 寫檔 ──────────────────────────────────────────────
    out = a.out
    cdir = out / "c"
    if cdir.exists():
        # ⚠ 舊分片不清掉，改名或消失的公司會查到殭屍資料。
        #   清不掉就直接失敗 —— 安靜地沿用舊檔比報錯危險得多。
        try:
            shutil.rmtree(cdir)
        except OSError as e:
            print(f"清不掉舊的 {cdir}：{e}\n"
                  f"請手動刪除該目錄後重跑（沿用舊分片會查到過期資料）。",
                  file=sys.stderr)
            return 1
    cdir.mkdir(parents=True, exist_ok=True)
    total = 0
    sizes = []
    for i, sh in enumerate(shards):
        body = json.dumps(sh, ensure_ascii=False, separators=(",", ":"))
        (cdir / f"{i}.json").write_text(body, encoding="utf-8")
        sizes.append(len(body.encode()))
        total += len(sh["e"])

    (out / "hazards.json").write_text(json.dumps(
        {code: {"name": name, "duty": duty} for code, name, _p, duty in HAZARDS},
        ensure_ascii=False, indent=1), encoding="utf-8")

    # ⚠ 跨語言的雜湊對拍。前端載入時會驗這幾組；對不上就是
    #   fnv1a() 或 norm_name() 有一邊被改過。那種 bug 的症狀是
    #   「有些公司查不到」而不是報錯，沒有這個檢查會找很久。
    #   用真實公司名而不是固定字串，因為要連 norm_name 一起驗
    #   （臺→台、全形括號、全形空白都在真實資料裡出現過）。
    step = max(1, len(names) // 6)
    check = {c: shard_of(c) for c in names[::step][:6]}

    (out / "meta.json").write_text(json.dumps({
        "schema": 1,
        "hash_check": check,
        "generated_at": time.strftime("%Y-%m-%d"),
        "shards": SHARDS,
        "companies": total,
        "violations": sum(len(v) for v in by_company.values()),
        "source": "勞動部違反勞動法令事業單位（雇主）查詢系統、經濟部商工登記公示資料",
        "source_url": SOURCE_URL,
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    ambiguous = sum(1 for sh in shards for v in sh["a"].values() if len(v) > 1)
    aliases = sum(len(sh["a"]) for sh in shards)
    mb = sum(sizes) / 1024 / 1024
    print(f"\n{total:,} 家寫進 {SHARDS} 個分片　共 {mb:.0f} MB")
    if merged:
        print(f"  其中 {merged} 個公司名正規化後與另一個相同（臺／台、全形空白之類），"
              f"已**合併**紀錄而非覆蓋")
    print(f"  核心名別名 {aliases:,} 個，其中 {ambiguous:,} 個對到多家公司"
          f"（{100 * ambiguous / aliases:.1f}%，前端會讓使用者選）"
          if aliases else "  沒有核心名別名")
    print(f"  每片 {min(sizes) / 1024:.0f}–{max(sizes) / 1024:.0f} KB，"
          f"平均 {sum(sizes) / len(sizes) / 1024:.0f} KB")
    print(f"  → {cdir}（不進 git，部署時直接上傳）")
    print(f"\n共 {time.time() - t0:.0f} 秒")
    print("""
⚠ 這裡的公司名與負責人姓名是**真實資料**。
   截圖、影片、簡報一律改用 `python -m pipeline.export --sample 12`
   產生的去識別化樣本，不要用這份。""")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
