/**
 * 查詢頁 —— 主線負責（M3）。
 * 現在是佔位，接上 API 之後會變成「輸入公司名 → 結果卡片」。
 */
export default function Home() {
  return (
    <div className="sw-card">
      <h1 style={{ marginTop: 0, fontSize: 24 }}>求職安全雷達</h1>
      <p style={{ color: "var(--ink-2)" }}>
        輸入一家公司，查它的負責人是否曾在其他公司留下違反勞動法令的公開紀錄。
      </p>
      <p className="sw-muted">（查詢功能開發中。職安地圖請點上方分頁。）</p>
    </div>
  );
}
