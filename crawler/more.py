"""抓四份新的勞動部開放資料（決賽前補齊，2026-10-30）。

    python -m crawler.more              # 全部
    python -m crawler.more --only ttqs

⚠ 要連 data.gov.tw、apiservice.mol.gov.tw。
  **本機的 Linux VM 與雲端容器都連不到**，只能在 Windows 的 venv 跑（部署工具\\fetch_more.bat）。
⚠ 這支**只下載**到 data/moldata/ 底下，不動 web/public/data，所以資料凍結期間也可以跑。

────────────────────────────────────────────────────────────────
為什麼是這四份（2026-10-30 從 data.gov.tw 勞動部 865 筆資料集逐筆篩出來的）
────────────────────────────────────────────────────────────────
篩選標準（四條都要過）：
  1. 對得到「一家事業單位」（有名稱或統編）—— 只有全國統計數字的表不用
  2. 是主管機關的認定或公告，不是公司自評
  3. 講的是這家公司對勞工做了什麼
  4. 在畫面上有明確角色

  workrule  6685  工作守則備查名冊           事前訊號（職安法第 34 條），跟 6686 安衛人員備查同一類
  ttqs     41723  TTQS 效期內單位名單         正面紀錄（人才培訓品質評核），**有統一編號**
  ntda     21214  國家人才發展獎得獎名單       正面紀錄（獎項），2015 年起逐年一個資源
  ntqa      6617  國家訓練品質獎               正面紀錄（獎項），較早年度

沒選、但看起來相關的（寫下來免得之後又去查一次）：
  44023 金安獎 —— 主題最貼近，但只有「工程名稱」沒有公司名，對不到公司
  152366 工作生活平衡措施、24036 托兒設施補助 —— 只有全國申請家數與金額
  6341 職安教育訓練績優 —— 評的是訓練機構，不是雇主

⚠⚠ 跟其他正面紀錄同一條規則：配錯等於幫一家公司背書。
    有統編（TTQS）只用統編對；其餘只接受正規化後完全相同的名稱，不做模糊比對。
⚠ 工作守則跟安衛人員備查一樣：沒有出現在名冊上**不等於**沒訂工作守則，
    畫面上只能出現「有」，永遠不能寫「無」。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                      # noqa: E402

UA = "shell-watch/0.1 (student research project; InnoServe 2026 contest)"
OUT = Path("data/moldata")

# key: (data.gov.tw 編號, 名稱, 要抓哪些資源)
#   "all"    每個 JSON 資源都抓（逐年的獎項）
#   "latest" 只抓最新一期（TTQS 是每季一份「目前有效」的快照，最新那份就是現況）
SOURCES = {
    "workrule": ("6685", "工作守則備查名冊", "all"),
    "ttqs": ("41723", "TTQS效期內單位名單", "latest"),
    "ntda": ("21214", "國家人才發展獎得獎名單", "all"),
    "ntqa": ("6617", "國家訓練品質獎", "all"),
}


def get(url: str, tries: int = 3) -> bytes:
    """⚠ 政府網站會在 HTTP 200 回 HTML 錯誤頁，所以要驗內容，不能只看狀態碼。"""
    last = ""
    for i in range(1, tries + 1):
        try:
            r = requests.get(url, timeout=300, headers={"User-Agent": UA})
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


def period_key(desc: str) -> int:
    """「115年10月TTQS效期內單位名單」→ 11510。抓不到年月回 0。"""
    m = re.search(r"(\d{3})年(\d{1,2})月", desc or "")
    return int(m.group(1)) * 100 + int(m.group(2)) if m else 0


def fetch_one(key: str) -> int:
    ds, name, mode = SOURCES[key]
    out = OUT / key
    out.mkdir(parents=True, exist_ok=True)
    meta = json.loads(get(f"https://data.gov.tw/api/v2/rest/dataset/{ds}").decode("utf-8-sig"))
    d = meta.get("result", meta)
    dist = [x for x in d.get("distribution", [])
            if str(x.get("resourceFormat", "")).upper() == "JSON"]
    if mode == "latest" and dist:
        dist = [max(dist, key=lambda x: period_key(x.get("resourceDescription", "")))]
    print(f"\n── {key}　{name}（data.gov.tw/dataset/{ds}）　{len(dist)} 個資源")
    manifest, bad = [], 0
    for x in dist:
        url = x["resourceDownloadUrl"]
        rid = url.rstrip("/").split("/")[-1]
        desc = x.get("resourceDescription", "")
        try:
            body = get(url)
            rows = as_rows(body)
            if not rows:
                raise RuntimeError("空的")
        except (RuntimeError, ValueError) as e:
            print(f"    ✗ {desc}：{e}", file=sys.stderr)
            bad += 1
            continue
        (out / f"{rid}.json").write_bytes(body)          # ⚠ 先原樣存檔，再處理
        manifest.append({"dataset": ds, "desc": desc, "file": f"{rid}.json",
                         "rows": len(rows), "fields": list(rows[0])})
        print(f"    {desc[:40]}　{len(rows):,} 筆")
    (out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    if manifest:
        print(f"  合計 {sum(m['rows'] for m in manifest):,} 筆　欄位 {manifest[0]['fields']}")
    return 0 if manifest and bad == 0 else 1


def main(argv: list[str] | None = None) -> int:
    use_utf8_stdout()
    p = argparse.ArgumentParser(description="抓四份新的勞動部開放資料")
    p.add_argument("--only", action="append", choices=list(SOURCES))
    a = p.parse_args(argv)
    rc = 0
    for key in (a.only or list(SOURCES)):
        try:
            rc |= fetch_one(key)
        except (RuntimeError, ValueError) as e:
            print(f"  ✗ {key}：{e}", file=sys.stderr)
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
