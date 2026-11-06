/**
 * 新手手冊（/guide）。設計稿 02_新手手冊（2026-11-06）。
 *
 * 首頁改成 Google 式極簡之後，原本放在首頁的時間軸示意、三步驟、
 * 涵蓋範圍數字、「這裡有什麼／不做什麼」全部搬到這一頁。
 *
 * ⚠ 維護規則
 * 1. 頁面上所有公司、統一編號、地址都是**虛構的**（範例營造股份有限公司）。
 *    截圖、影片會拍到這一頁，不要為了「比較真實」換成真的公司。
 * 2. 會變的數字一律從 meta.json 讀（跟 About.tsx 同一條規則）。
 * 3. 「這裡有什麼／不做什麼」跟結果頁的紅線是同一組，改一邊一定要改另一邊。
 * 4. 這一頁描述的是功能。功能改了、這裡沒跟上，就是一句謊 —— 改功能的
 *    同一筆 commit 就要改這裡。
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { getMeta } from "../lib/lookup";
import type { Meta } from "../lib/lookup";
import "../styles/guide.css";

const TOC: { id: string; label: string; sub?: string }[] = [
  { id: "core", label: "重點", sub: "先懂一件事" },
  { id: "step1", label: "STEP 1", sub: "輸入公司名稱" },
  { id: "step2", label: "STEP 2", sub: "選對那一家" },
  { id: "step3", label: "STEP 3", sub: "看懂結果頁" },
  { id: "tags", label: "怎麼看", sub: "每個標籤的意思" },
  { id: "more", label: "怎麼用", sub: "其他功能" },
  { id: "faq", label: "FAQ", sub: "常見問題" },
  { id: "data", label: "資料", sub: "資料從哪來" },
];

/* 線條圖示：跟全站一樣 24 格、currentColor。 */
const PATH: Record<string, string> = {
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4.2-4.2",
  warn: "M12 4 2.5 20h19L12 4Zm0 6v4.5m0 3v.01",
  check: "M5 12.5 10 17l9-10",
  minus: "M6 12h12",
  map: "M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20V6.5ZM9 4v13.5M15 6.5V20",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.5V12l3 2",
  chat: "M4 5h16v11H9l-5 4V5Zm4 5h8m-8 3h5",
  tag: "M3 12V4h8l10 10-8 8L3 12Zm5-4.5v.01",
  doc: "M6 3h8l4 4v14H6V3Zm8 0v4h4M9 12h6m-6 4h6",
  phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
};
function G({ k }: { k: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
         strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATH[k] ?? ""} />
    </svg>
  );
}

function Sec({ id, kicker, title, children }: { id: string; kicker: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="g-sec" aria-labelledby={`${id}-h`}>
      <p className="g-kicker">{kicker}</p>
      <h2 id={`${id}-h`} className="g-h2">{title}</h2>
      {children}
    </section>
  );
}

/** 結果頁示意圖上的 A–D 圈號 */
const Mk = ({ c }: { c: string }) => <span className="g-mk" aria-hidden="true">{c}</span>;

