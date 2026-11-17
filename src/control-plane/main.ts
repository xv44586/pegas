import { resolve } from 'node:path'

import { loadConfig } from '../core/config.js'
import { OpenAiTranscriptionProvider } from '../speech/openai-transcription-provider.js'
import { PegasStore } from '../storage/sqlite-store.js'
import { createControlPlane } from './server.js'

const config = loadConfig()
const store = new PegasStore(config.databasePath)
const speechProvider =
  config.speechProvider === 'openai-compatible'
    ? new OpenAiTranscriptionProvider({
        baseUrl: required(config.speechBaseUrl, 'speech base URL'),
        model: config.speechModel,
        ...(config.speechApiKey ? { apiKey: config.speechApiKey } : {}),
        timeoutMs: config.speechTimeoutMs,
      })
    : undefined
const server = createControlPlane({
  store,
  webRoot: resolve('dist/web'),
  ...(config.apiToken ? { apiToken: config.apiToken } : {}),
  ...(speechProvider ? { speechProvider } : {}),
  maximumAudioBytes: config.speechMaxAudioBytes,
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

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`)
  return value
}
