/**
 * 查詢頁 —— 產品的主畫面。主線負責，不是隊友的檔案。
 *
 * ══════════════════════════════════════════════════════════════
 * 這一頁的設計受紅線約束，不是純粹的 UI 決定
 * ══════════════════════════════════════════════════════════════
 *
 * 系統處理真實公司與真實人名，誤判是實質的名譽損害。所以：
 *
 *  1. **證據強度不能只有一個數字。** 一個「0.75」會被當成「75% 是同一人」。
 *     這一版**乾脆不顯示分數**，只顯示「幾項獨立佐證」＋完整的佐證句子。
 *     分數還留在資料裡（拿來排序），但不進畫面。
 *
 *  2. **不下結論。** 畫面上不會出現「這家公司有風險」。
 *     只呈現「這個負責人的姓名，也出現在這些公司的公開裁處紀錄上」。
 *
 *  3. **每一筆裁處都要能查回官方公告。** 勞動部沒有單筆永久連結，
 *     所以每一筆都顯示處分字號（獨立欄位）＋查詢系統連結。
 *
 *  4. **姓名相同不等於同一人**這句話要放在顯眼的地方，不是註腳。
 *
 *  5. **危害型態是規則歸類的，不是模型判的**，而且「未指明」不等於「沒有危害」。
 *     死亡災害的措辭是「本筆公告涉及死亡災害」——
 *     不能寫成「造成死亡」，因為有些是罰未依規定通報。
 *
 * ══════════════════════════════════════════════════════════════
 * 版面（依 Claude Design 的設計稿實作）
 * ══════════════════════════════════════════════════════════════
 * 行動優先。375px 是主要的版本；桌機只是把同一份標記攤成兩欄。
 * 顏色只有三個有意義：--fatal（嚴重度）、--pending（不確定性）、--link。
 * ⚠ 不要為了好看加第四個顏色，也**不要把 fatal 跟 pending 併成同一個色相**
 *   ——「死了人」跟「還不確定」是兩件事。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Candidate, LinkedCompany, LookupResult, ViolationRef,
} from "../types/contracts";
import sample from "../data/lookup.sample.json";
import { getMeta, hashMismatch, lookup } from "../lib/lookup";
import type { LookupOutcome, Meta } from "../lib/lookup";
import "../styles/home.css";

const DATA = sample as unknown as {
  generated_at: string; note: string; results: LookupResult[];
};

/** 超過這個筆數就切換成「長清單」模式（分面＋摺疊）。見設計稿 A7。 */
const LONG_LIST = 12;
/** 長清單一次顯示幾筆 */
const PAGE = 12;
/** 關聯公司預設展開幾筆裁處 */
const LINKED_PREVIEW = 3;

/* ══════════════════════════════════════════════════════════════
   小工具
   ══════════════════════════════════════════════════════════════ */

/** ⚠ 「0」不是免罰，是公告沒有刊載金額。
 *  台北市的職安法公告有 16,536 筆屬於這種情形。 */
function money(n: number): string {
  return n > 0 ? `${n.toLocaleString("zh-TW")} 元` : "公告未載金額";
}

/** 這一筆是不是還在爭議中（訴願／行政救濟尚未確定）。 */
function isPending(v: ViolationRef): boolean {
  return !!v.appeal && v.appeal.includes("尚未確定");
}

/** 「113/05/21」→「113」。格式不符就回空字串，不要硬猜。 */
function rocYear(date: string): string {
  const m = /^(\d{3})\//.exec(date);
  return m ? m[1] : "";
}

/** 一串裁處紀錄涵蓋的民國年範圍，例如「民國 113–115 年」。 */
function yearSpan(vs: ViolationRef[]): string {
  const ys = vs.map((v) => rocYear(v.date)).filter(Boolean).sort();
  if (!ys.length) return "";
  const a = ys[0], b = ys[ys.length - 1];
  return a === b ? `民國 ${a} 年` : `民國 ${a}–${b} 年`;
}

/**
 * 設立年份。
 *
 * ⚠ 商工登記的設立年份是**西元**（"1989"），可是這一頁其他所有日期都是
 *   民國（"113/05/21"）。不標示的話「設立 1989」會被讀成民國 1989 年。
 *   不換算、只標示 —— 換算是多一次可能出錯的轉手，標示零成本。
 */
