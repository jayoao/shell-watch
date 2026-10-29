/**
 * 查詢層 —— 從靜態分片組出契約裡的 LookupResult。
 *
 * ══════════════════════════════════════════════════════════════
 * 為什麼沒有後端
 * ══════════════════════════════════════════════════════════════
 * 全部 175,988 家公司、628,893 筆裁處，序列化後 229 MB、gzip 34 MB。
 * 切成 512 片之後，**一次查詢只下載約 68 KB**。
 * 所以不需要資料庫、不需要伺服器，demo 當天也不會因為後端掛掉而開天窗。
 *
 * 分片編號 = FNV-1a(正規化後的公司名) % 512，前後端各算一次，
 * 所以**不需要索引檔** —— 索引 175,988 個公司名本身就要好幾 MB。
 *
 * ⚠ fnv1a() 與 normName() 必須跟 pipeline/publish.py 裡的一模一樣。
 *   改了一邊沒改另一邊，症狀是「有些公司查不到」而不是報錯。
 *   那種 bug 沒有對拍測試會找很久。
 */
import type {
  Candidate, Credential, EvidenceKind, Hazard, Incident, LinkedCompany,
  LookupResult, Principal, SafetyStaff, SafetyUnits, Severity, Succession,
  ViolationRef,
} from "../types/contracts";

