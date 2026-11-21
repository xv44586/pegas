import { describe, expect, it, vi } from 'vitest'

import type { Clock } from '../src/core/clock.js'
import type { InboxEvent } from '../src/core/domain.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import { EventClaimError, PegasStore } from '../src/storage/sqlite-store.js'
import {
  processNextEvent,
  RoutingEventHandler,
  type EventHandler,
} from '../src/worker/processor.js'

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

function enqueueUserMessage(store: PegasStore, text: string): InboxEvent {
  return store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
  }).event
}

function seedRunningTask(store: PegasStore): { taskId: string } {
  enqueueUserMessage(store, '整理季度数据')
  const routed = processNextEventSync(store, 'worker-seed')
  if (!routed) throw new Error('Expected the seed event to route')
  const task = store.listTasks('owner')[0]
  if (!task) throw new Error('Expected the seeded Task')
  const claimed = store.claimNextRun('worker-seed')
  if (!claimed) throw new Error('Expected the seeded Run claim')
  return { taskId: task.id }
}

function processNextEventSync(store: PegasStore, workerId: string): boolean {
  const event = store.claimNextEvent(workerId)
  if (!event) return false
  store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: '整理季度数据',
      goal: '整理季度数据',
      input: '整理季度数据',
      reason: 'test seed',
    },
    'echo-test',
  )
  store.completeEvent(event.id, workerId)
  return true
}

