"""「現在乾淨、但同一個負責人收掉過一家被罰的公司」—— 零裁處新公司的前身。

    python -m tools.clean_successor          # → data/clean_successor.csv
    （pipeline.publish 會讀這份，寫出 web/public/data/zr.json）

輸入：data/records.csv、data/gcis.duckdb

════════════════════════════════════════════════════════════════
為什麼要有這支程式
════════════════════════════════════════════════════════════════
簡報第 3 頁講的情況是：「公司被罰之後歇業，負責人另外開一家 ——
紀錄留在舊公司，新公司在資料上是乾淨的。」

網站原本只把「兩家都有裁處紀錄」的公司連在一起（分片 c/ 只收有紀錄的
事業單位），所以查一家**乾淨的**新公司只會看到「沒有裁處紀錄」。

════════════════════════════════════════════════════════════════
條件（全部都要成立）
════════════════════════════════════════════════════════════════
  舊公司  勞動部有裁處紀錄；商工登記現況為解散／歇業／撤銷／廢止
  新公司  勞動部**零筆**裁處；商工登記仍在營業
  時序    舊公司最後一次裁處年 < 新公司設立年 ≤ 舊公司最後一次裁處年 + 3
          （設立只記到年，同一年分不出先後，寧可不收）
  縣市    兩家商工登記地址的縣市相同
  姓名    新公司在商工登記的代表人（中間字被遮成「_」）與舊公司公告上的
          負責人 mask_match 為 True；而且**舊公司自己在商工登記的代表人也必須是
          同一個遮罩姓名**（沒寫或寫的是別人都排除）
  罕見    全台商工登記裡，代表人登記成這個遮罩姓名的公司 ≤ RARE_LIMIT 家

⚠ 為什麼要「罕見」：零裁處的公司在勞動部資料裡不存在，它的負責人只能從
  商工登記拿，而商工登記把中間字遮掉了。「陳_德」全台有幾百家公司，
  對得上沒有意義；「李_漮」全台只有兩家，對得上就很難說是巧合。
  **這是名稱完全不同的新公司唯一能用的身分線索**，所以門檻要嚴。
⚠ 畫面上「罕見」與「姓名相符」都只算姓名訊號；獨立佐證是同縣市
  （以及剛好同地址時的同地址）。不要把它講得比這更強。
⚠⚠ 同名公司陷阱（2026-10-28 實測踩到）：商工登記裡「朋馳有限公司」有兩家 ——
  一家 1989 年設立、已解散、沒有代表人資料；另一家 2023 年設立、**仍在營業**、
  代表人「李_漮」。勞動部那 3 筆裁處其實是後者的，但用名稱去接商工登記時
  接到了已解散的那一家，於是一個「同時經營兩家公司」的人被算成「收掉再開」。
  所以：舊公司那一筆登記的代表人必須對得上；同名的另一筆登記如果仍在營業、
  代表人也對得上，代表這個人的公司根本沒收掉，整組排除。
⚠ 2026-10-28 第一版用的是「同一個登記地址」。使用者的判斷是：同一個地點
  說明不了什麼，要找的是同一個「人」。所以改成以遮罩姓名的罕見度為主，
  地址只在剛好相同時多列一條佐證。
⚠ 措辭照 SuccessionBox 的紅線：只陳述姓名、縣市與兩個日期，
  不用「換殼」，不推論動機。
"""
from __future__ import annotations

import csv
import io
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                      # noqa: E402
from pipeline.join import mask_match, norm_addr, norm_name                    # noqa: E402
from tools.succession import CLOSED, roc_to_ad                           # noqa: E402

RECORDS = Path("data/records.csv")
DB = Path("data/gcis.duckdb")
OUT = Path("data/clean_successor.csv")
ACTIVE = ("核准設立", "核准登記", "核准報備")
RARE_LIMIT = 5          # 全台代表人登記成這個遮罩姓名的公司最多幾家
MAX_GAP = 3             # 新公司最晚在舊公司最後一次裁處後幾年內設立
FIELDS = ["new_norm", "new_name", "new_est", "new_status", "rep_masked", "rep_count",
          "old_rep_same", "county", "old_norm", "old_name", "old_status", "old_last",
          "old_n", "principal", "same_address", "old_tax_id"]


