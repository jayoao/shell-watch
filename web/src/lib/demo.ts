/**
 * 決賽現場 demo 用的遮罩模式。網址帶 `?demo=1` 就開啟，整個分頁期間有效。
 *
 * 為什麼要有這個：
 *   這個站最有說服力的畫面，是「負責人的姓名也出現在這些公司的公開紀錄上」
 *   加上「時序」那一塊。但真實案例幾乎都是小型工程行、商行，負責人是一般民眾。
 *   在公開場合把一個真實的人跟「收掉再開」並列投在大螢幕上，是整個專案
 *   名譽風險最高的一刻，也違反我們自己「截圖、影片、簡報一律去識別化」的規則。
 *
 *   這個模式讓 demo 照常跑**正式資料、正式運算**，只在畫面上遮掉可以指認的東西。
 *   評審看到的是真的系統，不是一份手做的假畫面。
 *
 * 遮罩規則與 pipeline/export.py 一模一樣（mask / mask_company / mask_addr /
 * mask_doc_no），簡報上的去識別化樣本與現場畫面才會是同一套寫法。
 *
 * ⚠ 只遮「顯示」，不遮「查詢」。畫面上的名字遮掉之後，點下去還是要查得到
 *   真正那一家 —— 所以保留一張「遮罩後 → 原名」的對照表（只在記憶體裡）。
 * ⚠ 必須是決定性的：同一個名字永遠遮成同一個樣子，否則同組公司會遮成
 *   不一樣，畫面自相矛盾。
 * ⚠ 這不是安全機制。原始資料仍是公開資料，開發者工具看得到。它的目的只是
 *   「不要在投影幕上指認一個人」。
 */

export const DEMO: boolean = (() => {
  try {
    return new URLSearchParams(window.location.search).has("demo");
  } catch {
    return false;
  }
})();

const REAL = new Map<string, string>();      // 遮罩後 → 原名

export function maskPerson(n: string): string {
  const s = n.trim();
  if (s.length <= 1) return s;
  if (s.length === 2) return s[0] + "○";
  return s[0] + "○".repeat(s.length - 2) + s[s.length - 1];
}

export function maskCompany(n: string): string {
  const s = n.trim();
  return s.length > 2 ? "○".repeat(2) + s.slice(2) : s;
}

export function maskAddr(a: string): string {
  if (!a) return a;
  const m = /[路街道]/.exec(a);
  if (m) return a.slice(0, m.index + 1) + "○○○";
  const m2 = /[區鄉鎮市]/.exec(a.slice(3));
  return m2 ? a.slice(0, 3 + m2.index + 1) + "○○○" : "○○○";
}

export function maskDoc(d: string): string {
  const t = (d || "").trim();
  const m = /[0-9０-９]/.exec(t);
  return m ? t.slice(0, m.index) + "○○○○○○號" : t;
}

/** 遮一個公司名，並記住怎麼還原。 */
export function maskQuery(name: string): string {
  if (!DEMO) return name;
  const m = maskCompany(name);
  if (m !== name) REAL.set(m, name);
  return m;
}

/** 畫面上點到的是遮罩後的名字；送去查詢之前換回原名。 */
export function unmask(name: string): string {
  return REAL.get(name.trim()) ?? name;
}

/** 站內連結。demo 模式要帶著 demo=1，而且要用原名，否則重新整理就查不到。 */
export function demoHref(name: string): string {
  const q = `/?q=${encodeURIComponent(unmask(name))}`;
  return DEMO ? q + "&demo=1" : q;
}

/* ── 整包遮罩 ───────────────────────────────────────────────
   做法：先把結果裡所有「人名、公司名、地址」收集起來，建一張
   原文 → 遮罩 的替換表，再把整個物件裡的每一個字串跑一次替換。
   這樣佐證句子（「登記地址同為「…」」）、負責人寫法說明、
   得獎與安衛名冊裡夾帶的公司名，都會一起被遮到，不用逐欄位去追。 */

type Any = unknown;

