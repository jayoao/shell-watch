/* ============================================================
   事業單位位置圖層 —— 自己寫的聚合，沒有用外部套件。

   為什麼不用 react-leaflet-cluster：
     · 23,815 個點的分群規則我們要能完全控制（尤其是放大到街道層級時
       該散開到什麼程度），套件的預設行為調起來比自己寫還久
     · 這一頁今天已經被外部依賴咬過一次（OSM 圖磚 403）

   做法：把可視範圍內的點投影成「目前縮放下的像素座標」，
   用固定像素大小的格子分桶。格子是像素不是經緯度，所以
   **放大就會自動散開**，不需要為每一級縮放訂一套參數。
   ============================================================ */

import { useMemo, useState } from "react";
import { CircleMarker, Popup, Tooltip, useMap, useMapEvents } from "react-leaflet";
import type { Pt } from "../types/points";

/** 分桶的格子邊長（像素）。調小＝散得早，調大＝聚得久。 */
const CELL_PX = 54;

/** 超過這個縮放就不聚合了，一律畫單點（街道層級再聚合沒有意義）。 */
const NO_CLUSTER_ZOOM = 16;

interface Cell {
  key: string;
  lat: number;
  lng: number;
  count: number;
  n: number;
  fatal: number;
  one: Pt | null;   // count === 1 時才有
}

function radiusFor(count: number): number {
  return Math.min(26, 7 + Math.sqrt(count) * 2.6);
}

export default function Clusters({
  points,
  hazName,
}: {
  points: Pt[];
  hazName: (code: string) => string;
}) {
  const map = useMap();
  const [tick, setTick] = useState(0);
  useMapEvents({
    moveend: () => setTick((t) => t + 1),
    zoomend: () => setTick((t) => t + 1),
  });

  const cells = useMemo(() => {
    void tick;                       // 依賴：地圖一動就重算
    const zoom = map.getZoom();
    const bounds = map.getBounds().pad(0.25);
    const solo = zoom >= NO_CLUSTER_ZOOM;
    const acc = new Map<string, Cell>();

    for (const p of points) {
      if (!bounds.contains([p.lat, p.lng])) continue;
      let key: string;
      if (solo) {
        key = `s${p.lat},${p.lng},${p.name}`;
      } else {
        const px = map.project([p.lat, p.lng], zoom);
        key = `${Math.floor(px.x / CELL_PX)}:${Math.floor(px.y / CELL_PX)}`;
      }
      const c = acc.get(key);
      if (c) {
        c.count += 1;
        c.n += p.n;
        c.fatal += p.fatal;
        // 桶裡不只一個點時，代表點放在成員的平均位置
        c.lat += (p.lat - c.lat) / c.count;
        c.lng += (p.lng - c.lng) / c.count;
        c.one = null;
      } else {
        acc.set(key, {
          key, lat: p.lat, lng: p.lng, count: 1,
          n: p.n, fatal: p.fatal, one: p,
        });
      }
    }
    // 大的先畫、小的後畫，小點才不會被蓋住點不到
    return [...acc.values()].sort((a, b) => b.count - a.count);
  }, [points, map, tick]);

  return (
    <>
      {cells.map((c) => {
        const single = c.count === 1 && c.one;
        const color = single && c.one!.fatal > 0
          ? "var(--sev-high)"
          : "var(--accent-fill)";
        return (
          <CircleMarker
            key={c.key}
            center={[c.lat, c.lng]}
            radius={single ? 6 : radiusFor(c.count)}
            pathOptions={{
              color: "var(--map-label-halo)",
              weight: 1.2,
              fillColor: color,
              fillOpacity: single ? 0.9 : 0.72,
            }}
            eventHandlers={
              single
                ? {}
                : {
                    // 點聚合圈就放大進去，跟一般地圖的行為一致
                    click: () => map.setView([c.lat, c.lng], map.getZoom() + 2),
                  }
            }
          >
            {!single && (
              <Tooltip permanent direction="center" className="sw-cluster-label">
                {c.count >= 1000 ? `${Math.round(c.count / 100) / 10}k` : c.count}
              </Tooltip>
            )}
            {single && (
              <Popup>
                <div style={{ minWidth: 240, lineHeight: 1.65 }}>
                  <strong>{c.one!.name}</strong>
                  {/* ⚠ 這兩行不可以拿掉。圖釘落在真實門牌上，
                      誤讀的代價是指著一棟具體的建築物說它出過事。 */}
                  <div style={{ color: "var(--ink-3)", fontSize: 12 }}>
                    此處為該事業單位的商工登記地址，<b>不是職災的發生地點</b>。
                    營造業的公司登記在台北、工地在桃園是常態。
                  </div>
                  <hr style={{ margin: "6px 0", border: 0, borderTop: "1px solid var(--line)" }} />
                  <div>職安法裁處 {c.one!.n.toLocaleString()} 筆</div>
                  {/* ⚠ 措辭固定：「涉及」不是「造成」。有些公告罰的是
                      「未於八小時內通報死亡災害」。 */}
                  {c.one!.fatal > 0 && (
                    <div style={{ color: "var(--sev-high)", fontWeight: 700 }}>
                      其中 {c.one!.fatal} 筆公告涉及死亡災害
                    </div>
                  )}
                  {c.one!.pending > 0 && (
                    <div style={{ color: "var(--warn)" }}>
                      {c.one!.pending} 筆行政救濟尚未終結，原處分是否維持仍待確定
                    </div>
                  )}
                  {c.one!.haz && <div>主要危害型態：{hazName(c.one!.haz)}</div>}
                  {c.one!.year > 0 && <div>最近裁處年份：{c.one!.year}</div>}
                  <div style={{ color: "var(--ink-3)", marginTop: 4, fontSize: 12 }}>
                    定位精度：{c.one!.exact ? "門牌" : "路名（門牌對不到，取該路平均位置）"}
                  </div>
                </div>
              </Popup>
            )}
          </CircleMarker>
        );
      })}
    </>
  );
}
