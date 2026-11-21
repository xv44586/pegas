import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { InboxEvent, Task } from '../src/core/domain.js'
import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../src/executor/executor.js'
import type { JsonModelProvider } from '../src/model/provider.js'
import { ModelTaskRouter, RuleBasedTaskRouter } from '../src/router/router.js'
import {
  PegasStore,
  TaskActionBlockedError,
} from '../src/storage/sqlite-store.js'
import {
  assertRollbackCompatible,
  RollbackCompatibilityError,
} from '../src/supervisor/rollback-compatibility.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

describe('ROUTE-001 model control intents', () => {
  it('accepts steer and cancel decisions only for listed candidate tasks', async () => {
    const steerRouter = new ModelTaskRouter({
      provider: new StubProvider({
        kind: 'steer_task',
        taskId: 'task-active',
        reason: 'The user narrows the running work.',
      }),
    })
    const decision = await steerRouter.route(
      message('先别管排版，把数据整理对'),
      [task('task-active', '整理数据', 'started')],
    )
    expect(decision).toEqual({
      kind: 'steer_task',
      taskId: 'task-active',
      input: '先别管排版，把数据整理对',
      reason: 'The user narrows the running work.',
    })

    const cancelRouter = new ModelTaskRouter({
      provider: new StubProvider({
        kind: 'cancel_task',
        taskId: 'task-active',
        reason: 'The user explicitly stops the work.',
      }),
    })
    expect(
      await cancelRouter.route(message('这件事不用做了，停掉'), [
        task('task-active', '整理数据', 'started'),
      ]),
    ).toEqual({
      kind: 'cancel_task',
      taskId: 'task-active',
      reason: 'The user explicitly stops the work.',
    })
  })

  it('falls back to a new task for invalid control targets', async () => {
    for (const answer of [
      { kind: 'steer_task', taskId: 'invented', reason: 'guess' },
      { kind: 'steer_task', taskId: 'task-idle', reason: 'not running' },
      { kind: 'cancel_task', taskId: 'invented', reason: 'guess' },
    ]) {
      const router = new ModelTaskRouter({
        provider: new StubProvider(answer),
      })
      const decision = await router.route(message('调整一下方向'), [
        task('task-idle', '尚未开始', 'unstarted'),
        task('task-active', '进行中', 'started'),
      ])
      expect(decision).toMatchObject({ kind: 'create_task' })
    }
  })

  it('keeps explicit taskId continuation deterministic without the model', async () => {
    const provider = new StubProvider({
      kind: 'cancel_task',
      taskId: 'task-active',
      reason: 'should never be consulted',
    })
    const router = new ModelTaskRouter({ provider })
    const decision = await router.route(
      message('补充一个要求', { taskId: 'task-active' }),
      [task('task-active', '进行中', 'started')],
    )
    expect(decision).toMatchObject({ kind: 'continue_task' })
    expect(provider.calls).toBe(0)
  })
})

