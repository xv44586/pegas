export type TaskStatus =
  'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'

export type WorkerIconId = 'car' | 'camera' | 'computer' | 'phone'

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
  executionContext?: {
    executor: string
    workspace?: string
    model?: string
    permissions?: string
    protocol?: string
    settingsRevision?: number
    workerProfile?: string
  }
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
}

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

interface ModelUsageRecord {
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

interface DshModelCatalogItem {
  provider: string
  id: string
  name: string
}

export interface DshModelCatalog {
  defaultProvider: string
  defaultModel: string
  models: DshModelCatalogItem[]
}
