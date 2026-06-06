// 品牌識別資產：三色羽毛標（線條版 A）。固定 --brand-* 色，不隨 --primary 變。
export function FeatherMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M7 28 Q 8.5 14 17 5.5" stroke="var(--brand-coral)" strokeWidth="4.4" strokeLinecap="round" />
      <path d="M11.5 28 Q 15 12.5 24.5 7.5" stroke="var(--brand-mint)" strokeWidth="4.4" strokeLinecap="round" />
      <path d="M16 28 Q 22.5 14 28.5 12.5" stroke="var(--brand-lavender)" strokeWidth="4.4" strokeLinecap="round" />
    </svg>
  );
}
