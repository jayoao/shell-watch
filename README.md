# 換殼追蹤 · 以人為軸的求職安全雷達

2026 第 31 屆 InnoServe　主投：職安視覺化防災及素養提升組（LaborOD）

---

## 這是什麼

勞動部的「違反勞動法令事業單位查詢系統」**以公司為單位查詢**。
慣性違法的雇主只要解散公司、換名字重開，違法紀錄就留在舊公司，
新公司在系統裡是一張白紙。

**違法紀錄跟著公司走，但問題跟著人走。** 我們把查詢的軸線換成人。

## 快速開始

### 前端

```bash
cd web
npm install        # 第一次；之後用 npm ci
npm run dev        # http://localhost:5173
```

### 資料層

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt

python tools/make_mock.py       # 產生前端用的假資料
python pipeline/parse.py        # 看解析器的行為
python pipeline/exclude.py      # 看排除規則的行為
python pipeline/dedupe.py       # 看去重規則的行為
```

## 目錄

```
crawler/     勞動部查詢系統的爬取（constants.py 有 30 單位 × 10 法規的清單）
pipeline/    解析、去重、排除
tools/       假資料產生器等工具
web/         前端（Vite + React 18 + TypeScript）
data/raw/    爬下來的原始檔（不進 git）
```

## 分工

| | 負責 |
|---|---|
| 主線 | 爬取、清理、實體解析、後端 API、部署 |
| 隊友 | `web/src/pages/OshaMap.tsx` 一頁、標註、文件、影片 |

隊友只碰 `OshaMap.tsx`。資料契約在 `web/src/types/contracts.ts`，
假資料在 `web/src/data/mock.osha.json` —— 她拿假資料開發，
真資料好了只換檔案，她的程式不用改。

## 紅線

這個系統處理**真實公司與真實人名**。

- 只呈現「公開紀錄 + 出處連結」，**不下結論、不加形容詞**
- 展示、截圖、影片一律去識別化
- 不宣稱能「認定」違法，只說「呈現公開紀錄的關聯」

詳見 `CLAUDE.md`。
