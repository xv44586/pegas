import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Clock } from '../src/core/clock.js'
import type { ActionRequestDraft } from '../src/approval/approval.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

class MutableClock implements Clock {
  #value: Date

  constructor(value: string) {
    this.#value = new Date(value)
  }

  now(): Date {
    return new Date(this.#value)
  }

  step(ms: number): void {
    this.#value = new Date(this.#value.getTime() + ms)
  }
}

function seedTask(
  store: PegasStore,
  text: string,
): { taskId: string; runId: string } {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
  }).event
  const claimedEvent = store.claimNextEvent('setup-worker')
  if (!claimedEvent) throw new Error('Expected the setup event claim')
  const applied = store.applyRoutingDecision(
    claimedEvent,
    { kind: 'create_task', title: text, goal: text, input: text, reason: 't' },
    'echo-test',
  )
  store.completeEvent(event.id, 'setup-worker')
  return { taskId: applied.task.id, runId: applied.run.id }
}

function approvalDraft(key: string): ActionRequestDraft {
  return {
    kind: 'publish.release',
    risk: 'high',
    idempotencyKey: key,
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

describe('TASK-001 Task/Run state machine', () => {
  it('rejects invalid Run statuses at the database boundary (v29)', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-state-'))
    const path = join(directory, 'pegas.sqlite')
    try {
      const store = new PegasStore(path)
      const { taskId, runId } = seedTask(store, '状态机边界')
      store.close()
      const db = new DatabaseSync(path)
      try {
        expect(() =>
          db
            .prepare('UPDATE runs SET status = ? WHERE id = ?')
            .run('paused', runId),
        ).toThrow(/Invalid run status/)
        expect(() =>
          db
            .prepare(
              `INSERT INTO runs (id, task_id, executor, status, created_at, updated_at)
               VALUES (?, ?, 'echo-test', 'sleeping', ?, ?)`,
            )
            .run('run-bogus', taskId, 'now', 'now'),
        ).toThrow(/Invalid run status/)
        expect(() =>
          db
            .prepare('UPDATE tasks SET status = ? WHERE id = ?')
            .run('waiting', taskId),
        ).toThrow(/Invalid task status/)
      } finally {
        db.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('walks the full success path: queued → running → completed', () => {
    const store = new PegasStore(':memory:')
    const { taskId, runId } = seedTask(store, '一次成功交付')
    expect(store.findTask(taskId, 'owner')?.status).toBe('unstarted')
    expect(store.listRuns(taskId)[0]).toMatchObject({
      id: runId,
      status: 'queued',
    })

    const claimed = store.claimNextRun('worker-1')
    if (!claimed) throw new Error('Expected the Run claim')
    expect(claimed.run.status).toBe('running')
    expect(store.findTask(taskId, 'owner')?.status).toBe('started')

    store.completeRun(runId, 'worker-1', {
      executorRef: 'session-1',
      output: '完成',
    })
    expect(store.listRuns(taskId)[0]).toMatchObject({
      status: 'completed',
    })
    expect(store.listRuns(taskId)[0]?.claimedBy).toBeUndefined()
    expect(store.findTask(taskId, 'owner')?.status).toBe('completed')

    // Terminal Runs reject every late writer.
    expect(() =>
      store.completeRun(runId, 'worker-1', {
        executorRef: 'session-1',
        output: 'again',
      }),
    ).toThrow(/does not own/)
    expect(() => store.failRun(runId, 'worker-1', 'late failure')).toThrow(
      /does not own/,
    )
    expect(() => store.retryRun(runId, 'owner')).toThrow(/Task is closed/)
    store.close()
  })

  it('walks failure → retry → completion and keeps retry idempotent', () => {
    const store = new PegasStore(':memory:')
    const { taskId, runId } = seedTask(store, '失败后重试')
    store.claimNextRun('worker-1')
    store.failRun(runId, 'worker-1', 'executor crashed')
    expect(store.listRuns(taskId)[0]).toMatchObject({
      status: 'failed',
      lastError: 'executor crashed',
    })
    expect(store.findTask(taskId, 'owner')?.status).toBe('started')

    const retry = store.retryRun(runId, 'owner')
    expect(retry).toMatchObject({ status: 'queued', retryOfRunId: runId })
    expect(store.retryRun(runId, 'owner').id).toBe(retry.id)
    expect(() => store.retryRun(retry.id, 'owner')).toThrow(
      /Only failed runs can be retried/,
    )

    const claimed = store.claimNextRun('worker-2')
    if (!claimed) throw new Error('Expected the retry claim')
    expect(claimed.run.id).toBe(retry.id)
    store.completeRun(retry.id, 'worker-2', {
      executorRef: 'session-2',
      output: '重试成功',
    })
    const runs = store.listRuns(taskId)
    expect(runs.map(run => run.status)).toEqual(['failed', 'completed'])
    expect(store.findTask(taskId, 'owner')?.status).toBe('completed')
    store.close()
  })

  it('recovers an expired running Run as failed + linked retry', () => {
    const clock = new MutableClock('2026-11-21T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    const { taskId, runId } = seedTask(store, 'lease 过期恢复')
    store.claimNextRun('worker-1')
    clock.step(31_000)
    const claimed = store.claimNextRun('worker-2')
    if (!claimed) throw new Error('Expected the recovery claim')
    expect(claimed.run.retryOfRunId).toBe(runId)
    const runs = store.listRuns(taskId)
    expect(runs[0]).toMatchObject({
      status: 'failed',
      lastError: 'lease_expired',
    })
    expect(runs[1]).toMatchObject({ id: claimed.run.id, status: 'running' })
    // The stale worker can no longer write the old Run back.
    expect(() =>
      store.completeRun(runId, 'worker-1', { executorRef: 's', output: 'x' }),
    ).toThrow(/does not own/)
    store.close()
  })

  it('parks the Run for approval and resumes through a successor', () => {
    const store = new PegasStore(':memory:')
    const { taskId, runId } = seedTask(store, '高风险发布')
    const claimed = store.claimNextRun('worker-1')
    if (!claimed) throw new Error('Expected the Run claim')
    const { approval } = store.requestApproval(
      runId,
      claimed.claimToken,
      approvalDraft('publish-1'),
    )
    expect(store.listRuns(taskId)[0]?.status).toBe('waiting')
    expect(store.findTask(taskId, 'owner')?.status).toBe('started')

    const decided = store.decideApproval(approval.id, 'owner', {
      commandId: 'decision-1',
      optionId: 'approve',
    })
    const applied = store.applyApprovalDecision(decided.event)
    if (!applied) throw new Error('Expected an approval successor Run')
    expect(applied).toMatchObject({ status: 'queued' })
    const runs = store.listRuns(taskId)
    expect(runs[0]).toMatchObject({
      status: 'cancelled',
      lastError: 'superseded_by_approval_decision',
    })
    const successor = store.claimNextRun('worker-2')
    if (!successor) throw new Error('Expected the successor claim')
    expect(successor.run.id).toBe(applied.id)
    store.close()
  })

  it('steers a running Run into a cancelled attempt plus queued successor', () => {
    const store = new PegasStore(':memory:')
    const { taskId, runId } = seedTask(store, '执行中纠正')
    store.claimNextRun('worker-1')
    const correction = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '只分析最近一个月' },
    }).event
    const claimedCorrection = store.claimNextEvent('router-2')
    if (!claimedCorrection) throw new Error('Expected the correction claim')
    store.applyControlIntent(claimedCorrection, {
      kind: 'steer_task',
      taskId,
      input: '只分析最近一个月',
      reason: '用户纠正',
    })
    store.completeEvent(correction.id, 'router-2')
    const successor = store.supersedeRunForSteering(runId, 'worker-1')
    expect(successor).toMatchObject({
      status: 'queued',
      steeringOfRunId: runId,
    })
    const runs = store.listRuns(taskId)
    expect(runs[0]).toMatchObject({
      status: 'cancelled',
      lastError: `superseded_by_steering:${successor.id}`,
    })
    expect(runs[1]?.input).toContain('只分析最近一个月')
    store.close()
  })

  it('cancels every non-terminal Run when the user stops the Task', () => {
    const store = new PegasStore(':memory:')
    const { taskId, runId } = seedTask(store, '用户停止')
    store.claimNextRun('worker-1')
    const stopped = store.stopTask(taskId, 'owner', 'stop-1', '不做了')
    expect(stopped.status).toBe('cancelled')
    expect(store.listRuns(taskId)[0]?.status).toBe('cancelled')
    expect(store.claimNextRun('worker-2')).toBeUndefined()
    expect(() =>
      store.completeRun(runId, 'worker-1', { executorRef: 's', output: 'x' }),
    ).toThrow(/does not own/)
    expect(() => store.retryRun(runId, 'owner')).toThrow(/Task is closed/)
    // Stopping twice is idempotent and never rewrites the ended record.
    expect(store.stopTask(taskId, 'owner', 'stop-2').status).toBe('cancelled')
    store.close()
  })

  it('resumes a completed Task only through a mandate revalidated input', () => {
    const store = new PegasStore(':memory:')
    const { taskId, runId } = seedTask(store, '完成后继续')
    store.claimNextRun('worker-1')
    store.completeRun(runId, 'worker-1', { executorRef: 's', output: 'done' })
    expect(store.findTask(taskId, 'owner')?.status).toBe('completed')

    const followUp = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '在刚才结果上再补一段', taskId },
    }).event
    const claimed = store.claimNextEvent('router-2')
    if (!claimed) throw new Error('Expected the follow-up claim')
    const applied = store.applyRoutingDecision(
      claimed,
      {
        kind: 'continue_task',
        taskId,
        input: '在刚才结果上再补一段',
        reason: '显式引用',
      },
      'echo-test',
    )
    store.completeEvent(followUp.id, 'router-2')
    expect(applied.run.status).toBe('queued')
    expect(store.findTask(taskId, 'owner')?.status).not.toBe('completed')
    const runs = store.listRuns(taskId)
    expect(runs.map(run => run.status)).toEqual(['completed', 'queued'])
    store.close()
  })
})
