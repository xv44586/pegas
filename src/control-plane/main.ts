import { resolve } from 'node:path'

import { loadConfig } from '../core/config.js'
import { PegasStore } from '../storage/sqlite-store.js'
import { createControlPlane } from './server.js'

const config = loadConfig()
const store = new PegasStore(config.databasePath)
const server = createControlPlane({
  store,
  webRoot: resolve('dist/web'),
  ...(config.apiToken ? { apiToken: config.apiToken } : {}),
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
