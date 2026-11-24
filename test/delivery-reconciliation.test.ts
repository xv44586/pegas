import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import type { ActionRequestDraft } from '../src/approval/approval.js'
import { createControlPlane } from '../src/control-plane/server.js'
import type { Clock } from '../src/core/clock.js'
import type { ClaimedRun } from '../src/core/domain.js'
import {
  DeliveryReconciliation,
  parseReconciliationConfig,
} from '../src/observability/delivery-reconciliation.js'
import {
  createLogger,
  type StructuredLogRecord,
} from '../src/observability/logger.js'
import { MetricsRegistry } from '../src/observability/metrics.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

class MutableClock implements Clock {
  #value: Date

  constructor(value: string) {
    this.#value = new Date(value)
  }

  now(): Date {
    return new Date(this.#value)
  }

  set(value: string): void {
    this.#value = new Date(value)
  }

  advance(ms: number): void {
    this.#value = new Date(this.#value.getTime() + ms)
  }
}

function seededStore(path = ':memory:'): {
  store: PegasStore
  clock: MutableClock
} {
  const clock = new MutableClock('2026-11-22T02:00:00.000Z')
  const store = new PegasStore(path, { clock })
  cleanups.push(() => store.close())
  return { store, clock }
}

function createClaimedTask(
  store: PegasStore,
  text: string,
  options: {
    userId?: string
    claim?: boolean
    nodeId?: string
  } = {},
): ClaimedRun & { eventId: string } {
  const userId = options.userId ?? 'owner'
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
  }).event
  const claimedEvent = store.claimNextEvent('recon-router')
  if (!claimedEvent) throw new Error('Expected event claim')
  const applied = store.applyRoutingDecision(
    claimedEvent,
    { kind: 'create_task', title: text, goal: text, input: text, reason: 't' },
    'echo-test',
    {
      executor: 'echo-test',
      ...(options.nodeId ? { nodeId: options.nodeId } : {}),
    },
  )
  store.completeEvent(event.id, 'recon-router')
  if (options.claim === false)
    return {
      ...applied,
      claimToken: '',
      phase: 'execute',
      eventId: event.id,
    }
  const claimed = store.claimNextRun('recon-worker')
  if (!claimed) throw new Error('Expected run claim')
  return { ...claimed, eventId: event.id }
}

function completeWithDelivery(store: PegasStore, claimed: ClaimedRun): void {
  store.completeRun(claimed.run.id, 'recon-worker', {
    executorRef: 'session-recon',
    output: '完成',
  })
}

function sendNotification(store: PegasStore, dedupeKey: string): void {
  const message = store
    .listOutbox('owner')
    .find(candidate => candidate.dedupeKey === dedupeKey)
  if (!message) throw new Error(`Expected outbox message ${dedupeKey}`)
  const claimed = store.claimNextOutbox('recon-dispatcher')
  if (claimed?.id !== message.id) throw new Error('Expected notification claim')
  store.markOutboxSent(message.id, 'recon-dispatcher')
}

function approvalDraft(idempotencyKey: string): ActionRequestDraft {
  return {
    kind: 'publish.release',
    risk: 'high',
    idempotencyKey,
    request: { release: 'v1' },
    recoveryPoint: { step: 'before_publish' },
    approval: {
      summary: 'Publish release v1',
      impact: 'Makes the release public',
      recommendedOptionId: 'approve',
      options: [
        { id: 'approve', label: 'Publish', kind: 'approve' },
        { id: 'reject', label: 'Do not publish', kind: 'reject' },
      ],
    },
  }
}

