import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat as statFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { extname, resolve, sep } from 'node:path'

import { projectWorkChannel } from '../channel/work-channel.js'
import { spillBodyForGap } from '../activity/tool-semantics.js'
import { isWorkerIconId, type WorkerIconId } from '../brand/agent-icon.js'
import { parseWorkerCollaborationRequest } from '../collaboration/collaboration.js'
import {
  approvalStatuses,
  parseActionOutcomeDraft,
  parseActionReconciliationDraft,
  parseActionRequestDraft,
  parseApprovalDecisionDraft,
  type ApprovalStatus,
} from '../approval/approval.js'
import type {
  NewInboxEvent,
  OutboxResolutionDraft,
  SupervisorState,
  TaskStatus,
} from '../core/domain.js'
import type { Logger } from '../observability/logger.js'
import type { MetricsRegistry } from '../observability/metrics.js'
import {
  LinkPreviewService,
  type LinkPreviewOptions,
} from '../link-preview/link-preview.js'
import type {
  ChannelSearchSort,
  ChannelSearchOptions,
} from '../channel/work-channel.js'
import type { DshModelCatalog } from '../executor/dsh-model-catalog.js'
import {
  parseArtifactDraft,
  parseEvidenceClaimDraft,
  parseGoalContractDraft,
  parseWorkerReportDraft,
} from '../goal/goal-delivery.js'
import { verifyVisualEvidence } from '../goal/trusted-verifier.js'
import { AnthropicProvider } from '../model/anthropic-provider.js'
import {
  discoverModelCatalog,
  testModelConnection,
} from '../model/model-catalog.js'
import type { ModelCredentialVault } from '../model/model-credential-vault.js'
import { OpenAiTranscriptionProvider } from '../speech/openai-transcription-provider.js'
import { parseSpeechConnectionUpdate } from '../speech/speech-settings.js'
import { parseSpeechTestUpload } from '../speech/speech-test-upload.js'
import { OpenAiCompatibleProvider } from '../model/openai-compatible-provider.js'
import { ModelInputRewriter } from '../rewrite/model-input-rewriter.js'
import { parseRewriteConnectionUpdate } from '../rewrite/rewrite-settings.js'
import { DeterministicPrivacyMasker } from '../privacy/masker.js'
import { PrivacyMaskingProvider } from '../privacy/provider.js'
import type { JsonModelProvider } from '../model/provider.js'
import {
  parseRuntimeSettingsUpdate,
  type SettingsCapabilities,
} from '../settings/runtime-settings.js'
import {
  parseMemoryCategory,
  parseMemoryCreate,
  parseMemoryDelete,
  parseMemoryScope,
  parseMemoryUpdate,
} from '../memory/memory.js'
import {
  parseCustomInstructions,
  parseWorkRuleCreate,
  parseWorkRuleDelete,
  parseWorkRuleUpdate,
} from '../rules/rules.js'
import {
  parseAutomationCreate,
  parseAutomationStatusCommand,
  parseAutomationUpdate,
  parseFollowUpCommand,
  parseRunAutomationCommand,
  parseRunAutomationStatusCommand,
  parseRunMessageCommand,
} from '../schedule/schedule.js'
import type {
  SpeechRecognitionProvider,
  SpeechTranscript,
} from '../speech/provider.js'
import {
  ActionNotFoundError,
  ActionReconciliationConflictError,
  AutomationCommandConflictError,
  AutomationNotFoundError,
  AutomationReadOnlyError,
  AutomationRevisionConflictError,
  AutomationTargetUnavailableError,
  BehaviorPreferencesConflictError,
  CollaborationActionPendingError,
  CollaborationBudgetLimitError,
  CollaborationCommandConflictError,
  CollaborationFanoutLimitError,
  CollaborationReconciliationRequiredError,
  CollaborationTargetUnavailableError,
  EventAttachmentConflictError,
  EventAttachmentsUnsupportedError,
  GoalProposalCommandConflictError,
  MemoryCommandConflictError,
  MemoryLimitError,
  MemoryNotFoundError,
  MemoryRevisionConflictError,
  MemorySourceUnavailableError,
  MemoryTargetUnavailableError,
  NotificationPreferencesConflictError,
  OutboxNotFoundError,
  OutboxResolutionConflictError,
  RunClaimError,
  RunMessageCommandConflictError,
  SettingsRevisionConflictError,
  WorkerProfileReadOnlyError,
  WorkerProfileRevisionConflictError,
  WorkRuleCommandConflictError,
  WorkRuleLimitError,
  WorkRuleNotFoundError,
  WorkRuleRevisionConflictError,
  type PegasStore,
} from '../storage/sqlite-store.js'
import {
  effectiveWorkerProfile,
  parseWorkerProfileUpdate,
} from '../worker/worker-profile.js'

const maximumBodyBytes = 1024 * 1024
const defaultPageLimit = 50
const maximumPageLimit = 200
const defaultMaximumAudioBytes = 25 * 1024 * 1024
const maximumAttachmentBytes = 25 * 1024 * 1024
const maximumRunImageBytes = 10 * 1024 * 1024
const maximumRunSpillFileBytes = 4 * 1024 * 1024

/**
 * EXEC-006 round 18: best-effort read of one executor spill file for output
 * paging. The path always comes from a persisted, owner-checked semantic;
 * oversized or unreadable files simply yield no fallback.
 */
async function readRunSpillText(path: string): Promise<string | undefined> {
  try {
    const stats = await statFile(path)
    if (!stats.isFile() || stats.size > maximumRunSpillFileBytes)
      return undefined
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

function imageMediaType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.bmp':
      return 'image/bmp'
    case '.avif':
      return 'image/avif'
    default:
      return undefined
  }
}

export interface ControlPlaneOptions {
  store: PegasStore
  apiToken?: string
  webRoot?: string
  speechProvider?: SpeechRecognitionProvider
  maximumAudioBytes?: number
  settingsCapabilities?: SettingsCapabilities | (() => SettingsCapabilities)
  modelCredentialVault?: ModelCredentialVault
  agentModelCatalog?: () => Promise<DshModelCatalog>
  agentModelCatalogTtlMs?: number
  modelTimeoutMs?: number
  speechTimeoutMs?: number
  privacyHmacKey?: string
  recoveryStatus?: RecoveryStatusSource
  logger?: Logger
  metrics?: MetricsRegistry
  linkPreview?: LinkPreviewOptions
}

interface RecoveryStatusSource {
  baseUrl: string
  token?: string
  timeoutMs?: number
}

interface RecoveryReleaseProjection {
  id: string
  commit?: string
  createdAt: string
  compatibility?: { minimumSchema: number; maximumSchema: number }
}

interface RecoveryStatusProjection {
  available: boolean
  integrity: 'ok' | 'degraded' | 'unavailable'
  source: 'primary' | 'backup' | 'none'
  diagnostics: string[]
  phase?: SupervisorState['phase']
  updatedAt?: string
  lastFailure?: string
  active?: RecoveryReleaseProjection
  previous?: RecoveryReleaseProjection
}

const recoveryStatusTimeoutMs = 3_000
const maximumRecoveryDiagnostics = 20
const maximumRecoveryDiagnosticLength = 300

async function fetchRecoveryStatus(
  source: RecoveryStatusSource,
): Promise<RecoveryStatusProjection> {
  let upstream: Response
  try {
    upstream = await fetch(new URL('/v1/recovery/status', source.baseUrl), {
      headers: source.token ? { authorization: `Bearer ${source.token}` } : {},
      signal: AbortSignal.timeout(source.timeoutMs ?? recoveryStatusTimeoutMs),
    })
  } catch {
    return {
      available: false,
      integrity: 'unavailable',
      source: 'none',
      diagnostics: ['无法连接独立恢复平面；Supervisor 可能未运行。'],
    }
  }
  if (upstream.status !== 200 && upstream.status !== 503) {
    return {
      available: false,
      integrity: 'unavailable',
      source: 'none',
      diagnostics:
        upstream.status === 401
          ? ['恢复平面拒绝了控制面凭证；请检查 PEGAS_RECOVERY_TOKEN 配置。']
          : ['恢复平面返回了意外响应；状态不可用。'],
    }
  }
  let body: unknown
  try {
    body = await upstream.json()
  } catch {
    return {
      available: false,
      integrity: 'unavailable',
      source: 'none',
      diagnostics: ['恢复平面响应无法解析；状态不可用。'],
    }
  }
  return projectRecoveryStatus(body)
}

function projectRecoveryStatus(body: unknown): RecoveryStatusProjection {
  const record = isRecord(body) ? body : {}
  const meta = isRecord(record.recoveryState) ? record.recoveryState : {}
  const integrity =
    meta.integrity === 'ok' ||
    meta.integrity === 'degraded' ||
    meta.integrity === 'unavailable'
      ? meta.integrity
      : 'unavailable'
  const source =
    meta.source === 'primary' ||
    meta.source === 'backup' ||
    meta.source === 'none'
      ? meta.source
      : 'none'
  const diagnostics = Array.isArray(meta.diagnostics)
    ? meta.diagnostics
        .filter(
          (entry): entry is string =>
            typeof entry === 'string' && entry.trim().length > 0,
        )
        .slice(0, maximumRecoveryDiagnostics)
        .map(entry => entry.slice(0, maximumRecoveryDiagnosticLength))
    : []
  const active = projectRecoveryRelease(record.active)
  const previous = projectRecoveryRelease(record.previous)
  const phase =
    record.phase === 'stable' ||
    record.phase === 'verifying' ||
    record.phase === 'rolled_back'
      ? record.phase
      : undefined
  return {
    available: integrity !== 'unavailable' && Boolean(active),
    integrity,
    source,
    diagnostics,
    ...(phase ? { phase } : {}),
    ...(typeof record.updatedAt === 'string'
      ? { updatedAt: record.updatedAt }
      : {}),
    ...(typeof record.lastFailure === 'string' && record.lastFailure.trim()
      ? {
          lastFailure: record.lastFailure.slice(
            0,
            maximumRecoveryDiagnosticLength,
          ),
        }
      : {}),
    ...(active ? { active } : {}),
    ...(previous ? { previous } : {}),
  }
}

function projectRecoveryRelease(
  value: unknown,
): RecoveryReleaseProjection | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined
  const compatibility = isRecord(value.compatibility)
    ? value.compatibility
    : undefined
  const minimumSchema = compatibility?.minimumSchema
  const maximumSchema = compatibility?.maximumSchema
  return {
    id: value.id,
    ...(typeof value.commit === 'string' ? { commit: value.commit } : {}),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    ...(typeof minimumSchema === 'number' && typeof maximumSchema === 'number'
      ? { compatibility: { minimumSchema, maximumSchema } }
      : {}),
  }
}

