import { loadConfig } from '../core/config.js'
import { PegasStore } from '../storage/sqlite-store.js'

const config = loadConfig()
const store = new PegasStore(config.databasePath)
const lifecycle = { stopping: false }

console.log(
  `Pegas scheduler started with ${String(config.schedulerPollMs)}ms poll interval`,
)

process.on('SIGINT', requestStop)
process.on('SIGTERM', requestStop)

while (!lifecycle.stopping) {
  try {
    const fired = store.fireDueAutomations()
    if (fired.length > 0) {
      console.log(`Dispatched ${String(fired.length)} automation invocation(s)`)
    }
  } catch (error) {
    console.error('Automation scheduler iteration failed', error)
  }
  // Signal callbacks can change stopping while this iteration is awaiting.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!lifecycle.stopping) await wait(config.schedulerPollMs)
}

store.close()

function requestStop(): void {
  lifecycle.stopping = true
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
