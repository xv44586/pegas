import { cn } from '@bui/lib/utils'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

/** Segmented control — equal-width segments, sliding thumb. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className = '',
  ariaLabel,
}: {
  options: readonly (T | SegmentedOption<T>)[]
  value: T
  onChange: (v: T) => void
  className?: string
  ariaLabel?: string
}) {
  const segments: SegmentedOption<T>[] = options.map(option =>
    typeof option === 'string' ? { value: option, label: option } : option,
  )
  const index = Math.max(
    0,
    segments.findIndex(segment => segment.value === value),
  )
  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        'relative inline-grid h-8 select-none rounded-full bg-line/60 p-0.5',
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${segments.length}, 1fr)` }}
      role="tablist"
    >
      <span
        aria-hidden
        className="absolute inset-y-0.5 rounded-full bg-surface shadow-hairline
          transition-transform duration-200"
        style={{
          width: `calc((100% - 4px) / ${segments.length})`,
          left: 2,
          transform: `translateX(${index * 100}%)`,
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      />
      {segments.map(segment => (
        <button
          key={segment.value}
          role="tab"
          aria-selected={segment.value === value}
          onClick={() => onChange(segment.value)}
          type="button"
          className={cn(
            'relative z-10 rounded-full px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-150',
            segment.value === value
              ? 'text-ink'
              : 'text-ink-3 hover:text-ink-2',
          )}
        >
          {segment.label}
        </button>
      ))}
    </div>
  )
}
