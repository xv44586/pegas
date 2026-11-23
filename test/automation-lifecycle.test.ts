import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type { Clock } from '../src/core/clock.js'
import type { AutomationDraft } from '../src/schedule/schedule.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import {
  AutomationCommandConflictError,
  AutomationNotFoundError,
  AutomationReadOnlyError,
  AutomationRevisionConflictError,
  PegasStore,
} from '../src/storage/sqlite-store.js'
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

  step(ms: number): void {
    this.#value = new Date(this.#value.getTime() + ms)
  }
}

function intervalDraft(
  overrides: Partial<AutomationDraft> = {},
): AutomationDraft {
  return {
    title: '每分钟报数',
    prompt: '报出下一个数字。',
    schedule: { kind: 'interval', everySeconds: 60 },
    target: { kind: 'new_task' },
    ...overrides,
  }
}

async function drainAutomationEvents(store: PegasStore): Promise<void> {
  const handler = new RoutingEventHandler(
    new RuleBasedTaskRouter(),
    'echo-test',
  )
  for (let index = 0; index < 64; index += 1) {
    const handled = await processNextEvent(store, handler, 'lifecycle-worker')
    if (!handled) return
  }
  throw new Error('Automation events did not drain')
}

describe('automation deletion (DESIGN-006 phase 2)', () => {
  it('deletes an ended automation with its invocations and pending due events, keeping happened facts', async () => {
    const clock = new MutableClock('2026-11-23T02:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const automation = store.createAutomation({
      userId: 'owner',
      commandId: 'delete-create',
      automation: intervalDraft(),
    })
    clock.step(60 * 1000)
    store.fireDueAutomations()
    await drainAutomationEvents(store)
    const task = store.listTasks('owner')[0]
    if (!task) throw new Error('Expected automation task')
    const run = store.listRuns(task.id)[0]
    if (!run) throw new Error('Expected automation run')
    const claimed = store.claimNextRun('lifecycle-executor')
    if (!claimed) throw new Error('Expected claimed run')
    store.completeRun(claimed.run.id, 'lifecycle-executor', {
      executorRef: 'echo-test',
      output: '1\n第二个数字稍后报出。',
    })
    // A second fire stays pending (queued, unprocessed) at deletion time.
    clock.step(60 * 1000)
    store.fireDueAutomations()
    const ended = store.cancelAutomation(automation.id, {
      userId: 'owner',
      commandId: 'delete-cancel',
      expectedRevision: automation.revision,
    })
    expect(ended.status).toBe('cancelled')
    const invocationsBefore = store.listAutomationInvocations(
      automation.id,
      'owner',
    )
    expect(invocationsBefore.items.length).toBe(2)
    const pendingEvent = store
      .listEvents('owner')
      .find(event => event.status === 'pending')
    expect(pendingEvent?.type).toBe('automation.due')

    const deletion = store.deleteAutomation(automation.id, {
      userId: 'owner',
      commandId: 'delete-command',
      expectedRevision: ended.revision,
    })
    expect(deletion).toMatchObject({ id: automation.id, deleted: true })
    expect(store.findAutomation(automation.id, 'owner')).toBeUndefined()
    expect(store.listAutomations('owner')).toEqual([])
    expect(() =>
      store.listAutomationInvocations(automation.id, 'owner'),
    ).toThrow(AutomationNotFoundError)
    // The queued due event is gone; the processed one stays as history.
    expect(
      store
        .listEvents('owner')
        .filter(event => event.type === 'automation.due'),
    ).toHaveLength(1)
    // Happened facts survive: Task, Run and its output are untouched.
    expect(store.listTasks('owner')).toHaveLength(1)
    expect(store.listRuns(task.id)).toMatchObject([
      { status: 'completed', output: '1\n第二个数字稍后报出。' },
    ])
    // The scheduler no longer sees the deleted definition.
    clock.step(60 * 1000)
    expect(store.fireDueAutomations()).toEqual([])
  })

  it('replays the frozen deletion receipt and fences conflicts', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const automation = store.createAutomation({
      userId: 'owner',
      commandId: 'replay-create',
      automation: intervalDraft(),
    })
    const ended = store.cancelAutomation(automation.id, {
      userId: 'owner',
      commandId: 'replay-cancel',
      expectedRevision: automation.revision,
    })
    const command = {
      userId: 'owner',
      commandId: 'replay-delete',
      expectedRevision: ended.revision,
    }
    const deletion = store.deleteAutomation(automation.id, command)
    expect(store.deleteAutomation(automation.id, command)).toEqual(deletion)
    expect(() =>
      store.deleteAutomation(automation.id, {
        ...command,
        expectedRevision: ended.revision + 1,
      }),
    ).toThrow(AutomationCommandConflictError)
    expect(() =>
      store.deleteAutomation(automation.id, {
        userId: 'owner',
        commandId: 'stale-delete',
        expectedRevision: automation.revision,
      }),
    ).toThrow(AutomationNotFoundError)
  })

  it('refuses to delete live automations and isolates owners', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const automation = store.createAutomation({
      userId: 'owner',
      commandId: 'live-create',
      automation: intervalDraft(),
    })
    expect(() =>
      store.deleteAutomation(automation.id, {
        userId: 'owner',
        commandId: 'live-delete',
        expectedRevision: automation.revision,
      }),
    ).toThrow(AutomationReadOnlyError)
    const paused = store.pauseAutomation(automation.id, {
      userId: 'owner',
      commandId: 'live-pause',
      expectedRevision: automation.revision,
    })
    expect(() =>
      store.deleteAutomation(automation.id, {
        userId: 'owner',
        commandId: 'paused-delete',
        expectedRevision: paused.revision,
      }),
    ).toThrow(AutomationReadOnlyError)
    expect(() =>
      store.deleteAutomation(automation.id, {
        userId: 'other',
        commandId: 'other-delete',
        expectedRevision: paused.revision,
      }),
    ).toThrow(AutomationNotFoundError)
    const ended = store.cancelAutomation(automation.id, {
      userId: 'owner',
      commandId: 'live-cancel',
      expectedRevision: paused.revision,
    })
    expect(() =>
      store.deleteAutomation(automation.id, {
        userId: 'owner',
        commandId: 'fenced-delete',
        expectedRevision: automation.revision,
      }),
    ).toThrow(AutomationRevisionConflictError)
    expect(
      store.deleteAutomation(automation.id, {
        userId: 'owner',
        commandId: 'final-delete',
        expectedRevision: ended.revision,
      }).deleted,
    ).toBe(true)
  })

  it('serves the delete command over HTTP with stable errors', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => store.close(),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const automation = store.createAutomation({
      userId: 'owner',
      commandId: 'http-delete-create',
      automation: intervalDraft(),
    })
    const post = (path: string, body: Record<string, unknown>) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const live = await post(`/v1/automations/${automation.id}/delete`, {
      userId: 'owner',
      commandId: 'http-live-delete',
      expectedRevision: automation.revision,
    })
    expect(live.status).toBe(409)
    expect(await live.json()).toEqual({ error: 'automation_read_only' })
    const ended = store.cancelAutomation(automation.id, {
      userId: 'owner',
      commandId: 'http-delete-cancel',
      expectedRevision: automation.revision,
    })
    const missing = await post('/v1/automations/does-not-exist/delete', {
      userId: 'owner',
      commandId: 'http-missing-delete',
      expectedRevision: 1,
    })
    expect(missing.status).toBe(404)
    const deleted = await post(`/v1/automations/${automation.id}/delete`, {
      userId: 'owner',
      commandId: 'http-delete',
      expectedRevision: ended.revision,
    })
    expect(deleted.status).toBe(200)
    const deletedBody: unknown = await deleted.json()
    expect(deletedBody).toMatchObject({
      deletion: { id: automation.id, deleted: true },
    })
    expect(
      (deletedBody as { deletion: { deletedAt: string } }).deletion.deletedAt,
    ).toEqual(expect.any(String))
    const replay = await post(`/v1/automations/${automation.id}/delete`, {
      userId: 'owner',
      commandId: 'http-delete',
      expectedRevision: ended.revision,
    })
    expect(replay.status).toBe(200)
    const gone = await fetch(
      `${base}/v1/automations/${automation.id}?userId=owner`,
    )
    expect(gone.status).toBe(404)
  })
})

