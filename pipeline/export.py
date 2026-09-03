"""把 pipeline 的結果變成前端要的查詢結果。

    python -m pipeline.export --company 某某營造有限公司
    python -m pipeline.export --sample 12      # 產生前端用的去識別化樣本

輸出型別完全照 `web/src/types/contracts.ts` 的 `LookupResult`。
契約是兩個人之間的約定，**這裡不能自己加欄位**。

────────────────────────────────────────────────────────────────
confidence 這個數字要怎麼給才誠實
────────────────────────────────────────────────────────────────
契約的註解寫著「這不是『是同一個人的機率』，是『證據強度』」。這很重要：

    我們沒有辦法算「是同一人的機率」—— 那需要標準答案，
    而公開資料裡沒有身分證字號，標準答案不存在。

所以 confidence 是一個**序數**，由「有幾個獨立佐證」決定，
權重的順序來自實測（2026-09-03，用同地址當獨立量尺）：

    同地址      隨機機率 0.0158%，候選是 274 倍   → 0.40
    姓名罕見    3.24 倍（6.69% vs 2.06%）        → 0.35
    同縣市      1.49 倍（4.54% vs 3.05%）        → 0.25

**只有驗證過的訊號才有權重。** 時間鄰接、產業相同、共同董監事
目前還沒量過，所以它們會出現在證據清單（給人看），但**權重是 0**。
沒有證據就不給權重 —— 這條規則在這個專案已經救過好幾次。

畫面上一定要同時顯示證據清單，不能只顯示數字。
一個 0.75 沒有意義，「同地址＋姓名罕見」才有意義。
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                          # noqa: E402
from pipeline.join import norm_addr, norm_name              # noqa: E402
from pipeline.refine import load_facts                      # noqa: E402

RANKED = Path("data/ranked.csv")
RECORDS = Path("data/records.csv")
DB = Path("data/gcis.duckdb")
SAMPLE_OUT = Path("web/src/data/lookup.sample.json")

# ⚠ 勞動部的查詢系統是 POST，**沒有單筆的永久連結**。
#   所以 source_url 只能給查詢系統的首頁，靠處分字號讓人自己查到那一筆。
#   這是資料來源的限制，不是我們偷懶 —— 文件與簡報都要寫出來。
SOURCE_URL = "https://announcement.mol.gov.tw/"

WEIGHTS = {"same_address": 0.40, "rare_name": 0.35, "same_county": 0.25}
SEVERITY_BY_FINE = ((300_000, "重大"), (50_000, "中度"))


def severity_of(fine, violation: str) -> str:
    """嚴重度。目前用罰鍰級距，但**罰鍰的填寫率因縣市而異**
    （桃園 99.8%、台北市 0%），所以沒有金額時退回看有沒有死傷字樣。
    正式版這一格是語言模型唯一的用途（違法情節分級）。"""
    if fine:
        for threshold, level in SEVERITY_BY_FINE:
            if fine >= threshold:
                return level
        return "輕微"
    if any(k in violation for k in ("死亡", "罹災", "墜落", "感電", "捲夾")):
        return "重大"
    return "輕微"


def mask(name: str) -> str:
    """去識別化。紅線：demo、截圖、影片一律遮罩。"""
    if len(name) <= 1:
        return name
    if len(name) == 2:
        return name[0] + "○"
    return name[0] + "○" * (len(name) - 2) + name[-1]


def mask_company(name: str) -> str:
    return ("○" * min(2, len(name))) + name[2:] if len(name) > 2 else name


def load() -> tuple[dict, dict, dict]:
    with RECORDS.open(encoding="utf-8-sig", newline="") as f:
        records = list(csv.DictReader(f))
    by_company: dict[str, list[dict]] = defaultdict(list)
    principal_of: dict[str, str] = {}
    for r in records:
        c = r.get("company", "").strip()
        if c:
            by_company[c].append(r)
            if r.get("principal"):
                principal_of.setdefault(c, r["principal"])
    with RANKED.open(encoding="utf-8-sig", newline="") as f:
        ranked = list(csv.DictReader(f))
    by_principal: dict[str, list[dict]] = defaultdict(list)
    for g in ranked:
        by_principal[g["principal"]].append(g)
    return by_company, principal_of, by_principal


def violations_of(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        try:
            fine = int(r.get("fine") or 0)
        except ValueError:
            fine = 0
        content = (r.get("violation") or "").strip()
        out.append({
            "date": r.get("disposition_date", ""),
            "law": r.get("law_article") or r.get("law") or "",
            # 處分字號一定要放進來 —— 沒有永久連結，這是唯一能查回原始公告的線索
            "content": f"{content}（處分字號 {r.get('doc_no', '')}）" if content
                       else f"處分字號 {r.get('doc_no', '')}",
            "fine": fine,
            "severity": severity_of(fine, content),
            "appeal": (r.get("remark") or "").strip() or None,
            "source_url": SOURCE_URL,
        })
    out.sort(key=lambda v: v["date"], reverse=True)
    return out


def build(company: str, by_company, principal_of, by_principal,
          facts, addr_users, anonymize=False) -> dict | None:
    rows = by_company.get(company)
    if not rows:
        return None
    fact = facts.get(norm_name(company), {})
    principal = principal_of.get(company, "")

    principals = []
    if principal:
        linked = []
        for g in by_principal.get(principal, []):
            names = g["company_list"].split(" → ")
            tier = g.get("identity_tier", "")
            me = facts.get(norm_name(company), {})
            my_addr = norm_addr(me.get("addr", ""))

            for other in names:
                if other == company:
                    continue
                of = facts.get(norm_name(other), {})

                # ⚠ 證據要**逐一對**算，不能整組共用一份。
                #   三家公司的組裡可能只有其中兩家同地址；
                #   整組共用的話，畫面上會在沒有同地址的那一對底下
                #   寫「兩家公司登記在同一個地址」—— 那是誤導，
                #   而且是會被使用者當真的那種誤導。
                ev, conf = [], 0.0
                other_addr = norm_addr(of.get("addr", ""))
                if (my_addr and my_addr == other_addr
                        and addr_users.get(my_addr, 0) <= 10):
                    ev.append({"kind": "same_address",
                               "detail": f"兩家公司都登記在「{my_addr}」。"
                                         "全國隨機兩家公司同地址的機率是 0.0158%。"})
                    conf += WEIGHTS["same_address"]
                if tier.startswith(("A", "B")):
                    ev.append({"kind": "rare_name",
                               "detail": f"「{mask(principal) if anonymize else principal}」"
                                         "在全國公司負責人裡屬於罕見姓名，"
                                         "同名巧合的機率低於千分之一。"})
                    conf += WEIGHTS["rare_name"]
                if g.get("same_unit") == "1" and g.get("county_only") == "1":
                    ev.append({"kind": "same_county",
                               "detail": f"兩家公司的裁處都出自{g.get('unit', '')}，"
                                         "屬於同一個縣市的管轄範圍。"})
                    conf += WEIGHTS["same_county"]
                ev.append({"kind": "same_name",
                           "detail": "勞動部公告的負責人姓名相同。"
                                     "⚠ 姓名相同不等於同一人，這只是查詢的起點。"})

                linked.append({
                    "tax_id": of.get("id", ""),
                    "name": mask_company(other) if anonymize else other,
                    "status": of.get("status", ""),
                    "established": str(of["established"]) if of.get("established") else None,
                    # ⚠ 契約要的是**日期**，但 entity 表目前只存了狀態字串，
                    #   沒有存「公司狀況日期」。寧可給 null 也不要把
                    #   「解散」這種狀態字塞進日期欄位騙過型別檢查。
                    #   要補的話是改 gcis/load.py 多存一欄。
                    "dissolved": None,
                    "confidence": round(min(1.0, conf), 2),
                    "evidence": ev,
                    "violations": violations_of(by_company.get(other, [])),
                })
        principals.append({
            "name": mask(principal) if anonymize else principal,
            "role": "負責人（勞動部公告）",
            "linked_companies": linked,
        })

    own = violations_of(rows)
    linked_all = [c for p in principals for c in p["linked_companies"]]
    return {
        "query": mask_company(company) if anonymize else company,
        "company": {
            "tax_id": fact.get("id", ""),
            "name": mask_company(company) if anonymize else company,
            "status": fact.get("status", ""),
            "established": str(fact["established"]) if fact.get("established") else None,
            "address": fact.get("addr") or None,
            "own_violations": own,
        },
        "principals": principals,
        "summary": {
            "own_violation_count": len(own),
            "linked_violation_count": sum(len(c["violations"]) for c in linked_all),
            "linked_osha_count": sum(
                1 for c in linked_all for v in c["violations"]
                if "職業安全" in v["law"]),
            "highest_confidence": max((c["confidence"] for c in linked_all),
                                      default=0.0),
        },
    }


def main(argv=None) -> int:
    use_utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--company", help="查一家公司")
    ap.add_argument("--sample", type=int, help="產生前端樣本（去識別化）")
    a = ap.parse_args(argv)
    for p in (RANKED, RECORDS, DB):
        if not p.exists():
            print(f"找不到 {p}", file=sys.stderr)
            return 1
    import duckdb

    by_company, principal_of, by_principal = load()
    wanted = {norm_name(c) for c in by_company}
    con = duckdb.connect(str(DB), read_only=True)
    facts, addr_users = load_facts(con, wanted)
    con.close()

    if a.company:
        r = build(a.company, by_company, principal_of, by_principal,
                  facts, addr_users)
        if not r:
            print(f"查無「{a.company}」的裁處紀錄", file=sys.stderr)
            return 1
        print(json.dumps(r, ensure_ascii=False, indent=2))
        return 0

    n = a.sample or 12
    # 從 A 層的換殼候選抽，那是證據最足的一批
    pool = [g for g in
            (x for xs in by_principal.values() for x in xs)
            if g.get("identity_tier", "").startswith("A")]
    rng = random.Random(20260903)
    rng.shuffle(pool)
    out, seen = [], set()
    for g in pool:
        first = g["company_list"].split(" → ")[0]
        if first in seen:
            continue
        seen.add(first)
        r = build(first, by_company, principal_of, by_principal,
                  facts, addr_users, anonymize=True)
        if r and r["principals"] and r["principals"][0]["linked_companies"]:
            out.append(r)
        if len(out) >= n:
            break

    SAMPLE_OUT.parent.mkdir(parents=True, exist_ok=True)
    SAMPLE_OUT.write_text(json.dumps(
        {"generated_at": "2026-09-03",
         "note": "去識別化樣本。公司名與人名都已遮罩，僅供前端開發與展示。",
         "results": out}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(out)} 筆去識別化樣本 → {SAMPLE_OUT}")
    if out:
        r = out[0]
        print(f"\n範例：{r['query']}")
        print(f"  本身違規 {r['summary']['own_violation_count']} 筆，"
              f"關聯公司違規 {r['summary']['linked_violation_count']} 筆，"
              f"最高證據強度 {r['summary']['highest_confidence']}")
        for c in r["principals"][0]["linked_companies"][:2]:
            print(f"  → {c['name']}（{c['status']}）強度 {c['confidence']}")
            for e in c["evidence"]:
                print(f"      · {e['detail'][:60]}")
    print("\n⚠ confidence 是**證據強度**不是機率。畫面上一定要同時顯示證據清單，")
    print("   只顯示數字會讓使用者以為那是「是同一人的機率」。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
