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
  /** Execution node this Run is pinned to; only that node may claim it. */
  nodeId?: string
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
  authoritySourceRunId?: string
}

export interface InboxEvent {
  id: string
  userId: string
  type: string
  source: string
  authenticatedActor?: 'human'
  deviceId?: string
  dedupeKey?: string
  attachment?: EventAttachment
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
  authenticatedActor?: 'human'
  deviceId?: string
  dedupeKey?: string
  payload: unknown
}

export interface EventAttachment {
  id: string
  userId: string
  eventId: string
  fileName: string
  mediaType: string
  byteSize: number
  sha256: string
  createdAt: string
}

export interface ExecutionNode {
  id: string
  label: string
  capabilities: string[]
  lastHeartbeatAt: string
  createdAt: string
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
  targetResource?: 'pegas_repository'
  mandate: Mandate
  ended?: TaskEnd
  createdAt: string
  updatedAt: string
}

/**
 * ROUTE-003: one routing candidate plus authoritative summary facts derived
 * by the Control Plane. Workers never supply these fields as free text.
 */
export interface RoutingCandidate {
  task: Task
  /** Latest pending question the user is expected to answer, if any. */
  awaiting?: string
  /** First line of the most recent completed Run output. */
  lastDelivery?: string
  /** First line of the most recent user input attached to this Task. */
  recentInput?: string
}

type RunStatus =
  'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

export interface Run {
  id: string
  taskId: string
  originEventId?: string
  retryOfRunId?: string
  steeringOfRunId?: string
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
      targetResource?: 'pegas_repository'
    }
  | {
      kind: 'continue_task'
      taskId: string
      input: string
      reason: string
    }
  | {
      kind: 'steer_task'
      taskId: string
      input: string
      reason: string
    }
  | {
      kind: 'cancel_task'
      taskId: string
      reason: string
    }

export interface OutboxMessage {
  id: string
  userId: string
  taskId?: string
  channel: string
  dedupeKey: string
  payload: unknown
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'merged'
  attempts: number
  claimedBy?: string
  leaseUntil?: string
  nextAttemptAt?: string
  lastError?: string
  createdAt: string
  updatedAt: string
  sentAt?: string
  readAt?: string
  coalesceKey?: string
  coalescedCount?: number
  mergedIntoId?: string
  resolution?: OutboxResolution
}

export interface NotificationPreferences {
  userId: string
  quietStart?: string
  quietEnd?: string
  utcOffsetMinutes: number
  revision: number
  updatedAt: string
}

export interface OutboxResolutionDraft {
  commandId: string
  resolution: 'sent' | 'failed'
  note: string
}

interface OutboxResolution {
  resolution: 'sent' | 'failed'
  note: string
  previousStatus: 'failed' | 'unknown'
  resolvedBy: string
  createdAt: string
}

export interface ReleaseRef {
  id: string
  root: string
  commit?: string
  createdAt: string
  compatibility?: {
    minimumSchema: number
    maximumSchema: number
  }
}

export interface SupervisorState {
  active: ReleaseRef
  previous?: ReleaseRef
  phase: 'stable' | 'verifying' | 'rolled_back'
  updatedAt: string
  lastFailure?: string
}