export function createControlPlane(options: ControlPlaneOptions): Server {
  const loadAgentModelCatalog = cachedAgentModelCatalog(
    options.agentModelCatalog,
    options.agentModelCatalogTtlMs,
  )
  const logger = options.logger
  const metrics = options.metrics
  const linkPreviews = new LinkPreviewService(options.linkPreview)
  const server = createServer(async (request, response) => {
    const startedAt = performance.now()
    const method = request.method ?? 'GET'
    const path = request.url
      ? new URL(request.url, 'http://localhost').pathname
      : '/'
    response.on('finish', () => {
      const statusCode = response.statusCode
      if (!metrics || path === '/metrics' || path === '/healthz') return
      if (!path.startsWith('/v1/') && path !== '/readyz') return
      const route = metricRoute(path)
      metrics.increment('pegas_http_requests_total', {
        method,
        route,
        status: String(statusCode),
      })
      metrics.observe(
        'pegas_http_request_duration_seconds',
        (performance.now() - startedAt) / 1000,
        { method, route },
      )
      if (statusCode >= 500) {
        metrics.increment('pegas_errors_total', {
          component: 'control-plane',
          kind: 'http_5xx',
        })
      }
    })
    try {
      if (request.url === '/healthz' && request.method === 'GET') {
        return sendJson(response, 200, { status: 'ok' })
      }

      if (request.url === '/metrics' && request.method === 'GET') {
        if (!isAuthorized(request, options.apiToken)) {
          return sendJson(response, 401, { error: 'unauthorized' })
        }
        if (!metrics) {
          return sendJson(response, 404, { error: 'metrics_unavailable' })
        }
        response.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        })
        response.end(metrics.render())
        return
      }

      if (request.url === '/readyz' && request.method === 'GET') {
        return sendJson(response, options.store.ready() ? 200 : 503, {
          status: options.store.ready() ? 'ready' : 'not_ready',
          ...(process.env.PEGAS_RELEASE_ID
            ? { releaseId: process.env.PEGAS_RELEASE_ID }
            : {}),
        })
      }

      if (await tryServeWeb(request, response, options.webRoot)) return

      if (
        !isRunCapabilityWrite(request) &&
        !isConversationStateRead(request) &&
        !isAuthorized(request, options.apiToken)
      ) {
        return sendJson(response, 401, { error: 'unauthorized' })
      }

      if (
        request.url?.startsWith('/v1/voice/transcriptions') &&
        request.method === 'POST'
      ) {
        return await acceptVoiceTranscription(request, response, options)
      }

      if (
        request.url === '/v1/link-preview' ||
        request.url?.startsWith('/v1/link-preview?')
      ) {
        if (request.method !== 'GET') {
          return sendJson(response, 405, { error: 'method_not_allowed' })
        }
        const target = new URL(
          request.url,
          'http://localhost',
        ).searchParams.get('url')
        if (!target) {
          return sendJson(response, 400, { error: 'url_required' })
        }
        const preview = await linkPreviews.get(target)
        return sendJson(response, 200, preview)
      }

      if (
        request.url?.startsWith('/v1/voice/messages') &&
        request.method === 'POST'
      ) {
        return await acceptVoiceMessage(request, response, options)
      }

      if (
        request.url === '/v1/settings/speech/test' &&
        request.method === 'POST'
      ) {
        return await testSpeechConnection(request, response, options)
      }

      if (
        request.url === '/v1/settings/rewrite/test' &&
        request.method === 'POST'
      ) {
        return await testRewriteConnection(request, response, options)
      }

      if (request.url === '/v1/settings' && request.method === 'GET') {
        const capabilities = resolveSettingsCapabilities(options)
        if (!capabilities) {
          return sendJson(response, 503, { error: 'settings_unavailable' })
        }
        return sendJson(response, 200, {
          settings: options.store.getRuntimeSettings(),
          capabilities,
          speech: options.store.getSpeechSettings(),
          rewrite: options.store.getRewriteSettings(),
        })
      }

      if (request.url === '/v1/settings' && request.method === 'PUT') {
        const capabilities = resolveSettingsCapabilities(options)
        if (!capabilities || !options.modelCredentialVault) {
          return sendJson(response, 503, { error: 'settings_unavailable' })
        }
        const body = await readJson(request)
        const rewrite = parseRewriteConnectionUpdate(body)
        const rewriteMode =
          rewrite?.mode ?? options.store.getRewriteConnection().mode
        const update = parseRuntimeSettingsUpdate(
          body,
          capabilities,
          rewriteMode === 'custom',
        )
        const speech = parseSpeechConnectionUpdate(body)
        try {
          const settings = options.store.updateRuntimeSettingsAndProvider(
            update.expectedRevision,
            update.settings,
            {
              id: update.provider.id,
              name: update.provider.name,
              protocol: update.provider.protocol,
              baseUrl: update.provider.baseUrl,
              ...(update.provider.apiKey
                ? {
                    apiKeyCiphertext: options.modelCredentialVault.encrypt(
                      update.provider.apiKey,
                    ),
                  }
                : {}),
              clearApiKey: update.provider.clearApiKey,
            },
            speech
              ? {
                  provider: speech.provider,
                  baseUrl: speech.baseUrl,
                  model: speech.model,
                  ...(speech.apiKey
                    ? {
                        apiKeyCiphertext: options.modelCredentialVault.encrypt(
                          speech.apiKey,
                        ),
                      }
                    : {}),
                  clearApiKey: speech.clearApiKey,
                }
              : undefined,
            rewrite
              ? {
                  mode: rewrite.mode,
                  protocol: rewrite.protocol,
                  baseUrl: rewrite.baseUrl,
                  model: rewrite.model,
                  ...(rewrite.apiKey
                    ? {
                        apiKeyCiphertext: options.modelCredentialVault.encrypt(
                          rewrite.apiKey,
                        ),
                      }
                    : {}),
                  clearApiKey: rewrite.clearApiKey,
                }
              : undefined,
          )
          return sendJson(response, 200, {
            settings,
            capabilities: resolveSettingsCapabilities(options),
            speech: options.store.getSpeechSettings(),
            rewrite: options.store.getRewriteSettings(),
          })
        } catch (error) {
          if (error instanceof SettingsRevisionConflictError) {
            return sendJson(response, 409, {
              error: 'settings_conflict',
              message: error.message,
            })
          }
          throw error
        }
      }

      if (
        request.url === '/v1/settings/models/discover' &&
        request.method === 'POST'
      ) {
        const connection = modelProbeConnection(
          await readJson(request),
          options,
        )
        const models = await discoverModelCatalog({
          protocol: connection.protocol,
          baseUrl: connection.baseUrl,
          ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
          timeoutMs: options.modelTimeoutMs ?? 15_000,
        })
        return sendJson(response, 200, { models })
      }

      if (
        request.url === '/v1/settings/models/test' &&
        request.method === 'POST'
      ) {
        const connection = modelProbeConnection(
          await readJson(request),
          options,
        )
        const provider =
          connection.protocol === 'anthropic-messages'
            ? new AnthropicProvider({
                baseUrl: connection.baseUrl,
                model: connection.modelName,
                ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
                timeoutMs: options.modelTimeoutMs ?? 15_000,
              })
            : new OpenAiCompatibleProvider({
                baseUrl: connection.baseUrl,
                model: connection.modelName,
                ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
                timeoutMs: options.modelTimeoutMs ?? 15_000,
              })
        return sendJson(response, 200, await testModelConnection(provider))
      }

      if (
        request.url === '/v1/settings/agent-models' &&
        request.method === 'GET'
      ) {
        if (!loadAgentModelCatalog) {
          return sendJson(response, 503, { error: 'agent_models_unavailable' })
        }
        try {
          return sendJson(response, 200, await loadAgentModelCatalog())
        } catch {
          return sendJson(response, 503, {
            error: 'agent_models_unavailable',
          })
        }
      }

      if (request.url === '/v1/events' && request.method === 'POST') {
        const body = await readJson(request)
        const input = parseNewInboxEvent(body)
        const taskId = explicitTaskId(input)
        if (taskId) {
          const task = options.store.findTask(taskId, input.userId)
          if (!task) throw new Error(`Task ${taskId} does not exist for user`)
          if (task.status === 'cancelled')
            throw new Error('Task was stopped by the user')
          if (explicitSteerIntent(input)) {
            if (task.status !== 'started')
              throw new Error(
                'Steering requires a started task; queue the message instead',
              )
            const activeRun = options.store
              .listRunsForUser(input.userId, taskId)
              .some(run => run.status === 'queued' || run.status === 'running')
            if (!activeRun)
              throw new Error(
                'Steering requires a queued or running Run; queue the message instead',
              )
          }
        }
        const sourceTaskId = sourceContextTaskId(input)
        if (sourceTaskId) {
          const source = options.store.findTask(sourceTaskId, input.userId)
          if (!source)
            throw new Error(`Task ${sourceTaskId} does not exist for user`)
          if (source.status !== 'completed' && source.status !== 'cancelled')
            throw new Error(
              'sourceTaskId must reference a completed or cancelled Task',
            )
        }
        const result = options.store.enqueueEvent(input)
        return sendJson(response, result.inserted ? 202 : 200, result)
      }

      const eventsGetUrl = new URL(request.url ?? '/', 'http://localhost')
      if (eventsGetUrl.pathname === '/v1/events' && request.method === 'GET') {
        const url = eventsGetUrl
        const userId = url.searchParams.get('userId')
        if (!userId) throw new Error('userId is required')
        const cursor = url.searchParams.get('cursor') ?? undefined
        if (cursor) {
          const rawLimit = url.searchParams.get('limit')
          const page = options.store.pageEventsAfter(
            userId,
            rawLimit ? Number(rawLimit) : 50,
            cursor,
          )
          return sendJson(response, 200, {
            events: page.events,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          })
        }
        return sendJson(response, 200, {
          events: options.store.listEvents(userId),
        })
      }

      const eventResourceUrl = new URL(request.url ?? '/', 'http://localhost')
      const attachmentMatch = /^\/v1\/events\/([^/]+)\/attachments$/.exec(
        eventResourceUrl.pathname,
      )
      if (attachmentMatch) {
        const eventId = decodeURIComponent(attachmentMatch[1] ?? '')
        if (request.method === 'POST') {
          const userId = requiredQuery(eventResourceUrl, 'userId')
          const fileName = requiredQuery(eventResourceUrl, 'fileName')
          if (Array.from(fileName).length > 255)
            throw new Error('fileName must contain at most 255 characters')
          const mediaType =
            headerValue(request, 'content-type') ?? 'application/octet-stream'
          const bytes = await readBytes(request, maximumAttachmentBytes)
          if (bytes.byteLength === 0)
            throw new Error('Attachment body is required')
          const attachment = options.store.attachEventFile(eventId, userId, {
            fileName,
            mediaType,
            bytes,
          })
          return sendJson(response, 201, { attachment })
        }
        if (request.method === 'GET') {
          const userId = requiredQuery(eventResourceUrl, 'userId')
          const stored = options.store.readEventAttachmentBytes(eventId, userId)
          if (!stored) return sendJson(response, 404, { error: 'not_found' })
          response.writeHead(200, {
            'content-type': stored.attachment.mediaType,
            'content-length': String(stored.attachment.byteSize),
            'x-pegas-attachment-sha256': stored.attachment.sha256,
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(stored.attachment.fileName)}`,
          })
          return response.end(stored.bytes)
        }
      }

      const taskResourceUrl = new URL(request.url ?? '/', 'http://localhost')
      if (
        taskResourceUrl.pathname === '/v1/memories' &&
        request.method === 'GET'
      ) {
        const userId = requiredQuery(taskResourceUrl, 'userId')
        const page = pageRequest(taskResourceUrl)
        const scopeValue = optionalQuery(taskResourceUrl, 'scope')
        const categoryValue = optionalQuery(taskResourceUrl, 'category')
        const taskId = optionalQuery(taskResourceUrl, 'taskId')
        const scope = scopeValue ? parseMemoryScope(scopeValue) : undefined
        if (scope === 'global' && taskId)
          throw new Error('Global Memory cannot be filtered by taskId')
        if ((scope === 'worker' || scope === 'channel') && !taskId)
          throw new Error(`${scope} Memory requires taskId`)
        const result = options.store.listMemories(
          userId,
          page.limit,
          page.cursor,
          {
            ...(scope ? { scope } : {}),
            ...(taskId ? { taskId } : {}),
            ...(categoryValue
              ? { category: parseMemoryCategory(categoryValue) }
              : {}),
          },
        )
        return sendJson(response, 200, {
          memories: result.items,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        })
      }
      if (
        taskResourceUrl.pathname === '/v1/memories' &&
        request.method === 'POST'
      ) {
        const memory = options.store.createMemory(
          parseMemoryCreate(await readJson(request)),
        )
        return sendJson(response, 201, { memory })
      }
      const memoryResourceMatch =
        /^\/v1\/memories\/([^/]+)(?:\/(delete))?$/.exec(
          taskResourceUrl.pathname,
        )
      if (memoryResourceMatch) {
        const memoryId = decodeURIComponent(memoryResourceMatch[1] ?? '')
        const action = memoryResourceMatch[2]
        if (!action && request.method === 'GET') {
          const userId = requiredQuery(taskResourceUrl, 'userId')
          const memory = options.store.findMemory(memoryId, userId)
          if (!memory) return sendJson(response, 404, { error: 'not_found' })
          return sendJson(response, 200, { memory })
        }
        if (!action && request.method === 'PUT') {
          const memory = options.store.updateMemory(
            memoryId,
            parseMemoryUpdate(await readJson(request)),
          )
          return sendJson(response, 200, { memory })
        }
        if (action === 'delete' && request.method === 'POST') {
          const deletion = options.store.deleteMemory(
            memoryId,
            parseMemoryDelete(await readJson(request)),
          )
          return sendJson(response, 200, { deletion })
        }
      }
      if (
        taskResourceUrl.pathname === '/v1/automations' &&
        request.method === 'GET'
      ) {
        const userId = requiredQuery(taskResourceUrl, 'userId')
        return sendJson(response, 200, {
          automations: options.store.listAutomations(userId),
        })
      }
      if (
        taskResourceUrl.pathname === '/v1/rules' &&
        request.method === 'GET'
      ) {
        const userId = requiredQuery(taskResourceUrl, 'userId')
        const page = pageRequest(taskResourceUrl)
        const result = options.store.listWorkRules(
          userId,
          page.limit,
          page.cursor,
        )
        return sendJson(response, 200, {
          rules: result.items,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        })
      }
      if (
        taskResourceUrl.pathname === '/v1/rules' &&
        request.method === 'POST'
      ) {
        const rule = options.store.createWorkRule(
          parseWorkRuleCreate(await readJson(request)),
        )
        return sendJson(response, 201, { rule })
      }
      const ruleResourceMatch = /^\/v1\/rules\/([^/]+)(?:\/(delete))?$/.exec(
        taskResourceUrl.pathname,
      )
      if (ruleResourceMatch) {
        const ruleId = decodeURIComponent(ruleResourceMatch[1] ?? '')
        const action = ruleResourceMatch[2]
        if (!action && request.method === 'GET') {
          const userId = requiredQuery(taskResourceUrl, 'userId')
          const rule = options.store.findWorkRule(ruleId, userId)
          if (!rule) return sendJson(response, 404, { error: 'not_found' })
          return sendJson(response, 200, { rule })
        }
        if (!action && request.method === 'PUT') {
          const rule = options.store.updateWorkRule(
            ruleId,
            parseWorkRuleUpdate(await readJson(request)),
          )
          return sendJson(response, 200, { rule })
        }
        if (action === 'delete' && request.method === 'POST') {
          const deletion = options.store.deleteWorkRule(
            ruleId,
            parseWorkRuleDelete(await readJson(request)),
          )
          return sendJson(response, 200, { deletion })
        }
      }
      if (
        taskResourceUrl.pathname === '/v1/settings/behavior' &&
        (request.method === 'GET' || request.method === 'PUT')
      ) {
        if (request.method === 'GET') {
          return sendJson(response, 200, {
            preferences: options.store.getBehaviorPreferences(
              requiredQuery(taskResourceUrl, 'userId'),
            ),
          })
        }
        const body = await readJson(request)
        if (!isRecord(body)) throw new Error('Request body must be an object')
        const preferences = options.store.updateBehaviorPreferences(
          requiredString(body.userId, 'userId'),
          {
            expectedRevision: nonnegativeInteger(
              body.expectedRevision,
              'expectedRevision',
            ),
            customInstructions: parseCustomInstructions(
              body.customInstructions,
            ),
          },
        )
        return sendJson(response, 200, { preferences })
      }
      if (
        taskResourceUrl.pathname === '/v1/automations' &&
        request.method === 'POST'
      ) {
        const command = parseAutomationCreate(await readJson(request))
        try {
          const automation = options.store.createAutomation(command)
          return sendJson(response, 201, { automation })
        } catch (error) {
          return sendAutomationError(response, error)
        }
      }
      const automationResourceMatch =
        /^\/v1\/automations\/([^/]+)(?:\/(pause|resume|cancel|invocations))?$/.exec(
          taskResourceUrl.pathname,
        )
      if (automationResourceMatch) {
        const automationId = decodeURIComponent(
          automationResourceMatch[1] ?? '',
        )
        const action = automationResourceMatch[2]
        if (!action && request.method === 'GET') {
          const userId = requiredQuery(taskResourceUrl, 'userId')
          const automation = options.store.findAutomation(automationId, userId)
          if (!automation)
            return sendJson(response, 404, { error: 'not_found' })
          return sendJson(response, 200, { automation })
        }
        if (!action && request.method === 'PUT') {
          const command = parseAutomationUpdate(await readJson(request))
          try {
            const automation = options.store.updateAutomation(
              automationId,
              command,
            )
            return sendJson(response, 200, { automation })
          } catch (error) {
            return sendAutomationError(response, error)
          }
        }
        if (action && action !== 'invocations' && request.method === 'POST') {
          const command = parseAutomationStatusCommand(await readJson(request))
          try {
            const automation =
              action === 'pause'
                ? options.store.pauseAutomation(automationId, command)
                : action === 'resume'
                  ? options.store.resumeAutomation(automationId, command)
                  : options.store.cancelAutomation(automationId, command)
            return sendJson(response, 200, { automation })
          } catch (error) {
            return sendAutomationError(response, error)
          }
        }
        if (action === 'invocations' && request.method === 'GET') {
          const userId = requiredQuery(taskResourceUrl, 'userId')
          const requestedLimit = optionalQuery(taskResourceUrl, 'limit')
          const limit =
            requestedLimit === undefined
              ? 100
              : Number.parseInt(requestedLimit, 10)
          try {
            return sendJson(response, 200, {
              invocations: options.store.listAutomationInvocations(
                automationId,
                userId,
                limit,
              ),
            })
          } catch (error) {
            return sendAutomationError(response, error)
          }
        }
      }
      const runCollaborationMatch =
        /^\/v1\/runs\/([^/]+)\/collaborations$/.exec(taskResourceUrl.pathname)
      if (runCollaborationMatch && request.method === 'POST') {
        const claimToken = runClaimToken(request)
        if (!claimToken)
          return sendJson(response, 403, { error: 'run_claim_required' })
        const runId = decodeURIComponent(runCollaborationMatch[1] ?? '')
        options.store.assertCollaborationCapability(runId, claimToken)
        const relation = options.store.createCollaboration(
          runId,
          claimToken,
          parseWorkerCollaborationRequest(await readJson(request)),
        )
        return sendJson(response, 201, { relation })
      }
      const runGoalProposalMatch = /^\/v1\/runs\/([^/]+)\/goal-proposals$/.exec(
        taskResourceUrl.pathname,
      )
      if (runGoalProposalMatch && request.method === 'POST') {
        const claimToken = runClaimToken(request)
        if (!claimToken)
          return sendJson(response, 403, { error: 'run_claim_required' })
        const runId = decodeURIComponent(runGoalProposalMatch[1] ?? '')
        options.store.assertGoalProposalCapability(runId, claimToken)
        const body = await readJson(request)
        if (!isRecord(body)) throw new Error('Request body must be an object')
        const result = options.store.proposeGoalFromRun(
          runId,
          claimToken,
          requiredString(body.commandId, 'commandId'),
          parseGoalContractDraft(body.goal),
        )
        return sendJson(response, 201, result)
      }
      const runFollowUpMatch = /^\/v1\/runs\/([^/]+)\/follow-ups$/.exec(
        taskResourceUrl.pathname,
      )
      if (runFollowUpMatch && request.method === 'POST') {
        const claimToken = runClaimToken(request)
        if (!claimToken)
          return sendJson(response, 403, { error: 'run_claim_required' })
        const runId = decodeURIComponent(runFollowUpMatch[1] ?? '')
        const command = parseFollowUpCommand(await readJson(request))
        try {
          const result = options.store.createFollowUpFromRun(
            runId,
            claimToken,
            command,
          )
          return sendJson(response, 201, result)
        } catch (error) {
          if (error instanceof RunClaimError)
            return sendJson(response, 403, { error: 'run_claim_invalid' })
          return sendAutomationError(response, error)
        }
      }
      const runAutomationMatch = /^\/v1\/runs\/([^/]+)\/automations$/.exec(
        taskResourceUrl.pathname,
      )
      const runMessageMatch = /^\/v1\/runs\/([^/]+)\/messages$/.exec(
        taskResourceUrl.pathname,
      )
      if (runMessageMatch && request.method === 'POST') {
        const claimToken = runClaimToken(request)
        if (!claimToken)
          return sendJson(response, 403, { error: 'run_claim_required' })
        const runId = decodeURIComponent(runMessageMatch[1] ?? '')
        const command = parseRunMessageCommand(await readJson(request))
        try {
          const result = options.store.sayFromRun(runId, claimToken, command)
          return sendJson(response, 201, result)
        } catch (error) {
          if (error instanceof RunClaimError)
            return sendJson(response, 403, { error: 'run_claim_invalid' })
          if (error instanceof RunMessageCommandConflictError)
            return sendJson(response, 409, {
              error: 'run_message_command_conflict',
            })
          throw error
        }
      }
      if (runAutomationMatch && request.method === 'POST') {
        const claimToken = runClaimToken(request)
        if (!claimToken)
          return sendJson(response, 403, { error: 'run_claim_required' })
        const runId = decodeURIComponent(runAutomationMatch[1] ?? '')
        const command = parseRunAutomationCommand(await readJson(request))
        try {
          const result = options.store.createRunAutomation(
            runId,
            claimToken,
            command,
          )
          return sendJson(response, 201, result)
        } catch (error) {
          if (error instanceof RunClaimError)
            return sendJson(response, 403, { error: 'run_claim_invalid' })
          return sendAutomationError(response, error)
        }
      }
      const runAutomationStatusMatch =
        /^\/v1\/runs\/([^/]+)\/automations\/([^/]+)\/(pause|resume|cancel)$/.exec(
          taskResourceUrl.pathname,
        )
      if (runAutomationStatusMatch && request.method === 'POST') {
        const claimToken = runClaimToken(request)
        if (!claimToken)
          return sendJson(response, 403, { error: 'run_claim_required' })
        const runId = decodeURIComponent(runAutomationStatusMatch[1] ?? '')
        const automationId = decodeURIComponent(
          runAutomationStatusMatch[2] ?? '',
        )
        const operation = runAutomationStatusMatch[3] as
          'pause' | 'resume' | 'cancel'
        const command = parseRunAutomationStatusCommand(await readJson(request))
        try {
          const result = options.store.transitionRunAutomation(
            runId,
            claimToken,
            automationId,
            operation,
            command,
          )
          return sendJson(response, 200, result)
        } catch (error) {
          if (error instanceof RunClaimError)
            return sendJson(response, 403, { error: 'run_claim_invalid' })
          return sendAutomationError(response, error)
        }
      }
      const workerProfileMatch = /^\/v1\/tasks\/([^/]+)\/worker-profile$/.exec(
        taskResourceUrl.pathname,
      )
      if (workerProfileMatch && request.method === 'GET') {
        const taskId = decodeURIComponent(workerProfileMatch[1] ?? '')
        const userId = requiredQuery(taskResourceUrl, 'userId')
        if (!options.store.findTask(taskId, userId))
          return sendJson(response, 404, { error: 'not_found' })
        const profile = options.store.getWorkerProfile(taskId, userId)
        return sendJson(response, 200, {
          profile,
          effective: effectiveWorkerProfile(
            profile,
            options.store.getRuntimeSettings(),
          ),
        })
      }
      if (workerProfileMatch && request.method === 'PUT') {
        const taskId = decodeURIComponent(workerProfileMatch[1] ?? '')
        const body = await readJson(request)
        if (!isRecord(body)) throw new Error('Request body must be an object')
        const userId = requiredString(body.userId, 'userId')
        const task = options.store.findTask(taskId, userId)
        if (!task) return sendJson(response, 404, { error: 'not_found' })
        try {
          const update = parseWorkerProfileUpdate(body)
          const replay = options.store.replayWorkerProfileUpdate(
            taskId,
            userId,
            update,
          )
          if (replay) {
            return sendJson(response, 200, {
              profile: replay,
              effective: effectiveWorkerProfile(
                replay,
                options.store.getRuntimeSettings(),
              ),
            })
          }
          if (task.status === 'cancelled') {
            return sendJson(response, 409, {
              error: 'worker_profile_read_only',
            })
          }
          if (update.modelMode === 'override') {
            if (!loadAgentModelCatalog) {
              return sendJson(response, 503, {
                error: 'agent_models_unavailable',
              })
            }
            let catalog: DshModelCatalog
            try {
              catalog = await loadAgentModelCatalog()
            } catch {
              return sendJson(response, 503, {
                error: 'agent_models_unavailable',
              })
            }
            const available = catalog.models.some(
              model =>
                model.provider === update.modelProvider &&
                model.id === update.modelName,
            )
            if (!available) {
              return sendJson(response, 422, {
                error: 'worker_model_unavailable',
              })
            }
          }
          const profile = options.store.updateWorkerProfile(
            taskId,
            userId,
            update,
          )
          return sendJson(response, 200, {
            profile,
            effective: effectiveWorkerProfile(
              profile,
              options.store.getRuntimeSettings(),
            ),
          })
        } catch (error) {
          if (error instanceof WorkerProfileRevisionConflictError) {
            return sendJson(response, 409, {
              error: 'worker_profile_conflict',
              message: error.message,
            })
          }
          if (error instanceof WorkerProfileReadOnlyError) {
            return sendJson(response, 409, {
              error: 'worker_profile_read_only',
            })
          }
          throw error
        }
      }
      const taskGoalMatch = /^\/v1\/tasks\/([^/]+)\/goals$/.exec(
        taskResourceUrl.pathname,
      )
      if (taskGoalMatch && request.method === 'GET') {
        const userId = requiredQuery(taskResourceUrl, 'userId')
        const taskId = decodeURIComponent(taskGoalMatch[1] ?? '')
        const page = pageRequest(taskResourceUrl)
        const contracts = options.store.pageGoalContracts(
          taskId,
          userId,
          page.limit,
          page.cursor,
        )
        return sendJson(response, 200, {
          contracts: contracts.items,
          current: options.store.currentGoalContract(taskId, userId),
          ...(contracts.nextCursor ? { nextCursor: contracts.nextCursor } : {}),
        })
      }
      if (taskGoalMatch && request.method === 'POST') {
        const body = await readJson(request)
        if (!isRecord(body)) throw new Error('Request body must be an object')
        const contract = options.store.createGoalContract(
          decodeURIComponent(taskGoalMatch[1] ?? ''),
          requiredString(body.userId, 'userId'),
          requiredString(body.commandId, 'commandId'),
          parseGoalContractDraft(body.goal),
        )
        return sendJson(response, 201, { contract })
      }

      const taskArtifactMatch = /^\/v1\/tasks\/([^/]+)\/artifacts$/.exec(
        taskResourceUrl.pathname,
      )
      if (taskArtifactMatch && request.method === 'GET') {
        const userId = requiredQuery(taskResourceUrl, 'userId')
        const page = pageRequest(taskResourceUrl)
        const artifacts = options.store.pageArtifacts(
          decodeURIComponent(taskArtifactMatch[1] ?? ''),
          userId,
          page.limit,
          page.cursor,
        )
        return sendJson(response, 200, {
          artifacts: artifacts.items,
          ...(artifacts.nextCursor ? { nextCursor: artifacts.nextCursor } : {}),
        })
      }
      if (taskArtifactMatch && request.method === 'POST') {
        const body = await readJson(request)
        if (!isRecord(body)) throw new Error('Request body must be an object')
        const artifact = options.store.createArtifact(
          decodeURIComponent(taskArtifactMatch[1] ?? ''),
          requiredString(body.userId, 'userId'),
          requiredString(body.commandId, 'commandId'),
          parseArtifactDraft(body.artifact),
        )
        return sendJson(response, 201, { artifact })
      }

      const taskEvidenceMatch = /^\/v1\/tasks\/([^/]+)\/evidence$/.exec(
        taskResourceUrl.pathname,
      )
      if (taskEvidenceMatch && request.method === 'GET') {
        const userId = requiredQuery(taskResourceUrl, 'userId')
        const page = pageRequest(taskResourceUrl)
        const revision = taskResourceUrl.searchParams.get('goalRevision')
        const parsedRevision = revision ? Number(revision) : undefined
        if (
          parsedRevision !== undefined &&
          (!Number.isSafeInteger(parsedRevision) || parsedRevision <= 0)
        )
          throw new Error('goalRevision must be a positive integer')
        const evidence = options.store.pageEvidenceRefs(
          decodeURIComponent(taskEvidenceMatch[1] ?? ''),
          userId,
          page.limit,
          page.cursor,
          parsedRevision,
        )
        return sendJson(response, 200, {
          evidence: evidence.items,
          ...(evidence.nextCursor ? { nextCursor: evidence.nextCursor } : {}),
        })
      }

      const taskReviewMatch = /^\/v1\/tasks\/([^/]+)\/review-packs$/.exec(
        taskResourceUrl.pathname,
      )
      if (taskReviewMatch && request.method === 'GET') {
        const userId = requiredQuery(taskResourceUrl, 'userId')
        const page = pageRequest(taskResourceUrl)
        const taskId = decodeURIComponent(taskReviewMatch[1] ?? '')
        const reviewPacks = options.store.pageReviewPacks(
          taskId,
          userId,
          page.limit,
          page.cursor,
        )
        const currentGoal = options.store.currentGoalContract(taskId, userId)
        const current = currentGoal
          ? options.store.currentReviewPack(
              taskId,
              userId,
              currentGoal.revision,
            )
          : undefined
        return sendJson(response, 200, {
          reviewPacks: reviewPacks.items,
          current,
          ...(reviewPacks.nextCursor
            ? { nextCursor: reviewPacks.nextCursor }
            : {}),
        })
      }

      const taskDeliveryMatch = /^\/v1\/tasks\/([^/]+)\/delivery$/.exec(
        taskResourceUrl.pathname,
      )
      if (taskDeliveryMatch && request.method === 'GET') {
        const userId = requiredQuery(taskResourceUrl, 'userId')
        const taskId = decodeURIComponent(taskDeliveryMatch[1] ?? '')
        const current = options.store.currentGoalContract(taskId, userId)
        const currentRun = options.store.listRunsForUser(userId, taskId).at(-1)
        const currentReviewPack = current
          ? options.store.currentReviewPack(taskId, userId, current.revision)
          : undefined
        const reviewEvidenceIds = currentReviewPack?.criteria.flatMap(
          criterion => criterion.evidenceRefs,
        )
        const evidencePage = options.store.pageEvidenceRefs(
          taskId,
          userId,
          defaultPageLimit,
          undefined,
          current?.revision,
          currentRun?.id,
        )
        const evidence = reviewEvidenceIds
          ? options.store.evidenceByIds(taskId, userId, reviewEvidenceIds)
          : evidencePage.items
        const artifacts = options.store.artifactsByIds(
          taskId,
          userId,
          evidence.flatMap(item => (item.artifactId ? [item.artifactId] : [])),
        )
        return sendJson(response, 200, {
          goal: current,
          artifacts,
          evidence,
          reviewPack: currentReviewPack,
          continuation: {
            ...(!currentReviewPack && evidencePage.nextCursor
              ? { evidence: evidencePage.nextCursor }
              : {}),
          },
        })
      }

      if (request.url?.startsWith('/v1/tasks') && request.method === 'GET') {
        const url = new URL(request.url, 'http://localhost')
        const userId = url.searchParams.get('userId') ?? undefined
        return sendJson(response, 200, {
          tasks: options.store.listTasks(userId),
        })
      }

      const channelTimelineUrl = request.url
        ? new URL(request.url, 'http://localhost')
        : undefined
      const channelTimelineMatch = channelTimelineUrl?.pathname.match(
        /^\/v1\/channels\/([^/]+)\/timeline$/,
      )
      if (channelTimelineMatch && request.method === 'GET') {
        const userId = channelTimelineUrl?.searchParams.get('userId')
        if (!userId) throw new Error('userId is required')
        const taskId = decodeURIComponent(channelTimelineMatch[1] ?? '')
        const task = options.store.findTask(taskId, userId)
        if (!task) return sendJson(response, 404, { error: 'not_found' })
        const rawLimit = channelTimelineUrl?.searchParams.get('limit')
        const cursor =
          channelTimelineUrl?.searchParams.get('cursor') ?? undefined
        const page = options.store.pageChannelEvents(
          taskId,
          userId,
          rawLimit ? Number(rawLimit) : 50,
          cursor,
        )
        return sendJson(response, 200, {
          channel: projectWorkChannel(task),
          events: page.events,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          routing: options.store.listChannelRoutingDecisions(taskId, userId),
          runs: options.store.listRuns(taskId),
          messages: options.store.listOutbox(userId, taskId),
        })
      }

      if (channelTimelineUrl?.pathname === '/v1/channels/search') {
        if (request.method !== 'GET') {
          return sendJson(response, 405, { error: 'method_not_allowed' })
        }
        const userId = requiredQuery(channelTimelineUrl, 'userId')
        const page = pageRequest(channelTimelineUrl)
        const query = optionalQuery(channelTimelineUrl, 'q')
        if (query && Array.from(query).length > 200)
          throw new Error('q must contain at most 200 characters')
        const statuses = parseChannelStatuses(
          channelTimelineUrl.searchParams.get('status'),
        )
        const sort = parseChannelSearchSort(
          channelTimelineUrl.searchParams.get('sort'),
        )
        const ended = optionalBooleanQuery(channelTimelineUrl, 'ended')
        const needsAttention = optionalBooleanQuery(
          channelTimelineUrl,
          'needsAttention',
        )
        const workerIconId = parseWorkerIconQuery(
          channelTimelineUrl.searchParams.get('workerIconId'),
        )
        const searchOptions: ChannelSearchOptions = {
          ...(query ? { query } : {}),
          ...(statuses ? { statuses } : {}),
          ...(ended === undefined ? {} : { ended }),
          ...(needsAttention === undefined ? {} : { needsAttention }),
          ...(workerIconId ? { workerIconId } : {}),
          ...(sort ? { sort } : {}),
          limit: page.limit,
          ...(page.cursor ? { cursor: page.cursor } : {}),
        }
        return sendJson(
          response,
          200,
          options.store.searchChannels(userId, searchOptions),
        )
      }

      const channelCollaborationMatch = channelTimelineUrl?.pathname.match(
        /^\/v1\/channels\/([^/]+)\/collaborations$/,
      )
      if (channelCollaborationMatch && request.method === 'GET') {
        const userId = channelTimelineUrl?.searchParams.get('userId')
        if (!userId) throw new Error('userId is required')
        const taskId = decodeURIComponent(channelCollaborationMatch[1] ?? '')
        if (!options.store.findTask(taskId, userId))
          return sendJson(response, 404, { error: 'not_found' })
        const page = pageRequest(taskResourceUrl)
        const relations = options.store.pageCollaborations(
          taskId,
          userId,
          page.limit,
          page.cursor,
        )
        return sendJson(response, 200, {
          relations: relations.items,
          ...(relations.nextCursor ? { nextCursor: relations.nextCursor } : {}),
        })
      }

      if (request.url?.startsWith('/v1/channels') && request.method === 'GET') {
        const url = new URL(request.url, 'http://localhost')
        const userId = url.searchParams.get('userId')
        if (!userId) throw new Error('userId is required')
        return sendJson(response, 200, {
          channels: options.store
            .listTasks(userId)
            .filter(task => task.kind !== 'conversation')
            .map(task => projectWorkChannel(task)),
        })
      }

      if (
        new URL(request.url ?? '/', 'http://localhost').pathname ===
          '/v1/nodes' &&
        request.method === 'GET'
      ) {
        return sendJson(response, 200, {
          nodes: options.store.listExecutionNodes(),
        })
      }

      const recoveryStatusPath = new URL(request.url ?? '/', 'http://localhost')
        .pathname
      if (recoveryStatusPath === '/v1/recovery/status') {
        if (request.method !== 'GET') {
          return sendJson(response, 405, { error: 'method_not_allowed' })
        }
        if (!options.recoveryStatus) {
          return sendJson(response, 200, {
            available: false,
            integrity: 'unavailable',
            source: 'none',
            diagnostics: ['未配置独立恢复平面（PEGAS_RECOVERY_BASE_URL）。'],
          } satisfies RecoveryStatusProjection)
        }
        return sendJson(
          response,
          200,
          await fetchRecoveryStatus(options.recoveryStatus),
        )
      }

      if (request.url?.startsWith('/v1/usage') && request.method === 'GET') {
        const url = new URL(request.url, 'http://localhost')
        const userId = url.searchParams.get('userId')
        if (!userId) throw new Error('userId is required')
        const taskId = url.searchParams.get('taskId') ?? undefined
        const report = options.store.listModelUsage(userId, taskId)
        return sendJson(response, 200, {
          ...report,
          ...(taskId ? {} : { router: options.store.listRouterUsage(userId) }),
        })
      }

      if (
        request.url?.startsWith('/v1/reconciliation') &&
        request.method === 'GET'
      ) {
        const url = new URL(request.url, 'http://localhost')
        const userId = url.searchParams.get('userId') ?? undefined
        return sendJson(response, 200, {
          owed: options.store.listOwedDeliveries(userId),
          findings: options.store.listReconciliationFindings(),
        })
      }

      const stopChannelMatch = request.url?.match(
        /^\/v1\/channels\/([^/]+)\/stop$/,
      )
      if (stopChannelMatch && request.method === 'POST') {
        const body = await readJson(request)
        if (!body || typeof body !== 'object')
          throw new Error('request body is required')
        const userId = 'userId' in body ? body.userId : undefined
        const commandId = 'commandId' in body ? body.commandId : undefined
        const reason = 'reason' in body ? body.reason : undefined
        if (typeof userId !== 'string' || !userId.trim())
          throw new Error('userId is required')
        if (typeof commandId !== 'string' || !commandId.trim())
          throw new Error('commandId is required')
        if (reason !== undefined && typeof reason !== 'string')
          throw new Error('reason must be a string')
        const task = options.store.stopTask(
          decodeURIComponent(stopChannelMatch[1] ?? ''),
          userId,
          commandId,
          reason,
        )
        return sendJson(response, 200, {
          channel: projectWorkChannel(task),
        })
      }

      const retryMatch = request.url?.match(/^\/v1\/runs\/([^/]+)\/retry$/)
      if (retryMatch && request.method === 'POST') {
        const body = await readJson(request)
        if (
          !body ||
          typeof body !== 'object' ||
          !('userId' in body) ||
          typeof body.userId !== 'string' ||
          !body.userId.trim()
        )
          throw new Error('userId is required')
        return sendJson(response, 200, {
          run: options.store.retryRun(
            decodeURIComponent(retryMatch[1] ?? ''),
            body.userId,
          ),
        })
      }

      const eventRetryMatch = request.url?.match(
        /^\/v1\/events\/([^/]+)\/retry$/,
      )
      if (eventRetryMatch && request.method === 'POST') {
        const body = await readJson(request)
        if (
          !body ||
          typeof body !== 'object' ||
          !('userId' in body) ||
          typeof body.userId !== 'string' ||
          !body.userId.trim()
        )
          throw new Error('userId is required')
        return sendJson(response, 200, {
          event: options.store.retryEvent(
            decodeURIComponent(eventRetryMatch[1] ?? ''),
            body.userId,
          ),
        })
      }

      const runApprovalMatch = /^\/v1\/runs\/([^/]+)\/approvals$/.exec(
        taskResourceUrl.pathname,
      )
      if (runApprovalMatch && request.method === 'POST') {
        const claimToken = runClaimToken(request)
        if (!claimToken)
          return sendJson(response, 403, { error: 'run_claim_required' })
        const runId = decodeURIComponent(runApprovalMatch[1] ?? '')
        options.store.assertApprovalRequestCapability(runId, claimToken)
        const body = await readJson(request)
        if (!isRecord(body)) throw new Error('Request body must be an object')
        return sendJson(
          response,
          201,
          options.store.requestApproval(
            runId,
            claimToken,
            parseActionRequestDraft(body.action),
          ),
        )
      }

      if (
        /^\/v1\/approvals(?:\/|$)/.test(taskResourceUrl.pathname) &&
        (!options.apiToken || !isAuthorized(request, options.apiToken))
      ) {
        return sendJson(response, 401, { error: 'unauthorized' })
      }

      const approvalDecisionMatch =
        /^\/v1\/approvals\/([^/]+)\/decisions$/.exec(taskResourceUrl.pathname)
      if (approvalDecisionMatch && request.method === 'POST') {
        const body = await readJson(request)
        if (!isRecord(body)) throw new Error('Request body must be an object')
        const result = options.store.decideApproval(
          decodeURIComponent(approvalDecisionMatch[1] ?? ''),
          requiredString(body.userId, 'userId'),
          parseApprovalDecisionDraft(body),
        )
        return sendJson(
          response,
          result.event.status === 'processed' ? 200 : 202,
          result,
        )
      }

      const approvalMatch = /^\/v1\/approvals\/([^/]+)$/.exec(
        taskResourceUrl.pathname,
      )
      if (approvalMatch && request.method === 'GET') {
        const approval = options.store.getApproval(
          decodeURIComponent(approvalMatch[1] ?? ''),
          requiredQuery(taskResourceUrl, 'userId'),
        )
        return approval
          ? sendJson(response, 200, { approval })
          : sendJson(response, 404, { error: 'not_found' })
      }

      if (
        taskResourceUrl.pathname === '/v1/approvals' &&
        request.method === 'GET'
      ) {
        const userId = requiredQuery(taskResourceUrl, 'userId')
        const statusValue = taskResourceUrl.searchParams.get('status')
        const status = statusValue
          ? parseApprovalStatus(statusValue)
          : undefined
        const page = pageRequest(taskResourceUrl)
        const approvals = options.store.pageApprovals(
          userId,
          page.limit,
          page.cursor,
          status,
        )
        return sendJson(response, 200, {
          approvals: approvals.items,
          ...(approvals.nextCursor ? { nextCursor: approvals.nextCursor } : {}),
        })
      }

      const actionMatch = /^\/v1\/actions\/([^/]+)$/.exec(
        taskResourceUrl.pathname,
      )
      if (actionMatch && request.method === 'GET') {
        if (!options.apiToken || !isAuthorized(request, options.apiToken)) {
          return sendJson(response, 401, { error: 'unauthorized' })
        }
        const action = options.store.getAction(
          decodeURIComponent(actionMatch[1] ?? ''),
          requiredQuery(taskResourceUrl, 'userId'),
        )
        return action
          ? sendJson(response, 200, { action })
          : sendJson(response, 404, { error: 'not_found' })
      }

      const actionReconcileMatch = /^\/v1\/actions\/([^/]+)\/reconcile$/.exec(
        taskResourceUrl.pathname,
      )
      if (actionReconcileMatch && request.method === 'POST') {
        if (!options.apiToken || !isAuthorized(request, options.apiToken)) {
          return sendJson(response, 401, { error: 'unauthorized' })
        }
        const body = await readJson(request)
        if (!isRecord(body)) throw new Error('Request body must be an object')
        const action = options.store.reconcileAction(
          decodeURIComponent(actionReconcileMatch[1] ?? ''),
          requiredString(body.userId, 'userId'),
          parseActionReconciliationDraft(body),
        )
        return sendJson(response, 201, { action })
      }

      const actionOutcomeMatch = /^\/v1\/actions\/([^/]+)\/outcomes$/.exec(
        taskResourceUrl.pathname,
      )
      if (actionOutcomeMatch && request.method === 'POST') {
        const claimToken = runClaimToken(request)
        if (!claimToken)
          return sendJson(response, 403, { error: 'run_claim_required' })
        const actionId = decodeURIComponent(actionOutcomeMatch[1] ?? '')
        options.store.assertActionOutcomeCapability(actionId, claimToken)
        const body = await readJson(request)
        return sendJson(response, 201, {
          action: options.store.recordActionOutcome(
            actionId,
            claimToken,
            parseActionOutcomeDraft(body),
          ),
        })
      }

      const runEvidenceMatch = /^\/v1\/runs\/([^/]+)\/evidence$/.exec(
        taskResourceUrl.pathname,
      )
      if (runEvidenceMatch && request.method === 'POST') {
        const body = await readJson(request)
        if (!isRecord(body)) throw new Error('Request body must be an object')
        const userId = requiredString(body.userId, 'userId')
        if (body.confirmedForCapture !== true)
          throw new Error(
            'confirmedForCapture must be true to record an unverified user claim',
          )
        const claim = parseEvidenceClaimDraft(body.evidence)
        const artifactBytes =
          typeof body.artifactBase64 === 'string'
            ? Buffer.from(body.artifactBase64, 'base64')
            : undefined
        if (artifactBytes && artifactBytes.byteLength > maximumBodyBytes)
          throw new Error('Artifact bytes are too large')
        const evidence = options.store.createEvidenceRef(
          decodeURIComponent(runEvidenceMatch[1] ?? ''),
          userId,
          requiredString(body.commandId, 'commandId'),
          {
            ...claim,
            trustClass: 'user',
            verification: {
              method: 'unverified-client-claim',
              verifierIdentity: `client:${userId}`,
              verifierVersion: 'v1',
              result: 'pending',
            },
          },
          artifactBytes ? { artifactBytes } : {},
        )
        return sendJson(response, 201, { evidence })
      }

      const evidenceVerifyMatch = /^\/v1\/evidence\/([^/]+)\/verify$/.exec(
        taskResourceUrl.pathname,
      )
      if (evidenceVerifyMatch && request.method === 'POST') {
        const body = await readJson(request)
        if (!isRecord(body)) throw new Error('Request body must be an object')
        const userId = requiredString(body.userId, 'userId')
        const commandId = requiredString(body.commandId, 'commandId')
        const evidence = options.store.verifyEvidenceWithTrustedVerifier(
          decodeURIComponent(evidenceVerifyMatch[1] ?? ''),
          userId,
          commandId,
          verifyVisualEvidence,
        )
        return sendJson(response, 200, { evidence })
      }

      const evidenceContentMatch = /^\/v1\/evidence\/([^/]+)\/content$/.exec(
        taskResourceUrl.pathname,
      )
      if (evidenceContentMatch && request.method === 'GET') {
        const userId = requiredQuery(taskResourceUrl, 'userId')
        try {
          const content = options.store.evidenceArtifactContent(
            decodeURIComponent(evidenceContentMatch[1] ?? ''),
            userId,
          )
          response.writeHead(200, {
            'content-type': content.mimeType ?? 'application/octet-stream',
            'content-length': String(content.bytes.byteLength),
            'x-pegas-content-sha256': content.contentHash,
            'cache-control': 'private, no-store',
          })
          response.end(content.bytes)
          return
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unknown error'
          if (message === 'Evidence not found')
            return sendJson(response, 404, { error: 'not_found' })
          if (message === 'Evidence has no stored artifact content')
            return sendJson(response, 404, { error: 'content_unavailable' })
          throw error
        }
      }

      const runReportMatch = /^\/v1\/runs\/([^/]+)\/reports$/.exec(
        taskResourceUrl.pathname,
      )
      if (runReportMatch && request.method === 'GET') {
        const userId = requiredQuery(taskResourceUrl, 'userId')
        const page = pageRequest(taskResourceUrl)
        const reports = options.store.pageWorkerReports(
          decodeURIComponent(runReportMatch[1] ?? ''),
          userId,
          page.limit,
          page.cursor,
        )
        return sendJson(response, 200, {
          reports: reports.items,
          ...(reports.nextCursor ? { nextCursor: reports.nextCursor } : {}),
        })
      }
      if (runReportMatch && request.method === 'POST') {
        const claimToken = runClaimToken(request)
        if (!claimToken)
          return sendJson(response, 403, { error: 'run_claim_required' })
        const body = await readJson(request)
        if (!isRecord(body)) throw new Error('Request body must be an object')
        return sendJson(
          response,
          200,
          options.store.submitWorkerReport(
            decodeURIComponent(runReportMatch[1] ?? ''),
            undefined,
            { claimToken },
            parseWorkerReportDraft(body.report),
          ),
        )
      }

      if (request.url?.startsWith('/v1/runs') && request.method === 'GET') {
        const url = new URL(request.url, 'http://localhost')
        const activityMatch = /^\/v1\/runs\/([^/]+)\/activity$/.exec(
          url.pathname,
        )
        if (activityMatch) {
          const userId = url.searchParams.get('userId')
          if (!userId) throw new Error('userId is required')
          const limitParam = url.searchParams.get('limit')
          const report = options.store.listRunActivity(
            decodeURIComponent(activityMatch[1] ?? ''),
            userId,
            limitParam ? { limit: Number(limitParam) } : {},
          )
          if (!report) throw new Error('Run not found')
          return sendJson(response, 200, report)
        }
        const outputMatch =
          /^\/v1\/runs\/([^/]+)\/activity\/([^/]+)\/output$/.exec(url.pathname)
        if (outputMatch) {
          const userId = requiredQuery(url, 'userId')
          const offsetParam = url.searchParams.get('offset')
          const limitParam = url.searchParams.get('limit')
          const untilParam = url.searchParams.get('until')
          if (
            untilParam !== null &&
            (!/^\d+$/.test(untilParam) ||
              !Number.isSafeInteger(Number(untilParam)))
          )
            throw new Error('until must be a non-negative integer')
          const page = await options.store.readRunActivityOutput(
            decodeURIComponent(outputMatch[1] ?? ''),
            userId,
            decodeURIComponent(outputMatch[2] ?? ''),
            {
              ...(offsetParam ? { offset: Number(offsetParam) } : {}),
              ...(limitParam ? { limit: Number(limitParam) } : {}),
              ...(untilParam !== null ? { until: Number(untilParam) } : {}),
              spillReader: readRunSpillText,
            },
          )
          if (!page) return sendJson(response, 404, { error: 'not_found' })
          return sendJson(response, 200, page)
        }
        const outputFileMatch =
          /^\/v1\/runs\/([^/]+)\/activity\/([^/]+)\/output-file$/.exec(
            url.pathname,
          )
        if (outputFileMatch) {
          const userId = requiredQuery(url, 'userId')
          const paths = options.store.resolveRunOutputSpillPath(
            decodeURIComponent(outputFileMatch[1] ?? ''),
            userId,
            decodeURIComponent(outputFileMatch[2] ?? ''),
          )
          for (const path of paths) {
            const text = await readRunSpillText(path)
            if (text === undefined) continue
            response.writeHead(200, {
              'content-type': 'text/plain; charset=utf-8',
              'cache-control': 'private, max-age=300',
              'x-content-type-options': 'nosniff',
            })
            return response.end(spillBodyForGap(text)?.body ?? text)
          }
          return sendJson(response, 404, { error: 'not_found' })
        }
        const imageMatch =
          /^\/v1\/runs\/([^/]+)\/activity\/([^/]+)\/image$/.exec(url.pathname)
        if (imageMatch) {
          const userId = requiredQuery(url, 'userId')
          const path = options.store.resolveRunImagePath(
            decodeURIComponent(imageMatch[1] ?? ''),
            userId,
            decodeURIComponent(imageMatch[2] ?? ''),
          )
          if (!path) return sendJson(response, 404, { error: 'not_found' })
          const mediaType = imageMediaType(path)
          if (!mediaType)
            return sendJson(response, 415, { error: 'unsupported_media' })
          let bytes: Buffer
          try {
            const stats = await statFile(path)
            if (!stats.isFile() || stats.size > maximumRunImageBytes)
              return sendJson(response, 404, { error: 'not_found' })
            bytes = await readFile(path)
          } catch {
            return sendJson(response, 404, { error: 'not_found' })
          }
          response.writeHead(200, {
            'content-type': mediaType,
            'content-length': String(bytes.byteLength),
            'cache-control': 'private, max-age=300',
            'x-content-type-options': 'nosniff',
          })
          return response.end(bytes)
        }
        const subagentsMatch = /^\/v1\/runs\/([^/]+)\/subagents$/.exec(
          url.pathname,
        )
        if (subagentsMatch) {
          const userId = url.searchParams.get('userId')
          if (!userId) throw new Error('userId is required')
          const report = options.store.listRunSubagents(
            decodeURIComponent(subagentsMatch[1] ?? ''),
            userId,
          )
          if (!report) throw new Error('Run not found')
          return sendJson(response, 200, report)
        }
        const conversationStateMatch =
          /^\/v1\/runs\/([^/]+)\/conversation-state\/(tasks|memories)$/.exec(
            url.pathname,
          )
        if (conversationStateMatch) {
          const claimToken = runClaimToken(request)
          if (!claimToken)
            return sendJson(response, 403, { error: 'run_claim_required' })
          try {
            const projection = options.store.conversationStateForRun(
              decodeURIComponent(conversationStateMatch[1] ?? ''),
              claimToken,
              conversationStateMatch[2] === 'memories' ? 'memories' : 'tasks',
            )
            return sendJson(response, 200, projection)
          } catch (error) {
            if (error instanceof RunClaimError)
              return sendJson(response, 403, { error: 'run_claim_invalid' })
            throw error
          }
        }
        const userId = url.searchParams.get('userId')
        if (!userId) throw new Error('userId is required')
        const taskId = url.searchParams.get('taskId') ?? undefined
        return sendJson(response, 200, {
          runs: options.store.listRunsForUser(userId, taskId),
        })
      }

      if (request.url === '/v1/outbox' && request.method === 'POST') {
        const body = parseNewOutboxMessage(await readJson(request))
        const message = options.store.enqueueOutbox(body)
        return sendJson(response, 202, { message })
      }

      if (
        request.url?.startsWith('/v1/settings/notifications') &&
        (request.method === 'GET' || request.method === 'PUT')
      ) {
        const url = new URL(request.url, 'http://localhost')
        if (request.method === 'GET') {
          return sendJson(response, 200, {
            preferences: options.store.getNotificationPreferences(
              requiredQuery(url, 'userId'),
            ),
          })
        }
        const body = await readJson(request)
        if (!isRecord(body)) throw new Error('Request body must be an object')
        const preferences = options.store.updateNotificationPreferences(
          requiredString(body.userId, 'userId'),
          parseNotificationPreferencesUpdate(body),
        )
        return sendJson(response, 200, { preferences })
      }

      const resolveOutboxMatch = request.url?.match(
        /^\/v1\/outbox\/([^/]+)\/resolve$/,
      )
      if (resolveOutboxMatch && request.method === 'POST') {
        const body = await readJson(request)
        if (!isRecord(body)) throw new Error('Request body must be an object')
        const message = options.store.resolveOutboxMessage(
          decodeURIComponent(resolveOutboxMatch[1] ?? ''),
          requiredString(body.userId, 'userId'),
          parseOutboxResolutionDraft(body),
        )
        return sendJson(response, 201, { message })
      }

      const readOutboxMatch = request.url?.match(
        /^\/v1\/outbox\/([^/]+)\/read$/,
      )
      if (readOutboxMatch && request.method === 'POST') {
        const body = await readJson(request)
        if (
          !body ||
          typeof body !== 'object' ||
          !('userId' in body) ||
          typeof body.userId !== 'string' ||
          !body.userId.trim()
        )
          throw new Error('userId is required')
        return sendJson(response, 200, {
          message: options.store.markOutboxRead(
            decodeURIComponent(readOutboxMatch[1] ?? ''),
            body.userId,
          ),
        })
      }

      if (request.url?.startsWith('/v1/outbox') && request.method === 'GET') {
        const url = new URL(request.url, 'http://localhost')
        const userId = url.searchParams.get('userId')
        if (!userId) throw new Error('userId is required')
        return sendJson(response, 200, {
          messages: options.store.listOutbox(userId),
        })
      }

      return sendJson(response, 404, { error: 'not_found' })
    } catch (error) {
      if (error instanceof ActionNotFoundError)
        return sendJson(response, 404, { error: 'not_found' })
      if (error instanceof ActionReconciliationConflictError)
        return sendJson(response, 409, {
          error: 'action_reconciliation_conflict',
          message: error.message,
        })
      if (error instanceof OutboxNotFoundError)
        return sendJson(response, 404, { error: 'not_found' })
      if (error instanceof OutboxResolutionConflictError)
        return sendJson(response, 409, {
          error: 'outbox_resolution_conflict',
          message: error.message,
        })
      if (error instanceof NotificationPreferencesConflictError)
        return sendJson(response, 409, {
          error: 'notification_preferences_conflict',
          message: error.message,
        })
      if (error instanceof GoalProposalCommandConflictError)
        return sendJson(response, 409, {
          error: 'goal_proposal_command_conflict',
          message: error.message,
        })
      if (error instanceof CollaborationCommandConflictError)
        return sendJson(response, 409, {
          error: 'collaboration_command_conflict',
          message: error.message,
        })
      if (error instanceof CollaborationFanoutLimitError)
        return sendJson(response, 409, {
          error: 'collaboration_fanout_limit',
          message: error.message,
        })
      if (error instanceof CollaborationBudgetLimitError)
        return sendJson(response, 409, {
          error: 'collaboration_budget_limit',
          message: error.message,
        })
      if (error instanceof CollaborationActionPendingError)
        return sendJson(response, 409, {
          error: 'collaboration_action_outcome_required',
          message: error.message,
        })
      if (error instanceof CollaborationReconciliationRequiredError)
        return sendJson(response, 409, {
          error: 'collaboration_reconciliation_required',
          message: error.message,
        })
      if (error instanceof CollaborationTargetUnavailableError)
        return sendJson(response, 404, {
          error: 'collaboration_target_unavailable',
          message: error.message,
        })
      if (error instanceof MemoryCommandConflictError)
        return sendJson(response, 409, {
          error: 'memory_command_conflict',
        })
      if (error instanceof MemoryRevisionConflictError)
        return sendJson(response, 409, { error: 'memory_conflict' })
      if (error instanceof MemoryNotFoundError)
        return sendJson(response, 404, { error: 'not_found' })
      if (error instanceof MemorySourceUnavailableError)
        return sendJson(response, 409, {
          error: 'memory_source_unavailable',
        })
      if (error instanceof MemoryTargetUnavailableError)
        return sendJson(response, 409, {
          error: 'memory_target_unavailable',
        })
      if (error instanceof MemoryLimitError)
        return sendJson(response, 409, { error: 'memory_limit' })
      if (error instanceof WorkRuleCommandConflictError)
        return sendJson(response, 409, {
          error: 'rule_command_conflict',
        })
      if (error instanceof WorkRuleRevisionConflictError)
        return sendJson(response, 409, { error: 'rule_conflict' })
      if (error instanceof WorkRuleNotFoundError)
        return sendJson(response, 404, { error: 'not_found' })
      if (error instanceof WorkRuleLimitError)
        return sendJson(response, 409, { error: 'rule_limit' })
      if (error instanceof BehaviorPreferencesConflictError)
        return sendJson(response, 409, { error: 'behavior_conflict' })
      if (error instanceof RunClaimError)
        return sendJson(response, 403, {
          error: 'run_claim_invalid',
          message: error.message,
        })
      if (error instanceof EventAttachmentConflictError)
        return sendJson(response, 409, {
          error: 'attachment_conflict',
          message: error.message,
        })
      if (error instanceof EventAttachmentsUnsupportedError)
        return sendJson(response, 409, {
          error: 'attachments_unsupported',
          message: error.message,
        })
      const message = error instanceof Error ? error.message : 'Unknown error'
      logger?.error('http.request_failed', error, {
        method,
        route: metricRoute(path),
      })
      metrics?.increment('pegas_errors_total', {
        component: 'control-plane',
        kind: 'request_error',
      })
      return sendJson(response, 400, { error: 'bad_request', message })
    }
  })
  server.on('close', () => {
    linkPreviews.dispose()
  })
  return server
}

/** Normalizes dynamic path segments so metrics stay low-cardinality. */
function metricRoute(path: string): string {
  return path
    .split('/')
    .map(segment =>
      segment.length > 24 || /^\d+$/.test(segment) ? ':id' : segment,
    )
    .join('/')
}

function cachedAgentModelCatalog(
  load: ControlPlaneOptions['agentModelCatalog'],
  ttlMs = 5_000,
): (() => Promise<DshModelCatalog>) | undefined {
  if (!load) return undefined
  let cached: { value: DshModelCatalog; expiresAt: number } | undefined
  let inFlight: Promise<DshModelCatalog> | undefined
  return async () => {
    const now = Date.now()
    if (cached && cached.expiresAt > now) return cached.value
    if (inFlight) return inFlight
    inFlight = load()
      .then(value => {
        cached = { value, expiresAt: Date.now() + Math.max(0, ttlMs) }
        return value
      })
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }
}

function explicitTaskId(input: NewInboxEvent): string | undefined {
  if (
    input.type !== 'user.message' ||
    !input.payload ||
    typeof input.payload !== 'object' ||
    !('taskId' in input.payload)
  )
    return undefined
  const taskId = input.payload.taskId
  return typeof taskId === 'string' && taskId.trim() ? taskId : undefined
}

function sourceContextTaskId(input: NewInboxEvent): string | undefined {
  if (
    input.type !== 'user.message' ||
    !input.payload ||
    typeof input.payload !== 'object' ||
    Array.isArray(input.payload)
  )
    return undefined
  if ('sourceContext' in input.payload)
    throw new Error(
      'sourceContext facts are derived by the server and cannot be submitted',
    )
  if (!('sourceTaskId' in input.payload)) return undefined
  const sourceTaskId = input.payload.sourceTaskId
  if (typeof sourceTaskId !== 'string' || !sourceTaskId.trim())
    throw new Error('sourceTaskId must be a non-empty string')
  if (
    'taskId' in input.payload &&
    typeof input.payload.taskId === 'string' &&
    input.payload.taskId.trim()
  )
    throw new Error('taskId and sourceTaskId cannot be combined')
  return sourceTaskId
}

function explicitSteerIntent(input: NewInboxEvent): boolean {
  return (
    input.type === 'user.message' &&
    !!input.payload &&
    typeof input.payload === 'object' &&
    'intent' in input.payload &&
    input.payload.intent === 'steer'
  )
}

function modelProbeConnection(
  value: unknown,
  options: ControlPlaneOptions,
): {
  protocol: 'openai-chat' | 'anthropic-messages'
  baseUrl: string
  modelName: string
  apiKey?: string
} {
  const capabilities = resolveSettingsCapabilities(options)
  if (!capabilities || !options.modelCredentialVault) {
    throw new Error('模型设置服务不可用')
  }
  if (!isRecord(value)) throw new Error('Request body must be an object')
  const current = options.store.getRuntimeSettings()
  const update = parseRuntimeSettingsUpdate(
    {
      ...current,
      expectedRevision: current.revision,
      modelProvider: value.modelProvider,
      modelName: value.modelName,
      provider: value.provider,
    },
    capabilities,
  )
  const stored = options.store.getModelProviderConnection(update.provider.id)
  const storedApiKey =
    !update.provider.clearApiKey &&
    stored?.baseUrl === update.provider.baseUrl &&
    stored.apiKeyCiphertext
      ? options.modelCredentialVault.decrypt(stored.apiKeyCiphertext)
      : undefined
  const apiKey = update.provider.apiKey ?? storedApiKey
  return {
    protocol: update.provider.protocol,
    baseUrl: update.provider.baseUrl,
    modelName: update.settings.modelName,
    ...(apiKey ? { apiKey } : {}),
  }
}

async function testRewriteConnection(
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlPlaneOptions,
): Promise<void> {
  if (!options.modelCredentialVault)
    return sendJson(response, 503, { error: 'settings_unavailable' })
  const body = await readJson(request)
  if (
    !isRecord(body) ||
    typeof body.text !== 'string' ||
    !body.text.trim() ||
    body.text.length > 4000
  ) {
    throw new Error('填写不超过 4000 字的测试文本')
  }
  const original = body.text.trim()
  const rewrite = parseRewriteConnectionUpdate(body)
  if (!rewrite) throw new Error('改写连接缺失')
  const saved = options.store.getRewriteConnection()
  let provider: JsonModelProvider
  if (rewrite.mode === 'custom') {
    const savedKey =
      saved.mode === 'custom' &&
      saved.baseUrl === rewrite.baseUrl &&
      !rewrite.clearApiKey &&
      saved.apiKeyCiphertext
        ? options.modelCredentialVault.decrypt(saved.apiKeyCiphertext)
        : undefined
    const apiKey = rewrite.apiKey ?? savedKey
    const providerOptions = {
      baseUrl: rewrite.baseUrl,
      model: rewrite.model,
      ...(apiKey ? { apiKey } : {}),
      timeoutMs: options.modelTimeoutMs ?? 15_000,
    }
    provider =
      rewrite.protocol === 'anthropic-messages'
        ? new AnthropicProvider(providerOptions)
        : new OpenAiCompatibleProvider(providerOptions)
  } else {
    provider = modelProbeProvider(body, options)
  }
  const currentPrivacy = options.store.getRuntimeSettings().privacyMode
  if (currentPrivacy === 'mask' || body.privacyMode === 'mask') {
    if (!options.privacyHmacKey) throw new Error('隐私保护服务不可用')
    provider = new PrivacyMaskingProvider(
      provider,
      new DeterministicPrivacyMasker({ hmacKey: options.privacyHmacKey }),
    )
  }
  const started = performance.now()
  try {
    const rewritten = await new ModelInputRewriter(provider).testRewrite(
      original,
    )
    return sendJson(response, 200, {
      original,
      rewritten,
      changed: rewritten !== original,
      latencyMs: Math.round(performance.now() - started),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const status = /(?:returned|返回)\s+(401|403|404|429|5\d\d)\b/.exec(
      message,
    )?.[1]
    const guidance =
      status === '401' || status === '403'
        ? '密钥无效或没有模型权限'
        : status === '404'
          ? '找不到接口或模型，请检查服务地址和模型 ID'
          : status === '429'
            ? '请求过于频繁，请稍后重试或检查额度'
            : status?.startsWith('5')
              ? '服务暂时不可用，请稍后重试'
              : '改写测试失败，请检查地址、模型和网络'
    return sendJson(response, 400, {
      error: 'rewrite_test_failed',
      message: guidance,
    })
  }
}

function modelProbeProvider(
  value: unknown,
  options: ControlPlaneOptions,
): JsonModelProvider {
  const connection = modelProbeConnection(value, options)
  const providerOptions = {
    baseUrl: connection.baseUrl,
    model: connection.modelName,
    ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
    timeoutMs: options.modelTimeoutMs ?? 15_000,
  }
  return connection.protocol === 'anthropic-messages'
    ? new AnthropicProvider(providerOptions)
    : new OpenAiCompatibleProvider(providerOptions)
}

function resolveSettingsCapabilities(
  options: ControlPlaneOptions,
): SettingsCapabilities | undefined {
  return typeof options.settingsCapabilities === 'function'
    ? options.settingsCapabilities()
    : options.settingsCapabilities
}

async function acceptVoiceTranscription(
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlPlaneOptions,
): Promise<void> {
  const result = await transcribeVoiceRequest(request, response, options)
  if (!result) return
  return sendJson(response, 200, {
    transcript: result.transcript,
    provider: result.provider.name,
    model: result.provider.model,
  })
}

async function acceptVoiceMessage(
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlPlaneOptions,
): Promise<void> {
  const url = new URL(request.url ?? '', 'http://localhost')
  const userId = requiredQuery(url, 'userId')
  const source = optionalQuery(url, 'source') ?? 'web'
  const language = optionalQuery(url, 'language')
  const taskId = optionalQuery(url, 'taskId')
  const dedupeKey = headerValue(request, 'idempotency-key')?.trim()
  if (!dedupeKey) {
    return sendJson(response, 400, {
      error: 'bad_request',
      message: 'Idempotency-Key header is required',
    })
  }

  const voiceResult = await transcribeVoiceRequest(request, response, options)
  if (!voiceResult) return
  const { transcript, provider } = voiceResult

  const result = options.store.enqueueEvent({
    userId,
    type: 'user.message',
    source,
    authenticatedActor: 'human',
    dedupeKey,
    payload: {
      text: transcript.text,
      inputMode: 'voice',
      ...(taskId ? { taskId } : {}),
      voice: {
        provider: provider.name,
        model: provider.model,
        ...(language ? { requestedLanguage: language } : {}),
        ...(transcript.language
          ? { detectedLanguage: transcript.language }
          : {}),
      },
    },
  })

  return sendJson(response, result.inserted ? 202 : 200, {
    ...result,
    transcript,
  })
}

async function transcribeVoiceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlPlaneOptions,
): Promise<
  | { transcript: SpeechTranscript; provider: SpeechRecognitionProvider }
  | undefined
> {
  const provider = resolveSpeechProvider(options)
  if (!provider) {
    sendJson(response, 503, {
      error: 'speech_unavailable',
      message: '语音识别尚未配置，请前往设置添加转写服务。',
    })
    return undefined
  }

  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim()
  if (!contentType?.startsWith('audio/')) {
    sendJson(response, 415, {
      error: 'unsupported_media_type',
      message: 'Content-Type must be an audio media type',
    })
    return undefined
  }

  const audio = await readBytes(
    request,
    options.maximumAudioBytes ?? defaultMaximumAudioBytes,
  )
  if (audio.length === 0) {
    sendJson(response, 400, {
      error: 'bad_request',
      message: 'Audio body is required',
    })
    return undefined
  }

  const url = new URL(request.url ?? '', 'http://localhost')
  const language = optionalQuery(url, 'language')
  try {
    const transcript = await provider.transcribe({
      audio,
      contentType,
      filename: `utterance.${audioExtension(contentType)}`,
      ...(language ? { language } : {}),
    })
    return { transcript, provider }
  } catch (error) {
    options.logger?.error('speech.recognition_failed', undefined, {
      errorType: error instanceof Error ? error.name : 'unknown',
      providerStatus:
        error instanceof Error
          ? /Speech provider returned (\d{3})/.exec(error.message)?.[1]
          : undefined,
    })
    options.metrics?.increment('pegas_errors_total', {
      component: 'control-plane',
      kind: 'speech_provider',
    })
    sendJson(response, 502, {
      error: 'speech_provider_failed',
      message: '语音服务暂时不可用，请检查服务地址、模型和密钥后重试。',
    })
    return undefined
  }
}

function resolveSpeechProvider(
  options: ControlPlaneOptions,
): SpeechRecognitionProvider | undefined {
  if (options.speechProvider) return options.speechProvider
  const connection = options.store.getSpeechConnection()
  if (
    connection.provider !== 'openai-compatible' ||
    !connection.baseUrl ||
    !options.modelCredentialVault
  )
    return undefined
  return new OpenAiTranscriptionProvider({
    baseUrl: connection.baseUrl,
    model: connection.model,
    ...(connection.apiKeyCiphertext
      ? {
          apiKey: options.modelCredentialVault.decrypt(
            connection.apiKeyCiphertext,
          ),
        }
      : {}),
    timeoutMs: options.speechTimeoutMs ?? 120_000,
  })
}

async function testSpeechConnection(
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlPlaneOptions,
): Promise<void> {
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.startsWith('multipart/form-data;')) {
    return sendJson(response, 415, {
      error: 'unsupported_media_type',
      message: '请提供录音和语音服务设置。',
    })
  }
  const maximumAudioBytes =
    options.maximumAudioBytes ?? defaultMaximumAudioBytes
  const body = await readBytes(request, maximumAudioBytes + 32_768)
  const upload = await parseSpeechTestUpload(
    body,
    contentType,
    maximumAudioBytes,
  )
  const speech = parseSpeechConnectionUpdate({
    speech: JSON.parse(upload.speech) as unknown,
  })
  if (speech?.provider !== 'openai-compatible')
    throw new Error('请先选择转写服务。')
  if (!upload.audio.length) {
    throw new Error('测试录音无效或过大，请重新录制。')
  }
  const saved = options.store.getSpeechConnection()
  const savedKey =
    !speech.apiKey &&
    !speech.clearApiKey &&
    saved.provider === 'openai-compatible' &&
    saved.baseUrl === speech.baseUrl &&
    saved.apiKeyCiphertext &&
    options.modelCredentialVault
      ? options.modelCredentialVault.decrypt(saved.apiKeyCiphertext)
      : undefined
  const apiKey = speech.apiKey ?? savedKey
  const provider = new OpenAiTranscriptionProvider({
    baseUrl: speech.baseUrl,
    model: speech.model,
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: options.speechTimeoutMs ?? 120_000,
  })
  const started = performance.now()
  try {
    const transcript = await provider.transcribe({
      audio: upload.audio,
      contentType: upload.audioType,
      filename: `test.${audioExtension(upload.audioType)}`,
    })
    return sendJson(response, 200, {
      transcript,
      latencyMs: Math.round(performance.now() - started),
    })
  } catch (error) {
    const status =
      error instanceof Error
        ? Number(/Speech provider returned (\d{3})/.exec(error.message)?.[1])
        : 0
    const message =
      status === 401 || status === 403
        ? '语音服务未授权，请检查 API 密钥。'
        : status === 404
          ? '找不到转写接口或模型，请检查服务地址和模型名。'
          : status === 429
            ? '语音服务请求过于频繁，请稍后重试。'
            : '无法完成语音测试，请检查服务是否运行、地址和网络。'
    return sendJson(response, 502, { error: 'speech_probe_failed', message })
  }
}

function parseNewOutboxMessage(value: unknown): {
  userId: string
  taskId?: string
  channel: string
  dedupeKey: string
  payload: unknown
  coalesceKey?: string
} {
  if (!isRecord(value)) throw new Error('Request body must be an object')
  if (!Object.hasOwn(value, 'payload')) throw new Error('payload is required')
  const taskId = optionalString(value.taskId, 'taskId')
  const coalesceKey = optionalString(value.coalesceKey, 'coalesceKey')
  return {
    userId: requiredString(value.userId, 'userId'),
    ...(taskId ? { taskId } : {}),
    channel: optionalString(value.channel, 'channel') ?? 'conversation',
    dedupeKey: requiredString(value.dedupeKey, 'dedupeKey'),
    payload: value.payload,
    ...(coalesceKey ? { coalesceKey } : {}),
  }
}

function parseNotificationPreferencesUpdate(value: Record<string, unknown>): {
  expectedRevision: number
  quietStart?: string
  quietEnd?: string
  utcOffsetMinutes: number
} {
  const expectedRevision = value.expectedRevision
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0
  )
    throw new Error('expectedRevision must be a non-negative integer')
  const utcOffsetMinutes = value.utcOffsetMinutes
  if (typeof utcOffsetMinutes !== 'number')
    throw new Error('utcOffsetMinutes must be a number')
  const quietStart = optionalString(value.quietStart, 'quietStart')
  const quietEnd = optionalString(value.quietEnd, 'quietEnd')
  return {
    expectedRevision,
    ...(quietStart ? { quietStart } : {}),
    ...(quietEnd ? { quietEnd } : {}),
    utcOffsetMinutes,
  }
}

function parseOutboxResolutionDraft(
  value: Record<string, unknown>,
): OutboxResolutionDraft {
  const resolution = requiredString(value.resolution, 'resolution')
  if (resolution !== 'sent' && resolution !== 'failed')
    throw new Error('resolution must be sent or failed')
  const note = requiredString(value.note, 'note').trim()
  if (note.length > 2000)
    throw new Error('note must be at most 2000 characters')
  return {
    commandId: requiredString(value.commandId, 'commandId'),
    resolution,
    note,
  }
}

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

async function tryServeWeb(
  request: IncomingMessage,
  response: ServerResponse,
  webRoot?: string,
): Promise<boolean> {
  if (!webRoot || request.method !== 'GET' || !request.url) return false
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname.startsWith('/v1/')) return false

  const root = resolve(webRoot)
  const requested = resolve(root, `.${decodeURIComponent(url.pathname)}`)
  if (requested !== root && !requested.startsWith(`${root}${sep}`)) return false

  let file = requested
  if (url.pathname === '/' || !existsSync(file))
    file = resolve(root, 'index.html')
  if (!existsSync(file)) return false

  const body = await readFile(file)
  response.writeHead(200, {
    'cache-control':
      extname(file) === '.html'
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
    'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
  })
  response.end(body)
  return true
}

function isAuthorized(
  request: IncomingMessage,
  expectedToken?: string,
): boolean {
  if (!expectedToken) return true
  const actual = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!actual) return false
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expectedToken)
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  )
}

function isRunCapabilityWrite(request: IncomingMessage): boolean {
  if (request.method !== 'POST' || !request.url) return false
  const pathname = new URL(request.url, 'http://localhost').pathname
  return (
    /^\/v1\/runs\/[^/]+\/(reports|approvals|collaborations)$/.test(pathname) ||
    /^\/v1\/runs\/[^/]+\/goal-proposals$/.test(pathname) ||
    /^\/v1\/runs\/[^/]+\/follow-ups$/.test(pathname) ||
    /^\/v1\/runs\/[^/]+\/messages$/.test(pathname) ||
    /^\/v1\/runs\/[^/]+\/automations$/.test(pathname) ||
    /^\/v1\/runs\/[^/]+\/automations\/[^/]+\/(pause|resume|cancel)$/.test(
      pathname,
    ) ||
    /^\/v1\/actions\/[^/]+\/outcomes$/.test(pathname)
  )
}

function isConversationStateRead(request: IncomingMessage): boolean {
  if (request.method !== 'GET' || !request.url) return false
  const pathname = new URL(request.url, 'http://localhost').pathname
  return /^\/v1\/runs\/[^/]+\/conversation-state\/(tasks|memories)$/.test(
    pathname,
  )
}

function runClaimToken(request: IncomingMessage): string | undefined {
  const value = request.headers['x-pegas-run-claim-token']
  const actual = Array.isArray(value) ? value[0] : value
  const trimmed = actual?.trim()
  if (!trimmed) return undefined
  return trimmed
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const raw = (await readBytes(request, maximumBodyBytes)).toString('utf8')
  if (!raw) throw new Error('Request body is required')
  return JSON.parse(raw) as unknown
}

async function readBytes(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Buffer> {
  const declaredLength = Number(request.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error('Request body is too large')
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > maximumBytes) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function requiredQuery(url: URL, name: string): string {
  const value = optionalQuery(url, name)
  if (!value) throw new Error(`${name} is required`)
  return value
}

function optionalQuery(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim()
  return value === '' ? undefined : value
}

function pageRequest(url: URL): { limit: number; cursor?: string } {
  const rawLimit = optionalQuery(url, 'limit')
  const limit = rawLimit ? Number(rawLimit) : defaultPageLimit
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximumPageLimit)
    throw new Error(
      `limit must be an integer between 1 and ${String(maximumPageLimit)}`,
    )
  const cursor = optionalQuery(url, 'cursor')
  return { limit, ...(cursor ? { cursor } : {}) }
}

function parseChannelStatuses(value: string | null): TaskStatus[] | undefined {
  if (!value?.trim()) return undefined
  const allowed = new Set<TaskStatus>([
    'backlog',
    'unstarted',
    'started',
    'completed',
    'cancelled',
  ])
  const statuses = value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  if (statuses.length === 0) return undefined
  const invalid = statuses.find(status => !allowed.has(status as TaskStatus))
  if (invalid) throw new Error(`Unknown Channel status: ${invalid}`)
  return [...new Set(statuses)] as TaskStatus[]
}

function parseChannelSearchSort(
  value: string | null,
): ChannelSearchSort | undefined {
  if (!value) return undefined
  if (value === 'updated' || value === 'created' || value === 'ended')
    return value
  throw new Error('sort must be updated, created or ended')
}

function optionalBooleanQuery(url: URL, name: string): boolean | undefined {
  const value = optionalQuery(url, name)
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function parseWorkerIconQuery(value: string | null): WorkerIconId | undefined {
  if (!value?.trim()) return undefined
  if (isWorkerIconId(value)) return value
  throw new Error('workerIconId must be car, camera, computer or phone')
}

function audioExtension(contentType: string): string {
  const extensions: Record<string, string> = {
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'audio/x-m4a': 'm4a',
    'audio/x-wav': 'wav',
  }
  return extensions[contentType] ?? 'audio'
}

function headerValue(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function parseNewInboxEvent(value: unknown): NewInboxEvent {
  if (!isRecord(value)) throw new Error('Request body must be an object')
  const userId = requiredString(value.userId, 'userId')
  const type = requiredString(value.type, 'type')
  const source = requiredString(value.source, 'source')
  if (
    type === 'approval.decided' ||
    source === 'approval' ||
    type.startsWith('collaboration.') ||
    source === 'collaboration' ||
    type.startsWith('automation.') ||
    source === 'automation'
  ) {
    throw new Error(
      'Control Plane event types and sources are reserved and cannot be submitted directly',
    )
  }
  const dedupeKey = optionalString(value.dedupeKey, 'dedupeKey')
  const deviceId = optionalString(value.deviceId, 'deviceId')
  if (deviceId && Array.from(deviceId).length > 128)
    throw new Error('deviceId must contain at most 128 characters')
  if (!Object.hasOwn(value, 'payload')) throw new Error('payload is required')
  const authenticatedActor =
    type === 'user.message' && (source === 'web' || source === 'mobile')
      ? 'human'
      : undefined
  if (type === 'user.message' && !authenticatedActor) {
    throw new Error('user.message requires an authenticated human ingress')
  }
  return {
    userId,
    type,
    source,
    ...(authenticatedActor ? { authenticatedActor } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
    payload: value.payload,
  }
}

function sendAutomationError(response: ServerResponse, error: unknown): void {
  if (error instanceof AutomationCommandConflictError) {
    return sendJson(response, 409, { error: 'automation_command_conflict' })
  }
  if (error instanceof AutomationRevisionConflictError) {
    return sendJson(response, 409, { error: 'automation_conflict' })
  }
  if (error instanceof AutomationReadOnlyError) {
    return sendJson(response, 409, { error: 'automation_read_only' })
  }
  if (error instanceof AutomationTargetUnavailableError) {
    return sendJson(response, 409, { error: 'automation_target_unavailable' })
  }
  if (error instanceof AutomationNotFoundError) {
    return sendJson(response, 404, { error: 'not_found' })
  }
  throw error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${field} is required`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, field)
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative integer`)
  return value
}

function parseApprovalStatus(value: string): ApprovalStatus {
  const status = approvalStatuses.find(status => status === value)
  if (!status) {
    throw new Error('Approval status is invalid')
  }
  return status
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(body))
}
