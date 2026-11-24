import { loadConfig } from '../core/config.js'
import { loadModelCredentialVault } from '../model/model-credential-vault.js'
import { createConfiguredModelProvider } from '../model/provider-factory.js'
import { PrivacyMaskingProvider } from '../privacy/provider.js'
import { DeterministicPrivacyMasker } from '../privacy/masker.js'
import { PegasStore } from '../storage/sqlite-store.js'
import { ActionReconciliation } from './action-reconciliation.js'
import {
  DeliveryReconciliation,
  parseReconciliationConfig,
} from './delivery-reconciliation.js'
import { createLogger } from './logger.js'
import { MetricsRegistry } from './metrics.js'
import { createModelReconciliationJudge } from './model-reconciliation.js'

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
const actionReconciliation = reconcileConfig.autoReconcile
  ? new ActionReconciliation({
      store,
      logger,
      metrics,
      ...(reconcileConfig.modelReconcile
        ? {
            judge: createModelReconciliationJudge({
              provider: modelProvider,
              logger,
            }),
          }
        : {}),
    })
  : undefined
const modelCredentialVault = reconcileConfig.modelReconcile
  ? loadModelCredentialVault(config.modelCredentialKeyPath)
  : undefined
const lifecycle = { stopping: false }

process.on('SIGINT', requestStop)
process.on('SIGTERM', requestStop)

logger.info('service.started', {
  intervalMs: reconcileConfig.intervalMs,
  autoReconcile: reconcileConfig.autoReconcile,
  modelReconcile:
    reconcileConfig.autoReconcile && reconcileConfig.modelReconcile,
  message: reconcileConfig.autoReconcile
    ? 'Pegas reconciliation watchdog started (read-only delivery findings plus automatic write probes)'
    : 'Pegas delivery reconciliation watchdog started (read-only)',
})

while (!lifecycle.stopping) {
  try {
    const report = reconciliation.checkOnce()
    logger.info('reconciliation.checked', {
      owedCount: report.owedCount,
      findingCount: report.findings.length,
    })
    if (actionReconciliation) {
      const settled = await actionReconciliation.checkOnce()
      if (settled.settled.length > 0 || settled.inconclusive.length > 0) {
        logger.info('action.reconciliation_checked', {
          settledCount: settled.settled.length,
          inconclusiveCount: settled.inconclusive.length,
        })
      }
    }
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

function modelProvider() {
  if (!modelCredentialVault) {
    throw new Error('Model reconciliation is not configured')
  }
  const settings = store.getRuntimeSettings()
  const provider = createConfiguredModelProvider(
    settings,
    store,
    modelCredentialVault,
    config.modelTimeoutMs,
  )
  return settings.privacyMode === 'mask' && config.privacyHmacKey
    ? new PrivacyMaskingProvider(
        provider,
        new DeterministicPrivacyMasker({ hmacKey: config.privacyHmacKey }),
      )
    : provider
}