export default function Guide() {
  const [meta, setMeta] = useState<Meta | null | undefined>(undefined);
  const [on, setOn] = useState("core");
  const { hash } = useLocation();

  useEffect(() => { getMeta().then(setMeta, () => setMeta(null)); }, []);

  // 從首頁「看完整說明 →」（/guide#core）進來時捲到該段。
  // ⚠ 頁面是 lazy 載入的，瀏覽器自己的錨點捲動發生在元素出現之前，所以要補一次。
  useEffect(() => {
    if (!hash) { window.scrollTo(0, 0); return; }
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [hash]);

  // 左側目錄：跟著捲動標出目前這一段。
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((ents) => {
      const vis = ents.filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (vis[0]) setOn(vis[0].target.id);
    }, { rootMargin: "-80px 0px -60% 0px" });
    TOC.forEach((t) => { const el = document.getElementById(t.id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, []);

  const n = (v: number | undefined, fb: number) => (v ?? fb).toLocaleString("zh-TW");

  return (
    <div className="page guide">
      <nav className="g-toc" aria-label="新手手冊目錄">
        <p className="g-toc-h">新手手冊</p>
        <ol>
          {TOC.map((t) => (
            <li key={t.id}>
              <a href={`#${t.id}`} className={on === t.id ? "on" : ""} aria-current={on === t.id ? "location" : undefined}>
                <b>{t.label}</b>{t.sub && <span>{t.sub}</span>}
              </a>
            </li>
          ))}
        </ol>
        <Link className="g-toc-cta" to="/">回首頁查詢 →</Link>
      </nav>

      <article className="g-main">
        <header className="g-hero">
          <p className="g-kicker">新手手冊</p>
          <h1 className="g-h1">三步驟，查一家公司</h1>
          <p className="g-lead">
            輸入公司名稱、選對那一家、看懂結果頁。第一次用的話，大約三分鐘可以讀完這一頁。
          </p>
          <p className="g-banner" role="note">
            <G k="warn" />
            <span>本頁的「範例營造股份有限公司」以及所有統一編號、地址、紀錄都是<b>虛構的示意</b>，不是真實資料。</span>
          </p>
        </header>

        <Sec id="core" kicker="重點" title="先懂一件事：為什麼要看負責人">
          <p className="g-p">
            公司收掉重開，紀錄就留在舊公司。只查新公司的名字，會看到「0 筆」——
            但同一個負責人姓名，可能在舊公司底下留下過很多筆裁處。
          </p>
          <div className="g-core" role="img"
               aria-label="示意：甲公司已解散，有 12 筆裁處紀錄；乙公司今年新設立，0 筆。兩家公司的負責人姓名相同。">
            <div className="g-co">
              <p className="g-co-h">甲公司 <span>已解散</span></p>
              <p className="g-co-n num">12 <span>筆裁處</span></p>
            </div>
            <div className="g-co-mid" aria-hidden="true"><span>同一個負責人姓名</span><i /></div>
            <div className="g-co is-new">
              <p className="g-co-h">乙公司 <span>今年新設立</span></p>
              <p className="g-co-n num">0 <span>筆裁處</span></p>
            </div>
          </div>
          <ol className="g-narr">
            <li>甲公司有 12 筆公開裁處紀錄</li>
            <li>兩家公司登記的<b>負責人姓名相同</b></li>
            <li>乙公司今年才新設立，目前 0 筆紀錄</li>
            <li>甲公司先解散，乙公司才成立 —— 紀錄留在了舊公司</li>
          </ol>
          <p className="g-p">職得調查會列出<b>同名負責人</b>出現過的其他公司，並把姓名以外的佐證（同地址、同縣市、時間先後）一條一條列出來。</p>
          <div className="g-warn" role="note">
            <G k="warn" />
            <div>
              <p className="g-warn-h">姓名相同不等於同一人。本站不判定身分。</p>
              <p>公開資料裡沒有身分證字號。結果頁只呈現一個連結有幾項「獨立佐證」，是不是同一個人，請你自己進一步查證。</p>
            </div>
          </div>
        </Sec>

        <Sec id="step1" kicker="STEP 1" title="輸入公司名稱">
          <div className="g-mock g-mock-search" aria-hidden="true">
            <span className="g-ms-ic"><G k="search" /></span>
            <span className="g-ms-q">範例營造股份有限公司</span>
            <span className="g-ms-btn">查詢裁處紀錄</span>
          </div>
          <ul className="g-tips">
            <li><b>打完整的法定名稱最準</b>，連同「股份有限公司」「有限公司」「工程行」這些字尾。</li>
            <li>打簡稱（例如「台積電」）、品牌或英文名，會<b>列出候選讓你選</b>，不會直接跳到某一家。</li>
            <li>只能輸入公司。本站<b>不提供人名查詢</b>。</li>
            <li>查詢在你的瀏覽器裡完成：只下載這家公司所在的資料分片（壓縮後約 50 KB），本站不記錄你查了誰。</li>
          </ul>
        </Sec>

        <Sec id="step2" kicker="STEP 2" title="從候選中選對那一家">
          <p className="g-p">名稱很像、甚至<b>完全相同</b>的公司可能有好幾家。系統不會替你挑 —— 挑錯就會把一家公司的紀錄看成另一家的。</p>
          <ul className="g-mock g-cands" aria-hidden="true">
            <li>
              <p className="g-cand-n">範例營造股份有限公司</p>
              <dl><dt>統一編號</dt><dd className="num">12345678</dd><dt>登記地址</dt><dd>○○市○○區範例路 1 號</dd><dt>設立</dt><dd className="num">民國 98 年</dd></dl>
              <span className="g-cand-r num">裁處 12 筆</span>
            </li>
            <li>
              <p className="g-cand-n">範例營造有限公司</p>
              <dl><dt>統一編號</dt><dd className="num">87654321</dd><dt>登記地址</dt><dd>△△縣△△鄉示意街 20 號</dd><dt>設立</dt><dd className="num">民國 112 年</dd></dl>
              <span className="g-cand-r num is-zero">裁處 0 筆</span>
            </li>
          </ul>
          <ul className="g-tips">
            <li>對照<b>統一編號、登記地址、設立年</b>，確認是你要找的那一家再點進去。</li>
            <li>「裁處 0 筆」的是商工登記（或稅籍）查得到、但勞動部公告裡沒有紀錄的公司。</li>
            <li>異體字（例如「恒」與「恆」）可能是兩家不同的公司。</li>
          </ul>
        </Sec>

        <Sec id="step3" kicker="STEP 3" title="看懂結果頁">
          <div className="g-mock g-res" aria-hidden="true">
            <div className="g-res-row g-res-a"><Mk c="A" />
              <div><p className="g-res-co">範例營造股份有限公司</p>
                <p className="g-res-sub">統一編號 12345678 · 核准設立 · ○○市</p>
                <p className="g-res-k">職安履歷</p><div className="g-res-chips"><span className="bad">裁處 12 筆</span><span className="bad">重大職災 1 起</span><span className="good">安衛備查 2 處</span><span>負責人關聯 1 家</span></div>
              </div>
            </div>
            <div className="g-res-row g-res-b"><Mk c="B" />
              <div><p className="g-res-t">113/05/14 · 勞動基準法第 32 條第 2 項 · 罰鍰 2 萬元</p>
                <p className="g-res-d">延長工作時間超過法定上限</p>
                <div className="g-res-chips"><span>工時</span><span className="pend">尚未確定</span></div>
              </div>
            </div>
            <div className="g-res-row g-res-c"><Mk c="C" />
              <div><p className="g-res-t">你可以確認什麼</p>
                <p className="g-res-d">「平常一個月大概加班幾小時？旺季呢？」</p>
              </div>
            </div>
            <div className="g-res-row g-res-d4"><Mk c="D" />
              <div><p className="g-res-t">負責人姓名相符的公司 · 範例工程行（已解散）</p>
                <p className="g-res-d">二項獨立佐證：同登記地址、時間先後相接</p>
              </div>
            </div>
          </div>
          <div className="g-cards4">
            <div className="g-card"><p className="g-card-h"><Mk c="A" />這家公司是誰、有哪些紀錄</p>
              <p>公司基本資料與「職安履歷」一排總覽：裁處、重大職災、身障公告、得獎驗證、安衛備查⋯⋯ 點一格就跳到那一段。灰色的「—」是查過了、那份資料裡沒有這一家。</p></div>
            <div className="g-card"><p className="g-card-h"><Mk c="B" />每一筆裁處</p>
              <p>日期、違反法條、罰鍰與處分字號照公告原文列出；法條另外翻成人話並標出類別（例如工時、工資）；職安法的紀錄再標出危害類型（例如墜落、機械）。</p></div>
            <div className="g-card"><p className="g-card-h"><Mk c="C" />面試時你可以確認什麼</p>
              <p>把被罰的事翻成可以問的問題。例如工時：法規要求延長工作時間連同正常工時每日不得超過十二小時，每月延長工時不得超過四十六小時 —— 所以可以問「平常一個月大概加班幾小時？旺季呢？」</p></div>
            <div className="g-card"><p className="g-card-h"><Mk c="D" />負責人姓名相符的公司</p>
              <p>同名負責人出現過的其他公司、時間軸，以及每個連結有<b>幾項獨立佐證</b>。只有姓名相同的連結另外收成一組、預設收合。沒有分數，也不判定是不是同一人。</p></div>
          </div>
        </Sec>

        <Sec id="tags" kicker="怎麼看" title="每個標籤代表什麼">
          <div className="g-tbl-wrap">
            <table className="g-tbl">
              <thead><tr><th scope="col">標籤</th><th scope="col">意思</th><th scope="col">資料來源</th></tr></thead>
              <tbody>
                <tr><th scope="row"><span className="g-t bad">裁處</span></th><td>主管機關公開的違反勞動法令處分，逐筆附處分字號。</td><td>勞動部</td></tr>
                <tr><th scope="row"><span className="g-t fatal">涉及死亡災害</span></th><td>這筆處分與死亡災害有關。「涉及」不是「造成」——有些罰的是未在期限內通報。</td><td>勞動部</td></tr>
                <tr><th scope="row"><span className="g-t pend">尚未確定</span></th><td>這筆處分還在行政救濟中，還沒定案。</td><td>勞動部</td></tr>
                <tr><th scope="row"><span className="g-t bad">重大職災</span></th><td>重大職業災害公開網的紀錄，附實際發生地點與災害類型。</td><td>勞動部職安署</td></tr>
                <tr><th scope="row"><span className="g-t bad">身障公告</span></th><td>身障定額進用未足額公告（繳差額補助費，不是罰鍰）；有金展獎的也會一起標出。</td><td>勞動部</td></tr>
                <tr><th scope="row"><span className="g-t good">得獎驗證</span></th><td>職安獎項、TOSHMS 驗證，標明是<b>哪個場所</b>的；已到期的照實列出。</td><td>勞動部職安署</td></tr>
                <tr><th scope="row"><span className="g-t good">人才培訓</span></th><td>TTQS、國家人才發展獎等；評的是培訓制度，不是職業安全衛生。</td><td>勞動部勞動力發展署</td></tr>
                <tr><th scope="row"><span className="g-t good">安衛備查</span></th><td>有向主管機關備查職業安全衛生人員的場所數。</td><td>勞動部職安署</td></tr>
                <tr><th scope="row"><span className="g-t good">工作守則</span></th><td>安全衛生工作守則有報備查的場所數。</td><td>勞動部職安署</td></tr>
                <tr><th scope="row"><span className="g-t">上市櫃揭露</span></th><td>上市櫃公司<b>自行申報</b>的薪資中位數與職災人數。</td><td>證交所、櫃買中心</td></tr>
                <tr><th scope="row"><span className="g-t">負責人關聯</span></th><td>負責人姓名相符、且有姓名以外佐證的其他公司家數。</td><td>經濟部商工登記</td></tr>
                <tr><th scope="row"><span className="g-t">獨立佐證</span></th><td>姓名以外的線索（同地址、同縣市、時間先後⋯）。「姓名相同」「姓名罕見」都不算。</td><td>本站比對</td></tr>
              </tbody>
            </table>
          </div>
          <p className="g-note">逐年分布的最後一年（民國 115 年）不是完整年度，看起來比較少不代表變好了。</p>
        </Sec>

        <Sec id="more" kicker="怎麼用" title="其他功能">
          <div className="g-cards6">
            <Link className="g-card is-link" to="/osha"><p className="g-card-h"><G k="map" />職安地圖</p>
              <p>依鄉鎮市區看職安法裁處的分布，可以篩危害類型與死亡災害，點進去看是哪些公司。</p></Link>
            <div className="g-card"><p className="g-card-h"><G k="clock" />時間軸</p>
              <p>把這家公司與負責人姓名相符的公司排在同一條時間線上，看誰先解散、誰後成立。</p></div>
            <div className="g-card"><p className="g-card-h"><G k="chat" />面試可以問</p>
              <p>每種被罰的事都附一句可以在面試時確認的問題，不用自己想。</p></div>
            <div className="g-card"><p className="g-card-h"><G k="tag" />簡稱與品牌</p>
              <p>常見簡稱、品牌、英文名對照到法定名稱（已核對商工登記），列成候選讓你選。</p></div>
            <div className="g-card"><p className="g-card-h"><G k="doc" />查無也說清楚</p>
              <p>沒有裁處紀錄時，告訴你這家公司在商工登記查不查得到，以及查過了哪幾份資料。</p></div>
            <Link className="g-card is-link" to="/about"><p className="g-card-h"><G k="link" />資料來源與缺口</p>
              <p>每一份資料集的來源連結、涵蓋範圍，以及我們知道還缺什麼。</p></Link>
          </div>
        </Sec>

        <Sec id="faq" kicker="FAQ" title="常見問題">
          <div className="g-faq">
            <details open>
              <summary>查不到這家公司？</summary>
              <p>頁面會顯示「查無裁處紀錄」，並告訴你這家公司在經濟部商工登記查不查得到。先確認名稱是不是完整的法定名稱，或改打簡稱看看候選清單。</p>
            </details>
            <details>
              <summary>0 筆，代表這家公司很安全嗎？</summary>
              <p>不代表。0 筆只表示勞動部公開的裁處公告裡沒有它；沒被檢查到、或公告沒有涵蓋的地區與年份，都不會出現在這裡。本站不評分、不排名。</p>
            </details>
            <details>
              <summary>負責人姓名相同，就是同一個人嗎？</summary>
              <p>不一定。公開資料裡沒有身分證字號，本站不判定身分，只列出姓名以外有幾項獨立佐證，判斷請自行查證。</p>
            </details>
            <details>
              <summary>會記錄我查了哪家公司嗎？</summary>
              <p>不會。查詢在你的瀏覽器裡完成：只下載這家公司所在的那一個資料分片來比對，本站不記錄你查了誰。</p>
            </details>
          </div>
        </Sec>

        <Sec id="data" kicker="資料" title="資料從哪來">
          {meta === undefined ? <p className="g-p">載入資料中…</p> : (
            <dl className="g-stats">
              <div><dt className="num">{n(meta?.companies, 176268)}</dt><dd>家事業單位</dd></div>
              <div><dt className="num">{n(meta?.violations, 629192)}</dt><dd>筆公開裁處紀錄</dd></div>
              <div><dt className="num">9</dt><dd>部法規 · 民國 100–115 年</dd></div>
            </dl>
          )}
          <p className="g-p">
            資料來自勞動部「違反勞動法令事業單位（雇主）查詢系統」等公開資料，與經濟部商工登記；非本站自行蒐集或調查。
            {meta?.coverage_to && <> 裁處公告涵蓋至民國 <span className="num">{meta.coverage_to}</span>。</>}
          </p>
          <div className="g-pledge">
            <div className="g-pl">
              <p className="g-pl-h"><span className="g-pl-ic"><G k="check" /></span>這裡有什麼</p>
              <ul>
                <li>9 部法規的<b>公開裁處公告</b>，逐筆附處分字號</li>
                <li>法條翻成人話，看得出被罰的是什麼事</li>
                <li>得獎、驗證、安衛人員備查，標明是<b>哪個場所</b>的</li>
                <li>身障定額進用<b>未足額公告</b>與金展獎，109–115 年逐期標出</li>
                <li>上市櫃公司<b>自行申報</b>的薪資中位數與職災人數</li>
              </ul>
            </div>
            <div className="g-pl is-not">
              <p className="g-pl-h"><span className="g-pl-ic"><G k="minus" /></span>這裡不做什麼</p>
              <ul>
                <li><b>不評分、不排名</b>，不說哪家公司比較危險</li>
                <li><b>不判定身分</b>，公開資料裡沒有身分證字號</li>
                <li>不提供人名查詢 —— 輸入的只能是公司</li>
              </ul>
            </div>
          </div>
          <p className="g-p"><Link to="/about">每一份資料集、涵蓋範圍與已知缺口 →</Link></p>
        </Sec>

        <aside className="g-cta">
          <p className="g-cta-h">準備好了？查一家你在意的公司。</p>
          <p className="g-cta-p">遇到勞動權益問題，可以撥打 <b className="num">1955</b> 勞工諮詢申訴專線。</p>
          <Link className="g-cta-btn" to="/">回首頁開始查詢 →</Link>
        </aside>
      </article>
    </div>
  );
}
