import type { Logger } from './logger.js'
import type { MetricsRegistry } from './metrics.js'

export interface HealthcheckTarget {
  name: string
  url: string
  /** Expected healthy HTTP status. Defaults to 200. */
  expectStatus?: number
}

export interface HealthcheckAlert {
  type: 'healthcheck.alert'
  target: string
  status: 'offline' | 'recovered'
  consecutiveFailures: number
  detail?: string
  observedAt: string
}

export interface ExternalHealthcheckOptions {
  targets: HealthcheckTarget[]
  intervalMs?: number
  timeoutMs?: number
  failureThreshold?: number
  logger?: Logger
  metrics?: MetricsRegistry
  alert?: (alert: HealthcheckAlert) => Promise<void>
  fetchImpl?: typeof fetch
  now?: () => Date
}

interface TargetState {
  consecutiveFailures: number
  alerted: boolean
}

/**
 * Host-level watchdog that runs outside the monitored Pegas processes. It
 * probes health endpoints on a fixed interval and alerts once per outage
 * edge (offline after N consecutive failures, recovered on the first
 * success). It never writes product state; alerts are transport-only.
 */
export class ExternalHealthcheck {
  readonly #targets: HealthcheckTarget[]
  readonly #timeoutMs: number
  readonly #failureThreshold: number
  readonly #logger?: Logger
  readonly #metrics?: MetricsRegistry
  readonly #alert?: (alert: HealthcheckAlert) => Promise<void>
  readonly #fetch: typeof fetch
  readonly #now: () => Date
  readonly #states = new Map<string, TargetState>()

  constructor(options: ExternalHealthcheckOptions) {
    if (options.targets.length === 0)
      throw new Error('External healthcheck requires at least one target')
    const names = new Set(options.targets.map(target => target.name))
    if (names.size !== options.targets.length)
      throw new Error('Healthcheck target names must be unique')
    this.#targets = options.targets
    this.#timeoutMs = options.timeoutMs ?? 5_000
    this.#failureThreshold = options.failureThreshold ?? 3
    if (this.#failureThreshold < 1)
      throw new Error('failureThreshold must be at least 1')
    this.#logger = options.logger
    this.#metrics = options.metrics
    this.#alert = options.alert
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? (() => new Date())
    for (const target of options.targets)
      this.#states.set(target.name, { consecutiveFailures: 0, alerted: false })
  }

  /** Runs exactly one probe pass over all targets. */
  async checkOnce(): Promise<void> {
    for (const target of this.#targets) await this.#probe(target)
  }

  async #probe(target: HealthcheckTarget): Promise<void> {
    const state = this.#states.get(target.name)
    if (!state) throw new Error(`Unknown healthcheck target ${target.name}`)
    const expected = target.expectStatus ?? 200
    let healthy = false
    let detail: string | undefined
    try {
      const response = await this.#fetch(target.url, {
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
      healthy = response.status === expected
      if (!healthy) detail = `unexpected status ${String(response.status)}`
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    this.#metrics?.increment('pegas_healthcheck_probes_total', {
      target: target.name,
      outcome: healthy ? 'up' : 'down',
    })
    if (healthy) {
      if (state.alerted) {
        state.alerted = false
        this.#logger?.info('healthcheck.recovered', { target: target.name })
        await this.#emitAlert(target, 'recovered', state.consecutiveFailures)
      }
      state.consecutiveFailures = 0
      return
    }
    state.consecutiveFailures += 1
    this.#logger?.warn('healthcheck.probe_failed', {
      target: target.name,
      consecutiveFailures: state.consecutiveFailures,
      detail,
    })
    if (!state.alerted && state.consecutiveFailures >= this.#failureThreshold) {
      state.alerted = true
      this.#logger?.error(
        'healthcheck.offline',
        new Error(detail ?? 'probe failed'),
        {
          target: target.name,
          consecutiveFailures: state.consecutiveFailures,
        },
      )
      await this.#emitAlert(
        target,
        'offline',
        state.consecutiveFailures,
        detail,
      )
    }
  }

  async #emitAlert(
    target: HealthcheckTarget,
    status: 'offline' | 'recovered',
    consecutiveFailures: number,
    detail?: string,
  ): Promise<void> {
    if (!this.#alert) return
    const alert: HealthcheckAlert = {
      type: 'healthcheck.alert',
      target: target.name,
      status,
      consecutiveFailures,
      ...(detail ? { detail } : {}),
      observedAt: this.#now().toISOString(),
    }
    try {
      await this.#alert(alert)
      this.#metrics?.increment('pegas_healthcheck_alerts_total', {
        target: target.name,
        status,
        outcome: 'sent',
      })
    } catch (error) {
      // The edge stays latched so a failed alert transport does not spam
      // retries; the next recovered→offline cycle alerts again.
      this.#logger?.error('healthcheck.alert_failed', error, {
        target: target.name,
        status,
      })
      this.#metrics?.increment('pegas_healthcheck_alerts_total', {
        target: target.name,
        status,
        outcome: 'failed',
      })
    }
  }
}

