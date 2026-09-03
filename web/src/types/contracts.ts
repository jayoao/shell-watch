/* ============================================================
   資料契約 —— 兩個人之間的約定。
   資料一定長這樣；需要新欄位先講，不要自己在元件裡湊。

   規則：這個檔案是「唯一的型別來源」。
   後端產出的 JSON 必須符合這裡，前端也只能相信這裡有的欄位。
   ============================================================ */

/** 違法情節的嚴重度。由 LLM 分級 + 人工標註驗證（任務 T7）。 */
export type Severity = "輕微" | "中度" | "重大";

/** 職安法的一筆違規紀錄。地圖頁（T5）用的就是這個。 */
export interface OshaIncident {
  /** 唯一識別。React 的 key 用這個，不要用陣列索引 */
  id: string;
  /** 縣市／單位別，篩選用 */
  county: string;
  announced_date: string;      // YYYY-MM-DD
  disposition_date: string;    // YYYY-MM-DD
  doc_no: string;              // 處分字號
  /** 公司名稱。假資料裡是編的；正式展示一律去識別化 */
  employer: string;
  /** 負責人。顯示時一律遮罩 */
  principal: string;
  law: string;                 // 違反法規法條
  /** 違反內容。會很長，UI 要能換行或截斷 */
  violation: string;
  fine: number;                // 罰鍰（元）
  severity: Severity;
  /** 罹災人數。地圖圓點大小依這個，可能是 0 */
  casualties: number;
  incident_date: string | null;
  location: string | null;
  /** ⚠ 可能是 null —— 沒有座標的要跳過，不能讓整頁當掉 */
  lat: number | null;
  lng: number | null;
  industry: string | null;
  /** 訴願結果。有值代表案件曾被爭議，呈現時要標註 */
  appeal: string | null;
}

export interface OshaDataset {
  generated_at: string;
  source: string;
  source_url: string;
  incidents: OshaIncident[];
}

/* ── 以下是查詢結果卡片用的，主線負責，地圖頁用不到 ───────── */

export type EvidenceKind =
  | "same_name"        // 負責人姓名完全相同
  | "rare_name"        // 姓名罕見
  | "same_county"      // 同縣市
  | "same_address"     // 同地址
  | "time_adjacent"    // 舊公司解散與新公司設立時間鄰接
  | "same_industry"    // 所營事業重疊
  | "shared_director"; // 有第二個共同董監事

export interface Evidence {
  kind: EvidenceKind;
  /** 給人看的說明。這句話會直接顯示在畫面上，所以要寫成完整句子 */
  detail: string;
}

export interface ViolationRef {
  date: string;
  law: string;
  content: string;
  fine: number;
  severity: Severity;
  appeal: string | null;
  /** 官方公告連結。⚠ 每一筆都必須有，這是法律風險的防線 */
  source_url: string;
}

export interface LinkedCompany {
  tax_id: string;
  name: string;
  status: string;              // 登記現況
  established: string | null;
  dissolved: string | null;
  /** 0–1。這不是「是同一個人的機率」，是「證據強度」 */
  confidence: number;
  evidence: Evidence[];
  violations: ViolationRef[];
}

export interface Principal {
  name: string;
  role: string;                // 代表人／董事長／董事…
  linked_companies: LinkedCompany[];
}

export interface LookupResult {
  query: string;
  company: {
    tax_id: string;
    name: string;
    status: string;
    established: string | null;
    address: string | null;
    own_violations: ViolationRef[];
  };
  principals: Principal[];
  summary: {
    own_violation_count: number;
    linked_violation_count: number;
    linked_osha_count: number;
    highest_confidence: number;
  };
}
