import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type { InboxEvent } from '../src/core/domain.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import { RoutingEventHandler } from '../src/worker/processor.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('DESIGN-003 explicit steer intent', () => {
  it('routes an explicit steer payload deterministically without the model', async () => {
    const router = new RuleBasedTaskRouter()
    const decision = await router.route(
      message('先只做华东区', { taskId: 'task-1', intent: 'steer' }),
      [task('task-1', '整理数据', 'started')],
    )
    expect(decision).toEqual({
      kind: 'steer_task',
      taskId: 'task-1',
      input: '先只做华东区',
      reason: 'The user explicitly asked to steer the running task.',
    })
  })

  it('rejects steer intent without an explicit taskId or with unknown intent', () => {
    const router = new RuleBasedTaskRouter()
    expect(() =>
      router.route(message('纠正一下', { intent: 'steer' }), []),
    ).toThrow(/requires an explicit taskId/)
    expect(() =>
      router.route(message('你好', { intent: 'cancel' }), []),
    ).toThrow(/intent must be "steer"/)
  })

  it('applies explicit steering through the worker handler and replays idempotently', async () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => Promise.resolve(store.close()))
    const seeded = seedTask(store, '生成周报')
    const claimed = store.claimNextRun('worker-1')
    expect(claimed?.run.id).toBe(seeded.runId)
    const originClaim = store.claimNextEvent('worker-1')
    expect(originClaim?.id).toBe(seeded.eventId)
    store.completeEvent(seeded.eventId, 'worker-1')
    const steerEvent = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '改成月报', taskId: seeded.taskId, intent: 'steer' },
    }).event
    const handler = new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo')
    const claimedEvent = store.claimNextEvent('worker-1')
    expect(claimedEvent?.id).toBe(steerEvent.id)
    if (!claimedEvent) throw new Error('steer event was not claimed')
    await handler.handle(claimedEvent, store)
    store.completeEvent(steerEvent.id, 'worker-1')
    const runs = store.listRuns(seeded.taskId)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('running')
    const directives = store.listPendingRunSteering(seeded.runId, 'worker-1')
    expect(directives.map(directive => directive.text)).toContain('改成月报')
    const replay = store.applyControlIntent(steerEvent, {
      kind: 'steer_task',
      taskId: seeded.taskId,
      input: '改成月报',
      reason: 'replay',
    })
    expect(replay.task.id).toBe(seeded.taskId)
    expect(store.listRuns(seeded.taskId)).toHaveLength(1)
  })

  it('rejects steer submission over HTTP when the task is not started or has no active Run', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store, apiToken: 'secret' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    })
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const seeded = seedTask(store, '整理数据')
    const claimedSeed = store.claimNextRun('worker-1')
    expect(claimedSeed?.run.id).toBe(seeded.runId)
    store.completeRun(seeded.runId, 'worker-1', {
      executorRef: 'session-seed',
      output: 'done',
    })
    expect(store.findTask(seeded.taskId, 'owner')?.status).toBe('completed')
    const rejected = await postEvent(baseUrl, {
      text: '再补一列',
      taskId: seeded.taskId,
      intent: 'steer',
    })
    expect(rejected.status).toBe(400)
    expect((rejected.body as { message: string }).message).toMatch(
      /started task/,
    )

    const open = seedTask(store, '另一件事')
    const claimedOpen = store.claimNextRun('worker-1')
    expect(claimedOpen?.run.id).toBe(open.runId)
    store.failRun(open.runId, 'worker-1', 'executor crashed')
    const noActive = await postEvent(baseUrl, {
      text: '换个方向',
      taskId: open.taskId,
      intent: 'steer',
    })
    expect(noActive.status).toBe(400)
    expect((noActive.body as { message: string }).message).toMatch(
      /queued or running Run/,
    )

    const accepted = await postEvent(baseUrl, {
      text: '继续补充',
      taskId: open.taskId,
    })
    expect(accepted.status).toBe(202)
  })
})

describe('DESIGN-003 failed user message retry', () => {
  it('resets only failed user messages to pending and stays idempotent', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => Promise.resolve(store.close()))
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '会失败的消息' },
    }).event
    const claimed = store.claimNextEvent('worker-1')
    expect(claimed?.id).toBe(event.id)
    store.failEvent(event.id, 'worker-1', 'router unavailable', 1)
    expect(
      store.listEvents('owner').find(item => item.id === event.id)?.status,
    ).toBe('failed')
    const retried = store.retryEvent(event.id, 'owner')
    expect(retried.status).toBe('pending')
    expect(retried.attempts).toBe(0)
    const again = store.retryEvent(event.id, 'owner')
    expect(again.status).toBe('pending')
    const reclaimed = store.claimNextEvent('worker-2')
    expect(reclaimed?.id).toBe(event.id)
    store.completeEvent(event.id, 'worker-2')
    const processed = store.retryEvent(event.id, 'owner')
    expect(processed.status).toBe('processed')
  })

  it('rejects retry across owners, for unknown events, and for machine events', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => Promise.resolve(store.close()))
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '私有消息' },
    }).event
    store.claimNextEvent('worker-1')
    store.failEvent(event.id, 'worker-1', 'boom', 1)
    expect(() => store.retryEvent(event.id, 'intruder')).toThrow(
      /does not exist/,
    )
    expect(() => store.retryEvent('missing-event', 'owner')).toThrow(
      /does not exist/,
    )
    const machine = store.enqueueEvent({
      userId: 'owner',
      type: 'collaboration.requested',
      source: 'collaboration',
      payload: {},
    }).event
    expect(() => store.retryEvent(machine.id, 'owner')).toThrow(
      /Only user messages/,
    )
  })

  it('exposes retry over HTTP with owner isolation', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store, apiToken: 'secret' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    })
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '重试我' },
    }).event
    store.claimNextEvent('worker-1')
    store.failEvent(event.id, 'worker-1', 'boom', 1)
    const response = await fetch(
      `${baseUrl}/v1/events/${encodeURIComponent(event.id)}/retry`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId: 'owner' }),
      },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { event: InboxEvent }
    expect(body.event.status).toBe('pending')
    const intruder = await fetch(
      `${baseUrl}/v1/events/${encodeURIComponent(event.id)}/retry`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId: 'intruder' }),
      },
    )
    expect(intruder.status).toBe(400)
  })
})

async function postEvent(
  baseUrl: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload,
    }),
  })
  return { status: response.status, body: await response.json() }
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
      reason: 'DESIGN-003 chat experience test',
    },
    'echo',
  )
  return { eventId: event.id, taskId: created.task.id, runId: created.run.id }
}

function message(
  text: string,
  extra: Record<string, unknown> = {},
): InboxEvent {
  return {
    id: 'event-1',
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    status: 'pending',
    attempts: 0,
    createdAt: new Date().toISOString(),
    payload: { text, ...extra },
  }
}

function task(
  id: string,
  title: string,
  status: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled',
) {
  return {
    id,
    userId: 'owner',
    originEventId: `origin-${id}`,
    title,
    goal: title,
    status,
    workerIconId: 'computer' as const,
    mandate: {
      strength: 'explicit' as const,
      policyVersion: 'pegas-mandate-v1',
      basis: {
        source: 'web',
        scope: { conversation: 'owner' },
        via: 'router' as const,
      },
      actor: { source: 'web', id: 'owner' },
      scope: title,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}
