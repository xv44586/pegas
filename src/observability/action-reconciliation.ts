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
  targetHashes?: Record<string, string>
  absent?: readonly string[]
}): WriteProbeResult {
  const absent = input.absent ?? []
  if (input.targets.length === 0 && absent.length === 0)
    return { resolution: 'inconclusive', matched: [], missing: [] }
  const matched: string[] = []
  const missing: string[] = []
  for (const target of input.targets) {
    try {
      if (!statSync(target).isFile()) {
        missing.push(target)
        continue
      }
      const expected = input.targetHashes?.[target] ?? input.contentHash
      if (expected) {
        const actual = createHash('sha256')
          .update(readFileSync(target))
          .digest('hex')
        if (actual !== expected) {
          missing.push(target)
          continue
        }
      }
      matched.push(target)
    } catch {
      missing.push(target)
    }
  }
  for (const target of absent) {
    try {
      statSync(target)
      missing.push(target)
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        matched.push(target)
      } else {
        missing.push(target)
      }
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
    targetHashes?: Record<string, string>
    absent?: readonly string[]
  }) => WriteProbeResult
  judge?: (
    input: ModelReconciliationInput,
  ) => Promise<ModelReconciliationVerdict>
  limit?: number
}

interface ModelReconciliationTargetEvidence {
  path: string
  exists: boolean
  bytes?: number
  modifiedAt?: string
  content?: string
}

export interface ModelReconciliationInput {
  goal: string
  command: string
  category: string
  targets: ModelReconciliationTargetEvidence[]
}

export interface ModelReconciliationVerdict {
  resolution: 'succeeded' | 'failed' | 'inconclusive'
  reason: string
}

const evidenceContentBudgetBytes = 8_192
const evidenceCommandBudgetChars = 16_384

export function collectModelReconciliationEvidence(input: {
  goal: string
  command: string
  category: string
  targets: readonly string[]
}): ModelReconciliationInput | undefined {
  if (input.command.length > evidenceCommandBudgetChars) return undefined
  const targets: ModelReconciliationTargetEvidence[] = []
  for (const target of input.targets) {
    try {
      const facts = statSync(target)
      if (!facts.isFile()) return undefined
      if (facts.size > evidenceContentBudgetBytes) return undefined
      targets.push({
        path: target,
        exists: true,
        bytes: facts.size,
        modifiedAt: facts.mtime.toISOString(),
        content: readFileSync(target, 'utf8'),
      })
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        targets.push({ path: target, exists: false })
        continue
      }
      return undefined
    }
  }
  return {
    goal: input.goal,
    command: input.command,
    category: input.category,
    targets,
  }
}

export function parseModelReconciliationVerdict(
  value: unknown,
): ModelReconciliationVerdict | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('resolution' in value) ||
    !('reason' in value)
  )
    return undefined
  const resolution = value.resolution
  const reason = value.reason
  if (
    (resolution !== 'succeeded' &&
      resolution !== 'failed' &&
      resolution !== 'inconclusive') ||
    typeof reason !== 'string' ||
    reason.trim().length === 0 ||
    reason.length > 2_000
  )
    return undefined
  return { resolution, reason }
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
 *
 * A fingerprint-less bash write may additionally be judged by a model
 * against the recorded command plus current target facts. The model
 * verdict is advisory evidence, never a fallback to success: a missing
 * judge, unreadable evidence, a malformed verdict or a failed call all
 * leave the Action unknown for humans.
 */
export class ActionReconciliation {
  readonly #store: ActionReconciliationOptions['store']
  readonly #logger?: Logger
  readonly #metrics?: MetricsRegistry
  readonly #probe: NonNullable<ActionReconciliationOptions['probe']>
  readonly #judge?: NonNullable<ActionReconciliationOptions['judge']>
  readonly #limit: number

  constructor(options: ActionReconciliationOptions) {
    this.#store = options.store
    this.#logger = options.logger
    this.#metrics = options.metrics
    this.#probe = options.probe ?? probeWriteAction
    this.#judge = options.judge
    this.#limit = options.limit ?? 50
  }

  async checkOnce(): Promise<AutoReconciliationReport> {
    const report: AutoReconciliationReport = { settled: [], inconclusive: [] }
    const unknown = this.#store.listUnknownActions({ limit: this.#limit })
    for (const action of unknown) {
      const task = this.#store.findTask(action.taskId, action.userId)
      if (!task) {
        report.inconclusive.push(action.id)
        continue
      }
      const probeInput = writeProbeInput(action)
      if (!probeInput) {
        const judged = await this.#judgeBashAction(action, task.goal)
        if (judged) {
          const settled = this.#settle(action, judged.resolution, judged.note)
          if (settled) {
            report.settled.push({
              actionId: action.id,
              resolution: judged.resolution,
            })
          } else {
            report.inconclusive.push(action.id)
          }
          continue
        }
        report.inconclusive.push(action.id)
        continue
      }
      const probed = this.#probe(probeInput)
      if (probed.resolution === 'inconclusive') {
        report.inconclusive.push(action.id)
        continue
      }
      const note =
        probed.resolution === 'succeeded'
          ? `自动探测确认外部状态与预期一致${hasFingerprint(probeInput) ? '（含内容指纹）' : ''}：${probed.matched.join('、')}。`
          : `自动探测确认外部状态与预期不符（目标缺失、指纹不一致或应删除的文件仍存在）：${probed.missing.join('、')}。副作用未发生或未按预期发生。`
      const settled = this.#settle(action, probed.resolution, note)
      if (settled) {
        report.settled.push({
          actionId: action.id,
          resolution: probed.resolution,
        })
      } else {
        report.inconclusive.push(action.id)
      }
    }
    return report
  }

