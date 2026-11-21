import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import {
  createLogger,
  parseLogLevel,
  type StructuredLogRecord,
} from '../src/observability/logger.js'
import { MetricsRegistry } from '../src/observability/metrics.js'
import { OutboxDispatcher } from '../src/notification/dispatcher.js'
import { DeliveryOutcomeUnknownError } from '../src/notification/channel.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import { EchoExecutor } from '../src/executor/echo-executor.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('OBS-001 structured logger', () => {
  it('emits one JSON record per line with service, event and error shape', () => {
    const records: StructuredLogRecord[] = []
    const logger = createLogger({
      service: 'worker',
      sink: record => records.push(record),
      now: () => new Date('2026-11-21T08:00:00.000Z'),
      fields: { workerId: 'worker-1' },
    })
    logger.info('service.started', {
      message: 'Pegas worker started',
      executor: 'echo-test',
    })
    logger.error('run.execution_failed', new Error('boom'), {
      runId: 'run-1',
    })
    expect(records[0]).toEqual({
      ts: '2026-11-21T08:00:00.000Z',
      level: 'info',
      service: 'worker',
      event: 'service.started',
      message: 'Pegas worker started',
      fields: { workerId: 'worker-1', executor: 'echo-test' },
    })
    expect(records[1]?.error).toMatchObject({
      name: 'Error',
      message: 'boom',
    })
    expect(records[1]?.fields).toEqual({
      workerId: 'worker-1',
      runId: 'run-1',
    })
    expect(JSON.parse(JSON.stringify(records[0]))).toEqual(records[0])

    const child = logger.child({ runId: 'run-2' })
    child.warn('run.steered')
    expect(records[2]?.fields).toEqual({
      workerId: 'worker-1',
      runId: 'run-2',
    })
  })

  it('filters by level and defaults to info', () => {
    const records: StructuredLogRecord[] = []
    const logger = createLogger({
      service: 'test',
      level: 'warn',
      sink: record => records.push(record),
    })
    logger.debug('debug.event')
    logger.info('info.event')
    logger.warn('warn.event')
    logger.error('error.event', 'plain failure')
    expect(records.map(record => record.event)).toEqual([
      'warn.event',
      'error.event',
    ])
    expect(records[1]?.error).toEqual({
      name: 'UnknownError',
      message: 'plain failure',
    })
    expect(parseLogLevel(undefined)).toBe('info')
    expect(parseLogLevel('nonsense')).toBe('info')
    expect(parseLogLevel('debug')).toBe('debug')
  })
})

describe('OBS-001 metrics registry', () => {
  it('renders counters and histograms in Prometheus text format', () => {
    const metrics = new MetricsRegistry()
    metrics.increment('pegas_runs_total', { outcome: 'completed' })
    metrics.increment('pegas_runs_total', { outcome: 'completed' })
    metrics.increment('pegas_runs_total', { outcome: 'failed' })
    metrics.observe(
      'pegas_run_duration_seconds',
      0.2,
      { outcome: 'completed' },
      [0.1, 0.5],
    )
    metrics.observe(
      'pegas_run_duration_seconds',
      2,
      { outcome: 'completed' },
      [0.1, 0.5],
    )
    const text = metrics.render()
    expect(text).toContain('# TYPE pegas_runs_total counter')
    expect(text).toContain('pegas_runs_total{outcome="completed"} 2')
    expect(text).toContain('pegas_runs_total{outcome="failed"} 1')
    expect(text).toContain('# TYPE pegas_run_duration_seconds histogram')
    expect(text).toContain(
      'pegas_run_duration_seconds_bucket{le="0.1",outcome="completed"} 0',
    )
    expect(text).toContain(
      'pegas_run_duration_seconds_bucket{le="0.5",outcome="completed"} 1',
    )
    expect(text).toContain(
      'pegas_run_duration_seconds_bucket{le="+Inf",outcome="completed"} 2',
    )
    expect(text).toContain(
      'pegas_run_duration_seconds_count{outcome="completed"} 2',
    )
    expect(new MetricsRegistry().render()).toBe('')
  })
})

