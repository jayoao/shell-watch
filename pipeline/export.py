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
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                          # noqa: E402
from pipeline.hazard import HAZARDS, classify, is_fatal     # noqa: E402
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

# 危害型態 → 名稱與法規義務。來源是 pipeline/hazard.py，不在這裡重寫一份。
_HAZ = {code: (name, duty) for code, name, _pat, duty in HAZARDS}


def hazards_of(law: str, violation: str) -> list[dict]:
    """只對職安法歸類。其他法規（勞基法、性平法…）的危害型態是另一套，
    現在沒有規則就不要硬歸 —— 回空陣列，UI 那邊寫「未指明」。"""
    if "職業安全衛生" not in (law or ""):
        return []
    return [{"code": c, "name": _HAZ[c][0], "duty": _HAZ[c][1]}
            for c in classify(violation)]


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


# ⚠ 備註欄是個大雜燴。實測 14,039 筆非空值分成 557 種，其中：
#       '0'            7,672 筆  ← 佔位值，不是資料
#       '訴願駁回'      1,325 筆
#       '職業災害'        613 筆  ← 跟訴願無關
#       '行政救濟中'      494 筆  ← **本案尚未確定**
#       '訴願中'          214 筆  ← **本案尚未確定**
#   把整個備註直接塞進 appeal 欄位，畫面上會出現「訴願：0」這種東西 ——
#   訴願有沒有進行是法律上有意義的資訊，顯示一個「0」是雜訊，
#   而且會讓人以為那是某種結果。只認訴願／行政救濟相關的字樣。
_APPEAL_SETTLED = ("駁回", "不受理", "原處分維持")
_APPEAL_PENDING = ("訴願中", "行政救濟中", "提起訴願", "訴訟中", "審理中")


def appeal_of(remark: str) -> str | None:
    """備註 → 訴願狀態。認不出來的一律回 None，不要硬塞。

    回傳的字串會直接顯示在畫面上，所以要寫成完整、不會被誤讀的句子。
    ⚠ 「尚未確定」的案子一定要標出來 —— 那是紅線，不是體貼。
    """
    t = (remark or "").strip()
    if not t or t == "0" or t.isdigit():
        return None
    if any(k in t for k in _APPEAL_PENDING):
        return f"{t}（本案尚未確定）"
    if "訴願" in t and any(k in t for k in _APPEAL_SETTLED):
        # 已經寫了「原處分維持」就不要再加一次
        return t if "原處分維持" in t else f"{t}（原處分維持）"
    if "訴願" in t:
        return t
    return None          # 「職業災害」「專案檢查」這些不是訴願，不放這一欄


def mask(name: str) -> str:
    """去識別化。紅線：demo、截圖、影片一律遮罩。"""
    if len(name) <= 1:
        return name
    if len(name) == 2:
        return name[0] + "○"
    return name[0] + "○" * (len(name) - 2) + name[-1]


def mask_addr(addr: str) -> str:
    """去識別化樣本裡的地址。

    ⚠ 這個補丁的由來：原本的「去識別化」只遮公司名與人名，
      **統一編號和完整門牌原封不動留在 web/src/data/lookup.sample.json**，
      而那個檔案是進 git 的。統編一查商工登記就是公司全名和負責人本名，
      門牌也一樣 —— 遮名字等於沒遮，而且更糟：
      檔案上寫著「已去識別化」，等於給了一個假的安全感。

      商工登記是公開資料，這些欄位本身不是秘密。問題在於我們把
      「這家公司的負責人涉嫌換殼」這個**本系統明確拒絕做的認定**，
      跟一個可以直接查到人的鍵值放在同一個檔案裡。

    留到路名為止，門牌號之後全部遮掉：
      · 「同地址」這個證據的說服力還在（看得出是同一條路）
      · 但拿不到可以回查商工登記的鍵值

    ⚠ 必須是**決定性**的：同一個輸入永遠得到同一個輸出，
      否則同組公司的地址會遮成不一樣，畫面上自相矛盾。
    """
    if not addr:
        return addr
    m = re.search(r"[路街道]", addr)
    if m:
        return addr[:m.end()] + "○○○"
    # 沒有路名（例如「○○鄉○○村」）就只留到縣市區鄉鎮
    m = re.search(r"[區鄉鎮市]", addr[3:])
    return addr[:3 + m.end()] + "○○○" if m else "○○○"


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


