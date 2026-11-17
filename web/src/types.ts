export type TaskStatus =
  | 'inbox'
  | 'planning'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancelled'

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
  executor: string
  executorRef?: string
  resumeFromRef?: string
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
}

export interface Snapshot {
  events: InboxEvent[]
  messages: OutboxMessage[]
  runs: Run[]
  tasks: Task[]
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

export type ModelProviderId =
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

export interface SettingsCapabilities {
  providers: ModelProviderCapability[]
  privacyAvailable: boolean
}

export interface SettingsResponse {
  settings: RuntimeSettings
  capabilities: SettingsCapabilities
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