def load_records() -> dict[str, dict]:
    """每家有紀錄的公司：顯示名、最常見的負責人寫法、筆數、最後一次裁處年。"""
    s: dict[str, dict] = {}
    with RECORDS.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            k = norm_name(r["company"])
            if not k:
                continue
            d = s.setdefault(k, {"name": r["company"].strip(), "p": Counter(), "n": 0, "last": 0})
            if r["principal"]:
                d["p"][r["principal"].strip()] += 1
            d["n"] += 1
            y = roc_to_ad(r.get("disposition_date", "")) or 0
            d["last"] = max(d["last"], y)
    return s


def main() -> int:
    use_utf8_stdout()
    for p in (RECORDS, DB):
        if not p.exists():
            print(f"⚠ 找不到 {p}", file=sys.stderr)
            return 1
    import duckdb
    import pandas as pd

    recs = load_records()
    # ⚠ 負責人取「最常見的寫法」，平手時取字串小的 —— 跑兩次要得到一樣的結果。
    old = pd.DataFrame(
        sorted((k, sorted(d["p"].items(), key=lambda x: (-x[1], x[0]))[0][0], d["last"])
               for k, d in recs.items() if d["p"] and d["last"]),
        columns=["name_norm", "principal", "last_year"])
    con = duckdb.connect(str(DB), read_only=True)
    con.register("old", old)
    closed = ",".join("'" + s + "'" for s in sorted(CLOSED))
    active = ",".join("'" + s + "'" for s in ACTIVE)
    # SQL 只做粗篩（同縣市、姓名長度與頭尾字相同、罕見、時序），精確的遮罩比對在 Python 做。
    rows = con.execute(f"""
      WITH repf AS (SELECT rep_masked, count(*) AS c FROM entity
                    WHERE rep_masked <> '' GROUP BY 1),
      o AS (
        SELECT o.name_norm, o.principal, o.last_year, e.status AS ost, e.address AS oaddr,
               coalesce(e.rep_masked, '') AS orep, e.id AS oid,
               replace(substr(e.address,1,3),'臺','台') AS cty
        FROM old o JOIN entity e USING(name_norm) WHERE e.status IN ({closed})
      ),
      n AS (
        SELECT name_norm, name, rep_masked, established, status, address,
               replace(substr(address,1,3),'臺','台') AS cty
        FROM entity WHERE status IN ({active}) AND rep_masked <> ''
      )
      SELECT o.name_norm, o.principal, o.last_year, o.ost, o.oaddr, o.orep, o.cty,
             n.name_norm, n.name, n.rep_masked, n.established, n.status, n.address, repf.c,
             o.oid, (SELECT count(*) FROM entity x WHERE x.name_norm = n.name_norm) AS n_same
      FROM o JOIN n ON n.cty = o.cty
                   AND length(n.rep_masked) = length(o.principal)
                   AND left(n.rep_masked,1) = left(o.principal,1)
                   AND right(n.rep_masked,1) = right(o.principal,1)
      JOIN repf ON repf.rep_masked = n.rep_masked
      WHERE n.name_norm <> o.name_norm
        AND n.established > o.last_year AND n.established <= o.last_year + {MAX_GAP}
        AND repf.c <= {RARE_LIMIT}
    """).fetchall()
    # 同名公司陷阱：同一個名稱在商工登記裡另有一筆**營業中**、代表人也對得上的登記。
    cand_old = sorted({r[0] for r in rows})
    con.register("co", pd.DataFrame(cand_old, columns=["name_norm"]))
    live = con.execute(f"""
      SELECT e.name_norm, e.rep_masked FROM co JOIN entity e USING(name_norm)
      WHERE e.status IN ({active}) AND coalesce(e.rep_masked,'') <> ''
    """).fetchall()
    con.close()
    prin = {r[0]: r[1] for r in rows}
    still_open = {nm for nm, rp in live if mask_match(rp, prin[nm]) is True}

    hits = []
    for on, p, ly, ost, oaddr, orep, cty, nn, nname, rep, est, st, naddr, repc, oid, n_same in rows:
        if n_same > 1:
            # ⚠ 新公司的名稱在商工登記有同名多筆：查無裁處那一頁的現況與設立年來自
            #   pipeline/registry.py 的索引，不一定是這一筆，畫面會跟下面的時序對不上。
            continue
        if nn in recs:                                   # 新公司有紀錄 → 走原本那條路
            continue
        if mask_match(rep, p) is not True:
            continue
        if orep != rep:                                  # 舊公司那筆登記的代表人不是他（或沒寫）→ 排除
            continue
        if on in still_open:                             # 同名的另一筆登記仍在營業、代表人也是他 → 沒收掉
            continue
        a, b = norm_addr(oaddr), norm_addr(naddr)
        hits.append({"new_norm": nn, "new_name": nname, "new_est": int(est), "new_status": st,
                     "rep_masked": rep, "rep_count": int(repc), "old_rep_same": int(orep == rep),
                     "county": (oaddr or "")[:3], "old_norm": on, "old_name": recs[on]["name"],
                     "old_status": ost, "old_last": int(ly), "old_n": recs[on]["n"],
                     "principal": p, "same_address": a if a and a == b else "",
                     "old_tax_id": str(oid or "")})
    hits.sort(key=lambda h: (h["new_norm"], h["old_norm"]))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(hits)
    print(f"粗篩 {len(rows):,} 列 → 符合全部條件 {len(hits):,} 組，"
          f"{len({h['new_norm'] for h in hits}):,} 家新公司 → {OUT}")
    print(f"  全台只有這兩家公司登記這個遮罩姓名：{sum(h['rep_count'] == 2 and h['old_rep_same'] for h in hits):,} 組")
    print(f"  剛好也同地址：{sum(bool(h['same_address']) for h in hits):,} 組")
    print("⚠ 姓名相符與罕見只算姓名訊號；獨立佐證是同縣市（同地址時再加一項）。")
    return 0


