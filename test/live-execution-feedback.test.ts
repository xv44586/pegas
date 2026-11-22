import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AddressInfo } from 'node:net'

import { createControlPlane } from '../src/control-plane/server.js'
import { loadConfig } from '../src/core/config.js'
import { DshCliExecutor } from '../src/executor/dsh-cli-executor.js'
import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../src/executor/executor.js'
import { PrivacyMaskingExecutor } from '../src/privacy/executor.js'
import type { TextPrivacyMasker } from '../src/privacy/masker.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

const temporaryDirectories: string[] = []
const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function openStore(): PegasStore {
  const store = new PegasStore(':memory:')
  cleanups.push(() => store.close())
  return store
}

function enableChatLane(store: PegasStore): void {
  store.initializeRuntimeSettings({
    ...runtimeSettingsDefaults(loadConfig({})),
    chatLaneEnabled: true,
  })
}

function seedCompletedTask(
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
  const claimedEvent = store.claimNextEvent('feedback-router')
  if (!claimedEvent) throw new Error('Expected event claim')
  const created = store.applyRoutingDecision(
    claimedEvent,
    { kind: 'create_task', title: text, goal: text, input: text, reason: 't' },
    'echo-test',
    { executor: 'echo-test' },
  )
  store.completeEvent(event.id, 'feedback-router')
  const claimed = store.claimNextRun('feedback-worker')
  if (claimed?.run.id !== created.run.id) throw new Error('Expected run claim')
  store.completeRun(claimed.run.id, 'feedback-worker', {
    executorRef: 'session-feedback',
    output: '调研完成：结论 A 成立。',
  })
  return { taskId: created.task.id, runId: created.run.id }
}

describe('EXEC-006 related-task routing is deterministic', () => {
  it('forces create_task with sourceContext even when the model answers reply', async () => {
    const store = openStore()
    enableChatLane(store)
    const source = seedCompletedTask(store, '调研供应商定价')
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '基于它的结论继续做计划', sourceTaskId: source.taskId },
    })
    const handled = await processNextEvent(
      store,
      new RoutingEventHandler(
        {
          route: () =>
            Promise.resolve({
              kind: 'reply' as const,
              input: '基于它的结论继续做计划',
              reason: 'model prefers chat',
            }),
        },
        'echo-test',
      ),
      'feedback-router',
      undefined,
      { collectWindowMs: 0 },
    )
    expect(handled).toBe(true)
    const tasks = store.listTasks('owner')
    expect(tasks).toHaveLength(2)
    const created = tasks.find(task => task.id !== source.taskId)
    expect(created).toMatchObject({ kind: 'work', status: 'unstarted' })
    if (!created) throw new Error('Expected the related Task')
    const run = store.listRuns(created.id)[0]
    expect(run?.input).toContain('调研完成：结论 A 成立。')
    expect(run?.input).toContain(source.taskId)
    expect(run?.input).toContain('基于它的结论继续做计划')
  })

  it('fails the event instead of dropping the reference when the source has no facts', async () => {
    const store = openStore()
    enableChatLane(store)
    seedCompletedTask(store, '调研供应商定价')
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '继续', sourceTaskId: 'missing-task' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(
        {
          route: () =>
            Promise.resolve({
              kind: 'reply' as const,
              input: '继续',
              reason: 'model prefers chat',
            }),
        },
        'echo-test',
      ),
      'feedback-router',
      undefined,
      { collectWindowMs: 0 },
    )
    expect(store.listTasks('owner')).toHaveLength(1)
    expect(
      store
        .listEvents('owner')
        .find(
          event =>
            event.type === 'user.message' && event.status !== 'processed',
        ),
    ).toMatchObject({
      lastError: expect.stringContaining('no terminal facts') as string,
    })
  })
})

