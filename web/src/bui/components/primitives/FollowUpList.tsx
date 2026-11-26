import { CornerDownLeft } from 'lucide-react'
import { useId } from 'react'

/** The StreamingText follow-up rows, shared with durable conversation replies. */
export function FollowUpList({
  items,
  onSelect,
  label = '继续深入',
  disabledReason,
}: {
  items: readonly string[]
  onSelect?: (text: string, index: number) => void
  label?: string
  disabledReason?: string
}) {
  const labelId = useId()
  const hintId = useId()
  if (!items.length) return null
  return (
    <div className="bui mt-2.5 max-w-[560px] min-w-0">
      <p id={labelId} className="text-[12px] font-medium text-ink-2">
        {label}
      </p>
      <ul
        aria-labelledby={labelId}
        role="list"
        className="mt-0.5 flex list-none flex-col p-0"
      >
        {items.map((text, index) => (
          <li key={text}>
            <button
              type="button"
              aria-disabled={disabledReason ? true : undefined}
              aria-describedby={disabledReason ? hintId : undefined}
              onClick={() => {
                if (!disabledReason) onSelect?.(text, index)
              }}
              className="flex min-h-9 w-full items-center gap-2 rounded-[7px] border-b border-line px-1.5 py-1.5 text-left text-[12.5px] text-ink transition-colors duration-100 hover:bg-hover-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-disabled:opacity-60"
            >
              <CornerDownLeft
                size={13}
                className="shrink-0 text-ink-3"
                aria-hidden="true"
              />
              <span className="min-w-0 break-words">{text}</span>
            </button>
          </li>
        ))}
      </ul>
      {disabledReason && (
        <p id={hintId} className="mt-1 text-[12px] text-ink-2">
          {disabledReason}
        </p>
      )}
    </div>
  )
}
