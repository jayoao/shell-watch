import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import Home from "./pages/Home";
import { getMeta } from "./lib/lookup";
import type { Meta } from "./lib/lookup";

/**
 * 地圖頁用 lazy 載入，不要靜態 import。
 *
 * ⚠ 這一頁會把 leaflet、react-leaflet 與 osha_district.json（90 KB）
 *   一起拉進來。靜態 import 的話這些全部進主 bundle，
 *   **查詢頁（本專題的主產品）會為了一張它不需要的地圖多載一百多 KB**。
 *   查詢頁一次查詢才下載 14 KB，主 bundle 卻胖成這樣就本末倒置了。
 */
const OshaDistrictMap = lazy(() => import("./pages/OshaDistrictMap"));

/**
 * 頁首。設計稿的作法是「報紙的報頭」：粗的刊名、細的分隔線、
 * 右邊一行等寬字的資料規模。不用 logo、不用陰影、不用圓角。
 */
function Masthead() {
  const [meta, setMeta] = useState<Meta | null | undefined>(undefined);
  useEffect(() => { void getMeta().then(setMeta); }, []);
  return (
    <header className="sw-nav">
      <span className="brand">職得調查</span>
      <nav>
        <NavLink to="/" className={({ isActive }) => (isActive ? "on" : "")} end>
          查詢
        </NavLink>
        <NavLink to="/osha" className={({ isActive }) => (isActive ? "on" : "")}>
          職安地圖
        </NavLink>
      </nav>
      {/* ⚠ 資料規模只在桌機顯示（CSS 控制）。375px 放不下，
          硬塞進去會把導覽列擠成兩行。 */}
      <span className="scale">
        {meta
          ? `${meta.companies.toLocaleString("zh-TW")} 家事業單位 · ` +
            `${meta.violations.toLocaleString("zh-TW")} 筆公告 · 民國 100–115 年`
          : ""}
      </span>
    </header>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Masthead />
      <main className="sw-shell">
        <Suspense fallback={<p className="sw-muted">載入地圖資料中…</p>}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/osha" element={<OshaDistrictMap />} />
          </Routes>
        </Suspense>
      </main>
    </BrowserRouter>
  );
}
