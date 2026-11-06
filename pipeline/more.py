"""四份新資料 → 前端分片（crawler/more.py 抓的原檔）。

    python -m pipeline.more

輸出（都不進 git，部署時直接上傳）：
  web/public/data/pv/{0..255}.json   正規化法人名稱 → 工作守則備查（w）、人才發展獎項（a）
  web/public/data/tq/{0..63}.json    統一編號 → TTQS 效期內評核
  web/public/data/more.json          分片數與各資料的筆數、日期

⚠ 只**新增**這三樣，不碰 c/、g/、rp/、dq/、ls/、meta.json、extra.json ——
  資料凍結期間（2026-10-30 起）加這四份資料時，原本的資料一個 byte 都不變。

────────────────────────────────────────────────────────────────
⚠⚠ 規則（理由見 crawler/more.py 開頭）
────────────────────────────────────────────────────────────────
TTQS 有統編 → 只用統編對（tq/ 以統編為鍵）。
其餘只用 norm_name(legal_name(原始全名)) 完全相同；原始全名一定要留著顯示
（「○○公司台中分公司」的工作守則不是整家公司的）。
工作守則只能顯示「有」，不能顯示「無」—— 跟安衛人員備查同一條。
"""
from __future__ import annotations

import glob
import json
import re
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                    # noqa: E402
from pipeline.credential import legal_name                            # noqa: E402
from pipeline.join import norm_name                                   # noqa: E402
from pipeline.publish import fnv1a                                    # noqa: E402

SRC = Path("data/moldata")
SITE = Path("web/public/data/c")
OUT = Path("web/public/data")
PV_SHARDS = 256
TQ_SHARDS = 64
WR_SITES = 20          # 一家公司最多列幾個場所（其餘只給總數）


def rows_of(key: str) -> list[dict]:
    man_p = SRC / key / "manifest.json"
    if not man_p.exists():
        print(f"⚠ 沒有 {man_p}（跑 部署工具\\fetch_more.bat）")
        return []
    out = []
    for m in json.loads(man_p.read_text(encoding="utf-8")):
        data = json.loads((SRC / key / m["file"]).read_text(encoding="utf-8-sig"))
        if isinstance(data, dict):
            data = (data.get("result") or {}).get("records") or data.get("records") or data.get("data") or []
        for r in data:
            if isinstance(r, dict):
                out.append({str(k).strip(): (v.strip() if isinstance(v, str) else v) for k, v in r.items()}
                           | {"_desc": m.get("desc", "")})
    return out


def to_int(s) -> int:
    t = re.sub(r"[^\d]", "", str(s or ""))
    return int(t) if t else 0


def site_names() -> tuple[set[str], set[str]]:
    """網站上有裁處紀錄的公司：正規化名稱、統一編號（8 碼）。"""
    names: set[str] = set()
    taxes: set[str] = set()
    for f in glob.glob(str(SITE / "*.json")):
        for k, e in json.loads(Path(f).read_text(encoding="utf-8"))["e"].items():
            names.add(norm_name(e.get("n") or k))
            if e.get("t"):
                taxes.add(str(e["t"]).zfill(8))
    return names, taxes


def build_workrule(names: set[str]) -> tuple[dict, dict]:
    rows = rows_of("workrule")
    # 同一個場所會報備很多次（修訂工作守則就再報一次），只留最新的一次。
    latest: dict[str, int] = {}
    for r in rows:
        raw = (r.get("事業單位名稱（工程名稱）") or "").strip()
        if not raw:
            continue
        filed = to_int(r.get("登錄日期"))
        if filed > latest.get(raw, -1):
            latest[raw] = filed
    by: dict[str, list] = defaultdict(list)
    for raw, filed in latest.items():
        k = norm_name(legal_name(raw))
        if k in names:                 # 只留網站上查得到的公司，其餘用不到
            by[k].append((raw, filed))
    out = {}
    for k, lst in by.items():
        lst.sort(key=lambda x: (-x[1], x[0]))
        out[k] = {
            "n": len(lst),
            "l": lst[0][1],
            # 公司本身（原始全名正規化後就是公司名）有沒有一筆
            "o": 1 if any(norm_name(raw) == k for raw, _ in lst) else 0,
            "s": [[raw, filed] for raw, filed in lst[:WR_SITES]],
        }
    stats = {"wr_rows": len(rows), "wr_units": len(latest), "wr_companies": len(out),
             "wr_sites": sum(v["n"] for v in out.values())}
    print(f"工作守則備查　{len(rows):,} 列 → {len(latest):,} 個場所 → 對上 {len(out):,} 家公司"
          f"（{stats['wr_sites']:,} 個場所）")
    return out, stats


