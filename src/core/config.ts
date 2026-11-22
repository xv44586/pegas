import { hostname } from 'node:os'
import { resolve } from 'node:path'

import {
  modelProviderPreset,
  type ModelProviderId,
} from '../model/provider-catalog.js'
import { initialSpeechConnection } from '../speech/speech-settings.js'
import { defaultMagpieRouterModel } from './model-defaults.js'

export interface PegasConfig {
  apiHost: string
  apiPort: number
  apiToken?: string
  dataDir: string
  databasePath: string
  eventPollMs: number
  schedulerPollMs: number
  executorMode: 'dsh' | 'echo'
  dshCommand: string
  dshProfile: string
  dshHome: string
  dshAdditionalDirectories: string[]
  dshTimeoutMs: number
  workspaceRoot: string
  workerConcurrency: number
  nodeId: string
  nodeLabel: string
  routerMode: 'rules' | 'model'
  modelProvider: ModelProviderId
  modelBaseUrl?: string
  modelApiKey?: string
  modelName: string
  modelCredentialKeyPath: string
  modelTimeoutMs: number
  privacyMode: 'disabled' | 'mask'
  privacyHmacKey?: string
  rewriteMode: 'disabled' | 'light'
  speechProvider: 'disabled' | 'openai-compatible'
  speechBaseUrl?: string
  speechApiKey?: string
  speechModel: string
  speechTimeoutMs: number
  speechMaxAudioBytes: number
  pushMode: 'disabled' | 'webhook'
  pushWebhookUrl?: string
  pushWebhookToken?: string
  outboxPollMs: number
  outboxMaxAttempts: number
  selfChangeEnabled: boolean
  selfChangeRepositoryRoot: string
  selfChangeRoot: string
  recoveryBaseUrl: string
  recoveryToken?: string
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PegasConfig {
  const dataDir = resolve(environment.PEGAS_DATA_DIR ?? './data')
  const apiHost = environment.PEGAS_API_HOST ?? '127.0.0.1'
  const apiToken = environment.PEGAS_API_TOKEN
  const routerMode = environment.PEGAS_ROUTER === 'rules' ? 'rules' : 'model'
  const rawModelProvider = environment.PEGAS_MODEL_PROVIDER ?? 'magpie'
  const modelProvider = legacyModelProvider(rawModelProvider)
  const modelBaseUrl = environment.PEGAS_MODEL_BASE_URL
  const modelName = environment.PEGAS_MODEL_NAME
  const privacyMode = environment.PEGAS_PRIVACY_MODE ?? 'disabled'
  const privacyHmacKey = environment.PEGAS_PRIVACY_HMAC_KEY
  const rewriteMode = environment.PEGAS_REWRITE_MODE ?? 'disabled'
  const speechProvider =
    environment.PEGAS_SPEECH_PROVIDER ?? initialSpeechConnection.provider
  const speechBaseUrl =
    environment.PEGAS_SPEECH_BASE_URL ?? initialSpeechConnection.baseUrl
  const pushMode =
    environment.PEGAS_PUSH_MODE === 'webhook' ? 'webhook' : 'disabled'
  const pushWebhookUrl = environment.PEGAS_PUSH_WEBHOOK_URL

  if (!isLoopback(apiHost) && !apiToken) {
    throw new Error(
      'PEGAS_API_TOKEN is required when the API listens outside the loopback interface',
    )
  }
  if (rewriteMode !== 'disabled' && rewriteMode !== 'light') {
    throw new Error(
      `Unsupported PEGAS_REWRITE_MODE: ${rewriteMode}. Expected disabled or light`,
    )
  }
  if (!modelProviderPreset(modelProvider)) {
    throw new Error(`Unsupported PEGAS_MODEL_PROVIDER: ${rawModelProvider}`)
  }
  if (privacyMode !== 'disabled' && privacyMode !== 'mask') {
    throw new Error(
      `Unsupported PEGAS_PRIVACY_MODE: ${privacyMode}. Expected disabled or mask`,
    )
  }
  if (speechProvider === 'openai-compatible' && !speechBaseUrl) {
    throw new Error(
      'PEGAS_SPEECH_BASE_URL is required when PEGAS_SPEECH_PROVIDER=openai-compatible',
    )
  }
  if (speechProvider !== 'disabled' && speechProvider !== 'openai-compatible') {
    throw new Error(
      `Unsupported PEGAS_SPEECH_PROVIDER: ${speechProvider}. Expected disabled or openai-compatible`,
    )
  }
  if (pushMode === 'webhook' && !pushWebhookUrl) {
    throw new Error(
      'PEGAS_PUSH_WEBHOOK_URL is required when PEGAS_PUSH_MODE=webhook',
    )
  }

  return {
    apiHost,
    apiPort: parsePositiveInteger(
      environment.PEGAS_API_PORT,
      4317,
      'PEGAS_API_PORT',
    ),
    ...(apiToken ? { apiToken } : {}),
    dataDir,
    databasePath: resolve(dataDir, 'pegas.sqlite'),
    eventPollMs: parsePositiveInteger(
      environment.PEGAS_EVENT_POLL_MS,
      250,
      'PEGAS_EVENT_POLL_MS',
    ),
    schedulerPollMs: parsePositiveInteger(
      environment.PEGAS_SCHEDULER_POLL_MS,
      500,
      'PEGAS_SCHEDULER_POLL_MS',
    ),
    executorMode: environment.PEGAS_EXECUTOR === 'echo' ? 'echo' : 'dsh',
    dshCommand: environment.PEGAS_DSH_COMMAND ?? 'dsh',
    dshProfile: environment.PEGAS_DSH_PROFILE ?? 'headless',
    dshHome: resolve(environment.PEGAS_DSH_HOME ?? resolve(dataDir, 'dsh')),
    dshAdditionalDirectories: commaSeparatedPaths(
      environment.PEGAS_DSH_ADD_DIRS,
    ),
    dshTimeoutMs: parsePositiveInteger(
      environment.PEGAS_DSH_TIMEOUT_MS,
      60 * 60 * 1000,
      'PEGAS_DSH_TIMEOUT_MS',
    ),
    workspaceRoot: resolve(environment.PEGAS_WORKSPACE_ROOT ?? '.'),
    workerConcurrency: parsePositiveInteger(
      environment.PEGAS_WORKER_CONCURRENCY,
      2,
      'PEGAS_WORKER_CONCURRENCY',
    ),
    nodeId: nonemptyOr(environment.PEGAS_NODE_ID, hostname()),
    nodeLabel: nonemptyOr(environment.PEGAS_NODE_LABEL, hostname()),
    routerMode,
    modelProvider: modelProvider as ModelProviderId,
    ...(modelBaseUrl ? { modelBaseUrl } : {}),
    ...(environment.PEGAS_MODEL_API_KEY
      ? { modelApiKey: environment.PEGAS_MODEL_API_KEY }
      : {}),
    modelName:
      modelName ??
      (modelProvider === 'magpie'
        ? defaultMagpieRouterModel
        : (modelProviderPreset(modelProvider)?.defaultModel ?? '')),
    modelCredentialKeyPath: resolve(dataDir, 'model-credentials.key'),
    modelTimeoutMs: parsePositiveInteger(
      environment.PEGAS_MODEL_TIMEOUT_MS,
      90_000,
      'PEGAS_MODEL_TIMEOUT_MS',
    ),
    privacyMode,
    ...(privacyHmacKey ? { privacyHmacKey } : {}),
    rewriteMode,
    speechProvider,
    ...(speechBaseUrl ? { speechBaseUrl } : {}),
    ...(environment.PEGAS_SPEECH_API_KEY
      ? { speechApiKey: environment.PEGAS_SPEECH_API_KEY }
      : {}),
    speechModel:
      environment.PEGAS_SPEECH_MODEL ?? initialSpeechConnection.model,
    speechTimeoutMs: parsePositiveInteger(
      environment.PEGAS_SPEECH_TIMEOUT_MS,
      120_000,
      'PEGAS_SPEECH_TIMEOUT_MS',
    ),
    speechMaxAudioBytes: parsePositiveInteger(
      environment.PEGAS_SPEECH_MAX_AUDIO_BYTES,
      25 * 1024 * 1024,
      'PEGAS_SPEECH_MAX_AUDIO_BYTES',
    ),
    pushMode,
    ...(pushWebhookUrl ? { pushWebhookUrl } : {}),
    ...(environment.PEGAS_PUSH_WEBHOOK_TOKEN
      ? { pushWebhookToken: environment.PEGAS_PUSH_WEBHOOK_TOKEN }
      : {}),
    outboxPollMs: parsePositiveInteger(
      environment.PEGAS_OUTBOX_POLL_MS,
      500,
      'PEGAS_OUTBOX_POLL_MS',
    ),
    outboxMaxAttempts: parsePositiveInteger(
      environment.PEGAS_OUTBOX_MAX_ATTEMPTS,
      8,
      'PEGAS_OUTBOX_MAX_ATTEMPTS',
    ),
    selfChangeEnabled: environment.PEGAS_SELF_CHANGE === 'enabled',
    selfChangeRepositoryRoot: resolve(
      environment.PEGAS_SELF_CHANGE_REPO ?? '.',
    ),
    selfChangeRoot: resolve(
      environment.PEGAS_SELF_CHANGE_ROOT ?? resolve(dataDir, 'self-change'),
    ),
    recoveryBaseUrl:
      environment.PEGAS_RECOVERY_BASE_URL ?? 'http://127.0.0.1:4318',
    ...(environment.PEGAS_RECOVERY_TOKEN
      ? { recoveryToken: environment.PEGAS_RECOVERY_TOKEN }
      : {}),
  }
}

function legacyModelProvider(value: string): string {
  if (value === 'openai-compatible') return 'custom'
  if (value === 'codex-cli') return 'openai'
  return value
}

function commaSeparatedPaths(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map(path => path.trim())
    .filter(Boolean)
    .map(path => resolve(path))
}

function nonemptyOr(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === '') return fallback
  return trimmed
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`)
  return parsed
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}
