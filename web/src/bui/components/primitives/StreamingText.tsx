import { FollowUpList } from './FollowUpList'
import type * as React from 'react'
import { useEffect, useState } from 'react'

/* ─────────────────────────────────────────────────────────
 * STREAMING TEXT
 * Words resolve out of blur, inline citations appear in
 * context, then actions and follow-up prompts become usable.
 * ───────────────────────────────────────────────────────── */

const WORD_MS = 55
const HOLD_MS = 3400

/* one streamed word, or a `cite` placeholder that renders an inline source chip */
export interface StreamingToken {
  text: string
  cite?: boolean
}

const TOKENS: StreamingToken[] = [
  ...Array.from('本周执行次数比上周多了 23%，平均耗时下降 8%。').map(text => ({
    text,
  })),
  { text: '', cite: true },
  ...Array.from('夜间自动化贡献了大部分增量。').map(text => ({ text })),
]

const FOLLOW_UPS = ['哪些自动化最耗时', '对比夜间与白天的执行成功率']

const SOURCE_IMAGES = {
  scoop:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%231f7a5f'/%3E%3Cpath d='M20 36c0 7 5.4 12 12 12s12-5 12-12H20Z' fill='%23fff'/%3E%3Ccircle cx='32' cy='25' r='11' fill='%23bff3dd'/%3E%3Cpath d='M24 24c4-7 13-7 17 0' fill='none' stroke='%231f7a5f' stroke-width='4' stroke-linecap='round'/%3E%3C/svg%3E",
  trends:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%232f6fec'/%3E%3Cpath d='M15 43 27 31l8 7 14-18' fill='none' stroke='%23fff' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='49' cy='20' r='5' fill='%23bfe0ff'/%3E%3C/svg%3E",
  market:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%23e56d24'/%3E%3Cpath d='M17 45V25h8v20h-8Zm11 0V16h8v29h-8Zm11 0V30h8v15h-8Z' fill='%23fff'/%3E%3Cpath d='M16 49h32' stroke='%23ffd6b8' stroke-width='4' stroke-linecap='round'/%3E%3C/svg%3E",
}

/* one cited source rendered as an inline chip and in the sources list */
export interface StreamingSource {
  name: string
  domain: string
  href: string
  image: string
}

const SOURCES: StreamingSource[] = [
  {
    name: '执行指标',
    domain: 'metrics.pegas.local',
    href: 'https://example.com/metrics',
    image: SOURCE_IMAGES.scoop,
  },
  {
    name: '趋势索引',
    domain: 'trends.pegas.local',
    href: 'https://example.com/trends',
    image: SOURCE_IMAGES.trends,
  },
  {
    name: '运行日志',
    domain: 'runs.pegas.local',
    href: 'https://example.com/runs',
    image: SOURCE_IMAGES.market,
  },
]

function sourceImage(source: StreamingSource) {
  return source.image
}

function SourceChip({ source }: { source?: StreamingSource }) {
  if (!source) return null
  return (
    <a
      href={source.href}
      target="_blank"
      rel="noreferrer"
      className="ml-0 mr-1 inline-flex h-4.5 translate-y-[-1px] items-center gap-1 rounded-[5px]
        bg-inset pr-[3px] pl-[3px] align-middle font-mono text-[10.5px] text-ink-2 shadow-hairline
        transition-colors duration-150 hover:bg-hover hover:text-ink"
      style={{ animation: 'pop-in 250ms cubic-bezier(0.23,1,0.32,1) both' }}
    >
      <img
        src={sourceImage(source)}
        alt=""
        className="source-avatar size-3 rounded-[3px]"
      />
      <span>{source.domain}</span>
    </a>
  )
}

const ACTION_ICONS: React.ReactNode[] = [
  <g key="copy">
    <rect x="9" y="9" width="12" height="12" rx="2.5" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </g>,
  <path key="retry" d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />,
  <path
    key="up"
    d="M7 10v12M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z"
  />,
  <path
    key="down"
    d="M17 14V2M9 18.12L10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88z"
  />,
]

export interface StreamingLabels {
  /** label on the collapsed sources toggle */
  sources: string
  /** heading above the follow-up prompts */
  followUps: string
  /** accessible names for the action row */
  copy: string
  copied: string
  retry: string
  helpful: string
  notHelpful: string
}

const DEFAULT_LABELS: StreamingLabels = {
  sources: '3 个来源',
  followUps: '继续追问',
  copy: '复制回复',
  copied: '已复制',
  retry: '重新生成',
  helpful: '有帮助',
  notHelpful: '没帮助',
}

