#!/usr/bin/env python3
"""產生職安地圖用的假資料。

為什麼要有這支：
    隊友的地圖頁（T5）不能等真實資料。有了格式一模一樣的假資料，
    她可以完全平行開發；真資料好了只要換檔案，她的程式一行都不用改。

刻意在資料裡放的「壞情況」（她的程式必須要能撐住）：
    · 約 8% 的紀錄 lat/lng 是 null      → 要跳過，不能當掉
    · 約 25% 的紀錄 casualties 是 0     → 還是要畫，用最小的點
    · 少數紀錄 violation 超過 150 字     → Popup 要能捲動或截斷
    · 少數紀錄 location 是 null 但有座標 → 顯示要有 fallback

用法：
    python tools/make_mock.py                    # 產 200 筆
    python tools/make_mock.py --n 500 --seed 7   # 換數量與亂數種子
"""
from __future__ import annotations

import argparse
import json
import random
from datetime import date, timedelta
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "web" / "src" / "data" / "mock.osha.json"

# 縣市中心座標（約略）。真實資料會用地址做地理編碼，這裡只要分布合理即可。
COUNTIES: dict[str, tuple[float, float, float]] = {
    # 名稱: (緯度, 經度, 散布半徑（度）)
    "台北市": (25.0330, 121.5654, 0.06),
    "新北市": (25.0170, 121.4628, 0.18),
    "桃園市": (24.9937, 121.3010, 0.14),
    "台中市": (24.1477, 120.6736, 0.16),
    "台南市": (22.9999, 120.2269, 0.16),
    "高雄市": (22.6273, 120.3014, 0.18),
    "基隆市": (25.1276, 121.7392, 0.04),
    "新竹市": (24.8138, 120.9675, 0.04),
    "新竹縣": (24.8387, 121.0177, 0.12),
    "苗栗縣": (24.5602, 120.8214, 0.14),
    "彰化縣": (24.0518, 120.5161, 0.11),
    "南投縣": (23.9609, 120.9719, 0.18),
    "雲林縣": (23.7092, 120.4313, 0.12),
    "嘉義市": (23.4801, 120.4491, 0.03),
    "嘉義縣": (23.4518, 120.2555, 0.13),
    "屏東縣": (22.5519, 120.5487, 0.20),
    "宜蘭縣": (24.7021, 121.7378, 0.13),
    "花蓮縣": (23.9871, 121.6015, 0.25),
    "台東縣": (22.7583, 121.1444, 0.25),
    "澎湖縣": (23.5712, 119.5793, 0.06),
}
# 六都件數本來就多，用權重讓分布看起來像真的
WEIGHTS = [8, 7, 7, 6, 5, 6, 2, 2, 2, 2, 3, 2, 2, 1, 2, 2, 2, 2, 1, 1]

# 違規樣態取材自實際公告的文字風格（法條與敘述都是真實存在的類型）
VIOLATIONS: list[tuple[str, str, str]] = [
    ("職業安全衛生設施規則第281條第1項",
     "於高度2公尺以上之作業場所，勞工有墜落之虞，未使勞工確實使用安全帶、安全帽及其他必要之防護具。", "重大"),
    ("營造安全衛生設施標準第19條第1項",
     "構台區邊緣部分2公尺以上開口未設置護欄、護蓋或安全網等防護設備，亦無警示區隔，且構台爬梯亦未設置防止人員墜落之設施。", "重大"),
    ("職業安全衛生設施規則第228條",
     "鋼構作業鋼構最上層無上下設備。", "中度"),
    ("職業安全衛生法第26條第2項",
     "將工程交付承攬施工，未就物體倒塌危害於事前以書面具體告知承攬人有關其事業工作環境、危害因素暨本法及有關安全衛生規定應採取之措施，造成承攬人之勞工發生職業災害。", "重大"),
    ("職業安全衛生法第27條第1項第2款",
     "對於再承攬人所僱勞工從事安裝作業，有物體倒塌之虞之工作場所，未依規定確實巡視；亦未確實採積極具體之連繫與調整作為，要求再承攬人依規定採取必要措施。", "重大"),
    ("職業安全衛生設施規則第258條第1項第1款",
     "雇主使勞工從事高壓電氣設備檢查作業，未使勞工戴用完善的絕緣用防護具（僅手部配戴），致勞工碰觸帶電部分而發生感電。", "重大"),
    ("職業安全衛生設施規則第225條第1項",
     "於高度2公尺以上之處所進行作業，未設置適當之工作台。", "中度"),
    ("起重升降機具安全規則第63條",
     "從事吊掛作業，未指派具備資格之吊掛作業指揮人員。", "中度"),
    ("職業安全衛生法第23條第1項",
     "未依其事業規模、性質，訂定職業安全衛生管理計畫，據以執行。", "輕微"),
    ("職業安全衛生教育訓練規則第17條",
     "未對新僱勞工施以從事工作及預防災變所必要之一般安全衛生教育訓練。", "輕微"),
    ("職業安全衛生設施規則第21條之2",
     "工作場所之人行道、車行道與鐵道，未有安全區隔及標示，勞工有遭撞擊之虞。", "中度"),
    ("職業安全衛生管理辦法第12條之1",
     "未依規定訂定自動檢查計畫並實施自動檢查，相關紀錄亦未留存。", "輕微"),
]

SURNAMES = "陳林黃張李王吳劉蔡楊許鄭謝洪郭邱曾廖賴徐周葉蘇莊呂江何"
GIVEN = ["志明", "淑芬", "俊宏", "雅婷", "建宏", "美玲", "文雄", "怡君", "宗翰", "佳蓉",
         "冠廷", "詩涵", "承翰", "欣怡", "家豪", "淑惠", "柏翰", "郁婷", "彥廷", "筱涵"]

