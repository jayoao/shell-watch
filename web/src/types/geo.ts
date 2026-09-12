/* 鄉鎮市區聚合圖的資料契約。產出者是 pipeline/geo.py。

   ⚠ 這份資料的位置基礎是【商工登記地址】，不是【事故發生地點】。
     職安法 74,658 筆裡只有 189 筆填了發生地點（0.25%），
     用發生地點畫圖做不出來。型別名稱刻意叫 District 而不是 Incident，
     就是不要讓人以為這是一顆一顆的事故。 */

export interface DistrictRow {
  /** 縣市＋鄉鎮市區，例如「新北市五股區」 */
  k: string;
  lat: number;
  lng: number;
  /** 職安法裁處筆數 */
  n: number;
  /** 全部 9 部法規的裁處筆數 */
  all: number;
  /** 公告文字提到死亡災害的筆數。⚠ 不等於「造成死亡」 */
  fatal: number;
  /** 行政救濟尚未終結的筆數 */
  pending: number;
  /** 在這個區有裁處紀錄的事業單位家數 */
  co: number;
  /** 這個區現存（未解散歇業）的登記事業單位數 —— 算率的分母 */
  base: number;
  /** 危害型態代碼 → 筆數（15 種全帶） */
  haz: Record<string, number>;
  /** 危害型態代碼 → 其中涉及死亡災害的筆數。篩選危害型態時要用這個，
   *  不能用 fatal —— fatal 是全部型態合計。 */
  hazf: Record<string, number>;
  /** 危害型態代碼 → 其中行政救濟尚未終結的筆數。理由同 hazf。 */
  hazp: Record<string, number>;
  /** 裁處年份 → 筆數 */
  yr: Record<string, number>;
}

export interface DistrictDataset {
  schema: number;
  generated_at: string;
  basis: string;
  note: string;
  source: string;
  districts: number;
  osha_total: number;
  osha_mapped: number;
  all_mapped: number;
  rows: DistrictRow[];
}