function estLabel(e: string | null): string {
  if (!e) return "";
  return /^\d{4}$/.test(e) ? `設立 西元 ${e} 年` : `設立 ${e}`;
}

/**
 * 法條與違反內容常常是好幾項用「;」串起來的。攤成一行一項比較讀得下去。
 *
 * ⚠⚠ **不要把法條跟內容配對**（第 1 條法條配第 1 段內容…）。
 *   實測 2,657 筆裡有 135 筆是多項的，其中 **44 筆兩邊的項數對不起來**
 *   ——分隔符號在來源資料裡就不一致（有的用「;」、有的用「、」、有的用換行，
 *   還有的「；」出現在同一項的句子中間）。配對錯就是把 A 法條掛到 B 事實上，
 *   而這會直接顯示在一家真實公司的紀錄裡。
 *   各自斷行不主張任何對應關係，所以是安全的。
 */
function lines(s: string): string[] {
  return s.split(/[;；\n]/).map((x) => x.trim()).filter(Boolean);
}

const CJK_NUM = ["零", "一", "兩", "三", "四", "五", "六", "七", "八", "九"];

/**
 * 證據強度的文字。
 *
 * ⚠ **不顯示分數**，只顯示「幾項獨立佐證」。理由見檔頭第 1 條。
 *
 * ⚠ `same_name`（姓名相同）與 `rare_name`（姓名罕見）**都不算獨立佐證**。
 *   兩者講的是同一件事：這個姓名。罕見只是讓「同名巧合」的機率變低，
 *   它沒有提供第二個獨立的線索。把它算成一項，等於把同一個訊號數兩次
 *   ——這正是專案裡「身分訊號與樣態訊號不可相加」那條規則要擋的事。
 *   罕見本身還是會出現在下面的佐證清單裡，使用者看得到。
 */
function strengthLabel(c: LinkedCompany): string {
  const rare = c.evidence.some((e) => e.kind === "rare_name");
  const n = c.evidence.filter(
    (e) => e.kind !== "same_name" && e.kind !== "rare_name").length;
  if (n === 0) return rare ? "只有姓名相同（該姓名罕見）" : "只有姓名相同";
  return `${CJK_NUM[n] ?? n}項獨立佐證`;
}

/* ══════════════════════════════════════════════════════════════
   共用小元件
   ══════════════════════════════════════════════════════════════ */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="lbl">{label}</dt>
      <dd style={{ margin: 0 }}>{children}</dd>
    </>
  );
}

function Tags({ v }: { v: ViolationRef }) {
  const pending = isPending(v);
  if (!v.fatal && !pending) return null;
  return (
    <>
      {/* ⚠ 措辭固定：「涉及」不是「造成」。
          有些公告罰的是「未於八小時內通報死亡災害」，
          寫成「造成死亡」就是把通報違規講成殺人。 */}
      {v.fatal && <span className="tag tag-fatal">涉及死亡災害</span>}
      {/* 爭議中的案子要在最顯眼的位置標出來 —— 這是紅線不是體貼。
          原處分還沒確定，把它跟已確定的案子混在一起呈現，
          對被列的公司不公平，對使用者也是誤導。 */}
      {pending && <span className="tag tag-pending">尚未確定</span>}
    </>
  );
}

/** 一筆裁處。compact 用在長清單與關聯公司底下。 */
function Violation({ v, compact }: { v: ViolationRef; compact?: boolean }) {
  const pending = isPending(v);
  return (
    <li className="vio">
      <div className="vio-date">
        <span className="num">{v.date}</span>
      </div>
      <div className="vio-body">
        <div className="vio-tags"><Tags v={v} /></div>
        <p className="vio-law">
          {lines(v.law).map((t, i) => <span key={i}>{t}</span>)}
        </p>
        <p className="vio-content" style={compact ? { fontSize: 14 } : undefined}>
          {lines(v.content).map((t, i) => <span key={i}>{t}</span>)}
        </p>
        {v.hazards && v.hazards.length > 0 && (
          <p className="vio-haz">
            危害型態{"　"}{v.hazards.map((h) => h.name).join("、")}
          </p>
        )}
        {/* 處分字號是唯一能查回原始公告的線索，不能省。 */}
        <div className="vio-meta">
          <span className="num">罰鍰 {money(v.fine)}</span>
          <span style={{ overflowWrap: "anywhere" }}>處分字號 {v.doc_no || "公告未載"}</span>
          <a href={v.source_url} target="_blank" rel="noreferrer">查閱原始公告</a>
        </div>
        {pending && (
          <p className="vio-appeal">
            {v.appeal}{"　"}本案的行政救濟程序尚未終結，原處分是否維持仍待確定。
          </p>
        )}
      </div>
    </li>
  );
}

