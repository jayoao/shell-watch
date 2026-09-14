/**
 * 關於資料。
 *
 * ══════════════════════════════════════════════════════════════
 * 為什麼要有這一頁
 * ══════════════════════════════════════════════════════════════
 * 2026-09-15 外部檢視的結論之一：「資料使用度是這個作品最強的項目，
 * 比自己描述的還強 —— 但這些好東西散在各區塊的小字裡，評審不會每個都看到。」
 *
 * 他說得對。「基隆市與新竹市的職安法公告一筆都沒有」「台北市 16,536 筆
 * 公告未載金額」「TOSHMS 到期的照實列出，不採用來源的狀態欄」這些細節
 * 現在分別藏在查無頁、裁處清單的註腳、得獎區塊的小字裡。
 *
 * 這一頁把它們集中。⚠ 集中的重點不是炫耀資料量，是**把缺口攤開**：
 * 一份資料集的可信度，看的是它敢不敢講自己缺什麼。
 *
 * ══════════════════════════════════════════════════════════════
 * ⚠ 維護規則
 * ══════════════════════════════════════════════════════════════
 * 1. 會變的數字（公司數、公告數）一律從 meta.json 讀，**不要寫死**。
 *    寫死的下場是每次重跑管線就多一處過時的數字，而且沒有人會發現。
 * 2. 不會變的數字（覆蓋率、缺口）寫死，但**每一個都要標產出日**。
 * 3. 新增資料集 → 這一頁要補一列，`docs/開放資料來源.md` 也要補。
 *    兩邊不同步的話，報名文件跟網站會講不一樣的話。
 */
import { useEffect, useState } from "react";
import { getMeta } from "../lib/lookup";
import type { Meta } from "../lib/lookup";
import "../styles/about.css";

/** ⚠ 網址一律指向 data.gov.tw 的資料集頁面，不要指向我們實際打的下載端點。
 *  評審要看的是資料集本身，而下載端點會換。 */
const MOL = [
  {
    id: "155978",
    name: "事業單位違反職業安全衛生法令資料",
    use: "核心資料。事業單位名稱、負責人姓名、違反法條、違反內容、罰鍰、處分字號。",
  },
  {
    id: "156800",
    name: "違反勞動法令事業單位－勞工職業災害保險及保護法",
    use: "同上，擴充至災保法。",
  },
  {
    id: "126835",
    name: "重大職業災害公開網",
    use: "災害的實際發生地點（非登記地址）、災害類型、罹災人數、事業單位統一編號。"
       + "這是全站唯一有精確識別鍵的一份。",
  },
  {
    id: "6340",
    name: "通過臺灣職業安全衛生管理系統（TOSHMS）驗證之事業單位名單",
    use: "職安履歷的「驗證」面。",
  },
  {
    id: "46106",
    name: "通過職業安全衛生管理系統績效審查且於有效期間之事業單位清單",
    use: "同上。",
  },
  {
    id: "41460",
    name: "職業安全衛生獎項－推行職業安全衛生優良單位五星獎",
    use: "職安履歷的「得獎」面。",
  },
  {
    id: "41459",
    name: "職業安全衛生獎項－國家職業安全衛生獎",
    use: "同上。",
  },
];

const OTHER = [
  {
    name: "商工登記公示資料",
    org: "經濟部",
    url: "https://data.gcis.nat.gov.tw/",
    use: "登記地址與登記現況。⚠ 在方法上是最重要的一份——它是唯一一條"
       + "「與姓名無關」的軸線，所以拿它當獨立的校準尺。",
  },
  {
    name: "taiwan-address-data",
    org: "民間（BSD 授權，源自 TGOS）",
    url: "https://github.com/zhengda/taiwan-address-data",
    use: "地址轉經緯度。",
  },
  {
    name: "臺灣通用電子地圖圖磚",
    org: "內政部國土測繪中心",
    url: "https://wmts.nlsc.gov.tw/",
    use: "地圖頁底圖。⚠ 這是全站唯一的外部伺服器依賴，查詢頁不打它。",
  },
  {
    name: "twgeojson 行政區界",
    org: "g0v",
    url: "https://github.com/g0v/twgeojson",
    use: "鄉鎮市區界向量，內建在程式裡。",
  },
];

/** 已知缺口。⚠ 這張表是這一頁的重點，不要為了畫面好看縮短它。 */
const GAPS: [string, string][] = [
  [
    "基隆市與新竹市的職業安全衛生法公告，本站一筆都沒有",
    "不是我們漏抓。各縣市的公告保存期間不一致，這兩個縣市的職安法公告"
    + "在來源端就查不到。地圖上這兩個地區的空白是資料缺口，不是當地沒有違規。",
  ],
  [
    "台北市有 16,536 筆公告沒有刊載罰鍰金額",
    "部分縣市的公告不寫金額。畫面上顯示「公告未載金額」而不是 0 元——"
    + "未載不等於免罰，金額請以原始裁處書為準。",
  ],
  [
    "公開資料沒有身分證字號",
    "所以本系統不判定兩個同名的人是不是同一個人，只呈現這個連結有多少獨立佐證。"
    + "這是整個專案最根本的限制。",
  ],
  [
    "95% 的同名連結，除了姓名之外沒有任何佐證",
    "抽樣 468 個連結對，只有 4.9% 有姓名以外的獨立佐證（同地址或同縣市）。"
    + "零佐證的連結預設收合並標示，因為把它們跟有佐證的並排列出，呈現本身就是暗示。",
  ],
  [
    "重大職業災害只涵蓋 2024 年 7 月之後，全國約 500 筆",
    "它補的是「位置精確」，不是「涵蓋完整」。這裡沒有紀錄，不代表沒發生過職災。",
  ],
  [
    "得獎與驗證的對象是名單上寫的那個單位，很多是廠區",
    "「○○公司十二廠七期」通過驗證，不代表整家公司每個場所都通過。"
    + "顯示的一律是原始全名。",
  ],
  [
    "有效期一律以截止日期判定，不採用來源的「目前狀態」欄",
    "實測該欄位 86 筆全部寫「通過」，其中 51 筆的截止日期已經過了。"
    + "已到期的照實列出並標示，不隱藏也不當成有效。",
  ],
  [
    "地圖的登記地址層畫的是「登記在哪」，不是「事情發生在哪」",
    "職安法公告只有 0.25% 填了發生地點，所以那一層用商工登記地址，是近似位置。"
    + "重大職災那一層才是實際的肇災處。兩層並存，不是後者取代前者。",
  ],
];

