export type TaskStatus =
  'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'

export type WorkerIconId = 'car' | 'camera' | 'computer' | 'phone'

export type ChannelSearchSort = 'updated' | 'created' | 'ended'

export interface ChannelSearchFilters {
  ended?: boolean
  needsAttention?: boolean
  workerIconId?: WorkerIconId
  sort?: ChannelSearchSort
}

export interface Task {
  id: string
  userId: string
  originEventId: string
  title: string
  goal: string
  status: TaskStatus
  workerIconId?: WorkerIconId
  statusReason?: string
  mandate?: {
    strength: 'explicit' | 'inferred'
    policyVersion: string
    actor: { source: string; id: string }
    scope: string
  }
  ended?: {
    at: string
    by: 'executor' | 'human'
    outcome: 'completed' | 'dropped' | 'stopped'
    reason?: string
  }
  createdAt: string
  updatedAt: string
}

export interface WorkChannel extends Task {
  taskId: string
  workerIconId: WorkerIconId
  latestActivityAt: string
  endedAt?: string
  endedKind?: 'completed' | 'dropped' | 'stopped'
  canResume: boolean
  canStop: boolean
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
  executionContext?: {
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
  executionContractVersion?: number
  status: RunStatus
  input: string
  output?: string
  attempts: number
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface InboxEvent {
  id: string
  userId: string
  type: string
  source: string
  attachment?: EventAttachment
  payload: unknown
  status: 'pending' | 'processing' | 'processed' | 'failed'
  createdAt: string
  lastError?: string
}

export interface OutboxMessage {
  id: string
  userId: string
  taskId?: string
  payload: unknown
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown'
  createdAt: string
  updatedAt?: string
  sentAt?: string
  readAt?: string
  lastError?: string
  resolution?: OutboxResolution
}

export type Approval = ServerApproval
export type DurableAction = ServerDurableAction

export interface Snapshot {
  events: InboxEvent[]
  messages: OutboxMessage[]
  runs: Run[]
  channels: WorkChannel[]
  channelTimeline?: ChannelTimeline
}

export interface ChannelTimeline {
  channel: WorkChannel
  events: InboxEvent[]
  messages: OutboxMessage[]
  runs: Run[]
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
  router?: RouterUsageReport
}

interface RouterUsageRecord {
  callId: string
  userId: string
  component: 'router' | 'rewrite'
  eventId?: string
  modelRef: string
  completeness: 'complete' | 'unavailable'
  tokenSource?: 'provider_reported'
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  durationMs: number
  latencySource: 'pegas_observed'
  outcome: 'ok' | 'error'
  observedAt: string
}

interface RouterUsageReport {
  summary: {
    calls: number
    okCalls: number
    errorCalls: number
    reportedCalls: number
    inputTokens: number
    outputTokens: number
    durationMs: number
  }
  records: RouterUsageRecord[]
}

export interface RuntimeSettings {
  revision: number
  routerMode: 'model' | 'rules'
  modelProvider: ModelProviderId
  modelName: string
  agentModelMode: 'profile' | 'override'
  agentModelProvider: string
  agentModelName: string
  privacyMode: 'disabled' | 'mask'
  rewriteMode: 'disabled' | 'light'
  chatLaneEnabled?: boolean
  executionPools?: Partial<
    Record<'fast' | 'balanced' | 'deep', { provider: string; model: string }>
  >
  updatedAt: string
}

type ModelProviderId =
  | 'magpie'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'xai'
  | 'moonshot'
  | 'zhipu'
  | 'minimax'
  | 'qwen'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'siliconflow'
  | 'ollama'
  | 'lmstudio'
  | 'custom'

type ModelProviderProtocol = 'openai-chat' | 'anthropic-messages'

interface ModelProviderCapability {
  id: ModelProviderId
  name: string
  category: 'vendor' | 'gateway' | 'local' | 'custom'
  protocol: ModelProviderProtocol
  baseUrl: string
  defaultModel: string
  description: string
  requiresApiKey: boolean
  hasApiKey: boolean
  available: boolean
  reason?: string
}

export interface ModelProviderDraft {
  name: string
  protocol: ModelProviderProtocol
  baseUrl: string
  apiKey: string
  clearApiKey: boolean
}

interface SettingsCapabilities {
  providers: ModelProviderCapability[]
  privacyAvailable: boolean
}

export interface SettingsResponse {
  settings: RuntimeSettings
  capabilities: SettingsCapabilities
  speech?: SpeechSettings
  rewrite?: RewriteSettings
}

interface RewriteSettings {
  mode: 'router' | 'custom'
  protocol: 'openai-chat' | 'anthropic-messages'
  baseUrl: string
  model: string
  hasApiKey: boolean
}

export interface RewriteSettingsDraft extends RewriteSettings {
  apiKey: string
  clearApiKey: boolean
}

interface SpeechSettings {
  provider: 'disabled' | 'openai-compatible'
  baseUrl: string
  model: string
  hasApiKey: boolean
}

export interface SpeechSettingsDraft extends SpeechSettings {
  apiKey: string
  clearApiKey: boolean
}

export interface ModelCatalogItem {
  id: string
  name: string
}

export interface DshModelCatalogItem {
  provider: string
  id: string
  name: string
}

export interface DshModelCatalog {
  defaultProvider: string
  defaultModel: string
  models: DshModelCatalogItem[]
}

type AutomationSchedule =
  | { kind: 'once'; at: string }
  | { kind: 'interval'; everySeconds: number; startsAt?: string }

type AutomationTarget =
  { kind: 'new_task' } | { kind: 'existing_task'; taskId: string }

type AutomationStatus = 'active' | 'paused' | 'completed' | 'cancelled'

export interface Automation {
  id: string
  userId: string
  revision: number
  title: string
  prompt: string
  schedule: AutomationSchedule
  target: AutomationTarget
  status: AutomationStatus
  nextFireAt?: string
  lastFiredAt?: string
  createdAt: string
  updatedAt: string
}

export interface AutomationDraft {
  title: string
  prompt: string
  schedule: AutomationSchedule
  target: AutomationTarget
}

type AutomationInvocationStatus =
  'pending' | 'processing' | 'dispatched' | 'failed'

export interface AutomationInvocation {
  id: string
  automationId: string
  userId: string
  scheduledFor: string
  eventId: string
  status: AutomationInvocationStatus
  attempts: number
  lastError?: string
  createdAt: string
  updatedAt: string
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

export interface ChannelEvidencePage {
  evidence: {
    id: string
    goalRevision: number
    criterionId: string
    kind: string
    artifactId?: string
    verification: { result: 'passed' | 'pending' | 'failed' }
    sensitivity: string
    capturedAt: string
    limitations: string[]
  }[]
  nextCursor?: string
}

interface RecoveryRelease {
  id: string
  commit?: string
  createdAt: string
  compatibility?: { minimumSchema: number; maximumSchema: number }
}

export interface RecoveryStatus {
  available: boolean
  integrity: 'ok' | 'degraded' | 'unavailable'
  source: 'primary' | 'backup' | 'none'
  diagnostics: string[]
  phase?: 'stable' | 'verifying' | 'rolled_back'
  updatedAt?: string
  lastFailure?: string
  active?: RecoveryRelease
  previous?: RecoveryRelease
}

export type MemoryScope = 'global' | 'worker' | 'channel'

export type MemoryCategory =
  | 'preference'
  | 'fact'
  | 'context'
  | 'experience'
  | 'procedure'
  | 'sensitive_reference'

type MemorySource =
  | { kind: 'user_confirmation' }
  | { kind: 'task' | 'run' | 'artifact'; id: string }

export interface MemoryDraft {
  scope: MemoryScope
  taskId?: string
  category: MemoryCategory
  content: string
  source: MemorySource
}

export interface MemoryRecord extends MemoryDraft {
  id: string
  userId: string
  revision: number
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
}

export interface WorkRuleDraft {
  title: string
  content: string
  enabled: boolean
}

export interface WorkRuleRecord extends WorkRuleDraft {
  id: string
  userId: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface BehaviorPreferences {
  userId: string
  customInstructions: string
  revision: number
  updatedAt: string
}
import type {
  Approval as ServerApproval,
  DurableAction as ServerDurableAction,
} from '../../src/approval/approval'
import type {
  GoalContract as ServerGoalContract,
  ReviewPack as ServerReviewPack,
  TaskArtifact as ServerTaskArtifact,
} from '../../src/goal/goal-delivery'
import type {
  EventAttachment as ServerEventAttachment,
  ExecutionNode as ServerExecutionNode,
  NotificationPreferences as ServerNotificationPreferences,
} from '../../src/core/domain'
import type {
  EffectiveWorkerProfile as ServerEffectiveWorkerProfile,
  WorkerProfile as ServerWorkerProfile,
} from '../../src/worker/worker-profile'

export type GoalContract = ServerGoalContract
export type ReviewPack = ServerReviewPack
export type TaskArtifact = ServerTaskArtifact
export type EventAttachment = ServerEventAttachment
export type ExecutionNode = ServerExecutionNode
export type NotificationPreferences = ServerNotificationPreferences
type WorkerProfile = ServerWorkerProfile
type EffectiveWorkerProfile = ServerEffectiveWorkerProfile

type CollaborationKind = 'delegate' | 'handoff' | 'context_note' | 'handback'

type CollaborationStatus =
  'pending' | 'active' | 'returned' | 'completed' | 'failed' | 'cancelled'

interface CollaborationCommand {
  commandId: string
  kind: CollaborationKind
}

type WorkerCollaborationRequest =
  | (CollaborationCommand & {
      kind: 'delegate'
      goal: string
      reason: string
      expectedOutput: string
      contextRefs: string[]
    })
  | (CollaborationCommand & {
      kind: 'handoff'
      goal: string
      reason: string
      contextRefs: string[]
    })
  | (CollaborationCommand & {
      kind: 'context_note'
      targetChannelId: string
      text: string
      sourceRefs: string[]
    })
  | (CollaborationCommand & {
      kind: 'handback'
      inputEventId: string
      reason: string
    })

interface CollaborationResult {
  outcome: 'completed' | 'failed' | 'cancelled'
  summary: string
  targetRunId?: string
}

export interface ChannelRelation {
  id: string
  commandId: string
  userId: string
  kind: CollaborationKind
  status: CollaborationStatus
  sourceTaskId: string
  sourceRunId: string
  parentRelationId?: string
  rootRelationId: string
  depth: number
  targetTaskId?: string
  targetEventId?: string
  returnEventId?: string
  request: WorkerCollaborationRequest
  result?: CollaborationResult
  createdAt: string
  updatedAt: string
  settledAt?: string
}

export interface WorkerProfileResponse {
  profile: WorkerProfile
  effective: EffectiveWorkerProfile
}

export interface NotificationPreferencesUpdate {
  expectedRevision: number
  quietStart?: string
  quietEnd?: string
  utcOffsetMinutes: number
}

interface OutboxResolution {
  resolution: 'sent' | 'failed'
  note: string
  previousStatus: 'failed' | 'unknown'
  resolvedBy: string
  createdAt: string
}

export interface ReviewEvidencePreview {
  evidenceId: string
  criterionId: string
  kind: string
  verification: 'passed' | 'pending' | 'failed'
  sensitivity: string
  capturedAt: string
  contentHash: string
  artifactRevision?: string
  viewport?: { width: number; height: number }
  timecode?: number
  hasContent: boolean
  artifact?: {
    id: string
    name: string
    kind: string
    revision: string
    mimeType?: string
    uri?: string
  }
  presentation: Record<string, unknown>
  limitations: string[]
}

export interface ReviewCriterionPreview {
  criterionId: string
  completionStatus: 'satisfied' | 'partial' | 'unverified' | 'failed'
  explanation: string
  limitations: string[]
  evidenceCount: number
}

export interface ReviewProjection {
  finalOutcome: 'completed' | 'partial' | 'failed'
  goalRevision: number
  criteria: ReviewCriterionPreview[]
  evidence: ReviewEvidencePreview[]
  remainingRisks: string[]
  rollback?: Record<string, unknown>
  auditLink: string
}

export interface TaskDelivery {
  goal?: GoalContract
  artifacts: TaskArtifact[]
  evidence: {
    id: string
    criterionId: string
    kind: string
    artifactId?: string
    verification: { result: 'passed' | 'pending' | 'failed' }
    sensitivity: string
    capturedAt: string
    presentation: Record<string, unknown>
    limitations: string[]
  }[]
  reviewPack?: ReviewPack
}
