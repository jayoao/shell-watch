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
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Candidate, Credential, Incident, LinkedCompany, LookupResult, SafetyStaff,
  SafetyUnits, ViolationRef,
} from "../types/contracts";
import sample from "../data/lookup.sample.json";
import { getMeta, getPlainLaw, hashMismatch, lookup } from "../lib/lookup";
import type { LookupOutcome, Meta, PlainDict, RegistryHit } from "../lib/lookup";
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
  return `/?q=${encodeURIComponent(name)}`;
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
          <span className="vio-rowlaw">{lines(v.law)[0]}</span>
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
function PlainBars({ vs }: { vs: ViolationRef[] }) {
  const [duty, setDuty] = useState<PlainDict>({});
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { void getPlainLaw().then(setDuty); }, []);

  const groups = useMemo(() => {
    const m = new Map<string, { n: number; fatal: number; topic: string; duty: string }>();
    for (const v of vs) {
      const h = v.hazards && v.hazards.length ? v.hazards[0] : null;
      const label = v.plain?.label ?? (h ? (h.phrase ?? h.name) : "其他");
      const topic = v.plain?.topic ?? (h ? "職業安全" : "其他");
      const cur = m.get(label)
        ?? { n: 0, fatal: 0, topic, duty: h?.duty ?? "" };
      cur.n += 1;
      if (v.fatal) cur.fatal += 1;
      if (!cur.duty && h?.duty) cur.duty = h.duty;
      m.set(label, cur);
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

  return (
    <div className="bars">
      <div className="kicker" style={{ marginBottom: 9 }}>被罰過的事</div>
      {groups.map(([fam, rows]) => (
        <div key={fam} className="bar-fam">
          <p className="bar-famh">{fam}</p>
          <ul className="bar-list">
            {rows.map(([label, x]) => {
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
        </div>
      ))}
      <p className="fineprint">
        長度是<b>筆數</b>，不是嚴重程度——被查過十次的公司不等於比從沒被查過的
        公司危險。一筆公告可能同時屬於多類，各類相加會大於公告筆數。
        職安法公告沒有標籤，是本站的分類規則沒有對到，
        不是「公告沒寫」，也不是「沒有危害」。
      </p>
      {fatalTotal > 0 && (
        <p className="warnbox">
          共 {fatalTotal} 筆公告<b>涉及</b>死亡災害。「涉及」指公告文字提到
          死亡災害，包含未依規定通報的情形，<b>不等於該公司造成死亡</b>。
          詳情請以處分字號查閱原始公告。
        </p>
      )}
    </div>
  );
}

/**
 * 年度點陣。
 *
 * ⚠ 刻意**不用長條圖**。長條會被讀成趨勢（「這家公司越來越糟」），
 *   而我們自己的警語就說筆數受稽核頻率影響、不是那一年比較危險。
 *   點陣只回答一個問題：**什麼時候發生過**。那才是求職者要的
 *   ——「最近還在發生」跟「十年前的事」是兩回事。
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
  if (years.length < 2) return null;
  const max = Math.max(...years.map((y) => y[1]));
  return (
    <div className="ydots">
      <ul className="ydots-list">
        {years.map(([y, n]) => (
          <li key={y} title={`民國 ${y} 年\u3000${n} 筆`}>
            <span className="ydot"
                  style={{ opacity: 0.25 + 0.75 * (n / max) }} />
            <span className="ydot-y num">{y}</span>
            <span className="ydot-n num">{n}</span>
          </li>
        ))}
      </ul>
    </div>
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
  return (
    <li className="lawg">
      <div className="lawg-head">
        <p className="lawg-law">
          {lines(law).map((t, i) => <span key={i}>{t}</span>)}
        </p>
        <span className="lawg-n num">{vs.length} 筆</span>
      </div>
      <div className="lawg-meta">
        {yearSpan(vs) && <span>{yearSpan(vs)}</span>}
        {total > 0 && <span className="num">罰鍰合計 {money(total)}</span>}
        {/* ⚠ 「未載金額」的筆數要講出來。不講的話「合計 80 萬」會被讀成
            「總共只罰了 80 萬」，而實際上有幾筆根本沒公告金額。 */}
        {unlisted > 0 && <span>其中 {unlisted} 筆公告未載金額</span>}
      </div>
      {(topHz.length > 0 || fatal > 0 || pending > 0) && (
        <div className="lawg-tags">
          {topHz.length > 0 && <span>{topHz.join("、")}</span>}
          {fatal > 0 && <span className="lawg-fatal">涉及死亡災害 {fatal} 筆</span>}
          {pending > 0 && <span className="lawg-pending">尚未確定 {pending} 筆</span>}
        </div>
      )}
      <button className="linkish" onClick={() => setOpen((v) => !v)}>
        {open ? "收合" : `展開這 ${vs.length} 筆`}
      </button>
      {open && (
        <ul className="vio-list" style={{ marginTop: 10 }}>
          {vs.map((v, i) => (
            <Violation key={`${v.doc_no}-${v.date}-${i}`} v={v} compact />
          ))}
        </ul>
      )}
    </li>
  );
}

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

  return (
    <section className="block">
      <h2 className="block-h">{title}</h2>
      <p className="block-sub">
        {vs.length} 筆{yearSpan(vs) ? ` · ${yearSpan(vs)}` : ""}
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
        <ul className="lawg-list">
          {groups.map(([law, list]) => (
            <LawGroup key={law} law={law} vs={list} />
          ))}
        </ul>
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

      {note && hasZeroFine && <p className="fineprint rule-top">{note}</p>}
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

function CredGroup({ kind, list }: { kind: Credential["kind"]; list: Credential[] }) {
  const [all, setAll] = useState(false);
  // 有效的排前面，同組內保持來源順序
  const sorted = [...list].sort((a, b) => Number(b.active) - Number(a.active));
  const shown = all ? sorted : sorted.slice(0, CRED_PREVIEW);
  const rest = sorted.length - shown.length;
  return (
    <div className="cred-group">
      <div className="cred-kind">
        {CRED_LABEL[kind]}
        {sorted.length > 1 && `\u3000${sorted.length} 項`}
      </div>
      <ul className="cred-list">
        {shown.map((c, i) => (
          <li key={i} className={c.active ? undefined : "cred-dead"}>
            <span className="cred-unit">{c.unit}</span>
            {credLine(c) && <span className="cred-detail">{credLine(c)}</span>}
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <button className="linkish" onClick={() => setAll(true)}>
          展開其餘 {rest} 個單位
        </button>
      )}
      {all && sorted.length > CRED_PREVIEW && (
        <button className="linkish" onClick={() => setAll(false)}>收合</button>
      )}
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
function Credentials({ list }: { list: Credential[] }) {
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
      {groups.map(([k, v]) => <CredGroup key={k} kind={k} list={v} />)}
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
      <p className="side-p" style={{ marginTop: 10 }}>
        資料來自勞動部職業安全衛生署「安衛單位(人員)備查名冊」，
        記錄的是事業單位依職業安全衛生法<b>向勞動檢查機構報備</b>的安衛人員。
        ⚠ 這份名冊<b>只記錄有報備的單位</b>——職安法僅要求達到一定規模的
        事業單位設置，所以沒有紀錄的公司多數是依法不需要設置。
      </p>
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════
   查詢結果
   ══════════════════════════════════════════════════════════════ */
function Result({ hit, onPick }: {
  hit: LookupResult; onPick: (n: string) => void;
}) {
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

  // ⚠⚠ 2026-09-15 外部檢視抓到一個**自相矛盾**：國城營造上面寫
  //   「公告涉及死亡災害 0」，往下捲卻有一筆重大職災罹災 1 人。
  //   我們知道原因（一個是裁處公告的文字判讀、一個是重大職災公開網），
  //   但**使用者不知道，他看到的就是這個網站在打自己臉**。
  //   解法不是藏起來，是把兩個都寫出來並標明出處。
  const incidentCount = hit.company.incidents?.length ?? 0;

  // ⚠ 標籤一律用口語。「行政救濟尚未終結」對求職者是完全陌生的詞，
  //   而它的意思其實很簡單：這筆處分還沒定案。
  const stats: [number, string, string, boolean][] = [
    [hit.summary.own_violation_count, "這家公司被罰過", "", false],
    [hit.summary.linked_violation_count,
     allWeak ? "同名者其他公司被罰過" : "負責人的其他公司被罰過",
     allWeak ? "僅姓名相同，無其他佐證" : "", false],
    [hit.summary.fatal_count ?? 0, "公告提到死亡災害", "依裁處公告的文字", true],
    [incidentCount, "重大職業災害", "依重大職災公開網", incidentCount > 0],
    [pendingCount, "這筆處分還沒定案", "還在行政救濟程序中", false],
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
          {stats.map(([n, label, note, isFatal]) => (
            <div key={label} className="stat">
              <dt className="num" style={isFatal && n > 0 ? { color: "var(--fatal)" } : undefined}>
                {n}
              </dt>
              <dd>
                {label}
                {note && <span className="stat-note">{note}</span>}
              </dd>
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
            <LinkedGroups list={p.linked_companies} onPick={onPick} />
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
        <Incidents list={hit.company.incidents ?? []} />
        <Credentials list={hit.company.credentials ?? []} />
        <SafetyUnitsBlock su={hit.company.safety} />
      </div>

      <footer className="res-foot">
        {/* ⚠ 這一行要跟畫面上實際呈現的東西一致。
            2026-09-17 加進安衛人員備查之後才發現它只寫了裁處與商工登記兩份，
            但同一頁上早就有得獎、驗證、重大職災 —— 少報資料來源，
            在一個以「資料使用度」為賣點的系統上特別難看。
            新增任何一個資料來源，這一行要一起改（或者乾脆只指向關於資料頁）。 */}
        <p className="fineprint">
          資料來源：勞動部及其所屬機關開放資料 8 筆、經濟部商工登記公示資料。
          逐項名稱、串接率與已知缺口見 <a href="/about">關於資料</a>。
          本頁僅呈現主管機關已公告之裁處紀錄與其關聯，
          不對任何事業單位或個人作出評價或認定。
        </p>
      </footer>
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
    const t = name.trim();
    if (!t) { setOutcome(null); setAsked(""); return; }
    if (push) {
      // ⚠ pushState 不是 replaceState —— 要讓「上一頁」回得到前一次查詢。
      const u = `${window.location.pathname}?q=${encodeURIComponent(t)}`;
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

  // 開啟時若網址帶 q 就直接查；上一頁／下一頁也要跟著回到對應的結果。
  useEffect(() => {
    if (meta === undefined) return;          // 還在確認有沒有完整資料
    const t = readUrl();
    if (t) { setQ(t); void run(t, false); }
    const onPop = () => {
      const s2 = readUrl();
      setQ(s2);
      if (s2) void run(s2, false);
      else { setOutcome(null); setAsked(""); }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  const hit = outcome?.kind === "hit" ? outcome.result : null;
  const fresh = !outcome && !busy;

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
              查的是公司，看見的是人
            </p>
            {/* ⚠ 2026-09-15 標語從「面試前，把老闆的名字查一遍」改成這一句。
                原本那句會讓人預期一個**輸入姓名的框** —— 我們沒有，
                而且刻意不做（開放人名查詢會讓這個工具從「查公司」
                變成「查人」，倫理量級不同）。

                文案承諾產品沒有的東西，跟「功能改了文案沒跟上」是同一種謊，
                只是方向相反。新的標語描述的是真實的機制：
                輸入的是公司，呈現的軸線是人。 */}
            <p>
              勞動部的違法紀錄跟著公司走。公司收掉重開，紀錄就留在舊公司。
              所以輸入公司名之後，這裡會把它的負責人姓名，
              以及那個姓名出現在哪些其他公司的公開紀錄上，一起呈現出來。
            </p>
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

      {!busy && hit && <Result hit={hit} onPick={(n) => { setQ(n); void run(n); }} />}

      {/* 核心名對到多家：⚠ 絕對不能自己挑一家。
          挑錯就是把 A 公司的裁處紀錄顯示成 B 公司的，那是名譽損害。
          ⚠ 只列名稱不夠 —— 實測有兩家**名稱完全相同**的公司。
            統一編號與登記地址是使用者唯一分得出來的依據。 */}
      {!busy && outcome?.kind === "choose" && (
        <Choose outcome={outcome} asked={asked} onPick={(n) => { setQ(n); void run(n); }} />
      )}

      {!busy && outcome?.kind === "miss"
        && <Miss asked={asked} meta={meta} registry={outcome.registry} />}

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
        {outcome.reason === "abbrev" ? (
          /* ⚠ 簡稱這條路跟「撞名」完全是兩件事，說法不能共用。
             實測「全聯」會列出「全國聯合工程有限公司」—— 因為全聯實業
             根本不在本站的資料裡（本站只收錄被裁處過的事業單位）。
             如果只寫「請選一家」，使用者會以為其中一家就是全聯。
             所以這裡要先講「你要找的那家如果沒有紀錄，它不會出現」。 */
          <p>
            這些是<b>字面上像</b>的公司，不是系統認為你要找的那一家。
            本站只收錄<b>被主管機關裁處過</b>的事業單位 ——
            你要找的公司如果沒有裁處紀錄，它不會出現在這份清單裡，
            而清單上的是<b>另外幾家不同的公司</b>。
            請看統一編號與登記地址再決定要不要點進去。
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
function Miss({ asked, meta, registry }: {
  asked: string;
  meta: Meta | null | undefined;
  registry?: RegistryHit;
}) {
  const [why, setWhy] = useState(false);
  const closed = registry && registry.status !== "核准設立"
    && registry.status !== "核准停業";
  return (
    <div className="miss">
      {registry ? (
        <>
          <h1 className="res-title" style={{ fontSize: 22 }}>
            {asked}
          </h1>
          <p className="miss-lead">
            這家公司在<b>經濟部商工登記</b>查得到，
            而本站涵蓋的勞動部公告裡<b>沒有它的裁處紀錄</b>。
          </p>
          <dl className="fields" style={{ marginTop: 12 }}>
            {registry.status && (
              <Field label="登記現況">
                <span style={{ color: closed ? "var(--fatal)" : "var(--ink-2)" }}>
                  {registry.status}
                </span>
              </Field>
            )}
            {regEst(registry.established) && (
              <Field label="設立">
                <span style={{ color: "var(--ink-2)" }}>
                  {regEst(registry.established).replace(/^設立 /, "")}
                </span>
              </Field>
            )}
          </dl>
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

      <button className="linkish" onClick={() => setWhy((v) => !v)}>
        {why ? "收合" : "為什麼？"}
      </button>
      {why && (
        <div className="block" style={{ marginTop: 10 }}>
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
            {" "}各縣市公告保存期間不一：
            <b>基隆市與新竹市的職業安全衛生法公告在本站一筆都沒有</b>。
          </p>
          <p className="fineprint" style={{ marginTop: 10 }}>
            商工登記資料來自經濟部商工登記公示資料查詢服務。
            要看統一編號、登記地址與完整的登記事項，請到該系統查詢。
          </p>
        </div>
      )}
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
      <p className="cov-more">
        <a href="/about">資料來源、涵蓋範圍與已知缺口 →</a>
      </p>
    </section>
  );
}
