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
  DerivedMemoryBrowseService,
  DerivedMemoryCorrectionService,
} from '../src/memory/derived-memory.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextDerivedMemoryJob,
  processNextDerivedMemoryCurationJob,
  processNextDerivedMemoryCorrectionJob,
  synchronizeDerivedMemories,
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
    expect(store.listDerivedMemoryRecallAudit(claimed.run.id, 'owner')).toEqual(
      [
        { memoryId: 'active', stage: 'retrieved' },
        { memoryId: 'active', stage: 'injected' },
        { memoryId: 'deleted', stage: 'retrieved' },
        {
          memoryId: 'deleted',
          stage: 'filtered',
          reason: 'local_tombstone',
        },
      ],
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
    const claimed = createClaimedRun(store)
    store.recordDerivedMemoryRecall(claimed.run.id, 'owner', [
      {
        id: 'memory-1',
        text: 'wrong fact',
        type: 'world',
        tags: ['pegas:global'],
        metadata: {},
      },
    ])
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

  it('keeps polling a slow operation without consuming the error budget', async () => {
    const clock = new StepClock()
    const store = new PegasStore(':memory:', {
      derivedMemoryEnabled: true,
      clock,
    })
    const claimed = createClaimedRun(store)
    store.completeRun(claimed.run.id, 'worker', {
      executorRef: 'session',
      output: 'done',
    })
    const operationStatus = vi.fn().mockResolvedValue({ status: 'processing' })
    const retain: DerivedMemoryRetainService = {
      submit: vi.fn().mockResolvedValue('operation-1'),
      operationStatus,
    }
    await processNextDerivedMemoryJob(store, retain, 'memory-worker')
    for (let poll = 0; poll < 12; poll += 1) {
      await expect(
        processNextDerivedMemoryJob(store, retain, 'memory-worker'),
      ).resolves.toBe(true)
    }
    expect(operationStatus).toHaveBeenCalledTimes(12)

    operationStatus.mockRejectedValueOnce(new Error('transient network blip'))
    await expect(
      processNextDerivedMemoryJob(store, retain, 'memory-worker'),
    ).resolves.toBe(true)
    operationStatus.mockResolvedValue({ status: 'completed' })
    await expect(
      processNextDerivedMemoryJob(store, retain, 'memory-worker'),
    ).resolves.toBe(true)
    await expect(
      processNextDerivedMemoryJob(store, retain, 'memory-worker'),
    ).resolves.toBe(false)
    store.close()
  })

  it('clears a stale retry error once the operation settles normally', async () => {
    const clock = new StepClock()
    const store = new PegasStore(':memory:', {
      derivedMemoryEnabled: true,
      clock,
    })
    const claimed = createClaimedRun(store)
    store.completeRun(claimed.run.id, 'worker', {
      executorRef: 'session',
      output: 'done',
    })
    const operationStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient network blip'))
      .mockResolvedValue({ status: 'processing' })
    const retain: DerivedMemoryRetainService = {
      submit: vi.fn().mockResolvedValue('operation-1'),
      operationStatus,
    }
    await processNextDerivedMemoryJob(store, retain, 'memory-worker')
    const submitted = store.claimNextDerivedMemoryJob('memory-worker', 30_000)
    if (!submitted) throw new Error('Expected submitted job')
    store.markDerivedMemoryJobSubmitted(
      submitted.id,
      'memory-worker',
      'operation-1',
    )
    // First poll fails and records a real error.
    await expect(
      processNextDerivedMemoryJob(store, retain, 'memory-worker'),
    ).resolves.toBe(true)
    expect(
      store.derivedMemoryJobDiagnostics(submitted.id)?.lastError,
    ).toContain('transient network blip')
    // The next healthy pending poll must clear the stale error instead of
    // surfacing "processing" as a failure forever.
    await expect(
      processNextDerivedMemoryJob(store, retain, 'memory-worker'),
    ).resolves.toBe(true)
    expect(
      store.derivedMemoryJobDiagnostics(submitted.id)?.lastError,
    ).toBeUndefined()
    store.close()
  })

  it('parks an operation that never settles instead of hot-looping', async () => {
    const clock = new StepClock()
    const store = new PegasStore(':memory:', {
      derivedMemoryEnabled: true,
      clock,
    })
    const claimed = createClaimedRun(store)
    store.completeRun(claimed.run.id, 'worker', {
      executorRef: 'session',
      output: 'done',
    })
    const operationStatus = vi.fn().mockResolvedValue({ status: 'processing' })
    const retain: DerivedMemoryRetainService = {
      submit: vi.fn().mockResolvedValue('operation-1'),
      operationStatus,
    }
    await processNextDerivedMemoryJob(store, retain, 'memory-worker')
    for (let poll = 0; poll < 601; poll += 1) {
      await expect(
        processNextDerivedMemoryJob(store, retain, 'memory-worker'),
      ).resolves.toBe(true)
    }
    expect(operationStatus).toHaveBeenCalledTimes(600)
    expect(
      store.claimNextDerivedMemoryJob('memory-worker', 30_000),
    ).toBeUndefined()
    store.close()
  })

  it('submits and polls a durable user correction exactly once', async () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const claimed = createClaimedRun(store)
    store.recordDerivedMemoryRecall(claimed.run.id, 'owner', [
      {
        id: 'memory-1',
        text: 'Use npm.',
        type: 'world',
        tags: ['pegas:global'],
        metadata: {},
      },
    ])
    store.correctDerivedMemory('owner', 'memory-1', {
      commandId: 'correction-command',
      correction: 'Use pnpm.',
    })
    const submitCorrection = vi.fn().mockResolvedValue('operation-1')
    const correctionStatus = vi.fn().mockResolvedValue({
      status: 'completed',
    })
    const service: DerivedMemoryCorrectionService = {
      submitCorrection,
      correctionStatus,
    }

    await expect(
      processNextDerivedMemoryCorrectionJob(store, service, 'memory-worker'),
    ).resolves.toBe(true)
    await expect(
      processNextDerivedMemoryCorrectionJob(store, service, 'memory-worker'),
    ).resolves.toBe(true)
    await expect(
      processNextDerivedMemoryCorrectionJob(store, service, 'memory-worker'),
    ).resolves.toBe(false)
    expect(submitCorrection).toHaveBeenCalledTimes(1)
    expect(correctionStatus).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('clears a stale correction retry error on the next healthy poll', async () => {
    const clock = new StepClock()
    const store = new PegasStore(':memory:', {
      derivedMemoryEnabled: true,
      clock,
    })
    const claimed = createClaimedRun(store)
    store.recordDerivedMemoryRecall(claimed.run.id, 'owner', [
      {
        id: 'memory-1',
        text: 'Use npm.',
        type: 'world',
        tags: ['pegas:global'],
        metadata: {},
      },
    ])
    const correction = store.correctDerivedMemory('owner', 'memory-1', {
      commandId: 'correction-command',
      correction: 'Use pnpm.',
    })
    const correctionStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient network blip'))
      .mockResolvedValue({ status: 'processing' })
    const service: DerivedMemoryCorrectionService = {
      submitCorrection: vi.fn().mockResolvedValue('operation-1'),
      correctionStatus,
    }
    await expect(
      processNextDerivedMemoryCorrectionJob(store, service, 'memory-worker'),
    ).resolves.toBe(true)
    await expect(
      processNextDerivedMemoryCorrectionJob(store, service, 'memory-worker'),
    ).resolves.toBe(true)
    expect(
      store.derivedMemoryJobDiagnostics(correction.correctionJobId)?.lastError,
    ).toContain('transient network blip')
    await expect(
      processNextDerivedMemoryCorrectionJob(store, service, 'memory-worker'),
    ).resolves.toBe(true)
    expect(
      store.derivedMemoryJobDiagnostics(correction.correctionJobId)?.lastError,
    ).toBeUndefined()
    store.close()
  })

  it('synchronizes the complete provider projection without blocking runs', async () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    createClaimedRun(store)
    const list = vi.fn().mockResolvedValue([
      {
        id: 'provider-memory',
        text: 'Use pnpm.',
        type: 'world',
        tags: ['pegas:global'],
        metadata: {},
        state: 'valid',
      },
    ])
    const service: DerivedMemoryBrowseService = { list }

    await expect(synchronizeDerivedMemories(store, service)).resolves.toBe(1)
    expect(list).toHaveBeenCalledWith('owner')
    expect(store.listDerivedMemories('owner')).toMatchObject([
      { id: 'provider-memory' },
    ])
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

class StepClock {
  #value = new Date('2026-11-25T00:00:00.000Z')

  now(): Date {
    const current = new Date(this.#value)
    this.#value = new Date(this.#value.getTime() + 2_000)
    return current
  }
}