describe('ROUTE-002 router lease and fencing', () => {
  it('renews the event lease while routing is still in flight', async () => {
    const clock = new MutableClock('2026-11-21T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    enqueueUserMessage(store, '帮我订下周去上海的机票')
    const renewSpy = vi.spyOn(store, 'renewEventLease')
    let handlerEntered = false
    let releaseRouter: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      releaseRouter = resolve
    })
    const handler: EventHandler = {
      async handle(event, target) {
        handlerEntered = true
        await gate
        target.applyRoutingDecision(
          event,
          {
            kind: 'create_task',
            title: '订机票',
            goal: '订下周去上海的机票',
            input: '帮我订下周去上海的机票',
            reason: 'slow router finished',
          },
          'echo-test',
        )
      },
    }

    vi.useFakeTimers()
    try {
      let settled = false
      const processing = processNextEvent(store, handler, 'worker-slow').then(
        result => {
          settled = true
          return result
        },
      )
      await vi.waitFor(() => {
        expect(handlerEntered).toBe(true)
      })
      await vi.advanceTimersByTimeAsync(10_000)
      clock.step(25_000)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(renewSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
      // The original 30s lease would have expired without renewal; the
      // takeover worker must not be able to claim the event mid-flight.
      expect(store.claimNextEvent('worker-b')).toBeUndefined()
      expect(settled).toBe(false)
      releaseRouter?.()
      expect(await processing).toBe(true)
    } finally {
      vi.useRealTimers()
    }

    const events = store.listEvents('owner')
    expect(events).toHaveLength(1)
    expect(events[0]?.status).toBe('processed')
    expect(store.listTasks('owner')).toHaveLength(1)
    store.close()
  })

  it('fences routing writes from a worker whose event lease expired', () => {
    const clock = new MutableClock('2026-11-21T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    enqueueUserMessage(store, '写一份周报')
    const staleClaim = store.claimNextEvent('worker-a')
    if (!staleClaim) throw new Error('Expected the first claim')
    clock.step(31_000)
    const takeover = store.claimNextEvent('worker-b')
    if (!takeover) throw new Error('Expected the takeover claim')

    expect(() =>
      store.applyRoutingDecision(
        staleClaim,
        {
          kind: 'create_task',
          title: 'stale',
          goal: 'stale',
          input: 'stale',
          reason: 'stale worker',
        },
        'echo-test',
      ),
    ).toThrow(EventClaimError)
    expect(store.listTasks('owner')).toHaveLength(0)

    store.applyRoutingDecision(
      takeover,
      {
        kind: 'create_task',
        title: '周报',
        goal: '写一份周报',
        input: '写一份周报',
        reason: 'takeover worker',
      },
      'echo-test',
    )
    store.completeEvent(takeover.id, 'worker-b')
    expect(store.listTasks('owner')).toHaveLength(1)
    expect(() => store.completeEvent(staleClaim.id, 'worker-a')).toThrow(
      EventClaimError,
    )
    store.close()
  })

  it('keeps the takeover outcome when the stale worker writes back late', async () => {
    const clock = new MutableClock('2026-11-21T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    enqueueUserMessage(store, '预约周五的会议室')
    const staleClaim = store.claimNextEvent('worker-a')
    if (!staleClaim) throw new Error('Expected the first claim')
    clock.step(31_000)

    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    try {
      const handled = await processNextEvent(
        store,
        new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
        'worker-b',
      )
      expect(handled).toBe(true)
      // The stale worker resumes after the takeover already committed.
      expect(() =>
        store.applyRoutingDecision(
          staleClaim,
          {
            kind: 'create_task',
            title: 'stale duplicate',
            goal: 'stale duplicate',
            input: 'stale duplicate',
            reason: 'stale worker',
          },
          'echo-test',
        ),
      ).toThrow(EventClaimError)
      expect(() => store.completeEvent(staleClaim.id, 'worker-a')).toThrow(
        EventClaimError,
      )
    } finally {
      consoleError.mockRestore()
    }

    expect(store.listTasks('owner')).toHaveLength(1)
    const events = store.listEvents('owner')
    expect(events).toHaveLength(1)
    expect(events[0]?.status).toBe('processed')
    store.close()
  })

  it('fences control intents and approval writes with the same event claim', () => {
    const clock = new MutableClock('2026-11-21T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    const { taskId } = seedRunningTask(store)
    enqueueUserMessage(store, '这件事不用做了，停掉')
    const staleClaim = store.claimNextEvent('worker-a')
    if (!staleClaim) throw new Error('Expected the control event claim')
    clock.step(31_000)
    const takeover = store.claimNextEvent('worker-b')
    if (!takeover) throw new Error('Expected the takeover claim')

    expect(() =>
      store.applyControlIntent(staleClaim, {
        kind: 'cancel_task',
        taskId,
        reason: 'stale worker cancel',
      }),
    ).toThrow(EventClaimError)
    expect(store.findTask(taskId, 'owner')?.status).not.toBe('cancelled')

    store.applyControlIntent(takeover, {
      kind: 'cancel_task',
      taskId,
      reason: '用户明确停止',
    })
    store.completeEvent(takeover.id, 'worker-b')
    expect(store.findTask(taskId, 'owner')?.status).toBe('cancelled')
    expect(() => store.renewEventLease(staleClaim.id, 'worker-a')).toThrow(
      EventClaimError,
    )
    store.close()
  })

  it('fences approval.decided write-back after a lease takeover', () => {
    const clock = new MutableClock('2026-11-21T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    const approvalEvent = store.enqueueEvent({
      userId: 'owner',
      type: 'approval.decided',
      source: 'approval',
      payload: {},
    }).event
    const staleClaim = store.claimNextEvent('worker-a')
    if (!staleClaim) throw new Error('Expected the approval event claim')
    clock.step(31_000)
    store.claimNextEvent('worker-b')

    expect(() => store.applyApprovalDecision(staleClaim)).toThrow(
      EventClaimError,
    )
    expect(approvalEvent.type).toBe('approval.decided')
    store.close()
  })

  it('rejects lease renewal and write-back for unclaimed or foreign events', () => {
    const store = new PegasStore(':memory:')
    const event = enqueueUserMessage(store, '任意输入')
    expect(() => store.renewEventLease(event.id, 'worker-a')).toThrow(
      EventClaimError,
    )
    store.claimNextEvent('worker-a')
    expect(() => store.renewEventLease(event.id, 'worker-b')).toThrow(
      EventClaimError,
    )
    expect(() => store.completeEvent(event.id, 'worker-b')).toThrow(
      EventClaimError,
    )
    expect(() => store.failEvent(event.id, 'worker-b', 'not mine')).toThrow(
      EventClaimError,
    )
    store.renewEventLease(event.id, 'worker-a')
    store.completeEvent(event.id, 'worker-a')
    expect(() => store.renewEventLease(event.id, 'worker-a')).toThrow(
      EventClaimError,
    )
    store.close()
  })
})