export interface WebhookHealthcheckAlertOptions {
  url: string
  token?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** Posts one bounded JSON alert per edge to an operator webhook. */
export function webhookHealthcheckAlert(
  options: WebhookHealthcheckAlertOptions,
): (alert: HealthcheckAlert) => Promise<void> {
  const url = new URL(options.url)
  const timeoutMs = options.timeoutMs ?? 10_000
  const fetchImpl = options.fetchImpl ?? fetch
  return async alert => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `healthcheck:${alert.target}:${alert.status}:${alert.observedAt}`,
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok)
      throw new Error(
        `Healthcheck alert webhook returned ${String(response.status)}`,
      )
  }
}

export interface HealthcheckConfig {
  targets: HealthcheckTarget[]
  intervalMs: number
  timeoutMs: number
  failureThreshold: number
  alertWebhookUrl?: string
  alertWebhookToken?: string
}

/**
 * Reads PEGAS_HEALTHCHECK_TARGETS (`name=url,name=url`),
 * PEGAS_HEALTHCHECK_INTERVAL_MS, PEGAS_HEALTHCHECK_TIMEOUT_MS,
 * PEGAS_HEALTHCHECK_FAILURE_THRESHOLD and the alert webhook settings.
 * Invalid configuration fails closed with a descriptive error.
 */
export function parseHealthcheckConfig(
  env: Record<string, string | undefined>,
): HealthcheckConfig {
  const raw = env.PEGAS_HEALTHCHECK_TARGETS?.trim()
  if (!raw)
    throw new Error(
      'PEGAS_HEALTHCHECK_TARGETS is required (name=http://host:port/healthz,...)',
    )
  const targets: HealthcheckTarget[] = []
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf('=')
    if (separator <= 0)
      throw new Error(`Invalid healthcheck target entry: ${entry}`)
    const name = entry.slice(0, separator).trim()
    const url = entry.slice(separator + 1).trim()
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new Error(`Healthcheck target ${name} must use http(s)`)
    targets.push({ name, url: parsed.toString() })
  }
  return {
    targets,
    intervalMs: positiveInt(env.PEGAS_HEALTHCHECK_INTERVAL_MS, 30_000),
    timeoutMs: positiveInt(env.PEGAS_HEALTHCHECK_TIMEOUT_MS, 5_000),
    failureThreshold: positiveInt(env.PEGAS_HEALTHCHECK_FAILURE_THRESHOLD, 3),
    ...(env.PEGAS_HEALTHCHECK_ALERT_WEBHOOK_URL?.trim()
      ? {
          alertWebhookUrl: env.PEGAS_HEALTHCHECK_ALERT_WEBHOOK_URL.trim(),
        }
      : {}),
    ...(env.PEGAS_HEALTHCHECK_ALERT_WEBHOOK_TOKEN?.trim()
      ? {
          alertWebhookToken: env.PEGAS_HEALTHCHECK_ALERT_WEBHOOK_TOKEN.trim(),
        }
      : {}),
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`Expected a positive integer, got: ${value}`)
  return parsed
}
