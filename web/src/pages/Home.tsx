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
 *  5. **危害型態是規則歸類的，不是模型判的**，而且「沒有標籤」不等於「沒有危害」。
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
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Candidate, Credential, Incident, LinkedCompany, ListedHit, LookupResult, QuotaHit,
  SafetyStaff, SafetyUnits, ViolationRef,
} from "../types/contracts";
import sample from "../data/lookup.sample.json";
import { findBranches, getExtra, getMeta, getPlainLaw, hashMismatch, lookup } from "../lib/lookup";
import { DEMO, demoHref, maskOutcome, maskQuery, unmask } from "../lib/demo";
import { ASK } from "../lib/ask";
import type { Branches, Extra, LookupOutcome, Meta, PlainDict, RegistryHit } from "../lib/lookup";
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

/**
 * 兩層警語：第一句常駐，其餘收摺。
 *
 * ══════════════════════════════════════════════════════════════
 * ⚠⚠ 降階，不是刪除
 * ══════════════════════════════════════════════════════════════
 * 實測台電頁：警語 8 段、632 字，佔全頁 21.4%，而且全部常駐。
 * **警語太長等於沒有警語** —— 使用者看到第三塊灰色小字就開始跳過，
 * 結果最該被讀到的那一句跟最不重要的那一句一起被跳過。
 *
 * ⚠ 留在外面的那一句必須是**不看就會誤讀**的那一句。
 *   收起來的只能是「為什麼」「出處」「細節」。
 *   判準：把收起來的部分整段刪掉，剩下的話會不會變成假的？
 *   會 → 那部分不能收。
 *
 * ⚠ 摺疊的標題要寫**具體問的問題**（「為什麼不能跨年比較？」），
 *   不要寫「更多資訊」—— 後者沒有人會點。
 *
 * ⚠ 這裡刻意用 button + aria-expanded 而不是 <details>，
 *   跟這個專案其他收摺一致（Credentials、LawGroup、PlainBars 都是）。
 *   混用兩種模式會讓鍵盤操作的行為不一樣。
 */
