import { resolve } from 'node:path'

import { loadConfig } from '../core/config.js'
import {
  createDshModelConfiguration,
  ensureDshProfileHome,
} from '../executor/dsh-home.js'
import { loadDshModelCatalog } from '../executor/dsh-model-catalog.js'
import { loadModelCredentialVault } from '../model/model-credential-vault.js'
import { initializeConfiguredModelProvider } from '../model/provider-factory.js'
import {
  assertRuntimeSettingsAvailable,
  runtimeSettingsDefaults,
  settingsCapabilities,
} from '../settings/runtime-settings.js'
import { resolveInitialModelName } from '../settings/initial-model.js'
import { PegasStore } from '../storage/sqlite-store.js'
import { createLogger } from '../observability/logger.js'
import { MetricsRegistry } from '../observability/metrics.js'
import { createControlPlane } from './server.js'

const config = loadConfig()
const logger = createLogger({ service: 'control-plane' })
const metrics = new MetricsRegistry()
const store = new PegasStore(config.databasePath)
const modelCredentialVault = loadModelCredentialVault(
  config.modelCredentialKeyPath,
)
initializeConfiguredModelProvider(store, config, modelCredentialVault)
const initialModelName = await resolveInitialModelName(config, {
  hasRuntimeSettings: store.hasRuntimeSettings(),
  modelNameExplicit: Boolean(process.env.PEGAS_MODEL_NAME?.trim()),
})
const defaults = runtimeSettingsDefaults({
  ...config,
  modelName: initialModelName,
})
const capabilities = () =>
  settingsCapabilities(config, store.listModelProviderConnectionSummaries())
if (!store.hasRuntimeSettings()) {
  assertRuntimeSettingsAvailable(defaults, capabilities())
}
store.initializeRuntimeSettings(defaults)
if (config.executorMode !== 'echo') {
  ensureDshProfileHome(config.dshHome, config.dshProfile)
}
store.initializeSpeechConnection({
  provider: config.speechProvider,
  baseUrl: config.speechBaseUrl ?? '',
  model: config.speechModel,
  ...(config.speechApiKey
    ? {
        apiKeyCiphertext: modelCredentialVault.encrypt(config.speechApiKey),
      }
    : {}),
})
const server = createControlPlane({
  store,
  webRoot: resolve('dist/web'),
  logger,
  metrics,
  ...(config.apiToken ? { apiToken: config.apiToken } : {}),
  maximumAudioBytes: config.speechMaxAudioBytes,
  speechTimeoutMs: config.speechTimeoutMs,
  settingsCapabilities: capabilities,
  modelCredentialVault,
  modelTimeoutMs: config.modelTimeoutMs,
  ...(config.privacyHmacKey ? { privacyHmacKey: config.privacyHmacKey } : {}),
  recoveryStatus: {
    baseUrl: config.recoveryBaseUrl,
    ...(config.recoveryToken ? { token: config.recoveryToken } : {}),
  },
  agentModelCatalog: () => loadAgentModelCatalog(),
})

async function loadAgentModelCatalog() {
  const settings = store.getRuntimeSettings()
  const modelConfiguration = createDshModelConfiguration({
    connections: store.listModelProviderConnections(),
    vault: modelCredentialVault,
    agentModel: {
      provider: settings.modelProvider,
      model: settings.modelName,
    },
  })
  try {
    return await loadDshModelCatalog({
      command: config.dshCommand,
      profile: config.dshProfile,
      home: config.dshHome,
      patchPath: modelConfiguration.patchPath,
      environment: modelConfiguration.environment,
    })
  } finally {
    modelConfiguration.remove()
  }
}

server.listen(config.apiPort, config.apiHost, () => {
  logger.info('service.started', {
    host: config.apiHost,
    port: config.apiPort,
    message: `Pegas control plane listening on http://${config.apiHost}:${String(config.apiPort)}`,
  })
})

function shutdown(signal: string): void {
  logger.info('service.stopping', {
    signal,
    message: `Received ${signal}; stopping control plane`,
  })
  server.close(() => {
    store.close()
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
