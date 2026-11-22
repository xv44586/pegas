import type { RunActivityEntry, ToolSemantic } from '../types'

export type ActivityUnit =
  | { kind: 'entry'; key: string; entry: RunActivityEntry }
  | {
      kind: 'batch'
      key: string
      group: ActivityGroupKind
      entries: RunActivityEntry[]
    }

export type ActivityGroupKind = 'command' | 'read' | 'edit' | 'search' | 'web'

function activityGroupKind(
  entry: RunActivityEntry,
): ActivityGroupKind | undefined {
  const semantic = entry.semantic
  if (!semantic) return undefined
  switch (semantic.kind) {
    case 'shell':
      return 'command'
    case 'file_read':
      return 'read'
    case 'file_edit':
      return 'edit'
    case 'search':
      return 'search'
    case 'web':
      return 'web'
    case 'unknown':
      return undefined
  }
}

export function isDelegationEntry(entry: RunActivityEntry): boolean {
  return entry.tool === 'subagent' || entry.tool === 'subagent_fork'
}

/**
 * Groups consecutive same-kind tool calls (≥2) into one collapsible batch.
 * Text, thinking, steps, delegations and unknown tools keep their position
 * and never join a batch, so chronology stays authoritative.
 */
export function groupActivityEntries(
  entries: readonly RunActivityEntry[],
): ActivityUnit[] {
  const units: ActivityUnit[] = []
  let pending: RunActivityEntry[] = []
  let pendingGroup: ActivityGroupKind | undefined
  const flush = () => {
    if (pending.length === 0) return
    if (pending.length >= 2 && pendingGroup) {
      units.push({
        kind: 'batch',
        key: `batch-${String(pending[0]?.seq ?? 0)}`,
        group: pendingGroup,
        entries: pending,
      })
    } else {
      for (const entry of pending) {
        units.push({ kind: 'entry', key: `entry-${String(entry.seq)}`, entry })
      }
    }
    pending = []
    pendingGroup = undefined
  }
  for (const entry of entries) {
    const group =
      entry.kind === 'tool_call' && !isDelegationEntry(entry)
        ? activityGroupKind(entry)
        : undefined
    if (group && group === pendingGroup) {
      pending.push(entry)
      continue
    }
    flush()
    if (group) {
      pending = [entry]
      pendingGroup = group
    } else {
      units.push({ kind: 'entry', key: `entry-${String(entry.seq)}`, entry })
    }
  }
  flush()
  return units
}

export function batchSummary(group: ActivityGroupKind, count: number): string {
  const value = String(count)
  switch (group) {
    case 'command':
      return `运行了 ${value} 条命令`
    case 'read':
      return `读取了 ${value} 个文件`
    case 'edit':
      return `编辑了 ${value} 个文件`
    case 'search':
      return `搜索了 ${value} 次`
    case 'web':
      return `访问了 ${value} 个网页`
  }
}

export function batchRunningLabel(group: ActivityGroupKind): string {
  switch (group) {
    case 'command':
      return '正在运行命令'
    case 'read':
      return '正在读取文件'
    case 'edit':
      return '正在编辑文件'
    case 'search':
      return '正在搜索'
    case 'web':
      return '正在访问网页'
  }
}

export interface ToolHeadline {
  title: string
  subject?: string
  additions?: number
  deletions?: number
}

export function toolHeadline(entry: RunActivityEntry): ToolHeadline {
  const semantic = entry.semantic
  if (!semantic) return { title: entry.tool ?? entry.label }
  switch (semantic.kind) {
    case 'shell': {
      const command = semantic.command.replaceAll(/\s+/gu, ' ').trim()
      return { title: command }
    }
    case 'file_read':
      return {
        title: entry.status === 'started' ? '正在读取' : '已读取',
        subject: baseName(semantic.path),
      }
    case 'file_edit':
      return {
        title:
          semantic.mode === 'write'
            ? entry.status === 'started'
              ? '正在写入'
              : '已写入'
            : entry.status === 'started'
              ? '正在编辑'
              : '已编辑',
        subject: baseName(semantic.path),
        additions: semantic.additions,
        deletions: semantic.deletions,
      }
    case 'search':
      return {
        title: entry.status === 'started' ? '正在搜索' : '已搜索',
        subject: `“${semantic.query}”${semantic.path ? ` · ${baseName(semantic.path)}` : ''}`,
      }
    case 'web': {
      const target = semantic.url ?? semantic.query ?? ''
      return {
        title: entry.status === 'started' ? '正在访问' : '已访问',
        subject: displayUrl(target),
      }
    }
    case 'unknown':
      return { title: entry.tool ?? entry.label }
  }
}

function baseName(path: string): string {
  const segments = path.split('/')
  const last = segments.at(-1)
  return last === undefined || last === '' ? path : last
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return value
  }
}

export function shellFooter(entry: RunActivityEntry): {
  label: string
  tone: 'running' | 'ok' | 'error'
} {
  const semantic = entry.semantic as Extract<ToolSemantic, { kind: 'shell' }>
  if (entry.status === 'started') return { label: '执行中', tone: 'running' }
  if (semantic.interrupted) return { label: '已停止', tone: 'error' }
  if (semantic.exitCode !== undefined) {
    return semantic.exitCode === 0
      ? { label: '退出码 0', tone: 'ok' }
      : { label: `退出码 ${String(semantic.exitCode)}`, tone: 'error' }
  }
  return entry.status === 'error'
    ? { label: '失败', tone: 'error' }
    : { label: '成功', tone: 'ok' }
}

/** Flattens a diff back to unified text for copying. */
export function diffToText(
  semantic: Extract<ToolSemantic, { kind: 'file_edit' }>,
): string {
  const lines: string[] = [`--- ${semantic.path}`, `+++ ${semantic.path}`]
  for (const hunk of semantic.hunks) {
    if (hunk.oldStart !== undefined || hunk.newStart !== undefined) {
      lines.push(
        `@@ -${String(hunk.oldStart ?? '?')} +${String(hunk.newStart ?? '?')} @@`,
      )
    }
    for (const line of hunk.lines) {
      lines.push(
        `${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}${line.text}`,
      )
    }
  }
  return lines.join('\n')
}