describe('EXEC-006 continuation redirects active work instead of racing it', () => {
  it('appends a queued continuation into the pending Run input', async () => {
    const store = openStore()
    const handler = new RoutingEventHandler(
      new RuleBasedTaskRouter(),
      'echo-test',
    )
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '调研 Notion 定价' },
    })
    await processNextEvent(store, handler, 'feedback-router', undefined, {
      collectWindowMs: 0,
    })
    const task = store.listTasks('owner')[0]
    if (!task) throw new Error('Expected task')
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '重点看团队版，输出成表格', taskId: task.id },
    })
    await processNextEvent(store, handler, 'feedback-router', undefined, {
      collectWindowMs: 0,
    })
    const runs = store.listRuns(task.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('queued')
    expect(runs[0]?.input).toContain('调研 Notion 定价')
    expect(runs[0]?.input).toContain('重点看团队版，输出成表格')
    expect(runs[0]?.input).toContain('[用户补充]')
    const claimed = store.claimNextRun('feedback-worker')
    expect(claimed?.run.id).toBe(runs[0]?.id)
  })

  it('steers the running Run and its successor stays claimable after supersede', async () => {
    const store = openStore()
    const handler = new RoutingEventHandler(
      new RuleBasedTaskRouter(),
      'echo-test',
    )
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '调研 Notion 定价' },
    })
    await processNextEvent(store, handler, 'feedback-router', undefined, {
      collectWindowMs: 0,
    })
    const task = store.listTasks('owner')[0]
    if (!task) throw new Error('Expected task')
    const claimed = store.claimNextRun('feedback-worker')
    if (!claimed) throw new Error('Expected run claim')
    store.recordExecutorRef(claimed.run.id, 'feedback-worker', 'session-live')
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '改成对比团队版价格', taskId: task.id },
    })
    await processNextEvent(store, handler, 'feedback-router', undefined, {
      collectWindowMs: 0,
    })
    expect(store.listRuns(task.id)).toHaveLength(1)
    expect(
      store.renewRunLeaseAndCheckSteering(claimed.run.id, 'feedback-worker'),
    ).toBe(true)
    store.supersedeRunForSteering(claimed.run.id, 'feedback-worker')
    const runs = store.listRuns(task.id)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({
      status: 'cancelled',
      lastError: expect.stringContaining('superseded_by_steering') as string,
    })
    expect(runs[1]?.status).toBe('queued')
    expect(runs[1]?.input).toContain('改成对比团队版价格')
    const successor = store.claimNextRun('feedback-worker')
    expect(successor?.run.id).toBe(runs[1]?.id)
    expect(successor?.run.resumeFromRef).toBe('session-live')
  })

  it('rejects replaying one event with a different routing decision', () => {
    const store = openStore()
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '调研定价' },
    }).event
    const created = store.applyRoutingDecision(
      event,
      {
        kind: 'create_task',
        title: '调研定价',
        goal: '调研定价',
        input: '调研定价',
        reason: 'first decision',
      },
      'echo-test',
    )
    expect(() =>
      store.applyRoutingDecision(
        event,
        {
          kind: 'continue_task',
          taskId: created.task.id,
          input: '换个方向',
          reason: 'conflicting replay',
        },
        'echo-test',
      ),
    ).toThrow('different decision')
  })
})

class ActivityExecutor implements RunExecutor {
  readonly name = 'activity-test'

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    input.onProgress?.({ type: 'acknowledgement', text: '我开始调研了。' })
    input.onProgress?.({ type: 'activity', label: '调用工具 read' })
    input.onProgress?.({ type: 'activity', label: '完成第 1 步推理' })
    input.onProgress?.({ type: 'activity', label: '调用工具 read' })
    return Promise.resolve({ executorRef: 'session-activity', output: 'done' })
  }
}

