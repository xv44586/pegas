import { describe, expect, it, vi } from 'vitest'

import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../src/executor/executor.js'
import type {
  DerivedMemoryRecallService,
  DerivedMemoryRetainService,
  DerivedMemoryCurationService,
} from '../src/memory/derived-memory.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextDerivedMemoryJob,
  processNextDerivedMemoryCurationJob,
} from '../src/worker/processor.js'

describe('derived memory Run integration', () => {
  it('fails open when recall is unavailable', async () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store)
    const executor = new CapturingExecutor()
    const derivedMemory: DerivedMemoryRecallService = {
      recall: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    }

    await executeClaimedRun(
      store,
      executor,
      claimed,
      'worker',
      '/fallback',
      new AbortController().signal,
      'http://127.0.0.1:4317',
      undefined,
      undefined,
      undefined,
      undefined,
      derivedMemory,
    )

    expect(executor.input).toBeDefined()
    expect(store.listRuns(claimed.task.id)[0]).toMatchObject({
      status: 'completed',
    })
    store.close()
  })

  it('injects active recalled facts once and excludes a local tombstone', async () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store)
    store.tombstoneDerivedMemory('owner', 'deleted', 'user deleted')
    const executor = new CapturingExecutor()
    const derivedMemory: DerivedMemoryRecallService = {
      recall: vi.fn().mockResolvedValue({
        memories: [
          {
            id: 'active',
            text: 'Use pnpm',
            type: 'world',
            tags: ['pegas:global'],
            metadata: { task_id: claimed.task.id },
          },
          {
            id: 'deleted',
            text: 'Use npm',
            type: 'world',
            tags: ['pegas:global'],
            metadata: {},
          },
        ],
        entries: [
          derivedEntry('active', 'Use pnpm', claimed.task.id),
          derivedEntry('deleted', 'Use npm', claimed.task.id),
        ],
      }),
    }

    await executeClaimedRun(
      store,
      executor,
      claimed,
      'worker',
      '/fallback',
      new AbortController().signal,
      'http://127.0.0.1:4317',
      undefined,
      undefined,
      undefined,
      undefined,
      derivedMemory,
    )

    expect(executor.input?.memories?.map(memory => memory.id)).toEqual([
      'active',
    ])
    expect(store.listDerivedMemories('owner').map(memory => memory.id)).toEqual(
      ['active'],
    )
    store.close()
  })

  it('submits and polls a durable retain operation without duplicate submission', async () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const claimed = createClaimedRun(store)
    store.completeRun(claimed.run.id, 'worker', {
      executorRef: 'session',
      output: 'done',
    })
    const submit = vi.fn().mockResolvedValue('operation-1')
    const operationStatus = vi.fn().mockResolvedValue({ status: 'completed' })
    const retain: DerivedMemoryRetainService = {
      submit,
      operationStatus,
    }

    await expect(
      processNextDerivedMemoryJob(store, retain, 'memory-worker'),
    ).resolves.toBe(true)
    await expect(
      processNextDerivedMemoryJob(store, retain, 'memory-worker'),
    ).resolves.toBe(true)
    await expect(
      processNextDerivedMemoryJob(store, retain, 'memory-worker'),
    ).resolves.toBe(false)

    expect(submit).toHaveBeenCalledTimes(1)
    expect(operationStatus).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('delivers a tombstone to the provider asynchronously', async () => {
    const store = new PegasStore(':memory:')
    store.tombstoneDerivedMemory('owner', 'memory-1', 'wrong fact')
    const invalidate = vi.fn().mockResolvedValue(undefined)
    const curation: DerivedMemoryCurationService = { invalidate }

    await expect(
      processNextDerivedMemoryCurationJob(store, curation, 'memory-worker'),
    ).resolves.toBe(true)
    await expect(
      processNextDerivedMemoryCurationJob(store, curation, 'memory-worker'),
    ).resolves.toBe(false)
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner',
        memoryId: 'memory-1',
        reason: 'wrong fact',
      }),
    )
    store.close()
  })
})

function createClaimedRun(store: PegasStore) {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: 'Continue implementation' },
  }).event
  const task = store.createTaskFromEvent(event, 'Memory integration')
  store.applyRoutingDecision(
    event,
    {
      kind: 'continue_task',
      taskId: task.id,
      input: 'Continue implementation',
      reason: 'test',
    },
    'capturing',
    () => ({ executor: 'capturing', workspace: '/workspace/project' }),
  )
  const claimed = store.claimNextRun('worker')
  if (!claimed) throw new Error('Expected claimed Run')
  return claimed
}

function derivedEntry(id: string, content: string, taskId: string) {
  return {
    id,
    scope: 'worker' as const,
    taskId,
    category: 'fact' as const,
    content,
    source: { kind: 'task' as const, id: taskId },
    origin: 'derived' as const,
    provider: 'hindsight' as const,
  }
}

class CapturingExecutor implements RunExecutor {
  readonly name = 'capturing'
  input?: ExecutorInput

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    this.input = input
    return Promise.resolve({ executorRef: 'session', output: 'done' })
  }
}
