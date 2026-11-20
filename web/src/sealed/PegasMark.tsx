export function PegasMark({ size = 34 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="pegas-mark"
      viewBox="0 0 44 44"
      width={size}
      height={size}
    >
      <path
        d="M6.2 30.8c8.7-1.4 13.6-6.1 18.8-11.9 4.1-4.6 8.5-7.2 11.3-5.7 2.8 1.5 2.2 6.1-.8 9.8-5.3 6.4-15.8 9.6-29.3 7.8Z"
        fill="currentColor"
      />
    </svg>
  )
}
