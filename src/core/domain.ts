import type { WorkerIconId } from '../brand/agent-icon.js'

type EventStatus = 'pending' | 'processing' | 'processed' | 'failed'

export type TaskStatus =
  'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'

type TaskKind = 'work' | 'conversation'

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
  permissionTier?: 'strict' | 'standard' | 'full'
  authoritySourceRunId?: string
  executionPool?: 'fast' | 'balanced' | 'deep'
  requestedPool?: 'fast' | 'balanced' | 'deep'
  poolDowngradeReason?: string
  reasoningEffort?: string
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
  /** Defaults to 'work' when omitted; conversation Tasks carry 'conversation'. */
  kind?: TaskKind
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

/**
 * NOTIFY-006: one owed user-visible delivery. A terminal Run stays on this
 * ledger until its notification is confirmed sent (or human-resolved);
 * delivery failure never settles the debt. Read-only projection.
 */
export interface OwedDelivery {
  userId: string
  taskId: string
  taskTitle: string
  runId: string
  runStatus: 'completed' | 'failed'
  runEndedAt: string
  runError?: string
  messageId: string
  dedupeKey: string
  deliveryStatus: OutboxMessage['status']
  attempts: number
  deliveryError?: string
  messageCreatedAt: string
  mergedIntoId?: string
  mergedIntoStatus?: OutboxMessage['status']
}

/**
 * NOTIFY-006: read-only reconciliation finding. Findings only alert; repair
 * stays on the existing lease/retry/human-reconciliation paths (OBS-001
 * boundary: the watchdog never writes product state).
 */
