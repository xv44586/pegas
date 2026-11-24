import { Check, Copy, Link2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  Button,
  StatusPill,
  StreamText,
  ThinkingState,
  ToolChips,
  type ToolDiff,
  type ToolDiffLine,
  type ToolStep,
} from '@bui/index'

import type { PegasApi } from '../api'
import type { LinkPreviewLoader } from '../LinkPreviewCard'
import { MarkdownMessage } from '../MarkdownMessage'
import type { RunActivityEntry, RunActivityReport } from '../types'
import { thinkingHeadline, toolHeadline } from './activityModel'

export type FactTone = 'green' | 'orange' | 'red' | 'accent' | 'neutral'

/** shared status-label → pill tone lookup for work rows, trays and menus */
function statusTone(label: string): FactTone {
  if (label === '已完成') return 'green'
  if (label === '失败' || label === '执行失败') return 'red'
  if (label === '进行中' || label === '执行中' || label === '已启用')
    return 'accent'
  if (label === '待确认' || label === '等待中' || label === '需要你决定')
    return 'orange'
  return 'neutral'
}

/** compact status pill for dense list rows — same tones, smaller footprint */
export function RowStatusPill({ label }: { label: string }) {
  return (
    <StatusPill
      className="h-5.5 shrink-0 px-2 text-[12px]"
      tone={statusTone(label)}
    >
      {label}
    </StatusPill>
  )
}

/** BUI drawer/chat state header: tinted pill + muted copy on the plain surface. */
export function StateHeader({
  tone,
  label,
  children,
}: {
  tone: FactTone
  label: string
  children?: React.ReactNode
}) {
  return (
    <div
      className="bui-state-header"
      style={{ animation: 'fade-up 380ms cubic-bezier(0.23,1,0.32,1) both' }}
    >
      <StatusPill tone={tone}>{label}</StatusPill>
      {children && (
        <div className="mt-2 text-[13px] leading-[1.6] text-ink-2">
          {children}
        </div>
      )}
    </div>
  )
}

/** quiet icon action for message meta rows — same slot geometry as DESIGN-005 */
export function MetaIconButton({
  label,
  title,
  accent = false,
  className = '',
  onClick,
  children,
}: {
  label: string
  title?: string
  accent?: boolean
  className?: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      aria-label={label}
      className={`${className} inline-flex h-[22px] items-center justify-center gap-[3px] rounded-[7px] px-1 transition-colors duration-100 ${
        accent
          ? 'text-accent-ink hover:bg-accent-tint'
          : 'text-ink-3 hover:bg-hover-2 hover:text-ink'
      }`}
      onClick={onClick}
      title={title ?? label}
      type="button"
    >
      {children}
    </button>
  )
}

export function WorkEntryButton({
  label,
  taskTitle,
  onClick,
}: {
  label: string
  taskTitle: string
  onClick: () => void
}) {
  return (
    <MetaIconButton
      accent
      className="message-work-entry"
      label={`${label}：${taskTitle}`}
      onClick={onClick}
      title={label}
    >
      <Link2 size={14} />
    </MetaIconButton>
  )
}

export function CopyMessageButton({
  copied,
  onCopy,
}: {
  copied: boolean
  onCopy: () => void
}) {
  return (
    <MetaIconButton
      label={copied ? '已复制' : '复制消息'}
      onClick={onCopy}
      title={copied ? '已复制' : '复制消息'}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </MetaIconButton>
  )
}

/** follow-up prompt row — same visual language as StreamingText follow-ups */
function FollowUpRow({
  text,
  index,
  onPick,
}: {
  text: string
  index: number
  onPick: (text: string) => void
}) {
  return (
    <button
      onClick={() => onPick(text)}
      className="-mx-1.5 flex items-center gap-2 rounded-[7px] border-b border-line
        px-1.5 py-1.5 text-left text-[12.5px] text-ink transition-colors
        duration-100 hover:bg-hover-2"
      style={{
        animation: `fade-up 350ms cubic-bezier(0.23,1,0.32,1) ${String(index * 90)}ms both`,
      }}
      type="button"
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--ink-3)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
        aria-hidden="true"
      >
        <path d="M9 10l-5 5 5 5" />
        <path d="M20 4v7a4 4 0 0 1-4 4H4" />
      </svg>
      {text}
    </button>
  )
}

