import type {
  ChannelTimeline,
  ModelUsageReport,
  OutboxMessage,
  Run,
  SettingsResponse,
  Snapshot,
  WorkChannel,
} from '../types'

export type AppPage =
  'conversation' | 'work' | 'attention' | 'automation' | 'memory' | 'settings'

export type ThemeChoice = 'system' | 'light' | 'warm' | 'dark'

export type SettingsSection =
  | 'pegas'
  | 'appearance'
  | 'models'
  | 'router'
  | 'voice'
  | 'connections'
  | 'memory'
  | 'privacy'
  | 'notifications'
  | 'usage'
  | 'recovery'
  | 'about'

export type DrawerView =
  | {
      kind: 'task'
      channel: WorkChannel
      run?: Run
      selectedRunId?: string
      runs?: Run[]
      timeline?: ChannelTimeline
      timelineError?: string
      usage?: {
        totalTokens?: number
        durationMs?: number
        costUsd?: number
      }
    }
  | { kind: 'runtime'; run?: Run }
  | { kind: 'message'; message: OutboxMessage }
  | { kind: 'rule'; title: string }
  | {
      kind: 'preview'
      preview: 'file' | 'image' | 'video' | 'web'
      title: string
      description?: string
      mimeType?: string
      source?: string
      url?: string
    }

export interface AppData {
  snapshot: Snapshot
  settings?: SettingsResponse
  usage?: ModelUsageReport
  usageError?: string
}

export const emptySnapshot: Snapshot = {
  channels: [],
  events: [],
  messages: [],
  runs: [],
}

export const settingsSections: readonly {
  id: SettingsSection
  label: string
}[] = [
  { id: 'pegas', label: 'Pegas' },
  { id: 'appearance', label: '外观' },
  { id: 'models', label: '模型服务' },
  { id: 'router', label: '事情归类' },
  { id: 'voice', label: '语音与输入' },
  { id: 'connections', label: '能力与连接' },
  { id: 'memory', label: '记忆' },
  { id: 'privacy', label: '隐私' },
  { id: 'notifications', label: '通知' },
  { id: 'usage', label: '模型用量' },
  { id: 'recovery', label: '数据与恢复' },
  { id: 'about', label: '关于' },
]

export function textFromPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (!payload || typeof payload !== 'object') return ''
  const value = payload as Record<string, unknown>
  for (const key of [
    'text',
    'message',
    'content',
    'summary',
    'output',
    'error',
  ]) {
    if (typeof value[key] === 'string') return value[key]
  }
  return ''
}

function payloadType(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const type = (payload as Record<string, unknown>).type
  return typeof type === 'string' ? type : undefined
}

export type AttentionKind =
  'approval' | 'input' | 'failed' | 'result' | 'update'

export function attentionKind(message: OutboxMessage): AttentionKind {
  switch (payloadType(message.payload)) {
    case 'run.failed':
      return 'failed'
    case 'run.completed':
      return 'result'
    case 'approval.required':
    case 'approval.requested':
      return 'approval'
    case 'input.required':
    case 'input.requested':
      return 'input'
    default:
      return 'update'
  }
}

export function isAttentionMessage(message: OutboxMessage): boolean {
  return attentionKind(message) !== 'update'
}

export function runIdFromMessage(message: OutboxMessage): string | undefined {
  if (!message.payload || typeof message.payload !== 'object') return undefined
  const runId = (message.payload as Record<string, unknown>).runId
  return typeof runId === 'string' && runId.trim() ? runId : undefined
}

export function latestRunForTask(
  runs: readonly Run[],
  taskId: string,
): Run | undefined {
  let latest: Run | undefined
  for (const run of runs) {
    if (run.taskId !== taskId) continue
    if (!latest || Date.parse(run.updatedAt) >= Date.parse(latest.updatedAt))
      latest = run
  }
  return latest
}

export function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return '刚刚'
  const delta = Date.now() - timestamp
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${String(Math.floor(delta / 60_000))} 分钟前`
  if (delta < 86_400_000)
    return `${String(Math.floor(delta / 3_600_000))} 小时前`
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

export function statusLabel(channel: WorkChannel, run?: Run): string {
  if (channel.status === 'cancelled') return '已归档'
  if (channel.status === 'completed') return '已完成'
  return run ? runStatusLabel(run) : '等待中'
}

export function runStatusLabel(run: Run): string {
  switch (run.status) {
    case 'failed':
      return '失败'
    case 'waiting':
      return '等待中'
    case 'running':
    case 'queued':
      return '进行中'
    case 'completed':
      return '已完成'
    case 'cancelled':
      return '已归档'
  }
}