  async #judgeBashAction(
    action: DurableAction & { userId: string },
    goal: string,
  ): Promise<{ resolution: 'succeeded' | 'failed'; note: string } | undefined> {
    if (!this.#judge) return undefined
    if (action.kind !== 'dsh.tool.bash') return undefined
    const request = action.request
    if (request.tool !== 'bash') return undefined
    const category = request.category
    if (category !== 'out-of-workspace-write' && category !== 'workspace-write')
      return undefined
    const command = request.command
    if (typeof command !== 'string' || command.trim().length === 0)
      return undefined
    const targets = request.targets
    if (
      !Array.isArray(targets) ||
      targets.length === 0 ||
      !targets.every(target => typeof target === 'string')
    )
      return undefined
    const evidence = collectModelReconciliationEvidence({
      goal,
      command,
      category,
      targets,
    })
    if (!evidence) {
      this.#logger?.info('action.model_reconcile_skipped', {
        actionId: action.id,
        reason: 'evidence_unavailable',
      })
      return undefined
    }
    let verdict: ModelReconciliationVerdict | undefined
    try {
      verdict = parseModelReconciliationVerdict(await this.#judge(evidence))
    } catch (error) {
      this.#logger?.warn('action.model_reconcile_failed', {
        actionId: action.id,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    if (!verdict || verdict.resolution === 'inconclusive') {
      this.#logger?.info('action.model_reconcile_inconclusive', {
        actionId: action.id,
        ...(verdict ? { reason: verdict.reason.slice(0, 500) } : {}),
      })
      return undefined
    }
    this.#metrics?.increment('pegas_action_model_reconciliations_total', {
      resolution: verdict.resolution,
    })
    return {
      resolution: verdict.resolution,
      note: `模型判定（依据命令原文与目标现状，无静态指纹）：${verdict.reason}`,
    }
  }

  #settle(
    action: DurableAction & { userId: string },
    resolution: 'succeeded' | 'failed',
    note: string,
  ): boolean {
    try {
      this.#store.reconcileAction(action.id, autoReconciler, {
        commandId: `auto-reconcile:${action.id}`,
        resolution,
        note: note.slice(0, 2_000),
      })
      this.#metrics?.increment('pegas_action_auto_reconciliations_total', {
        resolution,
      })
      this.#logger?.info('action.auto_reconciled', {
        actionId: action.id,
        taskId: action.taskId,
        resolution,
      })
      return true
    } catch (error) {
      this.#logger?.warn('action.auto_reconcile_failed', {
        actionId: action.id,
        detail: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }
}

function writeProbeInput(action: DurableAction & { userId: string }):
  | {
      targets: readonly string[]
      contentHash?: string
      targetHashes?: Record<string, string>
      absent?: readonly string[]
    }
  | undefined {
  if (!action.kind.startsWith('dsh.tool.')) return undefined
  const tool = action.request.tool
  if (
    tool !== 'write' &&
    tool !== 'edit' &&
    tool !== 'apply_patch' &&
    tool !== 'bash'
  )
    return undefined
  const category = action.request.category
  if (category !== 'out-of-workspace-write' && category !== 'workspace-write')
    return undefined
  const targets = action.request.targets
  if (
    !Array.isArray(targets) ||
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
  const targetHashes = parseTargetHashes(effect, targets)
  const absent = parseAbsent(effect)
  if (targets.length === 0 && !absent) return undefined
  if (tool !== 'write' && !contentHash && !targetHashes && !absent)
    return undefined
  if (tool === 'bash' && !targetHashes) return undefined
  return {
    targets,
    ...(contentHash ? { contentHash } : {}),
    ...(targetHashes ? { targetHashes } : {}),
    ...(absent ? { absent } : {}),
  }
}

function parseTargetHashes(
  effect: unknown,
  targets: readonly unknown[],
): Record<string, string> | undefined {
  if (
    typeof effect !== 'object' ||
    effect === null ||
    !('targets' in effect) ||
    typeof effect.targets !== 'object' ||
    effect.targets === null ||
    Array.isArray(effect.targets)
  )
    return undefined
  const entries = Object.entries(effect.targets)
  const hashes: Record<string, string> = {}
  for (const [target, value] of entries) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
      return undefined
    hashes[target] = value
  }
  const covered = targets.every(
    target => typeof target === 'string' && hashes[target] !== undefined,
  )
  if (!covered || entries.length === 0) return undefined
  return hashes
}

function hasFingerprint(input: {
  contentHash?: string
  targetHashes?: Record<string, string>
}): boolean {
  return input.contentHash !== undefined || input.targetHashes !== undefined
}

function parseAbsent(effect: unknown): readonly string[] | undefined {
  if (
    typeof effect !== 'object' ||
    effect === null ||
    !('absent' in effect) ||
    !Array.isArray(effect.absent) ||
    effect.absent.length === 0 ||
    !effect.absent.every(target => typeof target === 'string')
  )
    return undefined
  return effect.absent
}