def mask_doc_no(doc_no: str) -> str:
    """處分字號在遮罩模式也要遮。

    ⚠ 這跟「每一筆都要能查回官方公告」不衝突 ——
      那條紅線管的是**正式產品**：使用者查的是真公司，就要給真字號。
      這裡是 demo 樣本，公司名已經遮掉了，字號留著等於留一把鑰匙：
      在勞動部查詢系統輸入字號，公司全名和負責人本名就出來了。
      遮了名字卻留字號，遮罩只是做給自己看的。
    """
    t = (doc_no or "").strip()
    if not t:
        return t
    m = re.search(r"[0-9０-９]", t)
    return (t[:m.start()] + "○" * 6 + "號") if m else t


def violations_of(rows: list[dict], anonymize: bool = False) -> list[dict]:
    out = []
    for r in rows:
        try:
            fine = int(r.get("fine") or 0)
        except ValueError:
            fine = 0
        content = (r.get("violation") or "").strip()
        doc = mask_doc_no(r.get("doc_no", "")) if anonymize else r.get("doc_no", "")
        out.append({
            "date": r.get("disposition_date", ""),
            "law": r.get("law_article") or r.get("law") or "",
            # 處分字號一定要放進來 —— 沒有永久連結，這是唯一能查回原始公告的線索
            "content": f"{content}（處分字號 {doc}）" if content
                       else f"處分字號 {doc}",
            "fine": fine,
            "severity": severity_of(fine, content),
            "appeal": appeal_of(r.get("remark", "")),
            "source_url": SOURCE_URL,
            "hazards": hazards_of(r.get("law") or "", content),
            # ⚠ 這是「公告文字提到死亡災害」，不是「造成死亡」。
            #   UI 的措辭已經配合這一點寫死，不要在別處改寫。
            "fatal": is_fatal(content),
        })
    out.sort(key=lambda v: v["date"], reverse=True)
    return out


def _summarise_hazards(own: list[dict], linked: list[dict]) -> list[dict]:
    """把本公司＋所有關聯公司的危害型態合併計數。

    ⚠ 這個清單會被讀成「在這個人底下工作要注意什麼」，所以：
      · 「未指明的設備措施不足」不排除 —— 它是最常見的一類，
        藏起來反而讓數字對不上。
      · 一筆公告可能同時屬於多類，所以各類加總會大於公告筆數，
        UI 不要拿它當分母。
    """
    from collections import Counter
    c: Counter = Counter()
    names: dict[str, str] = {}
    for v in own + [x for co in linked for x in co["violations"]]:
        for h in v.get("hazards", []):
            c[h["code"]] += 1
            names[h["code"]] = h["name"]
    return [{"code": k, "name": names[k], "count": n} for k, n in c.most_common()]


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
                               "detail": f"兩家公司都登記在"
                                         f"「{mask_addr(my_addr) if anonymize else my_addr}」。"
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
                    # ⚠ 統編是回查商工登記的鍵值，遮罩模式一定要拿掉
                    "tax_id": "" if anonymize else of.get("id", ""),
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
                    "violations": violations_of(by_company.get(other, []), anonymize),
                })
        principals.append({
            "name": mask(principal) if anonymize else principal,
            "role": "負責人（勞動部公告）",
            "linked_companies": linked,
        })

    own = violations_of(rows, anonymize)
    linked_all = [c for p in principals for c in p["linked_companies"]]
    return {
        "query": mask_company(company) if anonymize else company,
        "company": {
            "tax_id": "" if anonymize else fact.get("id", ""),
            "name": mask_company(company) if anonymize else company,
            "status": fact.get("status", ""),
            "established": str(fact["established"]) if fact.get("established") else None,
            "address": (mask_addr(fact["addr"]) if anonymize else fact["addr"]) \
                       if fact.get("addr") else None,
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
            # 防災：這個負責人名下（含本公司）被罰過哪幾種危害，多到少。
            "hazards": _summarise_hazards(own, linked_all),
            "fatal_count": (sum(1 for v in own if v["fatal"])
                            + sum(1 for c in linked_all
                                  for v in c["violations"] if v["fatal"])),
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
         "note": "去識別化樣本，僅供前端開發與展示。"
                 "公司名、人名、統一編號、門牌號皆已遮罩；"
                 "保留縣市與路名，是為了讓「同地址」這項證據看得出來。"
                 "處分字號亦已遮罩（它在勞動部查詢系統可直接查回公司名）。"
                 "裁處日期、罰鍰金額與違規內容為真實公告內容。",
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
