import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type { Clock } from '../src/core/clock.js'
import type { ExecutionContext } from '../src/core/domain.js'
import { loadConfig } from '../src/core/config.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import type { ExecutorResult, RunExecutor } from '../src/executor/executor.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

class StepClock implements Clock {
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

class EchoExecutor implements RunExecutor {
  readonly name = 'echo-test'

  execute(input: { prompt: string }): Promise<ExecutorResult> {
    return Promise.resolve({ executorRef: 'echo', output: input.prompt })
  }
}

function seedTask(
  store: PegasStore,
  text: string,
  context: ExecutionContext,
): { taskId: string; runId: string } {
  const event = store.enqueueEvent({
    id: `event-${randomUUID()}`,
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
      reason: 'node affinity test',
    },
    'echo-test',
    context,
  )
  return { taskId: created.task.id, runId: created.run.id }
}

describe('EXEC-004 execution node registry', () => {
  it('registers heartbeats and derives online state from heartbeat age', () => {
    const clock = new StepClock('2026-11-21T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const node = store.registerExecutionNode({
      id: 'mac-studio',
      label: 'Mac Studio',
      capabilities: ['dsh', 'self-change'],
    })
    expect(node).toMatchObject({ id: 'mac-studio', label: 'Mac Studio' })
    expect(store.listExecutionNodes()[0]).toMatchObject({
      id: 'mac-studio',
      online: true,
      capabilities: ['dsh', 'self-change'],
    })
    clock.step(120_000)
    expect(store.listExecutionNodes()[0]?.online).toBe(false)
    // Heartbeat refresh brings the node back online and updates metadata.
    store.registerExecutionNode({ id: 'mac-studio', label: 'Mac Studio 2' })
    expect(store.listExecutionNodes()[0]).toMatchObject({
      online: true,
      label: 'Mac Studio 2',
    })
    expect(store.executionNode('missing')).toBeUndefined()
  })

  it('exposes node status through the Control Plane', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => store.close(),
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    store.registerExecutionNode({ id: 'mac-mini', label: 'Mac mini' })
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const response = await fetch(`${base}/v1/nodes`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      nodes: [{ id: 'mac-mini', label: 'Mac mini', online: true }],
    })
  })

  it('defaults the node identity to the machine hostname', () => {
    const config = loadConfig()
    expect(config.nodeId.length).toBeGreaterThan(0)
    const overridden = loadConfig({
      ...process.env,
      PEGAS_NODE_ID: 'mac-studio',
      PEGAS_NODE_LABEL: '我的 Mac',
    })
    expect(overridden.nodeId).toBe('mac-studio')
    expect(overridden.nodeLabel).toBe('我的 Mac')
  })
})

describe('EXEC-004 node-pinned Runs', () => {
  it('keeps node-pinned Runs queued while the node is offline and never blocks other Tasks', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const local = seedTask(store, '整理 Mac 本地文件', {
      executor: 'echo-test',
      nodeId: 'mac-studio',
    })
    const anywhere = seedTask(store, '云端任务', { executor: 'echo-test' })

    // A worker on a different node cannot claim the pinned Run, but the
    // unpinned Task proceeds normally.
    const remoteClaim = store.claimNextRun('worker-cloud', 30_000, 'cloud-1')
    expect(remoteClaim?.run.id).toBe(anywhere.runId)
    store.completeRun(anywhere.runId, 'worker-cloud', {
      executorRef: 'echo',
      output: '云端任务',
    })
    expect(
      store.claimNextRun('worker-cloud', 30_000, 'cloud-1'),
    ).toBeUndefined()
    expect(store.listRuns(local.taskId)[0]?.status).toBe('queued')

    // A worker without any node identity also cannot claim it.
    expect(store.claimNextRun('worker-anonymous')).toBeUndefined()

    // The pinned node comes back and claims its own Run.
    const localClaim = store.claimNextRun('worker-mac', 30_000, 'mac-studio')
    expect(localClaim?.run.id).toBe(local.runId)
    expect(localClaim?.run.executionContext.nodeId).toBe('mac-studio')
    store.completeRun(local.runId, 'worker-mac', {
      executorRef: 'echo',
      output: '整理 Mac 本地文件',
    })
    expect(store.listRuns(local.taskId)[0]?.status).toBe('completed')
  })

  it('routes new Tasks with the worker node identity in the Run snapshot', async () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const handler = new RoutingEventHandler(
      new RuleBasedTaskRouter(),
      'echo-test',
      () => ({ executor: 'echo-test', nodeId: 'mac-studio' }),
    )
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '本地任务' },
    })
    await processNextEvent(store, handler, 'worker-mac')
    expect(store.claimNextRun('worker-other', 30_000, 'cloud')).toBeUndefined()
    const claimed = store.claimNextRun('worker-mac', 30_000, 'mac-studio')
    if (!claimed) throw new Error('Expected claimed Run')
    await executeClaimedRun(
      store,
      new EchoExecutor(),
      claimed,
      'worker-mac',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:1',
    )
    expect(store.listRuns(claimed.task.id)[0]?.status).toBe('completed')
  })

  it('does not let a lease-expired pinned Run leak to another node', () => {
    const clock = new StepClock('2026-11-21T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const local = seedTask(store, '本地长任务', {
      executor: 'echo-test',
      nodeId: 'mac-studio',
    })
    const first = store.claimNextRun('worker-mac-1', 30_000, 'mac-studio')
    expect(first?.run.id).toBe(local.runId)
    clock.step(60_000)
    // Lease expired, but the Run stays pinned to its node.
    expect(store.claimNextRun('worker-cloud', 30_000, 'cloud')).toBeUndefined()
    const takeover = store.claimNextRun('worker-mac-2', 30_000, 'mac-studio')
    // The expired attempt is failed and a retry Run on the same node resumes.
    expect(takeover?.task.id).toBe(local.taskId)
    expect(takeover?.run.id).not.toBe(local.runId)
    expect(takeover?.run.retryOfRunId).toBe(local.runId)
    expect(takeover?.run.executionContext.nodeId).toBe('mac-studio')
    expect(store.listRuns(local.taskId)[0]?.status).toBe('failed')
  })
})
