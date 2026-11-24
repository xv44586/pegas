import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

import type { DurableAction } from '../approval/approval.js'
import type { PegasStore } from '../storage/sqlite-store.js'
import type { Logger } from './logger.js'
import type { MetricsRegistry } from './metrics.js'

export interface WriteProbeResult {
  resolution: 'succeeded' | 'failed' | 'inconclusive'
  matched: string[]
  missing: string[]
}

export function probeWriteAction(input: {
  targets: readonly string[]
  contentHash?: string
}): WriteProbeResult {
  if (input.targets.length === 0)
    return { resolution: 'inconclusive', matched: [], missing: [] }
  const matched: string[] = []
  const missing: string[] = []
  for (const target of input.targets) {
    try {
      if (!statSync(target).isFile()) {
        missing.push(target)
        continue
      }
      if (input.contentHash) {
        const actual = createHash('sha256')
          .update(readFileSync(target))
          .digest('hex')
        if (actual !== input.contentHash) {
          missing.push(target)
          continue
        }
      }
      matched.push(target)
    } catch {
      missing.push(target)
    }
  }
  if (missing.length > 0) return { resolution: 'failed', matched, missing }
  return { resolution: 'succeeded', matched, missing }
}

export interface ActionReconciliationOptions {
  store: Pick<PegasStore, 'listUnknownActions' | 'reconcileAction' | 'findTask'>
  logger?: Logger
  metrics?: MetricsRegistry
  probe?: (input: {
    targets: readonly string[]
    contentHash?: string
  }) => WriteProbeResult
  limit?: number
}

export interface AutoReconciliationReport {
  settled: { actionId: string; resolution: 'succeeded' | 'failed' }[]
  inconclusive: string[]
}

const autoReconciler = 'system:auto-reconciliation'

/**
 * EXEC-003: actively probe the external world for unknown write side
 * effects. Only file writes with canonical targets are statically
 * verifiable; everything else stays on the human reconciliation path.
 * A missing target (or a content-hash mismatch when the intent recorded
 * one) is confirmed failure, never silently retried.
 */
export class ActionReconciliation {
  readonly #store: ActionReconciliationOptions['store']
  readonly #logger?: Logger
  readonly #metrics?: MetricsRegistry
  readonly #probe: NonNullable<ActionReconciliationOptions['probe']>
  readonly #limit: number

  constructor(options: ActionReconciliationOptions) {
    this.#store = options.store
    this.#logger = options.logger
    this.#metrics = options.metrics
    this.#probe = options.probe ?? probeWriteAction
    this.#limit = options.limit ?? 50
  }

  checkOnce(): AutoReconciliationReport {
    const report: AutoReconciliationReport = { settled: [], inconclusive: [] }
    const unknown = this.#store.listUnknownActions({ limit: this.#limit })
    for (const action of unknown) {
      const probeInput = writeProbeInput(action)
      if (!probeInput) {
        report.inconclusive.push(action.id)
        continue
      }
      const probed = this.#probe(probeInput)
      if (probed.resolution === 'inconclusive') {
        report.inconclusive.push(action.id)
        continue
      }
      const task = this.#store.findTask(action.taskId, action.userId)
      if (!task) {
        report.inconclusive.push(action.id)
        continue
      }
      const note =
        probed.resolution === 'succeeded'
          ? `自动探测确认全部目标已存在${probeInput.contentHash ? '且内容指纹一致' : ''}：${probed.matched.join('、')}。`
          : `自动探测确认目标缺失${probeInput.contentHash ? '或内容指纹不一致' : ''}：${probed.missing.join('、')}。副作用未发生或未按预期发生。`
      try {
        this.#store.reconcileAction(action.id, autoReconciler, {
          commandId: `auto-reconcile:${action.id}`,
          resolution: probed.resolution,
          note: note.slice(0, 2_000),
        })
        report.settled.push({
          actionId: action.id,
          resolution: probed.resolution,
        })
        this.#metrics?.increment('pegas_action_auto_reconciliations_total', {
          resolution: probed.resolution,
        })
        this.#logger?.info('action.auto_reconciled', {
          actionId: action.id,
          taskId: action.taskId,
          resolution: probed.resolution,
        })
      } catch (error) {
        report.inconclusive.push(action.id)
        this.#logger?.warn('action.auto_reconcile_failed', {
          actionId: action.id,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return report
  }
}

function writeProbeInput(
  action: DurableAction & { userId: string },
): { targets: readonly string[]; contentHash?: string } | undefined {
  if (!action.kind.startsWith('dsh.tool.')) return undefined
  const tool = action.request.tool
  if (tool !== 'write' && tool !== 'edit' && tool !== 'apply_patch')
    return undefined
  const category = action.request.category
  if (category !== 'out-of-workspace-write' && category !== 'workspace-write')
    return undefined
  const targets = action.request.targets
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    !targets.every(target => typeof target === 'string')
  )
    return undefined
  const effect = action.request.effect
  const contentHash =
    typeof effect === 'object' &&
    effect !== null &&
    'contentHash' in effect &&
    typeof effect.contentHash === 'string' &&
    /^[0-9a-f]{64}$/.test(effect.contentHash)
      ? effect.contentHash
      : undefined
  if (tool !== 'write' && !contentHash) return undefined
  return {
    targets,
    ...(contentHash ? { contentHash } : {}),
  }
}