PREFIX = ["宏", "泰", "昌", "利", "順", "冠", "鉅", "翔", "京", "鼎", "誠", "軒", "永", "喬", "新"]
SUFFIX = ["達", "陽", "陞", "隆", "全", "興", "泰", "豐", "順", "發", "揚", "昇", "茂", "邦", "光"]
KIND = ["營造股份有限公司", "工程有限公司", "實業股份有限公司", "機電工程有限公司",
        "鋼鐵股份有限公司", "建設股份有限公司", "企業有限公司", "科技股份有限公司",
        "食品有限公司", "物流股份有限公司", "紡織股份有限公司", "金屬工業股份有限公司"]
INDUSTRY = ["營造業", "製造業", "批發及零售業", "運輸及倉儲業", "住宿及餐飲業", "其他服務業"]
ROADS = ["中山路", "中正路", "民生路", "民權路", "文化路", "光復路", "建國路", "復興路",
         "自由路", "成功路", "和平路", "忠孝路", "仁愛路", "信義路"]


def mask(name: str) -> str:
    """人名遮罩。假資料也一律遮，養成習慣——真實資料上線時不會忘。"""
    return name[0] + "○" * (len(name) - 1) if len(name) > 1 else name


def make(rng: random.Random, i: int) -> dict:
    county = rng.choices(list(COUNTIES), weights=WEIGHTS, k=1)[0]
    lat0, lng0, spread = COUNTIES[county]

    law, text, severity = rng.choice(VIOLATIONS)

    # 重大情節才比較可能有罹災人數，其餘多半是 0
    if severity == "重大":
        casualties = rng.choices([0, 1, 1, 2, 3], weights=[3, 5, 4, 2, 1], k=1)[0]
    elif severity == "中度":
        casualties = rng.choices([0, 1], weights=[7, 3], k=1)[0]
    else:
        casualties = 0

    disp = date(2022, 1, 1) + timedelta(days=rng.randint(0, 1300))
    ann = disp + timedelta(days=rng.randint(30, 400))

    # 刻意留下的壞情況：約 8% 沒有座標
    has_coord = rng.random() > 0.08
    lat = round(lat0 + rng.uniform(-spread, spread), 6) if has_coord else None
    lng = round(lng0 + rng.uniform(-spread, spread), 6) if has_coord else None

    # 少數即使有座標也沒有原始地址文字
    # 假資料不編行政區，避免出現「雲林縣安南區」這種不存在的組合，
    # 讓看資料的人以為是程式的 bug。
    location = (
        f"{county}{rng.choice(ROADS)}{rng.randint(1, 480)}號"
        if rng.random() > 0.12 else None
    )

    # 少數紀錄的敘述特別長，用來測 Popup 的換行與截斷
    if rng.random() < 0.10:
        text = (
            text
            + "另查該事業單位前經勞動檢查發現同類缺失，並經以書面通知限期改善，"
            + "屆期複查時仍未完成改善，且未提出具體改善計畫；審酌其違反情節、"
            + "所生危害程度、應受責難程度及資力狀況，認情節重大，依法從重處分。"
        )

    company = rng.choice(PREFIX) + rng.choice(SUFFIX) + rng.choice(KIND)
    principal = rng.choice(SURNAMES) + rng.choice(GIVEN)

    return {
        "id": f"osha_{i:04d}",
        "county": county,
        "announced_date": ann.isoformat(),
        "disposition_date": disp.isoformat(),
        "doc_no": f"府勞檢字第{rng.randint(1100000000, 1159999999)}號",
        "employer": company,
        "principal": mask(principal),
        "law": law,
        "violation": text,
        "fine": rng.choice([30000, 50000, 60000, 100000, 150000, 200000, 300000]),
        "severity": severity,
        "casualties": casualties,
        "incident_date": (disp - timedelta(days=rng.randint(5, 120))).isoformat() if casualties else None,
        "location": location,
        "lat": lat,
        "lng": lng,
        "industry": rng.choice(INDUSTRY),
        "appeal": rng.choice([None, None, None, None, "訴願駁回", "訴願審理中"]),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="產生職安地圖用的假資料")
    ap.add_argument("--n", type=int, default=200, help="筆數，預設 200")
    ap.add_argument("--seed", type=int, default=20260902, help="亂數種子，固定才能重現")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    doc = {
        "generated_at": date.today().isoformat(),
        "source": "勞動部違反勞動法令事業單位查詢系統（本檔為開發用假資料）",
        "source_url": "https://announcement.mol.gov.tw/",
        "is_mock": True,
        "incidents": [make(rng, i + 1) for i in range(args.n)],
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")

    inc = doc["incidents"]
    no_coord = sum(1 for x in inc if x["lat"] is None)
    zero_cas = sum(1 for x in inc if x["casualties"] == 0)
    long_txt = sum(1 for x in inc if len(x["violation"]) > 100)
    print(f"寫入 {OUT}")
    print(f"  {len(inc)} 筆")
    print(f"  無座標 {no_coord} 筆（{no_coord/len(inc):.0%}）—— 她的程式要跳過")
    print(f"  罹災 0 人 {zero_cas} 筆（{zero_cas/len(inc):.0%}）—— 還是要畫")
    print(f"  敘述超過 100 字 {long_txt} 筆 —— Popup 要能處理")


if __name__ == "__main__":
    main()
