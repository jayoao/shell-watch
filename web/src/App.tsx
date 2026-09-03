import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import Home from "./pages/Home";
import OshaMap from "./pages/OshaMap";

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
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/osha" element={<OshaMap />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}
