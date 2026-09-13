"""把商工登記地址比對到門牌經緯度。

    python -m tools.geocode            # 全部職安法的地址
    python -m tools.geocode --pilot 200  # 只跑 200 條路，試水溫

要先有：
    data/addr_osha.csv  ← python -m pipeline.geo --export-addr
產出 data/geocode.csv（address, lat, lng, level）。

────────────────────────────────────────────────────────────────
為什麼是這份資料
────────────────────────────────────────────────────────────────
地址轉經緯度在台灣意外地難拿：

    職安法的「發生地點」欄位        填寫率 0.25%（74,658 筆只有 189 筆）
    data.gov.tw 的門牌坐標          各縣市各自上架，缺台中、彰化
    國土測繪中心開放 API            只有座標→村里，地址→座標要金鑰
    TGOS 全國門牌位置比對服務       技術上完全合用，但**申請對象不含個人**

最後用的是 taiwan-address-data（BSD 授權，原始來源就是 TGOS），
一條路一個檔：roads/{縣市代碼}-{路名}.csv，欄位含 X（經度）、Y（緯度）。
等於別人已經把那道申請門檻合法地繞過去了。

⚠ 這支要連 github.com。**本機的 Linux VM 連不到**，要在 Windows 的 venv 跑。

────────────────────────────────────────────────────────────────
實測結果（2026-09-13，24,819 個相異地址）
────────────────────────────────────────────────────────────────
    門牌精確   18,261   74.7%
    退到路名    4,759   19.5%
    抓不到      1,421    5.8%

⚠ 第一版是 67.8% / 16.4% / 15.8%，而且**失敗率照城鄉分佈**
  （台北抓不到 0.4%，彰化 47.6%，嘉義縣 71.4%）。
  那樣畫出來會讓人以為鄉下違規少，其實是定位失敗。
  三個 bug 全是解析端的，修完彰化掉到 6.9%：

    1. 「前鎮區」被斷成「前鎮」（鎮結尾），剩下「區民權二路」
    2. 來源寫「臺灣大道」，我們的正規化把臺換成台 → 整條路抓不到
    3. 只剝「里」沒剝「村」—— 鄉下用村，這是城鄉偏差的主因

  **定位失敗率有沒有系統性偏差，一定要按縣市拆開看。** 只看總成功率
  會得到「84% 很不錯」的結論，然後畫出一張帶偏見的圖。
"""
from __future__ import annotations

import csv
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import concurrent.futures as cf
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import use_utf8_stdout                                 # noqa: E402

SRC = Path("data/addr_osha.csv")
OUT = Path("data/geocode.csv")
BASE = "https://raw.githubusercontent.com/zhengda/taiwan-address-data/master/roads/"

# 縣市代碼。⚠ 這張表是**實際抓檔案驗證過**的，不是照公開文件抄的 ——
#   每一個代碼都抓了一條路，讀 FULL_ADDR 的前三個字確認。
CID = {"連江縣": "09007", "金門縣": "09020", "宜蘭縣": "10002", "新竹縣": "10004",
       "苗栗縣": "10005", "彰化縣": "10007", "南投縣": "10008", "雲林縣": "10009",
       "嘉義縣": "10010", "屏東縣": "10013", "台東縣": "10014", "花蓮縣": "10015",
       "澎湖縣": "10016", "基隆市": "10017", "新竹市": "10018", "嘉義市": "10020",
       "台北市": "63", "高雄市": "64", "新北市": "65", "台中市": "66",
       "台南市": "67", "桃園市": "68"}

COUNTIES = list(CID)

# ⚠ 「區」要先試而且要貪婪。允許非貪婪的 [區鄉鎮市] 會把「前鎮區」斷成「前鎮」。
TOWN_QU = re.compile(r"^(.{1,3}區)")
TOWN_OTHER = re.compile(r"^(.{1,3}?[鄉鎮市])")

TAIL = re.compile(r"^(?:(?P<sec>[一二三四五六七八九十]|\d+)段)?"
                  r"(?:(?P<lane>\d+)巷)?"
                  r"(?:(?P<alley>\d+)弄)?"
                  r"(?:\d+衖)?"
                  r"(?P<num>\d+(?:之\d+)?)號")

CN = {"一": "1", "二": "2", "三": "3", "四": "4", "五": "5",
      "六": "6", "七": "7", "八": "8", "九": "9", "十": "10"}

# 台灣的經緯度範圍（含外島）。⚠ 用來濾來源資料的髒點。
LAT, LNG = (21.5, 26.4), (118.0, 122.2)


def split_addr(a: str):
    """地址 → (縣市, 鄉鎮市區, 路名, 門牌尾段)。

    ⚠ 縣市不一定在開頭 ——「中部科學園區台中市后里區…」這種前綴真的存在。
    """
    pos = county = None
    for c in COUNTIES:
        i = a.find(c)
        if i >= 0 and (pos is None or i < pos):
            pos, county = i, c
    if county is None:
        return None
    rest = a[pos + 3:]
    m = TOWN_QU.match(rest) or TOWN_OTHER.match(rest)
    if not m:
        return None
    town = m.group(1)
    rest = rest[len(town):]
    rest = re.sub(r"^.{1,4}?[里村]", "", rest)     # 里跟村都要剝
    rest = re.sub(r"^\d+鄰", "", rest)
    road = re.split(r"\d", rest)[0]
    tail = rest[len(road):]
    road = re.sub(r"[一二三四五六七八九十]段$", "", road)
    return (county, town, road, tail) if road else None


