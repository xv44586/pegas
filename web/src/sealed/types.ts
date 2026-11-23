import type {
  Approval,
  BehaviorPreferences,
  ChannelSearchSort,
  ChannelTimeline,
  ChannelRelation,
  ConversationProjection,
  DurableAction,
  ExecutionNode,
  GoalContract,
  ModelUsageRecord,
  ModelUsageReport,
  OutboxMessage,
  ReviewProjection,
  Run,
  RunActivityReport,
  RunSubagentReport,
  SettingsResponse,
  Snapshot,
  TaskDelivery,
  WorkChannel,
  WorkerProfileResponse,
  WorkRuleRecord,
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
      automationActive?: boolean
      timeline?: ChannelTimeline
      timelineError?: string
      delivery?: TaskDelivery
      deliveryError?: string
      workerProfile?: WorkerProfileResponse
      workerProfileError?: string
      collaborations?: ChannelRelation[]
      collaborationsError?: string
      usage?: {
        totalTokens?: number
        durationMs?: number
        costUsd?: number
        records?: ModelUsageRecord[]
      }
      activityByRun?: Record<string, RunActivityReport>
      activityErrorByRun?: Record<string, string>
      subagentsByRun?: Record<string, RunSubagentReport>
      subagentErrorByRun?: Record<string, string>
    }
  | { kind: 'runtime'; run?: Run; nodes?: ExecutionNode[]; nodesError?: string }
  | { kind: 'message'; message: OutboxMessage }
  | {
      kind: 'approval'
      approval: Approval
      action: DurableAction
      message: OutboxMessage
      decisionError?: string
    }
  | {
      kind: 'reconciliation'
      action: DurableAction
      message: OutboxMessage
    }
  | {
      kind: 'review'
      review: ReviewProjection
      channel: WorkChannel
      message: OutboxMessage
      goal?: GoalContract
    }
  | {
      kind: 'clarification'
      questions: string[]
      channel: WorkChannel
      message: OutboxMessage
    }
  | {
      kind: 'rule'
      title: string
      rule?: WorkRuleRecord
      behavior?: BehaviorPreferences
      onSaved?: () => void
    }
  | {
      kind: 'preview'
      preview: 'file' | 'image' | 'video' | 'web'
      title: string
      description?: string
      mimeType?: string
      source?: string
      url?: string
      contentUrl?: string
      backLabel?: string
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
  if (payloadType(payload) === 'run.progress') return ''
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

export interface AttentionSummary {
  title: string
  preview?: string
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  return payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)
    : undefined
}

