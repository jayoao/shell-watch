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
import hazardTable from "../data/hazards.json";

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

/**
 * 這一筆是不是還在爭議中（訴願／行政救濟尚未終結）。
 *
 * ⚠ 這是紅線不是體貼。原處分還沒確定，把它跟已確定的案子混在一起呈現，
 *   對被列的公司不公平，對使用者也是誤導。查詢頁的 Violation 元件
 *   已經這樣做了，地圖頁不能兩套標準 —— 同一個系統對同一件事
 *   兩個頁面講法不同，是最難跟評審解釋的那種問題。
 *
 * 實測 mock 的 200 筆有 50 筆 appeal 有值，其中包含「訴願審理中」。
 */
const APPEAL_PENDING = ["訴願中", "審理中", "行政救濟中", "提起訴願", "訴訟中", "尚未確定"];

function isPending(appeal: string | null): boolean {
  return !!appeal && APPEAL_PENDING.some((k) => appeal.includes(k));
}

/** 危害型態代碼 → 名稱。分類本身在 pipeline/hazard.py 做，前端只查表。 */
const HAZARD_NAME: Record<string, string> =
  Object.fromEntries(Object.entries(hazardTable as Record<string, { name: string }>)
    .map(([code, v]) => [code, v.name]));

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
  const [hazardFilter, setHazardFilter] = useState<string>("");
  const [pendingOnly, setPendingOnly] = useState(false);

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
  /**
   * ⚠ 法條原本是下拉選單，換成真實資料會爆掉。
   *   mock 只有 12 種法條，但真實的 `law_article` 是
   *   「營造安全衛生設施標準第19條第1項暨職業安全衛生法第6條第1項第5款」
   *   這種完整引用，職安法的部分就有 **15,328 種** —— 一個 select 塞不下，
   *   而且塞得下也沒人找得到自己要的那一條。
   *   改成關鍵字比對（打「墜落」「營造」就能篩），選項數量再多都不會壞。
   */
  const laws = useMemo(
    () => Array.from(new Set(data.incidents.map((i) => i.law))).sort(),
    [data],
  );

  /**
   * 危害型態才是這一頁該有的篩選條件。組別叫「職安**視覺化防災**組」，
   * 「只看墜落」是防災的問題，「只看設施規則第281條」不是。
   * 15 種，選單塞得下，而且換成真實資料選項數也不會變。
   */
  const hazards = useMemo(() => {
    const seen = new Set<string>();
    for (const i of data.incidents) for (const h of i.hazards ?? []) seen.add(h);
    return [...seen].filter((h) => HAZARD_NAME[h]).sort(
      (a, b) => HAZARD_NAME[a].localeCompare(HAZARD_NAME[b], "zh-Hant"));
  }, [data]);

  // 在「座標有效」的清單（plottable）之上，再依照三個下拉選單的選擇篩一次。
  // 選單維持空字串（"全部"）的那一項，就不會排除任何資料。
  const filtered = useMemo(
    () =>
      plottable.filter((i) => {
        if (countyFilter && i.county !== countyFilter) return false;
        if (yearFilter && i.disposition_date?.slice(0, 4) !== yearFilter)
          return false;
        // 法條改成關鍵字比對，不是完全相同
        if (lawFilter && !i.law.includes(lawFilter)) return false;
        if (hazardFilter && !(i.hazards ?? []).includes(hazardFilter)) return false;
        if (pendingOnly && !isPending(i.appeal)) return false;
        return true;
      }),
    [plottable, countyFilter, yearFilter, lawFilter, hazardFilter, pendingOnly],
  );

  // TODO 4：統計摘要。從 filtered 算出「現在顯示幾筆」跟「罹災人數合計」，
  // filtered 一變（篩選列一動），這兩個數字就會自動重新算。
  const stats = useMemo(
    () => ({
      count: filtered.length,
      totalCasualties: filtered.reduce((sum, i) => sum + i.casualties, 0),
      pending: filtered.filter((i) => isPending(i.appeal)).length,
      fatal: filtered.filter((i) => i.fatal).length,
    }),
    [filtered],
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
          法條關鍵字：
          <input
            value={lawFilter}
            onChange={(e) => setLawFilter(e.target.value)}
            placeholder={`共 ${laws.length} 種，例如「營造」`}
            style={{ marginLeft: 4, padding: "2px 6px", width: 150 }}
          />
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="checkbox"
            checked={pendingOnly}
            onChange={(e) => setPendingOnly(e.target.checked)}
          />
          只看尚未確定的案件
        </label>
      </div>

      <p className="sw-muted" style={{ margin: "0 0 12px", fontWeight: 600 }}>
        目前顯示 {stats.count} 筆，合計罹災 {stats.totalCasualties} 人
        {stats.fatal > 0 && `，其中 ${stats.fatal} 筆公告涉及死亡災害`}
        {stats.pending > 0 && `\u3000·\u3000${stats.pending} 筆行政救濟尚未終結`}
      </p>

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
                  {/* ⚠ 措辭固定：「涉及」不是「造成」。有些公告罰的是
                      「未於八小時內通報死亡災害」，寫成「造成死亡」
                      就是把通報違規講成殺人。 */}
                  {incident.fatal && (
                    <div style={{ color: "var(--sev-high)", fontWeight: 700 }}>
                      本筆公告涉及死亡災害
                    </div>
                  )}
                  <div>{incident.law}</div>
                  {(incident.hazards ?? []).length > 0 && (
                    <div>
                      危害型態：
                      {(incident.hazards ?? [])
                        .map((h) => HAZARD_NAME[h] ?? h)
                        .join("、")}
                    </div>
                  )}
                  <div>罰鍰：NT$ {incident.fine.toLocaleString()}</div>
                  <div>裁處日期：{incident.disposition_date}</div>
                  {/* 爭議中的案子一定要標出來 —— 跟查詢頁同一條紅線 */}
                  {incident.appeal && (
                    <div style={{ marginTop: 4 }}>
                      訴願：{incident.appeal}
                      {isPending(incident.appeal) && (
                        <div style={{ color: "var(--warn)", fontWeight: 600 }}>
                          本案的行政救濟程序尚未終結，原處分是否維持仍待確定。
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>

      <p className="sw-muted" style={{ marginTop: 16 }}>
        本頁僅呈現主管機關已公告之裁處紀錄與其出處，不對任何事業單位作出評價或認定。
      </p>
    </div>
  );
}