describe('NOTIFY-006 owed-delivery ledger', () => {
  it('keeps terminal Runs owed until the notification is confirmed sent', () => {
    const { store } = seededStore()
    const claimed = createClaimedTask(store, '整理会议纪要')
    completeWithDelivery(store, claimed)

    const owed = store.listOwedDeliveries('owner')
    expect(owed).toHaveLength(1)
    expect(owed[0]).toMatchObject({
      taskId: claimed.task.id,
      runId: claimed.run.id,
      runStatus: 'completed',
      deliveryStatus: 'pending',
      dedupeKey: `run-completed:${claimed.run.id}`,
    })

    sendNotification(store, `run-completed:${claimed.run.id}`)
    expect(store.listOwedDeliveries('owner')).toEqual([])
  })

  it('treats exhausted and unknown deliveries as still owed, settled only by confirmation', () => {
    const { store, clock } = seededStore()
    const failed = createClaimedTask(store, '投递会失败的任务')
    completeWithDelivery(store, failed)
    const failedMessage = store.claimNextOutbox('recon-dispatcher')
    if (!failedMessage) throw new Error('Expected outbox claim')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const claimed =
        attempt === 0
          ? failedMessage
          : store.claimNextOutbox('recon-dispatcher')
      if (!claimed) throw new Error('Expected retry claim')
      clock.advance(60_000)
      store.failOutbox(
        claimed.id,
        'recon-dispatcher',
        'webhook down',
        clock.now(),
      )
    }
    expect(
      store.listOwedDeliveries('owner').map(entry => entry.deliveryStatus),
    ).toEqual(['failed'])

    const unknown = createClaimedTask(store, '投递结果未知的任务')
    completeWithDelivery(store, unknown)
    const unknownMessage = store.claimNextOutbox('recon-dispatcher')
    if (!unknownMessage) throw new Error('Expected outbox claim')
    store.markOutboxUnknown(
      unknownMessage.id,
      'recon-dispatcher',
      'connection reset after send',
    )
    expect(store.listOwedDeliveries('owner')).toHaveLength(2)

    store.resolveOutboxMessage(unknownMessage.id, 'owner', {
      commandId: 'resolve-unknown-1',
      resolution: 'sent',
      note: '用户在 Web 端已看到该消息',
    })
    const remaining = store.listOwedDeliveries('owner')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.runId).toBe(failed.run.id)
  })

  it('follows merged messages and scopes the ledger by owner', () => {
    const { store } = seededStore()
    const claimed = createClaimedTask(store, '会被合并的通知')
    completeWithDelivery(store, claimed)
    store.enqueueOutbox({
      userId: 'owner',
      taskId: claimed.task.id,
      channel: 'conversation',
      dedupeKey: 'coalesce-newer',
      coalesceKey: 'recon-coalesce',
      payload: { type: 'agent.message', runId: claimed.run.id, text: '更新' },
    })
    store.enqueueOutbox({
      userId: 'owner',
      taskId: claimed.task.id,
      channel: 'conversation',
      dedupeKey: 'coalesce-older',
      coalesceKey: 'recon-coalesce',
      payload: { type: 'agent.message', runId: claimed.run.id, text: '旧' },
    })
    const merged = store.listOwedDeliveries('owner')
    expect(
      merged.some(
        entry =>
          entry.deliveryStatus === 'merged' &&
          entry.mergedIntoStatus === 'pending',
      ),
    ).toBe(true)
    expect(store.listOwedDeliveries('someone-else')).toEqual([])
  })
})

