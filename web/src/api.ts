import type {
  Approval,
  Automation,
  AutomationDraft,
  AutomationInvocation,
  ChannelEvidencePage,
  ChannelRelation,
  ChannelSearchFilters,
  ChannelSearchResult,
  EventAttachment,
  ExecutionNode,
  GoalContract,
  InboxEvent,
  ChannelTimeline,
  DurableAction,
  DshModelCatalog,
  MemoryDraft,
  MemoryRecord,
  MemoryScope,
  ModelCatalogItem,
  ModelUsageReport,
  NotificationPreferences,
  NotificationPreferencesUpdate,
  OutboxMessage,
  RecoveryStatus,
  ReviewPack,
  Run,
  ModelProviderDraft,
  RuntimeSettings,
  SettingsResponse,
  SpeechSettingsDraft,
  RewriteSettingsDraft,
  Snapshot,
  Task,
  TaskDelivery,
  WorkChannel,
  WorkerProfileResponse,
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

  async channelTimeline(channelId: string): Promise<ChannelTimeline> {
    const user = encodeURIComponent(this.#userId)
    const raw = await this.#get<unknown>(
      `/v1/channels/${encodeURIComponent(channelId)}/timeline?userId=${user}&limit=200`,
    )
    if (raw && typeof raw === 'object' && 'channel' in raw) {
      const projected = raw as { channel: Partial<WorkChannel> }
      if (typeof projected.channel.id === 'string')
        projected.channel = {
          ...projected.channel,
          workerIconId: isWorkerIconId(projected.channel.workerIconId)
            ? projected.channel.workerIconId
            : fallbackWorkerIconId(projected.channel.id),
        }
    }
    if (!isChannelTimeline(raw, channelId))
      throw new Error('服务端返回的 Channel 时间线不完整。')
    return raw
  }

  async snapshot(channelId?: string): Promise<Snapshot> {
    const user = encodeURIComponent(this.#userId)
    const [events, channels, aggregateRuns, messages, rawChannelTimeline] =
      await Promise.all([
        this.#get<{ events: InboxEvent[] }>(`/v1/events?userId=${user}`),
        this.#workChannels(user),
        channelId
          ? Promise.resolve(undefined)
          : this.#get<{ runs: Run[] }>(`/v1/runs?userId=${user}`),
        this.#get<{ messages: OutboxMessage[] }>(`/v1/outbox?userId=${user}`),
        channelId
          ? this.#get<unknown>(
              `/v1/channels/${encodeURIComponent(channelId)}/timeline?userId=${user}&limit=200`,
            )
          : Promise.resolve(undefined),
      ])
    const channelTimeline = isChannelTimeline(rawChannelTimeline, channelId)
      ? rawChannelTimeline
      : undefined
    const compatibilityRuns =
      channelId && !channelTimeline
        ? await this.#get<{ runs: Run[] }>(
            `/v1/runs?userId=${user}&taskId=${encodeURIComponent(channelId)}`,
          )
        : undefined
    return {
      events: events.events,
      channels,
      runs:
        channelTimeline?.runs ??
        compatibilityRuns?.runs ??
        aggregateRuns?.runs ??
        [],
      messages: messages.messages,
      ...(channelTimeline ? { channelTimeline } : {}),
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

  async sendMessage(text: string, taskId?: string): Promise<InboxEvent> {
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
    const body = (await response.json()) as { event: InboxEvent }
    return body.event
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

  async retryRun(runId: string): Promise<Run> {
    const response = await fetch(
      `/v1/runs/${encodeURIComponent(runId)}/retry`,
      {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify({ userId: this.#userId }),
      },
    )
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { run: Run }).run
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

  async markOutboxRead(messageId: string): Promise<OutboxMessage> {
    const response = await fetch(
      `/v1/outbox/${encodeURIComponent(messageId)}/read`,
      {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify({ userId: this.#userId }),
      },
    )
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { message: OutboxMessage }).message
  }

  async automations(): Promise<Automation[]> {
    const user = encodeURIComponent(this.#userId)
    const response = await this.#get<{ automations: Automation[] }>(
      `/v1/automations?userId=${user}`,
    )
    return response.automations
  }

  async createAutomation(draft: AutomationDraft): Promise<Automation> {
    const response = await fetch('/v1/automations', {
      method: 'POST',
      headers: this.#headers(true),
      body: JSON.stringify({
        userId: this.#userId,
        commandId: crypto.randomUUID(),
        automation: draft,
      }),
    })
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { automation: Automation }).automation
  }

  async updateAutomation(
    automationId: string,
    expectedRevision: number,
    draft: AutomationDraft,
  ): Promise<Automation> {
    const response = await fetch(
      `/v1/automations/${encodeURIComponent(automationId)}`,
      {
        method: 'PUT',
        headers: this.#headers(true),
        body: JSON.stringify({
          userId: this.#userId,
          commandId: crypto.randomUUID(),
          expectedRevision,
          automation: draft,
        }),
      },
    )
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { automation: Automation }).automation
  }

  async setAutomationStatus(
    automationId: string,
    expectedRevision: number,
    action: 'pause' | 'resume' | 'cancel',
  ): Promise<Automation> {
    const response = await fetch(
      `/v1/automations/${encodeURIComponent(automationId)}/${action}`,
      {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify({
          userId: this.#userId,
          commandId: crypto.randomUUID(),
          expectedRevision,
        }),
      },
    )
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { automation: Automation }).automation
  }

  async automationInvocations(
    automationId: string,
  ): Promise<AutomationInvocation[]> {
    const user = encodeURIComponent(this.#userId)
    const response = await this.#get<{
      invocations: AutomationInvocation[]
    }>(
      `/v1/automations/${encodeURIComponent(automationId)}/invocations?userId=${user}&limit=50`,
    )
    return response.invocations
  }

  async searchChannels(
    query: string,
    filters: ChannelSearchFilters = {},
    cursor?: string,
  ): Promise<ChannelSearchResult> {
    const params = new URLSearchParams({
      userId: this.#userId,
      limit: '8',
      sort: filters.sort ?? 'updated',
    })
    if (query.trim()) params.set('q', query.trim())
    if (filters.ended !== undefined) params.set('ended', String(filters.ended))
    if (filters.needsAttention) params.set('needsAttention', 'true')
    if (filters.workerIconId) params.set('workerIconId', filters.workerIconId)
    if (cursor) params.set('cursor', cursor)
    return this.#get<ChannelSearchResult>(
      `/v1/channels/search?${params.toString()}`,
    )
  }

  async taskEvidence(
    taskId: string,
    goalRevision: number,
    cursor?: string,
  ): Promise<ChannelEvidencePage> {
    const params = new URLSearchParams({
      userId: this.#userId,
      goalRevision: String(goalRevision),
      limit: '20',
    })
    if (cursor) params.set('cursor', cursor)
    return this.#get<ChannelEvidencePage>(
      `/v1/tasks/${encodeURIComponent(taskId)}/evidence?${params.toString()}`,
    )
  }

  async taskDelivery(taskId: string): Promise<TaskDelivery> {
    const user = encodeURIComponent(this.#userId)
    return this.#get<TaskDelivery>(
      `/v1/tasks/${encodeURIComponent(taskId)}/delivery?userId=${user}`,
    )
  }

  async notificationPreferences(): Promise<NotificationPreferences> {
    const user = encodeURIComponent(this.#userId)
    const response = await this.#get<{
      preferences: NotificationPreferences
    }>(`/v1/settings/notifications?userId=${user}`)
    return response.preferences
  }

  async saveNotificationPreferences(
    update: NotificationPreferencesUpdate,
  ): Promise<NotificationPreferences> {
    const response = await fetch('/v1/settings/notifications', {
      method: 'PUT',
      headers: this.#headers(true),
      body: JSON.stringify({ userId: this.#userId, ...update }),
    })
    if (!response.ok) await throwResponse(response)
    const body = (await response.json()) as {
      preferences: NotificationPreferences
    }
    return body.preferences
  }

  async resolveOutboxMessage(
    messageId: string,
    resolution: 'sent' | 'failed',
    note: string,
  ): Promise<OutboxMessage> {
    const response = await fetch(
      `/v1/outbox/${encodeURIComponent(messageId)}/resolve`,
      {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify({
          userId: this.#userId,
          commandId: crypto.randomUUID(),
          resolution,
          note,
        }),
      },
    )
    if (!response.ok) await throwResponse(response)
    const body = (await response.json()) as { message: OutboxMessage }
    return body.message
  }

  async executionNodes(): Promise<ExecutionNode[]> {
    const response = await this.#get<{ nodes: ExecutionNode[] }>('/v1/nodes')
    return response.nodes
  }

  async recoveryStatus(): Promise<RecoveryStatus> {
    return this.#get<RecoveryStatus>('/v1/recovery/status')
  }

  async workerProfile(taskId: string): Promise<WorkerProfileResponse> {
    const user = encodeURIComponent(this.#userId)
    return this.#get<WorkerProfileResponse>(
      `/v1/tasks/${encodeURIComponent(taskId)}/worker-profile?userId=${user}`,
    )
  }

  async saveWorkerProfile(
    taskId: string,
    update: {
      expectedRevision: number
      modelMode: 'inherit' | 'override'
      modelProvider?: string
      modelName?: string
    },
  ): Promise<WorkerProfileResponse> {
    const response = await fetch(
      `/v1/tasks/${encodeURIComponent(taskId)}/worker-profile`,
      {
        method: 'PUT',
        headers: this.#headers(true),
        body: JSON.stringify({
          userId: this.#userId,
          commandId: crypto.randomUUID(),
          ...update,
        }),
      },
    )
    if (!response.ok) await throwResponse(response)
    return (await response.json()) as WorkerProfileResponse
  }

  async channelCollaborations(taskId: string): Promise<ChannelRelation[]> {
    const user = encodeURIComponent(this.#userId)
    const response = await this.#get<{ relations: ChannelRelation[] }>(
      `/v1/channels/${encodeURIComponent(taskId)}/collaborations?userId=${user}&limit=100`,
    )
    return response.relations
  }

  async goalContracts(
    taskId: string,
  ): Promise<{ contracts: GoalContract[]; current?: GoalContract }> {
    const user = encodeURIComponent(this.#userId)
    return this.#get<{ contracts: GoalContract[]; current?: GoalContract }>(
      `/v1/tasks/${encodeURIComponent(taskId)}/goals?userId=${user}&limit=50`,
    )
  }

  async reviewPacks(
    taskId: string,
  ): Promise<{ reviewPacks: ReviewPack[]; current?: ReviewPack }> {
    const user = encodeURIComponent(this.#userId)
    return this.#get<{ reviewPacks: ReviewPack[]; current?: ReviewPack }>(
      `/v1/tasks/${encodeURIComponent(taskId)}/review-packs?userId=${user}&limit=50`,
    )
  }

  async verifyEvidence(evidenceId: string): Promise<void> {
    const response = await fetch(
      `/v1/evidence/${encodeURIComponent(evidenceId)}/verify`,
      {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify({
          userId: this.#userId,
          commandId: crypto.randomUUID(),
        }),
      },
    )
    if (!response.ok) await throwResponse(response)
  }

  async sendVoiceMessage(
    audio: Blob,
    taskId?: string,
    language = 'zh',
  ): Promise<{ transcript: VoiceTranscript; event: InboxEvent }> {
    const params = new URLSearchParams({
      userId: this.#userId,
      language,
      source: 'web',
      ...(taskId ? { taskId } : {}),
    })
    const response = await fetch(`/v1/voice/messages?${params.toString()}`, {
      method: 'POST',
      headers: {
        ...this.#headers(false),
        'content-type': audio.type || 'application/octet-stream',
        'idempotency-key': crypto.randomUUID(),
      },
      body: audio,
    })
    if (!response.ok) await throwResponse(response)
    return (await response.json()) as {
      transcript: VoiceTranscript
      event: InboxEvent
    }
  }

  async uploadEventAttachment(
    eventId: string,
    file: File,
  ): Promise<EventAttachment> {
    const params = new URLSearchParams({
      userId: this.#userId,
      fileName: file.name,
    })
    const response = await fetch(
      `/v1/events/${encodeURIComponent(eventId)}/attachments?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          ...this.#headers(false),
          'content-type': file.type || 'application/octet-stream',
        },
        body: file,
      },
    )
    if (!response.ok) await throwResponse(response)
    const body = (await response.json()) as { attachment: EventAttachment }
    return body.attachment
  }

  eventAttachmentUrl(eventId: string): string {
    const params = new URLSearchParams({ userId: this.#userId })
    return `/v1/events/${encodeURIComponent(eventId)}/attachments?${params.toString()}`
  }

  async memories(options?: {
    scope?: MemoryScope
    taskId?: string
    cursor?: string
  }): Promise<{ memories: MemoryRecord[]; nextCursor?: string }> {
    const params = new URLSearchParams({ userId: this.#userId, limit: '200' })
    if (options?.scope) params.set('scope', options.scope)
    if (options?.taskId) params.set('taskId', options.taskId)
    if (options?.cursor) params.set('cursor', options.cursor)
    return this.#get<{ memories: MemoryRecord[]; nextCursor?: string }>(
      `/v1/memories?${params.toString()}`,
    )
  }

  async createMemory(draft: MemoryDraft): Promise<MemoryRecord> {
    const response = await fetch('/v1/memories', {
      method: 'POST',
      headers: this.#headers(true),
      body: JSON.stringify({
        userId: this.#userId,
        commandId: crypto.randomUUID(),
        memory: draft,
      }),
    })
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { memory: MemoryRecord }).memory
  }

  async updateMemory(
    memoryId: string,
    expectedRevision: number,
    draft: MemoryDraft,
  ): Promise<MemoryRecord> {
    const response = await fetch(
      `/v1/memories/${encodeURIComponent(memoryId)}`,
      {
        method: 'PUT',
        headers: this.#headers(true),
        body: JSON.stringify({
          userId: this.#userId,
          commandId: crypto.randomUUID(),
          expectedRevision,
          memory: draft,
        }),
      },
    )
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { memory: MemoryRecord }).memory
  }

  async deleteMemory(
    memoryId: string,
    expectedRevision: number,
  ): Promise<void> {
    const response = await fetch(
      `/v1/memories/${encodeURIComponent(memoryId)}/delete`,
      {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify({
          userId: this.#userId,
          commandId: crypto.randomUUID(),
          expectedRevision,
        }),
      },
    )
    if (!response.ok) await throwResponse(response)
  }

  async approval(approvalId: string): Promise<Approval> {
    const user = encodeURIComponent(this.#userId)
    const response = await this.#get<{ approval: Approval }>(
      `/v1/approvals/${encodeURIComponent(approvalId)}?userId=${user}`,
    )
    return response.approval
  }

  async action(actionId: string): Promise<DurableAction> {
    const user = encodeURIComponent(this.#userId)
    const response = await this.#get<{ action: DurableAction }>(
      `/v1/actions/${encodeURIComponent(actionId)}?userId=${user}`,
    )
    return response.action
  }

  async reconcileAction(
    actionId: string,
    resolution: 'succeeded' | 'failed',
    note: string,
  ): Promise<DurableAction> {
    const response = await fetch(
      `/v1/actions/${encodeURIComponent(actionId)}/reconcile`,
      {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify({
          userId: this.#userId,
          commandId: crypto.randomUUID(),
          resolution,
          note,
        }),
      },
    )
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { action: DurableAction }).action
  }

  async decideApproval(
    approvalId: string,
    optionId: string,
    rationale?: string,
  ): Promise<Approval> {
    const response = await fetch(
      `/v1/approvals/${encodeURIComponent(approvalId)}/decisions`,
      {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify({
          userId: this.#userId,
          commandId: crypto.randomUUID(),
          optionId,
          ...(rationale?.trim() ? { rationale: rationale.trim() } : {}),
        }),
      },
    )
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { approval: Approval }).approval
  }

  modelUsage(taskId?: string): Promise<ModelUsageReport> {
    const params = new URLSearchParams({ userId: this.#userId })
    if (taskId) params.set('taskId', taskId)
    return this.#get<ModelUsageReport>(`/v1/usage?${params.toString()}`)
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

function isChannelTimeline(
  value: unknown,
  channelId?: string,
): value is ChannelTimeline {
  if (!value || typeof value !== 'object' || !channelId) return false
  const candidate = value as Partial<ChannelTimeline>
  return (
    candidate.channel?.id === channelId &&
    Array.isArray(candidate.events) &&
    Array.isArray(candidate.messages) &&
    Array.isArray(candidate.runs)
  )
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
