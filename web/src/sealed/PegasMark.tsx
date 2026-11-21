export function PegasMark({ size = 34 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="pegas-mark"
      viewBox="0 0 64 64"
      width={size}
      height={size}
    >
      <rect width="64" height="64" rx="14" fill="currentColor" />
      <g
        fill="none"
        stroke="#ffffff"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M32 17V11" />
        <circle cx="32" cy="9" r="2.4" fill="#ffffff" stroke="none" />
        <path d="M17 31l-6 4 6 4" />
        <path d="M47 31l6 4-6 4" />
        <rect x="17" y="17" width="30" height="30" rx="13" />
      </g>
      <rect x="22" y="25" width="20" height="13" rx="6.5" fill="#181818" />
      <circle cx="28" cy="31.5" r="2.1" fill="#7defff" />
      <circle cx="36" cy="31.5" r="2.1" fill="#7defff" />
    </svg>
  )
}