describe('NOTIFY-006 reconciliation findings', () => {
  it('Unreported: a crash between Run write-back and delivery keeps the finding until sent', () => {
    const { store, clock } = seededStore()
    const claimed = createClaimedTask(store, '写回后通知前崩溃')
    completeWithDelivery(store, claimed)
    // Dispatcher never confirms: equivalent to SIGKILL during delivery.
    expect(store.listReconciliationFindings()).toEqual([])
    clock.advance(301_000)
    const findings = store.listReconciliationFindings()
    expect(findings).toEqual([
      expect.objectContaining({
        kind: 'unreported',
        taskId: claimed.task.id,
        runId: claimed.run.id,
      }),
    ])
    sendNotification(store, `run-completed:${claimed.run.id}`)
    expect(store.listReconciliationFindings()).toEqual([])
  })

  it('Unreported: a crash before write-back surfaces after lease expiry settles the Run', () => {
    const { store, clock } = seededStore()
    const claimed = createClaimedTask(store, '写回前崩溃')
    // Worker died holding the lease; nothing was written back.
    clock.advance(31_000)
    const successor = store.claimNextRun('takeover-worker')
    if (!successor) throw new Error('Expected lease-expiry takeover')
    expect(successor.run.retryOfRunId).toBe(claimed.run.id)
    store.failRun(successor.run.id, 'takeover-worker', 'executor crashed')
    clock.advance(301_000)
    const findings = store.listReconciliationFindings()
    expect(findings.filter(finding => finding.kind === 'unreported')).toEqual([
      expect.objectContaining({ runId: successor.run.id }),
    ])
    sendNotification(store, `run-failed:${successor.run.id}`)
    expect(
      store
        .listReconciliationFindings()
        .filter(finding => finding.kind === 'unreported'),
    ).toEqual([])
  })

  it('NeverStarted: an open Task without any Run is surfaced', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-recon-never-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const databasePath = join(directory, 'pegas.db')
    const { store, clock } = seededStore(databasePath)
    const created = createClaimedTask(store, '从未产生 Run', { claim: false })
    // Simulate a Task whose Run creation never became durable (routing
    // crashed between Task creation and Run write-back in an older build).
    const database = new DatabaseSync(databasePath)
    database.exec('PRAGMA busy_timeout = 5000;')
    database.prepare('DELETE FROM runs WHERE task_id = ?').run(created.task.id)
    database.close()
    expect(store.listRuns(created.task.id)).toEqual([])
    expect(store.listReconciliationFindings()).toEqual([])
    clock.advance(301_000)
    expect(store.listReconciliationFindings()).toEqual([
      expect.objectContaining({
        kind: 'never_started',
        taskId: created.task.id,
      }),
    ])
    const continuation = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '开始处理吧' },
    }).event
    const claimedEvent = store.claimNextEvent('recon-router')
    if (!claimedEvent) throw new Error('Expected event claim')
    const continued = store.applyRoutingDecision(
      claimedEvent,
      {
        kind: 'continue_task',
        taskId: created.task.id,
        input: '开始处理吧',
        reason: 't',
      },
      'echo-test',
      { executor: 'echo-test' },
    )
    store.completeEvent(continuation.id, 'recon-router')
    const claimed = store.claimNextRun('recon-worker')
    if (!claimed) throw new Error('Expected run claim')
    expect(continued.run.id).toBe(claimed.run.id)
    completeWithDelivery(store, claimed)
    sendNotification(store, `run-completed:${claimed.run.id}`)
    expect(store.listReconciliationFindings()).toEqual([])
  })

  it('Stranded: queued Runs are only flagged while a matching node is online', () => {
    const { store, clock } = seededStore()
    const pinned = createClaimedTask(store, '绑定节点的任务', {
      claim: false,
      nodeId: 'node-a',
    })
    clock.advance(121_000)
    // No node has ever heartbeated: nothing to strand against.
    expect(
      store
        .listReconciliationFindings()
        .filter(finding => finding.kind === 'stranded'),
    ).toEqual([])
    store.registerExecutionNode({ id: 'node-b', label: 'Other node' })
    expect(
      store
        .listReconciliationFindings()
        .filter(finding => finding.kind === 'stranded'),
    ).toEqual([])
    store.registerExecutionNode({ id: 'node-a', label: 'Pinned node' })
    const findings = store
      .listReconciliationFindings()
      .filter(finding => finding.kind === 'stranded')
    expect(findings).toEqual([
      expect.objectContaining({
        taskId: pinned.task.id,
        runId: pinned.run.id,
        nodeId: 'node-a',
      }),
    ])
    clock.advance(91_000)
    expect(
      store
        .listReconciliationFindings()
        .filter(finding => finding.kind === 'stranded'),
    ).toEqual([])
  })

  it('StaleWaiting: a resolved approval that never woke its Run is surfaced', () => {
    const { store, clock } = seededStore()
    const claimed = createClaimedTask(store, '等待审批的任务')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft('recon-approval-1'),
    )
    clock.advance(301_000)
    // Decision applied to the approval row but the Run wake-up was lost
    // (crash between approval resolution and successor dispatch).
    store.decideApproval(requested.approval.id, 'owner', {
      commandId: 'recon-decision-lost',
      optionId: 'approve',
    })
    const waiting = store.listRuns(claimed.task.id)[0]
    expect(waiting?.status).toBe('cancelled')
    expect(
      store
        .listReconciliationFindings()
        .filter(finding => finding.kind === 'stale_waiting'),
    ).toEqual([])
  })

  it('StaleWaiting: a waiting Run whose approval was resolved out-of-band is flagged', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-recon-stale-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const databasePath = join(directory, 'pegas.db')
    const { store, clock } = seededStore(databasePath)
    const claimed = createClaimedTask(store, '审批已批但未唤醒')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft('recon-approval-stale'),
    )
    // Simulate the lost wake-up: the approval fact is resolved but the
    // waiting Run and its successor were never updated (partial crash).
    const database = new DatabaseSync(databasePath)
    database.exec('PRAGMA busy_timeout = 5000;')
    database
      .prepare(
        `UPDATE approvals SET status = 'approved', resolved_at = ?
         WHERE id = ?`,
      )
      .run(clock.now().toISOString(), requested.approval.id)
    database.close()
    expect(store.listRuns(claimed.task.id)[0]?.status).toBe('waiting')
    expect(
      store
        .listReconciliationFindings()
        .filter(finding => finding.kind === 'stale_waiting'),
    ).toEqual([])
    clock.advance(301_000)
    const stale = store
      .listReconciliationFindings()
      .filter(finding => finding.kind === 'stale_waiting')
    expect(stale).toHaveLength(1)
    expect(stale[0]).toMatchObject({ runId: claimed.run.id })
    expect(stale[0]?.detail).toContain('approval_resolved')
    // Recovery stays on existing paths: replaying the full decision after
    // restoring the pending fact supersedes the waiting Run and clears the
    // finding; the watchdog itself never repairs.
    const repair = new DatabaseSync(databasePath)
    repair.exec('PRAGMA busy_timeout = 5000;')
    repair
      .prepare(
        `UPDATE approvals SET status = 'pending', resolved_at = NULL
         WHERE id = ?`,
      )
      .run(requested.approval.id)
    repair.close()
    store.decideApproval(requested.approval.id, 'owner', {
      commandId: 'recon-decision-1',
      optionId: 'approve',
    })
    expect(
      store
        .listReconciliationFindings()
        .filter(finding => finding.kind === 'stale_waiting'),
    ).toEqual([])
  })

  it('StaleWaiting: a settled delegate dependency leaves the source Run flagged', async () => {
    const { store, clock } = seededStore()
    const source = createClaimedTask(store, '委派出去的任务')
    store.createCollaboration(source.run.id, source.claimToken, {
      commandId: 'recon-delegate-1',
      kind: 'delegate',
      goal: '独立子任务',
      reason: '可并行',
      expectedOutput: '子结果',
      contextRefs: [],
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
      'recon-target-router',
      undefined,
      { collectWindowMs: 0 },
    )
    const target = store.claimNextRun('target-worker')
    if (!target) throw new Error('Expected delegate target claim')
    store.completeRun(target.run.id, 'target-worker', {
      executorRef: 'session-target',
      output: '子任务完成',
    })
    const sourceRun = store.listRuns(source.task.id)[0]
    expect(sourceRun?.status).toBe('cancelled')
    clock.advance(301_000)
    expect(
      store
        .listReconciliationFindings()
        .filter(finding => finding.kind === 'stale_waiting'),
    ).toEqual([])
  })
})

