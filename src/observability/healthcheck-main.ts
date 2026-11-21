import {
  ExternalHealthcheck,
  parseHealthcheckConfig,
  webhookHealthcheckAlert,
} from './external-healthcheck.js'
import { createLogger } from './logger.js'
import { MetricsRegistry } from './metrics.js'

const config = parseHealthcheckConfig(process.env)
const logger = createLogger({ service: 'healthcheck' })
const metrics = new MetricsRegistry()
const checker = new ExternalHealthcheck({
  targets: config.targets,
  timeoutMs: config.timeoutMs,
  failureThreshold: config.failureThreshold,
  logger,
  metrics,
  ...(config.alertWebhookUrl
    ? {
        alert: webhookHealthcheckAlert({
          url: config.alertWebhookUrl,
          ...(config.alertWebhookToken
            ? { token: config.alertWebhookToken }
            : {}),
        }),
      }
    : {}),
})
const lifecycle = { stopping: false }

logger.info('service.started', {
  targets: config.targets.map(target => target.name),
  intervalMs: config.intervalMs,
  message: `Pegas external healthcheck watching ${String(config.targets.length)} target(s)`,
})

process.on('SIGINT', requestStop)
process.on('SIGTERM', requestStop)

while (!lifecycle.stopping) {
  try {
    await checker.checkOnce()
  } catch (error) {
    logger.error('healthcheck.iteration_failed', error)
    metrics.increment('pegas_errors_total', {
      component: 'healthcheck',
      kind: 'iteration',
    })
  }
  // Signal callbacks can change stopping while this iteration is awaiting.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!lifecycle.stopping) await wait(config.intervalMs)
}

logger.info('service.stopping', {
  message: 'Pegas external healthcheck stopped',
})

function requestStop(signal: string): void {
  lifecycle.stopping = true
  logger.info('service.stopping_signal', {
    signal,
    message: `Received ${signal}; stopping external healthcheck`,
  })
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
