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

import { useMemo, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";
import type { DistrictDataset, DistrictRow } from "../types/geo";
import raw from "../data/osha_district.json";
import hazardTable from "../data/hazards.json";

const TAIWAN_CENTER: [number, number] = [23.7, 121.0];
const DEFAULT_ZOOM = 7;

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

const METRIC_LABEL: Record<Metric, string> = {
  count: "裁處件數",
  rate: "每千家登記事業單位的裁處件數",
  fatal: "公告涉及死亡災害的件數",
};

/** 圓點半徑（像素）。用平方根是因為人眼看的是面積不是半徑。 */
function radiusFor(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return 3 + Math.sqrt(value / max) * 22;
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

export default function OshaDistrictMap() {
  const data = raw as unknown as DistrictDataset;

  const [metric, setMetric] = useState<Metric>("rate");
  const [hazardFilter, setHazardFilter] = useState<string>("");
  const [countyFilter, setCountyFilter] = useState<string>("");

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
  const valueOf = useMemo(
    () => (r: DistrictRow): number => {
      if (metric === "fatal") return r.fatal;
      const n = countOf(r);
      return metric === "rate" ? (r.base > 0 ? (1000 * n) / r.base : 0) : n;
    },
    [metric, countOf],
  );

  const max = useMemo(
    () => rows.reduce((m, r) => Math.max(m, valueOf(r)), 0),
    [rows, valueOf],
  );

  const top = useMemo(
    () => [...rows].sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 10),
    [rows, valueOf],
  );

  const stats = useMemo(() => {
    const shown = rows.filter((r) => valueOf(r) > 0);
    return {
      districts: shown.length,
      records: rows.reduce((s, r) => s + countOf(r), 0),
      fatal: rows.reduce((s, r) => s + r.fatal, 0),
      pending: rows.reduce((s, r) => s + r.pending, 0),
    };
  }, [rows, valueOf, countOf]);

  const fmt = (v: number) =>
    metric === "rate" ? v.toFixed(1) : v.toLocaleString();

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
        <strong>圓點的位置是事業單位的「商工登記地址」，不是職災的發生地點。</strong>
        <br />
        職安法的 {data.osha_total.toLocaleString()} 筆公告裡，只有 189 筆填了發生地點（0.25%），
        無法用來定位。公司登記在台北、工地在桃園是營造業的常態，
        所以這張圖回答的是「被處分的事業單位登記在哪裡」，
        不是「哪裡容易出事」。圓點畫在該區的幾何中心，不是任何一筆紀錄的實際位置。
      </div>

      <p className="sw-muted" style={{ marginTop: -4 }}>
        資料來源：{data.source}（{data.generated_at} 產出）
        {" · "}
        {data.osha_mapped.toLocaleString()} / {data.osha_total.toLocaleString()} 筆
        職安法裁處可歸到鄉鎮市區（
        {((100 * data.osha_mapped) / data.osha_total).toFixed(1)}%），
        分布在 {data.districts} 個區
      </p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "4px 0 14px" }}>
        <label>
          顯示：
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
            disabled={metric === "fatal"}
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

      <p className="sw-muted" style={{ margin: "0 0 12px", fontWeight: 600 }}>
        目前 {stats.districts} 個區有資料，合計 {stats.records.toLocaleString()} 筆
        {stats.fatal > 0 && `，其中 ${stats.fatal.toLocaleString()} 筆公告涉及死亡災害`}
        {stats.pending > 0 && ` · ${stats.pending.toLocaleString()} 筆行政救濟尚未終結`}
        {metric === "rate" &&
          ` · 只列入現存登記事業單位 ${MIN_BASE} 家以上的區（分母太小的率不可靠）`}
      </p>

      <div
        style={{
          height: "66vh",
          minHeight: 400,
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

          {rows.map((r) => {
            const v = valueOf(r);
            if (v <= 0) return null;
            const color = metric === "fatal" ? "var(--sev-high)" : "var(--accent-fill)";
            return (
              <CircleMarker
                key={r.k}
                center={[r.lat, r.lng]}
                radius={radiusFor(v, max)}
                pathOptions={{
                  color,
                  fillColor: color,
                  fillOpacity: 0.45,
                  weight: 1.2,
                }}
              >
                <Popup>
                  <div style={{ minWidth: 230, lineHeight: 1.65 }}>
                    <strong>{r.k}</strong>
                    <div style={{ color: "var(--ink-3)", fontSize: 12 }}>
                      以登記地址歸戶，非事故發生地點
                    </div>
                    <hr style={{ margin: "6px 0", border: 0, borderTop: "1px solid var(--line)" }} />
                    <div>
                      職安法裁處
                      {hazardFilter && `（${HAZARD_NAME[hazardFilter]}）`}
                      ：{countOf(r).toLocaleString()} 筆
                    </div>
                    {r.base >= MIN_BASE ? (
                      <div>
                        每千家登記事業單位{" "}
                        {((1000 * countOf(r)) / r.base).toFixed(1)}
                        {" ± "}
                        {rateSE2(countOf(r), r.base).toFixed(1)}
                        <span style={{ color: "var(--ink-3)" }}>（±2SE）</span>
                      </div>
                    ) : (
                      <div style={{ color: "var(--ink-3)" }}>
                        現存登記事業單位僅 {r.base.toLocaleString()} 家，
                        分母太小，不計算率
                      </div>
                    )}
                    {/* ⚠ 措辭固定：「涉及」不是「造成」。有些公告罰的是
                        「未於八小時內通報死亡災害」，寫成「造成死亡」
                        就是把通報違規講成殺人。 */}
                    {r.fatal > 0 && (
                      <div style={{ color: "var(--sev-high)", fontWeight: 700 }}>
                        其中 {r.fatal} 筆公告涉及死亡災害
                      </div>
                    )}
                    {r.pending > 0 && (
                      <div style={{ color: "var(--warn)" }}>
                        {r.pending} 筆行政救濟尚未終結，原處分是否維持仍待確定
                      </div>
                    )}
                    <div style={{ color: "var(--ink-2)", marginTop: 4 }}>
                      有裁處紀錄的事業單位 {r.co.toLocaleString()} 家
                      {" / "}
                      現存登記 {r.base.toLocaleString()} 家
                    </div>
                    <div style={{ marginTop: 4 }}>
                      主要危害型態：
                      {Object.entries(r.haz)
                        .slice(0, 4)
                        .map(([h, c]) => `${HAZARD_NAME[h] ?? h} ${c}`)
                        .join("、") || "（本區無可歸類的職安法裁處）"}
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>

      <h2 style={{ fontSize: 17, margin: "20px 0 8px" }}>
        前 10 名 · {METRIC_LABEL[metric]}
        {hazardFilter && metric !== "fatal" && ` · 只看${HAZARD_NAME[hazardFilter]}`}
      </h2>
      <table className="sw-table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>鄉鎮市區</th>
            <th style={{ textAlign: "right" }}>{METRIC_LABEL[metric]}</th>
            <th style={{ textAlign: "right" }}>裁處件數</th>
            <th style={{ textAlign: "right" }}>現存登記家數</th>
            <th style={{ textAlign: "right" }}>涉及死亡災害</th>
          </tr>
        </thead>
        <tbody>
          {top.map((r) => (
            <tr key={r.k} style={{ borderTop: "1px solid var(--line)" }}>
              <td>{r.k}</td>
              <td style={{ textAlign: "right", fontWeight: 600 }}>
                {fmt(valueOf(r))}
                {metric === "rate" && (
                  <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>
                    {" ± "}
                    {rateSE2(countOf(r), r.base).toFixed(1)}
                  </span>
                )}
              </td>
              <td style={{ textAlign: "right" }}>{countOf(r).toLocaleString()}</td>
              <td style={{ textAlign: "right" }}>{r.base.toLocaleString()}</td>
              <td style={{ textAlign: "right" }}>{r.fatal.toLocaleString()}</td>
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
      </p>
    </div>
  );
}
