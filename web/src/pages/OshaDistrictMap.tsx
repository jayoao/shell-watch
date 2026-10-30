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
  Circle,
  Marker,
  Popup,
  Pane,
  useMap,
} from "react-leaflet";
import { divIcon } from "leaflet";
import type { TileErrorEvent } from "leaflet";
import type { Feature, Geometry } from "geojson";
import type { Layer, PathOptions } from "leaflet";
import type { GeoJsonObject } from "geojson";
import type { DistrictDataset, DistrictRow } from "../types/geo";
import raw from "../data/osha_district.json";
import ptsUrl from "../data/points.json?url";
import Clusters from "./OshaClusters";
import type { PointDataset, Pt } from "../types/points";
import boundsUrl from "../data/tw_districts.json?url";
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
/* ⚠⚠ 這兩份資料**不再編進 JS**，改成執行時抓。
   原本 points.json（1,756 KB）與 tw_districts.json（281 KB）是
   `import` 進來的，Vite 會把它們轉成 JS 字面量塞進 chunk ——
   地圖頁的 chunk 因此是 2,373 KB，其中 91% 是資料不是程式。
   實測冷載傳輸 606 KB、下載 14.0 秒，整頁要 25 秒才能用，
   而查詢頁現在有一個連結指過來。

   改成 `?url` 之後：Vite 把它們當靜態檔發出去（帶內容雜湊、可快取、
   由 CDN 各自壓縮），JS 只剩程式。介面、篩選列與表格立刻就出來，
   圖層資料後補。

   ⚠ 這不是把問題搬家。分開之後三件事變了：
     一、JS 不必等資料下載完才能執行（原本是同一個檔案）
     二、資料檔可以獨立快取，改程式不會讓使用者重抓 2 MB
     三、兩份資料並行下載，不是串行
   ⚠ 抓失敗要看得出來，不可以安靜地畫一張空地圖。 */

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
/**
 * ⚠⚠ focus 一定要走這個元件，不可以另外寫一個 setView。
 *   KeepSized 的 ResizeObserver 只要沒被使用者接管，每次 resize 都會
 *   fitBounds 回全台 —— 外面另外呼叫 setView 的話，會被它一腳踢回去，
 *   而且是間歇性的（要等下一次 resize 才發作），最難查的那一種。
 *   所以視窗位置只有一個來源：這裡。
 */
function KeepSized({ bounds, focus }: {
  bounds: [[number, number], [number, number]];
  focus?: { lat: number; lng: number; zoom: number } | null;
}) {
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
      /* 從查詢頁帶了行政區進來就對準那一區，否則維持全台。
         ⚠ 13 級大約是一個行政區填滿畫面。再近會看不出它在哪個縣市，
         再遠就跟全台沒兩樣，那個連結等於沒作用。 */
      if (focus) map.setView([focus.lat, focus.lng], focus.zoom, { animate: false });
      else map.fitBounds(bounds, { padding: [10, 10], animate: false });
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
  }, [map, bounds, focus]);

  return null;
}

