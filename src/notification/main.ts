import { randomUUID } from 'node:crypto'

import { loadConfig } from '../core/config.js'
import { createLogger } from '../observability/logger.js'
import { MetricsRegistry } from '../observability/metrics.js'
import { PegasStore } from '../storage/sqlite-store.js'
import { OutboxDispatcher } from './dispatcher.js'
import { WebhookNotificationChannel } from './webhook-channel.js'

const config = loadConfig()
if (config.pushMode !== 'webhook' || !config.pushWebhookUrl) {
  throw new Error('Notification dispatcher requires PEGAS_PUSH_MODE=webhook')
}

const store = new PegasStore(config.databasePath)
const logger = createLogger({ service: 'notification' })
const metrics = new MetricsRegistry()
const dispatcherId = `dispatcher-${randomUUID()}`
const channel = new WebhookNotificationChannel({
  url: config.pushWebhookUrl,
  ...(config.pushWebhookToken ? { token: config.pushWebhookToken } : {}),
})
const dispatcher = new OutboxDispatcher({
  store,
  channel,
  dispatcherId,
  maxAttempts: config.outboxMaxAttempts,
  logger,
  metrics,
})
const lifecycle = { stopping: false }
const shutdown = new AbortController()

process.on('SIGINT', requestStop)
process.on('SIGTERM', requestStop)

logger.info('service.started', {
  dispatcherId,
  message: `Pegas notification dispatcher ${dispatcherId} started with webhook`,
})

while (!lifecycle.stopping) {
  const dispatched = await dispatcher.dispatchNext(shutdown.signal)
  if (!dispatched) await wait(config.outboxPollMs)
}

store.close()

function requestStop(): void {
  lifecycle.stopping = true
  shutdown.abort()
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
