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

import { useMemo } from "react";
import { MapContainer, TileLayer } from "react-leaflet";
import type { OshaDataset, OshaIncident } from "../types/contracts";
import raw from "../data/mock.osha.json";

/** 台灣本島中心與預設縮放 */
const TAIWAN_CENTER: [number, number] = [23.7, 121.0];
const DEFAULT_ZOOM = 7;

/** 嚴重度 → CSS 變數。要用顏色的時候用這個，不要自己寫色碼。 */
export const SEVERITY_COLOR: Record<string, string> = {
  輕微: "var(--sev-low)",
  中度: "var(--sev-mid)",
  重大: "var(--sev-high)",
};

/**
 * 罹災人數 → 圓點半徑（公尺）。
 * 用平方根是因為人眼看的是「面積」不是「半徑」，
 * 直接用人數當半徑的話，10 人的點會比 1 人的點大 100 倍，整張圖只剩一顆球。
 * casualties 是 0 也要畫，所以有一個最小值。
 */
export function radiusFor(casualties: number): number {
  return 800 + Math.sqrt(Math.max(0, casualties)) * 2200;
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
          typeof i.lat === "number" && typeof i.lng === "number",
      ),
    [data],
  );

  const skipped = data.incidents.length - plottable.length;

  return (
    <div>
      <h1 style={{ marginTop: 0, fontSize: 24 }}>職業安全衛生違規地圖</h1>
      <p className="sw-muted" style={{ marginTop: -8 }}>
        資料來源：{data.source}（{data.generated_at} 產出）
        {" · "}
        共 {data.incidents.length} 筆
        {skipped > 0 && `，其中 ${skipped} 筆沒有座標未顯示`}
      </p>

      {/* TODO 3：篩選列放這裡（縣市／年份／法條） */}

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

          {/* ──────────────────────────────────────────────
              TODO 1：在這裡把 plottable 畫成圓點。

              提示：用 CircleMarker 不要用 Marker。
              Marker 需要圖釘圖片，那個東西在 Vite 打包後會破圖，
              CircleMarker 完全沒有這個問題，而且半徑可以依人數變化。

              大概像這樣：
                {plottable.map((i) => (
                  <CircleMarker key={i.id} center={[i.lat, i.lng]} ... >
                    <Popup> ... TODO 2 ... </Popup>
                  </CircleMarker>
                ))}

              半徑用上面的 radiusFor(i.casualties)，
              顏色用 SEVERITY_COLOR[i.severity]。
             ────────────────────────────────────────────── */}
        </MapContainer>
      </div>

      {/* TODO 4：統計摘要放這裡（目前顯示幾筆、合計罹災幾人） */}

      <p className="sw-muted" style={{ marginTop: 16 }}>
        本頁僅呈現主管機關已公告之裁處紀錄與其出處，不對任何事業單位作出評價或認定。
      </p>
    </div>
  );
}