export function FollowUpList({
  label,
  items,
  onPick,
}: {
  label: string
  items: readonly string[]
  onPick: (text: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="mt-2.5">
      <p className="text-[12px] font-medium text-ink-2">{label}</p>
      <div className="mt-0.5 flex flex-col">
        {items.map((text, index) => (
          <FollowUpRow index={index} key={text} onPick={onPick} text={text} />
        ))}
      </div>
    </div>
  )
}

/** settled/streaming say body: markdown when settled, BUI StreamText while streaming */
export function SayBody({
  text,
  streaming,
  onStreamProgress,
  linkPreviewLoader,
}: {
  text: string
  streaming: boolean
  onStreamProgress?: () => void
  linkPreviewLoader?: LinkPreviewLoader
}) {
  if (!streaming) {
    return (
      <MarkdownMessage
        content={text}
        {...(linkPreviewLoader ? { linkPreviewLoader } : {})}
      />
    )
  }
  return (
    <>
      <StreamText
        caret={false}
        className="whitespace-pre-wrap"
        text={text}
        {...(onStreamProgress ? { onProgress: onStreamProgress } : {})}
      />
      <span aria-label="正在输入" className="say-stream-caret" role="status" />
    </>
  )
}

function traceIcon(entry: RunActivityEntry): string {
  const kind = entry.semantic?.kind
  if (kind === 'shell') return 'run'
  if (kind === 'file_edit') return 'write'
  if (kind === 'file_read' || kind === 'search' || kind === 'web') return 'read'
  return 'think'
}

function detailLines(entry: RunActivityEntry): { text: string }[] {
  const source = entry.detail ?? entry.summary ?? ''
  return source
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .slice(0, 6)
    .map(text => ({
      text: text.length > 120 ? `${text.slice(0, 120)}…` : text,
    }))
}

function activityToToolSteps(entries: readonly RunActivityEntry[]): ToolStep[] {
  const seen = new Set<string>()
  const steps: ToolStep[] = []
  for (const entry of entries) {
    if (entry.kind !== 'tool_call') continue
    const headline = toolHeadline(entry)
    const label =
      entry.semantic?.kind === 'shell'
        ? '运行'
        : entry.semantic?.kind === 'file_edit'
          ? '编辑'
          : entry.semantic?.kind === 'file_read'
            ? '读取'
            : (entry.tool ?? '工具')
    const chip =
      entry.semantic?.kind === 'shell'
        ? headline.title
        : (headline.subject ?? headline.title)
    let key = `${label}:${chip}`
    let suffix = 2
    while (seen.has(key)) {
      key = `${label}:${chip}#${String(suffix)}`
      suffix += 1
    }
    seen.add(key)
    steps.push({
      icon: traceIcon(entry),
      label: `${label}${key.includes('#') ? ` ${key.split('#')[1] ?? ''}` : ''}`,
      chip,
      mono: true,
      detailMono: entry.semantic?.kind === 'shell',
      detail: detailLines(entry),
    })
  }
  return steps
}

function activityToDiffs(entries: readonly RunActivityEntry[]): {
  diffs: ToolDiff[]
  diffLines: Record<string, ToolDiffLine[]>
} {
  const diffs: ToolDiff[] = []
  const diffLines: Record<string, ToolDiffLine[]> = {}
  for (const entry of entries) {
    const semantic = entry.semantic
    if (semantic?.kind !== 'file_edit') continue
    const file = semantic.path.split('/').pop() ?? semantic.path
    if (diffLines[file]) continue
    diffs.push({
      file,
      add: semantic.additions,
      del: semantic.deletions,
    })
    diffLines[file] = semantic.hunks
      .flatMap(hunk => hunk.lines)
      .slice(0, 12)
      .map(line => ({
        text: line.text,
        tone:
          line.type === 'add'
            ? ('add' as const)
            : line.type === 'del'
              ? ('del' as const)
              : ('ctx' as const),
      }))
  }
  return { diffs, diffLines }
}

/**
 * Live agent trace in the main chat: ThinkingState header driven by the run
 * fact, ToolChips rows fed by the real run activity report. No demo clocks —
 * rows appear when the server reports them.
 */
export function RunTrace({
  api,
  runId,
  active,
  progressText,
  onOpen,
}: {
  api: PegasApi
  runId: string
  active: boolean
  progressText?: string
  onOpen: () => void
}) {
  const [report, setReport] = useState<RunActivityReport>()
  const [failed, setFailed] = useState(false)
  const loadedRef = useRef(false)

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    let cancelled = false
    const load = async () => {
      try {
        const result = await api.runActivity(runId)
        if (cancelled) return
        setReport(result)
      } catch {
        if (cancelled) return
        setFailed(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [api, runId])

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const result = await api.runActivity(runId)
          setReport(result)
          setFailed(false)
        } catch {
          setFailed(true)
        }
      })()
    }, 8000)
    return () => window.clearInterval(timer)
  }, [api, runId, active])

  const entries = report?.entries ?? []
  const thinking = entries.filter(entry => entry.kind === 'thinking')
  const latestThinking = thinking[thinking.length - 1]
  const steps = activityToToolSteps(entries)
  const { diffs, diffLines } = activityToDiffs(entries)
  const toolCount = entries.filter(entry => entry.kind === 'tool_call').length

  return (
    <div className="bui run-trace mt-3.5 w-full">
      <ThinkingState
        fill
        variant="Steps"
        working={active}
        active={progressText ?? '正在推进这件事'}
        done={
          toolCount > 0
            ? `执行了 ${String(toolCount)} 个工具`
            : '这一轮执行已结束'
        }
        rows={
          latestThinking
            ? [{ primary: thinkingHeadline(latestThinking) }]
            : [{ primary: progressText ?? '整理执行上下文' }]
        }
      />
      {steps.length > 0 && (
        <div className="mt-1">
          <ToolChips
            fill
            settle
            diffs={diffs}
            diffLines={diffLines}
            labels={{
              header: `${String(toolCount)} 次工具调用`,
              more: '',
            }}
            onOpenFile={onOpen}
            steps={steps}
          />
        </div>
      )}
      {failed && (
        <p className="mt-1 text-[12px] text-ink-3">
          执行明细暂时不可用，打开事情详情可以看到权威时间线。
        </p>
      )}
      <div className="mt-1.5">
        <Button onClick={onOpen} size="xs" variant="quiet">
          查看执行详情
        </Button>
      </div>
    </div>
  )
}