/* ══════════════════════════════════════════════════════════════
   長清單（設計稿 A7）
   ══════════════════════════════════════════════════════════════
   國城營造 396 筆。整串倒出來沒有人看得完，而且會把「有 3 筆涉及
   死亡災害」這種真正重要的事淹掉。所以：先給分面，再給清單。

   ⚠ 分面數字算的是**這一串**裡的筆數，不是全站的。
   ⚠ 「依年度」的筆數多寡受檢查頻率影響，不是「這一年比較危險」。
      這句話一定要寫在旁邊。
   ══════════════════════════════════════════════════════════════ */

type Facet = { key: string; label: string; test: (v: ViolationRef) => boolean };

function ViolationList({ vs, title, note }: {
  vs: ViolationRef[]; title: string; note?: string;
}) {
  // ⚠ 註腳只在真的有「公告未載金額」的時候才出現。
  //   每一串都掛一句「0 元不是免罰」，看到第三次就沒有人在看了。
  const hasZeroFine = vs.some((v) => v.fine <= 0);
  const long = vs.length > LONG_LIST;
  const [facet, setFacet] = useState("all");
  const [shown, setShown] = useState(PAGE);

  const facets = useMemo<Facet[]>(() => {
    const out: Facet[] = [{ key: "all", label: `全部 ${vs.length}`, test: () => true }];
    const fatal = vs.filter((v) => v.fatal).length;
    if (fatal) out.push({ key: "fatal", label: `涉及死亡災害 ${fatal}`, test: (v) => !!v.fatal });
    const pend = vs.filter(isPending).length;
    if (pend) out.push({ key: "pending", label: `尚未確定 ${pend}`, test: isPending });
    // 出現最多的三種危害型態
    const cnt = new Map<string, number>();
    for (const v of vs) for (const h of v.hazards ?? []) cnt.set(h.name, (cnt.get(h.name) ?? 0) + 1);
    for (const [name, n] of [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      out.push({
        key: `h:${name}`, label: `${name} ${n}`,
        test: (v) => (v.hazards ?? []).some((h) => h.name === name),
      });
    }
    return out;
  }, [vs]);

  const years = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of vs) {
      const y = rocYear(v.date);
      if (y) m.set(y, (m.get(y) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [vs]);

  const active = facets.find((f) => f.key === facet) ?? facets[0];
  const filtered = useMemo(() => vs.filter(active.test), [vs, active]);
  const visible = long ? filtered.slice(0, shown) : filtered;

  return (
    <section className="block">
      <h2 className="block-h">{title}</h2>
      <p className="block-sub">
        {vs.length} 筆{yearSpan(vs) ? ` · ${yearSpan(vs)}` : ""}
      </p>

      {long && (
        <>
          <div className="years">
            <div className="kicker" style={{ marginBottom: 9 }}>依年度</div>
            <ul className="years-list">
              {years.map(([y, n]) => (
                <li key={y}>
                  <span>民國 {y} 年</span>
                  <span className="num" style={{ color: "var(--ink-2)" }}>{n}</span>
                </li>
              ))}
            </ul>
            <p className="fineprint">
              筆數多寡受檢查與稽核頻率影響，不是「那一年比較危險」。
              同一次檢查可能開出好幾張處分書（營造業的工地尤其常見）。
            </p>
          </div>

          {/* 只有「全部」一個分面時不要畫 —— 一顆按不動的按鈕只是雜訊。 */}
          {facets.length > 1 && (
            <div className="chips">
              {facets.map((f) => (
                <button
                  key={f.key}
                  className="sw-chip"
                  aria-pressed={f.key === active.key}
                  onClick={() => { setFacet(f.key); setShown(PAGE); }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <ul className="vio-list">
        {visible.map((v, i) => (
          <Violation key={`${v.doc_no}-${v.date}-${i}`} v={v} compact={long} />
        ))}
      </ul>

      {long && shown < filtered.length && (
        <div className="more">
          <button
            className="sw-btn"
            style={{ background: "var(--sheet)", color: "var(--ink)" }}
            onClick={() => setShown(shown + PAGE * 4)}
          >
            再顯示 {Math.min(PAGE * 4, filtered.length - shown)} 筆
          </button>
          <p className="kicker" style={{ margin: "9px 0 0" }}>
            已顯示 {visible.length} / {filtered.length} 筆
            {active.key !== "all" ? `（${active.label}）` : ""}
          </p>
        </div>
      )}

      {note && hasZeroFine && <p className="fineprint rule-top">{note}</p>}
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════
   危害型態面板 —— 「視覺化防災」與「素養提升」就是這一塊
   ══════════════════════════════════════════════════════════════
   「這家公司違反職業安全衛生法」對求職者沒有用；
   「這個負責人名下的公司被罰過 4 次墜落防護不足，而法規要求雇主在
    二公尺以上作業設置護欄或母索」才是可以拿去現場對照的資訊。

   ⚠ 三件事不能省：
     1. 各類加總會大於公告筆數（一筆可能同時屬於多類），不要拿它當分母。
     2. 沒有標籤的職安法公告是「公告文字未指明」，不是「沒有危害」。
     3. 法規義務那段文字是給人看的教育內容，不是對這家公司的認定。
   ══════════════════════════════════════════════════════════════ */
function HazardPanel({ hit }: { hit: LookupResult }) {
  const list = hit.summary.hazards ?? [];
  const [open, setOpen] = useState<string | null>(list[0]?.code ?? null);

  const duty = useMemo(() => {
    const m: Record<string, string> = {};
    const all = [
      ...hit.company.own_violations,
      ...hit.principals.flatMap((p) => p.linked_companies.flatMap((c) => c.violations)),
    ];
    for (const v of all) for (const h of v.hazards ?? []) m[h.code] = h.duty;
    return m;
  }, [hit]);

  const fatal = hit.summary.fatal_count ?? 0;
  if (list.length === 0 && fatal === 0) return null;
  const openName = list.find((h) => h.code === open)?.name ?? "";

  return (
    <section className="side-block">
      <h2 className="side-h">被罰過的職安危害型態</h2>
      <p className="side-p">
        依公告文字的關鍵字歸類（規則比對，非模型判定）。
        一筆公告可能同時屬於多類，各類次數相加會大於公告筆數。
        點一下看法規要求雇主做什麼。
      </p>
      <div className="chips">
        {list.map((h) => (
          <button
            key={h.code}
            className="sw-chip"
            aria-pressed={open === h.code}
            onClick={() => setOpen(open === h.code ? null : h.code)}
          >
            {h.name}{"　"}{h.count}
          </button>
        ))}
      </div>

      {open && duty[open] && (
        <div className="duty">
          <p className="kicker" style={{ margin: "0 0 5px" }}>
            法規要求雇主做什麼 · {openName}
          </p>
          <p className="duty-text">{duty[open]}</p>
          <p className="fineprint" style={{ margin: "8px 0 0" }}>
            這是法規的一般性要求，不是對上述任何一家公司的認定。
          </p>
        </div>
      )}

      {fatal > 0 && (
        <p className="warnbox">
          其中 {fatal} 筆公告<b>涉及</b>死亡災害。「涉及」指公告文字提到死亡災害，
          包含未依規定通報的情形，不等於該公司造成死亡。
          詳情請以處分字號查閱原始公告。
        </p>
      )}
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════
   查詢結果
   ══════════════════════════════════════════════════════════════ */
function Result({ hit }: { hit: LookupResult }) {
  const linkedAll = hit.principals.flatMap((p) => p.linked_companies);
  const pendingCount = [
    ...hit.company.own_violations,
    ...linkedAll.flatMap((c) => c.violations),
  ].filter(isPending).length;

  const stats: [number, string, boolean][] = [
    [hit.summary.own_violation_count, "本身的裁處紀錄", false],
    [hit.summary.linked_violation_count, "同名負責人其他公司的裁處紀錄", false],
    [hit.summary.fatal_count ?? 0, "公告涉及死亡災害", true],
    [pendingCount, "行政救濟尚未終結", false],
  ];

  return (
    <div className="res">
      <header className="res-head">
        <div className="kicker" style={{ marginBottom: 10 }}>查詢結果</div>
        <h1 className="res-title">{hit.company.name}</h1>
        <dl className="fields">
          {hit.company.tax_id && (
            <Field label="統一編號"><span className="num">{hit.company.tax_id}</span></Field>
          )}
          <Field label="登記現況">
            <span style={{ color: "var(--ink-2)" }}>
              {hit.company.status || "登記狀態不明"}
              {hit.company.established ? ` · ${estLabel(hit.company.established)}` : ""}
            </span>
          </Field>
          {hit.company.address && (
            <Field label="登記地址">
              <span style={{ color: "var(--ink-2)" }}>{hit.company.address}</span>
            </Field>
          )}
        </dl>
      </header>

      <div className="res-side-top">
        {/* 這句話是紅線，不能拿掉也不能縮成註腳。 */}
        <div className="band">
          <p>姓名相同不等於同一人。</p>
          <p>
            公開資料沒有身分證字號。本系統不判定身分，
            只呈現這個連結有多少獨立佐證；判斷請自行進一步查證。
          </p>
        </div>
        <dl className="stats">
          {stats.map(([n, label, isFatal]) => (
            <div key={label} className="stat">
              <dt className="num" style={isFatal && n > 0 ? { color: "var(--fatal)" } : undefined}>
                {n}
              </dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="res-main">
        {hit.company.own_violations.length > 0 ? (
          <ViolationList
            vs={hit.company.own_violations}
            title="這家公司自己的紀錄"
            note={
              "「公告未載金額」不等於免罰。部分縣市的公告不刊載罰鍰金額，" +
              "台北市的職安法公告有 16,536 筆屬於這種情形；金額請以原始裁處書為準。"
            }
          />
        ) : (
          <section className="block">
            <h2 className="block-h">這家公司自己沒有公開的裁處紀錄</h2>
            <p className="block-sub">
              在本站涵蓋的公告範圍內，這家公司本身沒有被裁處的紀錄。
            </p>
          </section>
        )}

        {hit.principals.map((p) => (
          <section key={p.name} className="block">
            <h2 className="block-h">
              負責人 {p.name} 的姓名，也出現在這些公司的公開紀錄上
            </h2>
            <p className="block-sub">
              {p.linked_companies.length} 家公司 ·{" "}
              {p.linked_companies.reduce((n, c) => n + c.violations.length, 0)} 筆裁處
            </p>
            {p.linked_companies
              .slice()
              .sort((a, b) => b.confidence - a.confidence)
              .map((c, i) => <Linked key={`${c.tax_id}-${i}`} c={c} />)}
          </section>
        ))}

        {hit.principals.length === 0 && (
          <div className="band">
            <p>負責人的姓名沒有出現在其他公司的公開紀錄上。</p>
            <p>
              這代表<b>在本站涵蓋的公告範圍內</b>沒有找到同名的其他事業單位，
              不代表這個人名下沒有別的公司 ——
              沒有被裁處的公司不會出現在勞動部的公告裡。
            </p>
          </div>
        )}
      </div>

      <div className="res-haz">
        <HazardPanel hit={hit} />
      </div>

      <footer className="res-foot">
        <p className="fineprint">
          資料來源：勞動部違反勞動法令事業單位（雇主）查詢系統、經濟部商工登記公示資料。
          本頁僅呈現主管機關已公告之裁處紀錄與其關聯，
          不對任何事業單位或個人作出評價或認定。
        </p>
      </footer>
    </div>
  );
}

function Linked({ c }: { c: LinkedCompany }) {
  const [all, setAll] = useState(false);
  const vs = all ? c.violations : c.violations.slice(0, LINKED_PREVIEW);
  return (
    <div className="linked">
      <div className="linked-main">
        <h3 className="linked-h">{c.name}</h3>
        <div className="linked-meta">
          {c.tax_id && <span className="num">統編 {c.tax_id}</span>}
          <span>{c.status || "登記狀態不明"}</span>
          <span className="num">裁處 {c.violations.length} 筆</span>
        </div>
        <ul className="vio-list">
          {vs.map((v, i) => <Violation key={`${v.doc_no}-${i}`} v={v} compact />)}
        </ul>
        {c.violations.length > LINKED_PREVIEW && (
          <p style={{ margin: "12px 0 0" }}>
            <button className="linkish" onClick={() => setAll(!all)}>
              {all
                ? "收合這家公司的裁處紀錄"
                : `展開這家公司其餘 ${c.violations.length - LINKED_PREVIEW} 筆`}
            </button>
          </p>
        )}
      </div>
      {/* 證據強度：文字 ＋ 完整的佐證句子。⚠ 沒有分數，理由見檔頭。 */}
      <div className="linked-ev">
        <p className="kicker" style={{ margin: "0 0 5px" }}>證據強度</p>
        <p className="linked-ev-h">{strengthLabel(c)}</p>
        <ul className="linked-ev-list">
          {c.evidence.map((e, i) => (
            <li key={i} style={e.kind === "same_name" ? { color: "var(--ink-3)" } : undefined}>
              {e.detail}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   頁面
   ══════════════════════════════════════════════════════════════ */
export default function Home() {
  const [q, setQ] = useState("");
  // undefined = 還在確認有沒有完整資料；null = 只有展示樣本
  const [meta, setMeta] = useState<Meta | null | undefined>(undefined);
  const [outcome, setOutcome] = useState<LookupOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState("");

  useEffect(() => { void getMeta().then(setMeta); }, []);

  /**
   * ⚠ 查詢是**按下 Enter 才送**，不是邊打邊查。
   *   分片是完整名稱的精確比對，打到一半的字串永遠查不到，
   *   邊打邊查只會讓畫面在「查無」和結果之間閃爍，
   *   而且每按一個鍵就抓一次分片。
   */
  const run = useCallback(async (name: string) => {
    const t = name.trim();
    if (!t) { setOutcome(null); setAsked(""); return; }
    setBusy(true);
    setAsked(t);
    try {
      if (meta) {
        setOutcome(await lookup(t));
      } else {
        const r = DATA.results.find(
          (x) => x.query.includes(t) || x.company.name.includes(t)) ?? null;
        setOutcome(r ? { kind: "hit", result: r } : { kind: "miss" });
      }
    } finally {
      setBusy(false);
    }
  }, [meta]);

  const hit = outcome?.kind === "hit" ? outcome.result : null;
  const fresh = !outcome && !busy;

  return (
    <div className="page">
      {/* 索引不一致是硬錯誤，不能安靜地回「查無」。設計稿 A8。 */}
      {hashMismatch && (
        <div className="alert">
          <p className="alert-h">資料索引不一致，查詢結果可能不完整。</p>
          <p className="alert-p">{hashMismatch}</p>
          <p className="alert-p">
            你仍然可以查詢，但在索引修好之前，請把「查無紀錄」當成
            「這次沒查到」，不要當成「沒有紀錄」。
          </p>
        </div>
      )}

      {fresh && (
        <div className="hero">
          <div className="band" style={{ marginTop: 0 }}>
            <p style={{ fontSize: 26, lineHeight: 1.2, fontWeight: 700, letterSpacing: "-.02em" }}>
              求職安全雷達
            </p>
            <p>
              勞動部的違法紀錄跟著公司走。公司收掉重開，紀錄就留在舊公司。
              這裡把查詢的軸線換成人。
            </p>
          </div>
        </div>
      )}

      <form
        className="search"
        onSubmit={(e) => { e.preventDefault(); void run(q); }}
      >
        <label className="kicker" htmlFor="q">公司完整名稱</label>
        <input
          id="q"
          className="sw-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="例：國城營造有限公司"
          autoComplete="off"
        />
        <button className="sw-btn" type="submit" disabled={busy || !q.trim()}>
          {busy ? "查詢中" : "查詢"}
        </button>
        {fresh && (
          <p className="search-note">
            比對的是<b>完整的法定名稱</b>。少一個字、用簡稱或商標名都查不到。
          </p>
        )}
      </form>

      {/* 載入中：說清楚在下載什麼、多大、送不送出去。設計稿 A2。 */}
      {busy && (
        <div className="loading">
          <p className="loading-h">正在下載這家公司的資料分片</p>
          <p className="kicker">約 14 KB · 不會送出你查了誰</p>
          <div className="skels">
            <div className="skel" style={{ height: 22, width: "86%" }} />
            <div className="skel" style={{ height: 11, width: "54%" }} />
            <div className="skel" style={{ height: 11, width: "94%" }} />
            <div className="skel" style={{ height: 11, width: "88%" }} />
          </div>
        </div>
      )}

      {!busy && hit && <Result hit={hit} />}

      {/* 核心名對到多家：⚠ 絕對不能自己挑一家。
          挑錯就是把 A 公司的裁處紀錄顯示成 B 公司的，那是名譽損害。
          ⚠ 只列名稱不夠 —— 實測有兩家**名稱完全相同**的公司。
            統一編號與登記地址是使用者唯一分得出來的依據。 */}
      {!busy && outcome?.kind === "choose" && (
        <Choose outcome={outcome} asked={asked} onPick={(n) => { setQ(n); void run(n); }} />
      )}

      {!busy && outcome?.kind === "miss" && <Miss asked={asked} meta={meta} />}

      {!busy && outcome?.kind === "nodata" && (
        <div className="band">
          <p>完整資料尚未載入，目前只能查展示樣本。</p>
          <p>
            這是去識別化的展示資料（{DATA.results.length} 筆）。
            試著輸入「○」看看結果長什麼樣。
          </p>
        </div>
      )}

      {fresh && <Coverage meta={meta} />}
    </div>
  );
}

function Choose({ outcome, asked, onPick }: {
  outcome: Extract<LookupOutcome, { kind: "choose" }>;
  asked: string;
  onPick: (name: string) => void;
}) {
  const cands = outcome.candidates as Candidate[];
  const sameName = new Set<string>();
  const seen = new Set<string>();
  for (const c of cands) {
    if (seen.has(c.name)) sameName.add(c.name);
    seen.add(c.name);
  }
  return (
    <div className="choose">
      <div className="band">
        <p>{outcome.note ?? `「${asked}」對到 ${cands.length} 家公司。請你選一家。`}</p>
        {/* ⚠ 只對到一家也要走這裡，不可以直接跳進去。切字尾是猜測，
            猜測不能替使用者決定他在看哪一家公司的裁處紀錄。
            但話要講對 ——「我們沒辦法判斷你要查哪一家」在只有一家時是廢話。 */}
        {cands.length === 1 ? (
          <p>
            只對到這一家，不過這是把你打的字切掉字尾之後找出來的，
            不是你原本輸入的名稱。<b>請自己確認是不是這一家</b>再往下看。
          </p>
        ) : (
          <p>
            {sameName.size > 0 && <>其中有<b>名稱完全相同</b>、統一編號與登記地址不同的公司。</>}
            勞動部的公告只寫名稱，我們沒有辦法替你判斷你要查的是哪一家 ——
            選錯就會把一家公司的紀錄看成另一家的。
          </p>
        )}
      </div>
      <ul className="cand-list">
        {cands.map((c, i) => (
          <li key={`${c.tax_id}-${i}`}>
            <button onClick={() => onPick(c.name)}>
              <div className="cand-name">{c.name}</div>
              <dl className="fields">
                {c.tax_id && <Field label="統一編號"><span className="num">{c.tax_id}</span></Field>}
                {c.address && (
                  <Field label="登記地址">
                    <span style={{ color: "var(--ink-2)" }}>{c.address}</span>
                  </Field>
                )}
                {c.status && (
                  <Field label="登記現況">
                    <span style={{ color: "var(--ink-2)" }}>{c.status}</span>
                  </Field>
                )}
                {c.established && (
                  <Field label="設立">
                    <span style={{ color: "var(--ink-2)" }}>
                      {estLabel(c.established).replace(/^設立 /, "")}
                    </span>
                  </Field>
                )}
                <Field label="裁處紀錄">
                  <span className="num">{c.violation_count} 筆</span>
                </Field>
              </dl>
              <div className="cand-go">查這一家 →</div>
            </button>
          </li>
        ))}
      </ul>
      <p className="fineprint rule-top">
        分公司與本公司是不同的事業單位，裁處紀錄分開公告。兩邊都值得看。
      </p>
    </div>
  );
}

/**
 * 查無。⚠ 「查無紀錄」不等於「這家公司沒問題」——
 *   這一段是使用者最容易誤讀的地方，所以話要說滿。
 */
function Miss({ asked, meta }: { asked: string; meta: Meta | null | undefined }) {
  return (
    <div className="miss">
      <h1 className="res-title" style={{ fontSize: 22 }}>
        查無「{asked}」的公開裁處紀錄。
      </h1>
      <div className="band">
        <p>查無紀錄不代表這家公司沒有問題。</p>
        <p>
          這一頁只能告訴你「主管機關公告過什麼」。沒有公告，可能是沒有違規，
          也可能是沒被檢查、還沒公告，或是該縣市的公告已經下架。
        </p>
      </div>
      <div className="block">
        <div className="kicker" style={{ marginBottom: 10 }}>先確認這三件事</div>
        <ol className="checks">
          <li>
            名稱是<b>完整的法定名稱</b>嗎？招牌名、品牌名、簡稱都查不到。
            營業登記上可能是「○○食品行」而不是你看到的店名。
          </li>
          <li>是<b>分公司</b>嗎？分公司與本公司分開公告，兩個名稱都要試。</li>
          <li>
            是<b>人力派遣</b>嗎？你的面試公司與實際的僱用單位可能不是同一家；
            勞動契約上的名稱才是要查的那一個。
          </li>
        </ol>
      </div>
      <p className="fineprint rule-top">
        {meta
          ? `本站涵蓋 ${meta.companies.toLocaleString("zh-TW")} 家事業單位、` +
            `${meta.violations.toLocaleString("zh-TW")} 筆公告，9 部法規、民國 100–115 年。`
          : "本站涵蓋 9 部法規、民國 100–115 年的公開裁處紀錄。"}
        {" "}各縣市公告保存期間不一：
        <b>基隆市與新竹市的職業安全衛生法公告在本站一筆都沒有</b>。
      </p>
    </div>
  );
}

/** 資料涵蓋範圍。使用者有權知道「查無」代表什麼。 */
function Coverage({ meta }: { meta: Meta | null | undefined }) {
  return (
    <section className="coverage">
      <div className="kicker" style={{ marginBottom: 10 }}>資料涵蓋範圍</div>
      {meta === undefined ? (
        <p className="kicker">載入資料中…</p>
      ) : (
        <dl className="cov-list">
          <dt className="num">{(meta?.companies ?? 175828).toLocaleString("zh-TW")}</dt>
          <dd>家事業單位</dd>
          <dt className="num">{(meta?.violations ?? 629192).toLocaleString("zh-TW")}</dt>
          <dd>筆公開裁處紀錄</dd>
          <dt className="num">9</dt>
          <dd>部法規 · 民國 100–115 年（近九成落在 110 年之後）</dd>
        </dl>
      )}
      <p className="fineprint" style={{ marginTop: 16 }}>
        各縣市的公告保存期間差異很大，有些縣市不到兩年。查得到什麼，
        取決於主管機關公告了什麼。<b>基隆市與新竹市的職業安全衛生法公告
        在本站一筆都沒有。</b>
      </p>
      <p className="fineprint" style={{ marginTop: 10 }}>
        本站是純靜態網站，沒有後端。一次查詢只下載該公司的資料分片
        （約 14 KB），你查了誰不會送到任何伺服器。
      </p>
      <p className="fineprint" style={{ marginTop: 10 }}>
        資料來源：勞動部違反勞動法令事業單位（雇主）查詢系統、
        經濟部商工登記公示資料。
      </p>
    </section>
  );
}