def build_awards() -> tuple[dict, dict]:
    out: dict[str, list] = defaultdict(list)
    n = {"ntda": 0, "ntqa": 0}
    for r in rows_of("ntda"):
        raw = (r.get("得獎單位名稱") or "").strip()
        y = to_int(r.get("屆次（西元年）"))
        if raw and y:
            out[norm_name(legal_name(raw))].append([y, r.get("獎項別") or "", raw, "ntda"])
            n["ntda"] += 1
    for r in rows_of("ntqa"):
        raw = (r.get("得獎名單") or "").strip()
        y = to_int(r.get("得獎年度"))
        if raw and y:
            out[norm_name(legal_name(raw))].append([y + 1911 if y < 1911 else y,
                                                   r.get("名單類別") or "", raw, "ntqa"])
            n["ntqa"] += 1
    for v in out.values():
        v.sort(key=lambda x: -x[0])
    print(f"人才發展獎項　國家人才發展獎 {n['ntda']} 筆、國家訓練品質獎 {n['ntqa']} 筆 → {len(out)} 個單位")
    return dict(out), {"aw_ntda": n["ntda"], "aw_ntqa": n["ntqa"], "aw_units": len(out)}


def build_ttqs() -> tuple[dict, dict]:
    rows = rows_of("ttqs")
    out: dict[str, list] = defaultdict(list)
    label = ""
    for r in rows:
        t = re.sub(r"\D", "", str(r.get("統一編號") or ""))
        if not t:
            continue
        t = t.zfill(8)
        out[t].append([r.get("公司名稱或單位名稱") or "", r.get("評核範圍") or "",
                       r.get("版本") or "", r.get("牌等") or "", r.get("評核有效日期") or ""])
        label = label or (re.match(r"\d{3}年\d{1,2}月", r["_desc"]) or [""])[0]
    print(f"TTQS 效期內　{len(rows):,} 列 → {len(out):,} 個統編（{label}名單）")
    return dict(out), {"tq_rows": len(rows), "tq_units": len(out), "tq_label": label}


def write_shards(name: str, data: dict, n: int) -> None:
    d = OUT / name
    # ⚠ 不刪目錄、直接覆寫每一片：片數固定，而且 Cowork 的 VM 不能刪檔（rmtree 會 PermissionError）。
    d.mkdir(parents=True, exist_ok=True)
    shards: list[dict] = [{} for _ in range(n)]
    for k, v in data.items():
        shards[fnv1a(k) % n][k] = v
    for i, s in enumerate(shards):
        (d / f"{i}.json").write_text(json.dumps(s, ensure_ascii=False, separators=(",", ":")),
                                     encoding="utf-8")


def main() -> int:
    use_utf8_stdout()
    names, taxes = site_names()
    print(f"網站（凍結版）{len(names):,} 家公司\n")
    wr, s1 = build_workrule(names)
    aw, s2 = build_awards()
    tq, s3 = build_ttqs()
    # 關於資料頁的串接表用：網站上的公司有幾家對得上（獎項用名稱、TTQS 用統編）
    s2["aw_companies"] = len(set(aw) & names)
    s3["tq_companies"] = len(set(tq) & taxes)
    if not (wr or aw or tq):
        print("⚠ 四份都沒有資料，不寫任何檔案。")
        return 1
    pv: dict[str, dict] = defaultdict(dict)
    for k, v in wr.items():
        pv[k]["w"] = v
    for k, v in aw.items():
        pv[k]["a"] = v
    write_shards("pv", pv, PV_SHARDS)
    write_shards("tq", tq, TQ_SHARDS)
    more = {"generated_at": date.today().isoformat(), "pv_shards": PV_SHARDS, "tq_shards": TQ_SHARDS,
            **s1, **s2, **s3}
    (OUT / "more.json").write_text(json.dumps(more, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n→ {OUT}/pv/ {PV_SHARDS} 片、{OUT}/tq/ {TQ_SHARDS} 片、{OUT}/more.json")
    print(json.dumps(more, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
