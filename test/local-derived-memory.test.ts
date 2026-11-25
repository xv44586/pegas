import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  PegasDerivedMemoryService,
  opaqueKey,
} from '../src/memory/derived-memory.js'
import {
  LocalDerivedMemoryProvider,
  type LocalMemoryCandidate,
} from '../src/memory/local-provider.js'
import { createLocalMemoryDistiller } from '../src/memory/local-distiller.js'
import { loadMemoryKey } from '../src/memory/memory-key.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import { processNextDerivedMemoryJob } from '../src/worker/processor.js'

const HMAC_KEY = 'test-memory-key-0123456789abcdef0123456789abcdef'

function setup(
  candidates: LocalMemoryCandidate[] = [
    {
      text: 'The pnpm check gate must pass before merging any feature.',
      type: 'experience',
      scope: 'context',
    },
  ],
) {
  const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
  const calls: { evidence: string; context: string }[] = []
  const provider = new LocalDerivedMemoryProvider(store, {
    hmacKey: HMAC_KEY,
    distill: input => {
      calls.push(input)
      return Promise.resolve(candidates)
    },
  })
  const service = new PegasDerivedMemoryService(provider, {
    hmacKey: HMAC_KEY,
    providerName: 'local',
  })
  return { store, provider, service, calls }
}

function createClaimedRun(
  store: PegasStore,
  userId: string,
  workerId: string,
  workspace = '/workspace/project',
) {
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: 'Implement the memory feature and verify the gate' },
  }).event
  const task = store.createTaskFromEvent(event, 'Memory integration')
  store.applyRoutingDecision(
    event,
    {
      kind: 'continue_task',
      taskId: task.id,
      input: 'Implement the memory feature and verify the gate',
      reason: 'test',
    },
    'test-executor',
    () => ({ executor: 'test-executor', workspace }),
  )
  const claimed = store.claimNextRun(workerId)
  if (!claimed) throw new Error('Expected claimed Run')
  return claimed
}

