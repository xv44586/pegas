import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
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

describe('channel timeline pagination and routing facts', () => {
  it('pages events by stable cursor without losing or duplicating rows', async () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const { taskId } = await createRoutedTask(store, 'owner', '第一条输入')
    for (let index = 0; index < 6; index += 1) {
      store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: { text: `补充 ${String(index)}`, taskId },
      })
      await processNextEvent(
        store,
        new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo', () => ({
          executor: 'echo',
        })),
        `timeline-router-${String(index)}`,
      )
    }
    const all = store.listChannelEvents(taskId, 'owner')
    expect(all.length).toBe(7)

    const collected: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = store.pageChannelEvents(taskId, 'owner', 3, cursor)
      collected.push(...page.events.map(event => event.id))
      cursor = page.nextCursor
      pages += 1
      expect(page.events.length).toBeLessThanOrEqual(3)
    } while (cursor)
    expect(pages).toBe(3)
    expect(collected).toEqual(all.map(event => event.id))
    expect(new Set(collected).size).toBe(collected.length)
    expect(() =>
      store.pageChannelEvents(taskId, 'owner', 3, 'missing-cursor'),
    ).toThrow(/cursor is invalid/)
    expect(() => store.pageChannelEvents(taskId, 'owner', 0)).toThrow(
      /between 1 and 200/,
    )
    expect(() =>
      store.pageChannelEvents(taskId, 'other', 3, all[0]?.id),
    ).toThrow(/cursor is invalid/)
  })

  it('includes pending quoted replies only in the authoritative owner task', async () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const first = await createRoutedTask(store, 'owner', '第一件事情')
    const second = await createRoutedTask(store, 'owner', '另一件事情')
    const reply = store.enqueueOutbox({
      userId: 'owner',
      taskId: first.taskId,
      channel: 'conversation',
      dedupeKey: 'reply',
      payload: { type: 'agent.message', text: '可追问的回复' },
    })
    const pending = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: '引用追问', replyToMessageId: reply.id },
    }).event
    const crossOwner = store.enqueueEvent({
      userId: 'other',
      type: 'user.message',
      source: 'web',
      payload: { text: '越权引用', replyToMessageId: reply.id },
    }).event
    expect(() =>
      store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        payload: {
          text: '冲突目标',
          taskId: second.taskId,
          replyToMessageId: reply.id,
        },
      }),
    ).toThrow(/cannot be combined/)
    expect(
      store.listChannelEvents(first.taskId, 'owner').map(event => event.id),
    ).toContain(pending.id)
    expect(
      store.listChannelEvents(second.taskId, 'owner').map(event => event.id),
    ).not.toContain(pending.id)
    expect(
      store.listChannelEvents(first.taskId, 'other').map(event => event.id),
    ).not.toContain(crossOwner.id)
  })

  it('returns owner-scoped routing reasons and paginated HTTP timeline', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => store.close(),
    )
    const { taskId, eventId } = await createRoutedTask(
      store,
      'owner',
      '带路由原因的事情',
    )
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '第二条输入', taskId },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo', () => ({
        executor: 'echo',
      })),
      'http-timeline-router',
    )
    const routing = store.listChannelRoutingDecisions(taskId, 'owner')
    expect(routing[0]).toMatchObject({
      eventId,
      kind: 'create_task',
      taskId,
    })
    expect(routing[0]?.reason).toBeTruthy()
    expect(() => store.listChannelRoutingDecisions(taskId, 'other')).toThrow(
      /does not exist/,
    )

    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const response = await fetch(
      `${base}/v1/channels/${taskId}/timeline?userId=owner&limit=1`,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      events: { id: string }[]
      nextCursor?: string
      routing: { eventId: string; reason: string }[]
    }
    expect(body.events).toHaveLength(1)
    expect(body.routing[0]?.eventId).toBe(eventId)
    expect(body.nextCursor).toBe(body.events[0]?.id)
    const crossOwner = await fetch(
      `${base}/v1/channels/${taskId}/timeline?userId=other`,
    )
    expect(crossOwner.status).toBe(404)
    const badLimit = await fetch(
      `${base}/v1/channels/${taskId}/timeline?userId=owner&limit=0`,
    )
    expect(badLimit.status).toBe(400)
  })
})

async function createRoutedTask(
  store: PegasStore,
  userId: string,
  text: string,
): Promise<{ taskId: string; eventId: string }> {
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
  }).event
  await processNextEvent(
    store,
    new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo', () => ({
      executor: 'echo',
    })),
    `setup-router-${event.id}`,
  )
  const task = store.listTasks(userId)[0]
  if (!task) throw new Error('Expected routed Task')
  return { taskId: task.id, eventId: event.id }
}
