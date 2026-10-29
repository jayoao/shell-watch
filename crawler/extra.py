"""抓兩組新資料（決賽前補齊，2026-10-29）。

    python -m crawler.extra             # 全部
    python -m crawler.extra --only quota
    python -m crawler.extra --only listed

⚠ 要連 data.gov.tw、apiservice.mol.gov.tw、openapi.twse.com.tw、www.tpex.org.tw。
  **本機的 Linux VM 與雲端容器都連不到**，只能在 Windows 的 venv 跑（部署工具\\fetch_extra.bat）。

────────────────────────────────────────────────────────────────
一、身障定額進用不足額義務單位名單（勞動部勞動力發展署，data.gov.tw）
────────────────────────────────────────────────────────────────
勞動部每月（110 年起為「連續兩個月」）公告未足額進用身心障礙者的義務機關（構）。
依身心障礙者權益保障法第 38 條，員工 67 人以上的私立單位要進用 1% 身障者。
⚠ 這份是**勞動部的公告名單**，不是裁處：未足額的單位要繳差額補助費（第 43 條），
  不是罰鍰。畫面上一律寫「公告未足額」，不要寫成「違法」或「被罰」。
⚠ 只有「投保單位名稱」，沒有統一編號 —— 只能用名稱比對（正規化後完全相同）。

每一年是一個資料集，裡面每一期（月或兩個月）公立、私立各一個資源。
資源網址每年都會換，所以**每次都從 data.gov.tw 的 API 重新列**，不要寫死。

────────────────────────────────────────────────────────────────
二、上市櫃公司 ESG 揭露（證交所、櫃買中心 OpenAPI）
────────────────────────────────────────────────────────────────
  t187ap03     基本資料（統一編號、全名、網址）
  t187ap46_5   人力發展：非擔任主管之全時員工薪資中位數、平均數
  t187ap46_21  職業安全衛生：職業災害人數及比率（公司自行申報）
⚠ 這兩份是**公司自己申報**的，不是主管機關認定。畫面上要寫「公司自行申報」。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                      # noqa: E402

UA = "shell-watch/0.1 (student research project; InnoServe 2026 contest)"
QUOTA_OUT = Path("data/moldata/quota")
LISTED_OUT = Path("data/listed")

# 民國年 → data.gov.tw 資料集編號（2026-10-29 從 data.gov.tw 查的；新年度出來時加一行）
QUOTA_DATASETS = {
    "109": "157233", "110": "157234", "111": "31859", "112": "162056",
    "113": "168873", "114": "173669", "115": "177707",
}

LISTED = {
    "twse_basic": "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
    "twse_hr": "https://openapi.twse.com.tw/v1/opendata/t187ap46_L_5",
    "twse_osh": "https://openapi.twse.com.tw/v1/opendata/t187ap46_L_21",
    "tpex_basic": "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
    "tpex_hr": "https://www.tpex.org.tw/openapi/v1/t187ap46_O_5",
    "tpex_osh": "https://www.tpex.org.tw/openapi/v1/t187ap46_O_21",
}


def get(url: str, tries: int = 3) -> bytes:
    """⚠ 政府網站會在 HTTP 200 回 HTML 錯誤頁，所以要驗內容，不能只看狀態碼。"""
    last = ""
    for i in range(1, tries + 1):
        try:
            r = requests.get(url, timeout=120, headers={"User-Agent": UA})
            body = r.content
            head = body[:100].decode("utf-8", "replace").lstrip("﻿").lstrip().lower()
            if r.status_code == 200 and body and not head.startswith(("<!doctype", "<html")):
                return body
            last = f"HTTP {r.status_code}，開頭 {head[:60]!r}"
        except requests.RequestException as e:
            last = f"{e.__class__.__name__}: {e}"
        if i < tries:
            time.sleep(3 * i)
    raise RuntimeError(f"{url}：{last}")


def as_rows(body: bytes) -> list[dict]:
    data = json.loads(body.decode("utf-8-sig"))
    if isinstance(data, dict):
        data = (data.get("result") or {}).get("records") or data.get("records") or data.get("data") or []
    return data if isinstance(data, list) else []


def quota() -> int:
    QUOTA_OUT.mkdir(parents=True, exist_ok=True)
    manifest, bad = [], 0
    for roc, ds in QUOTA_DATASETS.items():
        meta = json.loads(get(f"https://data.gov.tw/api/v2/rest/dataset/{ds}").decode("utf-8-sig"))
        d = meta.get("result", meta)
        dist = [x for x in d.get("distribution", [])
                if str(x.get("resourceFormat", "")).upper() == "JSON"]
        print(f"  {roc} 年（data.gov.tw/dataset/{ds}）　{len(dist)} 期")
        for x in dist:
            url = x["resourceDownloadUrl"]
            rid = url.rstrip("/").split("/")[-1]
            path = QUOTA_OUT / f"{rid}.json"
            try:
                body = get(url)
                rows = as_rows(body)
                if rows and "投保單位名稱" not in rows[0]:
                    raise RuntimeError(f"欄位不對：{list(rows[0])}")
            except (RuntimeError, ValueError) as e:
                print(f"    ✗ {x.get('resourceDescription')}：{e}", file=sys.stderr)
                bad += 1
                continue
            path.write_bytes(body)
            manifest.append({"dataset": ds, "roc": roc, "desc": x.get("resourceDescription", ""),
                             "rid": rid, "file": path.name, "rows": len(rows)})
    (QUOTA_OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  身障未足額名單　{len(manifest)} 期、{sum(m['rows'] for m in manifest):,} 列　失敗 {bad}")
    return 0 if manifest and bad == 0 else 1


GOLD_DATASET = "42147"          # 金展獎得獎名單（進用身心障礙者績優機關），身障未足額的正面那一半
GOLD_OUT = Path("data/moldata/gold")


def gold() -> int:
    """金展獎：只收負面就成了黑名單，所以身障這一題也要收正面的。"""
    GOLD_OUT.mkdir(parents=True, exist_ok=True)
    meta = json.loads(get(f"https://data.gov.tw/api/v2/rest/dataset/{GOLD_DATASET}").decode("utf-8-sig"))
    d = meta.get("result", meta)
    dist = [x for x in d.get("distribution", [])
            if str(x.get("resourceFormat", "")).upper() == "JSON"]
    manifest, bad = [], 0
    for x in dist:
        url = x["resourceDownloadUrl"]
        rid = url.rstrip("/").split("/")[-1]
        try:
            body = get(url)
            rows = as_rows(body)
            if not rows:
                raise RuntimeError("空的")
        except (RuntimeError, ValueError) as e:
            print(f"    ✗ {x.get('resourceDescription')}：{e}", file=sys.stderr)
            bad += 1
            continue
        (GOLD_OUT / f"{rid}.json").write_bytes(body)
        manifest.append({"desc": x.get("resourceDescription", ""), "file": f"{rid}.json",
                         "rows": len(rows), "fields": list(rows[0])})
    (GOLD_OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  金展獎　{len(manifest)} 屆、{sum(m['rows'] for m in manifest):,} 筆　欄位 {manifest[0]['fields'] if manifest else ''}")
    return 0 if manifest and bad == 0 else 1


def listed() -> int:
    LISTED_OUT.mkdir(parents=True, exist_ok=True)
    bad = 0
    for key, url in LISTED.items():
        try:
            body = get(url)
            rows = as_rows(body)
            if not rows:
                raise RuntimeError("空的")
        except (RuntimeError, ValueError) as e:
            print(f"  ✗ {key}：{e}", file=sys.stderr)
            bad += 1
            continue
        (LISTED_OUT / f"{key}.json").write_bytes(body)
        print(f"  {key:11} {len(rows):,} 家")
    return 0 if bad == 0 else 1


def main(argv: list[str] | None = None) -> int:
    use_utf8_stdout()
    p = argparse.ArgumentParser()
    p.add_argument("--only", choices=["quota", "listed"])
    a = p.parse_args(argv)
    rc = 0
    if a.only in (None, "quota"):
        print("── 身障定額進用不足額義務單位名單")
        rc |= quota()
        print("── 金展獎得獎名單")
        rc |= gold()
    if a.only in (None, "listed"):
        print("── 上市櫃公司 ESG 揭露")
        rc |= listed()
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
