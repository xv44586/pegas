import { resolve } from 'node:path'

import { loadConfig } from '../core/config.js'
import { loadDshModelCatalog } from '../executor/dsh-model-catalog.js'
import { loadModelCredentialVault } from '../model/model-credential-vault.js'
import { initializeConfiguredModelProvider } from '../model/provider-factory.js'
import {
  assertRuntimeSettingsAvailable,
  runtimeSettingsDefaults,
  settingsCapabilities,
} from '../settings/runtime-settings.js'
import { PegasStore } from '../storage/sqlite-store.js'
import { createControlPlane } from './server.js'

const config = loadConfig()
const store = new PegasStore(config.databasePath)
const modelCredentialVault = loadModelCredentialVault(
  config.modelCredentialKeyPath,
)
initializeConfiguredModelProvider(store, config, modelCredentialVault)
const defaults = runtimeSettingsDefaults(config)
const capabilities = () =>
  settingsCapabilities(config, store.listModelProviderConnectionSummaries())
if (!store.hasRuntimeSettings()) {
  assertRuntimeSettingsAvailable(defaults, capabilities())
}
store.initializeRuntimeSettings(defaults)
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
  ...(config.apiToken ? { apiToken: config.apiToken } : {}),
  maximumAudioBytes: config.speechMaxAudioBytes,
  speechTimeoutMs: config.speechTimeoutMs,
  settingsCapabilities: capabilities,
  modelCredentialVault,
  modelTimeoutMs: config.modelTimeoutMs,
  ...(config.privacyHmacKey ? { privacyHmacKey: config.privacyHmacKey } : {}),
  agentModelCatalog: () =>
    loadDshModelCatalog({
      command: config.dshCommand,
      profile: config.dshProfile,
    }),
})

server.listen(config.apiPort, config.apiHost, () => {
  console.log(
    `Pegas control plane listening on http://${config.apiHost}:${String(config.apiPort)}`,
  )
})

function shutdown(signal: string): void {
  console.log(`Received ${signal}; stopping control plane`)
  server.close(() => {
    store.close()
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
