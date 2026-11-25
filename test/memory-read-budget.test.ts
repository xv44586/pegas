import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  PegasDerivedMemoryService,
  type DerivedMemory,
} from '../src/memory/derived-memory.js'
import { LocalDerivedMemoryProvider } from '../src/memory/local-provider.js'
import {
  memoryRelevance,
  passesRelevanceGate,
} from '../src/memory/relevance.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const HMAC_KEY = 'test-memory-key-0123456789abcdef0123456789abcdef'
const PROJECT = 'git:github.com/example/a'

function setup() {
  const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
  const provider = new LocalDerivedMemoryProvider(store, {
    hmacKey: HMAC_KEY,
    distill: () => Promise.resolve([]),
  })
  const service = new PegasDerivedMemoryService(provider, {
    hmacKey: HMAC_KEY,
    providerName: 'local',
  })
  return { store, provider, service }
}

function fact(
  store: PegasStore,
  overrides: Partial<DerivedMemory> & { id: string; text: string },
): DerivedMemory {
  const memory: DerivedMemory = {
    type: 'experience',
    tags: ['pegas:global'],
    metadata: {},
    state: 'valid',
    ...overrides,
  }
  store.insertLocalDerivedMemory('owner', memory, memory.projectKey)
  return memory
}

describe('read-side relevance gate (MEMORY-001 M4)', () => {
  it('scores lexical overlap for ASCII and CJK and rejects unrelated facts', () => {
    expect(
      memoryRelevance(
        'fix the pnpm check gate before merging',
        'The pnpm check gate must pass before merging.',
      ),
    ).toBeGreaterThan(0.3)
    expect(
      memoryRelevance('修复记忆召回的限流问题', '记忆召回在限流时需要退避重试'),
    ).toBeGreaterThan(0.2)
    expect(
      passesRelevanceGate(
        'plan a three day Chengdu travel itinerary',
        'The pnpm check gate must pass before merging.',
      ),
    ).toBe(false)
    expect(passesRelevanceGate('', 'anything')).toBe(false)
  })

  it('unrelated facts are filtered as low_relevance and never injected', async () => {
    const { store, service } = setup()
    fact(store, {
      id: 'unrelated',
      // Shares the incidental token "check" with the query so FTS retrieves
      // it; the relevance gate must still reject it as off-topic.
      text: '部署前 check 服务健康状态并确认监控告警静默窗口已经关闭。',
    })
    const recalled = await service.recall({
      userId: 'owner',
      taskId: 'task',
      runId: 'run',
      query: 'check',
      workingDirectory: '/workspace/other',
    })
    expect(recalled.entries).toHaveLength(0)
    expect(
      recalled.audit.some(
        entry => entry.stage === 'filtered' && entry.reason === 'low_relevance',
      ),
    ).toBe(true)
    store.close()
  })

  it('a project with 1000 facts still injects a constant-size opening', async () => {
    const { store, service } = setup()
    for (let index = 0; index < 1_000; index += 1) {
      fact(store, {
        id: `fact-${String(index)}`,
        text: `Project convention number ${String(index)}: run the pnpm check gate before merging feature branch ${String(index)}.`,
        projectKey: PROJECT,
        tags: [`pegas:project:any`],
      })
    }
    // Give the service the project tag allowance by recalling with the key.
    const recalled = await service.recall({
      userId: 'owner',
      taskId: 'task',
      runId: 'run',
      query: 'pnpm check gate merging feature branch',
      workingDirectory: '/workspace/a',
      projectKey: PROJECT,
    })
    expect(recalled.entries.length).toBeLessThanOrEqual(10)
    const characters = recalled.entries.reduce(
      (total, entry) => total + entry.content.length,
      0,
    )
    expect(characters).toBeLessThan(8_000)
    store.close()
  })
})

describe('salience lifecycle (MEMORY-001 M4)', () => {
  it('near-duplicate facts merge into the existing row instead of accumulating', () => {
    const { store } = setup()
    const original = fact(store, {
      id: 'original',
      text: 'The pnpm check gate must pass before merging.',
      projectKey: PROJECT,
    })
    const survivor = store.mergeNearDuplicateLocalMemory(
      'owner',
      {
        id: 'duplicate',
        text: '  the PNPM check gate must pass before merging.  ',
        type: 'experience',
        tags: [],
        metadata: {},
      },
      PROJECT,
    )
    expect(survivor).toBe(original.id)
    expect(store.listLocalDerivedMemories('owner')).toHaveLength(1)
    // A different scope is a different fact even with identical text.
    expect(
      store.mergeNearDuplicateLocalMemory(
        'owner',
        {
          id: 'other-scope',
          text: 'The pnpm check gate must pass before merging.',
          type: 'experience',
          tags: [],
          metadata: {},
        },
        'git:github.com/example/b',
      ),
    ).toBeUndefined()
    store.close()
  })

  it('injected facts accrue use_count and the L0 digest stays bounded', () => {
    const { store } = setup()
    // Register the project through a real workspace + settled Run.
    const root = mkdtempSync(join(tmpdir(), 'pegas-read-budget-'))
    const workspace = join(root, 'repo')
    mkdirSync(workspace)
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: 'register project' },
    }).event
    const task = store.createTaskFromEvent(event, 'register')
    store.applyRoutingDecision(
      event,
      {
        kind: 'continue_task',
        taskId: task.id,
        input: 'register project',
        reason: 'test',
      },
      'test-executor',
      () => ({ executor: 'test-executor', workspace }),
    )
    const claimed = store.claimNextRun('worker')
    if (!claimed) throw new Error('Expected claimed Run')
    store.completeRun(claimed.run.id, 'worker', {
      executorRef: 'session',
      output:
        'done with enough evidence to enqueue a retain job for the project',
    })
    const project = store.memoryProjectForWorkspace('owner', workspace)
    if (!project) throw new Error('Expected registered project')
    for (let index = 0; index < 30; index += 1) {
      fact(store, {
        id: `p-${String(index)}`,
        text: `Convention ${String(index)}: ${'detail '.repeat(40)}`,
        projectKey: project.canonicalKey,
      })
    }
    store.recordLocalDerivedMemoryUse('owner', ['p-0', 'p-1'])
    store.refreshMemoryProjectSummary('owner', project.canonicalKey)
    const summary = store.memoryProjectSummary('owner', project.canonicalKey)
    expect(summary).toBeDefined()
    expect(summary?.text.length).toBeLessThanOrEqual(1_600)
    expect(summary?.factCount).toBe(30)
    // The most-used facts lead the digest.
    expect(summary?.text).toContain('Convention 0:')
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
})
