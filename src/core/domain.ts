import type { WorkerIconId } from '../brand/agent-icon.js'

type EventStatus = 'pending' | 'processing' | 'processed' | 'failed'

export type TaskStatus =
  'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'

interface ActorRef {
  source: string
  id: string
}

interface MandateBasis {
  source: string
  scope: Record<string, unknown>
  via: 'direct' | 'router'
  sender?: string
  rules?: string[]
}

export interface Mandate {
  strength: 'explicit' | 'inferred'
  policyVersion: string
  basis: MandateBasis
  actor: ActorRef
  scope: string
}

export interface TaskEnd {
  at: string
  by: 'executor' | 'human'
  outcome: 'completed' | 'dropped' | 'stopped'
  reason?: string
}

export interface ExecutionContext {
  executor: string
  executorProfile?: string
  workspace?: string
  model?: string
  modelMode?: 'profile' | 'override'
  modelProvider?: string
  modelName?: string
  permissions?: string
  protocol?: string
  settingsRevision?: number
  workerProfile?: string
  workerProfileRevision?: number
  workerProfileSource?: 'global' | 'task'
}

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
  workerIconId: WorkerIconId
  statusReason?: string
  mandate: Mandate
  ended?: TaskEnd
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
  goalRevision?: number
  executionContext: ExecutionContext
  executionContractVersion: number
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
  claimToken: string
  phase: 'execute' | 'report'
}

export interface ModelTokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface ModelUsageSample {
  tokens: ModelTokenUsage
  source: 'provider_reported'
  reportedSteps: number
  unreportedSteps: number
  costUsd?: number
  costSource?: 'provider_reported'
}

export interface ModelUsageRecord {
  runId: string
  taskId: string
  userId: string
  workerIconId: WorkerIconId
  executor: string
  modelRef?: string
  completeness: 'complete' | 'partial' | 'unavailable'
  tokenSource?: 'provider_reported'
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  reportedSteps: number
  unreportedSteps: number
  durationMs?: number
  latencySource?: 'pegas_observed'
  costUsd?: number
  costSource?: 'provider_reported'
  observedAt: string
}

interface ModelUsageSummary {
  records: number
  completeRecords: number
  partialRecords: number
  unavailableRecords: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  durationMs: number
  costUsd?: number
}

export interface ModelUsageReport {
  summary: ModelUsageSummary
  records: ModelUsageRecord[]
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
  readAt?: string
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