export default function StreamingText({
  content = TOKENS,
  sources = SOURCES,
  followUps = FOLLOW_UPS,
  labels,
  loop = true,
  fill = false,
  settle = false,
  onCopy,
  onRetry,
  onFeedback,
  onDone,
  onFollowUp,
}: {
  variant?: string
  /** the streamed tokens; `cite` tokens render an inline source chip */
  content?: StreamingToken[]
  /** cited sources shown in the chip, avatar stack, and expanded list */
  sources?: StreamingSource[]
  /** follow-up prompt suggestions shown once the stream completes */
  followUps?: string[]
  /** prominent copy strings */
  labels?: Partial<StreamingLabels>
  /** restart the stream after a hold; turn off when embedding in a real thread */
  loop?: boolean
  /** fill the parent width instead of the gallery's fixed measure */
  fill?: boolean
  /** render the settled fact immediately — no reveal clock */
  settle?: boolean
  /** host copy handler for the settled reply */
  onCopy?: () => Promise<void> | void
  /** host retry handler; the action hides when absent */
  onRetry?: () => void
  /** host feedback handler; the actions hide when absent */
  onFeedback?: (helpful: boolean) => void
  onDone?: () => void
  /** fired when a follow-up prompt is chosen */
  onFollowUp?: (text: string, index: number) => void
} = {}) {
  const l = { ...DEFAULT_LABELS, ...labels }
  const [count, setCount] = useState(0)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const done = settle || count >= content.length

  useEffect(() => {
    if (settle) return
    if (done && !loop) {
      onDone?.()
      return
    }
    const t = setTimeout(
      () => setCount(c => (c >= content.length ? 0 : c + 1)),
      done ? HOLD_MS : WORD_MS,
    )
    return () => clearTimeout(t)
  }, [count, done, loop, settle])

  useEffect(() => {
    if (settle) onDone?.()
  }, [settle, onDone])

  const shown = settle ? content : content.slice(0, count)

  return (
    <div className={fill ? 'w-full' : 'min-h-[15.5rem] w-full max-w-95'}>
      <p className="text-[13px] leading-relaxed text-ink">
        {shown.map((token, i) =>
          token.cite ? (
            <SourceChip key={i} source={sources[0]} />
          ) : (
            <span key={i} className="inline">
              {token.text}
            </span>
          ),
        )}
        {!done && (
          <span
            className="ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 rounded-full bg-ink"
            style={{ animation: 'fade-in 150ms ease-out both' }}
          />
        )}
      </p>

      {/* action icons row */}
      <div
        className="mt-2 flex items-center gap-0.5 transition-opacity duration-400"
        style={{ opacity: done ? 1 : 0, pointerEvents: done ? 'auto' : 'none' }}
      >
        {[
          {
            key: 'copy',
            label: copied ? l.copied : l.copy,
            show: onCopy !== undefined,
            press: () => {
              void (async () => {
                await onCopy?.()
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              })()
            },
          },
          {
            key: 'retry',
            label: l.retry,
            show: onRetry !== undefined,
            press: () => onRetry?.(),
          },
          {
            key: 'up',
            label: l.helpful,
            show: onFeedback !== undefined,
            press: () => onFeedback?.(true),
          },
          {
            key: 'down',
            label: l.notHelpful,
            show: onFeedback !== undefined,
            press: () => onFeedback?.(false),
          },
        ].map((action, i) =>
          action.show ? (
            <button
              key={action.key}
              type="button"
              aria-label={action.label}
              onClick={action.press}
              className="flex size-6 items-center justify-center rounded-[6px] text-ink-3
              transition-colors duration-100 hover:bg-hover-2 hover:text-ink-2"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {ACTION_ICONS[i]}
              </svg>
            </button>
          ) : null,
        )}
        {sources.length > 0 && (
          <button
            type="button"
            aria-expanded={sourcesOpen}
            onClick={() => setSourcesOpen(current => !current)}
            className="ml-1.5 flex items-center gap-1.5 rounded-[6px] px-1 py-0.5 text-left transition-colors duration-150 hover:bg-hover"
          >
            <span className="flex -space-x-1">
              {sources.map(source => (
                <img
                  key={source.domain}
                  src={sourceImage(source)}
                  alt=""
                  className="source-avatar size-3.5 rounded-full bg-surface shadow-[0_0_0_1.5px_var(--canvas)]"
                />
              ))}
            </span>
            <span className="text-[12px] text-ink-2">{l.sources}</span>
          </button>
        )}
      </div>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: done && sourcesOpen ? '1fr' : '0fr',
          opacity: done && sourcesOpen ? 1 : 0,
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      >
        <div className="overflow-hidden">
          <div className="mt-1.5 flex flex-col rounded-[10px] bg-inset p-1 shadow-hairline">
            {sources.map(source => (
              <a
                key={source.domain}
                href={source.href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-[6px] px-1.5 py-1 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
              >
                <img
                  src={sourceImage(source)}
                  alt=""
                  className="source-avatar size-4 rounded-[4px]"
                />
                <span className="animated-underline">{source.name}</span>
                <span className="ml-auto font-mono text-[10.5px] text-ink-3">
                  {source.domain}
                </span>
              </a>
            ))}
          </div>
        </div>
      </div>

      {done && (
        <FollowUpList
          items={followUps}
          label={l.followUps}
          onSelect={onFollowUp}
        />
      )}
    </div>
  )
}