describe('OBS-001 control plane telemetry', () => {
  it('serves authenticated /metrics and records request counters', async () => {
    const store = new PegasStore(':memory:')
    const metrics = new MetricsRegistry()
    const records: StructuredLogRecord[] = []
    const logger = createLogger({
      service: 'control-plane',
      sink: record => records.push(record),
    })
    const server = createControlPlane({
      store,
      apiToken: '{{SECRET_obs0token}}',
      logger,
      metrics,
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => store.close(),
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const headers = { authorization: 'Bearer {{SECRET_obs0token}}' }

    const denied = await fetch(`${base}/metrics`)
    expect(denied.status).toBe(401)

    const tasks = await fetch(`${base}/v1/tasks?userId=owner`, { headers })
    expect(tasks.status).toBe(200)
    const bad = await fetch(`${base}/v1/events`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(bad.status).toBe(400)

    const scrape = await fetch(`${base}/metrics`, { headers })
    expect(scrape.status).toBe(200)
    expect(scrape.headers.get('content-type')).toContain('text/plain')
    const text = await scrape.text()
    expect(text).toContain(
      'pegas_http_requests_total{method="GET",route="/v1/tasks",status="200"} 1',
    )
    expect(text).toContain(
      'pegas_http_requests_total{method="POST",route="/v1/events",status="400"} 1',
    )
    expect(text).toContain('pegas_http_request_duration_seconds_count')
    expect(text).toContain(
      'pegas_errors_total{component="control-plane",kind="request_error"} 1',
    )
    // The scrape itself is not counted.
    expect(text).not.toContain('route="/metrics"')
    expect(records.some(record => record.event === 'http.request_failed')).toBe(
      true,
    )
  })

  it('normalizes dynamic ids into low-cardinality routes', async () => {
    const store = new PegasStore(':memory:')
    const metrics = new MetricsRegistry()
    const server = createControlPlane({ store, metrics })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => store.close(),
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    await fetch(`${base}/v1/outbox/0123456789abcdef0123456789abcdef/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'owner' }),
    })
    const text = metrics.render()
    expect(text).toContain('route="/v1/outbox/:id/read"')
    expect(text).not.toContain('0123456789abcdef')
  })
})

describe('OBS-001 worker and dispatcher telemetry', () => {
  it('counts event outcomes and run completions', async () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const metrics = new MetricsRegistry()
    const records: StructuredLogRecord[] = []
    const telemetry = {
      metrics,
      logger: createLogger({
        service: 'worker',
        sink: record => records.push(record),
      }),
    }
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '遥测闭环' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
      'worker-obs',
      telemetry,
    )
    const claimed = store.claimNextRun('worker-obs')
    if (!claimed) throw new Error('Expected claim')
    await executeClaimedRun(
      store,
      new EchoExecutor(),
      claimed,
      'worker-obs',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:1',
      telemetry,
    )
    const text = metrics.render()
    expect(text).toContain(
      'pegas_events_processed_total{outcome="processed"} 1',
    )
    expect(text).toContain('pegas_runs_total{outcome="completed"} 1')
    expect(text).toContain(
      'pegas_run_duration_seconds_count{outcome="completed"} 1',
    )
  })

  it('records run failures as errors with durable identifiers only', async () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const metrics = new MetricsRegistry()
    const records: StructuredLogRecord[] = []
    const telemetry = {
      metrics,
      logger: createLogger({
        service: 'worker',
        sink: record => records.push(record),
      }),
    }
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '会失败的任务' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
      'worker-obs',
      telemetry,
    )
    const claimed = store.claimNextRun('worker-obs')
    if (!claimed) throw new Error('Expected claim')
    await executeClaimedRun(
      store,
      {
        name: 'failing',
        execute: () => Promise.reject(new Error('executor exploded')),
      },
      claimed,
      'worker-obs',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:1',
      telemetry,
    )
    const failure = records.find(
      record => record.event === 'run.execution_failed',
    )
    expect(failure?.fields).toEqual({
      runId: claimed.run.id,
      taskId: claimed.task.id,
      workerId: 'worker-obs',
    })
    // The user's message text never enters the log record.
    expect(JSON.stringify(failure)).not.toContain('会失败的任务')
    expect(metrics.render()).toContain('pegas_runs_total{outcome="failed"} 1')
    expect(metrics.render()).toContain(
      'pegas_errors_total{component="worker",kind="run_execution"} 1',
    )
  })

  it('counts outbox delivery outcomes including unknown parking', async () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const metrics = new MetricsRegistry()
    const records: StructuredLogRecord[] = []
    store.enqueueOutbox({
      userId: 'owner',
      channel: 'conversation',
      dedupeKey: 'obs-unknown',
      payload: { text: 'unknown' },
    })
    const dispatcher = new OutboxDispatcher({
      store,
      dispatcherId: 'dispatcher-obs',
      metrics,
      logger: createLogger({
        service: 'notification',
        sink: record => records.push(record),
      }),
      channel: {
        name: 'flaky',
        deliver: () =>
          Promise.reject(new DeliveryOutcomeUnknownError('timeout')),
      },
    })
    await dispatcher.dispatchNext()
    store.enqueueOutbox({
      userId: 'owner',
      channel: 'conversation',
      dedupeKey: 'obs-sent',
      payload: { text: 'sent' },
    })
    const healthy = new OutboxDispatcher({
      store,
      dispatcherId: 'dispatcher-obs',
      metrics,
      channel: { name: 'ok', deliver: () => Promise.resolve() },
    })
    await healthy.dispatchNext()
    const text = metrics.render()
    expect(text).toContain('pegas_outbox_deliveries_total{outcome="unknown"} 1')
    expect(text).toContain('pegas_outbox_deliveries_total{outcome="sent"} 1')
    expect(text).toContain(
      'pegas_errors_total{component="notification",kind="delivery_unknown"} 1',
    )
    expect(
      records.some(record => record.event === 'outbox.delivery_unknown'),
    ).toBe(true)
  })
})
