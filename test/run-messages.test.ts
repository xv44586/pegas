import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type { Clock } from '../src/core/clock.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import { parseRunMessageCommand } from '../src/schedule/schedule.js'
import {
  PegasStore,
  RunClaimError,
  RunMessageCommandConflictError,
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

  step(ms: number): void {
    this.#value = new Date(this.#value.getTime() + ms)
  }
}

async function seedClaimedRun(store: PegasStore, text: string) {
  store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
  })
  await processNextEvent(
    store,
    new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
    'worker-1',
  )
  const task = store.listTasks('owner')[0]
  if (!task) throw new Error('Expected the seeded Task')
  const claimed = store.claimNextRun('worker-1')
  if (!claimed) throw new Error('Expected the Run claim')
  return { task, claimed }
}

describe('CONV-006 executor say lane', () => {
  it('parses strict run-message payloads', () => {
    expect(
      parseRunMessageCommand({ commandId: 'say-1', text: '第 1 个数：1' }),
    ).toEqual({ commandId: 'say-1', text: '第 1 个数：1' })
    for (const value of [
      null,
      {},
      { commandId: 'x' },
      { commandId: 'x', text: ' ' },
      { commandId: ' ', text: 'p' },
      { commandId: 'x', text: 'p', taskId: 'other-task' },
      { commandId: 'x', text: 'p', lane: 'decide' },
      { commandId: 'x', text: 'a'.repeat(8001) },
    ]) {
      expect(() => parseRunMessageCommand(value)).toThrow()
    }
  })

  it('delivers a claim-authenticated say fact anchored to the Task', async () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const { task, claimed } = await seedClaimedRun(store, '每分钟数一个数')

    const first = store.sayFromRun(claimed.run.id, claimed.claimToken, {
      commandId: 'count-1',
      text: '第 1 个数：1',
    })
    expect(first.message.payload).toEqual({
      type: 'agent.message',
      taskId: task.id,
      runId: claimed.run.id,
      text: '第 1 个数：1',
    })
    expect(first.message.projection).toEqual({
      lane: 'say',
      weight: 'inline',
      anchor: { taskId: task.id, eventId: task.originEventId },
    })

    const replay = store.sayFromRun(claimed.run.id, claimed.claimToken, {
      commandId: 'count-1',
      text: '第 1 个数：1',
    })
    expect(replay.message.id).toBe(first.message.id)
    expect(store.listOutbox('owner')).toHaveLength(1)

    expect(() =>
      store.sayFromRun(claimed.run.id, claimed.claimToken, {
        commandId: 'count-1',
        text: '篡改重放',
      }),
    ).toThrow(RunMessageCommandConflictError)
    expect(() =>
      store.sayFromRun(claimed.run.id, 'forged-claim', {
        commandId: 'count-2',
        text: '伪造',
      }),
    ).toThrow(RunClaimError)
  })

  it('refuses say facts after the Run stops and never settles the Task', async () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const { task, claimed } = await seedClaimedRun(store, '每分钟数一个数')
    store.stopTask(task.id, 'owner', 'stop-1')
    expect(() =>
      store.sayFromRun(claimed.run.id, claimed.claimToken, {
        commandId: 'late',
        text: '迟到的输出',
      }),
    ).toThrow(RunClaimError)
  })

  it('shows automation-triggered counting in the say lane with silent completion cards', async () => {
    const clock = new MutableClock('2026-11-23T06:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const { task, claimed } = await seedClaimedRun(store, '每分钟数一个数')
    store.createRunAutomation(claimed.run.id, claimed.claimToken, {
      commandId: 'count-loop',
      prompt: '报出下一个数字，并用 messages 接口发给用户',
      everySeconds: 60,
    })
    store.completeRun(claimed.run.id, 'worker-1', {
      executorRef: 'session-1',
      output: '已创建周期任务',
    })
    // The human-initiated creation Run keeps its visible completion card.
    const creationCard = store
      .listOutbox('owner')
      .find(item => item.dedupeKey === `run-completed:${claimed.run.id}`)
    expect(creationCard?.projection).toMatchObject({
      lane: 'work',
      weight: 'card',
    })

    clock.step(61 * 1000)
    const fired = store.fireDueAutomations()
    expect(fired).toHaveLength(1)
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
      'worker-2',
    )
    const triggered = store.claimNextRun('worker-2')
    if (!triggered) throw new Error('Expected the automation-triggered claim')
    store.sayFromRun(triggered.run.id, triggered.claimToken, {
      commandId: 'count-1',
      text: '第 1 个数：1',
    })
    store.completeRun(triggered.run.id, 'worker-2', {
      executorRef: 'session-2',
      output: '第 1 个数：1',
    })

    const outbox = store.listOutbox('owner')
    const say = outbox.find(
      item => item.dedupeKey === `run-message:${triggered.run.id}:count-1`,
    )
    expect(say?.projection).toMatchObject({ lane: 'say', weight: 'inline' })
    expect(say?.projection?.anchor?.taskId).toBe(task.id)
    const completion = outbox.find(
      item => item.dedupeKey === `run-completed:${triggered.run.id}`,
    )
    expect(completion?.projection).toMatchObject({
      lane: 'work',
      weight: 'silent',
    })
  })

  it('serves the claim-authenticated HTTP say endpoint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-run-message-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const store = new PegasStore(join(directory, 'pegas.sqlite'))
    cleanups.push(() => store.close())
    const { task, claimed } = await seedClaimedRun(store, '每分钟数一个数')
    const server = createControlPlane({
      store,
      apiToken: '{{SECRET_29jk5hg6}}',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const path = `/v1/runs/${claimed.run.id}/messages`
    const body = JSON.stringify({ commandId: 'say-http', text: '第 1 个数：1' })

    const noClaim = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(noClaim.status).toBe(403)

    const forged = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pegas-run-claim-token': 'forged',
      },
      body,
    })
    expect(forged.status).toBe(403)

    const created = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pegas-run-claim-token': claimed.claimToken,
      },
      body,
    })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as {
      message: {
        id: string
        payload: { type: string; taskId: string; text: string }
        projection?: { lane: string; weight: string }
      }
    }
    expect(createdBody.message.payload).toMatchObject({
      type: 'agent.message',
      taskId: task.id,
      text: '第 1 个数：1',
    })
    expect(createdBody.message.projection).toMatchObject({
      lane: 'say',
      weight: 'inline',
    })

    const replay = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pegas-run-claim-token': claimed.claimToken,
      },
      body,
    })
    expect(replay.status).toBe(201)
    expect(((await replay.json()) as typeof createdBody).message.id).toBe(
      createdBody.message.id,
    )

    const conflict = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pegas-run-claim-token': claimed.claimToken,
      },
      body: JSON.stringify({ commandId: 'say-http', text: '不同内容' }),
    })
    expect(conflict.status).toBe(409)

    const invalid = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pegas-run-claim-token': claimed.claimToken,
      },
      body: JSON.stringify({ commandId: 'say-x', text: 'p', lane: 'work' }),
    })
    expect(invalid.status).toBe(400)
  })
})