describe('EXEC-006 live run progress reaches the Outbox', () => {
  it('publishes a coalesced run.progress projection with counters and recent activity', async () => {
    const store = openStore()
    const executor = new ActivityExecutor()
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '调研执行过程可见性' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
      'feedback-router',
      undefined,
      { collectWindowMs: 0 },
    )
    const claimed = store.claimNextRun('feedback-worker')
    if (!claimed) throw new Error('Expected run claim')
    await executeClaimedRun(
      store,
      executor,
      claimed,
      'feedback-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )
    const progress = store
      .listOutbox('owner', claimed.task.id)
      .filter(
        message =>
          (message.payload as { type?: string }).type === 'run.progress' &&
          message.status !== 'merged',
      )
    expect(progress).toHaveLength(1)
    expect(progress[0]?.payload).toMatchObject({
      type: 'run.progress',
      runId: claimed.run.id,
      toolCalls: 2,
      steps: 1,
      recent: ['调用工具 read', '完成第 1 步推理', '调用工具 read'],
    })
    expect(
      store
        .listOutbox('owner', claimed.task.id)
        .some(
          message =>
            (message.payload as { type?: string }).type === 'run.acknowledged',
        ),
    ).toBe(true)
  })

  it('restores masked activity labels through the privacy boundary', async () => {
    const masker: TextPrivacyMasker = {
      mask: text => ({ text: text.replaceAll('secret', 'MASKED'), hits: [] }),
      restore: text => text.replaceAll('MASKED', 'secret'),
    }
    const observed: string[] = []
    const inner: RunExecutor = {
      name: 'inner-activity',
      execute: input => {
        input.onProgress?.({ type: 'activity', label: '调用工具 MASKED' })
        return Promise.resolve({ executorRef: 's', output: 'MASKED done' })
      },
    }
    const wrapped = new PrivacyMaskingExecutor(inner, masker)
    const result = await wrapped.execute({
      runId: 'run-privacy',
      taskId: 'task-privacy',
      prompt: 'use secret',
      workingDirectory: process.cwd(),
      onProgress: event => {
        if (event.type === 'activity') observed.push(event.label)
      },
    })
    expect(observed).toEqual(['调用工具 secret'])
    expect(result.output).toBe('secret done')
  })

  it('streams real tool_call and step events from the DSH executor', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({ type: 'session', sessionId: 'session-progress' }))
console.log(JSON.stringify({ type: 'tool_call', callId: 'call-1', tool: 'read' }))
console.log(JSON.stringify({ type: 'status', phase: 'step_start' }))
console.log(JSON.stringify({ type: 'status', phase: 'step_end' }))
console.log(JSON.stringify({ type: 'tool_call', callId: 'call-2', tool: 'shell' }))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-progress',
  text: 'finished',
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command })
    const labels: string[] = []
    await executor.execute({
      runId: 'run-dsh-progress',
      taskId: 'task-dsh-progress',
      prompt: 'do the work',
      workingDirectory: process.cwd(),
      onProgress: event => {
        if (event.type === 'activity') labels.push(event.label)
      },
    })
    expect(labels).toEqual([
      '调用工具 read',
      '开始第 1 步推理',
      '完成第 1 步推理',
      '调用工具 shell',
    ])
  })
})

function fakeDsh(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-fake-dsh-'))
  temporaryDirectories.push(directory)
  const command = join(directory, 'dsh')
  writeFileSync(command, `#!/usr/bin/env node\n${body}`, { mode: 0o700 })
  chmodSync(command, 0o700)
  return command
}

class TranscriptExecutor implements RunExecutor {
  readonly name = 'transcript-test'

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    input.onProgress?.({ type: 'acknowledgement', text: '我开始查资料。' })
    input.onProgress?.({ type: 'step', phase: 'start', step: 1 })
    input.onProgress?.({ type: 'thinking', text: '先找定价页面。' })
    input.onProgress?.({
      type: 'tool_call',
      callId: 'call-1',
      tool: 'shell',
      input: '{"command":"curl https://example.com/pricing"}',
    })
    input.onProgress?.({
      type: 'tool_result',
      callId: 'call-1',
      status: 'completed',
      result: 'Team $30/user/month',
    })
    input.onProgress?.({
      type: 'message',
      text: '**团队版** 每成员每月 30 美元。',
    })
    input.onProgress?.({ type: 'step', phase: 'end', step: 1 })
    return Promise.resolve({
      executorRef: 'session-transcript',
      output: '最终结论。',
    })
  }
}