describe('local derived memory provider (MEMORY-001 M2)', () => {
  it('distills a settled Run into searchable facts without any approval', async () => {
    const { store, service, calls } = setup()
    const claimed = createClaimedRun(store, 'owner', 'worker')
    store.completeRun(claimed.run.id, 'worker', {
      executorRef: 'session',
      output: '实现完成，pnpm check 全绿后合并',
    })

    const processed = await processNextDerivedMemoryJob(
      store,
      service,
      'memory-worker',
    )
    expect(processed).toBe(true)
    expect(calls).toHaveLength(1)
    // Local retain completes synchronously: submit + status settle the job.
    await processNextDerivedMemoryJob(store, service, 'memory-worker')
    expect(
      store.claimNextDerivedMemoryJob('memory-worker', 30_000),
    ).toBeUndefined()

    const recalled = await service.recall({
      userId: 'owner',
      taskId: claimed.task.id,
      runId: 'next-run',
      query: 'pnpm check gate',
      workingDirectory: '/workspace/project',
    })
    expect(recalled.entries).toHaveLength(1)
    expect(recalled.entries[0]).toMatchObject({
      origin: 'derived',
      provider: 'local',
    })
    expect(recalled.entries[0]?.content).toContain('pnpm check')
    store.close()
  })

  it('replaying the same operation never duplicates facts', async () => {
    const { store, provider, calls } = setup()
    createClaimedRun(store, 'owner', 'worker')
    const bank = opaqueKey('owner', 'owner', HMAC_KEY)
    const input = {
      operationId: 'op-1',
      documentId: 'pegas:run:run-1',
      content:
        'A sufficiently long evidence body about the verified gate that clears the novelty threshold for distillation.',
      context: 'Pegas successful work Run',
      tags: ['pegas:global'],
      metadata: { run_id: 'run-1' },
    }
    await provider.retain(bank, input)
    await provider.retain(bank, input)
    expect(calls).toHaveLength(1)
    expect(await provider.list(bank)).toHaveLength(1)
    store.close()
  })

  it('thin evidence completes with no model call and no facts', async () => {
    const { store, provider, calls } = setup()
    createClaimedRun(store, 'owner', 'worker')
    const bank = opaqueKey('owner', 'owner', HMAC_KEY)
    await provider.retain(bank, {
      operationId: 'op-thin',
      documentId: 'pegas:run:run-thin',
      content: 'ok',
      context: 'Pegas successful work Run',
      tags: ['pegas:global'],
      metadata: {},
    })
    expect(calls).toHaveLength(0)
    expect(await provider.list(bank)).toHaveLength(0)
    const status = await provider.operationStatus(bank, 'op-thin')
    expect(status.status).toBe('completed')
    store.close()
  })

  it('deleted facts stop being recalled and never revive on re-retain', async () => {
    const { store, provider } = setup()
    createClaimedRun(store, 'owner', 'worker')
    const bank = opaqueKey('owner', 'owner', HMAC_KEY)
    const input = {
      operationId: 'op-del',
      documentId: 'pegas:run:run-del',
      content:
        'Evidence long enough to distill a durable fact about gates that clears the novelty threshold for distillation.',
      context: 'Pegas successful work Run',
      tags: ['pegas:global'],
      metadata: { run_id: 'run-del' },
    }
    await provider.retain(bank, input)
    const [memory] = await provider.list(bank)
    if (!memory) throw new Error('Expected one memory')
    store.tombstoneDerivedMemory('owner', memory.id, 'user deleted')

    expect(await provider.list(bank)).toHaveLength(0)
    expect(
      await provider.recall(bank, {
        query: 'gates',
        maxTokens: 1_600,
        tags: ['pegas:global'],
      }),
    ).toHaveLength(0)
    // Same content arriving again under a new operation must stay suppressed.
    await provider.retain(bank, { ...input, operationId: 'op-del-2' })
    expect(await provider.list(bank)).toHaveLength(0)
    store.close()
  })

  it('keeps owners isolated and rejects unknown banks', async () => {
    const { store, provider } = setup()
    createClaimedRun(store, 'owner-a', 'worker')
    createClaimedRun(store, 'owner-b', 'worker')
    const bankA = opaqueKey('owner', 'owner-a', HMAC_KEY)
    const bankB = opaqueKey('owner', 'owner-b', HMAC_KEY)
    await provider.retain(bankA, {
      operationId: 'op-a',
      documentId: 'pegas:run:run-a',
      content:
        'Owner A evidence about a durable verified fact for recall that clears the novelty threshold for distillation.',
      context: 'Pegas successful work Run',
      tags: ['pegas:global'],
      metadata: {},
    })
    expect(await provider.list(bankA)).toHaveLength(1)
    expect(await provider.list(bankB)).toHaveLength(0)
    expect(await provider.list('pegas-owner-unknown')).toHaveLength(0)
    await expect(
      provider.retain('pegas-owner-unknown', {
        operationId: 'op-x',
        documentId: 'pegas:run:run-x',
        content:
          'Evidence long enough to distill a durable fact for recall that clears the novelty threshold for distillation.',
        context: 'ctx',
        tags: [],
        metadata: {},
      }),
    ).rejects.toThrow('Unknown derived memory bank')
    store.close()
  })

  it('context-tagged facts are not recalled from another workspace', async () => {
    const { store, service } = setup()
    const claimed = createClaimedRun(store, 'owner', 'worker')
    store.completeRun(claimed.run.id, 'worker', {
      executorRef: 'session',
      output: '实现完成，pnpm check 全绿后合并',
    })
    await processNextDerivedMemoryJob(store, service, 'memory-worker')
    await processNextDerivedMemoryJob(store, service, 'memory-worker')

    const otherWorkspace = await service.recall({
      userId: 'owner',
      taskId: claimed.task.id,
      runId: 'next-run',
      query: 'pnpm check gate',
      workingDirectory: '/workspace/other-project',
    })
    expect(otherWorkspace.entries).toHaveLength(0)
    expect(
      otherWorkspace.audit.some(entry => entry.reason === 'context_mismatch'),
    ).toBe(true)
    store.close()
  })

  it('distiller degrades malformed model output to no facts', async () => {
    const distill = createLocalMemoryDistiller({
      name: 'fake',
      generateJson: () => Promise.resolve({ memories: 'not-an-array' }),
    })
    expect(await distill({ evidence: 'evidence', context: 'ctx' })).toEqual([])
    const valid = createLocalMemoryDistiller({
      name: 'fake',
      generateJson: () =>
        Promise.resolve({
          memories: [
            { text: '  ', type: 'world', scope: 'global' },
            { text: 'ok fact', type: 'bogus', scope: 'global' },
            { text: 'good fact', type: 'world', scope: 'weird' },
          ],
        }),
    })
    expect(await valid({ evidence: 'e', context: 'c' })).toEqual([
      { text: 'good fact', type: 'world', scope: 'context' },
    ])
  })

  it('memory key is generated once and reused; explicit key wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pegas-memory-key-'))
    try {
      const path = join(dir, 'memory.key')
      const first = loadMemoryKey(path, undefined)
      expect(first).toHaveLength(64)
      expect(loadMemoryKey(path, undefined)).toBe(first)
      expect(loadMemoryKey(path, 'explicit')).toBe('explicit')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
