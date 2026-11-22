import type { ReconciliationFinding } from '../core/domain.js'
import type { PegasStore } from '../storage/sqlite-store.js'
import type { Logger } from './logger.js'
import type { MetricsRegistry } from './metrics.js'

export interface DeliveryReconciliationOptions {
  store: Pick<PegasStore, 'listOwedDeliveries' | 'listReconciliationFindings'>
  logger?: Logger
  metrics?: MetricsRegistry
  thresholds?: {
    unreportedAfterMs?: number
    neverStartedAfterMs?: number
    strandedAfterMs?: number
    staleWaitingAfterMs?: number
    nodeOnlineWithinMs?: number
  }
}

export interface ReconciliationReport {
  owedCount: number
  findings: ReconciliationFinding[]
}

/**
 * NOTIFY-006: read-only delivery reconciliation, the second safety net behind
 * the durable lease/retry recovery chain. It compares terminal Runs against
 * confirmed Outbox deliveries and surfaces four finding kinds. Following the
 * OBS-001 watchdog boundary it never writes product state and never triggers
 * automatic repair; operators act through the existing recovery paths.
 */
export class DeliveryReconciliation {
  readonly #store: DeliveryReconciliationOptions['store']
  readonly #logger?: Logger
  readonly #metrics?: MetricsRegistry
  readonly #thresholds: NonNullable<DeliveryReconciliationOptions['thresholds']>

  constructor(options: DeliveryReconciliationOptions) {
    this.#store = options.store
    this.#logger = options.logger
    this.#metrics = options.metrics
    this.#thresholds = options.thresholds ?? {}
  }

  checkOnce(): ReconciliationReport {
    const owed = this.#store.listOwedDeliveries()
    const findings = this.#store.listReconciliationFindings(this.#thresholds)
    this.#metrics?.increment('pegas_owed_deliveries', {}, owed.length)
    for (const finding of findings) {
      this.#metrics?.increment('pegas_reconciliation_findings_total', {
        kind: finding.kind,
      })
      this.#logger?.warn('reconciliation.finding', {
        kind: finding.kind,
        taskId: finding.taskId,
        ...(finding.runId ? { runId: finding.runId } : {}),
        ...(finding.nodeId ? { nodeId: finding.nodeId } : {}),
        since: finding.since,
        detail: finding.detail,
      })
    }
    return { owedCount: owed.length, findings }
  }
}

export interface ReconciliationWatchdogConfig {
  intervalMs: number
  unreportedAfterMs: number
  neverStartedAfterMs: number
  strandedAfterMs: number
  staleWaitingAfterMs: number
}

export function parseReconciliationConfig(
  env: Record<string, string | undefined>,
): ReconciliationWatchdogConfig {
  return {
    intervalMs: positiveInt(env.PEGAS_RECONCILE_INTERVAL_MS, 60_000),
    unreportedAfterMs: positiveInt(
      env.PEGAS_RECONCILE_UNREPORTED_AFTER_MS,
      300_000,
    ),
    neverStartedAfterMs: positiveInt(
      env.PEGAS_RECONCILE_NEVER_STARTED_AFTER_MS,
      300_000,
    ),
    strandedAfterMs: positiveInt(
      env.PEGAS_RECONCILE_STRANDED_AFTER_MS,
      120_000,
    ),
    staleWaitingAfterMs: positiveInt(
      env.PEGAS_RECONCILE_STALE_WAITING_AFTER_MS,
      300_000,
    ),
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`Expected a positive integer, got: ${value}`)
  return parsed
}
