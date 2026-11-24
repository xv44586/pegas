import type { PegasConfig } from '../core/config.js'
import { defaultMagpieRouterModel } from '../core/model-defaults.js'
import {
  modelProviderPreset,
  modelProviderPresets,
  type ModelProviderCategory,
  type ModelProviderId,
  type ModelProviderProtocol,
} from '../model/provider-catalog.js'
import type { RuntimeSettingsSelection } from './runtime-settings-selection.js'
import { parseExecutionPools } from '../worker/execution-pools.js'

export type { RuntimeSettingsSelection } from './runtime-settings-selection.js'

export interface RuntimeSettings extends RuntimeSettingsSelection {
  revision: number
  updatedAt: string
}

export interface ModelProviderConnectionSummary {
  id: ModelProviderId
  name: string
  protocol: ModelProviderProtocol
  baseUrl: string
  hasApiKey: boolean
}

export interface ModelProviderConnection extends Omit<
  ModelProviderConnectionSummary,
  'hasApiKey'
> {
  apiKeyCiphertext?: string
  updatedAt: string
}

interface ModelProviderCapability {
  id: ModelProviderId
  name: string
  category: ModelProviderCategory
  protocol: ModelProviderProtocol
  baseUrl: string
  defaultModel: string
  description: string
  requiresApiKey: boolean
  hasApiKey: boolean
  available: boolean
  reason?: string
}

export interface SettingsCapabilities {
  providers: ModelProviderCapability[]
  privacyAvailable: boolean
}

export interface ModelProviderConnectionUpdate {
  id: ModelProviderId
  name: string
  protocol: ModelProviderProtocol
  baseUrl: string
  apiKey?: string
  clearApiKey: boolean
}

export function runtimeSettingsDefaults(
  config: PegasConfig,
): RuntimeSettingsSelection {
  return {
    routerMode: config.routerMode,
    modelProvider: config.modelProvider,
    modelName: config.modelName,
    agentModelMode: 'profile',
    agentModelProvider: '',
    agentModelName: '',
    privacyMode: config.privacyMode,
    rewriteMode: config.rewriteMode,
    chatLaneEnabled: config.chatLaneEnabled,
  }
}

export function settingsCapabilities(
  config: PegasConfig,
  connections: readonly ModelProviderConnectionSummary[] = [],
): SettingsCapabilities {
  const byId = new Map(
    connections.map(connection => [connection.id, connection]),
  )
  return {
    providers: modelProviderPresets.map(preset => {
      const connection = byId.get(preset.id)
      const baseUrl = connection?.baseUrl ?? preset.baseUrl
      const hasApiKey = connection?.hasApiKey ?? false
      const available =
        Boolean(baseUrl) && (!preset.requiresApiKey || hasApiKey)
      return {
        id: preset.id,
        name: connection?.name ?? preset.name,
        category: preset.category,
        protocol: connection?.protocol ?? preset.protocol,
        baseUrl,
        defaultModel:
          preset.id === 'magpie'
            ? defaultMagpieRouterModel
            : preset.defaultModel,
        description:
          preset.id === 'magpie'
            ? '本机 Magpie 模型网关，默认使用指定的 Router 模型。'
            : preset.description,
        requiresApiKey: preset.requiresApiKey,
        hasApiKey,
        available,
        ...(!available
          ? { reason: baseUrl ? '尚未配置 API key' : '尚未配置 Base URL' }
          : {}),
      }
    }),
    privacyAvailable: Boolean(
      config.privacyHmacKey && config.privacyHmacKey.length >= 16,
    ),
  }
}