export interface ReconciliationFinding {
  kind: 'unreported' | 'never_started' | 'stranded' | 'stale_waiting'
  userId: string
  taskId: string
  runId?: string
  nodeId?: string
  since: string
  detail: string
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

export interface RunActivityEntry {
  seq: number
  kind: 'text' | 'thinking' | 'tool_call' | 'step'
  status?: 'started' | 'completed' | 'error'
  callId?: string
  tool?: string
  step?: number
  label: string
  detail?: string
  /** Model-generated Chinese headline for English thinking; raw detail stays verbatim. */
  summary?: string
  semantic?: ToolSemantic
  /** Lightweight lifecycle marker (compaction / steering); no tool payload. */
  meta?: { kind: 'compaction' | 'steered'; note?: string }
  createdAt: string
  updatedAt: string
}

/** Derived, bounded projection of a tool call for dedicated result views. */
export type ToolSemantic =
  | {
      kind: 'shell'
      command: string
      description?: string
      output?: string
      outputTruncated?: boolean
      outputOmittedCharacters?: number
      outputSpillPath?: string
      outputRawSpillPath?: string
      exitCode?: number
      interrupted?: boolean
    }
  | {
      kind: 'file_read'
      path: string
      lineCount?: number
      preview?: string
      previewTruncated?: boolean
      previewOmittedCharacters?: number
      previewSpillPath?: string
      previewRawSpillPath?: string
    }
  | {
      kind: 'image'
      path: string
      mediaType?: string
      width?: number
      height?: number
      bytes?: number
      originalWidth?: number
      originalHeight?: number
    }
  | {
      kind: 'delivery'
      files: { path: string; description?: string }[]
      preview?: string
      previewTruncated?: boolean
      previewOmittedCharacters?: number
      previewSpillPath?: string
      previewRawSpillPath?: string
    }
  | {
      kind: 'file_edit'
      path: string
      mode: 'edit' | 'write' | 'patch'
      additions: number
      deletions: number
      hunks: DiffHunk[]
      diffTruncated?: boolean
    }
  | {
      kind: 'search'
      query: string
      path?: string
      include?: string
      shape?: 'matches' | 'paths'
      total?: number
      resultTruncated?: boolean
      files?: SearchFileHits[]
      paths?: string[]
      preview?: string
      previewTruncated?: boolean
      previewOmittedCharacters?: number
      previewSpillPath?: string
      previewRawSpillPath?: string
    }
  | {
      kind: 'todo'
      items: TodoItem[]
      itemsTruncated?: boolean
    }
  | {
      kind: 'ask_user'
      questions: AskQuestion[]
      answers?: AskAnswer[]
      pending?: boolean
      preview?: string
      previewTruncated?: boolean
      previewOmittedCharacters?: number
      previewSpillPath?: string
      previewRawSpillPath?: string
    }
  | {
      kind: 'web'
      url?: string
      query?: string
      queries?: string[]
      statusCode?: number
      sources?: WebSource[]
      sourcesTruncated?: boolean
      preview?: string
      previewTruncated?: boolean
      previewOmittedCharacters?: number
      previewSpillPath?: string
      previewRawSpillPath?: string
    }
  | {
      kind: 'agent_control'
      action: 'wait' | 'message' | 'list' | 'interrupt'
      agent?: string
      message?: string
      timeoutMs?: number
      timedOut?: boolean
      agents?: { name: string; status: string; description?: string }[]
      preview?: string
      previewTruncated?: boolean
      previewOmittedCharacters?: number
      previewSpillPath?: string
      previewRawSpillPath?: string
    }
  | { kind: 'unknown' }

export interface WebSource {
  url: string
  title?: string
  snippet?: string
}

export interface SearchFileHits {
  path: string
  matches: { line: number; text: string }[]
}

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface AskQuestion {
  id: string
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

export interface AskAnswer {
  id: string
  selected: string[]
  custom?: string
}

export interface DiffHunk {
  oldStart?: number
  newStart?: number
  lines: { type: 'context' | 'add' | 'del'; text: string }[]
}

export interface RunActivityReport {
  runId: string
  taskId: string
  entries: RunActivityEntry[]
  totalEntries: number
  truncated: boolean
}

export interface SubagentTranscript {
  sessionId: string
  parentSessionId: string
  delegationDepth: number
  /** The delegation tool-call description, from the child's durable descriptor. */
  label?: string
  /** The delegated prompt, from the child's first durable user message. */
  prompt?: string
  createdAt: string
  entries: RunActivityEntry[]
  totalEntries: number
  truncated: boolean
}

export interface RunSubagentReport {
  runId: string
  taskId: string
  subagents: SubagentTranscript[]
}

export interface RouterUsageRecord {
  callId: string
  userId: string
  component: 'router' | 'rewrite' | 'summary'
  eventId?: string
  modelRef: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
  durationMs: number
  outcome: 'ok' | 'error'
}

export interface RouterUsageReport {
  summary: {
    calls: number
    okCalls: number
    errorCalls: number
    reportedCalls: number
    inputTokens: number
    outputTokens: number
    durationMs: number
  }
  records: (Omit<RouterUsageRecord, 'usage'> & {
    completeness: 'complete' | 'unavailable'
    tokenSource?: 'provider_reported'
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
    latencySource: 'pegas_observed'
    observedAt: string
  })[]
}

export type RoutingDecision =
  | {
      kind: 'create_task'
      title: string
      goal: string
      input: string
      reason: string
      targetResource?: 'pegas_repository'
      sourceContext?: TaskSourceContext
      matchedRuleId?: string
    }
  | {
      kind: 'reply'
      input: string
      reason: string
      matchedRuleId?: string
    }
  | {
      kind: 'continue_task'
      taskId: string
      input: string
      reason: string
      matchedRuleId?: string
    }
  | {
      kind: 'steer_task'
      taskId: string
      input: string
      reason: string
      matchedRuleId?: string
    }
  | {
      kind: 'cancel_task'
      taskId: string
      reason: string
      matchedRuleId?: string
    }
  | {
      kind: 'clarify'
      input: string
      question: string
      reason: string
    }

/**
 * COLLAB-001 (PLAN-001 P5): terminal facts handed from a finished or stopped
 * source Task into a new Task's first Run input. This is a factual handoff,
 * not a context note and not an authorization: it never resumes the source
 * session and never expands the new Task's mandate. The Control Plane
 * derives every field from authoritative rows; clients only reference the
 * source Task.
 */
export interface TaskSourceContext {
  sourceTaskId: string
  relationId?: string
  sourceTitle: string
  sourceStatus: 'completed' | 'cancelled'
  summary: string
  keyDecisions: string[]
  artifactRefs: { id: string; name: string; kind: string; uri?: string }[]
  reviewPackId?: string
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
  /**
   * CONV-006: read-only conversation projection derived by the server.
   * Never persisted and never accepted from clients; delivery payloads
   * and durable rows stay unchanged.
   */
  projection?: ConversationProjection
}

export type ConversationLane = 'say' | 'work' | 'decide'

export type ConversationWeight = 'inline' | 'card' | 'silent'

export interface ConversationAnchor {
  taskId: string
  eventId?: string
}

export interface ConversationProjection {
  lane: ConversationLane
  weight: ConversationWeight
  anchor?: ConversationAnchor
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
