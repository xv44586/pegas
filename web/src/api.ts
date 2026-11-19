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
  RewriteSettingsDraft,
  Snapshot,
  Task,
  WorkChannel,
} from './types'
import { fallbackWorkerIconId, isWorkerIconId } from './agent-icon-id'

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
    const [events, channels, runs, messages] = await Promise.all([
      this.#get<{ events: InboxEvent[] }>(`/v1/events?userId=${user}`),
      this.#workChannels(user),
      this.#get<{ runs: Run[] }>('/v1/runs'),
      this.#get<{ messages: OutboxMessage[] }>(`/v1/outbox?userId=${user}`),
    ])
    return {
      events: events.events,
      channels,
      runs: runs.runs,
      messages: messages.messages,
    }
  }

  async #workChannels(user: string): Promise<WorkChannel[]> {
    try {
      const response = await this.#get<unknown>(`/v1/channels?userId=${user}`)
      if (
        response &&
        typeof response === 'object' &&
        'channels' in response &&
        Array.isArray(response.channels)
      )
        return response.channels.map(channel => {
          const candidate = channel as Partial<WorkChannel>
          if (typeof candidate.id !== 'string')
            throw new Error('Channel response is missing an ID')
          return {
            ...candidate,
            workerIconId: isWorkerIconId(candidate.workerIconId)
              ? candidate.workerIconId
              : fallbackWorkerIconId(candidate.id),
          } as WorkChannel
        })
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error
    }

    // Compatibility with older Control Plane versions during a rolling
    // upgrade. The fallback can be removed after every supported server
    // exposes the WorkChannel projection.
    const legacy = await this.#get<{ tasks: Task[] }>(
      `/v1/tasks?userId=${user}`,
    )
    return legacy.tasks.map(task => ({
      ...task,
      taskId: task.id,
      workerIconId: task.workerIconId ?? fallbackWorkerIconId(task.id),
      latestActivityAt: task.updatedAt,
      ...(task.status === 'completed' || task.status === 'cancelled'
        ? { endedAt: task.updatedAt }
        : {}),
      ...(task.status === 'completed'
        ? { endedKind: 'completed' as const }
        : task.status === 'cancelled'
          ? { endedKind: 'stopped' as const }
          : {}),
      canResume: task.status === 'completed',
      canStop: ['backlog', 'unstarted', 'started'].includes(task.status),
    }))
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

  async testSpeechConnection(
    audio: Blob,
    speech: SpeechSettingsDraft,
  ): Promise<{ transcript: VoiceTranscript; latencyMs: number }> {
    const form = new FormData()
    form.set('speech', JSON.stringify(speech))
    form.set('audio', audio, 'sample.webm')
    const response = await fetch('/v1/settings/speech/test', {
      method: 'POST',
      headers: this.#headers(false),
      body: form,
    })
    if (!response.ok) await throwResponse(response)
    return (await response.json()) as {
      transcript: VoiceTranscript
      latencyMs: number
    }
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

  async stopChannel(channelId: string, reason?: string): Promise<void> {
    const response = await fetch(
      `/v1/channels/${encodeURIComponent(channelId)}/stop`,
      {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify({
          userId: this.#userId,
          commandId: crypto.randomUUID(),
          ...(reason ? { reason } : {}),
        }),
      },
    )
    if (!response.ok) await throwResponse(response)
  }

  async saveSettings(
    settings: RuntimeSettings,
    provider: ModelProviderDraft,
    speech?: SpeechSettingsDraft,
    rewrite?: RewriteSettingsDraft,
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
        ...(rewrite ? { rewrite } : {}),
      }),
    })
    if (!response.ok) await throwResponse(response)
    return (await response.json()) as SettingsResponse
  }

  async testRewrite(
    text: string,
    rewrite: RewriteSettingsDraft,
    settings: RuntimeSettings,
    provider: ModelProviderDraft,
  ): Promise<{
    original: string
    rewritten: string
    changed: boolean
    latencyMs: number
  }> {
    const response = await fetch('/v1/settings/rewrite/test', {
      method: 'POST',
      headers: this.#headers(true),
      body: JSON.stringify({
        text,
        rewrite,
        privacyMode: settings.privacyMode,
        modelProvider: settings.modelProvider,
        modelName: settings.modelName,
        provider,
      }),
    })
    if (!response.ok) await throwResponse(response)
    return (await response.json()) as {
      original: string
      rewritten: string
      changed: boolean
      latencyMs: number
    }
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
