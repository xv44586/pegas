export type TaskStatus =
  'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'

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
  modelProvider: 'codex-cli' | 'openai-compatible'
  modelName: string
  privacyMode: 'disabled' | 'mask'
  rewriteMode: 'disabled' | 'light'
  updatedAt: string
}

export interface SettingsCapabilities {
  providers: {
    id: RuntimeSettings['modelProvider']
    available: boolean
    reason?: string
  }[]
  privacyAvailable: boolean
}

export interface SettingsResponse {
  settings: RuntimeSettings
  capabilities: SettingsCapabilities
}