export default function OshaDistrictMap() {
  const data = raw as unknown as DistrictDataset;

  const [layer, setLayer] = useState<MapLayer>("points");
  const [fatalOnly, setFatalOnly] = useState(false);
  const [metric, setMetric] = useState<Metric>("rate");
  const [selected, setSelected] = useState<DistrictRow | null>(null);
  const [hazardFilter, setHazardFilter] = useState<string>("");
  // 版面：警語預設收合。⚠ 收的是理由，不是警告。
  const [why, setWhy] = useState(false);
  const [countyFilter, setCountyFilter] = useState<string>("");

  /**
   * 從查詢頁帶過來的鄉鎮市區：`/osha?d=台北市中正區`。
   *
   * ⚠⚠ 這兩頁原本完全沒有互連。使用者查完一家公司，想知道「這一帶
   *   的職安狀況如何」，只能自己回到地圖、自己在 365 個區裡面找。
   *
   * ⚠ 只讀一次。之後使用者在地圖上自己改篩選是他的操作，
   *   不可以被網址再蓋回去。
   * ⚠ 對不到就當作沒帶參數，不要跳錯誤 —— 地址推不出區是常態
   *   （郵政信箱、國外地址、舊式地名），那不是壞掉。
   */
  const qs = useMemo(
    () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search)),
    [],
  );

  const fromQuery = useMemo(() => {
    const d = qs?.get("d");
    if (!d) return null;
    return data.rows.find((r) => r.k === d) ?? null;
  }, [data, qs]);

  useEffect(() => {
    if (!fromQuery) return;
    const m = /^(.{2,3}[縣市])/.exec(fromQuery.k);
    if (m) setCountyFilter(m[1]);
    setSelected(fromQuery);
  }, [fromQuery]);

  /** 點位資料。⚠ hazmask 的位元順序以檔案裡的 haz_order 為準，不要另外寫死一份。 */
  const [pdata, setPdata] = useState<PointDataset | null>(null);
  const [bounds, setBounds] = useState<GeoJsonObject | null>(null);
  const [loadErr, setLoadErr] = useState<string>("");
  const [tileFail, setTileFail] = useState(false);

  useEffect(() => {
    let alive = true;
    // 兩份並行。⚠ 任何一份失敗都要講出來 ——
    // 靜默失敗的地圖跟「這一區沒有違規」長得一模一樣。
    void Promise.allSettled([
      fetch(ptsUrl).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
      fetch(boundsUrl).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
    ]).then(([p, b]) => {
      if (!alive) return;
      if (p.status === "fulfilled") setPdata(p.value as PointDataset);
      if (b.status === "fulfilled") setBounds(b.value as GeoJsonObject);
      const bad = [
        p.status === "rejected" ? "事業單位點位" : "",
        b.status === "rejected" ? "行政區界線" : "",
      ].filter(Boolean);
      if (bad.length) setLoadErr(bad.join("、"));
    });
    return () => { alive = false; };
  }, []);

  const hazBit = useMemo(() => {
    const m: Record<string, number> = {};
    (pdata?.haz_order ?? []).forEach((c, i) => (m[c] = 1 << i));
    return m;
  }, [pdata]);

  const allPoints = useMemo<Pt[]>(
    () =>
      (pdata?.pts ?? []).map((p) => ({
        name: p[0], lat: p[1], lng: p[2], exact: p[3] === 1,
        n: p[4], fatal: p[5], pending: p[6], haz: p[7], year: p[8], mask: p[9],
      })),
    [pdata],
  );

  /** 從查詢頁帶過來的公司名（`?c=`）。原字串，只拿來比對與顯示。 */
  const coName = qs?.get("c") ?? "";

  /**
   * 這家公司在點位檔裡的位置。
   *
   * ⚠⚠ `points.json` 只收**有職安法裁處、而且登記地址定位得出來**的
   *   事業單位（23,815 家）。站上共 176,268 家，所以有 86.5% 的公司
   *   在這裡查不到 —— 那不是錯誤，是這份資料的範圍。查不到就退回鄉鎮市區，
   *   並且要講出來為什麼，不可以安靜地顯示一張全台地圖。
   *
   * ⚠ 這裡也做一次台／臺 正規化。產出端（pipeline/points.py）已經合併過了，
   *   所以正常情況下只會命中一筆 —— 留著是因為查詢頁傳過來的 ?c= 是
   *   使用者當初查的那個寫法，可能跟點位檔的顯示名不同（顯示名取的是
   *   紀錄比較多的那個寫法）。不在這裡正規化，查「臺灣電力」就會對不到。
   */
  const coPoint = useMemo(() => {
    if (!coName || !allPoints.length) return null;
    const norm = (t: string) => t.replace(/臺/g, "台").trim();
    const want = norm(coName);
    const hits = allPoints.filter((p) => norm(p.name) === want);
    if (!hits.length) return null;
    const head = hits.reduce((a, b) => (b.n > a.n ? b : a));
    return {
      name: head.name,
      lat: head.lat,
      lng: head.lng,
      exact: hits.every((p) => p.exact),
      n: hits.reduce((a, p) => a + p.n, 0),
      fatal: hits.reduce((a, p) => a + p.fatal, 0),
      merged: hits.length,
    };
  }, [coName, allPoints]);
  /* ⚠ 要是每次 render 都給新物件，KeepSized 的 effect 會跟著重跑：
     事件監聽重掛一次，而且使用者還沒動過的話視窗會被一直拉回去。 */
  /* 有公司座標就對準公司，否則對準行政區。
     ⚠⚠ 縮放要跟著**定位精度**走，不可以一律拉到最近：
     路名級的點只知道在哪條路上，zoom 16 的圖釘會宣稱一個
     資料沒有的精度。門牌級 16、路名級 14、只有行政區 13。 */
  const focus = useMemo(() => {
    if (coPoint) return { lat: coPoint.lat, lng: coPoint.lng, zoom: coPoint.exact ? 16 : 14 };
    if (fromQuery) return { lat: fromQuery.lat, lng: fromQuery.lng, zoom: 13 };
    return null;
  }, [coPoint, fromQuery]);

  /**
   * 縣市篩選在點位圖層也要有作用。
   *
   * ⚠⚠ 2026-10-29 實測：圖層選「事業單位位置」時，縣市選單改來改去，
   *   地圖與上面那行統計**完全不動**，只有密度圖層的排名表會變。
   *   選單就擺在那裡，使用者當然以為它有效。
   * ⚠ 點位檔沒有縣市欄位，所以用行政區界做點在多邊形內的判斷
   *   （只算選到的那個縣市，先用外框篩掉，兩萬多個點也只要幾毫秒）。
   *   邊界是簡化過的，貼著縣市界的少數點可能歸錯邊 —— 這是近似，不是地籍。
   */
  const countyShape = useMemo(() => {
    if (!countyFilter || !bounds) return null;
    type Ring = number[][];
    const polys: Ring[][] = [];
    const fc = bounds as unknown as {
      features: { properties: { k: string }; geometry: { type: string; coordinates: unknown } }[];
    };
    for (const f of fc.features ?? []) {
      if (!f.properties?.k?.startsWith(countyFilter)) continue;
      const g = f.geometry;
      if (g.type === "Polygon") polys.push(g.coordinates as Ring[]);
      else if (g.type === "MultiPolygon") polys.push(...(g.coordinates as Ring[][]));
    }
    if (!polys.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of polys) for (const [x, y] of poly[0]) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return { polys, box: [x0, y0, x1, y1] as const };
  }, [countyFilter, bounds]);

  const points = useMemo(() => {
    const bit = hazardFilter ? hazBit[hazardFilter] ?? 0 : 0;
    const inRing = (ring: number[][], x: number, y: number) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    const inCounty = (p: Pt) => {
      if (!countyShape) return true;
      const [x0, y0, x1, y1] = countyShape.box;
      if (p.lng < x0 || p.lng > x1 || p.lat < y0 || p.lat > y1) return false;
      return countyShape.polys.some((poly) =>
        inRing(poly[0], p.lng, p.lat) && !poly.slice(1).some((h) => inRing(h, p.lng, p.lat)));
    };
    return allPoints.filter((p) => {
      if (fatalOnly && p.fatal <= 0) return false;
      if (!inCounty(p)) return false;
      // ⚠ 用 mask 不是 p.haz —— p.haz 只是「最主要」的那一種，
      //   拿它來篩會變成「主要危害是感電的公司」，數字會少報。
      if (bit && !(p.mask & bit)) return false;
      return true;
    });
  }, [allPoints, hazardFilter, fatalOnly, hazBit, countyShape]);

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

      {/* ⚠⚠ 這一塊是紅線，不是版面裝飾。拿掉它這張圖就會被讀成職災地圖。
          但 2026-09-15 外部檢視量到：375px 寬度下**地圖頂端在 890px**，
          整個第一屏只有標題、這個金框、和資料來源段落 ——
          「求職者點進職安地圖看到的是一頁文字，會以為走錯頁面」。

          所以改成：最關鍵的那一句常駐，其餘收進「為什麼？」。
          ⚠ 收起來的是**理由**，不是**警告**。那一句本身一個字都沒少。 */}
      <div className="map-warn">
        <strong>
          {layer === "points"
            ? "圖釘是事業單位的「商工登記地址」，不是職災的發生地點。"
            : "顏色深淺依「商工登記地址」歸戶到行政區，不是職災的發生地點。"}
        </strong>
        <button className="linkish" onClick={() => setWhy((v) => !v)}>
          {why ? "收合" : "為什麼？"}
        </button>
        {why && (
          <div className="map-why">
            <p>
              職安法的 {data.osha_total.toLocaleString()} 筆公告裡，
              只有 189 筆填了發生地點（0.25%），無法用來定位。
              公司登記在台北、工地在桃園是營造業的常態，
              所以這張圖回答的是「被處分的事業單位登記在哪裡」，
              不是「哪裡容易出事」。
            </p>
            {layer === "points" ? (
              <p>
                <b>圖釘落在真實門牌上，所以特別容易被誤讀</b>——那是一棟具體的
                建築物，但它可能只是登記處所（會計師事務所、負責人住家），
                與違規事實發生的位置無關。
              </p>
            ) : (
              <p>
                整個行政區一起上色，是因為這份資料的解析度就是「一個區」——
                再細的位置我們沒有，也不會假裝有。
              </p>
            )}
          </div>
        )}
      </div>

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

      {/* ⚠⚠ 沒上圖的那些去哪了，一定要講。
          一張地圖上的空白，跟「那裡沒有違規」長得一模一樣。
          三類成因分開列，而且四個數字相加等於總數 ——
          讀的人要能自己核對，不能只看到一個「涵蓋 87.8%」。 */}
      {layer === "density" && (
        <details className="cov-split">
          <summary>
            職安法 {data.osha_total.toLocaleString()} 筆裡，
            <b>{data.osha_mapped.toLocaleString()} 筆</b>（
            {((100 * data.osha_mapped) / data.osha_total).toFixed(1)}%）在這張圖上
            {"\u3000"}·{"\u3000"}其餘 {(data.osha_total - data.osha_mapped).toLocaleString()} 筆為什麼不在？
          </summary>
          <ul>
            <li>
              <b>{data.no_company_osha.toLocaleString()} 筆</b>
              {"\u3000"}公司名欄位是空的，無從歸戶到任何一家事業單位。
            </li>
            <li>
              <b>{data.no_addr_osha.toLocaleString()} 筆</b>
              {"\u3000"}（{data.no_addr_companies.toLocaleString()} 家）在商工登記裡對不到地址 ——
              多為診所、補習班、工作室等未登記為公司的型態。
            </li>
            <li>
              <b>{data.addr_unmapped_osha.toLocaleString()} 筆</b>
              {"\u3000"}（{data.addr_unmapped_companies.toLocaleString()} 家）有地址，但地址裡
              沒有寫到「區」（以新竹市、嘉義市為主）。省轄市的地址常見只寫到里與路名，
              從文字無法判斷是哪一區，本站不猜。
            </li>
          </ul>
          <p>
            這三類不是「那些地方沒有違規」，是這張圖放不進去。
            四個數字相加等於 {data.osha_total.toLocaleString()} 筆，可以自行核對。
          </p>
        </details>
      )}

      {/* ⚠ 抓失敗要講出來。一張少了點位的地圖跟「這裡沒有違規」
          長得一模一樣，而那是這個站最不能讓人誤會的一件事。 */}
      {loadErr && (
        <p className="alert" style={{ margin: "0 0 12px" }}>
          ⚠ {loadErr}載入失敗，這張圖目前不完整。請重新整理；
          <b>畫面上的空白是載入問題，不是那些地方沒有裁處紀錄。</b>
        </p>
      )}

      {tileFail && (
        <p className="sw-muted" style={{ margin: "0 0 12px" }}>
          ⚠ 底圖有圖磚連不上內政部國土測繪中心（重試兩次仍失敗），
          畫面上可能出現整片的色塊。<b>那是底圖的連線問題，不是那一帶沒有裁處紀錄</b>
          —— 行政區界、縣市名與所有資料圖層都是本站自己的檔案，不受影響。
        </p>
      )}

      {layer === "points" ? (
        !pdata ? (
          <p className="sw-muted" style={{ margin: "0 0 12px", fontWeight: 600 }}>
            事業單位點位載入中…（1.7 MB，第一次比較久，之後走快取）
          </p>
        ) : (
        <p className="sw-muted" style={{ margin: "0 0 12px", fontWeight: 600 }}>
          {/* ⚠⚠ 2026-10-29：篩了危害型態之後，原本寫「合計 20,058 筆職安法裁處」——
              那是**這些公司的全部**職安法裁處，不是「感電」那一類的筆數
              （點位檔每家只有總筆數與危害型態遮罩）。評審拿簡報上的
              「機械 9,986 筆」一比，就會看到同一個網站講兩個數字。
              所以篩選時改成講「幾家曾因這一類被裁處」，總筆數講明是全部。 */}
          {countyFilter ? `${countyFilter}：` : ""}
          {hazardFilter || fatalOnly ? (
            <>
              {points.length.toLocaleString()} 家事業單位
              {hazardFilter ? `曾因「${HAZARD_NAME[hazardFilter] ?? hazardFilter}」被裁處` : ""}
              {hazardFilter && fatalOnly ? "、" : ""}
              {fatalOnly ? "有公告涉及死亡災害" : ""}
              ；這些公司的職安法裁處合計{" "}
              {points.reduce((a, p) => a + p.n, 0).toLocaleString()} 筆（含其他危害型態）
            </>
          ) : (
            <>
              目前 {points.length.toLocaleString()} 家事業單位在圖上，合計{" "}
              {points.reduce((a, p) => a + p.n, 0).toLocaleString()} 筆職安法裁處
            </>
          )}
          {" · "}
          其中 {points.reduce((a, p) => a + p.fatal, 0).toLocaleString()} 筆公告涉及死亡災害
          {" · "}
          {countyFilter ? "全台" : ""}定位精度：門牌 {pdata.exact_n.toLocaleString()} 家（
          {((100 * pdata.exact_n) / pdata.total).toFixed(1)}%）、其餘為路名層級
          {" · "}
          {countyFilter ? "全台" : ""}另有 {(data.osha_mapped - pdata.pts.reduce((a, p) => a + p[4], 0)).toLocaleString()}
          {" "}筆裁處的事業單位地址對不到座標，未出現在本圖層
        </p>
        )
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
          <KeepSized bounds={TAIWAN_BOUNDS} focus={focus} />
          {/* ⚠⚠ 圖磚偶爾會單張失敗（實測 16 張掉 1 張，z8/110/212）。
              那一張在低縮放層級涵蓋台灣東半部，底下透出 --map-sea
              （深色主題是近黑），看起來就是畫面破一個大洞 ——
              而且**它跟「這裡沒有資料」長得一樣**，這是最不能誤會的一件事。
              重試兩次，仍然失敗才承認，並在下面說明那是連線問題。
              ⚠ 用 dataset 記次數，不要用外部變數 —— 圖磚會被 Leaflet
              回收重用，計數掛在元素上才不會互相污染。 */}
          <TileLayer
            url={BASEMAP_URL}
            attribution={BASEMAP_ATTR}
            maxZoom={20}
            eventHandlers={{
              tileerror: (e: TileErrorEvent) => {
                const img = e.tile as HTMLImageElement;
                const n = Number(img.dataset.retry ?? "0");
                if (n >= 2) { setTileFail(true); return; }
                img.dataset.retry = String(n + 1);
                const base = img.src.split("?")[0];
                window.setTimeout(() => { img.src = `${base}?r=${n + 1}`; }, 400 * (n + 1));
              },
            }}
          />
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
          {bounds && (
          <GeoJSON
            key={`v-${layer}-${metric}-${hazardFilter}-${countyFilter}-${max}`}
            data={bounds}
            style={layer === "density" ? styleFor : () => OUTLINE_ONLY}
            onEachFeature={layer === "density" ? onEachFeature : undefined}
            interactive={layer === "density"}
          />
          )}

          {layer === "points" && (
            <Clusters points={points} hazName={(c) => HAZARD_NAME[c] ?? c} />
          )}

          {/* ⚠⚠ 半徑用公尺不是像素，而且門牌級與路名級不一樣大。
              圓圈畫的是「我們知道到多細」，不是裝飾 ——
              一根圖釘會宣稱門牌級的精度，但 20.3% 的點沒有那個精度。 */}
          {coPoint && (
            /* ⚠⚠ 一定要放在自己的 pane 裡，而且 z-index 要高過 markerPane(600)。
               預設的 overlayPane 是 400，會被叢集的圓圈整個蓋掉 ——
               實測圈有畫出來（70×70 px、就在畫面中央），但看不見。
               「數字對但使用者看不到」跟沒做是一樣的。 */
            <Pane name="focus-co" style={{ zIndex: 650 }}>
            <Circle
              center={[coPoint.lat, coPoint.lng]}
              radius={coPoint.exact ? 70 : 300}
              pathOptions={{
                color: "var(--accent)", weight: 3, opacity: 1,
                fillColor: "var(--accent)", fillOpacity: 0.16,
              }}
            >
              <Popup>
                <b>{coPoint.name}</b>
                <br />職安法裁處 {coPoint.n.toLocaleString()} 筆
                {coPoint.fatal > 0 && <>（其中 {coPoint.fatal} 筆公告涉及死亡災害）</>}
                <br />
                {coPoint.exact ? "門牌級定位" : "路名級定位 —— 圓圈為大約範圍"}
                <br />商工登記地址，不是職災發生地點
              </Popup>
            </Circle>
            </Pane>
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

      {/* 點位圖層的圖例（2026-10-30 補）：原本只有密度圖層有圖例，
          評審第一眼看到的是點位圖層，圈裡的數字是什麼、紅點是什麼都要猜。 */}
      <div
        hidden={layer !== "points"}
        style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", maxWidth: 660,
                 margin: "10px auto 0", fontSize: 12, color: "var(--ink-2)" }}
      >
        {([
          [22, "var(--accent-fill)", 0.72, "圈內數字＝這一帶的事業單位家數（點一下放大）"],
          [10, "var(--accent-fill)", 0.9, "單一事業單位"],
          [10, "var(--sev-high)", 0.9, "公告涉及死亡災害"],
        ] as const).map(([d, c, o, t]) => (
          <span key={t} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <i style={{ width: d, height: d, borderRadius: "50%", background: c, opacity: o,
                        border: "1px solid var(--map-label-halo)", display: "inline-block" }} />
            {t}
          </span>
        ))}
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
      {/* ⚠ 從查詢頁帶過來的那一區，在表格上方單獨陳述一次。
          365 列裡自己找一列，跟直接告訴他，差別很大。
          ⚠ 措辭只給數字，不說「這一區很危險」—— 密度高可能是
          稽核密集，也可能是工業區，我們分不出來，就不要講。 */}
      {/* ⚠⚠ 帶了 ?c= 卻找不到，一定要講出原因。
          直接顯示一張全台地圖，使用者會以為是連結壞了，
          或更糟 —— 以為「這家公司沒有職安問題」。
          點位檔只收 23,815 家（有職安法裁處且定位得出來），
          站上共 176,268 家，查不到是常態不是例外。 */}
      {coName && !coPoint && (
        <p className="from-q">
          本站的職安法點位裡沒有「<b>{coName}</b>」——
          可能是它沒有職安法裁處，或登記地址無法定位成座標。
          {fromQuery && <>已改為顯示它登記地址所在的鄉鎮市區。</>}
        </p>
      )}

      {coPoint && (
        <p className="from-q">
          <b>{coPoint.name}</b>
          {"\u3000"}職安法裁處 <span className="num">{coPoint.n.toLocaleString()}</span> 筆
          {coPoint.fatal > 0 && <>{"\u3000·\u3000"}其中 <span className="num">{coPoint.fatal}</span> 筆公告涉及死亡災害</>}
          <span className="from-q-note">
            {/* ⚠ 精度一定要標。路名級的點只知道在哪條路上，
                圓圈畫的就是那個不確定範圍 —— 圖釘會讓人以為是門牌。 */}
            {coPoint.exact
              ? "圖上的圓圈是商工登記地址（門牌級定位），不是職災發生地點。"
              : "此筆只定位到路名，圓圈是大約範圍、不是確切門牌；且為商工登記地址，不是職災發生地點。"}
            {coPoint.merged > 1 && "\u3000本站把「台」「臺」兩種寫法視為同一家，已合併計算。"}
          </span>
        </p>
      )}

      {fromQuery && !coPoint && (
        <p className="from-q">
          <b>{fromQuery.k}</b>
          {"\u3000"}職安法裁處 <span className="num">{countOf(fromQuery).toLocaleString()}</span> 件
          {fatalOf(fromQuery) > 0 && <>{"\u3000·\u3000"}其中 <span className="num">{fatalOf(fromQuery)}</span> 件涉及死亡災害</>}
          {fromQuery.base >= MIN_BASE && (
            <>{"\u3000·\u3000"}每千家 <span className="num">{((1000 * countOf(fromQuery)) / fromQuery.base).toFixed(1)}</span></>
          )}
        </p>
      )}
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
            <tr key={r.k} style={{ borderTop: "1px solid var(--line)" }}
                className={fromQuery && r.k === fromQuery.k ? "row-q" : undefined}>
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

      {/* ⚠ 資料來源與覆蓋率搬到地圖下方。它是必要的，但它不該擋在地圖前面
          —— 使用者點進這一頁是要看圖的。2026-09-15 外部檢視量到 375px 下
          地圖頂端在 890px，第一屏完全看不到地圖。 */}
      <p className="sw-muted" style={{ marginTop: 16 }}>
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

      <p className="sw-muted" style={{ marginTop: 16, lineHeight: 1.8 }}>
        本頁僅呈現主管機關已公告之裁處紀錄的統計分布，不對任何事業單位或任何地區作出評價或認定。
        <br />
        名次高低同時受該地區的產業結構影響（工業區的營造與製造業比例高，
        本來就會有較多職安法裁處），不能單獨解讀為「這個地區比較危險」。
        <br />
        各縣市的資料公開期間長短不一（有些縣市不到 2 年；基隆市與新竹市政府自己的公告裡沒有職安法，
        兩市只會出現其他機關公告的裁處），跨地區比較請一併考慮這一點。
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
