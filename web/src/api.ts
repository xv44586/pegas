import type { ReviewDecisionDraft } from '../../src/goal/goal-delivery'
import type {
  BrowserTraceReceipt,
  MessageTrace,
} from '../../src/observability/message-trace'
import type {
  Approval,
  ApprovalRule,
  Automation,
  AutomationDraft,
  AutomationInvocation,
  BehaviorPreferences,
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
  DerivedMemoryRecord,
  DerivedMemorySyncState,
  LinkPreview,
  MemoryDraft,
  MemoryRecord,
  MemoryScope,
  DesktopResidency,
  ModelCatalogItem,
  ModelUsageReport,
  NotificationPreferences,
  NotificationPreferencesUpdate,
  OutboxMessage,
  RecoveryStatus,
  ReviewPack,
  Run,
  RunActivityReport,
  RunActivityOutputPage,
  RunSubagentReport,
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
  PermissionTierChange,
  WorkRuleDraft,
  WorkRuleRecord,
  RoutingRuleDraft,
  RoutingRuleRecord,
  RoutingPreview,
} from './types'
import { fallbackWorkerIconId, isWorkerIconId } from './agent-icon-id'

export type MessageTarget =
  { taskId: string } | { sourceTaskId: string } | { replyToMessageId: string }

export interface VoiceTranscript {
  text: string
  language?: string
}

