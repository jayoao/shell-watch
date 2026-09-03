# 換殼追蹤 · 以人為軸的求職安全雷達

2026 第 31 屆 InnoServe　主投：職安視覺化防災及素養提升組（LaborOD）

---

## 這是什麼

勞動部的「違反勞動法令事業單位查詢系統」**以公司為單位查詢**。
慣性違法的雇主只要解散公司、換名字重開，違法紀錄就留在舊公司，
新公司在系統裡是一張白紙。

**違法紀錄跟著公司走，但問題跟著人走。** 我們把查詢的軸線換成人。

---

## 我只做前端（T5 地圖頁）

**你不需要 Python，不需要下載任何資料。** 這三行就能跑起來：

```bash
cd web
npm ci              # 不要用 npm i，會裝到跟 lockfile 不同的版本
npm run dev         # http://localhost:5173
```

你要動的檔案只有一個：**`web/src/pages/OshaMap.tsx`**。

- 資料契約在 `web/src/types/contracts.ts` —— 型別的唯一來源，不要改
- 假資料在 `web/src/data/mock.osha.json` —— 真資料好了只換這個檔案，你的程式不用改
- 顏色一律用 `var(--xxx)`，定義在 `web/src/styles/tokens.css`，**不要寫死色碼**

送出前跑 `npm run build`（會依序跑 eslint → tsc → vite build，三關都要過）。

<details>
<summary>兩個一定會踩的坑</summary>

**hooks 不能放在 early return 之後。** 兩次渲染的 hook 數量不一樣會變成
React error #310、整頁白屏，而且 TypeScript 檢查不出來。
`eslint.config.mjs` 已經把這條設成 error 並納入 `npm run build`。

**地圖標記要用 `CircleMarker` 不要用 `Marker`。** Vite 會弄壞 Leaflet 預設的
marker 圖示路徑，畫出來會是破圖。
</details>

---

## 完整的資料流程（主線）

前端開發不需要跑這些。

```bash
python -m venv .venv
.venv\Scripts\activate                # Windows
pip install -r requirements.txt

# 勞動部：66 萬筆裁處公告
python -m crawler.mol                 # → data/raw/          約 20 分鐘
python -m pipeline.build              # → records.csv
python -m pipeline.signal             # 同名多公司分級 ＋ 同名巧合檢定
python -m pipeline.rarity             # 姓名稀有度 → 可信度分數
python -m pipeline.shell              # 換殼／集團分流

# 經濟部商工登記：427 萬筆（g0v 打包）
python -m gcis.fetch                  # → data/gcis/         約 610 MB
python -m gcis.load                   # → data/gcis.duckdb   約 100 秒
python -m pipeline.join               # 地址與登記狀態的佐證

# 人工標註
python -m tools.make_review           # 產生 link_review / parse_review
python -m tools.kappa a.csv b.csv     # 算兩人的一致率
```

測試：`python tests/test_parse.py`、`python tests/test_shell.py`

---

## 目錄

```
crawler/     勞動部查詢系統的爬取（constants.py 有 30 單位 × 10 法規）
gcis/        經濟部商工登記的下載與載入
pipeline/    解析、去重、排除、分級、可信度分數、跨機關對接
tools/       假資料產生器、標註檔產生器、kappa
tests/       解析與分類規則的測試（fixture 是**合成姓名**，見 CLAUDE.md）
web/         前端（Vite + React 18 + TypeScript + Leaflet）
data/        全部不進 git —— 太大而且含真實姓名，見 data/README.md
```

---

## 分工

| | 負責 |
|---|---|
| 主線 | 爬取、清理、實體解析、可信度分數、跨機關對接、部署 |
| 隊友 | `web/src/pages/OshaMap.tsx`、人工標註、報名文件、簡報、影片 |

---

## 紅線

這個系統處理**真實公司與真實人名**，誤判是實質的名譽損害。

- 只呈現「公開紀錄 ＋ 出處連結」，**不下結論、不加形容詞**
- 展示、截圖、影片一律去識別化
- **不宣稱能「認定」違法**，只說「呈現公開紀錄的關聯」
- 系統輸出的是**待查訊號**，不是判定

含真實姓名的標註檔（`*_review.csv`）**不進 git、不上雲端硬碟、不貼聊天群組**。

詳見 `CLAUDE.md`。
