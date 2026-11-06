/**
 * 站名旁的 LOGO（2026-10-29 定稿：C1「X 光」）。原檔在 public/logo.svg。
 * 墨色跟著主題（currentColor），鏡片底色跟著頁面底色，只有人是橘色。
 */
export default function BrandMark({ id = "brand-lens", className = "brand-mark" }: { id?: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 120 120" aria-hidden="true">
<defs><clipPath id={id}><circle cx="64" cy="64" r="24"/></clipPath></defs>
<rect x="12" y="18" width="56" height="90" rx="3" fill="none" stroke="currentColor" strokeWidth="6"/>
<path d="M12 18 L40 6 L68 18" fill="none" stroke="currentColor" strokeWidth="6" strokeLinejoin="round"/><rect x="22" y="30" width="8" height="8" rx="1" fill="currentColor"/><rect x="36" y="30" width="8" height="8" rx="1" fill="currentColor"/><rect x="50" y="30" width="8" height="8" rx="1" fill="currentColor"/><rect x="22" y="45" width="8" height="8" rx="1" fill="currentColor"/><rect x="36" y="45" width="8" height="8" rx="1" fill="currentColor"/><rect x="50" y="45" width="8" height="8" rx="1" fill="currentColor"/><rect x="22" y="60" width="8" height="8" rx="1" fill="currentColor"/><rect x="36" y="60" width="8" height="8" rx="1" fill="currentColor"/><rect x="50" y="60" width="8" height="8" rx="1" fill="currentColor"/><rect x="22" y="75" width="8" height="8" rx="1" fill="currentColor"/><rect x="36" y="75" width="8" height="8" rx="1" fill="currentColor"/><rect x="50" y="75" width="8" height="8" rx="1" fill="currentColor"/><rect x="22" y="90" width="8" height="8" rx="1" fill="currentColor"/><rect x="36" y="90" width="8" height="8" rx="1" fill="currentColor"/><rect x="50" y="90" width="8" height="8" rx="1" fill="currentColor"/>
<circle cx="64" cy="64" r="24" fill="var(--bg)"/>
<g clipPath={`url(#${id})`}><path d="M68 18 V108" stroke="currentColor" strokeWidth="2" strokeDasharray="3 3" opacity=".45"/><circle cx="64" cy="60" r="7.5" fill="#E0661A"/><path d="M49.75 80.25 C49.75 70.5 56.5 68.4 64 68.4 C71.5 68.4 78.25 70.5 78.25 80.25 Z" fill="#E0661A"/></g>
<circle cx="64" cy="64" r="24" fill="none" stroke="currentColor" strokeWidth="8"/>
<path d="M82 82 L106 106" stroke="currentColor" strokeWidth="12" strokeLinecap="round"/>
    </svg>
  );
}