describe('ROUTE-001 durable control application', () => {
  it('merges steering into a queued Run input and replays idempotently', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, '整理季度数据')
    const correction = humanEvent(store, '先只做华东区的数据')
    const decision = {
      kind: 'steer_task' as const,
      taskId: seeded.taskId,
      input: '先只做华东区的数据',
      reason: 'The user narrows queued work.',
    }
    const applied = store.applyControlIntent(correction, decision)
    expect(applied.task.id).toBe(seeded.taskId)
    const runs = store.listRuns(seeded.taskId)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.input).toContain('整理季度数据')
    expect(runs[0]?.input).toContain('[用户纠正]')
    expect(runs[0]?.input).toContain('先只做华东区的数据')

    const replay = store.applyControlIntent(correction, decision)
    expect(replay.task.id).toBe(seeded.taskId)
    expect(store.listRuns(seeded.taskId)).toHaveLength(1)
    expect(store.listRuns(seeded.taskId)[0]?.input).toBe(runs[0]?.input)

    expect(() =>
      store.applyControlIntent(correction, {
        kind: 'cancel_task',
        taskId: seeded.taskId,
        reason: 'conflicting replay',
      }),
    ).toThrow(/different decision/)

    const routing = store.listChannelRoutingDecisions(seeded.taskId, 'owner')
    expect(routing.at(-1)).toMatchObject({
      eventId: correction.id,
      kind: 'steer_task',
    })
    expect(
      store.listChannelEvents(seeded.taskId, 'owner').map(event => event.id),
    ).toContain(correction.id)
    store.close()
  })

  it('parks steering on a running Run and supersedes it with a session-resuming successor', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, '生成周报')
    const claimed = store.claimNextRun('worker-steer')
    if (!claimed) throw new Error('Expected claimed Run')
    store.recordExecutorRef(claimed.run.id, 'worker-steer', 'session-weekly')

    const correction = humanEvent(store, '改成双周报，覆盖上上周')
    store.applyControlIntent(correction, {
      kind: 'steer_task',
      taskId: seeded.taskId,
      input: '改成双周报，覆盖上上周',
      reason: 'The user redirects running work.',
    })
    expect(store.listRuns(seeded.taskId)).toHaveLength(1)
    expect(
      store.renewRunLeaseAndCheckSteering(claimed.run.id, 'worker-steer'),
    ).toBe(true)
    expect(
      store.listPendingRunSteering(claimed.run.id, 'worker-steer'),
    ).toMatchObject([
      { eventId: correction.id, text: '改成双周报，覆盖上上周' },
    ])

    // A stale completion cannot silently drop the correction.
    expect(() =>
      store.completeRun(claimed.run.id, 'worker-steer', {
        executorRef: 'session-weekly',
        output: '旧方向的周报',
      }),
    ).toThrow(/pending steering/)

    const successor = store.supersedeRunForSteering(
      claimed.run.id,
      'worker-steer',
    )
    expect(successor).toMatchObject({
      status: 'queued',
      steeringOfRunId: claimed.run.id,
      resumeFromRef: 'session-weekly',
    })
    expect(successor.input).toContain('生成周报')
    expect(successor.input).toContain('改成双周报，覆盖上上周')
    const parked = store
      .listRuns(seeded.taskId)
      .find(run => run.id === claimed.run.id)
    expect(parked).toMatchObject({
      status: 'cancelled',
      lastError: `superseded_by_steering:${successor.id}`,
    })
    // Replaying the supersede returns the same successor.
    expect(() =>
      store.supersedeRunForSteering(claimed.run.id, 'worker-steer'),
    ).toThrow(/does not own/)
    const next = store.claimNextRun('worker-steer-2')
    expect(next?.run.id).toBe(successor.id)
    expect(next?.run.resumeFromRef).toBe('session-weekly')
    store.close()
  })

  it('rejects steering without an active Run, across owners, and from machine input', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, '等待中的工作')
    const claimed = store.claimNextRun('worker-guard')
    if (!claimed) throw new Error('Expected claimed Run')
    store.failRun(claimed.run.id, 'worker-guard', 'transient failure')
    expect(() =>
      store.applyControlIntent(humanEvent(store, '换个方向'), {
        kind: 'steer_task',
        taskId: seeded.taskId,
        input: '换个方向',
        reason: 'no active run',
      }),
    ).toThrow(/queued or running Run/)

    const other = seedTask(store, '另一件事')
    const foreign = store.enqueueEvent({
      userId: 'intruder',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '停掉它' },
    }).event
    expect(() =>
      store.applyControlIntent(foreign, {
        kind: 'cancel_task',
        taskId: other.taskId,
        reason: 'cross owner',
      }),
    ).toThrow(/another user/)

    const machine = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'automation',
      payload: { text: '停掉它' },
    }).event
    expect(() =>
      store.applyControlIntent(machine, {
        kind: 'cancel_task',
        taskId: other.taskId,
        reason: 'machine',
      }),
    ).toThrow(/authenticated human/)
    store.close()
  })

  it('parks steering behind a blocking Action instead of bypassing it', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, '发布新版本')
    const claimed = store.claimNextRun('worker-approval')
    if (!claimed) throw new Error('Expected claimed Run')
    store.requestApproval(claimed.run.id, claimed.claimToken, {
      kind: 'publish.release',
      risk: 'high',
      idempotencyKey: 'steer-blocked-release',
      request: { release: 'v9' },
      recoveryPoint: { step: 'before_publish' },
      approval: {
        summary: '发布 v9',
        impact: '对外可见',
        recommendedOptionId: 'approve',
        options: [
          { id: 'approve', label: '发布', kind: 'approve' },
          { id: 'reject', label: '不发布', kind: 'reject' },
        ],
      },
    })
    expect(() =>
      store.applyControlIntent(humanEvent(store, '等等，先改发布说明'), {
        kind: 'steer_task',
        taskId: seeded.taskId,
        input: '等等，先改发布说明',
        reason: 'blocked by approval',
      }),
    ).toThrow(TaskActionBlockedError)
    store.close()
  })

  it('cancel_task stops the Task with the full human-stop semantics', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, '不再需要的工作')
    const claimed = store.claimNextRun('worker-cancel')
    if (!claimed) throw new Error('Expected claimed Run')
    store.requestApproval(claimed.run.id, claimed.claimToken, {
      kind: 'send.email',
      risk: 'high',
      idempotencyKey: 'cancel-pending-approval',
      request: { to: 'someone' },
      recoveryPoint: { step: 'before_send' },
      approval: {
        summary: '发送邮件',
        impact: '外部可见',
        recommendedOptionId: 'approve',
        options: [
          { id: 'approve', label: '发送', kind: 'approve' },
          { id: 'reject', label: '不发送', kind: 'reject' },
        ],
      },
    })

    const stopEvent = humanEvent(store, '这件事取消，不要做了')
    const applied = store.applyControlIntent(stopEvent, {
      kind: 'cancel_task',
      taskId: seeded.taskId,
      reason: '用户明确要求取消',
    })
    expect(applied.task).toMatchObject({
      status: 'cancelled',
      statusReason: 'stopped_by_user',
    })
    expect(applied.task.ended).toMatchObject({
      by: 'human',
      outcome: 'stopped',
      reason: '用户明确要求取消',
    })
    expect(store.listRuns(seeded.taskId)[0]).toMatchObject({
      status: 'cancelled',
      lastError: 'stopped_by_user',
    })
    expect(
      store.listOutbox('owner', seeded.taskId).map(m => m.dedupeKey),
    ).toContainEqual(expect.stringContaining('approval-resolved:'))
    expect(store.claimNextRun('worker-after-cancel')).toBeUndefined()

    // Replayed stop decision is idempotent; a stopped Task stays stopped.
    const replay = store.applyControlIntent(stopEvent, {
      kind: 'cancel_task',
      taskId: seeded.taskId,
      reason: '用户明确要求取消',
    })
    expect(replay.task.status).toBe('cancelled')
    expect(() =>
      store.applyRoutingDecision(
        humanEvent(store, '继续做'),
        {
          kind: 'continue_task',
          taskId: seeded.taskId,
          input: '继续做',
          reason: 'cannot resume stopped',
        },
        'echo',
      ),
    ).toThrow(/stopped by the user/)
    store.close()
  })

  it('rejects cancel for completed Tasks and steering for ended Tasks', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, '已完成的工作')
    const claimed = store.claimNextRun('worker-ended')
    if (!claimed) throw new Error('Expected claimed Run')
    store.completeRun(claimed.run.id, 'worker-ended', {
      executorRef: 'session-ended',
      output: '完成',
    })
    expect(store.findTask(seeded.taskId, 'owner')?.status).toBe('completed')
    expect(() =>
      store.applyControlIntent(humanEvent(store, '取消它'), {
        kind: 'cancel_task',
        taskId: seeded.taskId,
        reason: 'ended',
      }),
    ).toThrow(/already ended/)
    expect(() =>
      store.applyControlIntent(humanEvent(store, '换个方向'), {
        kind: 'steer_task',
        taskId: seeded.taskId,
        input: '换个方向',
        reason: 'ended',
      }),
    ).toThrow(/resume through continuation/)
    store.close()
  })
})