function n(x: number | undefined): string {
  return (x ?? 0).toLocaleString("zh-TW");
}

export default function About() {
  const [meta, setMeta] = useState<Meta | null | undefined>(undefined);
  useEffect(() => { void getMeta().then(setMeta); }, []);

  return (
    <div className="about">
      <h1 className="about-title">關於資料</h1>
      <p className="about-lead">
        本系統使用<b>勞動部及其所屬機關開放資料集 7 筆</b>，
        並以<b>經濟部商工登記公示資料</b>作為獨立的驗證軸線。
        全部是公開資料，沒有任何一筆來自非公開管道。
      </p>

      <section className="about-sec">
        <h2 className="about-h">規模</h2>
        <dl className="about-nums">
          <div>
            <dt className="num">{n(meta?.companies)}</dt>
            <dd>家事業單位</dd>
          </div>
          <div>
            <dt className="num">{n(meta?.violations)}</dt>
            <dd>筆公開裁處紀錄</dd>
          </div>
          <div>
            <dt className="num">9</dt>
            <dd>部法規</dd>
          </div>
          <div>
            <dt className="num">100–115</dt>
            <dd>民國年（裁處日期 100/10/12–115/08/31）</dd>
          </div>
        </dl>
        <p className="about-p">
          法規分布：勞工退休金條例 468,721 筆、職業安全衛生法 75,142 筆、
          勞動基準法 64,748 筆、勞工職業災害保險及保護法 25,059 筆、
          性別平等工作法 1,244 筆，其餘（最低工資法、就業服務法、工會法、
          中高齡者及高齡者就業促進法）合計 342 筆。
        </p>
        <p className="about-note">
          ⚠ 職安法佔 <b>11.8%</b>。本站是「勞動法遵的職安履歷」，
          不是只看職安法——但地圖頁只用職安法那一部分。
        </p>
      </section>

      <section className="about-sec">
        <h2 className="about-h">勞動部及其所屬機關開放資料</h2>
        <ol className="ds-list">
          {MOL.map((d) => (
            <li key={d.id}>
              <a className="ds-name"
                 href={`https://data.gov.tw/dataset/${d.id}`}
                 target="_blank" rel="noreferrer noopener">
                {d.name}
              </a>
              <div className="ds-url num">https://data.gov.tw/dataset/{d.id}</div>
              <div className="ds-use">{d.use}</div>
            </li>
          ))}
        </ol>
      </section>

      <section className="about-sec">
        <h2 className="about-h">其他公開資料（不計入勞動部資料使用度）</h2>
        <ol className="ds-list">
          {OTHER.map((d) => (
            <li key={d.name}>
              <a className="ds-name" href={d.url}
                 target="_blank" rel="noreferrer noopener">{d.name}</a>
              <div className="ds-url num">{d.org}{"\u3000"}{d.url}</div>
              <div className="ds-use">{d.use}</div>
            </li>
          ))}
        </ol>
      </section>

      <section className="about-sec">
        <h2 className="about-h">這些資料怎麼串起來</h2>
        <table className="join-table">
          <thead>
            <tr><th>串接</th><th className="right">結果</th><th>用什麼鍵</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>裁處公告 → 商工登記</td>
              <td className="right num">152,421 家（86.4%）</td>
              <td>正規化後的公司名稱</td>
            </tr>
            <tr>
              <td>裁處公告 → 得獎與驗證</td>
              <td className="right num">403 家 · 1,010 張證書</td>
              <td>正規化後完全相同的名稱，不做模糊比對</td>
            </tr>
            <tr>
              <td>裁處公告 → 重大職災</td>
              <td className="right num">380 家</td>
              <td>統一編號優先，無統編才退回名稱並標示</td>
            </tr>
            <tr>
              <td>地址 → 經緯度</td>
              <td className="right num">23,020 個地址</td>
              <td>門牌級 79.3%、路名級 20.7%</td>
            </tr>
          </tbody>
        </table>
        <p className="about-note">
          ⚠ 有 <b>13.6%</b> 的事業單位在商工登記裡查不到統一編號。
          多數是診所、小吃店、工作室這類以商業登記或執業登記存在的單位。
          它們的裁處紀錄照常顯示，只是沒有統編與登記地址可以佐證。
        </p>
      </section>

      <section className="about-sec">
        <h2 className="about-h">已知缺口</h2>
        <p className="about-p">
          一份資料集的可信度，看的是它敢不敢講自己缺什麼。以下每一項都是實測結果。
        </p>
        <dl className="gap-list">
          {GAPS.map(([h, body]) => (
            <div key={h}>
              <dt>{h}</dt>
              <dd>{body}</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className="about-foot">
        <p className="fineprint">
          資料產出日：{meta?.generated_at ?? "—"}
          {meta?.version ? `（版本 ${meta.version}）` : ""}。
          本頁僅呈現主管機關已公告之裁處紀錄與其關聯，
          不對任何事業單位或個人作出評價或認定。
        </p>
      </footer>
    </div>
  );
}