function payloadString(
  payload: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = payload?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function truncateText(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value
}

function plainMarkdownLine(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}\s+/u, '')
    .replace(/^\s{0,3}>\s?/u, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/(\*\*|__|~~|\*|_|`)/gu, '')
    .replace(/<[^>]+>/gu, '')
    .trim()
}

function plainMarkdown(value: string): {
  text: string
  firstLine: string
  heading: boolean
} {
  const rawLines = value.split(/\r?\n/u)
  const firstRawLine = rawLines.find(line => line.trim()) ?? ''
  const lines = rawLines.map(plainMarkdownLine).filter(Boolean)
  return {
    text: lines.join(' '),
    firstLine: lines[0] ?? '',
    heading: /^\s{0,3}#{1,6}\s+/u.test(firstRawLine),
  }
}

function attentionBodyText(payload: unknown): string {
  const record = payloadRecord(payload)
  for (const key of ['text', 'message', 'content', 'output', 'error']) {
    const value = payloadString(record, key)
    if (value) return value
  }
  return textFromPayload(payload)
}

function splitAttentionText(
  plain: ReturnType<typeof plainMarkdown>,
): AttentionSummary {
  if (!plain.text) return { title: 'Pegas 有一项更新' }
  if (plain.heading && plain.firstLine) {
    const rest = plain.text.slice(plain.firstLine.length).trim()
    return {
      title: truncateText(plain.firstLine, 80),
      ...(rest ? { preview: truncateText(rest, 160) } : {}),
    }
  }
  const sentence = /[。！？!?]/u.exec(plain.text)
  if (sentence && sentence.index < 120) {
    const title = plain.text.slice(0, sentence.index + 1)
    const rest = plain.text.slice(sentence.index + 1).trim()
    return {
      title: truncateText(title, 80),
      ...(rest ? { preview: truncateText(rest, 160) } : {}),
    }
  }
  return { title: truncateText(plain.text, 80) }
}

export function attentionSummary(message: OutboxMessage): AttentionSummary {
  const record = payloadRecord(message.payload)
  const explicit =
    payloadString(record, 'title') ?? payloadString(record, 'summary')
  const body = attentionBodyText(message.payload)
  const plain = plainMarkdown(body)
  if (explicit) {
    const title = truncateText(plainMarkdownLine(explicit), 80)
    const previewSource =
      plain.text && plain.text !== plainMarkdownLine(explicit)
        ? splitAttentionText(plain).title
        : undefined
    return {
      title,
      ...(previewSource && previewSource !== title
        ? { preview: truncateText(previewSource, 160) }
        : {}),
    }
  }
  return splitAttentionText(plain)
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
    case 'action.failed':
      return 'failed'
    case 'run.completed':
    case 'review.ready':
      return 'result'
    case 'approval.required':
    case 'approval.requested':
      return 'approval'
    case 'input.required':
    case 'input.requested':
    case 'goal.clarification_required':
    case 'goal.evidence_required':
    case 'run.blocked':
    case 'run.waiting':
    case 'action.outcome_unknown':
    case 'action.reconciliation_required':
      return 'input'
    default:
      return 'update'
  }
}

export function isAttentionMessage(message: OutboxMessage): boolean {
  return attentionKind(message) !== 'update'
}

export function unresolvedAttentionMessages(
  messages: readonly OutboxMessage[],
): OutboxMessage[] {
  const resolvedApprovalIds = new Set(
    messages
      .filter(message => payloadType(message.payload) === 'approval.resolved')
      .map(approvalIdFromMessage)
      .filter((id): id is string => Boolean(id)),
  )
  return messages.filter(message => {
    if (!isAttentionMessage(message)) return false
    if (attentionKind(message) !== 'approval') return true
    const approvalId = approvalIdFromMessage(message)
    return !approvalId || !resolvedApprovalIds.has(approvalId)
  })
}

export function runIdFromMessage(message: OutboxMessage): string | undefined {
  if (!message.payload || typeof message.payload !== 'object') return undefined
  const runId = (message.payload as Record<string, unknown>).runId
  return typeof runId === 'string' && runId.trim() ? runId : undefined
}

export type AttentionActionKind = 'confirm' | 'answer' | 'review' | 'reconcile'

export type AttentionSectionId = 'todo' | 'failed' | 'activity'

export function attentionActionKind(
  message: OutboxMessage,
): AttentionActionKind | undefined {
  if (
    needsOutboxResolution(message) ||
    isReconciliationMessage(message) ||
    payloadType(message.payload) === 'action.outcome_unknown'
  )
    return 'reconcile'
  switch (attentionKind(message)) {
    case 'approval':
      return 'confirm'
    case 'input':
      return 'answer'
    case 'result':
      return payloadType(message.payload) === 'review.ready'
        ? 'review'
        : undefined
    default:
      return undefined
  }
}

export function attentionSection(
  message: OutboxMessage,
): AttentionSectionId | undefined {
  if (attentionActionKind(message)) return 'todo'
  const kind = attentionKind(message)
  if (kind === 'failed') return 'failed'
  if (kind === 'result') return 'activity'
  return undefined
}

export interface AttentionGroup {
  key: string
  taskId?: string
  section: 'failed' | 'activity'
  messages: OutboxMessage[]
  latest: OutboxMessage
  unreadCount: number
}

export interface AttentionBoard {
  todo: OutboxMessage[]
  failed: AttentionGroup[]
  activity: AttentionGroup[]
  totalNotifications: number
  totalUnread: number
  totalThings: number
}

const ATTENTION_ACTIVITY_PAGE_SIZE = 20

function attentionTimestamp(message: OutboxMessage): number {
  const parsed = Date.parse(message.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

function byNewestAttention(left: OutboxMessage, right: OutboxMessage): number {
  return attentionTimestamp(right) - attentionTimestamp(left)
}

function groupAttentionMessages(
  messages: readonly OutboxMessage[],
  section: 'failed' | 'activity',
): AttentionGroup[] {
  const groups = new Map<string, AttentionGroup>()
  for (const message of messages) {
    const key = message.taskId ?? `message:${message.id}`
    const existing = groups.get(key)
    if (existing) {
      existing.messages.push(message)
      continue
    }
    groups.set(key, {
      key: `${section}:${key}`,
      ...(message.taskId ? { taskId: message.taskId } : {}),
      section,
      messages: [message],
      latest: message,
      unreadCount: 0,
    })
  }
  const result = [...groups.values()]
  for (const group of result) {
    group.messages.sort(byNewestAttention)
    const [latest] = group.messages
    if (latest) group.latest = latest
    group.unreadCount = group.messages.filter(message => !message.readAt).length
  }
  result.sort(
    (left, right) =>
      attentionTimestamp(right.latest) - attentionTimestamp(left.latest),
  )
  return result
}

export function attentionBoard(
  messages: readonly OutboxMessage[],
): AttentionBoard {
  const unresolved = unresolvedAttentionMessages(messages)
  const todo: OutboxMessage[] = []
  const failed: OutboxMessage[] = []
  const activity: OutboxMessage[] = []
  for (const message of unresolved) {
    const section = attentionSection(message)
    if (section === 'todo') todo.push(message)
    else if (section === 'failed') failed.push(message)
    else if (section === 'activity') activity.push(message)
  }
  todo.sort(byNewestAttention)
  const failedGroups = groupAttentionMessages(failed, 'failed')
  const activityGroups = groupAttentionMessages(activity, 'activity')
  return {
    todo,
    failed: failedGroups,
    activity: activityGroups,
    totalNotifications: unresolved.length,
    totalUnread: unresolved.filter(message => !message.readAt).length,
    totalThings: todo.length + failedGroups.length + activityGroups.length,
  }
}

export interface AttentionPageSlice {
  page: number
  pageCount: number
  groups: AttentionGroup[]
  rangeStart: number
  rangeEnd: number
}

export function attentionActivityPage(
  groups: readonly AttentionGroup[],
  requestedPage: number,
  pageSize: number = ATTENTION_ACTIVITY_PAGE_SIZE,
): AttentionPageSlice {
  const pageCount = Math.max(1, Math.ceil(groups.length / pageSize))
  const page = Math.min(Math.max(1, Math.floor(requestedPage)), pageCount)
  const start = (page - 1) * pageSize
  const slice = groups.slice(start, start + pageSize)
  return {
    page,
    pageCount,
    groups: slice,
    rangeStart: groups.length ? start + 1 : 0,
    rangeEnd: start + slice.length,
  }
}

const terminalCueTypes = new Set([
  'run.completed',
  'run.failed',
  'review.ready',
])

export interface TaskContextCue {
  title: string
}

export function taskContextCue(
  message: OutboxMessage,
  channels: readonly WorkChannel[],
): TaskContextCue | undefined {
  const type = payloadType(message.payload)
  if (!type || !terminalCueTypes.has(type) || !message.taskId) return undefined
  const channel = channels.find(item => item.id === message.taskId)
  if (!channel) return undefined
  return { title: channel.title }
}

export function isRunProgressMessage(message: OutboxMessage): boolean {
  return payloadType(message.payload) === 'run.acknowledged'
}

/**
 * CONV-006: a message stays out of the chat stream when the server
 * projection marks it silent. Old servers without projection attributes
 * fall back to the legacy payload-type filter so nothing breaks or floods.
 */
export function isSilentConversationMessage(message: OutboxMessage): boolean {
  const projection: ConversationProjection | undefined = message.projection
  if (projection) return projection.weight === 'silent'
  const type = payloadType(message.payload)
  return type === 'run.progress' || type === 'run.acknowledged'
}

export type ConversationLane = ConversationProjection['lane']

/**
 * CONV-006: the render lane comes from the server projection. Without
 * projection attributes (old server) the client falls back to a compatible
 * default: everything stays inline text, exactly the pre-projection UI.
 */
export function conversationLane(message: OutboxMessage): ConversationLane {
  return message.projection?.lane ?? 'say'
}

/**
 * EXEC-005: server fact only. A streaming say draft carries `streaming:true`
 * while the Run is still producing body text; the settled fact drops it.
 * Clients never infer streaming from payload text.
 */
export function isStreamingSayMessage(message: OutboxMessage): boolean {
  const record = payloadRecord(message.payload)
  return (
    payloadType(message.payload) === 'agent.message' &&
    record?.streaming === true
  )
}

/**
 * DESIGN-008: server fact only. A run.completed payload carries
 * automationActive when an active automation still targets the Task, so the
 * Run ending must not read as the whole thing being finished.
 */
export function hasActiveAutomationFact(
  payload: OutboxMessage['payload'],
): boolean {
  const record = payloadRecord(payload)
  return (
    payloadType(payload) === 'run.completed' &&
    record?.automationActive === true
  )
}

/**
 * DESIGN-008: the drawer hero reads the latest terminal run.completed fact
 * for the Task. Older completion facts never override a newer one.
 */
export function taskAutomationActive(
  messages: readonly OutboxMessage[],
  taskId: string,
): boolean {
  let latest: OutboxMessage | undefined
  for (const message of messages) {
    if (message.taskId !== taskId) continue
    if (payloadType(message.payload) !== 'run.completed') continue
    if (
      !latest ||
      Date.parse(message.createdAt) >= Date.parse(latest.createdAt)
    )
      latest = message
  }
  return latest ? hasActiveAutomationFact(latest.payload) : false
}

export interface ConversationAnchor {
  taskId: string
  eventId?: string
}

/** Server anchor only; never inferred from payload text. */
export function conversationAnchor(
  message: OutboxMessage,
): ConversationAnchor | undefined {
  return message.projection?.anchor
}

/** True when a later fact in the same stream resolves this decision. */
export function isResolvedDecisionMessage(
  message: OutboxMessage,
  messages: readonly OutboxMessage[],
): boolean {
  if (conversationLane(message) !== 'decide') return false
  const type = payloadType(message.payload)
  if (type === 'approval.required' || type === 'approval.requested') {
    const approvalId = approvalIdFromMessage(message)
    if (!approvalId) return false
    return messages.some(
      item =>
        payloadType(item.payload) === 'approval.resolved' &&
        approvalIdFromMessage(item) === approvalId,
    )
  }
  if (
    type === 'action.reconciliation_required' ||
    type === 'action.outcome_unknown'
  ) {
    const actionId = actionIdFromMessage(message)
    if (!actionId) return false
    return messages.some(
      item =>
        payloadType(item.payload) === 'action.reconciled' &&
        actionIdFromMessage(item) === actionId,
    )
  }
  return false
}

export function latestRunProgressText(
  messages: readonly OutboxMessage[],
  runId: string,
): string | undefined {
  let latest: OutboxMessage | undefined
  for (const message of messages) {
    if (!isRunProgressMessage(message)) continue
    if (runIdFromMessage(message) !== runId) continue
    if (
      !latest ||
      Date.parse(message.createdAt) >= Date.parse(latest.createdAt)
    )
      latest = message
  }
  return latest ? textFromPayload(latest.payload) : undefined
}

export function formatRunDuration(run: Run): string {
  const started = Date.parse(run.createdAt)
  const ended = Date.parse(run.updatedAt)
  if (Number.isNaN(started) || Number.isNaN(ended) || ended < started) return ''
  const totalSeconds = Math.round((ended - started) / 1000)
  if (totalSeconds < 60) return `${String(totalSeconds)} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60)
    return seconds > 0
      ? `${String(minutes)} 分 ${String(seconds)} 秒`
      : `${String(minutes)} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0
    ? `${String(hours)} 小时 ${String(remainingMinutes)} 分`
    : `${String(hours)} 小时`
}

export function approvalIdFromMessage(
  message: OutboxMessage,
): string | undefined {
  if (!message.payload || typeof message.payload !== 'object') return undefined
  const approvalId = (message.payload as Record<string, unknown>).approvalId
  return typeof approvalId === 'string' && approvalId.trim()
    ? approvalId
    : undefined
}

export function actionIdFromMessage(
  message: OutboxMessage,
): string | undefined {
  if (!message.payload || typeof message.payload !== 'object') return undefined
  const actionId = (message.payload as Record<string, unknown>).actionId
  return typeof actionId === 'string' && actionId.trim() ? actionId : undefined
}

export function isReconciliationMessage(message: OutboxMessage): boolean {
  return (
    payloadType(message.payload) === 'action.reconciliation_required' &&
    Boolean(actionIdFromMessage(message))
  )
}

export function needsOutboxResolution(message: OutboxMessage): boolean {
  return (
    !message.resolution &&
    (message.status === 'failed' || message.status === 'unknown')
  )
}

export function clarificationQuestions(
  message: OutboxMessage,
): string[] | undefined {
  if (payloadType(message.payload) !== 'goal.clarification_required')
    return undefined
  const questions = (message.payload as Record<string, unknown>).questions
  if (!Array.isArray(questions)) return undefined
  const parsed = questions.filter(
    (question): question is string =>
      typeof question === 'string' && Boolean(question.trim()),
  )
  return parsed.length ? parsed : undefined
}

export function reviewProjection(
  message: OutboxMessage,
): ReviewProjection | undefined {
  if (payloadType(message.payload) !== 'review.ready') return undefined
  const review = (message.payload as Record<string, unknown>).review
  if (!review || typeof review !== 'object') return undefined
  const candidate = review as Partial<ReviewProjection>
  if (
    !Array.isArray(candidate.criteria) ||
    !Array.isArray(candidate.evidence) ||
    typeof candidate.finalOutcome !== 'string'
  )
    return undefined
  return review as ReviewProjection
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

function channelSortTimestamp(
  channel: WorkChannel,
  sort: ChannelSearchSort,
): number {
  const value =
    sort === 'created'
      ? channel.createdAt
      : sort === 'ended'
        ? (channel.endedAt ?? channel.updatedAt)
        : channel.latestActivityAt
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

export function sortWorkChannels(
  channels: readonly WorkChannel[],
  sort: ChannelSearchSort,
): WorkChannel[] {
  return [...channels].sort((left, right) => {
    const delta =
      channelSortTimestamp(right, sort) - channelSortTimestamp(left, sort)
    if (delta !== 0) return delta
    return left.id < right.id ? 1 : left.id > right.id ? -1 : 0
  })
}

export function statusLabel(channel: WorkChannel, run?: Run): string {
  if (channel.status === 'cancelled') return '已归档'
  if (run) return runStatusLabel(run)
  return channel.status === 'completed' ? '已完成' : '等待中'
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
