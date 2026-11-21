import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type { Clock } from '../src/core/clock.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import { parseFollowUpCommand } from '../src/schedule/schedule.js'
import {
  AutomationCommandConflictError,
  PegasStore,
  RunClaimError,
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

describe('SCHEDULE-001 conversational follow-up', () => {
  it('parses strict follow-up payloads', () => {
    expect(
      parseFollowUpCommand({
        commandId: 'fu-1',
        prompt: '明天下午问我是否发布',
        at: '2026-11-22T14:00:00.000Z',
      }),
    ).toEqual({
      commandId: 'fu-1',
      prompt: '明天下午问我是否发布',
      at: '2026-11-22T14:00:00.000Z',
    })
    for (const value of [
      null,
      {},
      { commandId: 'x', prompt: 'p', at: 'not-a-date' },
      { commandId: 'x', prompt: ' ', at: '2026-11-22T14:00:00.000Z' },
      {
        commandId: 'x',
        prompt: 'p',
        at: '2026-11-22T14:00:00.000Z',
        target: { kind: 'new_task' },
      },
    ]) {
      expect(() => parseFollowUpCommand(value)).toThrow()
    }
  })

  it('creates a one-shot existing-task automation bound to the current Task', async () => {
    const clock = new MutableClock('2026-11-21T08:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const { task, claimed } = await seedClaimedRun(store, '准备发布方案')
    const result = store.createFollowUpFromRun(
      claimed.run.id,
      claimed.claimToken,
      {
        commandId: 'fu-1',
        prompt: '问用户是否确认发布',
        at: '2026-11-22T14:00:00.000Z',
      },
    )
    expect(result.automation).toMatchObject({
      userId: 'owner',
      status: 'active',
      schedule: { kind: 'once', at: '2026-11-22T14:00:00.000Z' },
      target: { kind: 'existing_task', taskId: task.id },
      prompt: '问用户是否确认发布',
    })
    expect(result.automation.title).toContain('准备发布方案')

    // Same command replay returns the frozen automation.
    const replay = store.createFollowUpFromRun(
      claimed.run.id,
      claimed.claimToken,
      {
        commandId: 'fu-1',
        prompt: '问用户是否确认发布',
        at: '2026-11-22T14:00:00.000Z',
      },
    )
    expect(replay.automation.id).toBe(result.automation.id)
    expect(() =>
      store.createFollowUpFromRun(claimed.run.id, claimed.claimToken, {
        commandId: 'fu-1',
        prompt: '不同的内容',
        at: '2026-11-22T14:00:00.000Z',
      }),
    ).toThrow(AutomationCommandConflictError)
    expect(store.listAutomations('owner')).toHaveLength(1)
  })

  it('rejects forged claims, past times and closed Tasks', async () => {
    const clock = new MutableClock('2026-11-21T08:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const { task, claimed } = await seedClaimedRun(store, '边界校验')
    expect(() =>
      store.createFollowUpFromRun(claimed.run.id, 'forged-token', {
        commandId: 'fu-x',
        prompt: 'p',
        at: '2026-11-22T14:00:00.000Z',
      }),
    ).toThrow(RunClaimError)
    expect(() =>
      store.createFollowUpFromRun(claimed.run.id, claimed.claimToken, {
        commandId: 'fu-past',
        prompt: 'p',
        at: '2026-11-21T07:00:00.000Z',
      }),
    ).toThrow(/future/)
    // Completing the Run invalidates its claim; a fresh open Run is needed
    // to exercise the closed-Task boundary with a live capability.
    store.completeRun(claimed.run.id, 'worker-1', {
      executorRef: 'session-1',
      output: 'done',
    })
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '继续', taskId: task.id },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
      'worker-2',
    )
    const reopened = store.claimNextRun('worker-2')
    if (!reopened) throw new Error('Expected the reopened Run claim')
    store.stopTask(task.id, 'owner', 'stop-1')
    expect(() =>
      store.createFollowUpFromRun(reopened.run.id, reopened.claimToken, {
        commandId: 'fu-closed',
        prompt: 'p',
        at: '2026-11-22T14:00:00.000Z',
      }),
    ).toThrow()
    expect(store.listAutomations('owner')).toHaveLength(0)
  })

  it('fires the follow-up back into the same Task through the scheduler', async () => {
    const clock = new MutableClock('2026-11-21T08:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const { task, claimed } = await seedClaimedRun(store, '发布提醒')
    store.createFollowUpFromRun(claimed.run.id, claimed.claimToken, {
      commandId: 'fu-fire',
      prompt: '现在问用户是否发布',
      at: '2026-11-21T09:00:00.000Z',
    })
    // The Task stays open (started) while waiting for the follow-up window.
    clock.step(61 * 60 * 1000)
    const fired = store.fireDueAutomations()
    expect(fired).toHaveLength(1)
    const handled = await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
      'worker-4',
    )
    expect(handled).toBe(true)
    const runs = store.listRuns(task.id)
    const last = runs.at(-1)
    expect(last?.input).toContain('现在问用户是否发布')
    const automations = store.listAutomations('owner')
    expect(automations[0]?.status).toBe('completed')
    const invocations = store.listAutomationInvocations(
      automations[0]?.id ?? '',
      'owner',
    )
    expect(invocations[0]?.status).toBe('dispatched')
  })

  it('serves the claim-authenticated HTTP endpoint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-follow-up-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const clock = new MutableClock('2026-11-21T08:00:00.000Z')
    const store = new PegasStore(join(directory, 'pegas.sqlite'), { clock })
    cleanups.push(() => store.close())
    const { claimed } = await seedClaimedRun(store, 'HTTP follow-up')
    const server = createControlPlane({ store, apiToken: 'instance-token' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const path = `/v1/runs/${claimed.run.id}/follow-ups`
    const body = JSON.stringify({
      commandId: 'fu-http',
      prompt: '明早提醒我检查发布结果',
      at: '2026-11-22T09:00:00.000Z',
    })

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
      automation: { id: string; target: { taskId: string } }
    }
    expect(createdBody.automation.target.taskId).toBe(claimed.task.id)

    const replay = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pegas-run-claim-token': claimed.claimToken,
      },
      body,
    })
    expect(replay.status).toBe(201)
    expect(
      ((await replay.json()) as { automation: { id: string } }).automation.id,
    ).toBe(createdBody.automation.id)

    const conflict = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pegas-run-claim-token': claimed.claimToken,
      },
      body: JSON.stringify({
        commandId: 'fu-http',
        prompt: '不同内容',
        at: '2026-11-22T09:00:00.000Z',
      }),
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      error: 'automation_command_conflict',
    })
  })
})
