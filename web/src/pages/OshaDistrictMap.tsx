/* ============================================================
   職安地圖（真實資料版）

   這一頁取代了 mock.osha.json 的示範資料。換掉的原因與代價：

     想畫的      每一筆職災的**發生地點**
     做不到      職安法 74,658 筆裡只有 189 筆填了發生地點（0.25%），
                 全台可用的座標大約 200 個
     改成畫      事業單位的**商工登記地址**所在鄉鎮市區，聚合成一個圓點

   ⚠ 這兩件事不一樣，而且在營造業差很遠（公司登記在台北、工地在桃園）。
     所以畫面上從標題、副標、圖例到每一個 Popup 都要寫「登記地址」。
     一張標示不清的地圖，比沒有地圖更糟 —— 它看起來很專業。

   ⚠ 圓點畫在「區的幾何中心」，不是任何一筆紀錄的實際位置。

   資料由 pipeline/geo.py 產出。她原本的逐筆版本保留在 OshaMap.tsx，
   篩選列與 Popup 的措辭都是從那支沿用過來的。
   ============================================================ */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  GeoJSON,
  CircleMarker,
  Marker,
  Popup,
  useMap,
} from "react-leaflet";
import { divIcon } from "leaflet";
import type { Feature, Geometry } from "geojson";
import type { Layer, PathOptions } from "leaflet";
import type { GeoJsonObject } from "geojson";
import type { DistrictDataset, DistrictRow } from "../types/geo";
import raw from "../data/osha_district.json";
import ptsRaw from "../data/points.json";
import Clusters from "./OshaClusters";
import type { PointDataset, Pt } from "../types/points";
import boundaries from "../data/tw_districts.json";
import hazardTable from "../data/hazards.json";

/**
 * 預設檢視用 bounds 讓 Leaflet 自己挑縮放，不要寫死 center + zoom。
 *
 * ⚠ 寫死 zoom 7 的下場：容器寬 1,000px 時，畫面橫向會塞進 11 個經度，
 *   而台灣本島只有 1.5 個經度寬 —— 結果整張圖七成是福建、琉球跟巴丹群島，
 *   台灣縮在中間一小條，所有圓點擠成一團看不出差別。
 *   用 bounds 的話，縮放會跟著容器實際大小算，換螢幕也不會歪。
 *
 * 範圍只框本島。金門（118.3E）與連江（26.1N）離太遠，
 * 框進來會讓整個本島再縮小一半 —— 那兩縣的資料還在圖上，縮小就看得到。
 */
/**
 * 界線圖層用我們自己的鄉鎮市區界。
 *
 * ⚠⚠ 2026-09-15 更正：這裡原本寫「**不打任何外部圖磚伺服器**」，
 *   但實測線上頁面會向 wmts.nlsc.gov.tw（內政部國土測繪中心）抓 16 張圖磚。
 *   底圖是後來加的，這段註解沒有跟著改 —— 於是專案裡多了一句
 *   **會被外部檢視當場戳破的假話**（2026-09-15 真的被戳了）。
 *
 *   圖磚本身沒問題：政府開放資料、合法可用、而且有地名標籤比純界線好看懂。
 *   要處理的是兩件事：
 *     1. 對外的說法改成「**查詢頁**零外部請求」，不要講整站。
 *     2. 它是外部依賴 —— 決賽當天 NLSC 掛掉或擋流量，底圖會空白。
 *        要嘛接受（界線圖層還在，不會整頁壞掉），要嘛改回純界線。
 *        這是 Nicole 的頁面，由她決定。
 *
 * ⚠ 原本用的是 tile.openstreetmap.org。上線之後整張圖變成一格一格的
 *   「Access blocked / 403」—— OSM 的圖磚是志工出錢跑的，有使用政策，
 *   公開網站直接打它會被封，而且是**部署之後才會知道**。
 *
 * 更根本的問題是它違反這個專案自己的原則：「不需要資料庫、不需要伺服器，
 * 展示當天不會因為後端掛掉而開天窗」。地圖頁偷偷開了一個對第三方的依賴，
 * 而那個依賴掛掉的時候，畫面上是一堆 403 而不是一張空白地圖 —— 更難看。
 *
 * 換成自己的界線之後：零外部請求、離線可用、換誰的網路都一樣。
 * 代價是沒有地名標籤（Popup 裡有區名補上）與 288 KB 的檔案
 * （gzip 後 78 KB，而且這一頁是 lazy 載入的，查詢頁不受影響）。
 */
const BOUNDARIES = boundaries as unknown as GeoJsonObject;

/**
 * 陸地要比海**亮**，不能反過來。
 *
 * ⚠ 第一版拿現成的 --surface / --surface-2 湊：淺色主題沒問題，
 *   但深色主題下 --surface(#161F27) 比 --surface-2(#1E2A33) 暗，
 *   整座島看起來像一個洞。
 *   淺色要「白陸地＋灰海」、深色要「灰陸地＋近黑海」——
 *   同一個 token 在兩個主題的明暗關係剛好相反，所以湊不出來。
 *   在 tokens.css 另外定義了 --map-land / --map-sea 兩個專用 token。
 */