/** ⚠ 跟 pipeline/publish.py 的 fnv1a() 對拍，見 tests/test_publish.py */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  const bytes = new TextEncoder().encode(s);
  for (const b of bytes) {
    h = Math.imul(h ^ b, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** ⚠ 跟 pipeline/join.py 的 norm_name() 對拍 */
export function normName(s: string): string {
  return (s ?? "")
    .trim()
    .replace(/ /g, "")
    .replace(/\u3000/g, "")
    .replace(/臺/g, "台")
    .replace(/（/g, "(")
    .replace(/）/g, ")");
}

/** ⚠ 2026-10-29：商工登記快照裡的統編是數字存的，開頭的 0 被吃掉了（台電 03795904 →
 *  "3795904"，4,968 家）。pipeline/refine.py 已經補回 8 碼；這裡是給舊分片的保險。 */
export function tax8(t: string | null | undefined): string {
  const s = (t ?? "").trim();
  return /^\d{1,7}$/.test(s) ? s.padStart(8, "0") : s;
}

const SHARDS_FALLBACK = 512;

/** 分片裡一筆裁處的欄位順序。⚠ 改順序要同時改 publish.py 並升 schema */
type RawViolation = [
  string,          // 0 裁處日期
  string,          // 1 法規法條
  string,          // 2 違反內容
  number,          // 3 罰鍰
  string,          // 4 嚴重度
  string | null,   // 5 訴願
  string,          // 6 處分字號
  string[],        // 7 危害型態代碼
  number,          // 8 是否涉及死亡災害
  string[],        // 9 人話標籤 [主題, 標籤]，對不到是空陣列
];

interface RawEntry {
  n: string;
  t: string;
  s: string;
  e: string | null;
  a: string | null;
  v: RawViolation[];
  p?: string;
  /** 依「組的負責人姓名」分群的連結。同一家公司在來源裡有兩種姓名寫法時，
   *  會有兩筆 —— 連結是靠哪一種寫法對上的，就掛在哪一種底下。 */
  ps?: [string, [string, [string, string][]][]][];
  /** 這家公司的公告裡出現過、但不是最常見的其他姓名寫法 */
  alt?: string[];
  /** 得獎與驗證。[kind, 原始全名, 證書編號或獎別, 有效期起, 有效期迄, 是否有效] */
  cr?: [string, string, string, string, string, number][];
  /** 重大職災。[角色, 日期, 災害類型, 罹災人數, 工程名稱, 場所, 檢查機構, 比對方式, 對造] */
  ic?: [string, string, string, number, string, string, string, string, string][];
  /** 時序型樣態。對造完整名稱 → [角色, 舊公司最後裁處年, 新公司設立年, 是否同年] */
  sc?: Record<string, [string, number, number, number]>;
  /** 安衛人員備查。n = 真實場所數；me = 公司本身那一筆；o = 其他場所（最多 30）。
   *  ⚠ 每一筆的數字順序是 [登錄日期, 管理員, 安全管理師, 衛生管理師, 甲, 乙, 丙]。
   *  順序改了一定要同步改 pipeline/publish.py 的 compact_safety() ——
   *  分片與程式的欄位順序不一致不會報錯，只會安靜地把甲種寫成乙種。 */
  su?: {
    n: number;
    me?: [number, number, number, number, number, number, number];
    o: [string, number, number, number, number, number, number, number][];
  };
}

/**
 * 一條連結有幾項**獨立**佐證。
 *
 * ⚠ same_name（姓名相同）與 rare_name（姓名罕見）都不算。兩者講的是
 *   同一件事：這個姓名。罕見只是讓「同名巧合」的機率變低，沒有提供
 *   第二個獨立的線索。算成兩項等於把同一個訊號數兩次。
 *
 * ⚠ 這個函式同時是**排序依據**。以前排序用的是分片裡的 0–1 分數，
 *   那個分數已經拿掉了（見 contracts.ts 的 independent 註解）。
 */
export function independentCount(ev: { kind: EvidenceKind }[]): number {
  return ev.filter((e) => e.kind !== "same_name" && e.kind !== "rare_name").length;
}

/** [登錄日期, 管理員, 安全管理師, 衛生管理師, 甲, 乙, 丙] → SafetyStaff。
 *  ⚠ 這個順序是跟 pipeline/publish.py 的 compact_safety() 約定的，改一邊等於說謊。 */
function toStaff(v: readonly number[]): SafetyStaff {
  return { filed: v[0], mgr: v[1], safe: v[2], health: v[3],
           a: v[4], b: v[5], c: v[6] };
}

function toSafety(su: NonNullable<RawEntry["su"]>): SafetyUnits {
  return {
    total: su.n,
    self: su.me ? toStaff(su.me) : undefined,
    sites: su.o.map(([unit, ...rest]) => ({ unit, ...toStaff(rest) })),
  };
}

/** 分片。e = 完整名稱 → 資料；a = 核心名 → 完整名稱清單 */
interface Shard {
  e: Record<string, RawEntry>;
  a: Record<string, string[]>;
}

export interface Meta {
  schema: number;
  /** 公司名 → 分片編號。前端算出來要一樣，見 getMeta() */
  hash_check?: Record<string, number>;
  generated_at: string;
  /** 這一次發布的版本字串（UTC 時間戳）。用來破分片的快取。 */
  version?: string;
  shards: number;
  /** 首字索引的分片數。舊的資料沒有這個欄位，缺的時候就當作沒有索引。 */
  x_shards?: number;
  /** 資料涵蓋到的最後一個裁處日期（民國 YYY/MM/DD，例如 "115/08/31"）。
   *  ⚠ 年度分布的最後一格要靠它判斷是不是「部分年度」。
   *  舊的分片沒有這個欄位，缺的時候前端就不標 —— 寧可不講，不要猜。 */
  coverage_to?: string;
  /** 商工登記存在性索引的分片數。只有 registry.py 跑過才會有。 */
  g_shards?: number;
  /** 商工登記前綴索引（前三個字）的分片數。只有 registry_prefix.py 跑過才會有。 */
  rp_shards?: number;
  /** 重大職災對到的事業單位家數（publish.py 寫入）。舊的 meta 沒有。 */
  incident_companies?: number;
  companies: number;
  violations: number;
  source: string;
  source_url: string;
}

const BASE = `${import.meta.env.BASE_URL}data/`;

let metaPromise: Promise<Meta | null> | null = null;
let hazardPromise: Promise<HazardDict> | null = null;
const shardCache = new Map<number, Promise<Shard | null>>();

/**
 * 分片的版本字串。meta.json 一載到就設定，之後所有 /data/ 的請求都帶上
 * `?v=...`。
 *
 * ⚠ 為什麼需要：分片檔名沒有內容雜湊（編號是 FNV-1a 算的，資料更新後
 *   檔名不變），所以瀏覽器會把舊的分片留在快取裡。
 *
 * ⚠⚠ 這不只是「資料晚一點更新」。**欄位格式一改，舊分片配新程式會安靜地
 *   錯位** —— 2026-09-14 實測：得獎欄位從 5 個元素變成 6 個之後，
 *   拿到舊分片的畫面顯示「有效至 1 已到期」，而正確答案是
 *   「有效期間 民國 114/10/13–民國 117/10/12」。畫面沒有報錯，只是每一欄
 *   都往前移一格。那比看到錯誤訊息危險得多。
 */
let dataVersion = "";

async function getJSON<T>(path: string, opts?: RequestInit): Promise<T | null> {
  try {
    const sep = path.includes("?") ? "&" : "?";
    const url = BASE + path + (dataVersion ? `${sep}v=${dataVersion}` : "");
    const r = await fetch(url, opts);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    // 沒有部署資料時走展示樣本，這是預期路徑不是錯誤
    return null;
  }
}

/** 雜湊對不上時為真。UI 要顯示硬錯誤，不能安靜地回「查無」。 */
export let hashMismatch: string | null = null;

/**
 * 有沒有完整資料。null 代表只有展示樣本可用。
 *
 * ⚠ 順便驗跨語言雜湊。publish.py 會把幾組真實公司名的分片編號寫進
 *   meta.json，這裡重算一次。對不上代表兩邊的 fnv1a()／normName()
 *   已經不一致 —— 那時候查詢會安靜地全部回「查無」，
 *   看起來像資料沒部署好，其實是程式錯了。**一定要吵。**
 */
export function getMeta(): Promise<Meta | null> {
  // ⚠ meta.json 一定要重新驗證，它就是版本的來源。
  //   它自己被快取住的話，下面那個 ?v= 會一直帶舊的版本號，等於沒破快取。
  metaPromise ??= getJSON<Meta>("meta.json", { cache: "no-cache" }).then((m) => {
    if (m?.version) dataVersion = m.version;
    if (m?.hash_check) {
      for (const [name, want] of Object.entries(m.hash_check)) {
        const got = fnv1a(normName(name)) % (m.shards || SHARDS_FALLBACK);
        if (got !== want) {
          hashMismatch =
            `分片雜湊與後端不一致（「${name}」前端算出 ${got}，資料是 ${want}）。` +
            "web/src/lib/lookup.ts 的 fnv1a()／normName() " +
            "跟 pipeline/publish.py 的版本已經不同步。";
          console.error(hashMismatch);
          break;
        }
      }
    }
    return m;
  });
  return metaPromise;
}

type HazardDict = Record<string, { name: string; duty: string; phrase?: string }>;

/** 人話標籤 → 法規要求雇主做什麼。載一次，全站共用。 */
export type PlainDict = Record<string, { topic: string; duty: string }>;
let plainPromise: Promise<PlainDict> | null = null;

export function getPlainLaw(): Promise<PlainDict> {
  plainPromise ??= getJSON<PlainDict>("plainlaw.json").then((d) => d ?? {});
  return plainPromise;
}

function getHazards(): Promise<HazardDict> {
  hazardPromise ??= getJSON<HazardDict>("hazards.json").then((h) => h ?? {});
  return hazardPromise;
}

function getShard(n: number): Promise<Shard | null> {
  let p = shardCache.get(n);
  if (!p) {
    p = getJSON<Shard>(`c/${n}.json`);
    shardCache.set(n, p);
  }
  return p;
}

async function findEntry(name: string, shards: number): Promise<RawEntry | null> {
  const key = normName(name);
  if (!key) return null;
  const shard = await getShard(fnv1a(key) % shards);
  return shard?.e?.[key] ?? null;
}

/**
 * 核心名 →（可能多家）完整名稱。
 *
 * ⚠ 撞名的時候**不要自己挑一家**。核心名「大同」可能對到好幾家不相干的
 *   公司，挑錯就是把 A 公司的裁處紀錄顯示成 B 公司的 —— 那是名譽損害，
 *   不是體驗問題。實測 2.0% 的核心名會對到多家，一律讓使用者選。
 */
async function findByCore(name: string, shards: number): Promise<string[]> {
  const key = normName(name);
  if (!key) return [];
  const shard = await getShard(fnv1a(key) % shards);
  return shard?.a?.[key] ?? [];
}

/**
 * 組織型態字尾。⚠ 使用者常常打到一半就按查詢。
 *
 * 這個查詢系統只有兩種鍵查得到：**完整公司名**與**核心名**（去掉組織型態字尾）。
 * 實測「旭隆實業」查得到（核心名，分片 982）、「旭隆實業股份有限公司」查得到
 * （完整名，分片 1214），但中間的「旭隆實業股份」**兩種鍵都不是**，
 * 而且它自己雜湊到分片 413 —— 連「附近有沒有像的」都掃不到，因為翻錯本子了。
 *
 * 沒有索引檔就做不到前綴搜尋（索引 17 萬個公司名本身就要好幾 MB，
 * 那會犧牲掉「一次查詢只下載一片」這個設計）。所以改成：查不到的時候，
 * 把尾端「打到一半的組織型態」切掉再試一次。
 */
const ORG_SUFFIX = [
  "股份有限公司", "有限公司", "無限公司", "兩合公司",
  "分公司", "公司", "企業社", "工作室", "商行", "事務所", "工程行",
];

/** 把尾端打到一半的組織型態切掉，回傳值得再試一次的候選字串（長的優先）。 */
export function trimPartialOrgSuffix(q: string): string[] {
  const out: string[] = [];
  for (const suf of ORG_SUFFIX) {
    for (let k = suf.length; k >= 1; k--) {
      const frag = suf.slice(0, k);
      if (q.length > frag.length && q.endsWith(frag)) {
        const cut = q.slice(0, -frag.length);
        if (cut && cut !== q && !out.includes(cut)) out.push(cut);
      }
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

// ── 簡稱查詢 ────────────────────────────────────────────────
//
// 「台積電」這種簡稱，兩種既有的鍵都對不到：它不是完整名稱，也不是核心名
// （核心名只是砍掉「股份有限公司」字尾，不會從中間挑字）。而使用者——
// 包括第一次打開這個網站的人——打的就是簡稱。
//
// ⚠ 為什麼不做全文索引：17 萬個公司名的索引本身好幾 MB，會犧牲掉
//   「一次查詢只下載一片」這個設計。改成**只用第一個字**當鍵，
//   把同首字的公司名切成 256 片，查不到的時候才下載其中一片。
//
// ⚠⚠ 這個做法的限制要講清楚：比對是**從第一個字錨定**的子序列。
//   「台積電」→「台灣積體電路製造股份有限公司」找得到（台…積…電 依序出現）；
//   「積體電路」找不到，因為它不是從「台」開始。多數人從頭簡稱，
//   但這不是全文搜尋，不要對外說成搜尋引擎。
const prefixCache = new Map<number, Promise<Record<string, string[]> | null>>();

/** ⚠ 跟 pipeline/publish.py 的 prefix_shard() 對拍 */
function prefixShard(ch: string, n: number): number {
  return fnv1a(ch) % n;
}

function getPrefix(n: number): Promise<Record<string, string[]> | null> {
  let p = prefixCache.get(n);
  if (!p) {
    p = getJSON<Record<string, string[]>>(`x/${n}.json`);
    prefixCache.set(n, p);
  }
  return p;
}

/** subseqScore 的「對不上」。⚠ 不可以用 -1 —— 見下面。 */
const NO_MATCH = -999;

/**
 * name 是否依序包含 q 的每一個字。回傳「鬆緊程度」，數字越小越貼。
 * 對不上回 NO_MATCH。
 *
 * 鬆緊 = 最後一個配對字的位置 − q 的長度。
 * 「台積電」對「台灣積體電路製造⋯」→ 電在第 5 位，5 − 3 = 2；
 * 對「台北市積善電機⋯」之類位置更後面的就會拿到更大的數字，排後面。
 *
 * ⚠⚠ 2026-09-25：這裡原本用 -1 當「對不上」的哨兵值，而**前綴完全吻合
 *   算出來也是 -1**（前綴吻合時 last === q.length - 1）。兩者撞號，於是
 *   呼叫端的 `sc >= 0` 把每一個前綴吻合的候選都當成沒對上丟掉。
 *
 *   實測後果：索引裡 176,359 家公司，有 176,344 家「打自己名字的前 2–4
 *   個字反而查不到」。打「國城」找不到國城營造有限公司，打「保吉」找不到
 *   保吉早午餐卻找得到保信吉商行 —— 而本站搜尋框的範例就寫著「國城營造
 *   有限公司」。
 *
 *   「台積電」是少數會過的，因為它是**不連續**子序列（台⋯積⋯電），
 *   算出來 sc = 1。難的那種會，簡單的那種不會，所以沒有人發現。
 *
 * ⚠ 哨兵值與合法回傳值永遠要能分辨。這個函式的合法值域含負數，
 *   所以哨兵不可以是 -1。
 */
function subseqScore(q: string, name: string): number {
  let i = 0;
  let last = -1;
  for (let j = 0; j < name.length && i < q.length; j++) {
    if (name[j] === q[i]) {
      i += 1;
      last = j;
    }
  }
  return i === q.length ? last - q.length : NO_MATCH;
}

/** 查到登記、但另外列出的相似候選上限。⚠ 每一家要多抓一片分片。 */
const ALSO_LIMIT = 6;

const ABBREV_MIN = 2;      // 一個字的查詢會撈回幾千家，沒有意義
const ABBREV_LIMIT = 12;

/** 用簡稱找候選完整公司名。找不到就回空陣列。 */
export async function searchAbbrev(query: string, meta: Meta): Promise<string[]> {
  const q = normName(query);
  const xs = meta.x_shards ?? 0;
  if (!xs || q.length < ABBREV_MIN) return [];
  const bucket = await getPrefix(prefixShard(q[0], xs));
  const names = bucket?.[q[0]];
  if (!names?.length) return [];
  const scored: [number, number, number, string][] = [];
  names.forEach((name, pos) => {
    const sc = subseqScore(q, normName(name));
    // 走到這裡代表完整名稱與核心名都已經試過且查不到，
    // 所以不會有「完全相同卻被當成候選」的情形。
    if (sc === NO_MATCH) return;
    // ⚠⚠ 分級用 Math.max(0, sc)，**不可以直接用 sc**。
    //   前綴完全吻合的 sc 是 -1，而 -1 >> 1 === -1，會自成一個比 0 更前面
    //   的等級 —— 於是「台電」的第一名變成「台電馬鞍山冰品部」，把
    //   台灣電力股份有限公司擠掉。前綴吻合**不代表**那就是使用者要的那家。
    //   夾到 0 之後它與 sc=0、sc=1 同級，再由索引順序（裁處筆數）決定，
    //   台灣電力與台灣積體電路的第一名都保住了。
    scored.push([Math.min(2, Math.max(0, sc) >> 1), pos, name.length, name]);
  });
  // ⚠ 排序刻意**不是**「貼的排最前面」。實測「台積電」的四個候選裡，
  //   「台積光電科技有限公司」比「台灣積體電路製造股份有限公司」更貼
  //   （字連在一起），但使用者要找的顯然是後者。
  //
  //   所以貼合度只粗分三級（0–1 / 2–3 / 4 以上），同一級之內改用索引順序 ——
  //   索引是依裁處筆數由多到少排的，等於用「規模」當次要線索。
  //   這是猜測，不是判定：候選卡上有統編、地址、裁處筆數，讓使用者自己認。
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return scored.slice(0, ABBREV_LIMIT).map((x) => x[3]);
}

// ── 商工登記存在性索引 ──────────────────────────────────────
//
// 2026-09-15：指導老師拿他合作的廠商「保吉生化學股份有限公司」來查，
// 得到「查無」，結論是我們的搜尋不夠聰明。實際查下去，他**一個字都沒打錯**：
// 那家公司在商工登記是「核准設立、1981 年」，而勞動部的裁處紀錄是 0 筆。
//
// ⚠⚠ 也就是說，那是一個關於他合作廠商的**好消息**，而我們把它講成了
//   一次失敗，第一句話還問他「名稱是完整的法定名稱嗎？」。
//   要修的不是比對，是**答案**——資料庫裡沒有的東西，再厲害的模糊比對
//   或語言模型都猜不出來。
//
// 所以查不到的時候多抓一片商工登記（約 26 KB），把「查無」分成兩種：
//   登記查得到 → 這家公司存在，只是沒有裁處紀錄
//   登記查不到 → 這時候才輪到「你可能打錯了」
const registryCache = new Map<number, Promise<Record<string, number> | null>>();

/** ⚠ 跟 pipeline/registry.py 的 STATUS_CODE 對照表一模一樣 */
const STATUS_LABEL: Record<number, string> = {
  1: "核准設立", 2: "核准停業", 3: "歇業", 4: "解散",
  5: "撤銷", 6: "廢止", 7: "歇業/撤銷", 8: "解散已清算完結",
};

export interface RegistryHit {
  /** 登記現況。查得到但代碼不認識時是空字串 */
  status: string;
  /** 設立年（西元）。0 代表來源沒有這個欄位 */
  established: number;
}

function getRegistry(n: number): Promise<Record<string, number> | null> {
  let p = registryCache.get(n);
  if (!p) {
    p = getJSON<Record<string, number>>(`g/${n}.json`);
    registryCache.set(n, p);
  }
  return p;
}

/* ── 零裁處新公司的前身（tools/clean_successor.py → zr.json）─────────
   ⚠ 欄位順序跟 tools/clean_successor.py 的 write_json() 一致，改一邊要改兩邊。 */
type ZrRow = [string, string, number, number, string, string, string, number, number, string, string];
//  舊公司名 舊現況 舊最後裁處年 新設立年 縣市 商工代表人(遮罩) 公告負責人
//  全台幾家公司登記此遮罩姓名 舊公司登記的代表人也是此遮罩姓名(0/1) 同地址時的地址 舊公司統編
let zrPromise: Promise<Record<string, ZrRow[]>> | null = null;
function getZr(): Promise<Record<string, ZrRow[]>> {
  zrPromise ??= getJSON<Record<string, ZrRow[]>>("zr.json").then((d) => d ?? {});
  return zrPromise;
}

/**
 * 一家**沒有裁處紀錄**的公司，它的負責人有沒有收掉過一家被罰的公司。
 *
 * ⚠⚠ 這是簡報第 3 頁那個情況：「新公司在資料上是乾淨的」。原本的關聯只在
 *   「兩家都有紀錄」的公司之間算，查乾淨的新公司只會看到「沒有裁處紀錄」。
 * ⚠ 身分線索只有商工登記的代表人，而它的中間字被遮掉了（「李_漮」）。
 *   所以只收「全台登記這個遮罩姓名的公司很少」的組合，並且照實寫出幾家。
 *   姓名相符與罕見都是**姓名訊號**；獨立佐證只有同縣市（剛好同地址再加一項）。
 * ⚠ 不放 time_adjacent —— 時間先後是樣態，不是身分佐證，走 succession。
 */
async function predecessors(query: string, shards: number, haz: HazardDict)
  : Promise<LinkedCompany[]> {
  const rows = (await getZr())[normName(query)] ?? [];
  const out: LinkedCompany[] = [];
  for (const [oldName, oldStatus, oldLast, newEst, county, rep, principal,
              repCount, oldRepSame, addr, oldTaxId] of rows) {
    const other = await findEntry(oldName, shards);
    if (!other) continue;                      // 舊公司的分片不在 → 不要顯示一個空殼
    const evidence: { kind: EvidenceKind; detail: string }[] = [
      { kind: "same_county",
        detail: `兩家公司在商工登記上都登記在${county}。` },
    ];
    if (addr) {
      evidence.push({ kind: "same_address",
        detail: `兩家公司都登記在「${addr}」。全國隨機兩家公司同地址的機率是 0.0158%。` });
    }
    evidence.push({ kind: "rare_name",
      detail: `全台商工登記裡，代表人登記為「${rep}」的公司共 ${repCount} 家`
        + (oldRepSame && repCount === 2 ? "，就是這兩家。" : "。") });
    evidence.push({ kind: "same_name",
      detail: `這家公司在商工登記的代表人是「${rep}」（中間的字由商工登記遮蔽），`
        + `與「${oldName}」在勞動部公告上的負責人「${principal}」相符。`
        + `⚠ 姓名相符不等於同一人。` });
    // ⚠ 現況與統編用 zr.json 的（核對過代表人的那一筆），不用分片裡的 ——
    //   同名公司時分片的商工登記事實可能是別家，那一筆不一定已停業。
    out.push({
      tax_id: tax8(oldTaxId),
      name: oldName,
      status: oldStatus || other.s,
      established: other.e ?? null,
      dissolved: null,
      independent: independentCount(evidence),
      succession: { role: "after", old_last_violation: oldLast,
                    new_established: newEst, same_year: false },
      evidence,
      violations: toViolations(other.v, haz),
    });
  }
  return out;
}

/** zr.json 的反方向：舊公司（正規化名）→ [新公司名, 那一列]。 */
let zrRevPromise: Promise<Record<string, [string, ZrRow][]>> | null = null;
function getZrReverse(): Promise<Record<string, [string, ZrRow][]>> {
  zrRevPromise ??= getZr().then((zr) => {
    const rev: Record<string, [string, ZrRow][]> = {};
    for (const [newName, rows] of Object.entries(zr)) {
      for (const row of rows) (rev[normName(row[0])] ??= []).push([newName, row]);
    }
    return rev;
  });
  return zrRevPromise;
}

/**
 * predecessors 的反方向：本頁這家（已停業、被裁處過）**之後**設立、
 * 商工登記代表人姓名相符、而且沒有裁處紀錄的公司。
 *
 * ⚠⚠ 2026-10-29 實測：查「顗博商行」會列出「達廣商行」，但點進達廣商行，
 *   畫面寫的是「負責人姓名未出現在其他公司的公開紀錄上」。兩頁互相矛盾，
 *   而且聽過舊公司名字的人永遠不會知道它換了名字重開。
 * ⚠ 統編要對得上 zr.json 那一列（核對過代表人的那一筆）。同名公司時，
 *   本頁可能是另一家同名的舊公司 —— 那一家不是這條線索的主角。
 * ⚠ 新公司沒有分片（沒有裁處紀錄），現況與設立年改問商工登記索引。
 */
async function successors(self: RawEntry, meta: Meta): Promise<LinkedCompany[]> {
  const rows = (await getZrReverse())[normName(self.n)] ?? [];
  const out: LinkedCompany[] = [];
  for (const [newName, [, , oldLast, newEst, county, rep, principal,
                        repCount, oldRepSame, addr, oldTaxId]] of rows) {
    if (self.t && oldTaxId && tax8(self.t) !== tax8(oldTaxId)) continue;
    const reg = await findInRegistry(newName, meta);
    const evidence: { kind: EvidenceKind; detail: string }[] = [
      { kind: "same_county", detail: `兩家公司在商工登記上都登記在${county}。` },
    ];
    if (addr) {
      evidence.push({ kind: "same_address",
        detail: `兩家公司都登記在「${addr}」。全國隨機兩家公司同地址的機率是 0.0158%。` });
    }
    evidence.push({ kind: "rare_name",
      detail: `全台商工登記裡，代表人登記為「${rep}」的公司共 ${repCount} 家`
        + (oldRepSame && repCount === 2 ? "，就是這兩家。" : "。") });
    evidence.push({ kind: "same_name",
      detail: `「${newName}」在商工登記的代表人是「${rep}」（中間的字由商工登記遮蔽），`
        + `與本頁這家公司在勞動部公告上的負責人「${principal}」相符。`
        + `⚠ 姓名相符不等於同一人。` });
    out.push({
      tax_id: "",
      name: newName,
      status: reg?.status ?? "",
      established: reg?.established ? String(reg.established) : String(newEst),
      dissolved: null,
      independent: independentCount(evidence),
      succession: { role: "before", old_last_violation: oldLast,
                    new_established: newEst, same_year: false },
      evidence,
      violations: [],
    });
  }
  return out;
}

/* ── 同一家公司的分公司、廠區 ───────────────────────────────────
   ⚠⚠ 2026-10-29 實測：查「台灣積體電路製造股份有限公司」只看到總公司 27 筆，
     而「⋯先進封測五廠」3 筆、「⋯十八B廠」1 筆完全沒提 —— 要去那個廠區面試的人
     最需要的就是那幾筆。分公司與廠區在公告上是**另一個事業單位**，
     所以不能合併筆數，只能告訴使用者「另外還有」，讓他自己點。
   ⚠ 用首字索引（x/）找：名稱以本公司全名開頭、後面還有字的事業單位。
     只在全名以「公司」結尾時才找 —— 「大同」開頭的不一定是大同公司的分支，
     「大同股份有限公司」開頭的才是。
   ⚠ 反方向（本頁是分支）：取到第一個「公司」為止當總公司名，總公司要真的有分片。 */
export interface Branches { parent?: string; names: string[] }

export async function findBranches(name: string): Promise<Branches> {
  const meta = await getMeta();
  const xs = meta?.x_shards ?? 0;
  const key = normName(name);
  const out: Branches = { names: [] };
  if (!meta || !xs || !key) return out;
  const i = key.indexOf("公司");
  if (i > 0 && i + 2 < key.length) {
    const parent = key.slice(0, i + 2);
    if (await findEntry(parent, meta.shards || SHARDS_FALLBACK)) out.parent = parent;
  }
  const root = out.parent ?? (key.endsWith("公司") ? key : "");
  if (!root) return out;
  const bucket = await getPrefix(prefixShard(root[0], xs));
  out.names = (bucket?.[root[0]] ?? []).filter((n) => {
    const k = normName(n);
    return k.startsWith(root) && k !== root && k !== key;
  });
  return out;
}

/**
 * 商工登記前綴搜尋：名稱以使用者打的字**開頭**的公司（至少三個字）。
 *
 * ⚠⚠ 2026-10-29：「保吉生」什麼都查不到。接字尾只救得了「打完整、只少字尾」的情形，
 *   使用者打到一半就按查詢才是常態。索引見 pipeline/registry_prefix.py：
 *   前三個字當鍵、一片約 16 KB，只在其他方法都找不到時才抓。
 * ⚠ 每個前綴底下已經依「營業中優先、資本額大優先」排好，取前面幾個就好。
 */
const RP_LEN = 3;
const RP_LIMIT = 12;
const rpCache = new Map<number, Promise<Record<string, [string, number][]> | null>>();
async function registryPrefix(query: string, meta: Meta): Promise<[string, RegistryHit][]> {
  const q = normName(query);
  const n = meta.rp_shards ?? 0;
  if (!n || q.length < RP_LEN) return [];
  const head = q.slice(0, RP_LEN), tail = q.slice(RP_LEN);
  const k = fnv1a(head) % n;
  let p = rpCache.get(k);
  if (!p) { p = getJSON<Record<string, [string, number][]>>(`rp/${k}.json`); rpCache.set(k, p); }
  const list = (await p)?.[head] ?? [];
  const out: [string, RegistryHit][] = [];
  for (const [rest, packed] of list) {
    if (!rest.startsWith(tail) || head + rest === q) continue;
    out.push([head + rest, {
      status: STATUS_LABEL[Math.floor(packed / 10000)] ?? "",
      established: packed % 10000,
    }]);
    if (out.length >= RP_LIMIT) break;
  }
  return out;
}

/** 首字索引裡「有裁處紀錄」的名稱（正規化）。用來分辨商工登記候選有沒有紀錄，不多抓分片。 */
async function namesWithRecords(query: string, meta: Meta): Promise<Set<string>> {
  const q = normName(query);
  const xs = meta.x_shards ?? 0;
  if (!xs || !q) return new Set();
  const bucket = await getPrefix(prefixShard(q[0], xs));
  return new Set((bucket?.[q[0]] ?? []).map(normName));
}

/**
 * 使用者沒打組織型態字尾時，接上常見字尾逐一問商工登記。
 *
 * ⚠ 每個字尾各抓一片商工登記索引（每片約 28 KB），只在「什麼都查不到」時才走，
 *   所以刻意只列最常見的幾種。打了錯的字尾（「保吉生化學有限公司」）先切掉再接。
 */
const REG_SUFFIX = [
  "股份有限公司", "有限公司", "企業社", "商行", "工程行", "實業社",
  "企業行", "行", "社", "工作室", "商號", "事務所",
];
async function registryBySuffix(query: string, meta: Meta): Promise<[string, RegistryHit][]> {
  let base = normName(query);
  for (const suf of [...ORG_SUFFIX].sort((a, b) => b.length - a.length)) {
    if (base.endsWith(suf) && base.length > suf.length + 1) { base = base.slice(0, -suf.length); break; }
  }
  if (base.length < 2) return [];
  const names = REG_SUFFIX.map((suf) => base + suf).filter((n) => n !== normName(query));
  const hits = await Promise.all(names.map((n) => findInRegistry(n, meta)));
  return names.flatMap((n, i) => (hits[i] ? [[n, hits[i]!] as [string, RegistryHit]] : []));
}

/** 這個名稱在經濟部商工登記裡存不存在。沒有索引或查不到都回 null。 */
export async function findInRegistry(
  query: string, meta: Meta,
): Promise<RegistryHit | null> {
  const key = normName(query);
  const gs = meta.g_shards ?? 0;
  if (!gs || !key) return null;
  const shard = await getRegistry(fnv1a(key) % gs);
  const packed = shard?.[key];
  if (packed === undefined) return null;
  return {
    status: STATUS_LABEL[Math.floor(packed / 10000)] ?? "",
    established: packed % 10000,
  };
}

const SOURCE_URL = "https://announcement.mol.gov.tw/";

/**
 * 把候選的完整名稱補成「看得出差別」的候選卡。
 *
 * ⚠ 每一家要各抓一片（候選之間的雜湊不同，不會在同一片裡），
 *   所以有上限。超過的部分照樣列出來，只是沒有統編與地址 ——
 *   寧可少資訊，也不要為了補齊欄位一次下載兩百片。
 */
const DESCRIBE_LIMIT = 24;

async function describe(names: string[], shards: number): Promise<Candidate[]> {
  // ⚠ 2026-10-29：「台灣電力」列出「台灣電力股份有限公司」與「臺灣電力股份有限公司」兩張
  //   一模一樣的卡（核心名索引兩種寫法都收了）。正規化後相同的只留一張。
  const uniq = new Set<string>();
  names = names.filter((n) => { const k = normName(n); if (uniq.has(k)) return false; uniq.add(k); return true; });
  const head = names.slice(0, DESCRIBE_LIMIT);
  const rest = names.slice(DESCRIBE_LIMIT);
  const got = await Promise.all(head.map((n) => findEntry(n, shards)));
  const out: Candidate[] = head.map((name, i) => ({
    name,
    tax_id: tax8(got[i]?.t),
    status: got[i]?.s ?? "",
    established: got[i]?.e ?? null,
    address: got[i]?.a ?? null,
    violation_count: got[i]?.v.length ?? 0,
  }));
  for (const name of rest) {
    out.push({ name, tax_id: "", status: "", established: null,
               address: null, violation_count: 0 });
  }
  return out;
}

function toIncidents(raw: NonNullable<RawEntry["ic"]>): Incident[] {
  return raw.map(([role, date, disaster, casualties, project, site, agency,
                   match, counterpart]) => ({
    role: role === "o" ? "owner" : "unit",
    date, disaster, casualties, project, site, agency,
    match: match === "n" ? "name" : "tax",
    counterpart,
  }));
}

function toViolations(
  raw: RawViolation[],
  haz: HazardDict,
): ViolationRef[] {
  return raw
    .map(([date, law, content, fine, severity, appeal, docNo, codes, fatal,
           plain]) => {
      const hazards: Hazard[] = codes
        .filter((c) => haz[c])
        .map((c) => ({ code: c, name: haz[c].name, duty: haz[c].duty,
                       phrase: haz[c].phrase }));
      return {
        date,
        law,
        content,
        // 勞動部沒有單筆永久連結，處分字號是唯一能查回原始公告的線索。
        // ⚠ 這是法律風險的防線，不能為了畫面好看拿掉。
        // ⚠ 它是獨立欄位，**不要再串回 content**。以前是串在違反內容後面的
        //   「（處分字號 ○○）」，結果是：欄位對不齊、使用者沒辦法只複製字號、
        //   長清單想只顯示字號也做不到。
        doc_no: docNo,
        fine,
        severity: severity as Severity,
        appeal,
        source_url: SOURCE_URL,
        hazards,
        fatal: fatal === 1,
        // ⚠ 舊分片沒有第 10 個欄位（plain），會是 undefined。
        //   一定要防 —— 這正是 2026-09-14 那個快取 bug 的形狀：
        //   欄位數一改，舊分片配新程式會安靜地錯位。
        plain: plain?.length === 2
          ? { topic: plain[0], label: plain[1] }
          : undefined,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function summariseHazards(vs: ViolationRef[]) {
  const count = new Map<string, { name: string; count: number }>();
  for (const v of vs) {
    for (const h of v.hazards ?? []) {
      const cur = count.get(h.code);
      if (cur) cur.count += 1;
      else count.set(h.code, { name: h.name, count: 1 });
    }
  }
  return [...count.entries()]
    .map(([code, x]) => ({ code, name: x.name, count: x.count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 常見簡稱／品牌／英文名對照（7-11、TSMC、台電⋯⋯）。
 *
 * ⚠⚠ 2026-10-29：AI 只在**離線**建表時用（tools/alias_seed.tsv），
 *   每一個法定名稱都由 tools/alias_build.py 核對過商工登記或裁處紀錄，查不到的丟掉。
 *   查詢時不呼叫任何 AI、不送出查詢 —— 跟嚴重度分級同一個做法。
 * ⚠ 一律列成候選讓使用者點，不自動跳進去：品牌背後的經營公司會換。
 * ⚠ 鍵的正規化跟 tools/alias_build.py 的 alias_key() 一模一樣。
 */
export function aliasKey(s: string): string {
  return [...s.normalize("NFKC").toLowerCase().replace(/臺/g, "台")]
    .filter((ch) => !" \t-_.'’°".includes(ch)).join("");
}
let aliasPromise: Promise<Record<string, string[]>> | null = null;
function getAlias(): Promise<Record<string, string[]>> {
  aliasPromise ??= import("../data/alias.json")
    .then((m) => m.default as Record<string, string[]>)
    .catch(() => ({}));
  return aliasPromise;
}

/** 候選卡：有紀錄的用分片補統編與地址；沒有紀錄的問商工登記補現況。 */
async function candidatesFor(names: string[], meta: Meta, shards: number): Promise<Candidate[]> {
  const out = await describe(names, shards);
  for (const c of out) {
    if (!c.status && !c.tax_id && c.violation_count === 0) {
      const r = await findInRegistry(c.name, meta);
      if (r) { c.status = r.status; c.established = r.established ? String(r.established) : null; }
    }
  }
  return out;
}

/** 查詢的四種結果。查不到跟沒資料是兩件事，UI 的說法完全不同。 */
export type LookupOutcome =
  | { kind: "hit"; result: LookupResult }
  // 要使用者自己選。reason 是「為什麼會走到選單」，三種的說法完全不同：
  //   core    核心名撞名（「大同」對到好幾家真的不同的公司）
  //   suffix  使用者把組織型態字尾打到一半
  //   abbrev  使用者打的是簡稱，系統用字面猜的
  | { kind: "choose"; candidates: Candidate[]; note?: string;
      reason?: "core" | "suffix" | "abbrev" | "alias" }
  // 有資料，但沒有這家的裁處紀錄。registry 有值 = 這個名稱在商工登記查得到，
  // 也就是「這家公司存在，而且紀錄乾淨」，不是「你可能打錯了」。
  //
  // ⚠ also = 字面上相似、且**有裁處紀錄**的事業單位。
  //   「國城」在商工登記裡真的有一家同名公司（1993 年設立、已歇業），
  //   於是 registry 先命中、直接回傳，走不到下面的簡稱比對 ——
  //   而使用者要找的幾乎一定是「國城營造有限公司」。
  //   把候選一起帶出來，讓確定的事實與可能的候選**並存**，
  //   不要用猜的取代事實，也不要因為有事實就把候選藏起來。
  //   before = 負責人姓名相符、已停業且被裁處過的另一家公司（見 predecessors）。
  | { kind: "miss"; registry?: RegistryHit; also?: Candidate[]; before?: LinkedCompany[];
      /** 使用者打的是 8 碼統一編號（本站還不能用統編查） */
      taxQuery?: string;
      /** 打不到兩個字 */
      tooShort?: boolean }
  | { kind: "nodata" };                        // 完整資料沒部署，只有展示樣本

/**
 * 查一家公司。
 *
 * ⚠ 「查不到」不等於「這家公司沒問題」—— 可能是名稱寫法不同，
 *   也可能是該縣市的資料保存期間較短。UI 一定要把這句話寫出來。
 */
export async function lookup(query: string): Promise<LookupOutcome> {
  const meta = await getMeta();
  if (!meta) return { kind: "nodata" };
  const shards = meta.shards || SHARDS_FALLBACK;
  const haz = await getHazards();

  // ⚠ 2026-10-29：打統編原本得到「這個名稱⋯很可能不是它的法定全名」，那是錯的說法。
  //   本站沒有統編索引；老實講，並把人帶到商工登記用統編查。
  const qq = normName(query);
  if (/^\d{8}$/.test(qq)) return { kind: "miss", taxQuery: qq };
  if ([...qq].length < 2) return { kind: "miss", tooShort: true };

  let self = await findEntry(query, shards);
  if (!self) {
    const cands = await findByCore(query, shards);
    if (cands.length > 1) {
      return { kind: "choose", candidates: await describe(cands, shards),
               reason: "core" };
    }
    // ⚠ 核心名只對到一家時原本會直接跳進去。但如果使用者打的**完整名稱本身**
    //   在商工登記查得到，那家才是他要找的 —— 不可以換成「核心名相同的另一家」。
    //   實測：「○○華電訊行」（營業中、零裁處）被直接帶到「○○華電訊有限公司」
    //   （已解散、有裁處），畫面標題是另一家的全名，使用者很容易沒注意到換了公司。
    if (cands.length === 1 && !(await findInRegistry(query, meta))) {
      self = await findEntry(cands[0], shards);
    }
  }
  if (!self) {
    // 常見簡稱／品牌／英文名。⚠ 放在商工登記之前：「全聯」「台電」在商工登記都真的有一家
    //   同名的小公司，先命中它就走不到對照表 —— 而使用者要找的幾乎一定是全聯實業、台灣電力。
    //   名稱完全相同的那一家照樣列在候選裡，不藏起來。
    const al = (await getAlias())[aliasKey(query)] ?? [];
    if (al.length) {
      const names = [...al];
      if (await findInRegistry(query, meta)) names.push(normName(query));
      return {
        kind: "choose", reason: "alias",
        candidates: await candidatesFor(names, meta, shards),
        note: `「${query.trim()}」對照到下列公司。`,
      };
    }
  }
  if (!self) {
    // ⚠⚠ 順序很重要，而且就是這一題踩出來的：先問商工登記這個名稱**存不存在**，
    //   再決定要不要開始猜。
    //
    //   「保吉生化學股份有限公司」在商工登記是核准設立的真公司，裁處 0 筆。
    //   如果先跑下面的切字尾與簡稱比對，畫面會變成「這些是字面上像的公司」
    //   並列出幾家不相干的公司 —— 那比「查無」更糟，因為它在一個
    //   **已經有明確答案**的問題上改用猜的。
    //
    //   名稱在商工登記查得到 = 這是一家真的公司，使用者沒打錯，
    //   結論就是「紀錄乾淨」。不要再猜。
    const reg = await findInRegistry(query, meta);
    if (reg) {
      // ⚠ 這裡只多抓一片 x（約 26 KB）。describe() 每一家要各抓一片，
      //   所以刻意收斂到 ALSO_LIMIT 家 —— 這是附帶資訊，不是主答案，
      //   不值得為它多下載十幾片。
      const before = await predecessors(query, shards, haz);
      // ⚠ 同一家舊公司已經以「前身」列出時，不要在「字面上像」那一組再列一次。
      const shown = new Set(before.map((c) => normName(c.name)));
      const near = (await searchAbbrev(query, meta))
        .filter((n) => !shown.has(normName(n))).slice(0, ALSO_LIMIT);
      return {
        kind: "miss",
        registry: reg,
        also: near.length ? await describe(near, shards) : undefined,
        before: before.length ? before : undefined,
      };
    }

    // 尾端可能是打到一半的組織型態（「旭隆實業股份」）。切掉再試。
    //
    // ⚠ 這條路一律走 choose，**不可以直接跳進去**，即使只對到一家。
    //   切字串是猜測，猜測不能替使用者決定他在看哪一家公司的裁處紀錄 ——
    //   猜錯就是把 A 公司的紀錄顯示成 B 公司的，那是名譽損害。
    for (const cut of trimPartialOrgSuffix(normName(query))) {
      const cands = await findByCore(cut, shards);
      const exact = cands.length ? [] : ((await findEntry(cut, shards)) ? [cut] : []);
      const hits = cands.length ? cands : exact;
      if (hits.length) {
        return {
          kind: "choose",
          reason: "suffix",
          candidates: await describe(hits, shards),
          note: `找不到「${query.trim()}」。`
            + `這個查詢系統要完整公司名稱，或是去掉「股份有限公司」等字尾的名稱。`
            + `以「${cut}」找到以下結果：`,
        };
      }
    }
    // 最後一招：簡稱。「台積電」→「台灣積體電路製造股份有限公司」。
    //
    // ⚠ 一律走 choose，**永遠不要自動跳進唯一的那一家**。子序列比對是猜的，
    //   猜錯就是把 A 公司的裁處紀錄顯示成 B 公司的。使用者自己點，
    //   看到的就是他自己選的公司。
    const abbrev = await searchAbbrev(query, meta);
    // ⚠⚠ 2026-10-29：查「保吉生化學」得到「商工登記與勞動部公告裡都查不到」，
    //   而 Google 一查就是「保吉生化學股份有限公司」。原因是商工登記索引只認**完整名稱**，
    //   簡稱比對又只掃有裁處紀錄的公司 —— 於是「沒被罰過的公司、使用者沒打字尾」
    //   這個最常見的情形，兩條路都走不到，畫面還說他可能打錯了。
    //   所以補上：把常見的組織型態字尾接回去，逐一問商工登記。
    // ⚠ 一樣走 choose，不自動跳進去（接字尾是猜的）。
    // ⚠ 先用前綴（「保吉生」→「保吉生化學股份有限公司」），找不到再接字尾
    //   （「保吉生化學有限公司」這種打錯字尾的，前綴對不上）。
    const pref = await registryPrefix(query, meta);
    const fromReg = pref.length ? pref : await registryBySuffix(query, meta);
    // ⚠⚠ 商工登記候選裡也可能有**被裁處過**的公司。不分辨的話，畫面會對一家
    //   有 27 筆紀錄的公司印出「裁處紀錄 0 筆」—— 那是對使用者說謊。
    //   首字索引本來就列出所有有紀錄的名稱，拿它來分，不必每家多抓一片。
    const rec = fromReg.length ? await namesWithRecords(query, meta) : new Set<string>();
    const order: string[] = [];
    const seen = new Set<string>();
    // ⚠ 排序：「前綴吻合且有紀錄」→ 簡稱比對（都有紀錄）→「前綴吻合、沒有紀錄」。
    //   實測「台積電」：前綴吻合的是「台積電梯有限公司」「台積電企業社」⋯⋯（都 0 筆），
    //   排在前面會把台灣積體電路製造擠到第九個。使用者打品牌簡稱時，要找的通常是
    //   被公告過、規模大的那一家；打法定名稱的前幾個字時，前綴那一組就在下面接著。
    const regWith = fromReg.filter(([x]) => rec.has(normName(x))).map(([x]) => x);
    const regWithout = fromReg.filter(([x]) => !rec.has(normName(x))).map(([x]) => x);
    for (const n of [...regWith, ...abbrev, ...regWithout]) {
      const k = normName(n);
      if (!seen.has(k)) { seen.add(k); order.push(n); }
    }
    if (order.length) {
      const regHit = new Map(fromReg.map(([n, h]) => [normName(n), h] as const));
      const needDescribe = order.filter((n) => !regHit.has(normName(n)) || rec.has(normName(n)));
      const described = new Map(
        (needDescribe.length ? await describe(needDescribe, shards) : []).map((c) => [normName(c.name), c]));
      const candidates: Candidate[] = order.map((n) => {
        const d = described.get(normName(n));
        if (d) return d;
        const h = regHit.get(normName(n))!;
        return { name: n, tax_id: "", status: h.status,
                 established: h.established ? String(h.established) : null,
                 address: null, violation_count: 0 };
      });
      return {
        kind: "choose",
        reason: "abbrev",
        candidates,
        note: `本站沒有名稱正好是「${query.trim()}」的事業單位。`,
      };
    }
    return { kind: "miss" };
  }

  const own = toViolations(self.v, haz);

  // 關聯公司在別的分片，各抓一次。同一片只會抓一次（shardCache）。
  //
  // ⚠ 依**組的負責人姓名**分群。同一家公司在來源公告裡的姓名寫法可能不只一種
  //   （實測有「徐健珩」4 筆、「徐建珩」1 筆的例子），而連結是靠其中一種
  //   對上的。全部壓成一份清單，畫面就會出現「負責人 A 的姓名也出現在這些
  //   公司」配上「B 很罕見」的證據 —— 兩個名字不一樣，使用者看不出為什麼。
  const principals: Principal[] = [];
  for (const [gp, entries] of self.ps ?? []) {
    const linked: LinkedCompany[] = [];
    for (const [otherName, ev] of entries) {
      const other = await findEntry(otherName, shards);
      const evidence = ev.map(([kind, detail]) => ({
        kind: kind as EvidenceKind, detail,
      }));
      const raw = self.sc?.[otherName];
      const succession: Succession | undefined = raw
        ? {
            role: raw[0] === "before" ? "before" : "after",
            old_last_violation: raw[1],
            new_established: raw[2],
            same_year: raw[3] === 1,
          }
        : undefined;
      linked.push({
        tax_id: tax8(other?.t),
        name: otherName,
        status: other?.s ?? "",
        established: other?.e ?? null,
        // ⚠ entity 表沒有存「公司狀況日期」，寧可給 null 也不要把
        //   「解散」這種狀態字塞進日期欄位騙過型別檢查。
        dissolved: null,
        independent: independentCount(evidence),
        succession,
        evidence,
        violations: other ? toViolations(other.v, haz) : [],
      });
    }
    // 這家公司自己的公告用的是別的寫法時，老實寫出來。
    const note = self.p && self.p !== gp
      ? `本系統在這家公司的公開紀錄上另外看到「${self.p}」的寫法；`
        + `這一組連結是以「${gp}」比對出來的。姓名寫法的差異來自來源公告。`
      : "";
    principals.push({
      name: gp,
      role: note ? `負責人（勞動部公告）\u3000${note}` : "負責人（勞動部公告）",
      linked_companies: linked,
    });
  }
  const linked = principals.flatMap((x) => x.linked_companies);

  const all = [...own, ...linked.flatMap((c) => c.violations)];
  const after = await successors(self, meta);
  const result: LookupResult = {
    query,
    company: {
      tax_id: tax8(self.t),
      name: self.n,
      status: self.s,
      established: self.e,
      address: self.a,
      own_violations: own,
      incidents: self.ic ? toIncidents(self.ic) : undefined,
      safety: self.su ? toSafety(self.su) : undefined,
      credentials: (self.cr ?? []).map(
        ([kind, unit, detail, validFrom, validTo, act]) => ({
          kind: kind as Credential["kind"], unit, detail,
          valid_from: validFrom, valid_to: validTo, active: act === 1,
        })),
    },
    principals,
    successors: after.length ? after : undefined,
    summary: {
      own_violation_count: own.length,
      linked_violation_count: linked.reduce((n, c) => n + c.violations.length, 0),
      linked_osha_count: linked.reduce(
        (n, c) => n + c.violations.filter((v) => v.law.includes("職業安全")).length, 0),
      max_independent: linked.reduce((m, c) => Math.max(m, c.independent), 0),
      hazards: summariseHazards(all),
      fatal_count: all.filter((v) => v.fatal).length,
    },
  };
  return { kind: "hit", result };
}