describe('ROUTE-001 worker steering loop', () => {
  it('aborts the Executor on heartbeat steering and queues a corrected successor', async () => {
    vi.useFakeTimers()
    try {
      const store = new PegasStore(':memory:')
      const seeded = seedTask(store, '长时间运行的分析')
      const claimed = store.claimNextRun('worker-loop')
      if (!claimed) throw new Error('Expected claimed Run')
      const executor = new HangingExecutor()
      const execution = executeClaimedRun(
        store,
        executor,
        claimed,
        'worker-loop',
        process.cwd(),
        new AbortController().signal,
        'http://127.0.0.1:4317',
      )
      await vi.advanceTimersByTimeAsync(0)
      store.recordExecutorRef(claimed.run.id, 'worker-loop', 'session-long')
      store.applyControlIntent(humanEvent(store, '只分析最近一个月'), {
        kind: 'steer_task',
        taskId: seeded.taskId,
        input: '只分析最近一个月',
        reason: 'redirect during execution',
      })
      await vi.advanceTimersByTimeAsync(10_000)
      await execution

      const runs = store.listRuns(seeded.taskId)
      expect(runs).toHaveLength(2)
      expect(runs[0]).toMatchObject({
        status: 'cancelled',
        lastError: `superseded_by_steering:${runs[1]?.id ?? ''}`,
      })
      expect(runs[1]).toMatchObject({
        status: 'queued',
        steeringOfRunId: claimed.run.id,
        resumeFromRef: 'session-long',
      })
      expect(runs[1]?.input).toContain('只分析最近一个月')
      store.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes a natural-language stop through the model router end to end', async () => {
    const store = new PegasStore(':memory:')
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '帮我持续关注机票价格' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo'),
      'worker-nl-seed',
    )
    const seededTask = store.listTasks('owner')[0]
    if (!seededTask) throw new Error('Expected seeded Task')
    const router = new ModelTaskRouter({
      provider: new StubProvider({
        kind: 'cancel_task',
        taskId: seededTask.id,
        reason: 'The user asks to stop watching fares.',
      }),
    })
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '机票不用盯了，停掉吧' },
    })
    const handled = await processNextEvent(
      store,
      new RoutingEventHandler(router, 'echo'),
      'worker-nl-stop',
    )
    expect(handled).toBe(true)
    expect(store.findTask(seededTask.id, 'owner')).toMatchObject({
      status: 'cancelled',
    })
    expect(store.listRuns(seededTask.id)[0]?.status).toBe('cancelled')
    store.close()
  })
})