/**
 * 底圖：內政部國土測繪中心「台灣通用電子地圖」（WMTS，政府開放資料）。
 *
 * ⚠ 不要換回 tile.openstreetmap.org —— 那是志工出錢跑的伺服器，有使用政策，
 *   公開網站直接打會被封，而且是部署之後才會知道（我們已經踩過一次，
 *   整張圖變成一格一格的「Access blocked / 403」）。
 *
 * ⚠ 圖磚是外部依賴，展示當天可能連不上。所以**我們自己的行政區界永遠疊在上面**：
 *   圖磚掛掉時畫面仍然是一張有邊界、有縣市名的地圖，
 *   不是空白、也不是一堆錯誤圖片。這是刻意的雙層設計，不要把任何一層拿掉。
 */
const BASEMAP_URL =
  "https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}";
const BASEMAP_ATTR =
  '圖資：<a href="https://maps.nlsc.gov.tw/">內政部國土測繪中心</a>';

/** 點位圖層時，行政區只畫界線不填色 —— 底圖跟圖釘才是主角。 */
const OUTLINE_ONLY = {
  color: "var(--line-strong)",
  weight: 0.7,
  fillOpacity: 0,
} as const;

const TAIWAN_BOUNDS: [[number, number], [number, number]] = [
  [21.85, 119.95],
  [25.35, 122.05],
];

/**
 * 建立地圖時用的安全初值。
 *
 * ⚠ **不要把 bounds 交給 MapContainer。** react-leaflet 的 bounds prop 是在
 *   「建立地圖的那一刻」就呼叫 fitBounds 的，而那一刻容器往往還沒有正確尺寸：
 *     尺寸偏小 → 算出來的縮放偏高 → 畫面只剩北台灣
 *     尺寸是 0 → 除以零 → 中心點變成 NaN → 丟出
 *                「Invalid LatLng object: (NaN, NaN)」→ **整個 React 樹掛掉、整頁空白**
 *   兩種都實際發生過，後者是在正式站上。
 *   所以建立時給固定的 center/zoom（永遠算得出來），真正的 fitBounds
 *   交給 KeepSized，等容器確定有尺寸之後才做。
 */
const INIT_CENTER: [number, number] = [23.7, 120.98];
const INIT_ZOOM = 7;

/**
 * 縣市標籤的落點：各縣市所有鄉鎮市區的面積加權形心。
 *
 * ⚠ 有四個是手動挪過的，因為「市」被「縣」包起來時兩個形心會疊在一起：
 *   新北市（台北市在它裡面）、嘉義縣（嘉義市在它裡面）、新竹縣（新竹市在它裡面）。
 *   挪過的落點仍在該縣市境內（新北→樹林三峽、嘉義縣→番路、新竹縣→尖石）。
 */
const COUNTY_LABELS: [string, number, number][] = [
  ["基隆市", 25.1427, 121.781], ["台北市", 25.083, 121.5534],
  ["新北市", 24.93, 121.42], ["桃園市", 24.9022, 121.2586],
  ["新竹市", 24.7866, 120.9485], ["新竹縣", 24.62, 121.25],
  ["苗栗縣", 24.483, 120.9232], ["台中市", 24.2382, 120.8932],
  ["彰化縣", 23.9585, 120.484], ["南投縣", 23.8429, 120.9822],
  ["雲林縣", 23.6853, 120.3802], ["嘉義市", 23.4805, 120.4481],
  ["嘉義縣", 23.42, 120.72], ["台南市", 23.1505, 120.3256],
  ["高雄市", 22.9994, 120.6202], ["屏東縣", 22.4841, 120.6767],
  ["宜蘭縣", 24.5705, 121.6404], ["花蓮縣", 23.7535, 121.3787],
  ["台東縣", 22.8624, 121.0412], ["澎湖縣", 23.5456, 119.5763],
  ["金門縣", 24.4515, 118.368], ["連江縣", 26.1784, 120.0465],
];

/** 沒有圖磚就沒有地名，所以自己畫。描邊用陸地色，壓在海上或陸上都看得見。 */
const countyIcon = (name: string) =>
  divIcon({
    className: "",
    iconSize: [0, 0],
    html:
      // ⚠ 底圖是淺色的（不管頁面是深色還是淺色主題），所以標籤顏色不能用
      //   --ink 系列 —— 深色主題下那是淺灰字，壓在淺色底圖上會看不見。
      //   --map-label / --map-label-halo 兩個主題同值，就是為了這件事。
      '<span style="position:absolute;transform:translate(-50%,-50%);' +
      "white-space:nowrap;font-size:11px;font-weight:700;letter-spacing:.02em;" +
      "color:var(--map-label);text-shadow:0 0 3px var(--map-label-halo)," +
      "0 0 3px var(--map-label-halo),0 0 3px var(--map-label-halo)," +
      '0 0 3px var(--map-label-halo);">' + name + "</span>",
  });

