type EventStatus = 'pending' | 'processing' | 'processed' | 'failed'

export type TaskStatus =
  'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'

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

type RunStatus =
  'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

export interface Run {
  id: string
  taskId: string
  retryOfRunId?: string
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
  attempts: number
  claimedBy?: string
  leaseUntil?: string
  nextAttemptAt?: string
  lastError?: string
  createdAt: string
  updatedAt: string
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
