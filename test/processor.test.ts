import { describe, expect, it } from 'vitest'

import { EchoExecutor } from '../src/executor/echo-executor.js'
import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../src/executor/executor.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

describe('event and run processing', () => {
  it('routes a user message through a durable run', async () => {
    const store = new PegasStore(':memory:')
    store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      dedupeKey: 'message-1',
      payload: { text: 'Ship the first vertical slice' },
    })
    const executor = new EchoExecutor()

    const processed = await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
      'worker-1',
    )

    expect(processed).toBe(true)
    expect(store.listTasks('user-1')).toMatchObject([
      { title: 'Ship the first vertical slice', status: 'unstarted' },
    ])
    expect(store.listRuns()).toMatchObject([
      { status: 'queued', input: 'Ship the first vertical slice' },
    ])
    expect(store.listOutbox('user-1')).toEqual([])

    const claimed = store.claimNextRun('worker-1')
    expect(claimed).toBeDefined()
    if (!claimed) throw new Error('Expected a claimed run')
    await executeClaimedRun(
      store,
      executor,
      claimed,
      'worker-1',
      process.cwd(),
      new AbortController().signal,
    )

    const completedRuns = store.listRuns()
    expect(completedRuns).toMatchObject([
      {
        status: 'completed',
        output: 'Ship the first vertical slice',
      },
    ])
    expect(completedRuns[0]?.executorRef).toMatch(/^echo-/)
    expect(store.listTasks('user-1')).toMatchObject([
      { status: 'started', statusReason: 'awaiting_user_review' },
    ])
    store.close()
  })

  it('continues an explicit task with the same executor session', async () => {
    const store = new PegasStore(':memory:')
    const executor = new EchoExecutor()
    const handler = new RoutingEventHandler(
      new RuleBasedTaskRouter(),
      executor.name,
    )
    store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      dedupeKey: 'message-1',
      payload: { text: 'Create the first version' },
    })
    await processNextEvent(store, handler, 'worker-1')
    const firstClaim = store.claimNextRun('worker-1')
    if (!firstClaim) throw new Error('Expected the first run')
    await executeClaimedRun(
      store,
      executor,
      firstClaim,
      'worker-1',
      process.cwd(),
      new AbortController().signal,
    )
    const task = store.listTasks('user-1')[0]
    if (!task) throw new Error('Expected the task')
    const firstSession = store.listRuns(task.id)[0]?.executorRef
    if (!firstSession) throw new Error('Expected the first executor session')

    store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      dedupeKey: 'message-2',
      payload: { text: 'Now add recovery tests', taskId: task.id },
    })
    await processNextEvent(store, handler, 'worker-1')

    const runs = store.listRuns(task.id)
    expect(store.listTasks('user-1')).toHaveLength(1)
    expect(runs).toHaveLength(2)
    expect(runs[1]).toMatchObject({
      status: 'queued',
      input: 'Now add recovery tests',
      resumeFromRef: firstSession,
    })
    expect(store.listOutbox('user-1')).toHaveLength(1)
    store.close()
  })

  it('publishes the executor acknowledgement before the final result', async () => {
    const store = new PegasStore(':memory:')
    const executor = new AcknowledgingExecutor()
    store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'web',
      payload: { text: 'Review the release workflow' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
      'worker-1',
    )
    const claimed = store.claimNextRun('worker-1')
    if (!claimed) throw new Error('Expected a claimed run')

    await executeClaimedRun(
      store,
      executor,
      claimed,
      'worker-1',
      process.cwd(),
      new AbortController().signal,
    )

    expect(store.listOutbox('user-1')).toMatchObject([
      {
        payload: {
          type: 'run.acknowledged',
          text: '我会检查发布流程和恢复路径，并给出可验证的改进结果。',
        },
      },
      {
        payload: { type: 'run.completed', text: 'Review complete' },
      },
    ])
    store.close()
  })
})

class AcknowledgingExecutor implements RunExecutor {
  readonly name = 'acknowledging-test'

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    input.onExecutorRef?.('session-ack')
    input.onProgress?.({
      type: 'acknowledgement',
      text: '我会检查发布流程和恢复路径，并给出可验证的改进结果。',
    })
    return Promise.resolve({
      executorRef: 'session-ack',
      output: 'Review complete',
    })
  }
}
