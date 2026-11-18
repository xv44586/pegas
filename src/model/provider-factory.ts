import type { PegasConfig } from '../core/config.js'
import type { RuntimeSettings } from '../settings/runtime-settings.js'
import type { PegasStore } from '../storage/sqlite-store.js'
import { AnthropicProvider } from './anthropic-provider.js'
import type { ModelCredentialVault } from './model-credential-vault.js'
import { OpenAiCompatibleProvider } from './openai-compatible-provider.js'
import type { JsonModelProvider } from './provider.js'
import { modelProviderPreset } from './provider-catalog.js'
import type { RewriteConnection } from '../rewrite/rewrite-settings.js'

export function createRewriteModelProvider(
  connection: RewriteConnection,
  vault: ModelCredentialVault,
  timeoutMs: number,
): JsonModelProvider {
  if (
    connection.mode !== 'custom' ||
    !connection.baseUrl ||
    !connection.model
  ) {
    throw new Error('改写服务尚未配置')
  }
  const apiKey = connection.apiKeyCiphertext
    ? vault.decrypt(connection.apiKeyCiphertext)
    : undefined
  const options = {
    baseUrl: connection.baseUrl,
    model: connection.model,
    ...(apiKey ? { apiKey } : {}),
    timeoutMs,
  }
  return connection.protocol === 'anthropic-messages'
    ? new AnthropicProvider(options)
    : new OpenAiCompatibleProvider(options)
}

export function createConfiguredModelProvider(
  settings: RuntimeSettings,
  store: PegasStore,
  vault: ModelCredentialVault,
  timeoutMs: number,
): JsonModelProvider {
  const preset = modelProviderPreset(settings.modelProvider)
  if (!preset)
    throw new Error(`Unknown model provider: ${settings.modelProvider}`)
  const connection = store.getModelProviderConnection(settings.modelProvider)
  const baseUrl = connection?.baseUrl ?? preset.baseUrl
  if (!baseUrl) throw new Error(`Missing base URL for ${preset.name}`)
  const apiKey = connection?.apiKeyCiphertext
    ? vault.decrypt(connection.apiKeyCiphertext)
    : undefined
  if (preset.requiresApiKey && !apiKey) {
    throw new Error(`Missing API key for ${preset.name}`)
  }
  const protocol = connection?.protocol ?? preset.protocol
  if (protocol === 'anthropic-messages') {
    return new AnthropicProvider({
      baseUrl,
      model: settings.modelName,
      ...(apiKey ? { apiKey } : {}),
      timeoutMs,
    })
  }
  return new OpenAiCompatibleProvider({
    baseUrl,
    model: settings.modelName,
    ...(apiKey ? { apiKey } : {}),
    timeoutMs,
  })
}

export function initializeConfiguredModelProvider(
  store: PegasStore,
  config: PegasConfig,
  vault: ModelCredentialVault,
): void {
  const preset = modelProviderPreset(config.modelProvider)
  if (!preset) return
  const baseUrl = config.modelBaseUrl ?? preset.baseUrl
  if (!baseUrl || (!config.modelApiKey && preset.requiresApiKey)) return
  store.initializeModelProviderConnection({
    id: preset.id,
    name: preset.name,
    protocol: preset.protocol,
    baseUrl,
    ...(config.modelApiKey
      ? { apiKeyCiphertext: vault.encrypt(config.modelApiKey) }
      : {}),
  })
}