function Caveat({ lead, label, className, children }: {
  lead: ReactNode; label: string; className: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className={className}>
        {lead}{" "}
        <button className="linkish" aria-expanded={open}
                onClick={() => setOpen((v) => !v)}>
          {open ? "收合" : label}
        </button>
      </p>
      {open && <p className={`${className} caveat-more`}>{children}</p>}
    </>
  );
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
 * 最近一筆裁處，以及最近三個年度的筆數。
 *
 * ⚠⚠ 為什麼要加這一行：原本畫面只講「255 筆 · 民國 104–115 年」。
 *   那是一個**沒有時間重心**的敘述 —— 十年前一百筆和去年五筆，
 *   對「我要不要去這家公司上班」的意義完全不同，但畫面上長得一樣。
 *   逐年點陣其實回答得了這個問題，可是它要求讀者自己去數。
 *
 * ⚠ 基準年用「資料涵蓋到哪一年」，不是「今天是哪一年」。
 *   用今天的話，同一份資料在跨年那天會突然少掉一整年的「近 3 年」，
 *   而資料根本沒有變 —— 畫面上的數字不可以因為時鐘走動而改變。
 *
 * ⚠ 只陳述日期與筆數，不加任何形容詞。「最近還在被罰」與
 *   「這家公司現在很危險」是兩件事，我們只講得起前面那件。
 */
function recency(vs: ViolationRef[], covTo: string) {
  const ds = vs.map((v) => v.date).filter(Boolean).sort();
  if (!ds.length) return null;
  const last = ds[ds.length - 1];
  const base = Number(rocYear(covTo) || rocYear(last));
  if (!base) return { last, from: 0, to: 0, n: 0, share: 0 };
  const from = base - 2;                       // 含基準年共三個年度
  const n = vs.filter((v) => Number(rocYear(v.date)) >= from).length;
  return { last, from, to: base, n, share: vs.length ? n / vs.length : 0 };
}

/**
 * 改制前後的行政區名對照。
 *
 * ⚠⚠ 這不是我們的錯字，是**來源資料的行政區名過期了**。
 *   職安地圖的鄉鎮市區界來自 g0v/twgeojson，裡面仍是
 *   「彰化縣員林鎮」「苗栗縣頭份鎮」—— 這兩個地方分別在
 *   民國 104 年 8 月與 10 月升格為縣轄市，至今十一年。
 *   商工登記的地址用的是現名（員林市），界線檔用的是舊名（員林鎮），
 *   不做對照，這兩個地方的連結會永遠落空，而且是安靜地落空。
 *
 * ⚠ 這裡只做「讓連結接得上」，不改畫面上的地名 ——
 *   地圖標的是哪一版名稱，是界線檔的事實，要修得從資料端修。
 *   這一條已列入「關於資料」的已知缺口。
 */
const DISTRICT_ALIAS: Record<string, string> = {
  "彰化縣員林市": "彰化縣員林鎮",
  "苗栗縣頭份市": "苗栗縣頭份鎮",
};

/**
 * 從登記地址推出鄉鎮市區的鍵，例如「台北市中正區」。
 *
 * ⚠ 商工登記寫「臺北市」，職安地圖的鍵是「台北市」—— 兩個字不一樣，
 *   不正規化就永遠對不到。這類「看起來一樣的字」是串接失敗的常見原因，
 *   所以寧可在這裡多寫一行，也不要讓連結安靜地失效。
 *
 * ⚠ 推不出來就回 null，畫面上就不顯示那個連結。
 *   寧可少一個入口，也不要把使用者送到一張錯的地圖上。
 */
function districtOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const a = address.trim();
  const c = /^(.{2,3}[縣市])/.exec(a);
  if (!c) return null;
  const rest = a.slice(c[0].length);

  /* ⚠⚠ 一定要先試「區」，不能寫成一條 `.{1,4}?[區鄉鎮市]`。
     那樣寫「高雄市前鎮區成功二路」會在「鎮」就停住，推成「前鎮」；
     反過來用貪婪的話，「臺中市西屯區市政北二路」會吃成「西屯區市」。
     行政區名一定以這四個字其中之一結尾，而「區」在台灣的層級最低，
     所以逐一嘗試、區優先，是唯一不會被路名騙到的寫法。 */
  let d = "";
  for (const suf of ["區", "鄉", "鎮", "市"]) {
    const m = new RegExp(`^(.{1,3}?${suf})`).exec(rest);
    if (m) { d = m[1]; break; }
  }
  if (!d) return null;
  const key = (c[1] + d).replace(/臺/g, "台");
  return DISTRICT_ALIAS[key] ?? key;
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

/**
 * 時序型樣態。
 *
 * ⚠⚠ 這一塊**刻意放在佐證清單之外**，而且用不同的視覺語言。
 *   身分訊號回答「這幾家是不是同一個人的」，樣態訊號回答
 *   「這個樣子像不像收掉再開」。把它塞進佐證清單裡，就是把兩個
 *   不同的問題混成一個答案 —— 那正是這個專案一路在避免的事。
 *
 * ⚠ 措辭是紅線。只陳述兩個日期，不用「換殼」兩個字，不推論動機。
 *   「符合這個樣態」跟「就是換殼」之間隔著動機與事實認定，
 *   那是主管機關的事，不是我們的。
 */
function SuccessionBox({ c }: { c: LinkedCompany }) {
  const s = c.succession;
  if (!s) return null;
  const gap = Math.abs(s.new_established - s.old_last_violation);
  return (
    <div className="succ">
      <p className="succ-h">時序</p>
      <p className="succ-p">
        {s.role === "after" ? (
          <>
            <b>{c.name}</b> 於西元 {s.old_last_violation} 年最後一次被裁處，
            目前登記現況為<b>{c.status || "不明"}</b>；
            而本頁這家公司設立於西元 {s.new_established} 年。
          </>
        ) : (
          <>
            本頁這家公司於西元 {s.old_last_violation} 年最後一次被裁處後停業；
            <b>{c.name}</b> 設立於西元 {s.new_established} 年。
          </>
        )}
      </p>
      {s.same_year ? (
        /* ⚠ 這個警語不可以省。商工登記的設立只有年份沒有月日，
           同年的先後順序講不清楚。實測 37.5% 的案例是這種。 */
        <p className="succ-warn">
          ⚠ 兩個年份<b>相同</b>。商工登記的設立只記到年，沒有月日，
          所以<b>先後順序無法確定</b>。
        </p>
      ) : (
        <p className="succ-note">相隔 {gap} 年。</p>
      )}
      <p className="succ-note">
        這只是兩個日期的先後。本系統不推論原因，也不認定這兩家公司之間
        有任何法律上的關係。
      </p>
    </div>
  );
}

/** 獨立佐證（同地址、同縣市⋯）。⚠ 跟 lookup.ts 的 independentCount 同一條規則。 */
function independentEv(c: LinkedCompany) {
  return c.evidence.filter(
    (e) => e.kind !== "same_name" && e.kind !== "rare_name");
}

/** 姓名訊號（同名、罕見）。它們是同一個訊號的兩種說法，不是兩項證據。 */
function nameEv(c: LinkedCompany) {
  return c.evidence.filter(
    (e) => e.kind === "same_name" || e.kind === "rare_name");
}

/** 查詢網址。⚠ 跟 Home 的 pushState 用同一個格式，改一邊要改兩邊。 */
function qHref(name: string): string {
  // ⚠ demo 遮罩模式下 name 是遮罩後的字，要換回原名並帶著 demo=1。非 demo 模式行為不變。
  return demoHref(name);
}

/**
 * 這是不是一個「單純的左鍵點擊」。
 *
 * ⚠ 中鍵、Ctrl/⌘/Shift/Alt + 點擊要**放行**給瀏覽器處理，
 *   那是「開新分頁」「另存連結」的標準操作。攔下來等於把 <a> 變回 <button>。
 */
function plainClick(e: React.MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

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
/**
 * 一筆裁處。
 *
 * ══════════════════════════════════════════════════════════════
 * compact 模式：一行摘要，點開才看細節
 * ══════════════════════════════════════════════════════════════
 * 2026-09-15 量出來的（台積電那一頁，手機 400px）：
 *
 *     頁高 6,374 px
 *     └─ 逐筆裁處 2,446 px（11 筆，**每筆平均 222 px**）★
 *
 * 一筆裡塞了六段：日期／法條／違反內容／危害型態／罰鍰＋字號＋連結／訴願。
 * 捲五個螢幕才看完十一筆，而其中多數是同一條法條的同一句法規全文。
 *
 * ⚠⚠ 第一次嘗試是「依法條分組」，**結果是頁面反而變長 145 px**。
 *   原因：清單本來就只顯示 12 筆（有分頁），收進分組的 16 筆
 *   大多本來就在分頁之外 —— 等於沒省，而分組列自己又多了 245 px。
 *   教訓：**先量高度再動手。**用字數推論捲動距離會推錯。
 *
 * ⚠ 收起來的東西**一個都沒有拿掉**。處分字號與原始公告連結是法律風險的
 *   防線，任何情況下都不能省 —— 它們還在，只是多一次點擊。
 */
function Violation({ v, compact }: { v: ViolationRef; compact?: boolean }) {
  const pending = isPending(v);
  const [open, setOpen] = useState(false);
  if (compact && !open) {
    return (
      <li className="vio vio-row">
        <button className="vio-rowbtn" onClick={() => setOpen(true)}>
          <span className="vio-rowdate num">{v.date}</span>
          {/* ⚠ 2026-10-29：收合列原本只有法條字號（「勞動基準法第24條」），
              求職者看不懂那是什麼事。有人話標籤就先講人話，法條留在展開裡。 */}
          <span className="vio-rowlaw">{v.plain?.label ?? lines(v.law)[0]}</span>
          <span className="vio-rowfine num">{money(v.fine)}</span>
        </button>
        {/* ⚠ 標籤留在收合狀態也要看得到。25 筆裡有 1 筆涉及死亡災害的時候，
            使用者必須在不展開的情況下就看得到那一筆。 */}
        <div className="vio-tags vio-rowtags"><Tags v={v} /></div>
      </li>
    );
  }
  return (
    <li className="vio">
      <div className="vio-date">
        <span className="num">{v.date}</span>
        {compact && (
          <button className="linkish vio-close" onClick={() => setOpen(false)}>
            收合
          </button>
        )}
      </div>
      <div className="vio-body">
        <div className="vio-tags"><Tags v={v} /></div>
        {v.plain && <p className="vio-plain">{v.plain.label}</p>}
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
        {pending ? (
          <p className="vio-appeal">
            {v.appeal}{"　"}本案的行政救濟程序尚未終結，原處分是否維持仍待確定。
          </p>
        ) : v.appeal ? (
          /* 已經有結果的訴願（駁回、撤銷），或是「曾公告訴願中但備註被清空」。
             ⚠ 這一類**不掛「尚未確定」標籤**：掛了等於說案子還在進行中，
               而它可能早就結束了。但也不能不顯示 —— 不顯示就等於說
               「沒有人爭議過這件事」。所以用中性的樣式把事實寫出來。 */
          <p className="vio-appeal-plain">訴願{"　"}{v.appeal}</p>
        ) : null}
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

/**
 * 同一條法條重複很多次的時候，收成一列摘要。
 *
 * ══════════════════════════════════════════════════════════════
 * 為什麼做這件事
 * ══════════════════════════════════════════════════════════════
 * 2026-09-15 指導老師的意見是「字太多，使用者不會看」。我去量了台積電
 * 那一頁（手機寬度）：
 *
 *     全頁文字   3,257 字
 *     頁面高度   6,229 px（約 7 個螢幕）
 *     警語總字數   686 字 ← 只佔 21%
 *
 * **79% 的文字是裁處紀錄本身**，而台積電 27 筆裡有 25 筆是同一條
 * 勞基法第 32 條第 2 項的加班超時，每一筆都把法規全文再印一次。
 * 滑五個螢幕，讀到的是同一句話講五遍。
 *
 * ⚠⚠ 所以砍警語是砍錯地方。警語 686 字是這個作品最大的差異點，
 *   砍掉它會毀掉「每個數字都講清楚限制」那個形象，而 2,571 字的重複
 *   一個字都沒少。要砍的是**重複**。
 *
 * ⚠ 一筆都不會被藏起來：展開就在那裡，處分字號與原始公告連結全部保留。
 *   那是法律風險的防線，任何情況下都不能省。
 *
 * ⚠ 少於 GROUP_MIN 筆不分組。為了分組而分組會讓畫面多一層點擊，
 *   卻沒有省到任何東西。實測「辰豐營造」43 筆散在 24 種法條上，
 *   那種公司本來就收不動，維持原樣才對。
 */
const GROUP_MIN = 3;

/**
 * 「這家公司被罰過什麼」——一排橫條。
 *
 * ══════════════════════════════════════════════════════════════
 * 為什麼是這個形狀
 * ══════════════════════════════════════════════════════════════
 * 一個不懂勞動法的人看到「勞動基準法第32條第2項」是看不懂的。
 * 他要的是「加班超過法定上限」。pipeline/plainlaw.py 那張 28 條的
 * 對照表把 98.7% 的紀錄翻成人話，這裡把它畫出來。
 *
 * ⚠⚠ 三條規矩，每一條都是紅線：
 *
 * 一、**長條的長度是「筆數」，不是「有多糟」。** 所以旁邊固定寫一句
 *    「筆數受檢查與稽核頻率影響」。一家被查過十次的公司會比
 *    一家從沒被查過的公司「看起來更糟」，那是稽核密度不是職場品質。
 *
 * 二、**不跨公司比較、不排名、不評分。** 長條只在這一頁的內部比長短，
 *    沒有任何「業界平均」之類的參照線 —— 那會變成評價。
 *
 * 三、**顏色只有涉及職災／死亡那一種。** 其餘全部同一個墨色。
 *    如果每一列都有顏色，就沒有任何一列是突出的。
 *
 * ⚠ 對不到人話標籤的（1.3%）標「其他」，不猜。
 */
/**
 * 主題 → 類別。
 *
 * ⚠⚠ 外部檢視兩次建議「用三個顏色分成錢的問題／工時的問題／會死人的問題」。
 *   目標我同意（與其反覆用文字提醒「筆數不等於嚴重度」，不如讓版面自己說話），
 *   但**顏色不是對的工具**：tokens.css 只有三個有意義的顏色，
 *   加三個新色會讓「涉及死亡災害」那個紅色不再突出。
 *
 * ⚠ 而且「會死人的問題」是**我們的嚴重度判斷**，那條紅線不能踩。
 *   改成分組：類別名稱是**法規本身的定義域**——職安法管的就是人身安全，
 *   那是法律寫的，不是我們排的。效果一樣，但我們沒有替使用者排嚴重度。
 */
const FAMILY: [string, string[]][] = [
  ["人身安全", ["職業安全"]],
  ["薪資與給付", ["工資", "退休金", "職災保險"]],
  ["工時與休假", ["工時", "休假"]],
  ["紀錄與配合檢查", ["出勤紀錄", "妨礙檢查"]],
];

function familyOf(topic: string): string {
  for (const [fam, topics] of FAMILY) if (topics.includes(topic)) return fam;
  return "其他";
}

/**
 * 「被罰過的事」——整個結果頁唯一回答「這家公司到底怎麼了」的地方。
 *
 * ══════════════════════════════════════════════════════════════
 * 為什麼把危害型態面板併進來
 * ══════════════════════════════════════════════════════════════
 * 2026-09-15 外部檢視：「結果頁有兩個區塊在講同一件事：『被罰過的事』
 * 長條圖（墜落防護不足 231）和最下方的『被罰過的職安危害型態』（墜落 231），
 * 數字幾乎一樣，但隔了兩千多 px。」
 *
 * 他說得對。原本的分工是長條講口語、面板講分類加法規義務，
 * 但使用者不會知道那是同一件事的兩種寫法 —— 他只會覺得看到兩次。
 * 合併成一個：口語標籤當主體，點開看「法規要求雇主做什麼」。
 *
 * ⚠ 合併之後**三件不能省的事**照樣要在（原本寫在危害型態面板的檔頭）：
 *   1. 各類加總會大於公告筆數（一筆可能同時屬於多類），不要拿它當分母。
 *   2. 沒有標籤的職安法公告，是**本站的規則沒有對到**，不是「沒有危害」，
 *      **也不是「公告沒寫」** —— 2026-09-17 實測，那些公告多數寫得很清楚，
 *      只是不落在我們的十四種分類裡。把自己的涵蓋不足說成來源的缺漏，
 *      方向剛好相反。
 *   3. 法規義務那段文字是教育內容，不是對這家公司的認定。
 *
 * ⚠ 長條的長度是**筆數不是嚴重度**。一家被查過十次的公司會比一家
 *   從沒被查過的公司「看起來更糟」，那是稽核密度不是職場品質。
 */
/**
 * 長條的長尾收合。
 *
 * ⚠ 這不是為了省版面才做的（實測只省 261px，全頁 4,193 → 3,932，−6%，
 *   你多半看不出來）。做它的理由是**可讀性**：台電「人身安全」家族有
 *   11 列，其中 7 列是 1–2 筆。眼睛要一路掃過那 7 列雜訊才看得到形狀。
 *
 * ⚠⚠ **有死亡災害的類別永遠不收**，不管筆數多小。
 *   台電的「職業災害沒有依規定通報」只有 3 筆但涉及死亡 —— 用筆數當
 *   唯一門檻就會把它藏起來。這是紅線：不可以因為數字小就把人命收摺。
 *
 * ⚠ 長尾少於 2 列時整個不收 —— 收合那一行本身就跟一列一樣高，
 *   收一列是純粹的多此一舉，還多一次點擊。
 *
 * ⚠⚠ **家族標題底下不可以是空的。** 第一版只用「筆數 >= 3 或有死亡」
 *   當門檻，沒想到整個家族的每一列都可能少於 3 筆。實測 4 家公司壞了 2 家：
 *     和德昌   「人身安全」0 列 —— 最重要的家族整個被收進一次點擊後面
 *     中華郵政 「薪資與給付」0 列、「工時與休假」0 列
 *   一個有標題、底下空無一物、只掛著一顆收合鈕的區塊，讀起來就是壞掉。
 *   所以 head 空的時候，把長尾最大的那一列提上來（rows 已依筆數排序）。
 *   ⚠ 這也是為什麼驗證不能只看台積電或台電那種大公司 ——
 *     大公司每個家族都有大數字，剛好繞過這個分支。
 */
const TAIL_MIN = 3;

function splitTail<T extends { n: number; fatal: number }>(
  rows: readonly (readonly [string, T])[],
): { head: (readonly [string, T])[]; tail: (readonly [string, T])[] } {
  const head = rows.filter(([, x]) => x.n >= TAIL_MIN || x.fatal > 0);
  const tail = rows.filter(([, x]) => x.n < TAIL_MIN && x.fatal === 0);
  // 家族底下至少要看得到一列。rows 已依筆數由多到少排序，所以 tail[0] 最大。
  if (head.length === 0 && tail.length > 0) head.push(tail.shift()!);
  if (tail.length < 2) return { head: [...rows], tail: [] };
  return { head, tail };
}

/** 「你可以確認什麼」清單的一列：法規要求＋面試時可以問的一句。 */
function AskItems({ items }: { items: readonly (readonly [string, string])[] }) {
  return (
    <ol className="ask-list">
      {items.map(([label, d]) => (
        <li key={label}>
          <b className="ask-t">{label}</b>
          <span className="ask-d">{d}</span>
          {ASK[label] && <span className="ask-q"><b>可以問</b>{"\u3000"}{ASK[label]}</span>}
        </li>
      ))}
    </ol>
  );
}

/**
 * 短清單（≤ 12 筆）的「你可以確認什麼」。長清單由 PlainBars 負責，規則一樣：
 * 標籤用人話標籤，沒有就用危害型態的 phrase；收容類別不進清單；
 * 查不到法規義務原文的跳過，不自己寫。
 */
const ASK_CATCHALL = new Set(["其他", "公告內容未對應到本站的危害分類"]);
function ShortAsk({ vs }: { vs: ViolationRef[] }) {
  const [duty, setDuty] = useState<PlainDict>({});
  useEffect(() => { void getPlainLaw().then(setDuty); }, []);
  const items = useMemo(() => {
    const m = new Map<string, { n: number; duty: string }>();
    for (const v of vs) {
      const h = v.hazards && v.hazards.length ? v.hazards[0] : null;
      const label = v.plain?.label ?? (h ? (h.phrase ?? h.name) : "");
      if (!label || ASK_CATCHALL.has(label)) continue;
      const cur = m.get(label) ?? { n: 0, duty: h?.duty ?? "" };
      cur.n += 1;
      m.set(label, cur);
    }
    return [...m.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([label, x]) => [label, x.duty || duty[label]?.duty || ""] as const)
      .filter(([, d]) => d.length > 0)
      .slice(0, 3);
  }, [vs, duty]);
  if (!items.length) return null;
  return (
    <section className="ask" style={{ marginTop: 18 }}>
      <div className="kicker">面試時，你可以確認什麼</div>
      <p className="ask-lead">
        以下是這家公司被罰過的{items.length === 1 ? "一" : items.length === 2 ? "兩" : "三"}類事，
        法規對雇主的要求。<b>這是法規對所有雇主的一般性要求，不是對這家公司的認定</b> ——
        面試或到職時，可以據此確認。
      </p>
      <AskItems items={items} />
    </section>
  );
}

/**
 * 「如果你在職場遇到類似的事」。
 *
 * ⚠ 2026-10-29 新增。查完之後使用者手上有資訊，卻不知道真的遇到了能找誰。
 * ⚠ 每一句都要有出處：1955 專線見勞動部網站（24 小時、免付費，也服務本國勞工）；
 *   不利處分禁止見職業安全衛生法第 39 條第 4 項、勞動檢查法第 33 條第 4 項；
 *   申訴人身分保密見勞動檢查法第 33 條第 5 項。不要自己加條文。
 */
function Recourse() {
  const [open, setOpen] = useState(false);
  return (
    <section className="recourse">
      <p className="rc-line">
        遇到勞動權益或安全問題？撥 <b className="num">1955</b> 勞工諮詢申訴專線（24 小時、免付費）
        <button className="linkish" onClick={() => setOpen((v) => !v)}>
          {open ? "收合" : "其他申訴管道"}
        </button>
      </p>
      {open && (
        <ul>
          <li><b>工資、工時、休假、勞退</b>：向工作所在地的縣市政府勞工局（處）申訴。</li>
          <li>
            <b>工作場所安全</b>：可以向雇主、主管機關或勞動檢查機構申訴。
            雇主不得因此解僱、調職或做其他不利的處分（職業安全衛生法第 39 條），
            勞動檢查機構必須對申訴人的身分保密（勞動檢查法第 33 條）。
          </li>
        </ul>
      )}
    </section>
  );
}

function PlainBars({ vs }: { vs: ViolationRef[] }) {
  const [duty, setDuty] = useState<PlainDict>({});
  const [open, setOpen] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  // 每個家族的長尾各自收放。⚠ 用家族名當鍵，不要用索引 ——
  // 家族數量會隨公司不同而變，索引在換一家公司之後會指到別的家族。
  const [tailOpen, setTailOpen] = useState<Record<string, boolean>>({});
  useEffect(() => { void getPlainLaw().then(setDuty); }, []);

  const groups = useMemo(() => {
    const m = new Map<string, { n: number; fatal: number; topic: string; duty: string }>();
    // ⚠⚠ 2026-10-29：改成「涉及這一類的筆數」，一筆有幾個危害型態就各算一次。
    //   原本每筆只歸第一類，於是同一頁上篩選按鈕寫「感電 25」、長條寫「用電安全防護不足 22」，
    //   評審看到的是同一個網站對同一類講兩個數字。各類相加會超過總筆數，這件事寫在「怎麼算的？」。
    //   ⚠ 簡報與海報的全國比例（墜落 41.1%）是另一種算法：一筆只歸主要的一類，加總 100%。
    for (const v of vs) {
      const hs = v.plain || !(v.hazards && v.hazards.length) ? [null] : v.hazards;
      for (const h of hs) {
        const label = v.plain?.label ?? (h ? (h.phrase ?? h.name) : "其他");
        const topic = v.plain?.topic ?? (h ? "職業安全" : "其他");
        const cur = m.get(label)
          ?? { n: 0, fatal: 0, topic, duty: h?.duty ?? "" };
        cur.n += 1;
        if (v.fatal) cur.fatal += 1;
        if (!cur.duty && h?.duty) cur.duty = h.duty;
        m.set(label, cur);
      }
    }
    const byFam = new Map<string, [string, typeof m extends Map<string, infer V> ? V : never][]>();
    for (const [label, x] of m) {
      const fam = familyOf(x.topic);
      const arr = byFam.get(fam) ?? [];
      arr.push([label, x]);
      byFam.set(fam, arr);
    }
    const order = [...FAMILY.map((f) => f[0]), "其他"];
    return order
      .filter((f) => byFam.has(f))
      .map((f) => [f, byFam.get(f)!.sort((a, b) => b[1].n - a[1].n)] as const);
  }, [vs]);

  if (groups.length === 0) return null;
  const max = Math.max(...groups.flatMap(([, r]) => r.map((x) => x[1].n)));
  const fatalTotal = vs.filter((v) => v.fatal).length;
  // 涉及死亡災害的公告落在哪幾類，多到少。⚠ 收容類別不排除 ——
  // 「未對應到本站的危害分類」裡若真的有死亡災害，藏起來比難看更糟。
  const fatalRows = groups
    .flatMap(([, r]) => r)
    .filter(([, x]) => x.fatal > 0)
    .sort((a, b) => b[1].fatal - a[1].fatal);

  // ⚠ 最大的那一類先用一句話講完。134 / 255 這種事使用者不會自己算，
  //   而它往往就是整頁最有資訊量的一行（台電有 52.5% 是承攬管理 ——
  //   那家公司自己不派人爬電桿，工程是外包的，這件事光看法條看不出來）。
  //   只有佔比 ≥30% 才印；不然「每 10 筆有 1 筆」是廢話。
  // ⚠⚠ 收容類別不可以當結論。實測和德昌印出
  //   「每 3 筆裁處，就有 1 筆是『其他』」—— 那句話零資訊，而且看起來像壞掉。
  //   「其他」是家族層的收容桶，「公告內容未對應到本站的危害分類」是
  //   危害層的收容桶，兩個都要排除。
  const CATCHALL = new Set(["其他", "公告內容未對應到本站的危害分類"]);
  const flat = groups.flatMap(([, r]) => r).filter(([label]) => !CATCHALL.has(label));
  const top = flat.length
    ? flat.reduce((a, b) => (b[1].n > a[1].n ? b : a))
    : null;
  const share = top && vs.length ? top[1].n / vs.length : 0;

  // 前三類（排除收容桶）且**查得到法規義務原文**的才進清單。
  // ⚠ 查不到 duty 的就跳過，不要為了湊三條去寫一段自己的話。
  const checklist = flat
    .slice()
    .sort((a, b) => b[1].n - a[1].n)
    .map(([label, x]) => [label, x.duty || duty[label]?.duty || ""] as const)
    .filter(([, d]) => d.length > 0)
    .slice(0, 3);

  return (
    <div className="bars">
      <div className="kicker" style={{ marginBottom: 9 }}>被罰過的事</div>
      {top && share >= 0.3 && (
        <div className="bars-lead">
          <p className="bars-lead-t">
            每 <b>{Math.round(1 / share)}</b> 筆裁處，就有 <b>1</b> 筆是<br />
            「{top[0]}」
          </p>
          <div className="bars-lead-bar">
            <span style={{ width: `${share * 100}%` }} />
          </div>
          <p className="bars-lead-n num">
            {top[1].n} / {vs.length} 筆 ・ {(share * 100).toFixed(1)}%
          </p>
        </div>
      )}
      {groups.map(([fam, rows]) => {
        const { head, tail } = splitTail(rows);
        const shown = tailOpen[fam] ? [...head, ...tail] : head;
        const tailN = tail.reduce((a, [, x]) => a + x.n, 0);
        return (
        <div key={fam} className="bar-fam">
          <p className="bar-famh">{fam}</p>
          <ul className="bar-list">
            {shown.map(([label, x]) => {
              const d = x.duty || duty[label]?.duty || "";
              const isOpen = open === label;
              return (
                <li key={label}>
                  <button className="bar-row"
                          aria-expanded={isOpen}
                          onClick={() => setOpen(isOpen ? null : label)}>
                    <span className="bar-label">{label}</span>
                    <span className="bar-track">
                      <span className="bar-fill" style={{ width: `${(x.n / max) * 100}%` }} />
                    </span>
                    <span className="bar-n num">{x.n}</span>
                  </button>
                  {x.fatal > 0 && (
                    <p className="bar-fatal">⚠ 其中 {x.fatal} 筆公告涉及死亡災害</p>
                  )}
                  {isOpen && d && (
                    <div className="duty">
                      <p className="kicker" style={{ margin: "0 0 5px" }}>
                        法規要求雇主做什麼
                      </p>
                      <p className="duty-text">{d}</p>
                      <p className="fineprint" style={{ margin: "8px 0 0" }}>
                        這是法規的一般性要求，<b>不是對這家公司的認定</b>。
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {tail.length > 0 && (
            <button className="bar-tail"
                    aria-expanded={!!tailOpen[fam]}
                    onClick={() => setTailOpen((t) => ({ ...t, [fam]: !t[fam] }))}>
              {tailOpen[fam]
                ? "收合"
                : `其他 ${tail.length} 類（共 ${tailN} 筆，各少於 ${TAIL_MIN} 筆）`}
            </button>
          )}
        </div>
        );
      })}
      {/* ⚠ 警語也要分兩層（NN/g progressive disclosure）。
          實測整頁 8 段警語共 668 字、佔全頁 21.4% 而且全部常駐 ——
          **警語太長等於沒有警語**，使用者第三次看到就跳過了。
          第一句留在畫面上，其餘收摺。⚠ 收的是說明，不是警告本身。 */}
      <p className="fineprint">
        長度是<b>筆數</b>，不是嚴重程度。
        <button className="linkish" style={{ marginLeft: 6 }}
                aria-expanded={why}
                onClick={() => setWhy((v) => !v)}>
          {why ? "收合" : "怎麼算的？"}
        </button>
      </p>
      {why && (
        <p className="fineprint" style={{ marginTop: 6 }}>
          被查過十次的公司不等於比從沒被查過的公司危險——筆數同時反映稽核頻率。
          每一類是「涉及這一類的筆數」，一筆公告同時涉及兩類就兩邊各算一次，
          所以各類相加會超過總筆數；下方的篩選按鈕用的是同一套算法。
          職安法公告沒有標籤，是本站的分類規則沒有對到，
          不是「公告沒寫」，也不是「沒有危害」。
        </p>
      )}
      {/* ⚠⚠ 「有 10 筆涉及死亡災害」回答的是「有多嚴重」，
          但組別叫**視覺化防災**，防災的第一個問題是「要防什麼」。
          每一類的 fatal 計數本來就算好了，只是沒有收攏成一句話。
          ⚠ 用的是跟長條同一份 groups（涉及這一類就算），一筆可能出現在兩類，
          所以這幾個數字相加可能大於 fatalTotal。 */}
      {fatalRows.length > 0 && (
        <p className="fatal-where">
          <span className="fatal-where-k">集中在</span>
          {fatalRows.map(([label, x]) => (
            <span key={label} className="fatal-chip">
              {label}<i className="num">{x.fatal}</i>
            </span>
          ))}
        </p>
      )}
      {fatalTotal > 0 && (
        <Caveat className="warnbox" label="「涉及」包含哪些情形？"
                lead={<>共 {fatalTotal} 筆公告<b>涉及</b>死亡災害。「涉及」指
                  公告文字提到，<b>不等於該公司造成死亡</b>。</>}>
          包含「未依規定通報死亡災害」的情形 —— 那種罰的是通報義務，
          不是災害本身。詳情請以處分字號查閱原始公告。
        </Caveat>
      )}

      {/* ⚠⚠ 素養提升的出口。上面講完「這家公司被罰過什麼」之後，
          使用者手上有資訊卻沒有動作 —— 他不知道自己能拿這個做什麼。
          這一區把最前面幾類對應的**法規義務原文**攤開，讓他知道
          面試或到職時可以確認哪些具體項目。

          ⚠⚠ 這裡一個字都不是我們寫的判斷。duty 全部來自
          hazards.json／法條對照表，是法規本文的摘錄。我們只換了
          一個框架：從「雇主應該做什麼」變成「你可以確認什麼」。
          一旦開始寫「這家公司可能沒有做到 X」，就是在做認定，
          那是主管機關的事，不是我們的。

          ⚠ 標題底下那句免責必須跟著，不可以只留清單。 */}
      {checklist.length > 0 && (
        <section className="ask">
          <div className="kicker">你可以確認什麼</div>
          <p className="ask-lead">
            以下是這家公司被罰最多的{checklist.length === 1 ? "一" : checklist.length === 2 ? "兩" : "三"}類，
            法規對雇主的要求。<b>這是法規對所有雇主的一般性要求，不是對這家公司的認定</b> ——
            面試或到職時，可以據此確認你要去的工地或廠區是否落實。
          </p>
          <AskItems items={checklist} />
        </section>
      )}
    </div>
  );
}

/**
 * 年度分布。
 *
 * ⚠ 刻意**不用長條圖、不用折線**。兩者都會被讀成趨勢
 *   （「這家公司越來越糟」），點只回答「什麼時候發生過」。
 *
 * ══════════════════════════════════════════════════════════════
 * ⚠⚠ 2026-09-17 實測：那個「趨勢」主要是**公告制度在擴張**
 * ══════════════════════════════════════════════════════════════
 * 全國裁處公告逐年筆數：
 *     民國 104 年   4,206 筆
 *     民國 110 年  86,464 筆
 *     民國 114 年  98,590 筆   ← 十一年成長 23 倍
 *
 * 原因不是全國公司變壞 23 倍，是**新的法規陸續納入公告**：
 *     勞工退休金條例        108 年以前 0 筆 → 110 年 74,227 筆
 *     勞工職業災害保險及保護法  110 年以前 0 筆 → 114 年  7,707 筆
 *
 * 所以任何一家公司的「早年少、近年多」，主要畫的是母體本身在長。
 * 台電 104 年 2 筆、114 年 38 筆看起來惡化 19 倍，
 * 但它佔全國的比例其實從 4.8‱ 降到 3.9‱。
 *
 * **在一個會成長的母體上畫趨勢，畫出來的是制度，不是行為。**
 * 改成折線或長條只會讓那個假故事更好讀。這個違反圖表慣例的決定
 * 是量過的，不是品味問題 —— 不要「修好」它。
 *
 * ⚠ 最後一格可能是**部分年度**（resource 抓到 115/08/31 就只有八個月）。
 *   17 筆並排在 114 年的 38 筆旁邊，讀起來是改善，實際是資料截斷。
 *   一定要標，而且標記靠 meta.coverage_to，不要寫死。
 */
function YearDots({ vs }: { vs: ViolationRef[] }) {
  const years = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of vs) {
      const y = rocYear(v.date);
      if (y) m.set(y, (m.get(y) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [vs]);
  // ⚠⚠ 所有 Hook 都要在提前 return 之前呼叫，跟 Credentials 同一條規矩。
  //   getMeta() 內部是 memoize 過的（metaPromise ??=），重複呼叫不會多打一次網路。
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => { void getMeta().then(setMeta); }, []);
  if (years.length < 2) return null;
  const max = Math.max(...years.map((y) => y[1]));

  // 「YYY/MM/DD」→ 不是 12/31 就代表那一年還沒走完。
  const cov = meta?.coverage_to ?? "";
  const covYear = cov.slice(0, 3);
  const partial = cov.length === 9 && cov.slice(4) !== "12/31" ? covYear : "";
  const lastIsPartial = partial && years[years.length - 1][0] === partial;

  return (
    <div className="ydots">
      <ul className="ydots-list">
        {years.map(([y, n]) => {
          const isPartial = y === partial;
          return (
            <li key={y}
                title={isPartial
                  ? `民國 ${y} 年（僅到 ${cov}）\u3000${n} 筆`
                  : `民國 ${y} 年\u3000${n} 筆`}>
              <span className={isPartial ? "ydot partial" : "ydot"}
                    style={isPartial ? undefined
                      : { opacity: 0.25 + 0.75 * (n / max) }} />
              <span className="ydot-y num">{y}</span>
              <span className="ydot-n num">{n}{isPartial && "*"}</span>
            </li>
          );
        })}
      </ul>
      {/* ⚠ 常駐的是「115 年不是完整年度」—— 那一句不看就會把資料截斷
          讀成改善。收起來的是「為什麼」。 */}
      <Caveat className="ydots-note" label="為什麼不能跨年比較？"
              lead={<>
                {lastIsPartial && <>* 民國 {partial} 年只到 {cov}，<b>不是完整年度</b>。</>}
                {" "}⚠ 跨年比較請謹慎。
              </>}>
        全國公告筆數在這段期間成長約 <b>23 倍</b>（民國 104 年 4,206 筆
        → 114 年 98,590 筆），因為勞工退休金條例在 110 年、勞工職業災害保險及
        保護法在 111 年才納入公告。早年筆數少多半是<b>當年還沒公告這些案件</b>，
        不是當年比較安全。
      </Caveat>
    </div>
  );
}

/**
 * 法條分組的一列。
 *
 * ⚠⚠ 從「卡片」改成「表格列」是量出來的決定，不是排版品味。
 *   2026-09-18 實測台電頁：舊版每列 130px，19 列共 2,472px，
 *   佔整頁 5,989px 的 **41%**；真正的摘要（Ledger）只佔 9%。
 *   頁面有八成在放清單，兩成不到在放結論。
 *   **欄位內容一個字都沒變**，只是同樣的四項資訊從四行變成一行。
 *   要改回卡片前，先量一次頁高。
 *
 * ⚠ 改表格時我一度拿掉 topHz（該組最常見的三種危害），理由是「危害長條
 *   講過了」。使用者否決：法條編號對非法律背景的人是不透明的，那一行是
 *   整列唯一用人話說「這條在管什麼」的地方。**沒有任何欄位被移除。**
 *
 * ⚠⚠ 「其中 N 筆公告未載金額」**沒有被拿掉**，只是縮成 †N 加表尾註解。
 *   這一項不能省：省掉的話「合計 760,000」會被讀成「總共只罰了 76 萬」，
 *   而實際上有幾筆根本沒公告金額。整組都沒有金額時顯示「全數未載」，
 *   不顯示 0 —— 0 會被讀成「罰了 0 元」。
 */
/**
 * 門面用的線框圖示。
 *
 * ⚠ 全部用 `stroke="currentColor"`，顏色一律由外層的 CSS 決定 ——
 *   圖示裡寫死顏色就會在深色主題消失，而且繞過 tokens.css。
 * ⚠ 都是裝飾性的：外層文字已經把意思講完了，所以掛 aria-hidden，
 *   不要給它們 aria-label，否則螢幕閱讀器會把同一件事唸兩次。
 */
const ICON: Record<string, ReactNode> = {
  megaphone: <><path d="M4 10v4h3l6 4V6l-6 4H4z" /><path d="M17 9a4 4 0 0 1 0 6" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
  plus: <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v8M8 12h8" /></>,
  arrow: <><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>,
  keyboard: <><rect x="3" y="8.3" width="18" height="8" rx="2" /><path d="M6.5 12.3h6" /><path d="M16.5 9.6v5.4" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6" /><path d="M20 20l-4.8-4.8" /></>,
  doc: <><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M8.5 8.5h7M8.5 12.5h7M8.5 16.5h4" /></>,
  bag: <><rect x="3" y="8" width="18" height="12" rx="1.5" /><path d="M8.5 8V6.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2V8" /></>,
  clipboard: <><rect x="6" y="3.5" width="12" height="17" rx="1.5" />
               <path d="M9.5 3.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v.5" /><path d="M9 12.5l2 2 4-4.5" /></>,
  bank: <><path d="M12 3l9 5H3l9-5z" /><path d="M5 10v8M9 10v8M15 10v8M19 10v8" /><path d="M4 20h16" /></>,
  check: <><path d="M20 6.5L9.5 17 4 11.5" /></>,
  minus: <><circle cx="12" cy="12" r="8.5" /><path d="M8 12h8" /></>,
  chat: <><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9.5h8M8 12.5h5" /></>,
  ext: <><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
  coin: <><circle cx="12" cy="12" r="8.5" /><path d="M14.5 9.2c-.6-.8-1.5-1.2-2.5-1.2-1.4 0-2.5.8-2.5 2s1.1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-1.9-.4-2.5-1.2M12 6.5v11" /></>,
  aid: <><rect x="3.5" y="7" width="17" height="12" rx="2" /><path d="M9 7V5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7" /><path d="M12 10.5v5M9.5 13h5" /></>,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17" /><path d="M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z" /></>,
  access: <><circle cx="12" cy="5" r="1.8" /><path d="M7 9h10M12 9v5l-3 6M12 14l3 6" /></>,
};

/** extra.json（兩組新資料的設定）。只抓一次。 */
function useExtra(): Extra | null {
  const [ex, setEx] = useState<Extra | null>(null);
  useEffect(() => { void getExtra().then(setEx); }, []);
  return ex;
}

/** 在一組分位數裡的位置（0–100）。分位數是 0、5、10…100 百分位。 */
function pctOf(v: number, q: number[] | undefined): number | null {
  if (!q || q.length < 2) return null;
  if (v <= q[0]) return 0;
  for (let i = 1; i < q.length; i++) {
    if (v <= q[i]) {
      const span = q[i] - q[i - 1];
      const f = span > 0 ? (v - q[i - 1]) / span : 0;
      return Math.round(((i - 1 + f) / (q.length - 1)) * 100);
    }
  }
  return 100;
}

/**
 * 上市櫃公司自行申報的揭露：非主管薪資中位數、職災人數、官網。
 *
 * ⚠ 使用者要求（2026-10-29）：「用類似外部連結那樣、圖像化、小小的，不要再多文字」。
 *   所以跟「在其他網站查」同一種圓角小膠囊，說明全部放 title。
 * ⚠ 都是**公司自行申報**（公開資訊觀測站），不是主管機關認定 —— title 一定要寫。
 * ⚠ 官網來自證交所／櫃買中心的基本資料（依統編），不是用搜尋去猜的。
 */
function ListedPills({ l, ex }: { l: ListedHit; ex: Extra | null }) {
  const yr = l.y ? `${l.y} 年度` : "";
  const p = l.med ? pctOf(l.med, ex?.ls_q) : null;
  return (
    <div className="elsewhere listed" aria-label="上市櫃公司自行申報的揭露資料">
      <span className="ew lsp-m" title={`${l.m}公司，股票代號 ${l.code}`}>{l.m}<b className="num">{l.code}</b></span>
      {l.med ? (
        <span className="ew lsp" title={`非擔任主管職務之全時員工薪資中位數 ${l.med.toLocaleString("zh-TW")} 仟元（${yr}，公司自行申報，公開資訊觀測站）`
          + (p !== null ? `。在所有上市櫃公司中約第 ${p} 百分位。` : "")}>
          <Ic k="coin" w={1.8} /><span>年薪中位數 <b className="num">{(l.med / 10).toFixed(1)}</b> 萬</span>
          {p !== null && <span className="meter" aria-hidden="true"><i style={{ width: `${Math.max(4, p)}%` }} /></span>}
        </span>
      ) : null}
      {l.inj !== undefined ? (
        <span className={l.inj > 0 ? "ew lsp warn" : "ew lsp"}
          title={`公司自行申報的職業災害人數${l.injr ? `與比率（占員工 ${l.injr}）` : ""}（${yr}，ESG 揭露）。不是主管機關認定。`}>
          <Ic k="aid" w={1.8} /><span>自報職災 <b className="num">{l.inj.toLocaleString("zh-TW")}</b> 人{l.injr && l.inj > 0 ? `・${l.injr}` : ""}</span>
        </span>
      ) : null}
      {l.w ? (
        <a className="ew" href={l.w} target="_blank" rel="noopener noreferrer"
           title={`公司官網（證交所／櫃買中心登錄的網址）`}>
          <Ic k="globe" w={1.8} /><span>官網</span>
          <span className="ew-x"><Ic k="ext" w={1.8} /></span>
        </a>
      ) : null}
    </div>
  );
}

/**
 * 勞動部公告：身障定額進用未足額（pipeline/extra.py）。
 *
 * ⚠⚠ 公告名單，不是裁處。未足額要繳差額補助費，不是罰鍰 —— 不可以寫「違法」「被罰」。
 * 一期一格的小方格：看得出是偶爾一次，還是年年都在名單上。
 */
function QuotaCard({ q, ex }: { q: QuotaHit; ex: Extra | null }) {
  const on = new Set(q.p.map((x) => x[0]));
  const all: [number, string][] = ex?.dq_all?.length ? ex.dq_all : q.p.map((x, i) => [i, x[0]]);
  const years = new Map<number, [number, string][]>();
  for (const a of all) {
    const y = Math.floor(a[0] / 100);
    if (!years.has(y)) years.set(y, []);
    years.get(y)!.push(a);
  }
  const last = q.p[0];
  const onLatest = !!ex?.dq_latest && last?.[0] === ex.dq_latest;
  // 金展獎（正面）。⚠ 跟未足額並列，不互相抵銷：兩件事都是公告，各自講清楚。
  const gold = q.g?.length ? (
    <div className="dq-gold">
      {q.g.map(([ed, aw], i) => (
        <span key={i} className="gold-tag" title="勞動部金展獎（進用身心障礙者績優機關）得獎名單">
          <Ic k="check" w={2} />金展獎 {ed}・{aw}
        </span>
      ))}
    </div>
  ) : null;
  if (!q.p.length) {
    return (
      <section className="dq good" aria-label="勞動部金展獎">
        <div className="dq-h"><Ic k="access" w={1.8} /><span>勞動部｜身障進用<b>績優</b></span></div>
        {gold}
      </section>
    );
  }
  return (
    <section className="dq" aria-label="勞動部公告身障定額進用未足額">
      <div className="dq-h">
        <Ic k="access" w={1.8} />
        <span>勞動部公告｜身障定額進用<b>未足額</b></span>
        <span className="dq-n"><b className="num">{q.p.length}</b> 期</span>
      </div>
      {gold}
      <div className="dq-grid" role="img"
        aria-label={`民國 ${[...years.keys()][0]} 年起共 ${all.length} 期公告，其中 ${q.p.length} 期在名單上`}>
        {[...years.entries()].map(([y, ps]) => (
          <div key={y} className="dq-yr">
            <span className="num">{y}</span>
            {ps.map(([k, l]) => <i key={k} className={on.has(l) ? "on" : ""} title={`${l}${on.has(l) ? "：在名單上" : ""}`} />)}
          </div>
        ))}
      </div>
      {last && (
        <p className="dq-last">
          最近一次 {last[0]}：應進用 <b className="num">{last[3]}</b> 人、進用 <b className="num">{last[2]}</b> 人、
          不足 <b className="num">{last[1]}</b> 人{onLatest ? "（最新一期仍在名單上）" : ""}
        </p>
      )}
      <p className="fineprint">
        身心障礙者權益保障法第 38 條：員工 67 人以上應進用 1% 身障者。未足額須繳差額補助費（不是罰鍰）。
      </p>
    </section>
  );
}

/**
 * 在其他網站查這家公司：Google、經濟部商工登記、職場評價。
 *
 * ⚠⚠ 只給連結，不抓、不存任何別人的資料（2026-10-29 討論的結論）：
 *   評價無法查證、也不是公開政府資料，整合進來就違反「不評分」；
 *   官網用搜尋去猜會對錯公司，那正是本站一路在防的誤讀。由使用者自己看、自己判斷。
 * ⚠ 點下去公司名稱會送到那個網站。畫面上不再加說明文字（使用者回饋：字已經太多），
 *   用外部連結圖示表示「離開本站」，完整說明放在 title 與 aria-label。
 * ⚠ demo 遮罩模式不顯示：連結會帶著真實公司名稱。
 * ⚠ 商工登記的網址格式 2026-10-29 實測過（公司 cmpyType、商號 busmType）；有統編就用統編查，最準。
 */
function Elsewhere({ name, taxId }: { name: string; taxId?: string }) {
  if (DEMO) return null;
  const n = name.trim();
  // ⚠ 名稱裡有「公司」但不在結尾（「台灣電力股份有限公司台中發電廠」）＝廠區或分支，
  //   商工登記要用總公司名稱查，型態也是公司，不是商號（2026-10-29 實測抓到）。
  const ci = n.indexOf("公司");
  const parent = ci > 0 && ci + 2 < n.length && !/分公司$/.test(n) ? n.slice(0, ci + 2) : n;
  // 只有統編（查無頁的統編提示）時不知道型態，用最常見的「公司」。
  const qType = /分公司$/.test(n) ? "brCmpyType" : /公司|^\d{8}$/.test(n) ? "cmpyType" : "busmType";
  const links = [
    { k: "search", label: "Google", site: "Google 搜尋",
      href: `https://www.google.com/search?q=${encodeURIComponent(n)}` },
    { k: "bank", label: "商工登記", site: "經濟部商工登記公示資料查詢",
      href: "https://findbiz.nat.gov.tw/fts/query/QueryList/queryList.do?qryCond="
        + `${encodeURIComponent(taxId || parent)}&infoType=D&qryType=${qType}&isAlive=all` },
    { k: "chat", label: "職場評價", site: "GoodJob 職場透明化運動",
      href: `https://www.goodjob.life/search?q=${encodeURIComponent(n)}` },
  ];
  return (
    <nav className="elsewhere" aria-label="在其他網站查這家公司（外部網站，會帶入公司名稱）">
      {links.map((l) => (
        <a key={l.k} className="ew" href={l.href} target="_blank" rel="noopener noreferrer"
           title={`在「${l.site}」查這家公司（外部網站，會帶入公司名稱）`}>
          <Ic k={l.k} w={1.8} /><span>{l.label}</span>
          <span className="ew-x"><Ic k="ext" w={1.8} /></span>
        </a>
      ))}
    </nav>
  );
}

function Ic({ k, w = 2 }: { k: keyof typeof ICON | string; w?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON[k]}
    </svg>
  );
}

function LawGroup({ law, vs }: { law: string; vs: ViolationRef[] }) {
  const [open, setOpen] = useState(false);
  const fined = vs.filter((v) => v.fine > 0);
  const unlisted = vs.length - fined.length;
  const total = fined.reduce((a, v) => a + v.fine, 0);
  const fatal = vs.filter((v) => v.fatal).length;
  const pending = vs.filter(isPending).length;
  const hz = new Map<string, number>();
  for (const v of vs) for (const h of v.hazards ?? []) hz.set(h.name, (hz.get(h.name) ?? 0) + 1);
  const topHz = [...hz.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
  // 表頭已經寫了「年度（民國）」，列內就不必每一列再重複「民國…年」。
  const ys = yearSpan(vs).replace(/^民國\s*/, "").replace(/\s*年$/, "");
  return (
    <>
      <tr className={open ? "lawr is-open" : "lawr"}>
        <th scope="row" className="lawr-law">
          {lines(law).map((t, i) => <span key={i}>{t}</span>)}
          {/* ⚠ 2026-09-18 第一版把這行拿掉了，使用者要求加回來：
              「法條第幾條第幾項」對非法律背景的人是不透明的，這一行是
              整列唯一用人話說「這條在管什麼」的地方。代價是每列 +17px。 */}
          {topHz.length > 0 && <span className="lawr-hz">{topHz.join("、")}</span>}
        </th>
        <td className="lawr-n num">{vs.length}</td>
        <td className="lawr-y num">{ys || "—"}</td>
        <td className="lawr-f num">
          {total > 0 ? (
            <>
              {total.toLocaleString("zh-TW")}
              {/* ⚠⚠ 第一版這裡是上標的「†28」。實測台電：35 筆裡有 28 筆
                  沒有公告金額，760,000 其實只加得到 7 筆 —— 一個 10px 的
                  上標擋不住「這家公司這條法被罰了 76 萬」的誤讀。
                  改成直接把分母寫出來：7/35 筆。
                  ⚠ 不要為了讓每一列等高而把它拿掉。列高不齊正是對的訊號：
                    合計不完整的列本來就該看起來不一樣。 */}
              {unlisted > 0 && (
                <span className="lawr-cov">{fined.length}/{vs.length} 筆有金額</span>
              )}
            </>
          ) : (
            <span className="lawr-none">全數未載</span>
          )}
        </td>
        <td className="lawr-t">
          {fatal > 0 && <span className="lawg-fatal" title={`涉及死亡災害 ${fatal} 筆`}>⚠ {fatal}</span>}
          {pending > 0 && <span className="lawg-pending" title={`尚未確定 ${pending} 筆`}>救濟 {pending}</span>}
        </td>
        <td className="lawr-x">
          <button
            className="linkish"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "收合" : `展開 ${vs.length}`}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="lawr-detail">
          <td colSpan={6}>
            <ul className="vio-list">
              {vs.map((v, i) => (
                <Violation key={`${v.doc_no}-${v.date}-${i}`} v={v} compact />
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * CSV 匯出。
 *
 * ⚠⚠ **Excel 的兩個地雷，兩個都要處理，不然台灣使用者一開就是亂碼或中毒：**
 *
 * 一、**BOM。** 沒有 UTF-8 BOM 的話 Excel 會用系統預設編碼開啟，
 *   中文全部變亂碼。這不是 Excel 的 bug 是它的預設行為，要自己加 \uFEFF。
 *
 * 二、**公式注入（CSV injection）。** 違法事實是來源機關的自由文字，
 *   我們不控制它的內容。一個以 = + - @ 開頭的儲存格，Excel 會當成公式執行。
 *   所以任何以這些字元開頭的欄位前面補一個單引號。
 *   ⚠ 這不是理論風險：我們把政府的原始文字原樣交給使用者的試算表。
 *
 * ⚠ 匯出的是**這家公司自己的紀錄**，不含「同名負責人其他公司」——
 *   把那些混進同一個檔案，等於在使用者的硬碟上做我們在畫面上拒絕做的合併。
 */
const CSV_HEAD = [
  "公告日期(民國)", "處分字號", "法規條項", "違法事實",
  "罰鍰(元)", "公告是否載明金額", "是否涉及死亡災害", "行政救濟",
  "危害分類", "白話標籤", "資料來源",
];

function csvCell(v: string | number): string {
  let t = String(v ?? "");
  // ⚠ 公式注入防線，不要因為「政府資料不會有」就拿掉。
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return '"' + t.replace(/"/g, '""') + '"';
}

function toCsv(vs: ViolationRef[]): string {
  const rows = vs.map((v) => [
    v.date,
    v.doc_no,
    v.law,
    v.content,
    v.fine > 0 ? v.fine : "",
    v.fine > 0 ? "是" : "否，公告未載金額",
    v.fatal ? "是（公告文字涉及，不等於該公司造成死亡）" : "否",
    v.appeal ?? "",
    (v.hazards ?? []).map((h) => h.name).join("、"),
    v.plain?.label ?? "",
    v.source_url,
  ].map(csvCell).join(","));
  // ⚠ 用 CRLF，Excel 對 LF-only 的處理在舊版會整欄擠成一列。
  return "\uFEFF" + [CSV_HEAD.map(csvCell).join(","), ...rows].join("\r\n") + "\r\n";
}

function downloadCsv(vs: ViolationRef[], company: string, covTo: string) {
  const blob = new Blob([toCsv(vs)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // ⚠ 檔名帶上資料涵蓋日：下載下來的檔案離開了網站，就沒有別的地方
  //   可以告訴使用者這份是什麼時候的資料了。
  // ⚠⚠ 一定要過濾檔名。covTo 是「115/08/31」，**斜線在 Windows 和 macOS
  //   都是非法檔名字元**；公司名也可能含其他保留字元，而來源資料我們不控制。
  //   瀏覽器各自有不同的替換行為，不要賭它會幫你處理。
  //   2026-09-18 實測 Chrome 產出的檔名就是「…涵蓋至115/08/31.csv」。
  // ⚠ 控制字元用 charCode 篩掉，不用 regex：
  //   /[\u0000-\u001f]/ 會被 eslint 的 no-control-regex 擋下來，
  //   而那條規則是對的 —— 控制字元寫在 regex 裡看不見、很難審。
  const safe = (t: string) =>
    [...t].filter((c) => c.charCodeAt(0) > 31).join("")
      .replace(/[\\/:*?"<>|]/g, "_")
      .trim();
  a.download = `職得調查_${safe(company)}_裁處紀錄_涵蓋至${safe(covTo) || "未標示"}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type SortKey = "law" | "n" | "year" | "fine";

/**
 * 可排序的表頭。
 *
 * ⚠ aria-sort 一定要給，而且三種值都要對（ascending / descending / none）——
 *   螢幕閱讀器是靠它報「已依筆數遞減排序」的，只把箭頭畫出來等於沒做。
 */
function SortTh({ k, label, num, sort, onSort }: {
  k: SortKey; label: string; num?: boolean;
  sort: { k: SortKey; desc: boolean }; onSort: (k: SortKey) => void;
}) {
  const active = sort.k === k;
  return (
    <th scope="col" className={num ? "num" : undefined}
        aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button className="th-sort" onClick={() => onSort(k)}>
        {label}
        <span className="th-arr" aria-hidden="true">{active ? (sort.desc ? "▼" : "▲") : "↕"}</span>
      </button>
    </th>
  );
}

function ViolationList({ vs, title, company }: {
  vs: ViolationRef[]; title: string; company: string;
}) {
  // 資料涵蓋到哪一天。⚠ getMeta() 內部 memoize 過，重複呼叫不會多打網路。
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => { void getMeta().then(setMeta); }, []);
  const covTo = meta?.coverage_to ?? "";
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: "n", desc: true });
  const onSort = (k: SortKey) =>
    setSort((s) => (s.k === k ? { k, desc: !s.desc } : { k, desc: true }));
  // ⚠ 註腳只在真的有「公告未載金額」的時候才出現。
  //   每一串都掛一句「0 元不是免罰」，看到第三次就沒有人在看了。
  const hasZeroFine = vs.some((v) => v.fine <= 0);
  const rec = useMemo(() => recency(vs, covTo), [vs, covTo]);
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
    // ⚠ 按鈕上的名稱跟長條圖用同一個（phrase），使用者才認得出是同一類。
    const lab = new Map<string, string>();
    for (const v of vs) for (const h of v.hazards ?? []) {
      cnt.set(h.name, (cnt.get(h.name) ?? 0) + 1);
      lab.set(h.name, h.phrase ?? h.name);
    }
    for (const [name, n] of [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      out.push({
        key: `h:${name}`, label: `${lab.get(name) ?? name} ${n}`,
        test: (v) => (v.hazards ?? []).some((h) => h.name === name),
      });
    }
    return out;
  }, [vs]);

  const active = facets.find((f) => f.key === facet) ?? facets[0];
  const filtered = useMemo(() => vs.filter(active.test), [vs, active]);

  // 依法條分組。⚠ 用原始的 law 字串當鍵，完全相同才算同一組 ——
  //   來源的法條寫法本來就不一致（有的寫「第32條第2項」、有的寫
  //   「第 32 條第 2 項」），模糊比對會把不同條文併在一起，那比不分組更糟。
  const { groups, rest } = useMemo(() => {
    const byLaw = new Map<string, ViolationRef[]>();
    for (const v of filtered) {
      const k = v.law || "";
      const cur = byLaw.get(k);
      if (cur) cur.push(v);
      else byLaw.set(k, [v]);
    }
    const g: [string, ViolationRef[]][] = [];
    const r: ViolationRef[] = [];
    for (const [k, list] of byLaw) {
      if (list.length >= GROUP_MIN) g.push([k, list]);
      else r.push(...list);
    }
    g.sort((a, b) => b[1].length - a[1].length);
    r.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return { groups: g, rest: r };
  }, [filtered]);

  const visible = long ? rest.slice(0, shown) : rest;
  // 表尾的 † 註解只在真的有「未載金額」時才出現。
  const anyUnlisted = groups.some(([, l]) => l.some((v) => v.fine <= 0));

  const sortedGroups = useMemo(() => {
    const key = (e: [string, ViolationRef[]]): string | number => {
      switch (sort.k) {
        case "law": return e[0];
        // 取最早的年份，不是最晚 —— 「從哪一年開始被罰」比「最後一次」有意義。
        case "year": return e[1].reduce((a, v) => {
          const y = rocYear(v.date);
          return y && (!a || y < a) ? y : a;
        }, "");
        case "fine": return e[1].reduce((a, v) => a + (v.fine > 0 ? v.fine : 0), 0);
        default: return e[1].length;
      }
    };
    const arr = [...groups];
    arr.sort((a, b) => {
      const x = key(a), y = key(b);
      const c = typeof x === "string"
        ? String(x).localeCompare(String(y), "zh-TW")
        : Number(x) - Number(y);
      return sort.desc ? -c : c;
    });
    return arr;
  }, [groups, sort]);

  return (
    <section className="block">
      <h2 className="block-h">{title}</h2>
      <p className="block-sub">
        {vs.length} 筆{yearSpan(vs) ? ` · ${yearSpan(vs)}` : ""}
        {/* ⚠⚠ 資料涵蓋到哪一天必須跟筆數放在一起。
            「255 筆」沒有日期就是一個沒有時效的斷言 —— 讀者無法分辨
            這是三週前還是三年前的資料。值本來就在 meta 裡，之前只用在
            年度圖的星號上，等於算了卻沒講。 */}
        {covTo && <> · 資料涵蓋至 <span className="num">{covTo}</span></>}
      </p>
      {/* ⚠ 單獨一行，不併進上面那串。上面那行講的是「涵蓋範圍」，
          這行講的是「時間重心」，兩個是不同的問題，併在一起會被讀過去。 */}
      {rec && (
        <p className="block-recent">
          最近一筆裁處{"\u3000"}<span className="num">{rec.last}</span>
          {rec.to > 0 && rec.n > 0 && (
            <>{"\u3000·\u3000"}近三個年度（民國 {rec.from}–{rec.to}）
              <span className="num"> {rec.n} </span>筆
              <span className="block-recent-s">
                {"\u3000"}佔全部的 {(rec.share * 100).toFixed(1)}%
              </span>
            </>
          )}
        </p>
      )}
      <p className="block-dl">
        <button className="linkish" onClick={() => downloadCsv(vs, company, covTo)}>
          下載這 {vs.length} 筆（CSV）
        </button>
      </p>

      {long && (
        <>
          {/* ⚠ 這裡原本是一份「民國 X 年 N 筆」的十列清單，佔 275 px。
              換成長條 + 點陣之後資訊更多、高度更低，而且回答的問題不一樣：
              清單回答「每年幾筆」（沒有人在意），長條回答「被罰的是什麼」、
              點陣回答「最近還在發生嗎」。 */}
          <PlainBars vs={vs} />
          <YearDots vs={vs} />

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

      {groups.length > 0 && (
        <>
          {/* ⚠ 真的用 <table>，不要用 div 排格子：這是表格資料，
              螢幕閱讀器要能逐欄報讀，法條那一欄是列標題（th scope="row"）。 */}
          <div className="lawg-wrap">
            <table className="lawg-tab">
              <caption className="sr-only">依法條分組的裁處摘要，依筆數由多到少排列</caption>
              <thead>
                <tr>
                  <SortTh k="law" label="法條" sort={sort} onSort={onSort} />
                  <SortTh k="n" label="筆數" num sort={sort} onSort={onSort} />
                  <SortTh k="year" label="年度（民國）" num sort={sort} onSort={onSort} />
                  <SortTh k="fine" label="罰鍰合計（元）" num sort={sort} onSort={onSort} />
                  <th scope="col">標記</th>
                  <th scope="col"><span className="sr-only">展開逐筆</span></th>
                </tr>
              </thead>
              <tbody>
                {sortedGroups.map(([law, list]) => (
                  <LawGroup key={law} law={law} vs={list} />
                ))}
              </tbody>
            </table>
          </div>
          {/* ⚠⚠ 依「罰鍰合計」排序會排出一個**看起來權威、實際上不完整**的
              順序：台電 19 組裡有 14 組的合計是不完整的。排序本身沒有錯，
              但它讓讀者以為第一列就是罰最多的那一組。
              所以只有在這個排序生效時才多印一句，把不完整的組數講出來。
              ⚠ 不要改成「乾脆不給排序」——使用者要排是合理的，
                我們的責任是讓他知道自己在排什麼。 */}
          {sort.k === "fine" && anyUnlisted && (
            <p className="fineprint lawg-foot lawg-warn">
              ⚠ 目前依「罰鍰合計」排序，但 {groups.filter(([, l]) => l.some((v) => v.fine <= 0)).length}
              /{groups.length} 組的合計並不完整（見各列的「N/M 筆有金額」）。
              這個順序是<b>已公告金額</b>的順序，不是實際罰鍰的順序。
            </p>
          )}
          {anyUnlisted && (
            <p className="fineprint lawg-foot">
              「N/M 筆有金額」是該法條有公告罰鍰金額的筆數／總筆數。
              合計只加得到有金額的那幾筆。<b>「公告未載金額」不等於免罰。</b>
            </p>
          )}
        </>
      )}

      {rest.length > 0 && (
        <>
          {groups.length > 0 && (
            <p className="kicker" style={{ margin: "16px 0 6px" }}>
              其餘 {rest.length} 筆（各法條少於 {GROUP_MIN} 筆，不分組）
            </p>
          )}
          <ul className="vio-list">
            {visible.map((v, i) => (
              <Violation key={`${v.doc_no}-${v.date}-${i}`} v={v} compact={long} />
            ))}
          </ul>
        </>
      )}

      {long && shown < rest.length && (
        <div className="more">
          <button
            className="sw-btn"
            style={{ background: "var(--sheet)", color: "var(--ink)" }}
            onClick={() => setShown(shown + PAGE * 4)}
          >
            再顯示 {Math.min(PAGE * 4, rest.length - shown)} 筆
          </button>
          <p className="kicker" style={{ margin: "9px 0 0" }}>
            已顯示 {visible.length} / {rest.length} 筆
            {active.key !== "all" ? `（${active.label}）` : ""}
          </p>
        </div>
      )}

      {/* ⚠ 2026-10-29：「你可以確認什麼」原本只在長清單（> 12 筆）的 PlainBars 裡出現，
          達廣商行這種 3 筆的小公司反而沒有 —— 而求職者最常查的正是小公司。 */}
      {!long && <ShortAsk vs={vs} />}

      {/* ⚠ 常駐的是「未載金額不等於免罰」；為什麼會沒有金額收起來。 */}
      {hasZeroFine && (
        <Caveat className="fineprint rule-top" label="為什麼會沒有金額？"
                lead={<>「公告未載金額」<b>不等於免罰</b>。</>}>
          部分縣市的公告不刊載罰鍰金額，臺北市的職業安全衛生法公告有
          16,536 筆屬於這種情形；金額請以原始裁處書為準。
        </Caveat>
      )}
    </section>
  );
}

const CRED_LABEL: Record<Credential["kind"], string> = {
  national: "國家職業安全衛生獎",
  star5: "推行職業安全衛生優良單位五星獎",
  toshms: "TOSHMS 職安衛管理系統驗證",
  perf: "職安衛管理系統績效審查",
};

/**
 * 顯示順序：得獎在前，驗證在後。
 *
 * 得獎少而且難得（全國一年幾十家），驗證多（光台積電就 26 張廠區證書）。
 * 照有效性排的話，使用者要滑過二十幾張證書才看得到得獎那一行。
 */
const CRED_ORDER: Credential["kind"][] = ["national", "star5", "toshms", "perf"];

/** 每一類先顯示幾筆。⚠ 台積電有 26 張 TOSHMS，全攤開會把整頁佔滿。 */
const CRED_PREVIEW = 2;

function credLine(c: Credential): string {
  // ⚠ 用陣列過濾再接，不要直接串 —— 績效審查的 detail 是空的，
  //   直接串會在行首留下一個全形空白。
  const span = c.valid_from && c.valid_to
    ? `有效期間 ${c.valid_from}–${c.valid_to}`
    : c.valid_to ? `有效至 ${c.valid_to}` : "";
  return [c.detail, span, c.active ? "" : "已到期"]
    .filter(Boolean).join("\u3000");
}

/**
 * 把單位名拆成「共同前綴」與「真正區別的部分」。
 *
 * ⚠ 台電 52 張驗證，每一筆都以「台灣電力股份有限公司」開頭 —— 10 個字
 *   重複 52 次，而真正有差別的「第二核能發電廠 / 台中供電區營運處」
 *   被推到最後面。整塊讀起來像一坨，原因就是六成的像素是同一串字。
 *
 * ⚠⚠ **只變暗，不刪除。** 單位全名是法定紀錄，複製貼上、螢幕閱讀器、
 *   Ctrl+F 都必須拿得到完整字串。前綴照樣在 DOM 裡，只是顏色降一階。
 *
 * ⚠ 只在「完全以公司全名開頭」時才拆。名稱不一樣的單位（例如子公司）
 *   整串照原樣顯示 —— 猜測式的拆字會把不同法人看成同一家的分支。
 */
function unitParts(unit: string, owner: string): [string, string] {
  if (owner && unit.startsWith(owner) && unit.length > owner.length) {
    return [owner, unit.slice(owner.length)];
  }
  return ["", unit];
}

function CredGroup({ kind, list, owner }: {
  kind: Credential["kind"]; list: Credential[]; owner: string;
}) {
  const [all, setAll] = useState(false);
  // 有效的排前面，同組內保持來源順序
  const sorted = [...list].sort((a, b) => Number(b.active) - Number(a.active));
  const shown = all ? sorted : sorted.slice(0, CRED_PREVIEW);
  const rest = sorted.length - shown.length;
  return (
    <div className="cred-group">
      {/* ⚠⚠ 階層曾經是**反的**：分類標題 12px/400/灰/等寬，底下的單位名
          13.5px/600/亮/襯線 —— 子項目比自己的標題還大聲，所以整塊讀起來
          沒有層次。分類標題現在是第 2 階（13px/700/亮），單位名降到
          第 3 階（13px/500）並且內縮 + 左側導引線。
          ⚠ 改任何一階的字級前，先確認四階的「級距」還在：
            16/700 → 13/700 → 13/500 → 11.5/400。 */}
      <div className="cred-kind">
        {CRED_LABEL[kind]}
        {sorted.length > 1 && <> <span className="cred-kind-n">{sorted.length} 項</span></>}
      </div>
      <ul className="cred-list">
        {shown.map((c, i) => {
          const [pre, tail] = unitParts(c.unit, owner);
          return (
            <li key={i} className={c.active ? undefined : "cred-dead"}>
              <span className="cred-unit">
                {pre && <span className="cred-pre">{pre}</span>}
                {tail}
              </span>
              {credLine(c) && <span className="cred-detail">{credLine(c)}</span>}
            </li>
          );
        })}
      </ul>
      <div className="cred-more">
        {rest > 0 && (
          <button className="linkish" onClick={() => setAll(true)}>
            展開其餘 {rest} 個單位
          </button>
        )}
        {all && sorted.length > CRED_PREVIEW && (
          <button className="linkish" onClick={() => setAll(false)}>收合</button>
        )}
      </div>
    </div>
  );
}

/** 西元 YYYYMMDD → 「民國 YYY/MM/DD」。⚠ 這裡換算，因為要跟其他日期並排比較。 */
function incDate(d: string): string {
  if (!/^\d{8}$/.test(d)) return d;
  const y = Number(d.slice(0, 4)) - 1911;
  return `民國 ${y}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
}

const INC_PREVIEW = 2;

/**
 * 重大職業災害。
 *
 * ⚠⚠ 三件事不可以搞錯，錯了就是誣指：
 *
 * 一、`casualties` 是**罹災人數**，含受傷。畫面上一個字都不能寫「死亡」。
 *
 * 二、`role` 分成事業單位與業主。業主是發包工地的人，罹災的勞工**不是他僱的**。
 *    把業主寫成「這家公司死了人」是把承攬商的事故算到定作人頭上。
 *    兩者都要顯示——業主的承攬管理責任正是職安法第 27 條在講的事——
 *    但必須寫清楚是哪一種身分。
 *
 * 三、`match === "name"` 代表這一筆是靠**名稱**對上的，不是統編。
 *    來源有 14.7% 的列沒有統編。靠名字對有可能對到同名的另一家公司，
 *    所以要標記出來讓使用者自己判斷。
 *
 * ⚠ 涵蓋範圍只有 2024-07 之後、約 500 筆。「沒有」不等於「沒發生過」，
 *   這句話一定要出現在畫面上。
 */
function Incidents({ list }: { list: Incident[] }) {
  const [all, setAll] = useState(false);
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, INC_PREVIEW);
  const rest = list.length - shown.length;
  const guessed = list.filter((x) => x.match === "name").length;
  return (
    <section className="side-block">
      <h2 className="side-h">重大職業災害</h2>
      <p className="side-p">
        來自勞動部重大職業災害公開網。
        ⚠ <b>只涵蓋 2024 年 7 月之後</b>，全國約 500 筆。
        這裡沒有紀錄，不代表這家公司沒發生過職災。
      </p>
      <ul className="inc-list">
        {shown.map((x, i) => (
          <li key={i} className={x.role === "owner" ? "inc-owner" : undefined}>
            <div className="inc-head">
              <span className="inc-date">{incDate(x.date)}</span>
              <span className="inc-type">{x.disaster}</span>
              <span className="inc-cas">罹災 {x.casualties} 人</span>
            </div>
            <div className="inc-role">
              {x.role === "owner"
                ? <>這家公司是<b>工程業主</b>（定作人）。
                    罹災勞工屬於{x.counterpart ? `「${x.counterpart}」` : "承攬廠商"}，
                    不是這家公司僱用的。</>
                : <>罹災勞工屬於<b>這家公司</b>。
                    {x.counterpart && x.counterpart !== "無"
                      && <>工程業主為「{x.counterpart}」。</>}</>}
            </div>
            {x.site && <div className="inc-site">場所{"\u3000"}{x.site}</div>}
            {x.project && <div className="inc-proj">工程{"\u3000"}{x.project}</div>}
            <div className="fineprint">
              {x.agency}
              {x.match === "name" && "　⚠ 這一筆是以名稱比對，非統一編號"}
            </div>
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <button className="linkish" onClick={() => setAll(true)}>
          再顯示 {rest} 筆
        </button>
      )}
      {all && list.length > INC_PREVIEW && (
        <button className="linkish" onClick={() => setAll(false)}>收合</button>
      )}
      {guessed > 0 && (
        <p className="fineprint" style={{ marginTop: 12 }}>
          其中 {guessed} 筆的來源沒有統一編號，只能以名稱比對；
          同名的另一家公司也會對上，請自行確認。
        </p>
      )}
    </section>
  );
}

/**
 * 得獎與驗證 —— 「職安履歷」的正面那一半。
 *
 * 只列違規的畫面看起來像在指控。把得獎與驗證放在同一頁，系統才是
 * 「呈現一家公司的職安紀錄」而不是「抓壞人」。
 *
 * ⚠⚠ `c.unit` 是來源的原始全名，**含廠區**（「…股份有限公司Fab8E廠」）。
 *   一定要原樣顯示。簡化成公司名，就是把一個廠區的證書講成整家公司的
 *   證書 —— 那是往有利的方向誤導，跟把 A 公司的違規掛到 B 公司同級。
 *   實測台積電有 26 張分屬不同廠區的證書，一張都不能合併成「台積電通過驗證」。
 *
 * ⚠ 到期的不藏起來，標示「已到期」。藏起來會讓人以為從來沒驗證過；
 *   當成有效則是背書。兩種都不對，所以照實寫。
 */
function Credentials({ list, owner }: { list: Credential[]; owner: string }) {
  // ⚠⚠ Hook 一定要在任何提前 return **之前**呼叫。
  //   2026-09-15 我把 useState 放在 `if (!list.length) return null` 後面，
  //   eslint 的 react-hooks/rules-of-hooks 當場擋下來。
  //   那不是龜毛：沒有得獎紀錄的公司會少呼叫一次 useState，
  //   React 用「呼叫順序」對應 state，順序一變就會把別的 state 讀成這個的。
  //   症狀是隨機的錯誤狀態，不會報錯 —— 跟我們踩過的快取錯位同一種病。
  const [open, setOpen] = useState(false);
  if (!list.length) return null;
  const groups = CRED_ORDER
    .map((k) => [k, list.filter((c) => c.kind === k)] as const)
    .filter(([, v]) => v.length > 0);
  const dead = list.filter((c) => !c.active).length;
  // ⚠ 2026-09-15 量到的：這一塊在手機上佔 802 px，比整份裁處清單還高，
  //   而它是「正面資訊」—— 求職者不會為了看獎項而來。
  //   預設收成一行摘要，想看再展開。**數量照樣寫在摘要上，不是藏起來。**
  const summary = groups
    .map(([k, v]) => `${CRED_LABEL[k]} ${v.length}`)
    .join("　");
  return (
    <section className="side-block">
      <h2 className="side-h">得獎與驗證</h2>
      <p className="cred-sum">{summary}</p>
      <button className="linkish" onClick={() => setOpen((v) => !v)}>
        {open ? "收合" : `展開 ${list.length} 項`}
      </button>
      {!open ? null : (
      <>
      <p className="side-p">
        資料來自勞動部公開的得獎與驗證名單。
        ⚠ <b>對象是下面寫的那個單位</b>——很多是廠區或分支，
        不代表整家公司的每個場所都通過。
      </p>
      {groups.map(([k, v]) => <CredGroup key={k} kind={k} list={v} owner={owner} />)}
      {dead > 0 && (
        <p className="fineprint" style={{ marginTop: 12 }}>
          其中 {dead} 項已到期，照實列出。
          ⚠ 有效與否一律依截止日期判定，<b>不採用來源的「目前狀態」欄</b>
          ——實測該欄位在已到期的項目上仍寫「通過」。
        </p>
      )}
      </>
      )}
    </section>
  );
}

/** 六類安衛人員。⚠ 順序＝畫面順序：專責人員在前，業務主管在後。 */
const STAFF: [keyof SafetyStaff, string][] = [
  ["mgr", "勞工安全衛生管理員"],
  ["safe", "勞工安全管理師"],
  ["health", "勞工衛生管理師"],
  ["a", "甲種業務主管"],
  ["b", "乙種業務主管"],
  ["c", "丙種業務主管"],
];

/** 只列出人數大於 0 的類別。⚠ 0 不要印出來 —— 「丙種 0 人」讀起來像缺點，
 *  但來源的 0 只代表這個場所不需要這個類別。 */
function staffText(s: SafetyStaff): string {
  return STAFF.filter(([k]) => s[k] > 0)
    .map(([k, label]) => `${label} ${s[k]}`)
    .join("\u3000");
}

/** 民國 YYYMMDD（1150901）→「115/09/01」。0 回空字串。 */
function rocDate(n: number): string {
  const t = String(n);
  return t.length === 7 ? `${t.slice(0, 3)}/${t.slice(3, 5)}/${t.slice(5, 7)}` : "";
}

/**
 * 安衛人員備查 —— 職安履歷裡**唯一的事前訊號**。
 *
 * 違規、職災、得獎、驗證講的都是已經發生的事。這一塊講的是
 * 「這家公司有沒有把職安法要求的安全衛生管理人員設上」。
 *
 * ⚠⚠ **絕對不可以有「無」這個狀態。**
 *   職安法只要求達到一定規模的事業單位設置安衛人員，小公司本來就不用設。
 *   一家公司沒有這一塊，可能是不需要設、可能是該設沒設、也可能是名冊
 *   沒收到或我們沒對上 —— 我們分不出是哪一種。所以 su 是 undefined 的時候
 *   整個區塊不渲染，不寫「未設置」、不寫「查無」、也不留一個空殼說明。
 *   把「不適用」呈現成「不合規」，是對具名公司的不實陳述，
 *   性質跟把 A 公司的違規掛到 B 公司身上一樣，只是方向相反。
 *
 * ⚠ `unit` 是來源原始全名，含分支與廠區（「…台中大墩分公司」）。
 *   原樣顯示。收斂成公司名，就是把一個分公司的一位業務主管
 *   講成整家公司的配置 —— 跟 Credentials 的廠區規矩同源。
 */
function SafetyUnitsBlock({ su }: { su?: SafetyUnits }) {
  // ⚠ Hook 一定要在提前 return 之前，見 Credentials 的說明。
  const [open, setOpen] = useState(false);
  if (!su) return null;
  const shown = su.sites.length;
  const rest = su.total - (su.self ? 1 : 0);
  return (
    <section className="side-block">
      <h2 className="side-h">安衛人員備查</h2>
      {su.self && (
        <p className="su-self">
          <b>公司本身</b>
          <span className="su-date num">{rocDate(su.self.filed)}</span>
          <span className="su-staff">{staffText(su.self)}</span>
        </p>
      )}
      {rest > 0 && (
        <>
          <p className="su-sum">
            另有 <b>{rest}</b> 個分支或廠區有備查紀錄
            {!su.self && "（名冊上沒有公司本身那一筆）"}
          </p>
          <button className="linkish" onClick={() => setOpen((v) => !v)}>
            {open ? "收合" : `展開${shown < rest ? ` ${shown} / ${rest}` : ""}`}
          </button>
        </>
      )}
      {open && (
        <ul className="su-list">
          {su.sites.map((x) => (
            <li key={x.unit + x.filed}>
              <span className="su-unit">{x.unit}</span>
              <span className="su-date num">{rocDate(x.filed)}</span>
              <span className="su-staff">{staffText(x)}</span>
            </li>
          ))}
          {shown < rest && (
            <li className="fineprint">
              只顯示最近報備的 {shown} 個，這家公司共有 {su.total} 個場所的紀錄。
            </li>
          )}
        </ul>
      )}
      {/* ⚠ 常駐的是「沒有紀錄不代表沒設置」—— 不看那一句，
          這一整塊就會被讀成「有的公司有、沒有的公司沒設」。
          收起來的是出處與法規門檻。 */}
      <div style={{ marginTop: 10 }}>
        <Caveat className="side-p" label="這份名冊是什麼？"
                lead={<>⚠ 這份名冊<b>只記錄有報備的單位</b>，
                  沒有紀錄的公司多數是依法不需要設置。</>}>
          資料來自勞動部職業安全衛生署「安衛單位(人員)備查名冊」，記錄的是
          事業單位依職業安全衛生法<b>向勞動檢查機構報備</b>的安衛人員。
          職安法僅要求達到一定規模的事業單位設置安全衛生管理人員，
          所以「沒有出現在名冊上」有三種可能（依法不需要設、該設沒設、
          名冊未收錄），本系統分不出是哪一種。
        </Caveat>
      </div>
    </section>
  );
}

/**
 * 一眼區：左邊「主管機關裁處」、右邊「主管機關核發」。
 *
 * ══════════════════════════════════════════════════════════════
 * ⚠⚠ 左右分欄**不是我們在評價**
 * ══════════════════════════════════════════════════════════════
 * 五星獎是勞動部頒的、TOSHMS 是勞動部核發的、裁處是勞動部開的 ——
 * 好壞是**來源本身就分好的**，我們只是照實反映。
 *
 * 舊版把兩邊做成一樣的灰色、一樣的字級，而且把得獎驗證收合成右下角
 * 一行小字。那不是中立，是把一半的資訊藏起來。中立是兩邊一樣顯眼。
 *
 * ⚠ 但**嚴重度**仍然不分色。哪一筆裁處比較嚴重是我們的判斷，那條紅線不動。
 *   紅色只用在「涉及死亡災害」，沒有擴散。
 *
 * ══════════════════════════════════════════════════════════════
 * ⚠⚠ 兩個數字不能相減，理由是「對象不同」
 * ══════════════════════════════════════════════════════════════
 * 實測台電：56 項得獎與驗證，屬於「台灣電力股份有限公司」本身的是 **0 項** ——
 * 全部掛在協和發電廠、台中供電區營運處這些場所上，分屬 52 個單位。
 * 裁處卻是開給公司的。
 *
 * 所以把一個大大的 56 放在公司名旁邊而不說明，讀起來就是
 * 「這家公司有 56 張證書」，那是**往有利方向誤導**，
 * 跟把甲公司的違規掛到乙公司身上同級，只是方向相反。
 * `selfCount === 0` 時一定要把那句話印出來。
 *
 * ══════════════════════════════════════════════════════════════
 * ⚠ 沒有紀錄就整格不渲染，不要印「0」
 * ══════════════════════════════════════════════════════════════
 * 全站 176,268 家裡，有得獎或驗證的只有 396 家、有安衛備查的 8,183 家 ——
 * **95.3% 的公司右邊這一格是不存在的。**
 * 多數公司從來沒申請過 TOSHMS，印「0 張驗證」會讀成「沒通過驗證」，
 * 那是把「沒申請」說成「沒通過」。跟安衛備查同一條規矩。
 */
function Ledger({ hit, pending, allWeak }: {
  hit: LookupResult; pending: number; allWeak: boolean;
}) {
  const cr = hit.company.credentials ?? [];
  const su = hit.company.safety;
  const verify = cr.filter((c) => c.kind === "toshms" || c.kind === "perf");
  const award = cr.filter((c) => c.kind === "star5" || c.kind === "national");
  const live = verify.filter((c) => c.active).length;
  const units = new Set(cr.map((c) => c.unit));
  // ⚠ 用完整名稱嚴格比對。寧可少說「公司本身也有」，不要多說。
  const selfCount = cr.filter((c) => c.unit === hit.company.name).length;
  const hasGrant = cr.length > 0 || !!su;

  const own = hit.summary.own_violation_count;
  const fatal = hit.summary.fatal_count ?? 0;
  const linked = hit.summary.linked_violation_count;
  // ⚠⚠ 2026-09-15 外部檢視抓到一個**自相矛盾**：國城營造上面寫
  //   「公告涉及死亡災害 0」，往下捲卻有一筆重大職災罹災 1 人。
  //   我們知道原因（一個是裁處公告的文字判讀、一個是重大職災公開網），
  //   但**使用者不知道，他看到的就是這個網站在打自己臉**。
  //   解法不是藏起來，是把兩個都寫出來並標明出處 —— 所以這一行不能省。
  const incidents = hit.company.incidents?.length ?? 0;
  const span = yearSpan(hit.company.own_violations);
  // ⚠⚠ 涵蓋率缺口要講在大字旁邊，不能只寫在下面的法條表裡。
  //   實測台電 255 筆有 69% 沒有公告罰鍰金額。讀者看到「255 筆」會預期
  //   查得到金額；查不到這件事該在這裡就知道，不是捲到一半才發現。
  //   ⚠ 措辭不可以寫成「只罰了 N 元」——沒有金額不等於沒有罰，是公告沒刊。
  const noFine = hit.company.own_violations.filter((v) => v.fine <= 0).length;

  // 一行一項，用 block span 不用 <br />：少一項就少一行，不會留下空行。
  const penNotes: ReactNode[] = [];
  if (fatal > 0) penNotes.push(<><span className="ltag f">⚠ {fatal} 筆</span>公告文字涉及死亡災害</>);
  if (pending > 0) penNotes.push(<><span className="ltag p">{pending} 筆</span>行政救濟中，尚未確定</>);
  if (noFine > 0) penNotes.push(<><span className="ltag q">{noFine} 筆</span>公告未載罰鍰金額</>);

  return (
    <section className="ledger">
      <div className={hasGrant ? "ledger-pair" : "ledger-pair one"}>
        <div className="lbox pen">
          <p className="lbox-h">主管機關裁處</p>
          <p className="lbox-n num">{own}<small>筆</small></p>
          <p className="lbox-s">
            {span && <span className="lline">{span}累計</span>}
            {penNotes.map((n, i) => <span className="lline" key={i}>{n}</span>)}
          </p>
        </div>

        {hasGrant && (
          <div className="lbox grant">
            {/* ⚠ 標題不能只寫「核發」——安衛人員備查是**事業單位報備、
                檢查機構備查**，不是主管機關核發的東西。混在一起寫，
                等於把「我報了」講成「政府發給我」。 */}
            <p className="lbox-h">
              {cr.length > 0 ? "得獎、驗證與備查" : "依法報備"}
            </p>
            {cr.length > 0 ? (
              <>
                <p className="lbox-n num">{cr.length}<small>項</small></p>
                <p className="lbox-s">
                  分屬 <b>{units.size}</b> 個場所
                  {selfCount === 0 && "（公司本身沒有紀錄）"}<br />
                  {verify.length > 0 && (
                    <><span className="ltag g">{live} 張</span>
                      驗證仍在有效期內
                      {verify.length - live > 0 && `，${verify.length - live} 張已到期`}<br /></>
                  )}
                  {award.length > 0 && (
                    <><span className="ltag g">{award.length} 次</span>得獎紀錄，無有效期<br /></>
                  )}
                  {su && <>另有 <b>{su.total}</b> 個場所有安衛人員備查</>}
                </p>
              </>
            ) : (
              /* ⚠ 只有安衛備查的時候，數字**只能印一次**。
                 2026-09-17 第一版大字印 444、底下又寫「另有 444 個場所」，
                 同一個數字講兩次，而且沒有前文卻寫「另有」。 */
              <>
                <p className="lbox-n num">{su?.total ?? 0}<small>個場所</small></p>
                <p className="lbox-s">
                  有安衛人員備查<br />
                  {su?.self
                    ? "公司本身也有一筆"
                    : "名冊上沒有公司本身那一筆"}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {/* ⚠ 這一句是這一區最重要的一行，不可以因為版面擠就拿掉。 */}
      {cr.length > 0 && selfCount === 0 && (
        <p className="ledger-note">
          <b>⚠ 兩邊的對象不一樣。</b>
          裁處是開給「{hit.company.name}」的；得獎與驗證發給的是名單上寫的
          各個廠區或分支單位，公司本身一項都沒有。兩個數字不能相減。
        </p>
      )}

      <p className="ledger-nil">
        {incidents > 0
          ? <>重大職業災害公開網有 <b>{incidents}</b> 筆紀錄</>
          : "重大職業災害公開網沒有這家公司的紀錄"}
        {"・"}
        {linked > 0
          ? <>{allWeak ? "同名者" : "負責人"}的其他公司被罰過 <b>{linked}</b> 筆
            {allWeak && "（僅姓名相同，無其他佐證）"}</>
          : (hit.successors?.length ?? 0) > 0
            ? <>負責人姓名未出現在其他公司的裁處紀錄上；但商工登記上有{" "}
                <b>{hit.successors?.length}</b> 家之後設立的公司，代表人姓名相符（見下方）</>
            : "負責人姓名未出現在其他公司的公開紀錄上"}
      </p>
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════
   查詢結果
   ══════════════════════════════════════════════════════════════ */
function Result({ hit, onPick, meta }: {
  hit: LookupResult; onPick: (n: string) => void; meta?: Meta | null;
}) {
  const ex = useExtra();
  const linkedAll = hit.principals.flatMap((p) => p.linked_companies);
  const pendingCount = [
    ...hit.company.own_violations,
    ...linkedAll.flatMap((c) => c.violations),
  ].filter(isPending).length;

  // ⚠⚠ 當**所有**連結都只有姓名相同的時候，那個數字本身就是暗示。
  //   實測「大裕機電股份有限公司」：本身 1 筆，而「同名負責人其他公司」
  //   顯示 9 筆 —— 那 9 筆來自 5 個很可能完全無關的同名者。
  //   數字照給（我們不替使用者刪資料），但標籤要把話講完。
  const allWeak = linkedAll.length > 0 && hit.summary.max_independent === 0;
  const after = hit.successors ?? [];
  const nameLinked = linkedAll.length > 0 || after.length > 0;

  // ⚠ 標籤一律用口語。「行政救濟尚未終結」對求職者是完全陌生的詞，
  //   而它的意思其實很簡單：這筆處分還沒定案。
  //   2026-09-17：原本的五格（其中兩格常常是 0，卻佔跟 255 一樣大的位置）
  //   換成 <Ledger>，理由寫在該元件的說明裡。

  // 登記地址所在的鄉鎮市區。⚠ 算一次就好，JSX 裡不要重複呼叫。
  const dist = districtOf(hit.company.address);

  /**
   * 這家公司有沒有職安法的裁處。
   *
   * ⚠⚠ 決定連結**怎麼寫**，不只是帶不帶參數。
   *   職安地圖的點位檔只收「有職安法裁處且登記地址定位得出來」的
   *   23,815 家，站上共 176,268 家。沒有職安法裁處的公司一定不在裡面 ——
   *   對這些公司寫「看它在地圖上的位置」就是開一張兌現不了的支票。
   *
   * ⚠ 用法條字串判斷，不要用 hazards 是否為空。
   *   hazards 空陣列的意思是「公告文字未指明危害型態」，
   *   那仍然是一筆職安法裁處，只是沒分類到。
   * ⚠ 反過來不成立：有職安法裁處也可能因為地址定不出座標而不在點位檔裡，
   *   那種情形由地圖頁自己講明並退回鄉鎮市區。
   */
  const hasOsha = hit.company.own_violations.some((v) => v.law.includes("職業安全衛生"));
  return (
    <div className="res">
      <header className="res-head">
        <div className="kicker" style={{ marginBottom: 10 }}>查詢結果</div>
        <h1 className="res-title">{hit.company.name}</h1>
        {/* ⚠ 改名（tools/rename_seed.tsv）。勞動部公告用舊名、商工登記只剩新名，
            不講清楚的話，使用者拿新名去查會以為「0 筆」，拿舊名查會以為「這家已經不在了」。 */}
        {hit.via_rename ? (
          <p className="rn-line">
            你查的「{hit.via_rename}」改名前叫<b>{hit.company.name}</b>；勞動部公告用的是舊名。
          </p>
        ) : hit.company.renamed_to ? (
          <p className="rn-line">現名 <b>{hit.company.renamed_to}</b></p>
        ) : null}
        {hit.company.former_names?.map((old) => (
          <p className="rn-line" key={old}>
            舊名{" "}
            <a href={qHref(old)} onClick={(e) => {
              if (plainClick(e)) { e.preventDefault(); onPick(old); }
            }}>{old}</a> 另有裁處紀錄 →
          </p>
        ))}
        <dl className="fields">
          {hit.company.tax_id && (
            <Field label="統一編號"><span className="num">{hit.company.tax_id}</span></Field>
          )}
          <Field label="登記現況">
            <span style={{ color: "var(--ink-2)" }}>
              {hit.company.status || "登記狀態不明"}
              {hit.company.established ? ` · ${estLabel(hit.company.established)}` : ""}
            </span>
            {" "}<TaxBadge tax={hit.company.tax_status} status={hit.company.status}
              date={meta?.taxreg_date} />
          </Field>
          {hit.company.address && (
            <Field label="登記地址">
              <span style={{ color: "var(--ink-2)" }}>{hit.company.address}</span>
              {/* ⚠ 查詢頁與職安地圖原本完全沒有互連 —— 兩頁各自獨立，
                  而整合性正是這個系統宣稱的特色之一。這個連結補上那個缺口。
                  ⚠ 措辭是「這一區的密度」不是「這家公司的位置」：
                  地圖畫的是鄉鎮市區聚合，不是單一公司的點。 */}
              {dist && (
                <a
                  className="to-map"
                  href={
                    `/osha?d=${encodeURIComponent(dist)}` +
                    (hasOsha ? `&c=${encodeURIComponent(hit.company.name)}` : "")
                  }
                >
                  {hasOsha ? "在職安地圖上看它的位置" : `看 ${dist} 的職安裁處密度`} →
                </a>
              )}
            </Field>
          )}
        </dl>
        <Elsewhere name={hit.company.name} taxId={hit.company.tax_id} />
        {hit.company.listed && <ListedPills l={hit.company.listed} ex={ex} />}
        {hit.company.quota && <QuotaCard q={hit.company.quota} ex={ex} />}
      </header>

      {/* ⚠⚠ res-side-top 與 res-haz 必須包在同一個 grid 格子裡。
          2026-09-18 之前它們是兩個獨立格子，跟左欄共用列 —— 第 1 列的高度
          被右欄的 558px 撐開，而左欄的 res-head 只有 166px，
          於是左欄從標題到清單之間出現 **392px 的純黑空白**，
          就在整頁最值錢的位置。包起來之後右欄自己流，不再撐列高。
          ⚠ 包起來也順便修好手機的順序：紅線警語與 Ledger 在清單之前。 */}
      <div className="res-side">
        <div className="res-side-top">
          {/* 這句話是紅線，不能拿掉也不能縮成註腳。
              ⚠ 2026-10-29：只在畫面上**真的有**以姓名連起來的公司時出現。
                沒有任何連結的頁面（統一超商）頂端也掛著這句，變成每頁都有的雜訊，
                使用者學會跳過它 —— 到了真正需要它的那一頁就沒人讀了。 */}
          {nameLinked && <div className="band">
            <p>姓名相同不等於同一人。</p>
            <p>
              公開資料沒有身分證字號。本系統不判定身分，
              只呈現這個連結有多少獨立佐證；判斷請自行進一步查證。
            </p>
          </div>}
          <Ledger hit={hit} pending={pendingCount} allWeak={allWeak} />
        </div>
        <div className="res-haz">
          <Incidents list={hit.company.incidents ?? []} />
          <Credentials list={hit.company.credentials ?? []} owner={hit.company.name} />
          <SafetyUnitsBlock su={hit.company.safety} />
        </div>
      </div>

      <div className="res-main">
        {/* ⚠ 「未載金額不等於免罰」那句話現在寫在 ViolationList 裡面
            （只在真的有未載金額的時候出現），不再由呼叫端傳字串進來 ——
            同一句警語散在兩個地方，改一邊忘另一邊只是時間問題。
            ⚠ 這個註解必須放在三元運算式**外面**：JSX 註解本身是一個
            表達式，塞在 `cond ? ( ... )` 的括號裡就是兩個表達式，
            2026-09-18 就是這樣噴 "Parsing error: ')' expected"。 */}
        <BranchHint name={hit.company.name} onPick={onPick} />

        {hit.company.own_violations.length > 0 ? (
          <ViolationList
            vs={hit.company.own_violations}
            title="這家公司自己的紀錄"
            company={hit.company.name}
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
            <LinkedGroups list={p.linked_companies} onPick={onPick} />
          </section>
        ))}

        {/* ⚠⚠ zr.json 的反方向（見 lookup.ts successors）。
            ⚠ 第一句一定要先講「下面這家沒有裁處紀錄、上面的紀錄是本頁這家的」，
              跟查無頁的「前身」區塊是同一條規則，只是方向相反。 */}
        {after.length > 0 && (
          <section className="block">
            <h2 className="block-h">之後設立、負責人姓名相符的公司</h2>
            <p className="block-sub">
              <b>下面這家公司本身沒有裁處紀錄</b>，上面那些裁處是本頁這家公司的。
              列出來是因為它在商工登記的代表人姓名，與本頁這家公司在勞動部公告上的負責人相符；
              兩家在同一個縣市；而且它設立在本頁這家公司最後一次被裁處之後。
              本系統不判定是不是同一個人，也不推論原因。
            </p>
            {after.map((c, i) => <Linked key={`a-${c.name}-${i}`} c={c} onPick={onPick} />)}
          </section>
        )}

        {hit.principals.length === 0 && after.length === 0 && (
          <div className="band">
            <p>負責人的姓名沒有出現在其他公司的公開紀錄上。</p>
            <p>
              這代表<b>在本站涵蓋的公告範圍內</b>沒有找到同名的其他事業單位，
              不代表這個人名下沒有別的公司 ——
              沒有被裁處的公司不會出現在勞動部的公告裡。
            </p>
          </div>
        )}

        <Recourse />
      </div>


      <footer className="res-foot">
        {/* ⚠ 這一行要跟畫面上實際呈現的東西一致。
            2026-09-17 加進安衛人員備查之後才發現它只寫了裁處與商工登記兩份，
            但同一頁上早就有得獎、驗證、重大職災 —— 少報資料來源，
            在一個以「資料使用度」為賣點的系統上特別難看。
            新增任何一個資料來源，這一行要一起改（或者乾脆只指向關於資料頁）。 */}
        <p className="fineprint">
          資料來源：勞動部及其所屬機關開放資料 16 筆、經濟部商工登記公示資料、財政部稅籍登記、上市櫃公司揭露。
          逐項名稱、串接率與已知缺口見 <a href="/about">關於資料</a>。
          本頁僅呈現主管機關已公告之裁處紀錄與其關聯，
          不對任何事業單位或個人作出評價或認定。
        </p>
      </footer>
    </div>
  );
}

/**
 * 同一家公司的分公司、廠區（或反過來：本頁是分支時的總公司）。
 *
 * ⚠⚠ 2026-10-29：查「台灣積體電路製造股份有限公司」只看到總公司 27 筆，
 *   「⋯先進封測五廠」3 筆、「⋯十八B廠」1 筆完全沒提。要去那個廠區面試的人
 *   最需要的就是那幾筆。
 * ⚠ 不合併筆數。分支在公告上是另一個事業單位，加在一起就是把 B 的紀錄算成 A 的。
 * ⚠ 主答案先出來，這一塊之後才補（多抓一片首字索引，不擋主畫面）。
 */
const BRANCH_PREVIEW = 8;
function BranchHint({ name, onPick }: { name: string; onPick: (n: string) => void }) {
  const [b, setB] = useState<Branches | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let alive = true;
    setB(null);
    setAll(false);
    void findBranches(unmask(name)).then((r) => { if (alive) setB(r); });
    return () => { alive = false; };
  }, [name]);
  if (!b || (!b.parent && b.names.length === 0)) return null;
  const list = all ? b.names : b.names.slice(0, BRANCH_PREVIEW);
  const link = (n: string) => (
    <a className="linked-go" href={qHref(maskQuery(n))}
       onClick={(e) => { if (plainClick(e)) { e.preventDefault(); onPick(n); } }}>
      {maskQuery(n)} →
    </a>
  );
  return (
    <div className="band branch">
      {b.parent && (
        <p>
          這是<b>分公司或廠區</b>的紀錄。總公司另有自己的裁處紀錄：{link(b.parent)}
        </p>
      )}
      {b.names.length > 0 && (
        <>
          <p>
            {b.parent ? "同一家公司另外還有 " : "這家公司另有 "}
            <b>{b.names.length}</b> 個分公司或廠區，有<b>自己的</b>裁處紀錄。
            分支在公告上是另一個事業單位，筆數分開算、不合併 ——
            你要去的如果是某個廠區或門市，請點那一個。
          </p>
          <ul className="branch-list">
            {list.map((n) => <li key={n}>{link(n)}</li>)}
          </ul>
          {b.names.length > BRANCH_PREVIEW && (
            <button className="linkish" onClick={() => setAll((v) => !v)}>
              {all ? "收合" : `再顯示 ${b.names.length - BRANCH_PREVIEW} 個`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Linked({ c, onPick }: { c: LinkedCompany; onPick?: (n: string) => void }) {
  const [all, setAll] = useState(false);
  const vs = all ? c.violations : c.violations.slice(0, LINKED_PREVIEW);
  return (
    <div className="linked">
      <div className="linked-main">
        {/* ⚠ 關聯公司要可以點進去。這是整站的核心賣點 ——
            使用者看到關聯公司的第一個反應就是想看那一家，
            2026-09-15 之前他必須自己複製名字回去重查。 */}
        {/* ⚠ 用 <a href> 而不是 <button>。網址已經有了，就該讓使用者
            中鍵／Ctrl+點擊開新分頁、右鍵複製連結 —— 比較好幾家候選公司
            的時候那是最自然的動作。onClick 攔下來走 SPA 導航，
            但**修飾鍵與中鍵放行**，交給瀏覽器處理。 */}
        <h3 className="linked-h">
          {onPick
            ? <a className="linked-go" href={qHref(c.name)}
                 onClick={(e) => { if (plainClick(e)) { e.preventDefault(); onPick(c.name); } }}>
                {c.name}<span className="linked-arrow"> →</span>
              </a>
            : c.name}
        </h3>
        <div className="linked-meta">
          {c.tax_id && <span className="num">統編 {c.tax_id}</span>}
          <span>{c.status || "登記狀態不明"}</span>
          <span className="num">裁處 {c.violations.length} 筆</span>
          {/* ⚠ 關聯公司也要查身障未足額公告（使用者要求「包含去連結之前的公司」）。 */}
          {c.quota && c.quota.p.length > 0 && (
            <span className="dq-tag" title={`勞動部公告身障定額進用未足額，最近一次 ${c.quota.p[0]?.[0] ?? ""}`}>
              身障未足額公告 <b className="num">{c.quota.p.length}</b> 期
            </span>
          )}
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
      {/* 證據強度。⚠ 沒有分數，理由見檔頭與 contracts.ts 的 independent。
          ⚠⚠ 兩組一定要分開列。2026-09-15 外部檢視戳到的矛盾就是：
             標題寫「兩項獨立佐證」，底下卻列了四條，而使用者沒辦法知道
             哪兩條算數。姓名相同與姓名罕見講的是同一件事，
             它們是**這個姓名有多罕見**，不是第二個線索。 */}
      <div className="linked-ev">
        <p className="kicker" style={{ margin: "0 0 5px" }}>證據強度</p>
        <p className="linked-ev-h">{strengthLabel(c)}</p>
        {independentEv(c).length > 0 && (
          <>
            <p className="ev-group">獨立佐證</p>
            <ul className="linked-ev-list">
              {independentEv(c).map((e, i) => <li key={i}>{e.detail}</li>)}
            </ul>
          </>
        )}
        <p className="ev-group">姓名訊號<span className="ev-note">（不計入獨立佐證）</span></p>
        <ul className="linked-ev-list ev-weak">
          {nameEv(c).map((e, i) => <li key={i}>{e.detail}</li>)}
        </ul>
        <SuccessionBox c={c} />
      </div>
    </div>
  );
}

/**
 * 一個負責人名下的連結，分成兩組顯示。
 *
 * ⚠⚠ 為什麼要分組：2026-09-15 的外部檢視抽樣了 945 個連結對，
 *   **56%（527 個）除了「姓名相同」之外沒有任何佐證**，
 *   只有 4.7% 有姓名以外的獨立佐證。
 *
 *   我們的立場是「不判定身分，只呈現有多少佐證」。但把零佐證的連結
 *   跟有獨立佐證的連結**並排列在一起**，呈現本身就變成一種暗示 ——
 *   使用者看到的是「這個負責人名下有 12 家公司」，而不是
 *   「有 1 家有實際佐證，另外 11 家只是名字一樣」。
 *
 *   所以：有獨立佐證的照常列；只有姓名相同的另外一組、預設收合、
 *   標題就寫清楚它是什麼。**不是藏起來** —— 藏起來等於替使用者
 *   決定那些不值得看，而且筆數照樣講出來。
 */
function LinkedGroups({ list, onPick }: {
  list: LinkedCompany[]; onPick: (n: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const sorted = [...list].sort((a, b) => b.independent - a.independent);
  const strong = sorted.filter((c) => c.independent > 0);
  const weak = sorted.filter((c) => c.independent === 0);
  return (
    <>
      {strong.map((c, i) => <Linked key={`s-${c.tax_id}-${i}`} c={c} onPick={onPick} />)}
      {weak.length > 0 && (
        <div className="weak-group">
          {/* ⚠ 沒有前一組的時候不能寫「另外」。實測「大裕機電股份有限公司」
              五條連結全是零佐證，畫面會變成「另外 5 家…」而上面什麼都沒有。 */}
          <p className="weak-h">
            {strong.length > 0 ? "另外 " : "這 "}<b>{weak.length}</b> 家公司的負責人
            <b>姓名相同</b>，但除了姓名之外<b>沒有其他佐證</b>。
          </p>
          <p className="weak-p">
            同名在台灣很常見 —— 「陳志明」這個姓名在全國就出現在 467 家公司上，
            那是 467 個不同的人。這一組<b>很可能與這家公司無關</b>，
            列出來只是因為我們不替你做判斷。
          </p>
          <button className="linkish" onClick={() => setOpen((v) => !v)}>
            {open ? "收合這 " + weak.length + " 家" : `還是要看這 ${weak.length} 家`}
          </button>
          {open && weak.map((c, i) => (
            <Linked key={`w-${c.tax_id}-${i}`} c={c} onPick={onPick} />))}
        </div>
      )}
      {strong.length === 0 && weak.length === 0 && null}
    </>
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
   * 查詢結果要有自己的網址。
   *
   * ⚠ 2026-09-15 外部檢視排第一的缺口：整站的網址永遠是 `/`，查完一家公司
   *   網址不變，所以**不能傳給朋友、不能加書籤、上一頁也回不去搜尋**。
   *   而求職者最自然的動作就是把某家公司丟進群組問「這家怎麼樣」。
   *
   * ⚠ 用 ?q= 而不是路徑（/c/統編），因為純靜態站沒有 rewrite，
   *   /c/xxx 會直接 404。query string 對 Cloudflare Pages 一定安全。
   *
   * ⚠⚠ 網址會帶著公司名。我們的 _headers 設了 `Referrer-Policy: no-referrer`，
   *   所以使用者點「查閱原始公告」跳到勞動部時，**不會把他查了誰洩漏出去**。
   *   那一行不能拿掉 —— 拿掉之後這個功能就變成把查詢紀錄送給第三方。
   */
  const readUrl = useCallback(() => {
    const p = new URLSearchParams(window.location.search).get("q") ?? "";
    return p.trim();
  }, []);

  /**
   * ⚠ 查詢是**按下 Enter 才送**，不是邊打邊查。
   *   分片是完整名稱的精確比對，打到一半的字串永遠查不到，
   *   邊打邊查只會讓畫面在「查無」和結果之間閃爍，
   *   而且每按一個鍵就抓一次分片。
   */
  const run = useCallback(async (name: string, push = true) => {
    // ⚠ demo 遮罩模式：畫面上點到的是遮罩後的名字，查詢前換回原名。
    const t = unmask(name.trim());
    if (!t) { setOutcome(null); setAsked(""); return; }
    if (push) {
      // ⚠ pushState 不是 replaceState —— 要讓「上一頁」回得到前一次查詢。
      const u = `${window.location.pathname}?q=${encodeURIComponent(t)}${DEMO ? "&demo=1" : ""}`;
      if (u !== window.location.pathname + window.location.search) {
        window.history.pushState({ q: t }, "", u);
      }
      // ⚠⚠ 換公司一定要捲回頂端。
      //   2026-09-15 外部檢視：從丞捷營造滾到 1,383px 點「丞潔機電」，
      //   新頁面停在 957px —— 使用者看到的是**另一家公司**的裁處清單中段，
      //   而他不知道自己換了公司。
      //   這個網站每一頁都在講「不要把 A 公司的紀錄看成 B 公司的」，
      //   而我們自己的換頁行為正在製造那件事。這是誤讀風險，不是體驗問題。
      window.scrollTo(0, 0);
    }
    setBusy(true);
    setAsked(maskQuery(t));
    // ⚠ demo 模式下查詢框也不能留著原名（例如有人直接打字送出）。
    if (DEMO) setQ(maskQuery(t));
    try {
      if (meta) {
        setOutcome(maskOutcome(await lookup(t)));
      } else {
        const r = DATA.results.find(
          (x) => x.query.includes(t) || x.company.name.includes(t)) ?? null;
        setOutcome(r ? { kind: "hit", result: r } : { kind: "miss" });
      }
    } finally {
      setBusy(false);
    }
  }, [meta]);

  // 開啟時若網址帶 q 就直接查；上一頁／下一頁也要跟著回到對應的結果。
  useEffect(() => {
    if (meta === undefined) return;          // 還在確認有沒有完整資料
    const t = readUrl();
    if (t) { setQ(maskQuery(t)); void run(t, false); }
    const onPop = () => {
      const s2 = readUrl();
      setQ(maskQuery(s2));
      if (s2) void run(s2, false);
      else { setOutcome(null); setAsked(""); }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  const hit = outcome?.kind === "hit" ? outcome.result : null;
  /**
   * 門面只在「網址沒有帶 q」的時候出現。
   *
   * ⚠⚠ `!readUrl()` 這一段是 2026-09-18 門面改版時補的，它修的是一個
   *   **本來就存在、只是以前看不出來**的洞：getMeta() 是一個帶
   *   `cache: "no-cache"` 的網路請求，在它回來之前 outcome 還是 null、
   *   busy 還是 false —— 也就是說 `/?q=公司名` 這種分享連結，
   *   會先顯示一次門面，等 meta 回來才跳進結果。
   *   以前門面只有一段文字，閃一下沒人發現；改成整條深色帶之後，
   *   那一閃就是實實在在的「卡門面」。
   *   ⚠ 這條規則是硬的：分享連結是這個站最重要的路徑之一，
   *     不可以卡門面。改這一行之前先想清楚。
   */
  const fresh = !outcome && !busy && !readUrl();

  /** 分頁標題跟著查詢走。⚠ 不然開了五個分頁分不出哪個是哪家公司。 */
  useEffect(() => {
    // ⚠ 舊名「求職安全雷達」漏在這裡三天（9/14 汰換，9/17 才發現）。
    //   分頁標題沒有人會主動去看，改名要 grep 全站。
    const base = "職得調查 · 查的是公司，看見的是人";
    document.title = hit ? `${hit.company.name}｜${base}`
      : asked ? `${asked}｜${base}` : base;
    return () => { document.title = base; };
  }, [hit, asked]);

  return (
    /* ⚠⚠ 首頁與結果頁是**同一個元件的兩個模式**，靠 `fresh` 切換，
       不是兩條路由。理由：`/?q=公司名` 這種分享連結必須直接進結果模式，
       中間不可以卡一個門面。2026-09-18 之前首頁只有 558px 的純文字，
       使用者的原話是「第一眼要能很清楚知道在幹嘛」。
       ⚠ 改這裡之前先確認 `/?q=…` 仍然跳過門面。 */
    <div className={fresh ? "page landing" : "page"}>
      {/* demo 遮罩模式的標示。⚠ 一定要顯示 —— 畫面上的 ○ 要有交代，
          評審才不會以為是資料壞掉，也不會以為這是一份手做的假畫面。 */}
      {DEMO && (
        <p className="demo-tag">
          去識別化示範：人名、公司名、地址、統一編號與處分字號已遮蔽；資料與運算皆為正式版本。
        </p>
      )}
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

      {/* ⚠⚠ .face 在**兩個模式都存在**，它包住門面與查詢表單。
          理由是查詢表單只能有一份：搬進 {fresh && …} 裡面的話，
          結果模式就得再寫一份，兩份遲早會長不一樣；而換一個位置
          render 會讓 <input> 重新掛載，手機上鍵盤會跳掉。
          只有 .landing 底下 CSS 才把它變成一條滿版的帶。 */}
      <div className="face">

      {fresh && (
        <div className="hero">
          {/* ⚠ 2026-09-18：標題從 <p className="hero-t"> 改成 <h1>，
              外面那層 .band 也拿掉了 —— 那條 3px 上緣線是結果頁的語彙，
              壓在門面帶上會多出一條跟誰都沒關係的線。
              ⚠ 附帶效果：tokens.css 的 `.band > p:first-child`（15px）
                從此咬不到標題，那個特異度陷阱消失了。但 home.css 的
                選擇器仍然寫成三段 `.landing .hero .hero-t` ——
                只要有人把 .band 加回來就會再輸一次，留著成本是零。 */}
          <h1 className="hero-t">查的是公司，看見的是人</h1>
            {/* ⚠ 2026-09-15 標語從「面試前，把老闆的名字查一遍」改成這一句。
                原本那句會讓人預期一個**輸入姓名的框** —— 我們沒有，
                而且刻意不做（開放人名查詢會讓這個工具從「查公司」
                變成「查人」，倫理量級不同）。

                文案承諾產品沒有的東西，跟「功能改了文案沒跟上」是同一種謊，
                只是方向相反。新的標語描述的是真實的機制：
                輸入的是公司，呈現的軸線是人。 */}
          <p className="hero-p">
            勞動部的違法紀錄<b>跟著公司走</b>。公司收掉重開，紀錄就留在舊公司。
          </p>

          {/* ⚠⚠ 這張圖講的是整個系統唯一難用文字說清楚的事：換殼。
              用**虛構**的甲乙公司，不用真實案例 —— 首頁是門面，
              在沒有人查詢過的情況下就在門面上點名一家真公司，
              跟我們整站在守的那條線不一致。
              ⚠ 圖裡自帶「姓名相同不等於同一人」。這張圖會被截圖進簡報和影片，
                警語跟著圖走，才不會在轉載時掉隊。
              ⚠ 用 HTML+CSS 不用 SVG：中文在 SVG 裡縮放會失控，
                而且 HTML 的文字螢幕閱讀器讀得到、可以被 Ctrl+F 找到。 */}
          <div className="dia" role="img"
               aria-label="示意圖：甲公司從民國 100 年到 114 年累積 12 筆裁處紀錄，之後解散；同一個負責人姓名在 115 年新設立乙公司，0 筆紀錄。姓名相同不等於同一人。">
            <div className="dia-row" aria-hidden="true">
              <div className="dia-box">
                <p className="dia-h">甲公司</p>
                <p className="dia-s">已解散</p>
                <p className="dia-n num">12</p>
                <p className="dia-s">筆裁處紀錄</p>
              </div>
              {/* 連線在兩張卡**中間**，不在下面 ——
                  「同一個負責人」是這張圖的主詞，不是註腳。 */}
              <div className="dia-mid"><i /></div>
              <div className="dia-box is-new">
                <p className="dia-h">乙公司</p>
                <p className="dia-s">今年新設立</p>
                <p className="dia-n num">0</p>
                <p className="dia-s">筆裁處紀錄</p>
              </div>
            </div>
            <p className="dia-cap" aria-hidden="true">同一個負責人姓名</p>
            {/* ⚠ 時間軸不是裝飾。沒有它，兩張卡只說得出「一家有一家沒有」，
                說不出先後 ——「紀錄留在舊公司」這句話就少了它的依據。
                ⚠ 年份跟甲乙公司一樣是**虛構**的示意年：
                  門面上不點名任何一家沒被查詢過的真公司。 */}
            <div className="dia-tl" aria-hidden="true">
              <div className="dia-tl-track">
                <span className="dia-tl-seg" />
                <span className="dia-tl-gap"><span>解散</span></span>
                <span className="dia-tl-seg is-new" />
              </div>
              <div className="dia-tl-marks">
                <div><span className="num">民國 100</span><span className="num">114</span></div>
                <div />
                <div><span className="num">115</span><span>今</span></div>
              </div>
            </div>
            <p className="dia-note" aria-hidden="true">
              ⚠ 姓名相同<b>不等於</b>同一人。本站不判定身分，
              只呈現這個連結有多少獨立佐證。
            </p>
            {/* ⚠⚠ 這四句是把上面那張圖用白話再講一次，給看不懂圖的人。
                第 2 句原稿是「這兩家公司，登記的負責人**是同一個人**」——
                那句話直接違反我們整站的紅線，而且它就印在
                「姓名相同不等於同一人」下面 40px 的地方，**自己打自己**。
                改成「負責人姓名相同」：陳述我們真的看得到的事實，
                不做身分認定。
                ⚠ 這一段 aria-hidden，因為整張 .dia 已經有完整的 aria-label，
                  不 hidden 的話螢幕閱讀器會把同一件事唸兩次。 */}
            <ol className="dia-narrate" aria-hidden="true">
              <li className="n1">
                <span className="dia-narrate-ic"><Ic k="megaphone" w={1.8} /></span>
                <span>甲公司在民國 100–114 年間，被公告裁罰 12 次</span>
              </li>
              <li className="n2">
                <span className="dia-narrate-ic"><Ic k="link" w={1.8} /></span>
                <span>兩家公司登記的<b>負責人姓名相同</b></span>
              </li>
              <li className="n3">
                <span className="dia-narrate-ic"><Ic k="plus" w={1.8} /></span>
                <span>乙公司今年才新設立，目前 0 筆紀錄</span>
              </li>
              <li className="n4">
                <span className="dia-narrate-ic"><Ic k="arrow" w={1.8} /></span>
                <span>甲公司先解散，乙公司才成立 —— 紀錄留在了舊公司</span>
              </li>
            </ol>
          </div>
        </div>
      )}

      <form
        className="search"
        onSubmit={(e) => { e.preventDefault(); void run(q); }}
      >
        <label className="kicker" htmlFor="q">公司完整名稱</label>
        {/* ⚠ 不要只靠 <form> 的隱含送出（implicit submission）。
            2026-09-15 外部檢視回報「按 Enter 沒反應」，我用兩種自動化
            都無法確定是網站的問題還是工具合成按鍵的問題 ——
            兩邊送進來的 keydown 都是 trusted 但不觸發 submit。

            結論是：這個問題不需要先查清楚。決賽評審會親手按 Enter，
            而顯式處理只要三行、沒有任何副作用。**與其確定，不如保證。** */}
        <input
          id="q"
          className="sw-input"
          // ⚠ type="search" + enterkeyhint 讓手機鍵盤的右下角變成「搜尋」。
          //   原本是預設的「換行」，使用者按了不會送出，只會關掉鍵盤。
          type="search"
          enterKeyHint="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          // ⚠ demo 遮罩模式：現場要「輸入公司名」，但一個字一個字打（尤其是注音選字視窗）
          //   會在投影幕上把真名完整打出來。所以 demo 時用貼上：攔下貼上事件，
          //   框裡只顯示遮罩後的名字，按 Enter 時再換回原名去查。非 demo 模式行為不變。
          onPaste={DEMO ? (e) => {
            const text = e.clipboardData.getData("text").trim();
            if (!text) return;
            e.preventDefault();
            setQ(maskQuery(text));
          } : undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!busy && q.trim()) void run(q);
            }
          }}
          placeholder="例：台積電、國城營造有限公司"
          autoComplete="off"
        />
        <button className="sw-btn" type="submit" disabled={busy || !q.trim()}>
          {busy ? "查詢中" : "查詢"}
        </button>
        {/* ⚠ 這句話原本寫「少一個字、用簡稱或商標名都查不到」。
            簡稱查詢與商工登記存在性索引上線之後它就不成立了，
            但它在首頁又擺了一天 —— 功能改了、文案沒跟上，
            是這個專案最容易累積的一種謊。改文案要跟功能同一筆 commit。 */}
        {fresh && (
          <p className="search-note">
            打完整的法定名稱最準。打簡稱（例如「台積電」）會列出候選讓你選。
          </p>
        )}
      </form>

      {fresh && (
        <>
          {/* ⚠⚠ 「怎麼用」刻意放在搜尋框**後面**，設計稿原本放前面。
              理由是量出來的：放前面時手機 375×812 上查詢鈕底緣在 y=1173，
              視窗只有 812 —— 要捲 1.4 屏才看得到搜尋框。
              這是查詢工具，搜尋框不能是捲下去才有的東西。
              放後面之後它仍然在第一次捲動就看得到，而且「先看到框、
              再看到三步驟」讀起來也通。 */}
          <ol className="howto">
            <li className="howto-step s1">
              <span className="howto-n"><Ic k="keyboard" w={1.8} /></span>
              <span className="howto-t">輸入公司名稱</span>
            </li>
            <li className="howto-arrow a1" aria-hidden="true">→</li>
            <li className="howto-step s2">
              <span className="howto-n"><Ic k="search" w={1.8} /></span>
              <span className="howto-t">查詢裁處紀錄</span>
            </li>
            <li className="howto-arrow a2" aria-hidden="true">→</li>
            <li className="howto-step s3">
              <span className="howto-n"><Ic k="doc" w={1.8} /></span>
              <span className="howto-t">看見完整歷史</span>
            </li>
          </ol>

          <section className="scenarios">
            <div className="kicker" style={{ marginBottom: 10 }}>適合這樣用</div>
            <ul className="scenario-list">
              <li className="scenario-item c1">
                <span className="scenario-ic"><Ic k="bag" w={1.8} /></span>
                <div>
                  <p className="scenario-h">投履歷、面試前</p>
                  <p className="scenario-p">先查這家公司過去有沒有公開的裁處紀錄</p>
                </div>
              </li>
              <li className="scenario-item c2">
                <span className="scenario-ic"><Ic k="clipboard" w={1.8} /></span>
                <div>
                  <p className="scenario-h">簽約、發包前</p>
                  <p className="scenario-p">看看往來廠商在公告裡出現過幾次</p>
                </div>
              </li>
              {/* ⚠ 原稿是「查查負責人**是不是同一個**」—— 我們不回答那個問題。
                  改成陳述我們真的會呈現的東西：同名的負責人出現在哪些公司。 */}
              <li className="scenario-item c3">
                <span className="scenario-ic"><Ic k="link" w={1.8} /></span>
                <div>
                  <p className="scenario-h">公司解散又重開</p>
                  <p className="scenario-p">看看同名的負責人，還出現在哪些公司的紀錄上</p>
                </div>
              </li>
            </ul>
          </section>
        </>
      )}

      </div>{/* /.face */}

      {/* 載入中：說清楚在下載什麼、多大、送不送出去。設計稿 A2。 */}
      {busy && (
        <div className="loading">
          <p className="loading-h">正在下載這家公司的資料分片</p>
          <p className="kicker">約 14 KB · 本站不記錄你查了誰</p>
          <div className="skels">
            <div className="skel" style={{ height: 22, width: "86%" }} />
            <div className="skel" style={{ height: 11, width: "54%" }} />
            <div className="skel" style={{ height: 11, width: "94%" }} />
            <div className="skel" style={{ height: 11, width: "88%" }} />
          </div>
        </div>
      )}

      {!busy && hit && <Result hit={hit} meta={meta} onPick={(n) => { setQ(n); void run(n); }} />}

      {/* 核心名對到多家：⚠ 絕對不能自己挑一家。
          挑錯就是把 A 公司的裁處紀錄顯示成 B 公司的，那是名譽損害。
          ⚠ 只列名稱不夠 —— 實測有兩家**名稱完全相同**的公司。
            統一編號與登記地址是使用者唯一分得出來的依據。 */}
      {!busy && outcome?.kind === "choose" && (
        <Choose outcome={outcome} asked={asked} onPick={(n) => { setQ(n); void run(n); }} />
      )}

      {!busy && outcome?.kind === "miss"
        && <Miss asked={asked} meta={meta} registry={outcome.registry}
                 also={outcome.also} before={outcome.before}
                 quota={outcome.quota} listed={outcome.listed}
                 taxQuery={outcome.taxQuery} tooShort={outcome.tooShort}
                 onPick={(n) => { setQ(n); void run(n); }} />}

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
        {outcome.reason === "variant" ? (
          <p>異體字不代表同一家公司（例如「恒」與「恆」可能是兩家），請確認後再點進去。</p>
        ) : outcome.reason === "alias" ? (
          /* ⚠ 對照表是本站整理的（AI 輔助、逐筆核對過商工登記），不是官方資料。 */
          <p>常見簡稱、品牌或英文名的對照（本站整理、已核對商工登記）。品牌的經營公司可能變動，請確認後再點進去。</p>
        ) : outcome.reason === "abbrev" ? (
          /* ⚠ 簡稱這條路跟「撞名」完全是兩件事，說法不能共用。
             實測「全聯」會列出「全國聯合工程有限公司」—— 因為全聯實業
             根本不在本站的資料裡（本站只收錄被裁處過的事業單位）。
             如果只寫「請選一家」，使用者會以為其中一家就是全聯。
             所以這裡要先講「你要找的那家如果沒有紀錄，它不會出現」。 */
          /* ⚠ 2026-10-29：原本寫「本站只收錄被裁處過的事業單位，你要找的公司如果沒有
             裁處紀錄，它不會出現在這份清單裡」——商工登記索引上線之後那句已經不對了。
             現在清單裡也會有「商工登記查得到、0 筆裁處」的公司（接字尾找到的）。 */
          <p>
            這些是名稱<b>字面上像</b>的事業單位，系統沒有替你決定是哪一家。
            「裁處紀錄 0 筆」的是在經濟部商工登記（或財政部稅籍）查得到、但勞動部公告裡沒有紀錄的公司。
            請看名稱全文、統一編號、登記地址或設立年，確認是你要找的那一家再點進去。
          </p>
        ) : cands.length === 1 ? (
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
            <a href={qHref(c.name)}
               onClick={(e) => { if (plainClick(e)) { e.preventDefault(); onPick(c.name); } }}>
              <div className="cand-name">{c.name}</div>
              {c.renamed_to && <div className="rn-line" style={{ margin: "2px 0 6px" }}>現名 <b>{c.renamed_to}</b></div>}
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
            </a>
          </li>
        ))}
      </ul>
      <p className="fineprint rule-top">
        分公司與本公司是不同的事業單位，裁處紀錄分開公告。兩邊都值得看。
      </p>
    </div>
  );
}

/** 西元年 → 「西元 1981 年」。⚠ 標示不換算，跟結果頁的 estLabel 一致。 */
/**
 * 財政部稅籍旗標（gcis/taxreg.py，每日更新、只收營業中）。
 *
 * ⚠⚠ 2026-10-29：商工登記快照是 9 月的，「青菜豐商行」快照寫核准設立、官方已經停業。
 *   稅籍沒列不代表一定歇業（也可能還沒辦稅籍、或名稱寫法不同），所以只講「沒列」，
 *   不講「已停業」，而且只在商工寫「核准設立」時才提醒 —— 已經寫解散的不用再補一刀。
 * ⚠ 使用者回饋「太多文字」：這裡只放一顆小標籤，說明放在 title 與「怎麼判斷的？」。
 */
function TaxBadge({ tax, status, date }: {
  tax?: "active" | "unlisted"; status: string; date?: string;
}) {
  if (status === "營業中") {
    // 商工快照裡查不到、整筆來自財政部稅籍（publish.py load_tax）。標出來源就好。
    return (
      <span className="txb ok" title={`商工登記快照裡查不到這家；統編、設立年與地址來自財政部營業（稅籍）登記${date ? `（${date}）` : ""}`}>
        財政部稅籍
      </span>
    );
  }
  if (tax === "active") {
    return (
      <span className="txb ok" title={`財政部營業（稅籍）登記${date ? `（${date}）` : ""}列為營業中`}>
        ✓ 稅籍營業中
      </span>
    );
  }
  if (tax === "unlisted" && status === "核准設立") {
    return (
      <span className="txb warn"
        title={`財政部營業（稅籍）登記${date ? `（${date}）` : ""}沒有列為營業中。商工登記快照可能已過時，請到商工登記確認最新現況。`}>
        稅籍未列營業中
      </span>
    );
  }
  return null;
}

function regEst(y: number): string {
  return y > 0 ? `設立 西元 ${y} 年` : "";
}

/**
 * 查無。
 *
 * ⚠⚠ 2026-09-15 的教訓：指導老師拿他合作的廠商
 *   「保吉生化學股份有限公司」來查，得到「查無」，結論是我們的搜尋不夠聰明。
 *   實際上他一個字都沒打錯 —— 那家公司在商工登記是核准設立、1981 年，
 *   而勞動部的裁處紀錄是 0 筆。
 *
 *   **那是關於他合作廠商的好消息，而這一頁把它講成了一次失敗**，
 *   而且第一句話就問他「名稱是完整的法定名稱嗎？」。
 *
 *   所以查無分成兩種，說法完全不同：
 *     registry 有值  這家公司在商工登記存在 → 講「沒有裁處紀錄」，
 *                    **不要**問他是不是打錯了
 *     registry 沒值  這個名稱在商工登記也查不到 → 這時候才輪到「可能打錯了」
 *
 * ⚠ 版面也一起改了。原本這一頁第一屏有兩百多字，把真正的答案埋掉。
 *   現在第一屏只留答案與一句最關鍵的警語，其餘收進「為什麼」。
 *   警語不是刪掉 —— 刪掉會變成我們在暗示「沒紀錄 = 安全」。
 */
function Miss({ asked, meta, registry, also, before, onPick, taxQuery, tooShort, quota, listed }: {
  quota?: QuotaHit;
  listed?: ListedHit;
  taxQuery?: string;
  tooShort?: boolean;
  asked: string;
  meta: Meta | null | undefined;
  registry?: RegistryHit;
  also?: Candidate[];
  before?: LinkedCompany[];
  onPick?: (name: string) => void;
}) {
  const [why, setWhy] = useState(false);
  const ex = useExtra();
  const closed = registry && registry.status !== "核准設立"
    && registry.status !== "核准停業" && registry.status !== "營業中"
    && registry.tax !== "active";
  if (taxQuery) {
    return (
      <div className="miss">
        <h1 className="res-title" style={{ fontSize: 22 }}>本站還不能用統一編號查詢</h1>
        <p className="miss-lead">請輸入公司名稱。要用統編 {taxQuery} 查登記資料，可以直接到商工登記：</p>
        <Elsewhere name={taxQuery} taxId={taxQuery} />
      </div>
    );
  }
  if (tooShort) {
    return (
      <div className="miss">
        <h1 className="res-title" style={{ fontSize: 22 }}>請至少輸入兩個字</h1>
      </div>
    );
  }
  return (
    <div className="miss">
      {registry || quota ? (
        <>
          <h1 className="res-title" style={{ fontSize: 22 }}>
            {asked}
          </h1>
          {/* ⚠⚠ 2026-10-29：使用者要的是「查過什麼、各得到什麼」，一眼看完。
              第一版是三列清單＋一大段條件說明，使用者回饋「太多文字」。
              改成三格：每格只有「查了什麼／結果／一行補充」，條件與限制收進「怎麼判斷的？」。
              ⚠ 負責人那一格不可以寫「沒有」——寫「未發現」，因為只抓得到姓名少見的情形。 */}
          <div className="ms-cards">
            {/* ⚠ 學校、醫院、財團法人這類單位不在商工登記，但會在身障未足額公告上（中原大學）。
                沒有登記資料時第一格改講公告。 */}
            {!registry && quota && (
              <div className="ms-card">
                <span className="ms-k">勞動部公告</span>
                <b>{quota.p.length ? "身障未足額" : "金展獎"}</b>
                <span className="ms-s">
                  {quota.p.length ? <><b className="num">{quota.p.length}</b> 期{quota.c ? `・${quota.c}` : ""}</>
                    : "進用身心障礙者績優"}
                </span>
              </div>
            )}
            {registry && (
            <div className="ms-card">
              {/* ⚠ 商工快照沒有、只在財政部稅籍查得到的（家福、統一星巴克…）標「財政部稅籍」，
                  不可以寫成「商工登記 查得到」—— 那是另一個機關的資料。 */}
              <span className="ms-k">{registry.taxOnly ? "財政部稅籍" : "商工登記"}</span>
              <b>查得到</b>
              <span className="ms-s">
                {registry.status && <span style={{ color: closed ? "var(--fatal)" : undefined }}>{registry.status}</span>}
                {regEst(registry.established) ? `・${regEst(registry.established).replace(/^設立 /, "")}設立` : ""}
                {!registry.taxOnly && (
                  <>{" "}<TaxBadge tax={registry.tax} status={registry.status} date={meta?.taxreg_date} /></>
                )}
              </span>
            </div>
            )}
            <div className="ms-card">
              <span className="ms-k">勞動部裁處</span>
              <b className="num">0 筆</b>
              <span className="ms-s">民國 100–115 年公告</span>
            </div>
            <div className="ms-card">
              <span className="ms-k">負責人關聯</span>
              {/* ⚠ 只在財政部稅籍查得到的，沒有負責人可以比 —— 寫「未發現」等於說查過了。 */}
              <b>{before && before.length > 0 ? `${before.length} 家`
                : !registry || registry.taxOnly ? "無法比對" : "未發現"}</b>
              <span className="ms-s">
                {before && before.length > 0 ? "已停業、被裁處過（見下方）"
                  : !registry ? "不在商工登記，沒有負責人資料"
                  : registry.taxOnly ? "稅籍資料沒有負責人欄位" : "已停業且被裁處過的公司"}
              </span>
            </div>
          </div>
          <Elsewhere name={asked} />
          {listed && <ListedPills l={listed} ex={ex} />}
          {quota && <QuotaCard q={quota} ex={ex} />}
          {/* ⚠ 2026-10-29：查「全聯」直接命中一家名稱就叫「全聯」的公司（0 筆），
              而大家要找的全聯實業（62 筆）只排在下面的「字面上像」。名稱很短時，
              把第一個有紀錄的候選拉到這裡一行。 */}
          {also && also.length > 0 && [...asked].length <= 4 && (
            <p className="maybe">
              也許你要找{"\u3000"}
              <a href={qHref(also[0].name)} onClick={(e) => {
                if (onPick && plainClick(e)) { e.preventDefault(); onPick(also[0].name); }
              }}>{also[0].name}</a>
              <span className="num">（{also[0].violation_count} 筆）</span>
            </p>
          )}
          {closed && (
            <div className="band" style={{ marginTop: 14 }}>
              <p>
                ⚠ 這個名稱目前的登記現況是<b>{registry.status}</b>。
                如果你是在應徵這家公司，請先確認實際的僱用單位是哪一家。
              </p>
            </div>
          )}
        </>
      ) : (
        <>
          <h1 className="res-title" style={{ fontSize: 22 }}>
            查無「{asked}」。
          </h1>
          <p className="miss-lead">
            這個名稱在<b>商工登記與勞動部公告裡都查不到</b>，
            所以很可能不是它的法定全名。
          </p>
          <ol className="checks" style={{ marginTop: 14 }}>
            <li>
              招牌名、品牌名、簡稱都查不到 ——
              營業登記上可能是「○○食品行」而不是你看到的店名。
            </li>
            <li>分公司與本公司分開公告，兩個名稱都要試。</li>
            <li>
              人力派遣的話，<b>勞動契約上的名稱</b>才是要查的那一個。
            </li>
          </ol>
        </>
      )}

      {/* ⚠ 這句話不可以收進展開裡。使用者只看第一屏就離開是常態，
          而「沒紀錄 ≠ 沒問題」是這一頁唯一不能漏掉的一句。 */}
      <p className="miss-caveat">
        沒有裁處紀錄<b>不等於</b>沒有問題。這一頁只能告訴你主管機關公告過什麼。
      </p>

      {/* ⚠⚠ 簡報第 3 頁那個情況：新公司在資料上是乾淨的，紀錄留在舊公司。
          這一塊是 tools/clean_successor.py 算出來的，只出現在「沒有裁處紀錄」這一頁。
          ⚠ 第一句一定要先講「上面這家公司本身沒有紀錄、下面是另一家」——
            否則使用者會把舊公司的裁處看成這一家的，那正是這個站一路在防的誤讀。
          ⚠ 措辭不用「換殼」「前身」這類推論，只陳述姓名、縣市與兩個日期。 */}
      {before && before.length > 0 && (
        <section className="block" style={{ marginTop: 22 }}>
          <h2 className="block-h">
            負責人姓名相符、已停業且被裁處過的公司
          </h2>
          <p className="block-sub">
            <b>上面這家公司本身沒有裁處紀錄。</b>下面是<b>另一家公司</b>，
            它的紀錄不是這家的。列出來是因為這家公司在商工登記的代表人姓名，
            與它在勞動部公告上的負責人相符；兩家在同一個縣市；而且這家設立在它最後一次被裁處之後。
            本系統不判定是不是同一個人，也不推論原因。
          </p>
          {before.map((c, i) => <Linked key={`b-${c.tax_id}-${i}`} c={c} onPick={onPick} />)}
        </section>
      )}

      {/* ⚠⚠ 「國城」逼出來的。商工登記裡真的有一家就叫「國城」（1993 年
          設立、已歇業），存在性索引先命中就直接回傳，走不到簡稱比對 ——
          而使用者要找的幾乎一定是「國城營造有限公司」，本站搜尋框的
          範例寫的就是那一家。

          ⚠ 但上面那個答案是**確定的事實**（這個名稱在商工登記查得到、
            沒有裁處紀錄），不可以被猜測取代。所以兩個並存：事實在上面，
            候選在下面，而且要講清楚「這些是另外幾家不同的公司」。
            這跟 Choose 的 abbrev 說法是同一條規則。 */}
      {also && also.length > 0 && (
        <div className="also">
          <p className="also-h">
            另外有 {also.length} 家<b>名稱字面上像</b>、而且有裁處紀錄的事業單位。
            它們是<b>不同的公司</b>，不是上面那一家的紀錄。
          </p>
          <ul className="also-list">
            {also.map((c, i) => (
              <li key={`${c.tax_id}-${i}`}>
                <a href={qHref(c.name)}
                   onClick={(e) => {
                     if (onPick && plainClick(e)) { e.preventDefault(); onPick(c.name); }
                   }}>{c.name}</a>
                <span className="also-meta">
                  {c.tax_id && <span className="num">{c.tax_id}</span>}
                  {c.address && <span>{c.address}</span>}
                  <span>{c.violation_count} 筆裁處</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button className="linkish" onClick={() => setWhy((v) => !v)}>
        {why ? "收合" : registry ? "怎麼判斷的？" : "為什麼？"}
      </button>
      {why && (
        <div className="block" style={{ marginTop: 10 }}>
          {registry && (
            <p style={{ marginBottom: 10 }}>
              <b>負責人關聯</b>：找的是商工登記代表人的遮罩姓名相同、全台少見、登記在同一縣市、
              已停業而且被裁處過的公司，並且這家設立在對方最後一次被裁處之後。
              商工登記只公開遮罩後的姓名，所以只抓得到姓名少見的情形 ——
              「未發現」不代表負責人沒有其他公司。
            </p>
          )}
          <p>
            沒有公告，可能是沒有違規，也可能是<b>沒被檢查</b>、還沒公告，
            或是該縣市的公告<b>已經下架</b>。
          </p>
          <p className="fineprint" style={{ marginTop: 10 }}>
            {meta
              ? `本站涵蓋 ${meta.companies.toLocaleString("zh-TW")} 家事業單位、`
                + `${meta.violations.toLocaleString("zh-TW")} 筆公告，`
                + `9 部法規、民國 100–115 年。`
              : "本站涵蓋 9 部法規、民國 100–115 年的公開裁處紀錄。"}
            {" "}各縣市公告保存期間不一；基隆市與新竹市政府自己的公告裡沒有職安法，
            登記在兩市的事業單位只會出現其他機關公告的職安法裁處。
          </p>
          <p className="fineprint" style={{ marginTop: 10 }}>
            商工登記資料來自經濟部商工登記公示資料查詢服務。
            要看統一編號、登記地址與完整的登記事項，請到該系統查詢。
          </p>
          {meta?.taxreg_date && (
            <p className="fineprint" style={{ marginTop: 6 }}>
              「稅籍營業中」來自財政部全國營業（稅籍）登記資料（{meta.taxreg_date}），每日更新、只收營業中的營業人。
              商工登記寫核准設立、稅籍卻沒有列的，商工資料可能已過時。
            </p>
          )}
        </div>
      )}

      {(registry || quota) && <Recourse />}
    </div>
  );
}

/**
 * 資料涵蓋範圍。
 *
 * ⚠⚠ 2026-09-15 外部檢視：「首頁在搜尋框下方還有四個數字加四段說明，
 *   那些是關於資料頁的內容，搬過去就好。」他說得對 —— 而那四段裡有一段
 *   是我前一天親手加的（63 萬筆的組成），加的時候只想著誠實，
 *   沒想過位置。**誠實的內容放錯地方，一樣會擋住使用者。**
 *
 * 現在首頁只留四個數字，四段說明全部搬到 /about。
 * 想知道細節的人點一下就到，不想知道的人不用滑過去。
 */
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
          <dd>部法規 · 民國 100–115 年</dd>
        </dl>
      )}
      {/* ⚠ 首頁的三個大數字沒有時間戳就是三個沒有時效的斷言。
          meta.coverage_to 本來就算好了，只是以前沒印出來。 */}
      {meta?.coverage_to && (
        <p className="cov-asof">
          裁處公告資料涵蓋至民國 <span className="num">{meta.coverage_to}</span>
        </p>
      )}
      {/* ⚠ 「非本站自行蒐集」是這一行的重點，不是裝飾。
          一個列出真實公司裁處紀錄的網站，最需要先講清楚的就是
          「這些不是我們認定的，是主管機關公告的」。
          ⚠ 用官方全名「違反勞動法令事業單位（雇主）查詢系統」，
            不要寫成「勞動部裁罰檢查系統」——那個系統不叫這個名字。
          ⚠ 商工登記是**經濟部**的，所以這裡寫「勞動部與經濟部」，
            不可以整句掛到勞動部頭上。 */}
      <p className="cov-trust">
        <span className="cov-trust-ic"><Ic k="bank" w={1.8} /></span>
        資料來自勞動部「違反勞動法令事業單位（雇主）查詢系統」等公開資料，
        與經濟部商工登記；非本站自行蒐集或調查。
      </p>
      <p className="cov-more">
        <a href="/about">資料來源、涵蓋範圍與已知缺口 →</a>
      </p>

      {/* ⚠⚠ 「不會做什麼」跟「會做什麼」一樣重要，而且要在**使用者查詢之前**
          就講完。查完之後才說「我們不評分」，他已經把數字讀成分數了。
          ⚠ 這三條跟結果頁上的紅線是同一組，改一邊一定要改另一邊。 */}
      <div className="pledge">
        <div className="pledge-col">
          <div className="pledge-hd">
            <span className="pledge-ic"><Ic k="check" w={2.2} /></span>
            <p className="pledge-h">這裡有什麼</p>
          </div>
          <ul>
            <li>9 部法規的<b>公開裁處公告</b>，逐筆附處分字號</li>
            <li>法條翻成人話，看得出被罰的是什麼事</li>
            <li>得獎、驗證、安衛人員備查，標明是<b>哪個場所</b>的</li>
          </ul>
        </div>
        <div className="pledge-col is-not">
          <div className="pledge-hd">
            {/* ⚠ 用「減號」不用「叉」。叉是錯誤／失敗的符號；
                這一欄講的是我們**選擇不做**的事，那是自我約束不是錯誤。 */}
            <span className="pledge-ic"><Ic k="minus" w={2.2} /></span>
            <p className="pledge-h">這裡不做什麼</p>
          </div>
          <ul>
            <li><b>不評分、不排名</b>，不說哪家公司比較危險</li>
            <li><b>不判定身分</b>，公開資料裡沒有身分證字號</li>
            <li>不提供人名查詢 —— 輸入的只能是公司</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
