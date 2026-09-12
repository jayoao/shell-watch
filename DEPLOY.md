# 部署

網站是**純靜態**的，沒有後端。查詢用的 2,048 個分片放在 `web/public/data/`，
由前端自己算雜湊決定要抓哪一片。所以部署 = 把 `web/dist/` 整個上傳。

## ⚠ 為什麼不走 GitHub 自動部署

`web/public/data/` 有 **159 MB、2,048 個檔案**，而且在 `.gitignore` 裡。

它是衍生資料（來源是 `data/records.csv` 與 `data/ranked.csv`，那兩個有真實姓名、
本來就沒進 git）。159 MB 的產生物進 git，每次重新產生就是一次全量改寫，歷史會爆掉。

所以：**本機產生 → 本機打包 → 直接上傳**。git 只放程式碼。

---

## 第一次部署

需要一個 Cloudflare 帳號（免費方案就夠）。

```
cd D:\class-project\shell-watch

python -m pipeline.publish          :: 產生 2,048 個分片（幾分鐘）
python -m pipeline.geo              :: 產生地圖頁的鄉鎮市區聚合（幾秒）
cd web
npm run build                       :: eslint + tsc + vite build，dist/ 約 160 MB
npx wrangler pages deploy dist --project-name shell-watch
```

第三行第一次跑會：

1. 開瀏覽器要你登入 Cloudflare 並授權
2. 問要不要建立 `shell-watch` 這個專案 → 選是
3. 問生產分支叫什麼 → 填 `main`

跑完會給你一個網址，大概長這樣：

```
https://shell-watch.pages.dev
```

## 之後每次更新

資料或程式改了就重跑同樣三行。`wrangler` 只會上傳有變動的檔案，比第一次快很多。

```
cd D:\class-project\shell-watch
python -m pipeline.publish
python -m pipeline.geo
cd web
npm run build
npx wrangler pages deploy dist --project-name shell-watch
```

⚠ `pipeline.geo` 漏跑的話，地圖頁會用 `web/src/data/` 裡那份**上次的**聚合結果
（那一份有進 git，所以不會壞，但數字會停在上次），而且畫面上看不出來。
資料重跑過就一定要跟著跑這支。

⚠ `pipeline.publish` 會先清掉舊的分片目錄。清不掉就會直接失敗並要你手動刪 ——
那是刻意的：**沿用舊分片會讓使用者查到過期資料，而畫面上不會有任何異狀。**

---

## 部署後要檢查的五件事

1. 首頁搜尋框下面寫著「資料涵蓋 17X,XXX 家事業單位、6XX,XXX 筆公開裁處紀錄」
   —— 如果寫的是「去識別化的展示資料（12 筆）」，代表 `data/` 沒上傳成功。
2. 查一家真實公司（例如 `瀚強工程股份有限公司`），有結果、有證據清單。
3. 打核心名（`瀚強工程`）會出現「請選擇你要查的那一家」。
4. 開 `/osha` 地圖頁，直接重新整理**不會 404**（`_redirects` 在做這件事）。
5. 開瀏覽器的開發者工具 → Network，確認查詢時只抓了 `1` 個 `data/c/*.json`
   （約 14 KB，gzip 後）。抓很多片代表雜湊對不上。

畫面最上面如果出現紅字「資料索引不一致」，就是 `publish.py` 跟 `lookup.ts` 的
雜湊函式不同步 —— 那時候查詢會安靜地全部回「查無」，看起來像資料沒部署好。

---

## ⚠ 上線之後的三條紅線

**一、網站上有真實姓名。**
`public/robots.txt` 與 `_headers` 的 `X-Robots-Tag` 都設了 `noindex` ——
評審、老師、拿到網址的人都看得到，但搜尋引擎不收錄。

那些資料是勞動部依法公告的公開資訊，我們只是換一個軸線呈現。
但「被 Google 收錄」跟「在政府網站上查得到」是兩件事：一旦被索引，
某個人的姓名會永久跟「違反勞動法令」綁在搜尋結果上，
而本系統明確拒絕做「這些公司是同一人」的認定。

**不要把 noindex 拿掉。**

**二、截圖、影片、簡報一律用去識別化樣本。**

```
python -m pipeline.export --sample 12
```

那份的公司名、人名、統一編號、門牌號、處分字號都遮過。
線上網站是給人實際查詢用的，不是給錄影用的。

**三、不要把 `web/public/data/` 加進 git。**
`.gitignore` 已經擋了。如果哪天 `git status` 看到它，代表有人改了 `.gitignore`。

---

## 如果 Cloudflare 太麻煩（備案）

Netlify 可以直接把 `web/dist/` 資料夾拖到 <https://app.netlify.com/drop>，
不用 CLI 也不用先註冊。缺點是 2,048 個檔案用瀏覽器上傳比較慢也比較容易斷。
`_headers` 與 `_redirects` 兩個檔案 Netlify 也吃同樣的格式，不用改。