/** 危害型態代碼 → 名稱。分類在 pipeline/hazard.py 做，前端只查表。 */
const HAZARD_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(hazardTable as Record<string, { name: string }>)
    .map(([code, v]) => [code, v.name]),
);

/**
 * 算「每千家」的最低分母。
 *
 * ⚠ 沒有這道門檻的話，排行榜前幾名會全是只有幾十家公司的小區 ——
 *   一家公司被罰兩次就能衝到全國第一。那不是訊號，是分母太小。
 *   500 是人訂的，畫面上要寫出來。
 */
const MIN_BASE = 500;

type Metric = "count" | "rate" | "fatal";
type MapLayer = "points" | "density";

const METRIC_LABEL: Record<Metric, string> = {
  count: "裁處件數",
  rate: "每千家登記事業單位的裁處件數",
  fatal: "公告涉及死亡災害的件數",
};

/**
 * 數值 → 分級（0 = 無資料，1..5 由淺到深）。
 *
 * ⚠ 這一頁原本是在每個區的**幾何中心畫一個圓點**。那是錯的圖種：
 *   資料的單位是「一個行政區」，不是「一個地點」。放大到街道層級之後，
 *   那個圓點看起來像在宣稱「事情發生在這裡」，但它不代表任何一家公司的位置
 *   —— 實測 377 個形心裡有 9 個甚至落在自己的區外（凹形的區會這樣）。
 *   密度（每千家）本來就該用填色的面來表示，不是點。
 *
 * 分級用「相對於最大值的平方根」切，不是等距 —— 數值分布極度右偏
 * （五股區 193.7，中位數不到 30），等距切的話 90% 的區會全部落在第一級。
 */
const BINS = 5;

function binOf(value: number, max: number): number {
  if (!(value > 0) || !(max > 0)) return 0;
  const t = Math.sqrt(value / max);
  return Math.min(BINS, Math.max(1, Math.ceil(t * BINS)));
}

/**
 * 分級 → 行政區的填色不透明度。
 *
 * ⚠ 上限只到 0.42，比沒有底圖時淡很多 —— 底下是真實地圖，
 *   填太實等於把街道蓋掉，那就失去「在真實的地方」的意義了。
 */
const BIN_ALPHA = [0, 0.1, 0.18, 0.26, 0.34, 0.42];

/**
 * 圓點半徑（像素）。用平方根是因為人眼看的是**面積**不是半徑。
 *
 * ⚠ 這個圓點是**該區的代表點**，不是任何一筆紀錄的位置 ——
 *   它畫在行政區的幾何中心。所以行政區的淡填色一定要留著：
 *   那是在告訴使用者「這個數字屬於整片區域」，
 *   不是屬於圓點底下那棟建築物。兩層是一組的，不要只留一層。
 */
function radiusFor(value: number, max: number): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return 3 + Math.sqrt(value / max) * 13;
}

/**
 * 比例的 ±2 個標準誤（回傳單位與 rate 相同：每千家）。
 *
 * 這是專案的規矩：每一次比例的比較都要看 2 個標準誤。
 * 五股區 193.7 跟觀音區 117.5 看起來差很多，但要先確認差距大於誤差。
 */
function rateSE2(n: number, base: number): number {
  if (base <= 0) return 0;
  const p = n / base;
  return 2 * Math.sqrt(Math.max(p * (1 - p), 0) / base) * 1000;
}

/**
 * ⚠⚠ 這個元件不是裝飾，沒有它整張圖在正式站上是**空白的**，或是縮放錯的。
 *
 * Leaflet 建立地圖時量一次容器尺寸就**快取起來**，之後只有 invalidateSize()
 * 或視窗 resize 才會重算。這一頁踩過的兩種災情都來自那一次量錯：
 *
 *   量到 0 寬   → 裁切範圍 0 寬 → 每個圖形的 d 都變成 "M0 0"
 *                 DOM 裡 667 個 path 都在、一個錯誤都沒有、畫面全空
 *
 *   量到過大   → 縮放算得太高 → 畫面只剩北台灣
 *                 成因：leaflet.css 還沒載入時，.leaflet-pane 的
 *                 position:absolute 還不存在，667 個圖形與 22 個標籤
 *                 用正常文件流排開，容器被撐成好幾千 px 高。
 *
 * ⚠ 第二種特別陰險，因為**尺寸後來會自己修好**（CSS 一載入容器就縮回正常，
 *   ResizeObserver 也確實更新了 Leaflet 的尺寸）——錯的只剩縮放。
 *   所以「只在第一次套用預設檢視」是錯的設計：第一次正是最不可信的那一次。
 *
 * 現在的規則：**在使用者自己動地圖之前，每次尺寸變化都重新套用預設檢視。**
 * 使用者一旦拖曳、縮放或按下 +／−，就不再自動重設 —— 不然他放大到某個區
 * 在看，一改視窗大小就被彈回全台，那比不會自動調整更煩。
 *
 * 「使用者動過」是用容器上的真實輸入事件判斷的（pointerdown／wheel／keydown），
 * 不是用 Leaflet 的 zoomstart —— 因為 fitBounds 自己也會觸發 zoomstart，
 * 用那個判斷會變成「第一次自動 fit 之後就再也不 fit」，等於繞回原來的 bug。
 */