def write_json(out_dir: Path, src: Path = OUT) -> int:
    """給 pipeline.publish 呼叫：data/clean_successor.csv → <out_dir>/zr.json。

    格式：{ 新公司正規化名: [[舊公司名, 舊公司現況, 舊公司最後裁處年, 新公司設立年,
                              縣市, 商工登記代表人(遮罩), 公告負責人, 全台幾家登記此遮罩姓名,
                              舊公司登記的代表人也是此遮罩姓名(0/1), 同地址時的地址(否則空字串),
                              舊公司統編], ...] }
    ⚠ 舊公司的現況與統編用這裡的（已核對過代表人的那一筆），不要用分片裡的 ——
      分片的商工登記事實是另一套挑法，同名公司時可能是別家。
    ⚠ 欄位順序改了要同時改 web/src/lib/lookup.ts 的 ZrRow。
    """
    if not src.exists():
        return 0
    zr: dict[str, list] = {}
    with src.open(encoding="utf-8-sig", newline="") as f:
        for h in csv.DictReader(f):
            zr.setdefault(h["new_norm"], []).append(
                [h["old_name"], h["old_status"], int(h["old_last"]), int(h["new_est"]),
                 h["county"], h["rep_masked"], h["principal"], int(h["rep_count"]),
                 int(h["old_rep_same"]), h["same_address"],
                 # ⚠ 統編補回 8 碼（快照裡開頭的 0 被吃掉了，見 pipeline/refine.py）
                 (h["old_tax_id"].zfill(8) if h["old_tax_id"].isdigit() else h["old_tax_id"])])
    (out_dir / "zr.json").write_text(
        json.dumps(zr, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return len(zr)


if __name__ == "__main__":
    sys.exit(main())
