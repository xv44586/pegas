export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  className = '',
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-10 shrink-0 rounded-full transition-colors duration-200
        disabled:opacity-50 disabled:pointer-events-none
        ${checked ? 'bg-ink' : 'bg-line-strong'} ${className}`}
    >
      <span
        className="absolute top-0.5 left-0.5 size-5 rounded-full bg-white
          shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-transform duration-200"
        style={{
          transform: checked ? 'translateX(16px)' : 'translateX(0)',
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      />
    </button>
  )
}
