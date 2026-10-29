"""兩組新資料 → 前端分片（crawler/extra.py 抓的原檔）。

    python -m pipeline.extra

輸出（都不進 git，部署時直接上傳）：
  web/public/data/dq/{0..255}.json   身障定額進用不足額名單，正規化名稱 → 各期
  web/public/data/ls/{0..63}.json    上市櫃公司揭露，正規化全名 → 薪資、職災、官網
  web/public/data/extra.json         分片數、最新一期、薪資分位數（前端畫小長條用）

⚠ 跟 publish.py 分開：publish 每次重寫 meta.json，這兩份資料的設定放 extra.json，
  誰先跑誰後跑都不會互相蓋掉。

────────────────────────────────────────────────────────────────
⚠⚠ 措辭（前端照這裡寫）
────────────────────────────────────────────────────────────────
身障名單：勞動部「公告」的「連續未足額進用身心障礙者」義務單位。
  - 不是裁處，不是罰鍰：未足額要繳差額補助費（身權法第 43 條）。
  - 不寫「違法」「被罰」。寫「勞動部公告未足額」。
  - 只用名稱比對（來源沒有統編），正規化後完全相同才算。
上市櫃揭露：公司**自行申報**，不是主管機關認定。職災人數也是公司自己報的。
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                    # noqa: E402
from pipeline.join import norm_name                                   # noqa: E402
from pipeline.publish import fnv1a                                    # noqa: E402

QUOTA_DIR = Path("data/moldata/quota")
GOLD_DIR = Path("data/moldata/gold")
LISTED_DIR = Path("data/listed")
OUT = Path("web/public/data")
DQ_SHARDS = 256
LS_SHARDS = 64


def _rows(p: Path) -> list[dict]:
    data = json.loads(p.read_text(encoding="utf-8-sig"))
    if isinstance(data, dict):
        data = (data.get("result") or {}).get("records") or data.get("records") or []
    # ⚠ 證交所有些欄名尾巴帶空白（「員工薪資平均數(仟元/人) 」），一律去掉。
    return [{str(k).strip(): (v.strip() if isinstance(v, str) else v) for k, v in r.items()}
            for r in data if isinstance(r, dict)]


def period(desc: str) -> tuple[str, int]:
    """「115年1-2月私立單位連續未足額單位名單」→ ("115年1-2月", 11502)。
    「111年12月至112年1月…」→ ("111年12月至112年1月", 11201)。排序用的是**期末**年月。"""
    label = re.split(r"[公私]立", desc)[0].replace("(修)", "").strip()
    years = re.findall(r"(\d{3})年", label)
    months = re.findall(r"(\d{1,2})(?:-(\d{1,2}))?月", label)
    if not years or not months:
        return label, 0
    y = int(years[-1])
    m1, m2 = months[-1]
    return label, y * 100 + int(m2 or m1)


def num(s) -> int:
    t = re.sub(r"[^\d]", "", str(s or ""))
    return int(t) if t else 0


def build_quota() -> dict:
    man_p = QUOTA_DIR / "manifest.json"
    if not man_p.exists():
        print(f"⚠ 沒有 {man_p}（跑 部署工具\\fetch_extra.bat）")
        return {}
    manifest = json.loads(man_p.read_text(encoding="utf-8"))
    by: dict[str, dict] = {}
    periods: dict[int, str] = {}
    rows_total = 0
    for m in manifest:
        sector = "私" if "私立" in m["desc"] else "公" if "公立" in m["desc"] else ""
        label, end = period(m["desc"])
        if not end:
            print(f"  ⚠ 看不懂期別：{m['desc']}")
            continue
        periods[end] = label
        for r in _rows(QUOTA_DIR / m["file"]):
            name = (r.get("投保單位名稱") or "").strip()
            key = norm_name(name)
            if not key:
                continue
            rows_total += 1
            e = by.setdefault(key, {"n": name, "c": (r.get("縣市別") or "").replace("臺", "台"),
                                    "s": sector, "p": {}})
            # 同一期同一名稱出現兩次（極少見，來源重複）就留不足人數大的那筆
            prev = e["p"].get(end)
            cur = [label, num(r.get("不足人數數量")), num(r.get("進用人數數量")),
                   num(r.get("法定人數數量"))]
            if prev is None or cur[1] > prev[1]:
                e["p"][end] = cur
    # 金展獎（進用身心障礙者績優）：同一個主題的正面那一半。只收負面就成了黑名單。
    #   ⚠ 也只用名稱比對（來源沒有統編），正規化後完全相同才算。
    gold: dict[str, list] = defaultdict(list)
    gman = GOLD_DIR / "manifest.json"
    if gman.exists():
        for m in json.loads(gman.read_text(encoding="utf-8")):
            ed = (re.match(r"(第.+?屆)", m["desc"]) or [None, m["desc"]])[1]
            for r in _rows(GOLD_DIR / m["file"]):
                key = norm_name(r.get("機關_構_名稱") or "")
                if key:
                    gold[key].append([ed, (r.get("獎項別") or "").strip()])
        print(f"金展獎　{sum(len(v) for v in gold.values()):,} 筆、{len(gold):,} 個單位")
    out = OUT / "dq"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    shards: list[dict] = [{} for _ in range(DQ_SHARDS)]
    for key, e in by.items():
        ps = [e["p"][k] for k in sorted(e["p"], reverse=True)]       # 新的在前
        shards[fnv1a(key) % DQ_SHARDS][key] = {"n": e["n"], "c": e["c"], "s": e["s"], "p": ps}
    for key, gs in gold.items():
        e = shards[fnv1a(key) % DQ_SHARDS].setdefault(key, {"n": key, "c": "", "s": "", "p": []})
        e["g"] = gs
    for i, sh in enumerate(shards):
        (out / f"{i}.json").write_text(json.dumps(sh, ensure_ascii=False, separators=(",", ":")),
                                       encoding="utf-8")
    latest = max(periods) if periods else 0
    private = sum(1 for e in by.values() if e["s"] == "私")
    print(f"身障未足額名單　{len(manifest)} 份資源、{len(periods)} 期、{rows_total:,} 列 → "
          f"{len(by):,} 個單位（私立 {private:,}）　最新一期 {periods.get(latest, '')}")
    return {"dq_shards": DQ_SHARDS, "dq_latest": periods.get(latest, ""),
            "dq_latest_key": latest, "dq_first": periods.get(min(periods), "") if periods else "",
            "dq_periods": len(periods), "dq_units": len(by), "gold_units": len(gold),
            # 全部期別（舊到新），前端畫「每一期一格」的小方格用
            "dq_all": [[k, periods[k]] for k in sorted(periods)]}


def build_listed() -> dict:
    need = ["twse_basic", "twse_hr", "twse_osh", "tpex_basic", "tpex_hr", "tpex_osh"]
    if not all((LISTED_DIR / f"{k}.json").exists() for k in need):
        print(f"⚠ {LISTED_DIR} 不完整（跑 部署工具\\fetch_extra.bat）")
        return {}

    def g(r: dict, *keys: str) -> str:
        for k in keys:
            if r.get(k):
                return str(r[k]).strip()
        return ""

    comp: dict[str, dict] = {}            # 公司代號 → 資料
    for mkt, basic in (("上市", "twse_basic"), ("上櫃", "tpex_basic")):
        for r in _rows(LISTED_DIR / f"{basic}.json"):
            code = g(r, "公司代號", "SecuritiesCompanyCode")
            name = g(r, "公司名稱", "CompanyName")
            if not code or not name:
                continue
            tax = re.sub(r"\D", "", g(r, "營利事業統一編號", "UnifiedBusinessNo."))
            web = g(r, "網址", "WebAddress")
            if web and not web.startswith("http"):
                web = "https://" + web
            comp[code] = {"code": code, "m": mkt, "n": name, "a": g(r, "公司簡稱", "CompanyAbbreviation"),
                          "t": tax.zfill(8) if tax else "", "w": web}
    for hr in ("twse_hr", "tpex_hr"):
        for r in _rows(LISTED_DIR / f"{hr}.json"):
            c = comp.get(g(r, "公司代號"))
            if not c:
                continue
            c["y"] = num(g(r, "報告年度"))
            c["med"] = num(g(r, "非擔任主管之全時員工薪資中位數(仟元/人)"))
            c["avg"] = num(g(r, "非擔任主管職務之全時員工薪資平均數(仟元/人)"))
    for osh in ("twse_osh", "tpex_osh"):
        for r in _rows(LISTED_DIR / f"{osh}.json"):
            c = comp.get(g(r, "公司代號"))
            if not c:
                continue
            inj = g(r, "職業災害人數及比率-人數")
            rate = g(r, "職業災害人數及比率-比率")
            if inj != "":
                c["inj"] = num(inj)
                c["injr"] = rate
    out = OUT / "ls"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    shards: list[dict] = [{} for _ in range(LS_SHARDS)]
    for c in comp.values():
        key = norm_name(c["n"])
        shards[fnv1a(key) % LS_SHARDS][key] = {k: v for k, v in c.items() if v not in ("", None)}
    for i, sh in enumerate(shards):
        (out / f"{i}.json").write_text(json.dumps(sh, ensure_ascii=False, separators=(",", ":")),
                                       encoding="utf-8")
    meds = sorted(c["med"] for c in comp.values() if c.get("med"))
    q = [meds[min(len(meds) - 1, round(i / 20 * (len(meds) - 1)))] for i in range(21)] if meds else []
    years = sorted({c.get("y", 0) for c in comp.values() if c.get("y")})
    print(f"上市櫃揭露　{len(comp):,} 家（有薪資 {len(meds):,}、有職災申報 "
          f"{sum(1 for c in comp.values() if 'inj' in c):,}）　報告年度 {years}")
    return {"ls_shards": LS_SHARDS, "ls_q": q, "ls_year": years[-1] if years else 0,
            "ls_companies": len(comp)}


def main() -> int:
    use_utf8_stdout()
    ex = {**build_quota(), **build_listed()}
    (OUT / "extra.json").write_text(json.dumps(ex, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {OUT / 'extra.json'}")
    return 0 if ex else 1


if __name__ == "__main__":
    raise SystemExit(main())