describe('ROUTE-001 rollback compatibility', () => {
  it('blocks rollback below v24 while steering is unconsumed and allows it after', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-steer-rollback-'))
    const path = join(directory, 'pegas.sqlite')
    try {
      const store = new PegasStore(path)
      const seeded = seedTask(store, '回滚验证')
      const claimed = store.claimNextRun('worker-rollback')
      if (!claimed) throw new Error('Expected claimed Run')
      store.applyControlIntent(humanEvent(store, '换个口径'), {
        kind: 'steer_task',
        taskId: seeded.taskId,
        input: '换个口径',
        reason: 'rollback guard',
      })
      store.close()
      expect(() => assertRollbackCompatible(path, 23)).toThrow(
        RollbackCompatibilityError,
      )

      const reopened = new PegasStore(path)
      reopened.supersedeRunForSteering(claimed.run.id, 'worker-rollback')
      reopened.close()
      expect(() => assertRollbackCompatible(path, 23)).not.toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

class StubProvider implements JsonModelProvider {
  readonly name = 'stub'
  calls = 0
  readonly #answer: unknown

  constructor(answer: unknown) {
    this.#answer = answer
  }

  generateJson(): Promise<unknown> {
    this.calls += 1
    return Promise.resolve(this.#answer)
  }
}

class HangingExecutor implements RunExecutor {
  readonly name = 'hanging-test'

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    return new Promise((_, reject) => {
      input.signal?.addEventListener(
        'abort',
        () => reject(new Error('executor aborted for steering')),
        { once: true },
      )
    })
  }
}

function seedTask(
  store: PegasStore,
  text: string,
): { eventId: string; taskId: string; runId: string } {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
  }).event
  const created = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: text,
      goal: text,
      input: text,
      reason: 'ROUTE-001 control intent test',
    },
    'echo',
  )
  return { eventId: event.id, taskId: created.task.id, runId: created.run.id }
}

function humanEvent(store: PegasStore, text: string): InboxEvent {
  return store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
  }).event
}

function message(
  text: string,
  extra: Record<string, unknown> = {},
): InboxEvent {
  return {
    id: 'event-control',
    userId: 'user-1',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text, ...extra },
    status: 'pending',
    attempts: 0,
    createdAt: '2026-11-21T00:00:00.000Z',
  }
}

function task(
  id: string,
  title: string,
  status: Task['status'] = 'started',
): Task {
  return {
    id,
    userId: 'user-1',
    originEventId: 'origin-1',
    title,
    goal: title,
    status,
    workerIconId: 'computer',
    mandate: {
      strength: 'explicit',
      policyVersion: 'pegas-mandate-v1',
      basis: {
        source: 'web',
        scope: { conversation: 'user-1' },
        via: 'router',
      },
      actor: { source: 'web', id: 'user-1' },
      scope: title,
    },
    createdAt: '2026-11-21T00:00:00.000Z',
    updatedAt: '2026-11-21T00:00:00.000Z',
  }
}
