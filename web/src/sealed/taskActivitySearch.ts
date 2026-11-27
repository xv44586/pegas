import type { RunActivityEntry } from '../types'
import { toolHeadline } from './activityModel'

export interface TaskSearchRecord {
  id: string
  text: string
  role: 'user' | 'pegas' | 'activity'
  at: string
  label?: string
}

export interface TaskActivitySearchSnapshot {
  taskId: string
  entries: TaskSearchRecord[]
  pending: boolean
  failed: boolean
  truncated: boolean
  retry: () => void
}

/** The seq is only unique within a Run or child session, never globally. */
export function activitySearchId(
  runId: string,
  seq?: number,
  sessionId?: string,
) {
  return JSON.stringify([runId, sessionId ?? null, seq ?? null])
}

function textValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(textValues)
  if (value && typeof value === 'object')
    return Object.entries(value)
      .filter(([key]) => !['kind', 'shape', 'status'].includes(key))
      .flatMap(([, item]) => textValues(item))
  return []
}

/** Search saved record text, not DOM previews, provider secrets or external files. */
export function activitySearchRecord(
  runId: string,
  entry: RunActivityEntry,
  sessionId?: string,
): TaskSearchRecord {
  const type =
    entry.kind === 'tool_call'
      ? entry.semantic?.kind === 'todo'
        ? '规划'
        : '工具调用'
      : entry.kind === 'thinking'
        ? '思考与决策'
        : entry.kind === 'text'
          ? '中间结果'
          : '执行步骤'
  const headline = entry.kind === 'tool_call' ? toolHeadline(entry) : undefined
  return {
    id: activitySearchId(runId, entry.seq, sessionId),
    role: 'activity',
    label: `${sessionId ? '子 Agent · ' : ''}${type}${entry.tool ? ` · ${entry.tool}` : ''}`,
    at: entry.createdAt,
    text: [
      ...new Set(
        [
          entry.label,
          entry.detail,
          entry.summary,
          entry.tool,
          entry.meta?.note,
          headline?.title,
          headline?.subject,
          ...textValues(entry.semantic),
        ].filter((text): text is string => Boolean(text)),
      ),
    ].join('\n'),
  }
}

/** Reveal native nested disclosures before scrolling/focusing the original row. */
export function revealActivitySearchTarget(content: HTMLElement, id: string) {
  const row = content.querySelector<HTMLElement>(
    `[data-activity-id="${CSS.escape(id)}"]`,
  )
  if (!row) return undefined
  for (const details of row.querySelectorAll('details')) details.open = true
  let ancestor: HTMLElement | null = row
  while (ancestor && ancestor !== content) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
    ancestor = ancestor.parentElement
  }
  if ('scrollIntoView' in row)
    row.scrollIntoView({ block: 'center', behavior: 'instant' })
  row.focus({ preventScroll: true })
  return row
}
