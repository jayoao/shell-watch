import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Link } from "react-router-dom";
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
     原本  data-theme="light"  報紙亮色

   ⚠ 2026-10-29 改：「原本」原本是「拿掉屬性、跟隨系統」，手機設成深色的人會看到暖灰深色。
     預設改成固定亮色，因為海報與三折頁上的手機畫面是亮色，評審掃 QR 看到的要一樣。

   ⚠ 預設值寫在 index.html 的 <html data-theme="light">，
     使用者的選擇由 <head> 裡的 inline script 在第一次繪製前套用。
     這裡的 effect 只負責**之後**的切換與保存。 */
const THEME_KEY = "sw-theme";
type ThemeChoice = "light" | "neon";

function readTheme(): ThemeChoice {
  // ⚠ 私密視窗讀 localStorage 會丟例外，不是回 null。
  try {
    // ⚠ 2026-10-29 起預設亮色。舊版存的 "auto" 一律當亮色。
    return localStorage.getItem(THEME_KEY) === "neon" ? "neon" : "light";
  } catch {
    return "light";
  }
}

function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("data-theme", theme);
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
      onClick={() => setTheme((t) => (t === "neon" ? "light" : "neon"))}
    >
      <span className={theme === "light" ? "on" : ""}>原本</span>
      <span className={theme === "neon" ? "on" : ""}>霓虹</span>
    </button>
  );
}

/* ── 字級 ──────────────────────────────────────────────────
   2026-10-30 使用者要求：「怕有眼睛不好的」。三段：標準／大／特大。
   ⚠ 作法是 CSS zoom 放大整個 .sw-shell，不是改 html 的 font-size：
     全站的字級都寫死 px（幾百處），改 rem 等於重寫；而且只放大字、
     不放大欄寬，固定寬的格子會被撐破。zoom 是整塊等比放大，版面比例不變。
   ⚠ 導覽列刻意不放大 —— 手機 375px 放不下。
   ⚠ 地圖（.leaflet-container）有反向 zoom，見 tokens.css。
   ⚠ 預設值與第一次繪製前的套用在 index.html 的 inline script，
     跟主題一樣，避免載入時閃一下。 */
const FS_KEY = "sw-fs";
type FsChoice = "m" | "l" | "xl";
const FS_LEVELS: { v: FsChoice; label: string }[] = [
  { v: "m", label: "標準字級" },
  { v: "l", label: "大字級" },
  { v: "xl", label: "特大字級" },
];

function readFs(): FsChoice {
  try {
    const v = localStorage.getItem(FS_KEY);
    return v === "l" || v === "xl" ? v : "m";
  } catch {
    return "m";
  }
}

function FontSizeToggle() {
  const [fs, setFs] = useState<FsChoice>(readFs);
  useEffect(() => {
    const el = document.documentElement;
    if (fs === "m") el.removeAttribute("data-fs");
    else el.setAttribute("data-fs", fs);
    try {
      localStorage.setItem(FS_KEY, fs);
    } catch {
      /* 私密視窗：本次有效，不會被記住 */
    }
    // 地圖等用尺寸計算版面的元件需要知道容器變了
    window.dispatchEvent(new Event("resize"));
  }, [fs]);

  return (
    <div className="fs-toggle" role="group" aria-label="文字大小">
      {FS_LEVELS.map((l) => (
        <button
          key={l.v}
          type="button"
          className={`fs-${l.v}${fs === l.v ? " on" : ""}`}
          aria-pressed={fs === l.v}
          aria-label={l.label}
          title={l.label}
          onClick={() => setFs(l.v)}
        >
          A
        </button>
      ))}
    </div>
  );
}

/**
 * 頁首。設計稿的作法是「報紙的報頭」：粗的刊名、細的分隔線、
 * 右邊一行等寬字的資料規模。不用 logo、不用陰影、不用圓角。
 */
/**
 * 站名旁的 LOGO（2026-10-29 定稿：C1「X 光」）。原檔在 public/logo.svg。
 * 墨色跟著主題（currentColor），鏡片底色跟著頁面底色，只有人是橘色。
 */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 120 120" aria-hidden="true">
<defs><clipPath id="brand-lens"><circle cx="64" cy="64" r="24"/></clipPath></defs>
<rect x="12" y="18" width="56" height="90" rx="3" fill="none" stroke="currentColor" strokeWidth="6"/>
<path d="M12 18 L40 6 L68 18" fill="none" stroke="currentColor" strokeWidth="6" strokeLinejoin="round"/><rect x="22" y="30" width="8" height="8" rx="1" fill="currentColor"/><rect x="36" y="30" width="8" height="8" rx="1" fill="currentColor"/><rect x="50" y="30" width="8" height="8" rx="1" fill="currentColor"/><rect x="22" y="45" width="8" height="8" rx="1" fill="currentColor"/><rect x="36" y="45" width="8" height="8" rx="1" fill="currentColor"/><rect x="50" y="45" width="8" height="8" rx="1" fill="currentColor"/><rect x="22" y="60" width="8" height="8" rx="1" fill="currentColor"/><rect x="36" y="60" width="8" height="8" rx="1" fill="currentColor"/><rect x="50" y="60" width="8" height="8" rx="1" fill="currentColor"/><rect x="22" y="75" width="8" height="8" rx="1" fill="currentColor"/><rect x="36" y="75" width="8" height="8" rx="1" fill="currentColor"/><rect x="50" y="75" width="8" height="8" rx="1" fill="currentColor"/><rect x="22" y="90" width="8" height="8" rx="1" fill="currentColor"/><rect x="36" y="90" width="8" height="8" rx="1" fill="currentColor"/><rect x="50" y="90" width="8" height="8" rx="1" fill="currentColor"/>
<circle cx="64" cy="64" r="24" fill="var(--bg)"/>
<g clipPath="url(#brand-lens)"><path d="M68 18 V108" stroke="currentColor" strokeWidth="2" strokeDasharray="3 3" opacity=".45"/><circle cx="64" cy="60" r="7.5" fill="#E0661A"/><path d="M49.75 80.25 C49.75 70.5 56.5 68.4 64 68.4 C71.5 68.4 78.25 70.5 78.25 80.25 Z" fill="#E0661A"/></g>
<circle cx="64" cy="64" r="24" fill="none" stroke="currentColor" strokeWidth="8"/>
<path d="M82 82 L106 106" stroke="currentColor" strokeWidth="12" strokeLinecap="round"/>
    </svg>
  );
}

function Masthead() {
  const [meta, setMeta] = useState<Meta | null | undefined>(undefined);
  useEffect(() => { void getMeta().then(setMeta); }, []);
  return (
    <header className="sw-nav">
      {/* 慣例：點站名回首頁（2026-10-29 使用者回報點了沒反應） */}
      <Link to="/" className="brand" aria-label="職得調查 首頁"><BrandMark /><span className="brand-name">職得調查</span></Link>
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
      <div className="nav-tools">
        <FontSizeToggle />
        <ThemeToggle />
      </div>
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
            {/* ⚠ 2026-10-29：打錯網址原本是一整片空白。 */}
            <Route path="*" element={
              <div style={{ padding: "48px 0" }}>
                <h1 className="res-title" style={{ fontSize: 22 }}>找不到這一頁</h1>
                <p><a href="/">回到查詢</a>{" · "}<a href="/osha">職安地圖</a>{" · "}<a href="/about">關於資料</a></p>
              </div>} />
          </Routes>
        </Suspense>
      </main>
    </BrowserRouter>
  );
}
