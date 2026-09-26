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

/** 關於資料。純文字，很小，但沒有理由讓查詢頁載它。 */
const About = lazy(() => import("./pages/About"));

/* ── 配色切換 ──────────────────────────────────────────────────
   兩個選項，不是三個：

     霓虹  data-theme="neon"   高彩度深色
     原本  **拿掉屬性**         跟隨系統：亮色 → 報紙、深色 → 暖灰

   ⚠ 「原本」不是 data-theme="dark"。寫死 dark 會讓亮色模式的人
     也被強迫看深色 ——「原本」的定義就是「照系統，不要干預」。

   ⚠ 預設值寫在 index.html 的 <html data-theme="neon">，
     使用者的選擇由 <head> 裡的 inline script 在第一次繪製前套用。
     這裡的 effect 只負責**之後**的切換與保存。 */
const THEME_KEY = "sw-theme";
type ThemeChoice = "auto" | "neon";

function readTheme(): ThemeChoice {
  // ⚠ 私密視窗讀 localStorage 會丟例外，不是回 null。
  try {
    return localStorage.getItem(THEME_KEY) === "auto" ? "auto" : "neon";
  } catch {
    return "neon";
  }
}

function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "auto") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", "neon");
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* 私密視窗寫不進去。切換在本次瀏覽仍然有效，只是不會被記住。 */
    }
  }, [theme]);

  return (
    <button
      type="button"
      className="theme-toggle"
      /* ⚠ 兩個可見的字不足以讓螢幕閱讀器知道「現在是哪一個、按下去會怎樣」。
         aria-label 要把狀態與動作都講出來。 */
      aria-label={theme === "neon"
        ? "目前是霓虹配色，切換回原本配色"
        : "目前是原本配色，切換為霓虹配色"}
      onClick={() => setTheme((t) => (t === "neon" ? "auto" : "neon"))}
    >
      <span className={theme === "auto" ? "on" : ""}>原本</span>
      <span className={theme === "neon" ? "on" : ""}>霓虹</span>
    </button>
  );
}

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
        <NavLink to="/about" className={({ isActive }) => (isActive ? "on" : "")}>
          關於資料
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
      <ThemeToggle />
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
            <Route path="/about" element={<About />} />
          </Routes>
        </Suspense>
      </main>
    </BrowserRouter>
  );
}
