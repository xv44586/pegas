import { describe, expect, it } from 'vitest'

import type { Clock } from '../src/core/clock.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

describe('PegasStore', () => {
  it('persists runtime settings without overwriting saved choices', () => {
    const store = new PegasStore(':memory:')
    const defaults = {
      routerMode: 'model' as const,
      modelProvider: 'openai' as const,
      modelName: 'gpt-default',
      privacyMode: 'disabled' as const,
      rewriteMode: 'disabled' as const,
    }

    expect(store.initializeRuntimeSettings(defaults)).toMatchObject({
      ...defaults,
      revision: 1,
    })
    const saved = store.updateRuntimeSettings(1, {
      ...defaults,
      modelName: 'gpt-saved',
      privacyMode: 'mask',
      rewriteMode: 'light',
    })

    expect(saved).toMatchObject({
      modelName: 'gpt-saved',
      privacyMode: 'mask',
      rewriteMode: 'light',
      revision: 2,
    })
    expect(
      store.initializeRuntimeSettings({
        ...defaults,
        modelName: 'gpt-new-env',
      }),
    ).toEqual(saved)
    expect(() => store.updateRuntimeSettings(1, defaults)).toThrow(
      '其他设备更新',
    )
    store.close()
  })

  it('updates a provider connection and runtime selection in one revision transaction', () => {
    const store = new PegasStore(':memory:')
    const defaults = {
      routerMode: 'rules' as const,
      modelProvider: 'openai' as const,
      modelName: 'gpt-5-mini',
      privacyMode: 'disabled' as const,
      rewriteMode: 'disabled' as const,
    }
    store.initializeRuntimeSettings(defaults)

    const saved = store.updateRuntimeSettingsAndProvider(
      1,
      { ...defaults, routerMode: 'model' },
      {
        id: 'openai',
        name: 'OpenAI',
        protocol: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyCiphertext: 'encrypted-key-one',
        clearApiKey: false,
      },
    )

    expect(saved).toMatchObject({ revision: 2, routerMode: 'model' })
    expect(store.getModelProviderConnection('openai')).toMatchObject({
      apiKeyCiphertext: 'encrypted-key-one',
    })
    expect(() =>
      store.updateRuntimeSettingsAndProvider(1, defaults, {
        id: 'openai',
        name: 'OpenAI',
        protocol: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyCiphertext: 'must-not-win',
        clearApiKey: false,
      }),
    ).toThrow('其他设备更新')
    expect(store.getModelProviderConnection('openai')).toMatchObject({
      apiKeyCiphertext: 'encrypted-key-one',
    })
    store.close()
  })

  it('deduplicates source events without losing the original event', () => {
    const store = new PegasStore(':memory:')
    const input = {
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      dedupeKey: 'message-1',
      payload: { text: 'Build a feature' },
    }

    const first = store.enqueueEvent(input)
    const duplicate = store.enqueueEvent(input)

    expect(first.inserted).toBe(true)
    expect(duplicate.inserted).toBe(false)
    expect(duplicate.event.id).toBe(first.event.id)
    store.close()
  })

  it('leases events and only lets the owner complete them', () => {
    const store = new PegasStore(':memory:')
    store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      payload: { text: 'Hello' },
    })

    const event = store.claimNextEvent('worker-1')

    expect(event?.status).toBe('processing')
    expect(() => store.completeEvent(event?.id ?? '', 'worker-2')).toThrow(
      /does not own/,
    )
    store.completeEvent(event?.id ?? '', 'worker-1')
    expect(store.claimNextEvent('worker-1')).toBeUndefined()
    store.close()
  })

  it('creates one task and one outbox message when an event is retried', () => {
    const store = new PegasStore(':memory:')
    const { event } = store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      payload: { text: 'Add self recovery' },
    })

    const taskA = store.createTaskFromEvent(event, 'Add self recovery')
    const taskB = store.createTaskFromEvent(event, 'A duplicate title')
    const messageA = store.enqueueOutbox({
      userId: event.userId,
      taskId: taskA.id,
      channel: 'mobile',
      dedupeKey: `task-created:${taskA.id}`,
      payload: { taskId: taskA.id },
    })
    const messageB = store.enqueueOutbox({
      userId: event.userId,
      taskId: taskA.id,
      channel: 'mobile',
      dedupeKey: `task-created:${taskA.id}`,
      payload: { taskId: taskA.id },
    })

    expect(taskB.id).toBe(taskA.id)
    expect(messageB.id).toBe(messageA.id)
    expect(store.listTasks()).toHaveLength(1)
    store.close()
  })

  it('does not duplicate a run when routing is replayed after a crash', () => {
    const store = new PegasStore(':memory:')
    const { event } = store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      payload: { text: 'Implement durable routing' },
    })
    const decision = {
      kind: 'create_task' as const,
      title: 'Implement durable routing',
      goal: 'Implement durable routing',
      input: 'Implement durable routing',
      reason: 'test',
    }

    const first = store.applyRoutingDecision(event, decision, 'test-executor')
    const replay = store.applyRoutingDecision(event, decision, 'test-executor')

    expect(replay.task.id).toBe(first.task.id)
    expect(replay.run.id).toBe(first.run.id)
    expect(store.listRuns()).toHaveLength(1)
    store.close()
  })

  it('lets a new worker resume exactly when the durable lease expires', () => {
    const clock = new MutableClock('2026-11-17T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    const { event } = store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      payload: { text: 'Recover this run' },
    })
    store.applyRoutingDecision(
      event,
      {
        kind: 'create_task',
        title: 'Recover this run',
        goal: 'Recover this run',
        input: 'Recover this run',
        reason: 'test',
      },
      'test-executor',
    )
    const firstClaim = store.claimNextRun('worker-1', 1000)
    if (!firstClaim) throw new Error('Expected the first claim')
    store.recordExecutorRef(firstClaim.run.id, 'worker-1', 'session-durable')

    clock.set('2026-11-17T00:00:00.999Z')
    expect(store.claimNextRun('worker-2')).toBeUndefined()

    clock.set('2026-11-17T00:00:01.000Z')

    const recovered = store.claimNextRun('worker-2')

    expect(recovered?.run).toMatchObject({
      id: firstClaim.run.id,
      executorRef: 'session-durable',
      claimedBy: 'worker-2',
      attempts: 2,
    })
    store.close()
  })
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
}
