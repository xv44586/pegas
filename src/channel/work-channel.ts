import type { Run, Task, TaskEnd, TaskStatus } from '../core/domain.js'
import type { WorkerIconId } from '../brand/agent-icon.js'

export type ChannelSearchSort = 'updated' | 'created' | 'ended'

export interface ChannelSearchOptions {
  query?: string
  statuses?: TaskStatus[]
  ended?: boolean
  needsAttention?: boolean
  workerIconId?: WorkerIconId
  sort?: ChannelSearchSort
  limit: number
  cursor?: string
}

interface ChannelSearchMatch {
  channelId: string
  sourceKind: string
  sourceId: string
  snippet: string
}

export interface ChannelSearchResult {
  channels: WorkChannel[]
  matches: ChannelSearchMatch[]
  nextCursor?: string
}

type WorkState =
  | 'not_started'
  | 'queued'
  | 'running'
  | 'awaiting_input'
  | 'awaiting_approval'
  | 'awaiting_reconciliation'
  | 'awaiting_evidence'
  | 'waiting_dependency'
  | 'waiting_schedule'
  | 'waiting_provider'
  | 'blocked'
  | 'failed'
  | 'awaiting_review'
  | 'delivered'
  | 'handed_off'
  | 'closed_unfinished'
  | 'stopped'

export interface WorkWorkflow {
  state: WorkState
  resultMessageId?: string
  attentionMessageId?: string
  retryRunId?: string
}

interface WorkFacts {
  active: 'queued' | 'running' | null
  lastRunId: string | null
  lastRunStatus: Run['status'] | null
  pendingApproval: string | null
  reconciliation: string | null
  attentionMessageId: string | null
  resultMessageId: string | null
  scheduled: number
  retryBlocked: number
}

function workWorkflow(task: Task, facts: WorkFacts): WorkWorkflow {
  const { state, attention } = workflowState(task, facts)
  return {
    state,
    ...(attention && facts.attentionMessageId
      ? { attentionMessageId: facts.attentionMessageId }
      : {}),
    ...((state === 'delivered' || state === 'awaiting_review') &&
    facts.resultMessageId
      ? { resultMessageId: facts.resultMessageId }
      : {}),
    ...((state === 'failed' || state === 'waiting_provider') &&
    !facts.retryBlocked &&
    facts.lastRunStatus === 'failed' &&
    facts.lastRunId
      ? { retryRunId: facts.lastRunId }
      : {}),
  }
}

function workflowState(
  task: Task,
  facts: WorkFacts,
): { state: WorkState; attention?: boolean } {
  if (task.status === 'cancelled')
    return { state: 'stopped', attention: Boolean(facts.reconciliation) }
  if (task.statusReason === 'awaiting_user_review')
    return { state: 'awaiting_review' }
  if (task.status === 'completed') {
    if (task.statusReason === 'handed_off') return { state: 'handed_off' }
    if (task.ended?.outcome === 'dropped') return { state: 'closed_unfinished' }
    return { state: 'delivered' }
  }
  if (facts.reconciliation)
    return { state: 'awaiting_reconciliation', attention: true }
  if (facts.pendingApproval)
    return { state: 'awaiting_approval', attention: true }
  switch (task.statusReason) {
    case 'awaiting_goal_clarification':
    case 'awaiting_user_input':
      return { state: 'awaiting_input', attention: true }
    case 'awaiting_evidence':
      return { state: 'awaiting_evidence', attention: true }
    case 'waiting_on_dependency':
    case 'handed_back':
      return { state: 'waiting_dependency' }
    case 'awaiting_provider_condition':
      return { state: 'waiting_provider' }
    case 'blocked':
    case 'action_outcome_pending':
      return { state: 'blocked', attention: true }
  }
  if (facts.active) return { state: facts.active }
  if (facts.lastRunStatus === 'failed') return { state: 'failed' }
  if (facts.scheduled) return { state: 'waiting_schedule' }
  return { state: task.status === 'started' ? 'blocked' : 'not_started' }
}

/**
 * User-facing projection of the authoritative Task lifecycle.
 *
 * The first version deliberately keeps channelId equal to taskId. Keeping both
 * fields in the API makes the projection boundary explicit without migrating
 * persisted Task/Run references.
 */
export interface WorkChannel {
  id: string
  taskId: string
  userId: string
  originEventId: string
  title: string
  goal: string
  status: TaskStatus
  workerIconId: Task['workerIconId']
  statusReason?: string
  createdAt: string
  updatedAt: string
  latestActivityAt: string
  endedAt?: string
  ended?: TaskEnd
  endedKind?: TaskEnd['outcome']
  canResume: boolean
  canStop: boolean
  workflow: WorkWorkflow
}

export function projectWorkChannel(task: Task, facts: WorkFacts): WorkChannel {
  const ended = task.status === 'completed' || task.status === 'cancelled'
  return {
    id: task.id,
    taskId: task.id,
    userId: task.userId,
    originEventId: task.originEventId,
    title: task.title,
    goal: task.goal,
    status: task.status,
    workerIconId: task.workerIconId,
    ...(task.statusReason ? { statusReason: task.statusReason } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    latestActivityAt: task.updatedAt,
    ...(ended ? { endedAt: task.ended?.at ?? task.updatedAt } : {}),
    ...(task.ended ? { ended: task.ended, endedKind: task.ended.outcome } : {}),
    workflow: workWorkflow(task, facts),
    canResume: task.status === 'completed',
    canStop: ['backlog', 'unstarted', 'started'].includes(task.status),
  }
}