def _key(sec, lane, alley, num):
    return f"{CN.get(sec, sec) if sec else ''}|{lane or ''}|{alley or ''}|{num or ''}"


def src_key(r: dict) -> str:
    strip = lambda k, s: (r.get(k) or "").replace(s, "")
    return _key(strip("SECTION", "段"), strip("LANE", "巷"),
                strip("ALLEY", "弄"), strip("NUMBER", "號"))


def _get(url: str, tries: int = 3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=45) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            if getattr(e, "code", None) == 404:
                return None
            time.sleep(1.5 * (i + 1))
    return None


def fetch_road(cid: str, road: str):
    """⚠ 台／臺兩種都要試。我們的正規化把臺換成台，來源資料用的是臺。"""
    for v in dict.fromkeys([road, road.replace("台", "臺"), road.replace("臺", "台")]):
        t = _get(BASE + urllib.parse.quote(f"{cid}-{v}.csv"))
        if t is not None:
            return t
    return None


def main() -> int:
    use_utf8_stdout()
    pilot = None
    if "--pilot" in sys.argv:
        pilot = int(sys.argv[sys.argv.index("--pilot") + 1])
    if not SRC.exists():
        print(f"缺 {SRC}，先跑 python -m pipeline.geo --export-addr", file=sys.stderr)
        return 1

    addrs = sorted({r["address"] for r in csv.DictReader(SRC.open(encoding="utf-8"))})
    parsed = {a: split_addr(a) for a in addrs}
    ok = {a: p for a, p in parsed.items() if p}
    print(f"相異地址 {len(addrs):,}　拆得出 {len(ok):,}"
          f"（{100 * len(ok) / len(addrs):.1f}%）")

    by_road = defaultdict(list)
    for a, (county, _town, road, tail) in ok.items():
        by_road[(county, road)].append((a, tail))
    roads = sorted(by_road)
    if pilot:
        roads = roads[:pilot]
    print(f"要抓 {len(roads):,} 個路檔", flush=True)

    out: dict[str, tuple] = {}
    stat: Counter = Counter()
    t0 = time.time()

    def work(rk):
        county, road = rk
        return rk, (fetch_road(CID[county], road) if county in CID else None)

    with cf.ThreadPoolExecutor(12) as ex:
        for n, (rk, text) in enumerate(ex.map(work, roads), 1):
            wanted = by_road[rk]
            if not text:
                stat["路檔抓不到"] += len(wanted)
                continue
            good = []
            for r in csv.DictReader(text.splitlines()):
                try:
                    y, x = float(r["Y"]), float(r["X"])
                except (TypeError, ValueError, KeyError):
                    continue
                # ⚠ 髒點要在取用前濾掉。實測抓到座標掉到菲律賓外海（17.6N）、
                #   以及 TWD97 的公尺值（4796012）混進經緯度欄位。
                #   不先濾，壞點會被平均進「路名層級」座標，汙染一整條路，
                #   而且畫面上看不出來。
                if LAT[0] <= y <= LAT[1] and LNG[0] <= x <= LNG[1]:
                    good.append((r, (y, x)))
            exact = {src_key(r): p for r, p in good}
            pts = [p for _, p in good]
            mid = (sum(p[0] for p in pts) / len(pts),
                   sum(p[1] for p in pts) / len(pts)) if pts else None
            for a, tail in wanted:
                m = TAIL.match(tail or "")
                k = _key(m.group("sec"), m.group("lane"),
                         m.group("alley"), m.group("num")) if m else None
                if k and k in exact:
                    out[a] = exact[k] + ("門牌",)
                    stat["門牌精確"] += 1
                elif mid:
                    out[a] = mid + ("路名",)
                    stat["退到路名"] += 1
                else:
                    stat["路檔無座標"] += 1
            if n % 500 == 0:
                print(f"  {n:,}/{len(roads):,}　{time.time() - t0:.0f}s", flush=True)

    tot = sum(stat.values())
    print(f"\n耗時 {time.time() - t0:.0f}s")
    for k, v in stat.most_common():
        print(f"  {k:<10} {v:>7,}　{100 * v / tot:5.1f}%")

    # ── 定位失敗有沒有系統性偏差？按縣市拆開看 ──
    by_county = defaultdict(Counter)
    for a, p in ok.items():
        by_county[p[0]][out[a][2] if a in out else "抓不到"] += 1
    print(f"\n{'縣市':<8}{'地址':>7}{'門牌%':>8}{'路名%':>8}{'抓不到%':>9}")
    for c, cnt in sorted(by_county.items(),
                         key=lambda kv: 100 * kv[1]["門牌"] / sum(kv[1].values())):
        t = sum(cnt.values())
        print(f"{c:<8}{t:>7,}{100*cnt['門牌']/t:>8.1f}"
              f"{100*cnt['路名']/t:>8.1f}{100*cnt['抓不到']/t:>9.1f}")
    print("\n⚠ 上表是這支程式最重要的輸出。總成功率再高，只要失敗率照城鄉分佈，"
          "\n   畫出來就是一張「鄉下比較少違規」的假圖。")

    if pilot:
        print("\n（--pilot 模式，不寫檔）")
        return 0

    with OUT.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["address", "lat", "lng", "level"])
        for a, (lat, lng, lvl) in sorted(out.items()):
            w.writerow([a, f"{lat:.6f}", f"{lng:.6f}", lvl])
    print(f"\n→ {OUT}（{len(out):,} 筆）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
