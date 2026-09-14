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
  LookupResult, Principal, Severity, ViolationRef,
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
  ps?: [string, [string, number, [string, string][]][]][];
  /** 這家公司的公告裡出現過、但不是最常見的其他姓名寫法 */
  alt?: string[];
  /** 得獎與驗證。[kind, 原始全名, 證書編號或獎別, 有效期起, 有效期迄, 是否有效] */
  cr?: [string, string, string, string, string, number][];
  /** 重大職災。[角色, 日期, 災害類型, 罹災人數, 工程名稱, 場所, 檢查機構, 比對方式, 對造] */
  ic?: [string, string, string, number, string, string, string, string, string][];
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
  companies: number;
  violations: number;
  source: string;
  source_url: string;
}

const BASE = `${import.meta.env.BASE_URL}data/`;

let metaPromise: Promise<Meta | null> | null = null;
let hazardPromise: Promise<Record<string, { name: string; duty: string }>> | null = null;
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

function getHazards(): Promise<Record<string, { name: string; duty: string }>> {
  hazardPromise ??= getJSON<Record<string, { name: string; duty: string }>>("hazards.json")
    .then((h) => h ?? {});
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

/**
 * name 是否依序包含 q 的每一個字。回傳「鬆緊程度」，數字越小越貼。
 * 對不上回 -1。
 *
 * 鬆緊 = 最後一個配對字的位置 − q 的長度。
 * 「台積電」對「台灣積體電路製造⋯」→ 電在第 5 位，5 − 3 = 2；
 * 對「台北市積善電機⋯」之類位置更後面的就會拿到更大的數字，排後面。
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
  return i === q.length ? last - q.length : -1;
}

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
    if (sc >= 0) scored.push([Math.min(2, sc >> 1), pos, name.length, name]);
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
  const head = names.slice(0, DESCRIBE_LIMIT);
  const rest = names.slice(DESCRIBE_LIMIT);
  const got = await Promise.all(head.map((n) => findEntry(n, shards)));
  const out: Candidate[] = head.map((name, i) => ({
    name,
    tax_id: got[i]?.t ?? "",
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
  haz: Record<string, { name: string; duty: string }>,
): ViolationRef[] {
  return raw
    .map(([date, law, content, fine, severity, appeal, docNo, codes, fatal]) => {
      const hazards: Hazard[] = codes
        .filter((c) => haz[c])
        .map((c) => ({ code: c, name: haz[c].name, duty: haz[c].duty }));
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

/** 查詢的四種結果。查不到跟沒資料是兩件事，UI 的說法完全不同。 */
export type LookupOutcome =
  | { kind: "hit"; result: LookupResult }
  // 要使用者自己選。reason 是「為什麼會走到選單」，三種的說法完全不同：
  //   core    核心名撞名（「大同」對到好幾家真的不同的公司）
  //   suffix  使用者把組織型態字尾打到一半
  //   abbrev  使用者打的是簡稱，系統用字面猜的
  | { kind: "choose"; candidates: Candidate[]; note?: string;
      reason?: "core" | "suffix" | "abbrev" }
  | { kind: "miss" }                           // 有資料，但沒有這家的紀錄
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

  let self = await findEntry(query, shards);
  if (!self) {
    const cands = await findByCore(query, shards);
    if (cands.length > 1) {
      return { kind: "choose", candidates: await describe(cands, shards),
               reason: "core" };
    }
    if (cands.length === 1) self = await findEntry(cands[0], shards);
  }
  if (!self) {
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
    if (abbrev.length) {
      return {
        kind: "choose",
        reason: "abbrev",
        candidates: await describe(abbrev, shards),
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
    for (const [otherName, confidence, ev] of entries) {
      const other = await findEntry(otherName, shards);
      linked.push({
        tax_id: other?.t ?? "",
        name: otherName,
        status: other?.s ?? "",
        established: other?.e ?? null,
        // ⚠ entity 表沒有存「公司狀況日期」，寧可給 null 也不要把
        //   「解散」這種狀態字塞進日期欄位騙過型別檢查。
        dissolved: null,
        confidence,
        evidence: ev.map(([kind, detail]) => ({
          kind: kind as EvidenceKind, detail,
        })),
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
  const result: LookupResult = {
    query,
    company: {
      tax_id: self.t,
      name: self.n,
      status: self.s,
      established: self.e,
      address: self.a,
      own_violations: own,
      incidents: self.ic ? toIncidents(self.ic) : undefined,
      credentials: (self.cr ?? []).map(
        ([kind, unit, detail, validFrom, validTo, act]) => ({
          kind: kind as Credential["kind"], unit, detail,
          valid_from: validFrom, valid_to: validTo, active: act === 1,
        })),
    },
    principals,
    summary: {
      own_violation_count: own.length,
      linked_violation_count: linked.reduce((n, c) => n + c.violations.length, 0),
      linked_osha_count: linked.reduce(
        (n, c) => n + c.violations.filter((v) => v.law.includes("職業安全")).length, 0),
      highest_confidence: linked.reduce((m, c) => Math.max(m, c.confidence), 0),
      hazards: summariseHazards(all),
      fatal_count: all.filter((v) => v.fatal).length,
    },
  };
  return { kind: "hit", result };
}
