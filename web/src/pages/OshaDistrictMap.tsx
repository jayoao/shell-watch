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
import { MapContainer, GeoJSON, CircleMarker, Popup } from "react-leaflet";
import type { GeoJsonObject } from "geojson";
import type { DistrictDataset, DistrictRow } from "../types/geo";
import raw from "../data/osha_district.json";
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
 * 底圖用我們自己的鄉鎮市區界，**不打任何外部圖磚伺服器**。
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
const LAND = {
  color: "var(--line-strong)",
  weight: 0.7,
  fillColor: "var(--map-land)",
  fillOpacity: 1,
} as const;

const TAIWAN_BOUNDS: [[number, number], [number, number]] = [
  [21.85, 119.95],
  [25.35, 122.05],
];

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

/**
 * 圓點半徑（像素）。用平方根是因為人眼看的是**面積**不是半徑 ——
 * 直接拿數值當半徑的話，10 倍的值會畫成 100 倍大的圓。
 *
 * ⚠ 最大值只給到 15px。西部工業帶的鄉鎮市區本來就擠，
 *   圓再大一點整條海岸線就糊成一塊藍色，看不出哪個區是哪個區。
 *   （試過 22px，實測就是糊掉。）
 */
function radiusFor(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return 2 + Math.sqrt(value / max) * 10;
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
          bounds={TAIWAN_BOUNDS}
          boundsOptions={{ padding: [10, 10] }}
          /*
           * ⚠ zoomSnap 預設是 1，縮放只能是整數級。
           *   本島在這個框裡剛好卡在 7 跟 8 中間 —— 只能取整數的話
           *   會退回 7，然後台灣又縮成一小條。改成 0.25 才吃得到 7.75。
           */
          zoomSnap={0.25}
          minZoom={6}
          /* 沒有圖磚了，容器底色就是「海」 —— 要比陸地暗，見 LAND 的註解 */
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
          <GeoJSON data={BOUNDARIES} style={() => LAND} interactive={false} />

          {/* 大圓先畫、小圓後畫 —— 不然彰化那一帶的小區會被鄰居蓋住點不到 */}
          {ranked.map((r) => {
            const v = valueOf(r);
            if (v <= 0) return null;
            /* 用 --accent 不是 --accent-fill —— 深色主題下 accent-fill
               壓在深色陸地上對比不夠。 */
            const color = metric === "fatal" ? "var(--sev-high)" : "var(--accent)";
            return (
              <CircleMarker
                key={r.k}
                center={[r.lat, r.lng]}
                radius={radiusFor(v, max)}
                pathOptions={{
                  color,
                  fillColor: color,
                  /*
                   * 填色要淡、外框要清楚。
                   * ⚠ 西部工業帶的鄉鎮市區本來就擠，300 個圓一定會重疊。
                   *   填得越實，重疊處越糊成一塊；改成淡填色＋明顯外框之後，
                   *   重疊的圓會讀成「幾個圈圈疊在一起」而不是「一坨藍色」。
                   */
                  fillOpacity: 0.22,
                  opacity: 0.9,
                  weight: 1.4,
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
                    {fatalOf(r) > 0 && (
                      <div style={{ color: "var(--sev-high)", fontWeight: 700 }}>
                        其中 {fatalOf(r)} 筆公告涉及死亡災害
                      </div>
                    )}
                    {pendingOf(r) > 0 && (
                      <div style={{ color: "var(--warn)" }}>
                        {pendingOf(r)} 筆行政救濟尚未終結，原處分是否維持仍待確定
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
        行政區界為簡化後的鄉鎮市區界（來源：g0v/twgeojson），僅作為底圖，
        不得用於任何界線或面積的認定；本頁不向任何外部圖磚伺服器取圖。
        <br />
        預設檢視只框住本島；金門縣與連江縣的資料也在圖上，要縮小才看得到。
        地圖可用滾輪、左上角的 + / − 或雙擊縮放。
      </p>
    </div>
  );
}