function collect(o: Any, people: Set<string>, orgs: Set<string>, addrs: Set<string>) {
  if (!o || typeof o !== "object") return;
  if (Array.isArray(o)) { o.forEach((x) => collect(x, people, orgs, addrs)); return; }
  const r = o as Record<string, Any>;
  // ⚠ 危害型態也有 name（「機械設備防護」），它不是公司名。不排除的話會被遮成「○○設備防護」。
  const isHazard = "duty" in r || "code" in r;
  for (const [k, v] of Object.entries(r)) {
    if (isHazard && k === "name") continue;
    if (typeof v === "string" && v) {
      if (k === "name" && "linked_companies" in r) people.add(v);          // Principal
      else if (k === "name" || k === "query" || k === "counterpart") orgs.add(v);
      else if (k === "address" || k === "site") addrs.add(v);
      else if (k === "detail" && r.kind === "same_address") {
        // ⚠ 沒有路名的地址（「○○鄉○○村○○號」）漏過下面的 ADDR 安全網，實測 4 家。
        //   佐證句子裡引號內的就是地址，直接收進替換表，交給 maskAddr。
        for (const m of v.matchAll(/「([^」]{6,})」/g)) addrs.add(m[1]);
      } else if (k === "detail" && r.kind === "same_name") {
        // 零裁處新公司那一塊沒有 Principal 物件，姓名只出現在佐證句子裡：
        // 「代表人是「盧_帆」…負責人「盧紀帆」相符」。短的引號內容一律當人名。
        for (const m of v.matchAll(/「([^」]{2,4})」/g)) people.add(m[1]);
      } else if (k === "role") {
        // 「本系統在這家公司的公開紀錄上另外看到「X」的寫法；…以「Y」比對出來的」
        for (const m of v.matchAll(/「([^」]{2,6})」/g)) people.add(m[1]);
      }
    } else if (v && typeof v === "object") {
      collect(v, people, orgs, addrs);
    }
  }
}

/* 安全網：字串裡任何「縣市＋區鄉鎮＋路街」後面接門牌的，一律把門牌遮掉。
   ⚠ 實測漏過一次：公司地址存的是「臺南市…」，佐證句子寫的是「台南市…」，
     逐字替換對不上，完整門牌就印在畫面上。只靠替換表不夠。 */
const ADDR = /((?:[臺台][北中南東]|[\u4e00-\u9fff]{2})[縣市][\u4e00-\u9fff]{1,4}?[區鄉鎮市](?:[\u4e00-\u9fff]{1,4}?[里村])?[\u4e00-\u9fff0-9０-９]{0,8}?[路街道])([0-9０-９一二三四五六七八九十百段巷弄衖號樓之\-－、]+)/g;

function rewrite(o: Any, rules: [string, string][]): Any {
  if (typeof o === "string") {
    let s = o;
    for (const [a, b] of rules) if (s.includes(a)) s = s.split(a).join(b);
    return s.replace(ADDR, "$1○○○");
  }
  if (Array.isArray(o)) return o.map((x) => rewrite(x, rules));
  if (o && typeof o === "object") {
    const out: Record<string, Any> = {};
    for (const [k, v] of Object.entries(o as Record<string, Any>)) {
      if (k === "tax_id") out[k] = "";
      else if (k === "doc_no" && typeof v === "string") out[k] = maskDoc(v);
      else if (k === "project" && typeof v === "string") out[k] = v ? "（工程名稱已遮蔽）" : v;
      else out[k] = rewrite(v, rules);
    }
    return out;
  }
  return o;
}

/** 把 lookup() 的回傳整包遮罩。非 demo 模式原封不動。 */
export function maskOutcome<T>(out: T): T {
  if (!DEMO) return out;
  const people = new Set<string>(), orgs = new Set<string>(), addrs = new Set<string>();
  collect(out, people, orgs, addrs);
  const rules: [string, string][] = [];
  // ⚠ 臺／台兩種寫法都要換。來源資料兩種都有。
  for (const a of addrs) for (const v of new Set([a, a.replace(/臺/g, "台"), a.replace(/台/g, "臺")]))
    rules.push([v, maskAddr(v)]);
  for (const o of orgs) { rules.push([o, maskQuery(o)]); }
  for (const p of people) rules.push([p, maskPerson(p)]);
  // ⚠ 長的先換。不然「○○工程行」裡的人名片段會先被換掉，公司名就對不上了。
  rules.sort((x, y) => y[0].length - x[0].length);
  return rewrite(out, rules.filter(([a, b]) => a && a !== b)) as T;
}
