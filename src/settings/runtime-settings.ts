import type { PegasConfig } from '../core/config.js'

type RouterMode = 'model' | 'rules'
type ModelProviderId = 'codex-cli' | 'openai-compatible'
type PrivacyMode = 'disabled' | 'mask'
type RewriteMode = 'disabled' | 'light'

export interface RuntimeSettingsSelection {
  routerMode: RouterMode
  modelProvider: ModelProviderId
  modelName: string
  privacyMode: PrivacyMode
  rewriteMode: RewriteMode
}

export interface RuntimeSettings extends RuntimeSettingsSelection {
  revision: number
  updatedAt: string
}

export interface SettingsCapabilities {
  providers: {
    id: ModelProviderId
    available: boolean
    reason?: string
  }[]
  privacyAvailable: boolean
}

export function runtimeSettingsDefaults(
  config: PegasConfig,
): RuntimeSettingsSelection {
  return {
    routerMode: config.routerMode,
    modelProvider: config.modelProvider,
    modelName: config.modelName ?? 'gpt-5.6-luna',
    privacyMode: config.privacyMode,
    rewriteMode: config.rewriteMode,
  }
}

export function settingsCapabilities(
  config: PegasConfig,
): SettingsCapabilities {
  return {
    providers: [
      { id: 'codex-cli', available: true },
      {
        id: 'openai-compatible',
        available: Boolean(config.modelBaseUrl),
        ...(!config.modelBaseUrl
          ? { reason: '服务端尚未配置 OpenAI-compatible Base URL' }
          : {}),
      },
    ],
    privacyAvailable: Boolean(
      config.privacyHmacKey && config.privacyHmacKey.length >= 16,
    ),
  }
}

export function parseRuntimeSettingsUpdate(
  value: unknown,
  capabilities: SettingsCapabilities,
): { expectedRevision: number; settings: RuntimeSettingsSelection } {
  if (!isRecord(value)) throw new Error('Request body must be an object')
  const expectedRevision = positiveInteger(
    value.expectedRevision,
    'expectedRevision',
  )
  const routerMode = enumValue(value.routerMode, 'routerMode', [
    'model',
    'rules',
  ])
  const modelProvider = enumValue(value.modelProvider, 'modelProvider', [
    'codex-cli',
    'openai-compatible',
  ])
  const privacyMode = enumValue(value.privacyMode, 'privacyMode', [
    'disabled',
    'mask',
  ])
  const rewriteMode = enumValue(value.rewriteMode, 'rewriteMode', [
    'disabled',
    'light',
  ])
  const modelName = requiredString(value.modelName, 'modelName', 120)
  const settings = {
    routerMode,
    modelProvider,
    modelName,
    privacyMode,
    rewriteMode,
  }
  assertRuntimeSettingsAvailable(settings, capabilities)
  return {
    expectedRevision,
    settings,
  }
}

export function assertRuntimeSettingsAvailable(
  settings: RuntimeSettingsSelection,
  capabilities: SettingsCapabilities,
): void {
  const provider = capabilities.providers.find(
    candidate => candidate.id === settings.modelProvider,
  )
  if (!provider?.available) {
    throw new Error(
      provider?.reason ?? `Provider ${settings.modelProvider} unavailable`,
    )
  }
  if (settings.privacyMode === 'mask' && !capabilities.privacyAvailable) {
    throw new Error('服务端尚未配置隐私 HMAC key，不能开启脱敏')
  }
}

function enumValue<const T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`)
  }
  const normalized = value.trim()
  if (normalized.length > maximum) {
    throw new Error(
      `${name} must contain at most ${String(maximum)} characters`,
    )
  }
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
