# data/

**這個資料夾的內容不進 git。** 見專案根目錄的 `.gitignore`。

兩個理由：檔案很大（`gcis/` 583 MB、`gcis.duckdb` 800 MB、
`records.csv` 201 MB，GitHub 單檔上限 100 MB），而且**含真實公司名與人名**。

## 怎麼把資料生出來

```bash
python -m crawler.mol      # 勞動部裁處公告 → data/raw/       約 20 分鐘
python -m pipeline.build   # → data/records.csv
python -m pipeline.signal  # → data/candidates.csv
python -m pipeline.rarity  # → data/candidates_scored.csv
python -m pipeline.shell   # → data/shell_candidates.csv

python -m gcis.fetch       # 商工登記打包檔 → data/gcis/      約 610 MB
python -m gcis.load        # → data/gcis.duckdb               約 100 秒
python -m pipeline.join    # → data/joined.csv
```

前端開發不需要跑這些 —— `web/` 用的是 `tools/make_mock.py` 產生的假資料。
