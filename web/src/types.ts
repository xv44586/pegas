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
  projectId?: string
  workingDirectory?: string
  workspaceNodeId?: string
  workspaceRevision?: number
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

import type { WorkWorkflow } from '../../src/channel/work-channel'

export interface WorkChannel extends Task {
  taskId: string
  workerIconId: WorkerIconId
  latestActivityAt: string
  endedAt?: string
  endedKind?: 'completed' | 'dropped' | 'stopped'
  canResume: boolean
  canStop: boolean
  workflow?: WorkWorkflow
}

type RunStatus =
  'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

export interface Run {
  id: string
  taskId: string
  originEventId?: string
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
  channel?: string
  payload: unknown
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown'
  createdAt: string
  updatedAt?: string
  sentAt?: string
  readAt?: string
  lastError?: string
  resolution?: OutboxResolution
  projection?: ConversationProjection
  deliveryDecision?: 'accept' | 'request_changes' | 'cancelled'
}

export interface ConversationProjection {
  lane: 'say' | 'work' | 'decide'
  weight: 'inline' | 'card' | 'silent'
  anchor?: { taskId: string; eventId?: string }
}

export type Approval = ServerApproval
export type DurableAction = ServerDurableAction
export type ApprovalRule = ServerApprovalRule

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
  nextCursor?: string
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

export interface RunActivityEntry {
  seq: number
  kind: 'text' | 'thinking' | 'tool_call' | 'step'
  status?: 'started' | 'completed' | 'error'
  callId?: string
  tool?: string
  step?: number
  label: string
  detail?: string
  summary?: string
  semantic?: ToolSemantic
  meta?: { kind: 'compaction' | 'steered'; note?: string }
  createdAt: string
  updatedAt: string
}

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

interface WebSource {
  url: string
  title?: string
  snippet?: string
}

interface SearchFileHits {
  path: string
  matches: { line: number; text: string }[]
}

interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

interface AskQuestion {
  id: string
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

interface AskAnswer {
  id: string
  selected: string[]
  custom?: string
}

interface DiffHunk {
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
  nextBeforeSeq?: number
}

export interface RunActivityOutputPage {
  runId: string
  callId: string
  content: string
  offset: number
  totalCharacters: number
  archivedCharacters: number
  truncatedArchive: boolean
  gapStart?: number
  gapEnd?: number
}

export interface SubagentTranscript {
  sessionId: string
  parentSessionId: string
  delegationDepth: number
  label?: string
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

interface RouterUsageRecord {
  callId: string
  userId: string
  component: 'router' | 'rewrite' | 'summary' | 'memory'
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
  routingUncertainty?: 'new_task' | 'ask_first' | 'continue_recent'
  permissionTier?: 'strict' | 'standard' | 'full'
  autoReviewEnabled?: boolean
  /** Optional code-change SVG in work reports; defaults to off. */
  visualDiffEnabled?: boolean
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

export interface ModelProviderCapability {
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

export interface RewriteSettings {
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

export interface SpeechSettings {
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
  taskId?: string
  summary?: string
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

export interface DesktopResidency {
  managed: boolean
  resident?: boolean
  loginItemRegistered?: boolean
  diagnostics?: string[]
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

export interface DerivedMemoryRecord {
  id: string
  text: string
  type: 'world' | 'experience' | 'observation'
  score?: number
  tags: string[]
  metadata: Record<string, unknown>
  state?: 'valid' | 'invalidated'
}

export interface DerivedMemorySyncState {
  status: 'healthy' | 'failed'
  memoryCount: number
  lastSyncedAt?: string
  lastError?: string
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

export interface RoutingRuleDraft {
  title: string
  content: string
  enabled: boolean
}

export interface RoutingRuleRecord extends RoutingRuleDraft {
  id: string
  userId: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface RoutingPreview {
  kind: string
  reason: string
  taskId?: string
  taskTitle?: string
  title?: string
  question?: string
  matchedRuleId?: string
  routerMode: 'model' | 'rules'
  dryRun: true
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
import type { ApprovalRule as ServerApprovalRule } from '../../src/approval/approval-rule'
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

export interface PermissionTierChange {
  commandId: string
  revision: number
  permissionMode?: 'inherit' | 'strict' | 'standard' | 'full'
  previousPermissionMode?: 'inherit' | 'strict' | 'standard' | 'full'
  createdAt: string
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

interface LinkPreviewImage {
  dataUrl: string
  width: number
  height: number
}

export type LinkPreview =
  | { status: 'unavailable' }
  | {
      status: 'ready'
      title: string | null
      description: string | null
      image: LinkPreviewImage | null
    }
