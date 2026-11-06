"""四份新資料對得上多少家？（決定要不要上線用，**不產生任何網站檔案**）

    python -m pipeline.more_check

讀 data/moldata/{workrule,ttqs,ntda,ntqa}/ 與目前的 web/public/data/c/*.json（凍結版），
印出每一份：原始筆數、不重複單位數、對得上「有裁處紀錄的公司」幾家。

比對規則跟正式上線時一樣嚴（見 crawler/more.py 開頭）：
  TTQS     有統一編號 → 只用統編對
  其餘     只接受 norm_name(legal_name(原始全名)) 完全相同，不做模糊比對
           （legal_name 剝掉廠區／分支後綴，跟安衛人員備查、得獎驗證同一條規矩）

⚠ 輸出裡的公司名是公開資料，但仍有真實公司名；只印前幾個樣本給人眼檢查。
"""
from __future__ import annotations

import glob
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                    # noqa: E402
from pipeline.credential import legal_name                            # noqa: E402
from pipeline.join import norm_name                                   # noqa: E402

SRC = Path("data/moldata")
SITE = Path("web/public/data/c")


def rows_of(key: str) -> list[dict]:
    man_p = SRC / key / "manifest.json"
    if not man_p.exists():
        print(f"  ⚠ 沒有 {man_p}（先跑 部署工具\\fetch_more.bat）")
        return []
    out = []
    for m in json.loads(man_p.read_text(encoding="utf-8")):
        data = json.loads((SRC / key / m["file"]).read_text(encoding="utf-8-sig"))
        if isinstance(data, dict):
            data = (data.get("result") or {}).get("records") or data.get("records") or data.get("data") or []
        for r in data:
            if isinstance(r, dict):
                r = {str(k).strip(): (v.strip() if isinstance(v, str) else v) for k, v in r.items()}
                r["_desc"] = m.get("desc", "")
                out.append(r)
    return out


def col(r: dict, *subs: str) -> str:
    """欄名用「包含」找，因為 JSON 版的欄名有時跟 data.gov.tw 宣告的不完全一樣。"""
    # ⚠ 先找完全相同的欄名，再找「包含」。6617 的「名單類別」包含「名單」，
    #   只用包含的話會先抓到類別欄（2026-10-30 實測：26 列只剩 5 個「單位」）。
    for s in subs:
        if s in r:
            return str(r[s] or "").strip()
    for k, v in r.items():
        if any(s in k for s in subs):
            return str(v or "").strip()
    return ""


def main() -> int:
    use_utf8_stdout()
    names: set[str] = set()
    tax: set[str] = set()
    for f in glob.glob(str(SITE / "*.json")):
        for k, e in json.loads(Path(f).read_text(encoding="utf-8"))["e"].items():
            names.add(norm_name(e.get("n") or k))
            if e.get("t"):
                tax.add(str(e["t"]).zfill(8))
    print(f"網站（凍結版）：{len(names):,} 家有裁處紀錄的公司，其中 {len(tax):,} 家有統編\n")

    summary = {}
    for key, label, name_cols, by_tax in (
        ("workrule", "工作守則備查名冊 6685", ("事業單位名稱", "工程名稱"), False),
        ("ttqs", "TTQS 效期內單位名單 41723", ("公司名稱", "單位名稱"), True),
        ("ntda", "國家人才發展獎 21214", ("得獎單位",), False),
        ("ntqa", "國家訓練品質獎 6617", ("得獎名單",), False),
    ):
        print(f"── {label}")
        rows = rows_of(key)
        if not rows:
            continue
        print(f"   欄位　{[k for k in rows[0] if k != '_desc']}")
        units: dict[str, str] = {}          # 原始全名 → 比對鍵
        hit_units: list[str] = []
        project_like = 0
        for r in rows:
            raw = col(r, *name_cols)
            if not raw:
                continue
            if "工程" in raw and not any(s in raw for s in ("公司", "工程行", "企業社")):
                project_like += 1
            units[raw] = norm_name(legal_name(raw))
        if by_tax:
            tids = {col(r, "統一編號").zfill(8) for r in rows if col(r, "統一編號")}
            hit = tids & tax
            name_hit = {u for u, k in units.items() if k in names}
            print(f"   原始 {len(rows):,} 列　不重複統編 {len(tids):,}")
            print(f"   ✔ 用統編對上有裁處紀錄的公司：{len(hit):,} 家"
                  f"（名稱對上 {len(name_hit):,} 個單位，只當參考，上線只用統編）")
            levels = Counter(col(r, "牌等") for r in rows)
            print(f"   牌等分布　{dict(levels.most_common(8))}")
            summary[key] = {"rows": len(rows), "units": len(tids), "hit": len(hit)}
        else:
            hit_units = [u for u, k in units.items() if k in names]
            hit_cos = {units[u] for u in hit_units}
            print(f"   原始 {len(rows):,} 列　不重複單位 {len(units):,}"
                  + (f"（其中約 {project_like:,} 列看起來是工程名稱）" if project_like else ""))
            print(f"   ✔ 名稱對上有裁處紀錄的公司：{len(hit_cos):,} 家（{len(hit_units):,} 個單位／場所）")
            years = Counter(r["_desc"][:20] for r in rows)
            if len(years) > 1:
                print(f"   資源　{len(years)} 個：{', '.join(list(years)[:4])} …")
            summary[key] = {"rows": len(rows), "units": len(units), "hit": len(hit_cos)}
        print()

    out = SRC / "more_check.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"摘要 → {out}")
    print("把上面整段貼回對話。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
