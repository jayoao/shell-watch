/* 事業單位位置圖層的資料契約。產出者是 tools/geocode.py + pipeline 的點位輸出。

   ⚠ 座標是【商工登記地址】，不是【職災發生地點】。
     這一層的圖釘會落在真實門牌上，所以誤讀的代價比「區中心的點」高得多：
     那是一棟具體的建築物。措辭在畫面上不可以省。 */

/** 一筆點位。用陣列而不是物件是為了檔案大小（23,815 筆，gzip 後 431 KB）。 */
export type RawPoint = [
  name: string,
  lat: number,
  lng: number,
  exact: 0 | 1,      // 1 = 定位到門牌，0 = 只定位到路名
  n: number,         // 職安法裁處筆數
  fatal: number,     // 其中公告涉及死亡災害的筆數
  pending: number,   // 其中行政救濟尚未終結的筆數
  haz: string,       // 最主要的危害型態代碼
  year: number,      // 最近一次裁處的西元年
  hazmask: number,   // 危害型態位元遮罩，見 haz_order
];

export interface PointDataset {
  schema: number;
  cols: string[];
  basis: string;
  note: string;
  exact_n: number;
  total: number;
  /** ⚠ 位元順序。前端必須用這一份解讀 hazmask —— 兩邊對齊的隱性契約。 */
  haz_order: string[];
  pts: RawPoint[];
}

export interface Pt {
  name: string;
  lat: number;
  lng: number;
  exact: boolean;
  n: number;
  fatal: number;
  pending: number;
  haz: string;
  year: number;
  mask: number;
}
