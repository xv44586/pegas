import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ExternalHealthcheck,
  parseHealthcheckConfig,
  webhookHealthcheckAlert,
  type HealthcheckAlert,
} from '../src/observability/external-healthcheck.js'
import {
  createLogger,
  type StructuredLogRecord,
} from '../src/observability/logger.js'
import { MetricsRegistry } from '../src/observability/metrics.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function probeServer(): Promise<{
  url: string
  state: { status: number }
}> {
  const state = { status: 200 }
  const server: Server = createServer((_request, response) => {
    response.writeHead(state.status).end('ok')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () => new Promise<void>(resolve => server.close(() => resolve())),
  )
  const address = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${String(address.port)}/healthz`, state }
}

describe('OBS-001 external healthcheck watchdog', () => {
  it('alerts once after the failure threshold and once on recovery', async () => {
    const target = await probeServer()
    const alerts: HealthcheckAlert[] = []
    const records: StructuredLogRecord[] = []
    const metrics = new MetricsRegistry()
    const checker = new ExternalHealthcheck({
      targets: [{ name: 'control-plane', url: target.url }],
      failureThreshold: 2,
      logger: createLogger({
        service: 'healthcheck',
        sink: record => records.push(record),
      }),
      metrics,
      alert: alert => {
        alerts.push(alert)
        return Promise.resolve()
      },
    })
    await checker.checkOnce()
    expect(alerts).toHaveLength(0)
    target.state.status = 503
    await checker.checkOnce()
    expect(alerts).toHaveLength(0)
    await checker.checkOnce()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toEqual(
      expect.objectContaining({
        type: 'healthcheck.alert',
        target: 'control-plane',
        status: 'offline',
        consecutiveFailures: 2,
        detail: 'unexpected status 503',
      }),
    )
    // The offline edge stays latched: no repeated alerts while down.
    await checker.checkOnce()
    await checker.checkOnce()
    expect(alerts).toHaveLength(1)
    target.state.status = 200
    await checker.checkOnce()
    expect(alerts).toHaveLength(2)
    expect(alerts[1]?.status).toBe('recovered')
    // A second outage alerts again.
    target.state.status = 500
    await checker.checkOnce()
    await checker.checkOnce()
    expect(alerts).toHaveLength(3)
    expect(alerts[2]?.status).toBe('offline')
    const rendered = metrics.render()
    expect(rendered).toContain(
      'pegas_healthcheck_probes_total{outcome="up",target="control-plane"} 2',
    )
    expect(rendered).toContain(
      'pegas_healthcheck_probes_total{outcome="down",target="control-plane"} 6',
    )
    expect(rendered).toContain('pegas_healthcheck_alerts_total')
    expect(
      records.some(
        record =>
          record.event === 'healthcheck.offline' && record.level === 'error',
      ),
    ).toBe(true)
    expect(
      records.some(record => record.event === 'healthcheck.recovered'),
    ).toBe(true)
  })

  it('treats connection failure and timeout as down without throwing', async () => {
    const alerts: HealthcheckAlert[] = []
    const checker = new ExternalHealthcheck({
      targets: [
        { name: 'dead', url: 'http://dead.invalid/healthz' },
        { name: 'slow', url: 'http://slow.invalid/healthz' },
      ],
      failureThreshold: 1,
      timeoutMs: 50,
      fetchImpl: (input, init) => {
        const url = input instanceof Request ? input.url : input.toString()
        if (url.includes('dead.invalid'))
          return Promise.reject(new Error('connect ECONNREFUSED'))
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('The operation was aborted due to timeout'))
          })
        })
      },
      alert: alert => {
        alerts.push(alert)
        return Promise.resolve()
      },
    })
    await checker.checkOnce()
    expect(alerts).toHaveLength(2)
    expect(alerts.map(alert => alert.target).sort()).toEqual(['dead', 'slow'])
    expect(alerts[0]?.detail).toBeTruthy()
  })

  it('keeps the outage latched when the alert transport fails', async () => {
    const target = await probeServer()
    target.state.status = 500
    const records: StructuredLogRecord[] = []
    const metrics = new MetricsRegistry()
    let attempts = 0
    const checker = new ExternalHealthcheck({
      targets: [{ name: 'control-plane', url: target.url }],
      failureThreshold: 1,
      logger: createLogger({
        service: 'healthcheck',
        sink: record => records.push(record),
      }),
      metrics,
      alert: () => {
        attempts += 1
        return Promise.reject(new Error('webhook down'))
      },
    })
    await checker.checkOnce()
    await checker.checkOnce()
    expect(attempts).toBe(1)
    expect(metrics.render()).toContain('outcome="failed"')
    expect(
      records.some(record => record.event === 'healthcheck.alert_failed'),
    ).toBe(true)
    target.state.status = 200
    await checker.checkOnce()
    expect(attempts).toBe(2)
  })

  it('validates targets and thresholds fail-closed', () => {
    expect(() => new ExternalHealthcheck({ targets: [] })).toThrow(
      'at least one target',
    )
    expect(
      () =>
        new ExternalHealthcheck({
          targets: [
            { name: 'a', url: 'http://127.0.0.1:1/healthz' },
            { name: 'a', url: 'http://127.0.0.1:2/healthz' },
          ],
        }),
    ).toThrow('unique')
    expect(
      () =>
        new ExternalHealthcheck({
          targets: [{ name: 'a', url: 'http://127.0.0.1:1/healthz' }],
          failureThreshold: 0,
        }),
    ).toThrow('at least 1')
  })
})

describe('OBS-001 healthcheck configuration', () => {
  it('parses targets and applies defaults', () => {
    const config = parseHealthcheckConfig({
      PEGAS_HEALTHCHECK_TARGETS:
        'control-plane=http://127.0.0.1:8787/healthz, recovery=http://127.0.0.1:8788/healthz',
      PEGAS_HEALTHCHECK_ALERT_WEBHOOK_URL: 'http://127.0.0.1:9000/alert',
      PEGAS_HEALTHCHECK_ALERT_WEBHOOK_TOKEN: 'secret',
    })
    expect(config.targets).toEqual([
      { name: 'control-plane', url: 'http://127.0.0.1:8787/healthz' },
      { name: 'recovery', url: 'http://127.0.0.1:8788/healthz' },
    ])
    expect(config.intervalMs).toBe(30_000)
    expect(config.timeoutMs).toBe(5_000)
    expect(config.failureThreshold).toBe(3)
    expect(config.alertWebhookUrl).toBe('http://127.0.0.1:9000/alert')
    expect(config.alertWebhookToken).toBe('secret')
  })

  it('rejects missing targets, malformed entries and non-http protocols', () => {
    expect(() => parseHealthcheckConfig({})).toThrow(
      'PEGAS_HEALTHCHECK_TARGETS is required',
    )
    expect(() =>
      parseHealthcheckConfig({ PEGAS_HEALTHCHECK_TARGETS: 'no-separator' }),
    ).toThrow('Invalid healthcheck target entry')
    expect(() =>
      parseHealthcheckConfig({
        PEGAS_HEALTHCHECK_TARGETS: 'x=file:///etc/passwd',
      }),
    ).toThrow('must use http(s)')
    expect(() =>
      parseHealthcheckConfig({
        PEGAS_HEALTHCHECK_TARGETS: 'x=http://127.0.0.1:1/healthz',
        PEGAS_HEALTHCHECK_INTERVAL_MS: '-5',
      }),
    ).toThrow('positive integer')
  })
})

describe('OBS-001 webhook alert transport', () => {
  it('posts a bounded JSON alert with idempotency key and bearer token', async () => {
    const received: {
      headers: Record<string, string | string[] | undefined>
      body: unknown
    }[] = []
    const state = { status: 204 }
    const server = createServer(async (request, response) => {
      const chunks: Uint8Array[] = []
      for await (const chunk of request) chunks.push(chunk as Uint8Array)
      received.push({
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      })
      response.writeHead(state.status).end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const address = server.address() as AddressInfo
    const send = webhookHealthcheckAlert({
      url: `http://127.0.0.1:${String(address.port)}/alert`,
      token: 'alert-secret',
    })
    const alert: HealthcheckAlert = {
      type: 'healthcheck.alert',
      target: 'control-plane',
      status: 'offline',
      consecutiveFailures: 3,
      detail: 'unexpected status 503',
      observedAt: '2026-11-21T00:00:00.000Z',
    }
    await send(alert)
    expect(received).toHaveLength(1)
    expect(received[0]?.headers.authorization).toBe('Bearer alert-secret')
    expect(received[0]?.headers['idempotency-key']).toBe(
      'healthcheck:control-plane:offline:2026-11-21T00:00:00.000Z',
    )
    expect(received[0]?.body).toEqual(alert)
    state.status = 500
    await expect(send(alert)).rejects.toThrow('returned 500')
  })
})
