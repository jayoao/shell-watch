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
  Evidence, EvidenceKind, Hazard, LinkedCompany, LookupResult, Severity, ViolationRef,
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
  l?: [string, number, [string, string][]][];
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
  shards: number;
  companies: number;
  violations: number;
  source: string;
  source_url: string;
}

const BASE = `${import.meta.env.BASE_URL}data/`;

let metaPromise: Promise<Meta | null> | null = null;
let hazardPromise: Promise<Record<string, { name: string; duty: string }>> | null = null;
const shardCache = new Map<number, Promise<Shard | null>>();

async function getJSON<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(BASE + path);
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
  metaPromise ??= getJSON<Meta>("meta.json").then((m) => {
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

const SOURCE_URL = "https://announcement.mol.gov.tw/";

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
        // 勞動部沒有單筆永久連結，處分字號是唯一能查回原始公告的線索。
        // ⚠ 這是法律風險的防線，不能為了畫面好看拿掉。
        content: content ? `${content}（處分字號 ${docNo}）` : `處分字號 ${docNo}`,
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
  | { kind: "choose"; candidates: string[] }   // 核心名對到多家，要使用者選
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
    if (cands.length > 1) return { kind: "choose", candidates: cands };
    if (cands.length === 1) self = await findEntry(cands[0], shards);
  }
  if (!self) return { kind: "miss" };

  const own = toViolations(self.v, haz);

  // 關聯公司在別的分片，各抓一次。同一片只會抓一次（shardCache）。
  const linked: LinkedCompany[] = [];
  for (const [otherName, confidence, ev] of self.l ?? []) {
    const other = await findEntry(otherName, shards);
    const violations = other ? toViolations(other.v, haz) : [];
    const evidence: Evidence[] = ev.map(([kind, detail]) => ({
      kind: kind as EvidenceKind,
      detail,
    }));
    linked.push({
      tax_id: other?.t ?? "",
      name: otherName,
      status: other?.s ?? "",
      established: other?.e ?? null,
      // ⚠ entity 表沒有存「公司狀況日期」，寧可給 null 也不要把
      //   「解散」這種狀態字塞進日期欄位騙過型別檢查。
      dissolved: null,
      confidence,
      evidence,
      violations,
    });
  }

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
    },
    principals: self.p
      ? [{ name: self.p, role: "負責人（勞動部公告）", linked_companies: linked }]
      : [],
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