export function webAccessHeaders(token?: string): Record<string, string> {
  return {
    'x-pegas-local-web': '1',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
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
  // A result stays in every snapshot for this browser session. Forgetting an
  // acknowledged phase turns it back into a new receipt at the next poll.
  readonly #traceReceipts = new Set<string>()
  #initialTraceResults: Set<string> | undefined

  constructor(userId: string, token = '') {
    this.#userId = userId
    this.#token = token
  }

  setToken(token: string): void {
    this.#token = token
  }

  messageTrace(eventId: string): Promise<MessageTrace> {
    const user = encodeURIComponent(this.#userId)
    return this.#get<MessageTrace>(
      `/v1/events/${encodeURIComponent(eventId)}/trace?userId=${user}`,
    )
  }

  async recordTraceReceipts(
    receipts: readonly BrowserTraceReceipt[],
  ): Promise<void> {
    const pending = new Map<string, BrowserTraceReceipt>()
    for (const receipt of receipts) {
      const id =
        receipt.phase === 'accepted' ? receipt.eventId : receipt.messageId
      const key = `${receipt.phase}:${id}`
      if (this.#traceReceipts.has(key)) continue
      pending.set(key, receipt)
      this.#traceReceipts.add(key)
    }
    if (!pending.size) return
    const entries = [...pending]
    for (let index = 0; index < entries.length; index += 30) {
      const batch = entries.slice(index, index + 30)
      try {
        const response = await fetch('/v1/observability/browser-receipts', {
          method: 'POST',
          headers: this.#headers(true),
          body: JSON.stringify({
            userId: this.#userId,
            receipts: batch.map(([, receipt]) => receipt),
          }),
          keepalive: true,
        })
        if (!response.ok) throw new Error('Browser receipts unavailable')
        const result = (await response.json()) as { recorded: boolean[] }
        batch.forEach(([key], offset) => {
          if (!result.recorded[offset]) this.#traceReceipts.delete(key)
        })
      } catch {
        for (const [key] of batch) this.#traceReceipts.delete(key)
      }
    }
  }

  tracksResult(messageId: string): boolean {
    return this.#initialTraceResults?.has(messageId) === false
  }

  #observeFetchedResults(result: { messages: OutboxMessage[] }): {
    messages: OutboxMessage[]
  } {
    const messages = result.messages.filter(
      message => message.projection?.weight !== 'silent',
    )
    this.#initialTraceResults ??= new Set(
      messages
        .filter(
          message =>
            !(
              typeof message.payload === 'object' &&
              message.payload !== null &&
              'streaming' in message.payload &&
              message.payload.streaming === true
            ),
        )
        .map(message => message.id),
    )
    void this.recordTraceReceipts(
      messages
        .filter(message => this.tracksResult(message.id))
        .map(message => ({ phase: 'fetched', messageId: message.id })),
    )
    return result
  }

  #recordTraceAcceptance(eventId: string, startedAt: number): void {
    void this.recordTraceReceipts([
      {
        phase: 'accepted',
        eventId,
        durationMs: Math.min(
          Math.round(performance.now() - startedAt),
          300_000,
        ),
      },
    ])
  }

  async linkPreview(url: string): Promise<LinkPreview> {
    const raw = await this.#get<unknown>(
      `/v1/link-preview?url=${encodeURIComponent(url)}`,
    )
    return projectLinkPreview(raw)
  }

  async runActivity(runId: string): Promise<RunActivityReport> {
    const user = encodeURIComponent(this.#userId)
    return this.#get<RunActivityReport>(
      `/v1/runs/${encodeURIComponent(runId)}/activity?userId=${user}&limit=400`,
    )
  }

  /** Read the complete owner-scoped activity history, keeping older clients unchanged. */
  async completeRunActivity(
    runId: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<RunActivityReport> {
    let cursor: number | undefined
    const entries = new Map<number, RunActivityReport['entries'][number]>()
    let totalEntries = 0
    do {
      const params = new URLSearchParams({ userId: this.#userId, limit: '400' })
      if (cursor !== undefined) params.set('beforeSeq', String(cursor))
      const page = await this.#get<RunActivityReport>(
        `/v1/runs/${encodeURIComponent(runId)}/activity?${params}`,
        signal,
      )
      if (page.runId !== runId || page.taskId !== taskId)
        throw new Error('执行记录归属不匹配。')
      if (cursor === undefined) totalEntries = page.totalEntries
      for (const entry of page.entries) entries.set(entry.seq, entry)
      const next = page.nextBeforeSeq
      if (
        next !== undefined &&
        (!Number.isSafeInteger(next) ||
          next < 1 ||
          (cursor !== undefined && next >= cursor))
      )
        throw new Error('执行记录分页游标没有前进。')
      cursor = next
    } while (cursor !== undefined)
    // An older server without pagination must not silently masquerade as complete.
    if (entries.size < totalEntries)
      throw new Error('执行记录尚未完整读取，请重试或更新服务。')
    return {
      runId,
      taskId,
      entries: [...entries.values()].sort((a, b) => a.seq - b.seq),
      totalEntries: entries.size,
      truncated: false,
    }
  }

  async runSubagents(
    runId: string,
    signal?: AbortSignal,
  ): Promise<RunSubagentReport> {
    const user = encodeURIComponent(this.#userId)
    return this.#get<RunSubagentReport>(
      `/v1/runs/${encodeURIComponent(runId)}/subagents?userId=${user}`,
      signal,
    )
  }

  async runActivityOutputPage(
    runId: string,
    callId: string,
    offset: number,
    until?: number,
  ): Promise<RunActivityOutputPage> {
    const user = encodeURIComponent(this.#userId)
    return this.#get<RunActivityOutputPage>(
      `/v1/runs/${encodeURIComponent(runId)}/activity/${encodeURIComponent(callId)}/output?userId=${user}&offset=${String(offset)}&limit=12000${until !== undefined ? `&until=${String(until)}` : ''}`,
    )
  }

  runActivityImageUrl(runId: string, callId: string): string {
    const user = encodeURIComponent(this.#userId)
    return `/v1/runs/${encodeURIComponent(runId)}/activity/${encodeURIComponent(callId)}/image?userId=${user}`
  }

  runActivityOutputFileUrl(runId: string, callId: string): string {
    const user = encodeURIComponent(this.#userId)
    return `/v1/runs/${encodeURIComponent(runId)}/activity/${encodeURIComponent(callId)}/output-file?userId=${user}`
  }

  async channelTimeline(
    channelId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ChannelTimeline> {
    const user = encodeURIComponent(this.#userId)
    const raw = await this.#get<unknown>(
      `/v1/channels/${encodeURIComponent(channelId)}/timeline?userId=${user}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      signal,
    )
    if (raw && typeof raw === 'object' && 'channel' in raw) {
      const projected = raw as { channel?: Partial<WorkChannel> | null }
      if (projected.channel && typeof projected.channel.id === 'string')
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

  /** Drain the server's owner-scoped input cursor; Outbox and Runs are unpaged. */
  async completeChannelTimeline(
    channelId: string,
    signal?: AbortSignal,
  ): Promise<ChannelTimeline> {
    const events = new Map<string, InboxEvent>()
    const seen = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      signal?.throwIfAborted()
      const page = await this.channelTimeline(channelId, cursor, signal)
      for (const event of page.events) events.set(event.id, event)
      if (!page.nextCursor) return { ...page, events: [...events.values()] }
      if (seen.has(page.nextCursor))
        throw new Error('事情历史游标未前进，请重新读取。')
      seen.add(page.nextCursor)
      cursor = page.nextCursor
    }
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
        this.#get<{ messages: OutboxMessage[] }>(
          `/v1/outbox?userId=${user}`,
        ).then(result => this.#observeFetchedResults(result)),
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

  async sendMessage(
    text: string,
    target?: MessageTarget,
    dedupeKey: string = crypto.randomUUID(),
  ): Promise<InboxEvent> {
    const startedAt = performance.now()
    const response = await fetch('/v1/events', {
      method: 'POST',
      headers: this.#headers(true),
      body: JSON.stringify({
        userId: this.#userId,
        type: 'user.message',
        source: 'web',
        dedupeKey,
        payload: {
          text,
          ...target,
        },
      }),
    })
    if (!response.ok) await throwResponse(response)
    const body = (await response.json()) as { event: InboxEvent }
    this.#recordTraceAcceptance(body.event.id, startedAt)
    return body.event
  }

  async sendSteerMessage(text: string, taskId: string): Promise<InboxEvent> {
    const startedAt = performance.now()
    const response = await fetch('/v1/events', {
      method: 'POST',
      headers: this.#headers(true),
      body: JSON.stringify({
        userId: this.#userId,
        type: 'user.message',
        source: 'web',
        dedupeKey: crypto.randomUUID(),
        payload: { text, taskId, intent: 'steer' },
      }),
    })
    if (!response.ok) await throwResponse(response)
    const body = (await response.json()) as { event: InboxEvent }
    this.#recordTraceAcceptance(body.event.id, startedAt)
    return body.event
  }

  async retryEvent(eventId: string): Promise<InboxEvent> {
    const response = await fetch(
      `/v1/events/${encodeURIComponent(eventId)}/retry`,
      {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify({ userId: this.#userId }),
      },
    )
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

  async deleteAutomation(
    automationId: string,
    expectedRevision: number,
  ): Promise<void> {
    const response = await fetch(
      `/v1/automations/${encodeURIComponent(automationId)}/delete`,
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

  async automationInvocations(
    automationId: string,
    cursor?: string,
  ): Promise<{ invocations: AutomationInvocation[]; nextCursor?: string }> {
    const params = new URLSearchParams({
      userId: this.#userId,
      limit: '25',
    })
    if (cursor) params.set('cursor', cursor)
    return this.#get<{
      invocations: AutomationInvocation[]
      nextCursor?: string
    }>(
      `/v1/automations/${encodeURIComponent(automationId)}/invocations?${params.toString()}`,
    )
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

  async decideDelivery(
    reviewPackId: string,
    draft: ReviewDecisionDraft,
  ): Promise<void> {
    const response = await fetch(
      `/v1/review-packs/${encodeURIComponent(reviewPackId)}/decision`,
      {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify({ userId: this.#userId, ...draft }),
      },
    )
    if (!response.ok) await throwResponse(response)
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

  async desktopResidency(): Promise<DesktopResidency> {
    return this.#get<DesktopResidency>('/v1/desktop/residency')
  }

  async saveDesktopResidency(resident: boolean): Promise<DesktopResidency> {
    const response = await fetch('/v1/desktop/residency', {
      method: 'PUT',
      headers: this.#headers(true),
      body: JSON.stringify({ resident }),
    })
    if (!response.ok) await throwResponse(response)
    return (await response.json()) as DesktopResidency
  }

  async workerProfile(taskId: string): Promise<WorkerProfileResponse> {
    const user = encodeURIComponent(this.#userId)
    return this.#get<WorkerProfileResponse>(
      `/v1/tasks/${encodeURIComponent(taskId)}/worker-profile?userId=${user}`,
    )
  }

  async permissionTierChanges(taskId: string): Promise<PermissionTierChange[]> {
    const user = encodeURIComponent(this.#userId)
    const response = await fetch(
      `/v1/tasks/${encodeURIComponent(taskId)}/worker-profile/changes?userId=${user}`,
      { headers: this.#headers(true) },
    )
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { changes: PermissionTierChange[] })
      .changes
  }

  async saveWorkerProfile(
    taskId: string,
    update: {
      expectedRevision: number
      modelMode: 'inherit' | 'override'
      modelProvider?: string
      modelName?: string
      pool?: 'fast' | 'balanced' | 'deep'
      effort?: string
      permissionMode?: 'inherit' | 'strict' | 'standard' | 'full'
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
    cursor?: string,
  ): Promise<{
    contracts: GoalContract[]
    current?: GoalContract
    nextCursor?: string
  }> {
    const query = new URLSearchParams({ userId: this.#userId, limit: '50' })
    if (cursor) query.set('cursor', cursor)
    return this.#get(
      `/v1/tasks/${encodeURIComponent(taskId)}/goals?${query.toString()}`,
    )
  }

  async reviewGoal(
    taskId: string,
    revision: number,
  ): Promise<GoalContract | undefined> {
    if (!Number.isSafeInteger(revision) || revision < 1) return undefined
    const delivery = await this.taskDelivery(taskId).catch(() => undefined)
    if (delivery?.goal?.revision === revision) return delivery.goal

    let cursor: string | undefined
    do {
      const page = await this.goalContracts(taskId, cursor)
      const goal = page.contracts.find(
        contract => contract.revision === revision,
      )
      if (goal) return goal
      cursor = page.nextCursor
    } while (cursor)
    return undefined
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
    target?: MessageTarget,
    language = 'zh',
  ): Promise<{ transcript: VoiceTranscript; event: InboxEvent }> {
    const params = new URLSearchParams({
      userId: this.#userId,
      language,
      source: 'web',
      ...target,
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

  async derivedMemories(): Promise<{
    memories: DerivedMemoryRecord[]
    sync: DerivedMemorySyncState | null
  }> {
    const params = new URLSearchParams({ userId: this.#userId })
    const result = await this.#get<{
      memories: DerivedMemoryRecord[]
      sync?: DerivedMemorySyncState | null
    }>(`/v1/derived-memories?${params.toString()}`)
    return { memories: result.memories, sync: result.sync ?? null }
  }

  async deleteDerivedMemory(memoryId: string): Promise<void> {
    const response = await fetch(
      `/v1/derived-memories/${encodeURIComponent(memoryId)}/delete`,
      {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify({
          userId: this.#userId,
          reason: 'Deleted from Pegas memory settings',
        }),
      },
    )
    if (!response.ok) await throwResponse(response)
  }

  async correctDerivedMemory(
    memoryId: string,
    correction: string,
  ): Promise<void> {
    const response = await fetch(
      `/v1/derived-memories/${encodeURIComponent(memoryId)}/correct`,
      {
        method: 'POST',
        headers: this.#headers(true),
        body: JSON.stringify({
          userId: this.#userId,
          commandId: crypto.randomUUID(),
          correction,
        }),
      },
    )
    if (!response.ok) await throwResponse(response)
  }

  async workRules(): Promise<{ rules: WorkRuleRecord[]; nextCursor?: string }> {
    const params = new URLSearchParams({ userId: this.#userId, limit: '200' })
    return this.#get<{ rules: WorkRuleRecord[]; nextCursor?: string }>(
      `/v1/rules?${params.toString()}`,
    )
  }

  async createWorkRule(draft: WorkRuleDraft): Promise<WorkRuleRecord> {
    const response = await fetch('/v1/rules', {
      method: 'POST',
      headers: this.#headers(true),
      body: JSON.stringify({
        userId: this.#userId,
        commandId: crypto.randomUUID(),
        rule: draft,
      }),
    })
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { rule: WorkRuleRecord }).rule
  }

  async updateWorkRule(
    ruleId: string,
    expectedRevision: number,
    draft: WorkRuleDraft,
  ): Promise<WorkRuleRecord> {
    const response = await fetch(`/v1/rules/${encodeURIComponent(ruleId)}`, {
      method: 'PUT',
      headers: this.#headers(true),
      body: JSON.stringify({
        userId: this.#userId,
        commandId: crypto.randomUUID(),
        expectedRevision,
        rule: draft,
      }),
    })
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { rule: WorkRuleRecord }).rule
  }

  async deleteWorkRule(
    ruleId: string,
    expectedRevision: number,
  ): Promise<void> {
    const response = await fetch(
      `/v1/rules/${encodeURIComponent(ruleId)}/delete`,
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

  async routingRules(): Promise<{
    rules: RoutingRuleRecord[]
    nextCursor?: string
  }> {
    const params = new URLSearchParams({ userId: this.#userId, limit: '200' })
    return this.#get<{ rules: RoutingRuleRecord[]; nextCursor?: string }>(
      `/v1/routing-rules?${params.toString()}`,
    )
  }

  async createRoutingRule(draft: RoutingRuleDraft): Promise<RoutingRuleRecord> {
    const response = await fetch('/v1/routing-rules', {
      method: 'POST',
      headers: this.#headers(true),
      body: JSON.stringify({
        userId: this.#userId,
        commandId: crypto.randomUUID(),
        rule: draft,
      }),
    })
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { rule: RoutingRuleRecord }).rule
  }

  async updateRoutingRule(
    ruleId: string,
    expectedRevision: number,
    draft: RoutingRuleDraft,
  ): Promise<RoutingRuleRecord> {
    const response = await fetch(
      `/v1/routing-rules/${encodeURIComponent(ruleId)}`,
      {
        method: 'PUT',
        headers: this.#headers(true),
        body: JSON.stringify({
          userId: this.#userId,
          commandId: crypto.randomUUID(),
          expectedRevision,
          rule: draft,
        }),
      },
    )
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { rule: RoutingRuleRecord }).rule
  }

  async deleteRoutingRule(
    ruleId: string,
    expectedRevision: number,
  ): Promise<void> {
    const response = await fetch(
      `/v1/routing-rules/${encodeURIComponent(ruleId)}/delete`,
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

  async routingPreview(text: string): Promise<RoutingPreview> {
    const response = await fetch('/v1/routing/preview', {
      method: 'POST',
      headers: this.#headers(true),
      body: JSON.stringify({ userId: this.#userId, text }),
    })
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { preview: RoutingPreview }).preview
  }

  async behaviorPreferences(): Promise<BehaviorPreferences> {
    const user = encodeURIComponent(this.#userId)
    const response = await this.#get<{ preferences: BehaviorPreferences }>(
      `/v1/settings/behavior?userId=${user}`,
    )
    return response.preferences
  }

  async saveBehaviorPreferences(
    expectedRevision: number,
    customInstructions: string,
  ): Promise<BehaviorPreferences> {
    const response = await fetch('/v1/settings/behavior', {
      method: 'PUT',
      headers: this.#headers(true),
      body: JSON.stringify({
        userId: this.#userId,
        expectedRevision,
        customInstructions,
      }),
    })
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { preferences: BehaviorPreferences })
      .preferences
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

  async approvalRules(taskId?: string): Promise<ApprovalRule[]> {
    const params = new URLSearchParams({ userId: this.#userId })
    const response = await fetch(
      taskId
        ? `/v1/tasks/${encodeURIComponent(taskId)}/approval-rules?${params.toString()}`
        : `/v1/approval-rules?${params.toString()}`,
      { headers: this.#headers(true) },
    )
    if (!response.ok) await throwResponse(response)
    return ((await response.json()) as { rules: ApprovalRule[] }).rules
  }

  async policyAudit(
    runId: string,
    cursor?: string,
  ): Promise<{
    entries: {
      id: string
      reason: string
      ruleId?: string
      decision: string
      createdAt: string
    }[]
    nextCursor?: string
  }> {
    const params = new URLSearchParams({ userId: this.#userId, runId })
    if (cursor) params.set('cursor', cursor)
    return this.#get(`/v1/policy-audit?${params.toString()}`)
  }

  async revokeApprovalRule(
    taskId: string,
    ruleId: string,
  ): Promise<ApprovalRule> {
    const response = await fetch(
      `/v1/tasks/${encodeURIComponent(taskId)}/approval-rules/${encodeURIComponent(ruleId)}/revoke`,
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
    return ((await response.json()) as { rule: ApprovalRule }).rule
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
        ...(settings.chatLaneEnabled === undefined
          ? {}
          : { chatLaneEnabled: settings.chatLaneEnabled }),
        ...(settings.routingUncertainty === undefined
          ? {}
          : { routingUncertainty: settings.routingUncertainty }),
        ...(settings.permissionTier === undefined
          ? {}
          : { permissionTier: settings.permissionTier }),
        ...(settings.autoReviewEnabled === undefined
          ? {}
          : { autoReviewEnabled: settings.autoReviewEnabled }),
        ...(settings.executionPools === undefined
          ? {}
          : { executionPools: settings.executionPools }),
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
    modelName: string | undefined,
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

  async #get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, {
      headers: this.#headers(false),
      signal,
    })
    if (!response.ok) await throwResponse(response)
    return (await response.json()) as T
  }

  #headers(json: boolean): Record<string, string> {
    return {
      ...webAccessHeaders(this.#token),
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
    Array.isArray(candidate.runs) &&
    candidate.runs.every(run => run.taskId === channelId) &&
    candidate.messages.every(message => message.taskId === channelId) &&
    (candidate.nextCursor === undefined ||
      typeof candidate.nextCursor === 'string')
  )
}

function projectLinkPreview(value: unknown): LinkPreview {
  if (!value || typeof value !== 'object') return { status: 'unavailable' }
  const candidate = value as {
    status?: unknown
    title?: unknown
    description?: unknown
    image?: {
      dataUrl?: unknown
      width?: unknown
      height?: unknown
    } | null
  }
  if (candidate.status !== 'ready') return { status: 'unavailable' }
  const image =
    candidate.image &&
    typeof candidate.image.dataUrl === 'string' &&
    candidate.image.dataUrl.startsWith('data:image/') &&
    typeof candidate.image.width === 'number' &&
    typeof candidate.image.height === 'number'
      ? {
          dataUrl: candidate.image.dataUrl,
          width: candidate.image.width,
          height: candidate.image.height,
        }
      : null
  return {
    status: 'ready',
    title: typeof candidate.title === 'string' ? candidate.title : null,
    description:
      typeof candidate.description === 'string' ? candidate.description : null,
    image,
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