describe('EXEC-006 durable run activity transcript', () => {
  it('persists typed entries with tool input/result merge and serves them owner-scoped', async () => {
    const store = openStore()
    const executor = new TranscriptExecutor()
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '调研定价并留档' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
      'feedback-router',
      undefined,
      { collectWindowMs: 0 },
    )
    const claimed = store.claimNextRun('feedback-worker')
    if (!claimed) throw new Error('Expected run claim')
    await executeClaimedRun(
      store,
      executor,
      claimed,
      'feedback-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )
    const report = store.listRunActivity(claimed.run.id, 'owner')
    expect(report?.totalEntries).toBe(6)
    expect(report?.entries.map(entry => entry.kind)).toEqual([
      'text',
      'step',
      'thinking',
      'tool_call',
      'text',
      'step',
    ])
    const tool = report?.entries.find(entry => entry.kind === 'tool_call')
    expect(tool).toMatchObject({
      callId: 'call-1',
      tool: 'shell',
      status: 'completed',
    })
    expect(tool?.detail).toContain('curl https://example.com/pricing')
    expect(tool?.detail).toContain('[结果]')
    expect(tool?.detail).toContain('Team $30/user/month')
    expect(
      report?.entries.filter(entry => entry.kind === 'text').at(-1)?.detail,
    ).toBe('**团队版** 每成员每月 30 美元。')
    expect(store.listRunActivity(claimed.run.id, 'intruder')).toBeUndefined()

    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const response = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity?userId=owner`,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { totalEntries: number }
    expect(body.totalEntries).toBe(6)
    const foreign = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity?userId=intruder`,
    )
    expect(foreign.status).toBeGreaterThanOrEqual(400)
  })

  it('bounds the transcript window and reports truncation honestly', () => {
    const store = openStore()
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '长任务' },
    }).event
    const created = store.applyRoutingDecision(
      event,
      {
        kind: 'create_task',
        title: '长任务',
        goal: '长任务',
        input: '长任务',
        reason: 't',
      },
      'echo-test',
    )
    store.claimNextRun('transcript-worker')
    for (let index = 0; index < 5; index += 1) {
      store.appendRunActivity(created.run.id, 'transcript-worker', {
        kind: 'text',
        label: `条目 ${String(index)}`,
        detail: `条目 ${String(index)}`,
      })
    }
    const report = store.listRunActivity(created.run.id, 'owner', { limit: 3 })
    expect(report?.entries).toHaveLength(3)
    expect(report?.totalEntries).toBe(5)
    expect(report?.truncated).toBe(true)
    expect(report?.entries.map(entry => entry.label)).toEqual([
      '条目 2',
      '条目 3',
      '条目 4',
    ])
  })

  it('streams tool_result, thinking and step numbers from the DSH executor', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({ type: 'session', sessionId: 'session-transcript' }))
console.log(JSON.stringify({ type: 'status', phase: 'step_start', turn: 1, step: 1 }))
console.log(JSON.stringify({ type: 'thinking', text: 'plan the search' }))
console.log(JSON.stringify({ type: 'tool_call', callId: 'call-9', tool: 'grep', input: { pattern: 'price' } }))
console.log(JSON.stringify({ type: 'tool_result', callId: 'call-9', status: 'completed', result: '3 matches' }))
console.log(JSON.stringify({ type: 'status', phase: 'step_end', turn: 1, step: 1 }))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-transcript',
  text: 'finished',
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command })
    const events: string[] = []
    await executor.execute({
      runId: 'run-dsh-transcript',
      taskId: 'task-dsh-transcript',
      prompt: 'do the work',
      workingDirectory: process.cwd(),
      onProgress: event => {
        if (event.type === 'tool_call')
          events.push(`call:${event.callId}:${event.tool}:${event.input ?? ''}`)
        if (event.type === 'tool_result')
          events.push(
            `result:${event.callId}:${event.status}:${event.result ?? ''}`,
          )
        if (event.type === 'thinking') events.push(`thinking:${event.text}`)
        if (event.type === 'step')
          events.push(`step:${event.phase}:${String(event.step ?? '')}`)
      },
    })
    expect(events).toEqual([
      'step:start:1',
      'thinking:plan the search',
      'call:call-9:grep:{"pattern":"price"}',
      'result:call-9:completed:3 matches',
      'step:end:1',
    ])
  })
})