describe('NOTIFY-006 watchdog boundary', () => {
  it('reports findings with durable identifiers only and never writes product state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-recon-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const databasePath = join(directory, 'pegas.db')
    const { store, clock } = seededStore(databasePath)
    const claimed = createClaimedTask(store, '机密正文不得进入日志')
    completeWithDelivery(store, claimed)
    clock.advance(301_000)

    const records: StructuredLogRecord[] = []
    const metrics = new MetricsRegistry()
    const watchdog = new DeliveryReconciliation({
      store,
      logger: createLogger({
        service: 'reconciliation',
        sink: record => records.push(record),
      }),
      metrics,
    })
    const report = watchdog.checkOnce()
    expect(report.owedCount).toBe(1)
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: 'unreported', runId: claimed.run.id }),
    ])
    const serialized = JSON.stringify(records)
    expect(serialized).toContain(claimed.run.id)
    expect(serialized).not.toContain('机密正文')
    expect(metrics.render()).toContain('pegas_reconciliation_findings_total')
    expect(metrics.render()).toContain('pegas_owed_deliveries')

    // A second process observes the same facts; the watchdog wrote nothing.
    const reader = new PegasStore(databasePath, { clock })
    cleanups.push(() => reader.close())
    expect(reader.listOwedDeliveries('owner')).toHaveLength(1)
    expect(
      reader.listOutbox('owner').every(message => message.status === 'pending'),
    ).toBe(true)
    expect(reader.listRuns(claimed.task.id)[0]?.status).toBe('completed')
  })

  it('a watchdog crash does not affect the main delivery path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-recon-crash-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const databasePath = join(directory, 'pegas.db')
    const { store, clock } = seededStore(databasePath)
    const claimed = createClaimedTask(store, '对账崩溃不影响主链路')
    completeWithDelivery(store, claimed)
    clock.advance(301_000)

    const watchdogConnection = new PegasStore(databasePath, { clock })
    const watchdog = new DeliveryReconciliation({
      store: watchdogConnection,
    })
    expect(watchdog.checkOnce().findings).toHaveLength(1)
    watchdogConnection.close()

    // Main chain keeps working after the watchdog process is gone.
    sendNotification(store, `run-completed:${claimed.run.id}`)
    expect(store.listOwedDeliveries('owner')).toEqual([])
    const next = createClaimedTask(store, '崩溃后的新任务')
    completeWithDelivery(store, next)
    sendNotification(store, `run-completed:${next.run.id}`)
    expect(store.listOwedDeliveries('owner')).toEqual([])
  })

  it('parses watchdog configuration with conservative defaults and fail-closed validation', () => {
    expect(parseReconciliationConfig({})).toEqual({
      intervalMs: 60_000,
      unreportedAfterMs: 300_000,
      neverStartedAfterMs: 300_000,
      strandedAfterMs: 120_000,
      staleWaitingAfterMs: 300_000,
      autoReconcile: true,
    })
    expect(
      parseReconciliationConfig({
        PEGAS_RECONCILE_INTERVAL_MS: '5000',
        PEGAS_RECONCILE_UNREPORTED_AFTER_MS: '1000',
      }),
    ).toMatchObject({ intervalMs: 5000, unreportedAfterMs: 1000 })
    expect(
      parseReconciliationConfig({ PEGAS_AUTO_RECONCILE: 'disabled' }),
    ).toMatchObject({ autoReconcile: false })
    expect(() =>
      parseReconciliationConfig({ PEGAS_AUTO_RECONCILE: 'maybe' }),
    ).toThrow(/PEGAS_AUTO_RECONCILE/)
    expect(() =>
      parseReconciliationConfig({ PEGAS_RECONCILE_INTERVAL_MS: '0' }),
    ).toThrow(/positive integer/)
    expect(() =>
      parseReconciliationConfig({ PEGAS_RECONCILE_INTERVAL_MS: 'soon' }),
    ).toThrow(/positive integer/)
  })

  it('serves the read-only reconciliation projection over the authenticated API', async () => {
    const { store, clock } = seededStore()
    const claimed = createClaimedTask(store, 'API 可见的欠账')
    completeWithDelivery(store, claimed)
    clock.advance(301_000)
    const server = createControlPlane({ store, apiToken: 'recon-token' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const unauthorized = await fetch(`${base}/v1/reconciliation`)
    expect(unauthorized.status).toBe(401)
    const response = await fetch(`${base}/v1/reconciliation?userId=owner`, {
      headers: { authorization: 'Bearer recon-token' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      owed: { runId: string }[]
      findings: { kind: string; runId?: string }[]
    }
    expect(body.owed.map(entry => entry.runId)).toEqual([claimed.run.id])
    expect(body.findings).toEqual([
      expect.objectContaining({ kind: 'unreported', runId: claimed.run.id }),
    ])
    // GET projection did not settle anything.
    expect(store.listOwedDeliveries('owner')).toHaveLength(1)
  })
})
