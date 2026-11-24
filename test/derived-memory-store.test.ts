import { describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'

import { createControlPlane } from '../src/control-plane/server.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

describe('derived memory durable jobs', () => {
  it('atomically enqueues one idempotent retain job when a work Run completes', () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const claimed = createClaimedRun(store, 'owner', 'worker')
    store.completeRun(claimed.run.id, 'worker', {
      executorRef: 'session',
      output: '实现完成，验证通过',
    })

    const job = store.claimNextDerivedMemoryJob('memory-worker', 30_000)
    expect(job).toMatchObject({
      userId: 'owner',
      taskId: claimed.task.id,
      runId: claimed.run.id,
      kind: 'run_success',
      documentId: `pegas:run:${claimed.run.id}`,
      attempts: 1,
    })
    expect(job?.content).toContain('实现完成，验证通过')
    expect(job?.content).not.toContain('sk-secret')
    expect(
      store.claimNextDerivedMemoryJob('other-worker', 30_000),
    ).toBeUndefined()

    store.markDerivedMemoryJobSubmitted(
      job?.id ?? '',
      'memory-worker',
      'provider-operation',
    )
    const polling = store.claimNextDerivedMemoryJob('memory-worker', 30_000)
    expect(polling?.providerOperationId).toBe('provider-operation')
    store.completeDerivedMemoryJob(polling?.id ?? '', 'memory-worker')
    expect(
      store.claimNextDerivedMemoryJob('memory-worker', 30_000),
    ).toBeUndefined()
    store.close()
  })

  it('records observed failure without inventing a cause', () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const claimed = createClaimedRun(store, 'owner', 'worker')
    store.failRun(claimed.run.id, 'worker', 'command exited with status 2')
    const job = store.claimNextDerivedMemoryJob('memory-worker', 30_000)
    expect(job).toMatchObject({ kind: 'run_failure' })
    expect(job?.content).toContain(
      'Observed failure: command exited with status 2',
    )
    expect(job?.content).not.toContain('Root cause')
    store.close()
  })

  it('keeps tombstoned derived memories out of later recall projections', () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const claimed = createClaimedRun(store, 'owner', 'worker')
    store.recordDerivedMemoryRecall(claimed.run.id, 'owner', [
      {
        id: 'memory-1',
        text: 'use pnpm',
        type: 'world',
        tags: ['pegas:global'],
        metadata: { task_id: claimed.task.id },
      },
    ])
    expect(store.listDerivedMemories('owner')).toHaveLength(1)

    store.tombstoneDerivedMemory('owner', 'memory-1', 'user deleted')
    store.recordDerivedMemoryRecall(claimed.run.id, 'owner', [
      {
        id: 'memory-1',
        text: 'use pnpm',
        type: 'world',
        tags: ['pegas:global'],
        metadata: { task_id: claimed.task.id },
      },
    ])
    expect(store.listDerivedMemories('owner')).toEqual([])
    store.close()
  })

  it('exposes derived-memory browse and delete without an approval prompt', async () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const claimed = createClaimedRun(store, 'owner', 'worker')
    store.recordDerivedMemoryRecall(claimed.run.id, 'owner', [
      {
        id: 'memory/http',
        text: 'use pnpm',
        type: 'world',
        tags: ['pegas:global'],
        metadata: {},
      },
    ])
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const list = await fetch(`${base}/v1/derived-memories?userId=owner`)
    expect(await list.json()).toMatchObject({
      memories: [{ id: 'memory/http', text: 'use pnpm' }],
    })
    const deletion = await fetch(
      `${base}/v1/derived-memories/${encodeURIComponent('memory/http')}/delete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'owner' }),
      },
    )
    expect(await deletion.json()).toEqual({
      deletion: { id: 'memory/http', deleted: true },
    })
    expect(store.listDerivedMemories('owner')).toEqual([])
    expect(
      store.claimNextDerivedMemoryCurationJob('memory-worker', 30_000),
    ).toMatchObject({ userId: 'owner', memoryId: 'memory/http' })
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
  })
})

function createClaimedRun(store: PegasStore, userId: string, workerId: string) {
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: {
      text: 'Implement memory without leaking sk-secret-123456789',
    },
  }).event
  const task = store.createTaskFromEvent(event, 'Memory integration')
  store.applyRoutingDecision(
    event,
    {
      kind: 'continue_task',
      taskId: task.id,
      input: 'Implement memory without leaking sk-secret-123456789',
      reason: 'test',
    },
    'test-executor',
    () => ({ executor: 'test-executor', workspace: '/workspace/project' }),
  )
  const claimed = store.claimNextRun(workerId)
  if (!claimed) throw new Error('Expected claimed Run')
  return claimed
}
