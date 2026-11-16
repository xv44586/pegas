export const eventStatuses = [
  'pending',
  'processing',
  'processed',
  'failed',
] as const
export type EventStatus = (typeof eventStatuses)[number]

export const taskStatuses = [
  'inbox',
  'planning',
  'running',
  'waiting',
  'completed',
  'failed',
  'paused',
  'cancelled',
] as const
export type TaskStatus = (typeof taskStatuses)[number]

export interface InboxEvent {
  id: string
  userId: string
  type: string
  source: string
  dedupeKey?: string
  payload: unknown
  status: EventStatus
  attempts: number
  claimedBy?: string
  leaseUntil?: string
  createdAt: string
  processedAt?: string
  lastError?: string
}

export interface NewInboxEvent {
  id?: string
  userId: string
  type: string
  source: string
  dedupeKey?: string
  payload: unknown
}

export interface Task {
  id: string
  userId: string
  originEventId: string
  title: string
  goal: string
  status: TaskStatus
  statusReason?: string
  createdAt: string
  updatedAt: string
}

export const runStatuses = [
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
] as const
export type RunStatus = (typeof runStatuses)[number]

export interface Run {
  id: string
  taskId: string
  executor: string
  executorRef?: string
  resumeFromRef?: string
  status: RunStatus
  input: string
  output?: string
  attempts: number
  claimedBy?: string
  leaseUntil?: string
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface ClaimedRun {
  run: Run
  task: Task
}

export type RoutingDecision =
  | {
      kind: 'create_task'
      title: string
      goal: string
      input: string
      reason: string
    }
  | {
      kind: 'continue_task'
      taskId: string
      input: string
      reason: string
    }

export interface OutboxMessage {
  id: string
  userId: string
  taskId?: string
  channel: string
  dedupeKey: string
  payload: unknown
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown'
  createdAt: string
  sentAt?: string
}

export interface ReleaseRef {
  id: string
  root: string
  commit?: string
  createdAt: string
}

export interface SupervisorState {
  active: ReleaseRef
  previous?: ReleaseRef
  phase: 'stable' | 'verifying' | 'rolled_back'
  updatedAt: string
  lastFailure?: string
}