describe('automation invocation history (DESIGN-006 phase 2)', () => {
  it('pages invocations by scheduled time with a seek cursor and projects run facts', async () => {
    const clock = new MutableClock('2026-11-23T02:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const automation = store.createAutomation({
      userId: 'owner',
      commandId: 'history-create',
      automation: intervalDraft(),
    })
    for (let index = 0; index < 3; index += 1) {
      clock.step(60 * 1000)
      store.fireDueAutomations()
    }
    await drainAutomationEvents(store)
    const tasks = store.listTasks('owner')
    expect(tasks.length).toBe(3)
    // Complete one run so its invocation carries taskId + summary.
    const claimed = store.claimNextRun('history-executor')
    if (!claimed) throw new Error('Expected claimed run')
    store.completeRun(claimed.run.id, 'history-executor', {
      executorRef: 'echo-test',
      output: '3\n完整输出第二行。',
    })

    const first = store.listAutomationInvocations(automation.id, 'owner', {
      limit: 2,
    })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBe(first.items[1]?.id)
    expect(first.items[0]?.scheduledFor).toBe('2026-11-23T02:03:00.000Z')
    expect(first.items[1]?.scheduledFor).toBe('2026-11-23T02:02:00.000Z')
    const second = store.listAutomationInvocations(automation.id, 'owner', {
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeUndefined()
    expect(second.items[0]?.scheduledFor).toBe('2026-11-23T02:01:00.000Z')

    const completedInvocation = [...first.items, ...second.items].find(
      item => item.taskId === claimed.run.taskId,
    )
    expect(completedInvocation).toMatchObject({
      taskId: claimed.run.taskId,
      summary: '3',
    })
    for (const item of [...first.items, ...second.items]) {
      if (item.id === completedInvocation?.id) continue
      expect(item.taskId).toBeDefined()
      expect(item.summary).toBeUndefined()
    }
    expect(() =>
      store.listAutomationInvocations(automation.id, 'owner', {
        cursor: 'not-an-invocation',
      }),
    ).toThrow(/cursor/i)
    expect(() =>
      store.listAutomationInvocations(automation.id, 'owner', { limit: 0 }),
    ).toThrow(/limit/i)
    expect(() =>
      store.listAutomationInvocations(automation.id, 'owner', { limit: 201 }),
    ).toThrow(/limit/i)
    expect(() =>
      store.listAutomationInvocations(automation.id, 'other'),
    ).toThrow(AutomationNotFoundError)
  })

  it('serves cursor pagination over HTTP and keeps the legacy array shape working', async () => {
    const clock = new MutableClock('2026-11-23T02:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => store.close(),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const automation = store.createAutomation({
      userId: 'owner',
      commandId: 'http-history-create',
      automation: intervalDraft(),
    })
    for (let index = 0; index < 3; index += 1) {
      clock.step(60 * 1000)
      store.fireDueAutomations()
    }
    const first = await fetch(
      `${base}/v1/automations/${automation.id}/invocations?userId=owner&limit=2`,
    )
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as {
      invocations: { id: string }[]
      nextCursor?: string
    }
    expect(firstBody.invocations).toHaveLength(2)
    expect(firstBody.nextCursor).toBe(firstBody.invocations[1]?.id)
    const second = await fetch(
      `${base}/v1/automations/${automation.id}/invocations?userId=owner&limit=2&cursor=${String(firstBody.nextCursor)}`,
    )
    const secondBody = (await second.json()) as {
      invocations: unknown[]
      nextCursor?: string
    }
    expect(secondBody.invocations).toHaveLength(1)
    expect(secondBody.nextCursor).toBeUndefined()
    const invalid = await fetch(
      `${base}/v1/automations/${automation.id}/invocations?userId=owner&cursor=bogus`,
    )
    expect(invalid.status).toBe(400)
    const badLimit = await fetch(
      `${base}/v1/automations/${automation.id}/invocations?userId=owner&limit=0`,
    )
    expect(badLimit.status).toBe(400)
    const missing = await fetch(
      `${base}/v1/automations/nope/invocations?userId=owner`,
    )
    expect(missing.status).toBe(404)
  })
})
