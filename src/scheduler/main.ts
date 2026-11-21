import { loadConfig } from '../core/config.js'
import { createLogger } from '../observability/logger.js'
import { MetricsRegistry } from '../observability/metrics.js'
import { PegasStore } from '../storage/sqlite-store.js'

const config = loadConfig()
const logger = createLogger({ service: 'scheduler' })
const metrics = new MetricsRegistry()
const store = new PegasStore(config.databasePath)
const lifecycle = { stopping: false }

logger.info('service.started', {
  pollMs: config.schedulerPollMs,
  message: `Pegas scheduler started with ${String(config.schedulerPollMs)}ms poll interval`,
})

process.on('SIGINT', requestStop)
process.on('SIGTERM', requestStop)

while (!lifecycle.stopping) {
  try {
    const fired = store.fireDueAutomations()
    if (fired.length > 0) {
      metrics.increment('pegas_automations_fired_total', {}, fired.length)
      logger.info('automations.dispatched', {
        count: fired.length,
        message: `Dispatched ${String(fired.length)} automation invocation(s)`,
      })
    }
  } catch (error) {
    logger.error('scheduler.iteration_failed', error)
    metrics.increment('pegas_errors_total', {
      component: 'scheduler',
      kind: 'iteration',
    })
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