export function parseRuntimeSettingsUpdate(
  value: unknown,
  capabilities: SettingsCapabilities,
  rewriteConnectionAvailable = false,
): {
  expectedRevision: number
  settings: RuntimeSettingsSelection
  provider: ModelProviderConnectionUpdate
} {
  if (!isRecord(value)) throw new Error('Request body must be an object')
  const expectedRevision = positiveInteger(
    value.expectedRevision,
    'expectedRevision',
  )
  const routerMode = enumValue(value.routerMode, 'routerMode', [
    'model',
    'rules',
  ])
  const modelProvider = enumValue(
    value.modelProvider,
    'modelProvider',
    capabilities.providers.map(provider => provider.id),
  )
  const privacyMode = enumValue(value.privacyMode, 'privacyMode', [
    'disabled',
    'mask',
  ])
  const rewriteMode = enumValue(value.rewriteMode, 'rewriteMode', [
    'disabled',
    'light',
  ])
  const modelName = requiredString(value.modelName, 'modelName', 160)
  const agentModelMode = enumValue(value.agentModelMode, 'agentModelMode', [
    'profile',
    'override',
  ])
  const agentModelProvider =
    optionalString(value.agentModelProvider, 'agentModelProvider', 160) ?? ''
  const agentModelName =
    optionalString(value.agentModelName, 'agentModelName', 240) ?? ''
  if (
    agentModelMode === 'override' &&
    (!agentModelProvider || !agentModelName)
  ) {
    throw new Error('Agent 模型覆盖需要 provider 和 model')
  }
  const selected = capabilities.providers.find(
    provider => provider.id === modelProvider,
  )
  if (!selected) throw new Error(`Unknown provider: ${modelProvider}`)
  const providerValue = isRecord(value.provider) ? value.provider : {}
  const preset = modelProviderPreset(modelProvider)
  if (!preset) throw new Error(`Unknown provider: ${modelProvider}`)
  const custom = modelProvider === 'custom'
  const apiKey = optionalString(providerValue.apiKey, 'provider.apiKey', 16_384)
  const provider: ModelProviderConnectionUpdate = {
    id: modelProvider,
    name: custom
      ? requiredString(providerValue.name, 'provider.name', 60)
      : preset.name,
    protocol: custom
      ? enumValue(providerValue.protocol, 'provider.protocol', [
          'openai-chat',
          'anthropic-messages',
        ])
      : preset.protocol,
    baseUrl: custom
      ? normalizedUrl(providerValue.baseUrl, 'provider.baseUrl')
      : selected.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    clearApiKey: providerValue.clearApiKey === true,
  }
  const settings: RuntimeSettingsSelection = {
    routerMode,
    modelProvider,
    modelName,
    agentModelMode,
    agentModelProvider,
    agentModelName,
    privacyMode,
    rewriteMode,
    ...(typeof value.chatLaneEnabled === 'boolean'
      ? { chatLaneEnabled: value.chatLaneEnabled }
      : {}),
    ...(value.executionPools === undefined
      ? {}
      : { executionPools: parseExecutionPools(value.executionPools) }),
    ...(value.permissionTier === undefined
      ? {}
      : {
          permissionTier: enumValue(value.permissionTier, 'permissionTier', [
            'strict',
            'standard',
            'full',
          ]),
        }),
    ...(value.autoReviewEnabled === undefined
      ? {}
      : {
          autoReviewEnabled: booleanValue(
            value.autoReviewEnabled,
            'autoReviewEnabled',
          ),
        }),
  }
  const hasApiKey = provider.apiKey
    ? true
    : provider.clearApiKey
      ? false
      : selected.hasApiKey
  const available =
    Boolean(provider.baseUrl) && (!selected.requiresApiKey || hasApiKey)
  assertRuntimeSettingsAvailable(
    settings,
    capabilities,
    available,
    rewriteConnectionAvailable,
  )
  return { expectedRevision, settings, provider }
}

export function assertRuntimeSettingsAvailable(
  settings: RuntimeSettingsSelection,
  capabilities: SettingsCapabilities,
  selectedProviderAvailable?: boolean,
  rewriteConnectionAvailable = false,
): void {
  const provider = capabilities.providers.find(
    candidate => candidate.id === settings.modelProvider,
  )
  const requiresModel =
    settings.routerMode === 'model' ||
    (settings.rewriteMode === 'light' && !rewriteConnectionAvailable)
  if (
    requiresModel &&
    !(selectedProviderAvailable ?? provider?.available ?? false)
  ) {
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

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be a boolean`)
  }
  return value
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function requiredString(value: unknown, name: string, maximum: number): string {
  const normalized = optionalString(value, name, maximum)
  if (!normalized) throw new Error(`${name} must be a non-empty string`)
  return normalized
}

function optionalString(
  value: unknown,
  name: string,
  maximum: number,
): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length > maximum) {
    throw new Error(
      `${name} must contain at most ${String(maximum)} characters`,
    )
  }
  return normalized
}

function normalizedUrl(value: unknown, name: string): string {
  const url = new URL(requiredString(value, name, 2048))
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must use http or https`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not include credentials, query, or fragment`)
  }
  return url.toString().replace(/\/$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
