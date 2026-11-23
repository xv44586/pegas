import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type { Clock } from '../src/core/clock.js'
import { DshCliExecutor } from '../src/executor/dsh-cli-executor.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import {
  parseFollowUpCommand,
  parseRunAutomationCommand,
  parseRunAutomationStatusCommand,
} from '../src/schedule/schedule.js'
import {
  AutomationCommandConflictError,
  AutomationNotFoundError,
  AutomationRevisionConflictError,
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

describe('SCHEDULE-001 executor recurring automations', () => {
  it('parses strict run-automation payloads and rejects bare local times', () => {
    expect(
      parseRunAutomationCommand({
        commandId: 'ra-1',
        prompt: '每分钟报一个数',
        everySeconds: 60,
        startsAt: '2026-11-23T10:05:00+08:00',
      }),
    ).toEqual({
      commandId: 'ra-1',
      prompt: '每分钟报一个数',
      everySeconds: 60,
      startsAt: '2026-11-23T02:05:00.000Z',
    })
    expect(
      parseRunAutomationCommand({
        commandId: 'ra-2',
        prompt: 'p',
        everySeconds: 3600,
      }),
    ).toEqual({ commandId: 'ra-2', prompt: 'p', everySeconds: 3600 })
    for (const value of [
      null,
      {},
      { commandId: 'x', prompt: 'p', everySeconds: 30 },
      { commandId: 'x', prompt: 'p', everySeconds: 60.5 },
      { commandId: 'x', prompt: ' ', everySeconds: 60 },
      {
        commandId: 'x',
        prompt: 'p',
        everySeconds: 60,
        target: { kind: 'new_task' },
      },
      {
        commandId: 'x',
        prompt: 'p',
        everySeconds: 60,
        startsAt: '2026-11-23T10:05:00',
      },
    ]) {
      expect(() => parseRunAutomationCommand(value)).toThrow()
    }
    expect(() =>
      parseRunAutomationCommand({
        commandId: 'x',
        prompt: 'p',
        everySeconds: 60,
        startsAt: '2026-11-23T10:05:00',
      }),
    ).toThrow(/timezone offset or Z/)
    expect(
      parseRunAutomationStatusCommand({
        commandId: 'stop-1',
        expectedRevision: 1,
      }),
    ).toEqual({ commandId: 'stop-1', expectedRevision: 1 })
    expect(() =>
      parseRunAutomationStatusCommand({
        commandId: 'stop-1',
        expectedRevision: 1,
        userId: 'owner',
      }),
    ).toThrow(/Unexpected field/)
  })

  it('rejects follow-up times without an explicit timezone', () => {
    expect(() =>
      parseFollowUpCommand({
        commandId: 'fu-tz',
        prompt: 'p',
        at: '2026-11-24T14:00:00',
      }),
    ).toThrow(/timezone offset or Z/)
    expect(
      parseFollowUpCommand({
        commandId: 'fu-tz',
        prompt: 'p',
        at: '2026-11-24T14:00:00+08:00',
      }).at,
    ).toBe('2026-11-24T06:00:00.000Z')
  })

  it('creates an interval automation frozen to the current Task and replays idempotently', async () => {
    const clock = new MutableClock('2026-11-23T02:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const { task, claimed } = await seedClaimedRun(store, '每分钟计数 1 到 10')
    const result = store.createRunAutomation(
      claimed.run.id,
      claimed.claimToken,
      {
        commandId: 'count-1',
        prompt: '报出下一个数字；数到 10 后调用 cancel 收尾',
        everySeconds: 60,
      },
    )
    expect(result.automation).toMatchObject({
      userId: 'owner',
      status: 'active',
      schedule: { kind: 'interval', everySeconds: 60 },
      target: { kind: 'existing_task', taskId: task.id },
      nextFireAt: '2026-11-23T02:01:00.000Z',
    })
    expect(result.automation.title).toContain('每分钟计数')

    const replay = store.createRunAutomation(
      claimed.run.id,
      claimed.claimToken,
      {
        commandId: 'count-1',
        prompt: '报出下一个数字；数到 10 后调用 cancel 收尾',
        everySeconds: 60,
      },
    )
    expect(replay.automation.id).toBe(result.automation.id)
    expect(() =>
      store.createRunAutomation(claimed.run.id, claimed.claimToken, {
        commandId: 'count-1',
        prompt: '不同的内容',
        everySeconds: 60,
      }),
    ).toThrow(AutomationCommandConflictError)
    expect(store.listAutomations('owner')).toHaveLength(1)
  })

  it('rejects forged claims, past startsAt and closed Tasks', async () => {
    const clock = new MutableClock('2026-11-23T02:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const { claimed } = await seedClaimedRun(store, '边界校验')
    expect(() =>
      store.createRunAutomation(claimed.run.id, 'forged-token', {
        commandId: 'ra-x',
        prompt: 'p',
        everySeconds: 60,
      }),
    ).toThrow(RunClaimError)
    expect(() =>
      store.createRunAutomation(claimed.run.id, claimed.claimToken, {
        commandId: 'ra-past',
        prompt: 'p',
        everySeconds: 60,
        startsAt: '2026-11-23T01:59:00.000Z',
      }),
    ).toThrow(/future/)
    expect(store.listAutomations('owner')).toHaveLength(0)
  })

  it('refuses new automations once the Task is closed, even with a live claim', async () => {
    const clock = new MutableClock('2026-11-23T02:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const { task, claimed } = await seedClaimedRun(store, '关闭后拒绝')
    store.stopTask(task.id, 'owner', 'stop-1')
    expect(() =>
      store.createRunAutomation(claimed.run.id, claimed.claimToken, {
        commandId: 'ra-closed',
        prompt: 'p',
        everySeconds: 60,
      }),
    ).toThrow(RunClaimError)
    expect(store.listAutomations('owner')).toHaveLength(0)
  })

  it('fires recurring invocations back into the same Task and stays active', async () => {
    const clock = new MutableClock('2026-11-23T02:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const { task, claimed } = await seedClaimedRun(store, '周期报数')
    const { automation } = store.createRunAutomation(
      claimed.run.id,
      claimed.claimToken,
      {
        commandId: 'count-fire',
        prompt: '报出下一个数字',
        everySeconds: 60,
      },
    )
    store.completeRun(claimed.run.id, 'worker-1', {
      executorRef: 'session-1',
      output: '已创建周期任务',
    })
    // Completing the Run must not close the Task while an active automation
    // still targets it; otherwise the first invocation would fail.
    expect(store.findTask(task.id, 'owner')?.status).not.toBe('completed')

    clock.step(61 * 1000)
    const fired = store.fireDueAutomations()
    expect(fired).toHaveLength(1)
    expect(fired[0]?.automation.status).toBe('active')
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
      'worker-4',
    )
    const runs = store.listRuns(task.id)
    expect(runs.at(-1)?.input).toContain('报出下一个数字')
    expect(
      store.listAutomationInvocations(automation.id, 'owner').items[0],
    ).toMatchObject({
      status: 'dispatched',
      scheduledFor: '2026-11-23T02:01:00.000Z',
    })

    clock.step(60 * 1000)
    expect(store.fireDueAutomations()).toHaveLength(1)
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
      'worker-5',
    )
    expect(store.listRuns(task.id).at(-1)?.input).toContain('报出下一个数字')
    expect(store.findAutomation(automation.id, 'owner')?.status).toBe('active')
  })

  it('transitions only automations bound to the current Task', async () => {
    const clock = new MutableClock('2026-11-23T02:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const { task, claimed } = await seedClaimedRun(store, '收尾校验')
    const { automation } = store.createRunAutomation(
      claimed.run.id,
      claimed.claimToken,
      { commandId: 'ra-stop', prompt: 'p', everySeconds: 60 },
    )
    const foreign = store.createAutomation({
      userId: 'owner',
      commandId: 'foreign-create',
      automation: {
        title: '别的任务',
        prompt: 'p',
        schedule: { kind: 'interval', everySeconds: 3600 },
        target: { kind: 'new_task' },
      },
    })
    expect(() =>
      store.transitionRunAutomation(
        claimed.run.id,
        claimed.claimToken,
        foreign.id,
        'cancel',
        { commandId: 'stop-foreign', expectedRevision: 1 },
      ),
    ).toThrow(AutomationNotFoundError)
    expect(() =>
      store.transitionRunAutomation(
        claimed.run.id,
        'forged',
        automation.id,
        'cancel',
        { commandId: 'stop-forged', expectedRevision: 1 },
      ),
    ).toThrow(RunClaimError)
    expect(() =>
      store.transitionRunAutomation(
        claimed.run.id,
        claimed.claimToken,
        automation.id,
        'cancel',
        { commandId: 'stop-stale', expectedRevision: 9 },
      ),
    ).toThrow(AutomationRevisionConflictError)

    const cancelled = store.transitionRunAutomation(
      claimed.run.id,
      claimed.claimToken,
      automation.id,
      'cancel',
      { commandId: 'stop-1', expectedRevision: 1 },
    )
    expect(cancelled.automation).toMatchObject({
      status: 'cancelled',
      revision: 2,
      target: { kind: 'existing_task', taskId: task.id },
    })
    const replay = store.transitionRunAutomation(
      claimed.run.id,
      claimed.claimToken,
      automation.id,
      'cancel',
      { commandId: 'stop-1', expectedRevision: 1 },
    )
    expect(replay.automation).toEqual(cancelled.automation)
    clock.step(120 * 1000)
    expect(store.fireDueAutomations()).toEqual([])
  })

  it('DESIGN-008: run.completed carries automationActive only while an active automation targets the Task', async () => {
    const clock = new MutableClock('2026-11-23T02:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const { task, claimed } = await seedClaimedRun(store, '每分钟报数 1 到 10')
    const { automation } = store.createRunAutomation(
      claimed.run.id,
      claimed.claimToken,
      { commandId: 'ra-fact', prompt: '报出下一个数字', everySeconds: 60 },
    )
    store.completeRun(claimed.run.id, 'worker-1', {
      executorRef: 'session-1',
      output: '周期自动化已创建并生效',
    })
    const scheduled = store
      .listOutbox('owner', task.id)
      .find(
        message =>
          (message.payload as { type?: string }).type === 'run.completed',
      )
    expect(scheduled?.payload).toMatchObject({
      type: 'run.completed',
      automationActive: true,
    })

    clock.step(61 * 1000)
    store.fireDueAutomations()
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
      'worker-2',
    )
    const firedClaim = store.claimNextRun('worker-2')
    if (!firedClaim) throw new Error('expected the fired invocation run')
    store.transitionRunAutomation(
      firedClaim.run.id,
      firedClaim.claimToken,
      automation.id,
      'cancel',
      { commandId: 'ra-fact-stop', expectedRevision: 1 },
    )
    store.completeRun(firedClaim.run.id, 'worker-2', {
      executorRef: 'session-2',
      output: '已数到 10，周期自动化已自动取消。',
    })
    const completions = store
      .listOutbox('owner', task.id)
      .filter(
        message =>
          (message.payload as { type?: string }).type === 'run.completed',
      )
    const final = completions.at(-1)
    expect(final?.payload).toMatchObject({ type: 'run.completed' })
    expect(final?.payload).not.toHaveProperty('automationActive')
  })

  it('DESIGN-008: plain runs without automations never carry automationActive', async () => {
    const clock = new MutableClock('2026-11-23T02:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const { task, claimed } = await seedClaimedRun(store, '一次性整理任务')
    store.completeRun(claimed.run.id, 'worker-1', {
      executorRef: 'session-1',
      output: '整理完成',
    })
    const completion = store
      .listOutbox('owner', task.id)
      .find(
        message =>
          (message.payload as { type?: string }).type === 'run.completed',
      )
    expect(completion?.payload).toMatchObject({ type: 'run.completed' })
    expect(completion?.payload).not.toHaveProperty('automationActive')
  })

  it('serves claim-authenticated HTTP create and status endpoints', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-run-automation-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const clock = new MutableClock('2026-11-23T02:00:00.000Z')
    const store = new PegasStore(join(directory, 'pegas.sqlite'), { clock })
    cleanups.push(() => store.close())
    const { claimed } = await seedClaimedRun(store, 'HTTP 周期任务')
    const server = createControlPlane({ store, apiToken: 'instance-token' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const path = `/v1/runs/${claimed.run.id}/automations`
    const body = JSON.stringify({
      commandId: 'ra-http',
      prompt: '每分钟报一个数',
      everySeconds: 60,
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
      automation: { id: string; revision: number; target: { taskId: string } }
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
        commandId: 'ra-http',
        prompt: '不同内容',
        everySeconds: 60,
      }),
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      error: 'automation_command_conflict',
    })

    const bareTime = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pegas-run-claim-token': claimed.claimToken,
      },
      body: JSON.stringify({
        commandId: 'ra-bare',
        prompt: 'p',
        everySeconds: 60,
        startsAt: '2026-11-23T11:00:00',
      }),
    })
    expect(bareTime.status).toBe(400)

    const statusPath = `${path}/${createdBody.automation.id}/cancel`
    const statusNoClaim = await fetch(base + statusPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'stop-http', expectedRevision: 1 }),
    })
    expect(statusNoClaim.status).toBe(403)

    const cancelled = await fetch(base + statusPath, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pegas-run-claim-token': claimed.claimToken,
      },
      body: JSON.stringify({ commandId: 'stop-http', expectedRevision: 1 }),
    })
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({
      automation: { status: 'cancelled', revision: 2 },
    })
  })

  it('creates an automation through a credential-scrubbed model shell', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-run-automation-e2e-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const store = new PegasStore(join(directory, 'pegas.sqlite'))
    cleanups.push(() => store.close())
    const { claimed } = await seedClaimedRun(
      store,
      '每分钟数一个数，从 1 数到 10',
    )
    const server = createControlPlane({
      store,
      apiToken: '{{SECRET_9jk5hg67}}',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const command = join(directory, 'fake-dsh')
    writeFileSync(
      command,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const pattern = /KEY|PASSWORD|SECRET|TOKEN/i
const scrubbed = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !pattern.test(key) && !key.toUpperCase().startsWith('DSH_'),
  ),
)
const script = [
  'const fs = require("node:fs");',
  'const capability = JSON.parse(fs.readFileSync(process.env.PEGAS_RUN_CAPABILITY_FILE, "utf8"));',
  'fetch(capability.baseUrl + "/v1/runs/" + capability.runId + "/automations", {',
  '  method: "POST",',
  '  headers: { "content-type": "application/json", "x-pegas-run-claim-token": capability.claimToken },',
  '  body: JSON.stringify({ commandId: "count-1-10", prompt: "输出下一个数字", everySeconds: 60, title: "数数 1 到 10" }),',
  '}).then(async response => {',
  '  process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }));',
  '});',
].join('\\n')
const child = spawnSync(process.execPath, ['-e', script], {
  env: scrubbed,
  encoding: 'utf8',
})
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-scrubbed-e2e',
  text: child.stdout,
  reason: { kind: 'completed' },
}))
`,
      { mode: 0o700 },
    )
    chmodSync(command, 0o700)
    const executor = new DshCliExecutor({ command })
    const result = await executor.execute({
      runId: claimed.run.id,
      taskId: claimed.task.id,
      prompt: '把它保存为周期自动化',
      workingDirectory: directory,
      actionCapability: { baseUrl: base, claimToken: claimed.claimToken },
    })
    const response = JSON.parse(result.output) as {
      status: number
      body: { automation: { id: string; target: { taskId: string } } }
    }
    expect(response.status).toBe(201)
    expect(response.body.automation.target.taskId).toBe(claimed.task.id)
    const automations = store.listAutomations('owner')
    expect(automations).toHaveLength(1)
    expect(automations[0]).toMatchObject({
      status: 'active',
      schedule: { kind: 'interval', everySeconds: 60 },
      target: { kind: 'existing_task', taskId: claimed.task.id },
    })
  })
})
