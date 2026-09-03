/* ============================================================
   職安地圖（任務 T5）—— 這是你的檔案。

   目標：把職業安全衛生法的違規紀錄按「發生地點」標在台灣地圖上，
        圓點大小代表「罹災人數」。

   五個功能，由簡到難，做到哪算哪：
     1. 【必做】地圖顯示台灣，每筆一個圓點，大小依 casualties
     2. 【必做】點圓點跳出 Popup：公司名、法條、罰鍰、日期
     3. 【盡量】篩選列：縣市、年份、法條
     4. 【盡量】統計：目前顯示幾筆、合計罹災幾人
     5. 【有空】點太密時聚合（react-leaflet-cluster）

   三個一定要遵守的規則：
     · 顏色一律用 var(--xxx)，不要寫死色碼
     · 資料從 mock.osha.json import，不要把資料複製到程式裡
     · lat/lng 可能是 null —— 要跳過，不能讓整頁當掉（下面已經處理好了）

   卡住的話看工作說明書 T5 的「卡住怎麼辦」。
   ============================================================ */

import { useMemo, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";
import type { OshaDataset, OshaIncident } from "../types/contracts";
import raw from "../data/mock.osha.json";

/** 台灣本島中心與預設縮放 */
const TAIWAN_CENTER: [number, number] = [23.7, 121.0];
const DEFAULT_ZOOM = 7;

/**
 * 台灣本島（含外島）大致的經緯度範圍，用來擋掉明顯不合理的座標。
 *
 * mock.osha.json 是隨機亂數產生的假資料，有些座標會剛好落在海裡、
 * 國外，這不是程式碼寫錯，是假資料本身的隨機性。這個範圍框住台灣，
 * 框外的點一律不畫，等 10/12 換成真的地址座標之後這道檢查可以留著，
 * 順便防範萬一真實資料的地址解析出錯、跑出離譜座標。
 */
const TAIWAN_LAT_RANGE: [number, number] = [21.85, 25.3];
const TAIWAN_LNG_RANGE: [number, number] = [120.0, 122.05];

function inTaiwanBounds(lat: number, lng: number): boolean {
  return (
    lat >= TAIWAN_LAT_RANGE[0] &&
    lat <= TAIWAN_LAT_RANGE[1] &&
    lng >= TAIWAN_LNG_RANGE[0] &&
    lng <= TAIWAN_LNG_RANGE[1]
  );
}

/** 嚴重度 → CSS 變數。要用顏色的時候用這個，不要自己寫色碼。 */
export const SEVERITY_COLOR: Record<string, string> = {
  輕微: "var(--sev-low)",
  中度: "var(--sev-mid)",
  重大: "var(--sev-high)",
};

/**
 * 罹災人數 → 圓點半徑（**像素**）。
 *
 * ⚠ CircleMarker 的 radius 單位是像素，Circle 才是公尺。
 *   這兩個很容易搞混：如果你把公尺的數字（幾千）餵給 CircleMarker，
 *   會得到一個半徑三千像素、蓋滿整個畫面的藍色圓。
 *
 * 用平方根是因為人眼看的是「面積」不是「半徑」。直接用人數當半徑的話，
 * 10 人的點會比 1 人的點大 100 倍，整張圖只剩一顆球。
 * casualties 是 0 也要畫得出來，所以有一個最小值。
 */
export function radiusFor(casualties: number): number {
  return 5 + Math.sqrt(Math.max(0, casualties)) * 3.5;
}

export default function OshaMap() {
  const data = raw as unknown as OshaDataset;

  // ⚠ 所有 hook 都要放在 early return 之前。
  // 放在 return 後面的話，兩次渲染的 hook 數量會不一樣，
  // React 會丟 error #310 把整頁炸成白屏，而 TypeScript 檢查不出來。
  const plottable = useMemo(
    () =>
      data.incidents.filter(
        (i): i is OshaIncident & { lat: number; lng: number } =>
          typeof i.lat === "number" &&
          typeof i.lng === "number" &&
          inTaiwanBounds(i.lat, i.lng),
      ),
    [data],
  );

  const skipped = data.incidents.length - plottable.length;

  // TODO 3：篩選列用的「目前選了什麼」記憶格，一開始都是空字串，
  // 代表「全部都要」，不特別篩選。
  const [countyFilter, setCountyFilter] = useState<string>("");
  const [yearFilter, setYearFilter] = useState<string>("");
  const [lawFilter, setLawFilter] = useState<string>("");

  // 從全部資料裡整理出三個下拉選單各自有哪些選項，並排序、去除重複。
  const counties = useMemo(
    () => Array.from(new Set(data.incidents.map((i) => i.county))).sort(),
    [data],
  );
  const years = useMemo(
    () =>
      Array.from(
        new Set(
          data.incidents
            .map((i) => i.disposition_date?.slice(0, 4))
            .filter((y): y is string => Boolean(y)),
        ),
      ).sort(),
    [data],
  );
  const laws = useMemo(
    () => Array.from(new Set(data.incidents.map((i) => i.law))).sort(),
    [data],
  );

  // 在「座標有效」的清單（plottable）之上，再依照三個下拉選單的選擇篩一次。
  // 選單維持空字串（"全部"）的那一項，就不會排除任何資料。
  const filtered = useMemo(
    () =>
      plottable.filter((i) => {
        if (countyFilter && i.county !== countyFilter) return false;
        if (yearFilter && i.disposition_date?.slice(0, 4) !== yearFilter)
          return false;
        if (lawFilter && i.law !== lawFilter) return false;
        return true;
      }),
    [plottable, countyFilter, yearFilter, lawFilter],
  );

  return (
    <div>
      <h1 style={{ marginTop: 0, fontSize: 24 }}>職業安全衛生違規地圖</h1>
      <p className="sw-muted" style={{ marginTop: -8 }}>
        資料來源：{data.source}（{data.generated_at} 產出）
        {" · "}
        共 {data.incidents.length} 筆
        {skipped > 0 && `，其中 ${skipped} 筆座標缺漏或明顯有誤未顯示`}
      </p>

      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          margin: "4px 0 16px",
        }}
      >
        <label>
          縣市：
          <select
            value={countyFilter}
            onChange={(e) => setCountyFilter(e.target.value)}
          >
            <option value="">全部</option>
            {counties.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label>
          年份：
          <select
            value={yearFilter}
            onChange={(e) => setYearFilter(e.target.value)}
          >
            <option value="">全部</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>

        <label>
          法條：
          <select
            value={lawFilter}
            onChange={(e) => setLawFilter(e.target.value)}
          >
            <option value="">全部</option>
            {laws.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        style={{
          height: "70vh",              // ← 容器一定要給明確高度，不然地圖高度會是 0
          minHeight: 420,
          borderRadius: 14,
          overflow: "hidden",
          border: "1px solid var(--line)",
          boxShadow: "var(--shadow)",
        }}
      >
        <MapContainer
          center={TAIWAN_CENTER}
          zoom={DEFAULT_ZOOM}
          style={{ height: "100%", width: "100%" }}
          scrollWheelZoom
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {filtered.map((incident) => (
            <CircleMarker
              key={incident.id}
              center={[incident.lat, incident.lng]}
              radius={radiusFor(incident.casualties)}
              pathOptions={{
                color: SEVERITY_COLOR[incident.severity] ?? "var(--ink-3)",
                fillColor: SEVERITY_COLOR[incident.severity] ?? "var(--ink-3)",
                fillOpacity: 0.55,
                weight: 1.5,
              }}
            >
              <Popup>
                <div style={{ minWidth: 200, lineHeight: 1.6 }}>
                  <strong>{incident.employer}</strong>
                  <div>{incident.law}</div>
                  <div>罰鍰：NT$ {incident.fine.toLocaleString()}</div>
                  <div>裁處日期：{incident.disposition_date}</div>
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>

      {/* TODO 4：統計摘要放這裡（目前顯示幾筆、合計罹災幾人） */}

      <p className="sw-muted" style={{ marginTop: 16 }}>
        本頁僅呈現主管機關已公告之裁處紀錄與其出處，不對任何事業單位作出評價或認定。
      </p>
    </div>
  );
}