import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import Home from "./pages/Home";

/**
 * 地圖頁用 lazy 載入，不要靜態 import。
 *
 * ⚠ 這一頁會把 leaflet、react-leaflet 與 osha_district.json（90 KB）
 *   一起拉進來。靜態 import 的話這些全部進主 bundle，
 *   **查詢頁（本專題的主產品）會為了一張它不需要的地圖多載一百多 KB**。
 *   查詢頁一次查詢才下載 14 KB，主 bundle 卻胖成這樣就本末倒置了。
 */
const OshaDistrictMap = lazy(() => import("./pages/OshaDistrictMap"));

export default function App() {
  return (
    <BrowserRouter>
      <nav className="sw-nav">
        <span className="brand">換殼追蹤</span>
        <NavLink to="/" className={({ isActive }) => (isActive ? "on" : "")} end>
          查詢
        </NavLink>
        <NavLink to="/osha" className={({ isActive }) => (isActive ? "on" : "")}>
          職安地圖
        </NavLink>
      </nav>
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
