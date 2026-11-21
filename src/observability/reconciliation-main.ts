import { loadConfig } from '../core/config.js'
import { PegasStore } from '../storage/sqlite-store.js'
import {
  DeliveryReconciliation,
  parseReconciliationConfig,
} from './delivery-reconciliation.js'
import { createLogger } from './logger.js'
import { MetricsRegistry } from './metrics.js'

const config = loadConfig()
const reconcileConfig = parseReconciliationConfig(process.env)
const store = new PegasStore(config.databasePath)
const logger = createLogger({ service: 'reconciliation' })
const metrics = new MetricsRegistry()
const reconciliation = new DeliveryReconciliation({
  store,
  logger,
  metrics,
  thresholds: {
    unreportedAfterMs: reconcileConfig.unreportedAfterMs,
    neverStartedAfterMs: reconcileConfig.neverStartedAfterMs,
    strandedAfterMs: reconcileConfig.strandedAfterMs,
    staleWaitingAfterMs: reconcileConfig.staleWaitingAfterMs,
  },
})
const lifecycle = { stopping: false }

process.on('SIGINT', requestStop)
process.on('SIGTERM', requestStop)

logger.info('service.started', {
  intervalMs: reconcileConfig.intervalMs,
  message: 'Pegas delivery reconciliation watchdog started (read-only)',
})

while (!lifecycle.stopping) {
  try {
    const report = reconciliation.checkOnce()
    logger.info('reconciliation.checked', {
      owedCount: report.owedCount,
      findingCount: report.findings.length,
    })
  } catch (error) {
    logger.error('reconciliation.iteration_failed', error)
    metrics.increment('pegas_errors_total', {
      component: 'reconciliation',
      kind: 'iteration',
    })
  }
  // Signal callbacks can change stopping while this iteration is awaiting.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!lifecycle.stopping) await wait(reconcileConfig.intervalMs)
}

store.close()
logger.info('service.stopping', {
  message: 'Pegas delivery reconciliation watchdog stopped',
})

function requestStop(signal: string): void {
  lifecycle.stopping = true
  logger.info('service.stopping_signal', {
    signal,
    message: `Received ${signal}; stopping delivery reconciliation`,
  })
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
