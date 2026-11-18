import type {
  InboxEvent,
  DshModelCatalog,
  ModelCatalogItem,
  OutboxMessage,
  Run,
  ModelProviderDraft,
  RuntimeSettings,
  SettingsResponse,
  SpeechSettingsDraft,
  Snapshot,
  Task,
} from './types'

export interface VoiceTranscript {
  text: string
  language?: string
}

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class PegasApi {
  readonly #userId: string
  #token: string

  constructor(userId: string, token = '') {
    this.#userId = userId
    this.#token = token
  }

  setToken(token: string): void {
    this.#token = token
  }

  async snapshot(): Promise<Snapshot> {
    const user = encodeURIComponent(this.#userId)
    const [events, tasks, runs, messages] = await Promise.all([
      this.#get<{ events: InboxEvent[] }>(`/v1/events?userId=${user}`),
      this.#get<{ tasks: Task[] }>(`/v1/tasks?userId=${user}`),
      this.#get<{ runs: Run[] }>('/v1/runs'),
      this.#get<{ messages: OutboxMessage[] }>(`/v1/outbox?userId=${user}`),
    ])
    return {
      events: events.events,
      tasks: tasks.tasks,
      runs: runs.runs,
      messages: messages.messages,
    }
  }

  async sendMessage(text: string, taskId?: string): Promise<void> {
    const response = await fetch('/v1/events', {
      method: 'POST',
      headers: this.#headers(true),
      body: JSON.stringify({
        userId: this.#userId,
        type: 'user.message',
        source: 'web',
        dedupeKey: crypto.randomUUID(),
        payload: { text, ...(taskId ? { taskId } : {}) },
      }),
    })
    if (!response.ok) await throwResponse(response)
  }

  async transcribeVoice(
    audio: Blob,
    language = 'zh',
  ): Promise<VoiceTranscript> {
    const params = new URLSearchParams({ language })
    const response = await fetch(`/v1/voice/transcriptions?${params}`, {
      method: 'POST',
      headers: {
        ...this.#headers(false),
        'content-type': audio.type || 'application/octet-stream',
      },
      body: audio,
    })
    if (!response.ok) await throwResponse(response)
    const body = (await response.json()) as { transcript: VoiceTranscript }
    return body.transcript
  }

  settings(): Promise<SettingsResponse> {
    return this.#get<SettingsResponse>('/v1/settings')
  }

  async retryRun(runId: string): Promise<void> {
    const response = await fetch(
      `/v1/runs/${encodeURIComponent(runId)}/retry`,
      {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify({ userId: this.#userId }),
      },
    )
    if (!response.ok) await throwResponse(response)
  }

  async saveSettings(
    settings: RuntimeSettings,
    provider: ModelProviderDraft,
    speech?: SpeechSettingsDraft,
  ): Promise<SettingsResponse> {
    const response = await fetch('/v1/settings', {
      method: 'PUT',
      headers: this.#headers(true),
      body: JSON.stringify({
        expectedRevision: settings.revision,
        routerMode: settings.routerMode,
        modelProvider: settings.modelProvider,
        modelName: settings.modelName,
        agentModelMode: settings.agentModelMode,
        agentModelProvider: settings.agentModelProvider,
        agentModelName: settings.agentModelName,
        privacyMode: settings.privacyMode,
        rewriteMode: settings.rewriteMode,
        provider,
        ...(speech ? { speech } : {}),
      }),
    })
    if (!response.ok) await throwResponse(response)
    return (await response.json()) as SettingsResponse
  }

  async discoverModels(
    modelProvider: RuntimeSettings['modelProvider'],
    modelName: string,
    provider: ModelProviderDraft,
  ): Promise<ModelCatalogItem[]> {
    const response = await fetch('/v1/settings/models/discover', {
      method: 'POST',
      headers: this.#headers(true),
      body: JSON.stringify({ modelProvider, modelName, provider }),
    })
    if (!response.ok) await throwResponse(response)
    const body = (await response.json()) as { models: ModelCatalogItem[] }
    return body.models
  }

  async testModel(
    modelProvider: RuntimeSettings['modelProvider'],
    modelName: string,
    provider: ModelProviderDraft,
  ): Promise<{ ok: true; latencyMs: number }> {
    const response = await fetch('/v1/settings/models/test', {
      method: 'POST',
      headers: this.#headers(true),
      body: JSON.stringify({ modelProvider, modelName, provider }),
    })
    if (!response.ok) await throwResponse(response)
    return (await response.json()) as { ok: true; latencyMs: number }
  }

  agentModels(): Promise<DshModelCatalog> {
    return this.#get<DshModelCatalog>('/v1/settings/agent-models')
  }

  async #get<T>(path: string): Promise<T> {
    const response = await fetch(path, { headers: this.#headers(false) })
    if (!response.ok) await throwResponse(response)
    return (await response.json()) as T
  }

  #headers(json: boolean): Record<string, string> {
    return {
      ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      ...(json ? { 'content-type': 'application/json' } : {}),
    }
  }
}

async function throwResponse(response: Response): Promise<never> {
  let message = `请求失败（${String(response.status)}）`
  try {
    const body = (await response.json()) as { message?: string }
    if (body.message) message = body.message
  } catch {
    // Keep the status-based message when the body is not JSON.
  }
  throw new ApiError(response.status, message)
}