function KeepSized({ bounds }: { bounds: [[number, number], [number, number]] }) {
  const map = useMap();
  const userMoved = useRef(false);

  useEffect(() => {
    const el = map.getContainer();
    const markUser = () => {
      userMoved.current = true;
    };

    const sync = () => {
      map.invalidateSize({ animate: false });
      if (userMoved.current) return;
      if (el.clientWidth <= 0 || el.clientHeight <= 0) return;
      map.fitBounds(bounds, { padding: [10, 10], animate: false });
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);

    el.addEventListener("pointerdown", markUser, { passive: true });
    el.addEventListener("wheel", markUser, { passive: true });
    el.addEventListener("keydown", markUser);

    return () => {
      ro.disconnect();
      el.removeEventListener("pointerdown", markUser);
      el.removeEventListener("wheel", markUser);
      el.removeEventListener("keydown", markUser);
    };
  }, [map, bounds]);

  return null;
}

export default function OshaDistrictMap() {
  const data = raw as unknown as DistrictDataset;

  const [layer, setLayer] = useState<MapLayer>("points");
  const [fatalOnly, setFatalOnly] = useState(false);
  const [metric, setMetric] = useState<Metric>("rate");
  const [selected, setSelected] = useState<DistrictRow | null>(null);
  const [hazardFilter, setHazardFilter] = useState<string>("");
  const [countyFilter, setCountyFilter] = useState<string>("");

  /** 點位資料。⚠ hazmask 的位元順序以檔案裡的 haz_order 為準，不要另外寫死一份。 */
  const pdata = ptsRaw as unknown as PointDataset;
  const hazBit = useMemo(() => {
    const m: Record<string, number> = {};
    pdata.haz_order.forEach((c, i) => (m[c] = 1 << i));
    return m;
  }, [pdata]);

  const allPoints = useMemo<Pt[]>(
    () =>
      pdata.pts.map((p) => ({
        name: p[0], lat: p[1], lng: p[2], exact: p[3] === 1,
        n: p[4], fatal: p[5], pending: p[6], haz: p[7], year: p[8], mask: p[9],
      })),
    [pdata],
  );

  const points = useMemo(() => {
    const bit = hazardFilter ? hazBit[hazardFilter] ?? 0 : 0;
    return allPoints.filter((p) => {
      if (fatalOnly && p.fatal <= 0) return false;
      // ⚠ 用 mask 不是 p.haz —— p.haz 只是「最主要」的那一種，
      //   拿它來篩會變成「主要危害是感電的公司」，數字會少報。
      if (bit && !(p.mask & bit)) return false;
      return true;
    });
  }, [allPoints, hazardFilter, fatalOnly, hazBit]);

  const counties = useMemo(
    () => Array.from(new Set(data.rows.map((r) => r.k.slice(0, 3)))).sort(
      (a, b) => a.localeCompare(b, "zh-Hant")),
    [data],
  );

  const hazards = useMemo(() => {
    const seen = new Set<string>();
    for (const r of data.rows) for (const h of Object.keys(r.haz)) seen.add(h);
    return [...seen]
      .filter((h) => HAZARD_NAME[h])
      .sort((a, b) => HAZARD_NAME[a].localeCompare(HAZARD_NAME[b], "zh-Hant"));
  }, [data]);

  /** 這個區在目前的篩選條件下有幾筆。沒選危害型態就是全部職安法。 */
  const countOf = useMemo(
    () => (r: DistrictRow) => (hazardFilter ? r.haz[hazardFilter] ?? 0 : r.n),
    [hazardFilter],
  );

  const rows = useMemo(() => {
    let out = data.rows;
    if (countyFilter) out = out.filter((r) => r.k.startsWith(countyFilter));
    if (metric === "rate") out = out.filter((r) => r.base >= MIN_BASE);
    return out;
  }, [data, countyFilter, metric]);

  /** 每個區在目前設定下要畫多大。fatal 不受危害型態篩選影響，所以要分開。 */
  /**
   * 同一個篩選條件下，涉及死亡災害的筆數。
   *
   * ⚠ 篩了危害型態就一定要用 hazf，不能用 r.fatal。
   *   不然畫面會變成「合計 3,404 筆（感電），其中 1,959 筆涉及死亡災害」——
   *   兩個數字各自都對，放在一起卻在回答一個沒有人問的問題。
   */
  const fatalOf = useMemo(
    () => (r: DistrictRow) => (hazardFilter ? r.hazf[hazardFilter] ?? 0 : r.fatal),
    [hazardFilter],
  );

  /** 同理，行政救濟尚未終結的筆數也要跟著篩，不然會變成另一個同樣的錯。 */
  const pendingOf = useMemo(
    () => (r: DistrictRow) => (hazardFilter ? r.hazp[hazardFilter] ?? 0 : r.pending),
    [hazardFilter],
  );

  const valueOf = useMemo(
    () => (r: DistrictRow): number => {
      if (metric === "fatal") return fatalOf(r);
      const n = countOf(r);
      return metric === "rate" ? (r.base > 0 ? (1000 * n) / r.base : 0) : n;
    },
    [metric, countOf, fatalOf],
  );

  const max = useMemo(
    () => rows.reduce((m, r) => Math.max(m, valueOf(r)), 0),
    [rows, valueOf],
  );

  /** 目前畫得出來的區：key → 資料列。被篩掉的區不在裡面，就不填色。 */
  const shown = useMemo(() => {
    const m = new Map<string, DistrictRow>();
    for (const r of rows) m.set(r.k, r);
    return m;
  }, [rows]);

  /** 行政區的填色。沒有資料（或被篩掉）的區維持陸地本色。 */
  const styleFor = useMemo(
    () =>
      (feature?: Feature<Geometry, { k: string }>): PathOptions => {
        const r = feature && shown.get(feature.properties.k);
        const bin = r ? binOf(valueOf(r), max) : 0;
        // ⚠ 沒資料的區 fillOpacity 要是 0，不是填成陸地色 ——
        //   底下有底圖，填實了等於把地圖蓋掉。
        return {
          color: "var(--line-strong)",
          weight: 0.8,
          fillColor: metric === "fatal" ? "var(--sev-high)" : "var(--accent)",
          fillOpacity: bin === 0 ? 0 : BIN_ALPHA[bin],
        };
      },
    [shown, valueOf, max, metric],
  );

  /**
   * 點一個區就開它的 Popup。
   * ⚠ 用 useMemo 綁在同一組相依上，並且讓 GeoJSON 的 key 一起變 ——
   *   不然 onEachFeature 會抓到舊的 closure，點出來是上一次篩選的數字。
   */
  const onEachFeature = useMemo(
    () => (feature: Feature<Geometry, { k: string }>, layer: Layer) => {
      layer.on("click", () => setSelected(shown.get(feature.properties.k) ?? null));
    },
    [shown],
  );

  /**
   * 篩選條件一改就把開著的 Popup 關掉。
   * ⚠ 不關的話，被篩掉的區（例如切到「每千家」之後分母不足的區）
   *   的 Popup 還開著，畫面上會有一個地圖上已經不存在的區在報數字。
   */
  useEffect(() => {
    setSelected((cur) => (cur && shown.has(cur.k) ? cur : null));
  }, [shown]);

  const ranked = useMemo(
    () => [...rows].sort((a, b) => valueOf(b) - valueOf(a)),
    [rows, valueOf],
  );

  const top = useMemo(() => ranked.slice(0, 10), [ranked]);

  const stats = useMemo(() => {
    const shown = rows.filter((r) => valueOf(r) > 0);
    return {
      districts: shown.length,
      records: rows.reduce((s, r) => s + countOf(r), 0),
      fatal: rows.reduce((s, r) => s + fatalOf(r), 0),
      pending: rows.reduce((s, r) => s + pendingOf(r), 0),
    };
  }, [rows, valueOf, countOf, fatalOf, pendingOf]);

  return (
    <div>
      <h1 style={{ marginTop: 0, fontSize: 24 }}>職業安全衛生裁處分布圖</h1>

      {/* ⚠ 這一塊是紅線，不是版面裝飾。拿掉它這張圖就會被讀成職災地圖。 */}
      <div
        style={{
          background: "var(--warn-soft)",
          color: "var(--on-warn-soft)",
          border: "1px solid var(--warn)",
          borderRadius: 10,
          padding: "10px 14px",
          margin: "0 0 14px",
          lineHeight: 1.7,
        }}
      >
        <strong>
          {layer === "points"
            ? "圖釘是事業單位的「商工登記地址」，不是職災的發生地點。"
            : "顏色深淺是依事業單位的「商工登記地址」歸戶到行政區，不是職災的發生地點。"}
        </strong>
        <br />
        職安法的 {data.osha_total.toLocaleString()} 筆公告裡，只有 189 筆填了發生地點（0.25%），
        無法用來定位。公司登記在台北、工地在桃園是營造業的常態，
        所以這張圖回答的是「被處分的事業單位登記在哪裡」，
        不是「哪裡容易出事」。
        {layer === "points" ? (
          <>
            {" "}
            <b>圖釘落在真實門牌上，所以特別容易被誤讀</b>——那是一棟具體的建築物，
            但它可能只是登記處所（會計師事務所、負責人住家），與違規事實發生的位置無關。
          </>
        ) : (
          " 整個行政區一起上色，是因為這份資料的解析度就是「一個區」——再細的位置我們沒有，也不會假裝有。"
        )}
      </div>

      <p className="sw-muted" style={{ marginTop: -4 }}>
        資料來源：{data.source}（{data.generated_at} 產出）
        {" · "}
        {data.osha_mapped.toLocaleString()} / {data.osha_total.toLocaleString()} 筆
        職安法裁處可歸到鄉鎮市區（
        {((100 * data.osha_mapped) / data.osha_total).toFixed(1)}%），
        分布在 {data.districts} 個區
        {layer === "points" && (
          <>
            {" · "}
            座標由地址比對 taiwan-address-data（BSD 授權，原始來源為內政部 TGOS）取得
          </>
        )}
      </p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "4px 0 14px" }}>
        <label>
          圖層：
          <select value={layer} onChange={(e) => setLayer(e.target.value as MapLayer)}>
            <option value="points">事業單位位置</option>
            <option value="density">行政區密度</option>
          </select>
        </label>

        {layer === "points" && (
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="checkbox"
              checked={fatalOnly}
              onChange={(e) => setFatalOnly(e.target.checked)}
            />
            只看有涉及死亡災害的事業單位
          </label>
        )}

        <label style={{ display: layer === "density" ? undefined : "none" }}>
          密度指標：
          <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            <option value="rate">{METRIC_LABEL.rate}</option>
            <option value="count">{METRIC_LABEL.count}</option>
            <option value="fatal">{METRIC_LABEL.fatal}</option>
          </select>
        </label>

        <label>
          危害型態：
          <select
            value={hazardFilter}
            onChange={(e) => setHazardFilter(e.target.value)}
          >
            <option value="">全部</option>
            {hazards.map((h) => (
              <option key={h} value={h}>
                {HAZARD_NAME[h]}
              </option>
            ))}
          </select>
        </label>

        <label>
          縣市：
          <select value={countyFilter} onChange={(e) => setCountyFilter(e.target.value)}>
            <option value="">全部</option>
            {counties.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>

      {layer === "points" ? (
        <p className="sw-muted" style={{ margin: "0 0 12px", fontWeight: 600 }}>
          目前 {points.length.toLocaleString()} 家事業單位在圖上，合計{" "}
          {points.reduce((a, p) => a + p.n, 0).toLocaleString()} 筆職安法裁處
          {" · "}
          其中 {points.reduce((a, p) => a + p.fatal, 0).toLocaleString()} 筆公告涉及死亡災害
          {" · "}
          定位精度：門牌 {pdata.exact_n.toLocaleString()} 家（
          {((100 * pdata.exact_n) / pdata.total).toFixed(1)}%）、其餘為路名層級
          {" · "}
          另有 {(data.osha_mapped - pdata.pts.reduce((a, p) => a + p[4], 0)).toLocaleString()}
          {" "}筆裁處的事業單位地址對不到座標，未出現在本圖層
        </p>
      ) : (
      <p className="sw-muted" style={{ margin: "0 0 12px", fontWeight: 600 }}>
        目前 {stats.districts} 個區有資料，合計 {stats.records.toLocaleString()} 筆
        {stats.fatal > 0 && `，其中 ${stats.fatal.toLocaleString()} 筆公告涉及死亡災害`}
        {stats.pending > 0 && ` · ${stats.pending.toLocaleString()} 筆行政救濟尚未終結`}
        {metric === "rate" &&
          ` · 只列入現存登記事業單位 ${MIN_BASE} 家以上的區（分母太小的率不可靠）`}
      </p>
      )}

      {/*
        ⚠ 地圖要限寬，不能撐滿版面。
          台灣本島只有 2.1 個經度寬、3.5 個緯度高 —— 一個 1,000px 寬的框
          在高度剛好裝下台灣時，橫向會多出 5 個經度的海，
          畫面七成是福建跟太平洋。限寬到 660px 之後比例才接近本島本身
          （本島會佔滿高度的九成、寬度的一半左右，那就是台灣的長相）。
      */}
      <div
        style={{
          height: "70vh",
          minHeight: 440,
          maxWidth: 660,
          margin: "0 auto",
          borderRadius: 14,
          overflow: "hidden",
          border: "1px solid var(--line)",
          boxShadow: "var(--shadow)",
        }}
      >
        <MapContainer
          center={INIT_CENTER}
          zoom={INIT_ZOOM}
          /*
           * ⚠ zoomSnap 預設是 1，縮放只能是整數級。
           *   本島在這個框裡剛好卡在 7 跟 8 中間 —— 只能取整數的話
           *   會退回 7，然後台灣又縮成一小條。改成 0.25 才吃得到 7.75。
           */
          zoomSnap={0.25}
          minZoom={6}
          /* 圖磚還沒載入（或載不到）時看到的底色 */
          style={{ height: "100%", width: "100%", background: "var(--map-sea)" }}
          /*
           * 滾輪縮放維持開啟 —— 這是實際使用後決定的。
           *
           * 已知的取捨：地圖有 66vh 高，游標停在地圖上時滾輪會縮放而不是
           * 捲頁面，要看下面的排行榜得先把游標移出地圖。
           * 如果哪天覺得卡（特別是展示或錄影時滾一下地圖就跳掉），
           * 把這行改成 scrollWheelZoom={false} 即可，其餘不用動。
           */
          scrollWheelZoom
        >
          <KeepSized bounds={TAIWAN_BOUNDS} />
          <TileLayer url={BASEMAP_URL} attribution={BASEMAP_ATTR} maxZoom={20} />
          {COUNTY_LABELS.map(([name, lat, lng]) => (
            <Marker
              key={name}
              position={[lat, lng]}
              icon={countyIcon(name)}
              interactive={false}
              keyboard={false}
            />
          ))}

          {/*
            ⚠ 資料圖層是**面**，不是點。
              每個行政區用自己的形狀填色，所以放大到任何倍率都不會出現
              「這個點宣稱事情發生在這裡」的問題 —— 整個區都被塗到，
              那才是這份資料真正的解析度。
              key 要含 metric／篩選條件：react-leaflet 的 GeoJSON 不會因為
              style 函式變了就重畫，要換 key 強制重建。
          */}
          {/* 行政區永遠畫界線；只有密度圖層才填色。 */}
          <GeoJSON
            key={`v-${layer}-${metric}-${hazardFilter}-${countyFilter}-${max}`}
            data={BOUNDARIES}
            style={layer === "density" ? styleFor : () => OUTLINE_ONLY}
            onEachFeature={layer === "density" ? onEachFeature : undefined}
            interactive={layer === "density"}
          />

          {layer === "points" && (
            <Clusters points={points} hazName={(c) => HAZARD_NAME[c] ?? c} />
          )}

          {/*
            行政區代表點。⚠ 只在密度圖層出現 —— 點位圖層已經有真實門牌的
            圖釘了，再疊一層「區中心的點」會讓人分不清哪個是真的位置。
            大圓先畫、小圓後畫，小區才不會被鄰居蓋住點不到。
          */}
          {layer === "density" && ranked.map((r) => {
            const v = valueOf(r);
            if (v <= 0) return null;
            return (
              <CircleMarker
                key={r.k}
                center={[r.lat, r.lng]}
                radius={radiusFor(v, max)}
                pathOptions={{
                  color: "var(--map-label-halo)",
                  weight: 1.2,
                  fillColor:
                    metric === "fatal" ? "var(--sev-high)" : "var(--accent-fill)",
                  fillOpacity: 0.85,
                }}
                eventHandlers={{ click: () => setSelected(r) }}
              />
            );
          })}

          {layer === "density" && selected && (
            <Popup
              position={[selected.lat, selected.lng]}
              eventHandlers={{ remove: () => setSelected(null) }}
            >
              <div style={{ minWidth: 230, lineHeight: 1.65 }}>
                      <strong>{selected.k}</strong>
                      <div style={{ color: "var(--ink-3)", fontSize: 12 }}>
                        以登記地址歸戶，非事故發生地點。
                        圓點是這個行政區的代表點，不是任何一筆紀錄的位置。
                      </div>
                      <hr style={{ margin: "6px 0", border: 0, borderTop: "1px solid var(--line)" }} />
                      <div>
                        職安法裁處
                        {hazardFilter && `（${HAZARD_NAME[hazardFilter]}）`}
                        ：{countOf(selected).toLocaleString()} 筆
                      </div>
                      {selected.base >= MIN_BASE ? (
                        <div>
                          每千家登記事業單位{" "}
                          {((1000 * countOf(selected)) / selected.base).toFixed(1)}
                          {" ± "}
                          {rateSE2(countOf(selected), selected.base).toFixed(1)}
                          <span style={{ color: "var(--ink-3)" }}>（±2SE）</span>
                        </div>
                      ) : (
                        <div style={{ color: "var(--ink-3)" }}>
                          現存登記事業單位僅 {selected.base.toLocaleString()} 家，
                          分母太小，不計算率
                        </div>
                      )}
                      {/* ⚠ 措辭固定：「涉及」不是「造成」。有些公告罰的是
                          「未於八小時內通報死亡災害」，寫成「造成死亡」
                          就是把通報違規講成殺人。 */}
                      {fatalOf(selected) > 0 && (
                        <div style={{ color: "var(--sev-high)", fontWeight: 700 }}>
                          其中 {fatalOf(selected)} 筆公告涉及死亡災害
                        </div>
                      )}
                      {pendingOf(selected) > 0 && (
                        <div style={{ color: "var(--warn)" }}>
                          {pendingOf(selected)} 筆行政救濟尚未終結，原處分是否維持仍待確定
                        </div>
                      )}
                      <div style={{ color: "var(--ink-2)", marginTop: 4 }}>
                        有裁處紀錄的事業單位 {selected.co.toLocaleString()} 家
                        {" / "}
                        現存登記 {selected.base.toLocaleString()} 家
                      </div>
                      <div style={{ marginTop: 4 }}>
                        主要危害型態：
                        {Object.entries(selected.haz)
                          .slice(0, 4)
                          .map(([h, c]) => `${HAZARD_NAME[h] ?? h} ${c}`)
                          .join("、") || "（本區無可歸類的職安法裁處）"}
                      </div>
                    </div>
            </Popup>
          )}
        </MapContainer>
      </div>

      {/* 圖例。顏色一旦拿來編碼數值就一定要有圖例，不然深淺只是裝飾。 */}
      <div
        hidden={layer !== "density"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          maxWidth: 660,
          margin: "10px auto 0",
          fontSize: 12,
          color: "var(--ink-2)",
        }}
      >
        <span>{METRIC_LABEL[metric]}：</span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <i
            style={{
              width: 16,
              height: 12,
              background: "transparent",
              border: "1px solid var(--line-strong)",
              display: "inline-block",
            }}
          />
          無資料
        </span>
        {[1, 2, 3, 4, 5].map((bin) => (
          <span key={bin} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <i
              style={{
                width: 16,
                height: 12,
                background: metric === "fatal" ? "var(--sev-high)" : "var(--accent)",
                opacity: BIN_ALPHA[bin],
                border: "1px solid var(--line-strong)",
                display: "inline-block",
              }}
            />
            {metric === "rate"
              ? (max * (bin / BINS) ** 2).toFixed(0)
              : Math.round(max * (bin / BINS) ** 2).toLocaleString()}
          </span>
        ))}
        <span style={{ color: "var(--ink-3)" }}>（上界）</span>
        <span style={{ color: "var(--ink-3)" }}>
          圓點大小同樣代表數值，位置是該行政區的中心
        </span>
      </div>

      <h2 style={{ fontSize: 17, margin: "20px 0 8px" }}>
        前 10 名 · {METRIC_LABEL[metric]}
        {hazardFilter && ` · 只看${HAZARD_NAME[hazardFilter]}`}
      </h2>
      {/*
        ⚠ 欄位固定，不隨「顯示」改變 —— 只有排序跟粗體會變。
          之前「顯示」選裁處件數時，第 2 欄和第 3 欄會印出一模一樣的數字
          （值＝裁處件數），看起來像程式壞掉。四個數字一起看也比較有用：
          率高是因為分子大還是分母小，一眼就看得出來。
      */}
      <table className="sw-table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>鄉鎮市區</th>
            <th style={{ textAlign: "right", fontWeight: metric === "rate" ? 800 : 500 }}>
              每千家{metric === "rate" && " ▼"}
            </th>
            <th style={{ textAlign: "right", fontWeight: metric === "count" ? 800 : 500 }}>
              裁處件數{metric === "count" && " ▼"}
            </th>
            <th style={{ textAlign: "right" }}>現存登記家數</th>
            <th style={{ textAlign: "right", fontWeight: metric === "fatal" ? 800 : 500 }}>
              涉及死亡災害{metric === "fatal" && " ▼"}
            </th>
          </tr>
        </thead>
        <tbody>
          {top.map((r) => (
            <tr key={r.k} style={{ borderTop: "1px solid var(--line)" }}>
              <td>{r.k}</td>
              <td style={{ textAlign: "right" }}>
                {r.base >= MIN_BASE ? (
                  <>
                    <strong>{((1000 * countOf(r)) / r.base).toFixed(1)}</strong>
                    <span style={{ color: "var(--ink-3)" }}>
                      {" ± "}
                      {rateSE2(countOf(r), r.base).toFixed(1)}
                    </span>
                  </>
                ) : (
                  <span style={{ color: "var(--ink-3)" }}>分母不足</span>
                )}
              </td>
              <td style={{ textAlign: "right" }}>{countOf(r).toLocaleString()}</td>
              <td style={{ textAlign: "right" }}>{r.base.toLocaleString()}</td>
              <td style={{ textAlign: "right" }}>{fatalOf(r).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="sw-muted" style={{ marginTop: 16, lineHeight: 1.8 }}>
        本頁僅呈現主管機關已公告之裁處紀錄的統計分布，不對任何事業單位或任何地區作出評價或認定。
        <br />
        名次高低同時受該地區的產業結構影響（工業區的營造與製造業比例高，
        本來就會有較多職安法裁處），不能單獨解讀為「這個地區比較危險」。
        <br />
        各縣市的資料公開期間長短不一（有些縣市不到 2 年，基隆市與新竹市的職安法一筆都沒有），
        跨地區比較請一併考慮這一點。
        <br />
        面量圖會放大大面積行政區的視覺份量（花蓮秀林鄉的面積是台北市中正區的數百倍），
        比較時請看數字，不要只看色塊大小。
        <br />
        底圖為內政部國土測繪中心「台灣通用電子地圖」；
        行政區界為簡化後的鄉鎮市區界（來源：g0v/twgeojson），
        不得用於任何界線或面積的認定。行政區界由本站自行提供，
        因此即使底圖服務暫時無法連線，邊界與資料仍然顯示得出來。
        <br />
        預設檢視只框住本島；金門縣與連江縣的資料也在圖上，要縮小才看得到。
        地圖可用滾輪、左上角的 + / − 或雙擊縮放。
      </p>
    </div>
  );
}
