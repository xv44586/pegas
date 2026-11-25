import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PegasDerivedMemoryService } from '../src/memory/derived-memory.js'
import {
  LocalDerivedMemoryProvider,
  type LocalMemoryCandidate,
} from '../src/memory/local-provider.js'
import {
  normalizeRemoteUrl,
  resolveProjectIdentity,
} from '../src/memory/project-identity.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import { processNextDerivedMemoryJob } from '../src/worker/processor.js'

const HMAC_KEY = 'test-memory-key-0123456789abcdef0123456789abcdef'

function git(cwd: string, ...arguments_: string[]): void {
  execFileSync('git', arguments_, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
}

function initRepository(directory: string, remote?: string): void {
  mkdirSync(directory, { recursive: true })
  git(directory, 'init', '-q')
  writeFileSync(join(directory, 'README.md'), '# project\n')
  git(directory, 'add', '.')
  git(directory, 'commit', '-qm', 'initial')
  if (remote) git(directory, 'remote', 'add', 'origin', remote)
}

describe('project identity resolution (MEMORY-001 M3)', () => {
  it('normalizes scp and URL remotes to one canonical key', () => {
    const expected = 'github.com/xv44586/pegas'
    expect(normalizeRemoteUrl('git@github.com:xv44586/pegas.git')).toBe(
      expected,
    )
    expect(normalizeRemoteUrl('https://github.com/xv44586/pegas.git')).toBe(
      expected,
    )
    expect(normalizeRemoteUrl('https://github.com/xv44586/pegas/')).toBe(
      expected,
    )
    expect(
      normalizeRemoteUrl('https://user:token@github.com/xv44586/pegas.git'),
    ).toBe(expected)
    expect(normalizeRemoteUrl('ssh://git@github.com/xv44586/pegas.git')).toBe(
      expected,
    )
    expect(normalizeRemoteUrl('not a remote')).toBeUndefined()
    expect(normalizeRemoteUrl('')).toBeUndefined()
  })

  it('linked worktrees and fresh clones of one remote converge; default workspace stays project-less', () => {
    const root = mkdtempSync(join(tmpdir(), 'pegas-project-'))
    try {
      const main = join(root, 'main')
      const clone = join(root, 'clone')
      const worktree = join(root, 'linked-worktree')
      const plain = join(root, 'plain-dir')
      const defaultWorkspace = join(root, 'default-workspace')
      initRepository(main, 'git@github.com:xv44586/pegas.git')
      initRepository(clone, 'https://github.com/xv44586/pegas.git')
      git(main, 'worktree', 'add', '-q', worktree)
      mkdirSync(plain)
      mkdirSync(defaultWorkspace)

      const fromMain = resolveProjectIdentity(main, defaultWorkspace)
      const fromClone = resolveProjectIdentity(clone, defaultWorkspace)
      const fromWorktree = resolveProjectIdentity(worktree, defaultWorkspace)
      expect(fromMain?.canonicalKey).toBe('git:github.com/xv44586/pegas')
      expect(fromClone?.canonicalKey).toBe(fromMain?.canonicalKey)
      expect(fromWorktree?.canonicalKey).toBe(fromMain?.canonicalKey)

      const fromPlain = resolveProjectIdentity(plain, defaultWorkspace)
      expect(fromPlain?.canonicalKey).toMatch(/^path:/)
      expect(
        resolveProjectIdentity(defaultWorkspace, defaultWorkspace),
      ).toBeUndefined()
      expect(
        resolveProjectIdentity(join(root, 'missing'), defaultWorkspace),
      ).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function setup(options: {
  candidates?: LocalMemoryCandidate[]
  defaultWorkspaceRoot?: string
  now?: () => Date
}) {
  const store = new PegasStore(':memory:', {
    derivedMemoryEnabled: true,
    ...(options.defaultWorkspaceRoot
      ? { defaultWorkspaceRoot: options.defaultWorkspaceRoot }
      : {}),
    ...(options.now ? { clock: { now: options.now } } : {}),
  })
  const calls: { evidence: string; context: string }[] = []
  const provider = new LocalDerivedMemoryProvider(store, {
    hmacKey: HMAC_KEY,
    distill: input => {
      calls.push(input)
      return Promise.resolve(
        options.candidates ?? [
          {
            text: 'The pnpm check gate must pass before merging any feature.',
            type: 'experience',
            scope: 'context',
          },
        ],
      )
    },
  })
  const service = new PegasDerivedMemoryService(provider, {
    hmacKey: HMAC_KEY,
    providerName: 'local',
  })
  return { store, provider, service, calls }
}

/** Move the fake clock past the coalescing window so jobs become due. */
function advancePastWindow(state: { now: Date }): void {
  state.now = new Date(state.now.getTime() + 61_000)
}

function createClaimedRun(
  store: PegasStore,
  userId: string,
  workerId: string,
  workspace: string,
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

function settleRun(store: PegasStore, workspace: string): void {
  const claimed = createClaimedRun(store, 'owner', 'worker', workspace)
  store.completeRun(claimed.run.id, 'worker', {
    executorRef: 'session',
    output: '实现完成，pnpm check 全绿后合并，回归全部通过',
  })
}

describe('project-scoped local memory (MEMORY-001 M3)', () => {
  it('a settled Run registers its project and recall from a linked worktree hits the same facts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pegas-project-memory-'))
    try {
      const main = join(root, 'main')
      const worktree = join(root, 'linked')
      initRepository(main, 'git@github.com:xv44586/pegas.git')
      git(main, 'worktree', 'add', '-q', worktree)
      const time = { now: new Date('2026-11-25T00:00:00.000Z') }
      const { store, service } = setup({ now: () => time.now })
      settleRun(store, main)
      advancePastWindow(time)
      await processNextDerivedMemoryJob(store, service, 'memory-worker')
      await processNextDerivedMemoryJob(store, service, 'memory-worker')

      const project = store.memoryProjectForWorkspace('owner', worktree)
      expect(project?.canonicalKey).toBe('git:github.com/xv44586/pegas')
      const recalled = await service.recall({
        userId: 'owner',
        taskId: 'next-task',
        runId: 'next-run',
        query: 'pnpm check gate',
        workingDirectory: worktree,
        ...(project ? { projectKey: project.canonicalKey } : {}),
      })
      expect(recalled.entries).toHaveLength(1)
      store.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('project facts never enter the global bank and never leak into another project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pegas-project-scope-'))
    try {
      const projectA = join(root, 'a')
      const projectB = join(root, 'b')
      initRepository(projectA, 'git@github.com:example/a.git')
      initRepository(projectB, 'git@github.com:example/b.git')
      const time = { now: new Date('2026-11-25T00:00:00.000Z') }
      const { store, service } = setup({
        now: () => time.now,
        candidates: [
          {
            // The model claims global, but the fact was learned inside a
            // project: it must stay project-scoped.
            text: 'The pnpm check gate must pass before merging any feature.',
            type: 'experience',
            scope: 'global',
          },
        ],
      })
      settleRun(store, projectA)
      advancePastWindow(time)
      await processNextDerivedMemoryJob(store, service, 'memory-worker')
      await processNextDerivedMemoryJob(store, service, 'memory-worker')

      const facts = store.listLocalDerivedMemories('owner')
      expect(facts).toHaveLength(1)
      expect(facts[0]?.projectKey).toBe('git:github.com/example/a')
      expect(facts[0]?.tags).not.toContain('pegas:global')

      const projectBKey = store.memoryProjectForWorkspace('owner', projectB)
      const fromB = await service.recall({
        userId: 'owner',
        taskId: 'task-b',
        runId: 'run-b',
        query: 'pnpm check gate',
        workingDirectory: projectB,
        ...(projectBKey ? { projectKey: projectBKey.canonicalKey } : {}),
      })
      expect(fromB.entries).toHaveLength(0)
      store.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the default workspace creates no project and keeps global scope available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pegas-project-default-'))
    try {
      const defaultWorkspace = join(root, 'default')
      mkdirSync(defaultWorkspace)
      const { store, service } = setup({
        defaultWorkspaceRoot: defaultWorkspace,
        candidates: [
          {
            text: '用户偏好中文回复并附带验收证据。',
            type: 'world',
            scope: 'global',
          },
        ],
      })
      settleRun(store, defaultWorkspace)
      await processNextDerivedMemoryJob(store, service, 'memory-worker')
      await processNextDerivedMemoryJob(store, service, 'memory-worker')
      expect(
        store.memoryProjectForWorkspace('owner', defaultWorkspace),
      ).toBeUndefined()
      const facts = store.listLocalDerivedMemories('owner')
      expect(facts).toHaveLength(1)
      expect(facts[0]?.projectKey).toBeUndefined()
      expect(facts[0]?.tags).toContain('pegas:global')
      store.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('retain coalescing window (MEMORY-001 M3)', () => {
  it('sibling project jobs distill in one call and settle together', async () => {
    let now = new Date('2026-11-25T00:00:00.000Z')
    const { store, service, calls } = setup({ now: () => now })
    // Two settled Runs in one project enqueue two jobs.
    const root = mkdtempSync(join(tmpdir(), 'pegas-coalesce-'))
    try {
      const project = join(root, 'repo')
      initRepository(project, 'git@github.com:example/a.git')
      settleRun(store, project)
      settleRun(store, project)
      // Inside the window nothing is claimed.
      expect(await processNextDerivedMemoryJob(store, service, 'mw')).toBe(
        false,
      )
      expect(calls).toHaveLength(0)
      // Window ages out: one claim distills both Runs in one model call.
      now = new Date(now.getTime() + 61_000)
      expect(await processNextDerivedMemoryJob(store, service, 'mw')).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.evidence).toContain('--- Run ')
      // Both jobs share the operation and complete on the next poll.
      expect(await processNextDerivedMemoryJob(store, service, 'mw')).toBe(true)
      expect(store.claimNextDerivedMemoryJob('mw', 30_000)).toBeUndefined()
      expect(store.listLocalDerivedMemories('owner')).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
      store.close()
    }
  })

  it('deleting a batch fact suppresses re-distillation from every contributing Run', async () => {
    let now = new Date('2026-11-25T00:00:00.000Z')
    const { store, service } = setup({ now: () => now })
    const root = mkdtempSync(join(tmpdir(), 'pegas-coalesce-tomb-'))
    try {
      const project = join(root, 'repo')
      initRepository(project, 'git@github.com:example/a.git')
      settleRun(store, project)
      settleRun(store, project)
      now = new Date(now.getTime() + 61_000)
      await processNextDerivedMemoryJob(store, service, 'mw')
      await processNextDerivedMemoryJob(store, service, 'mw')
      const [fact] = store.listLocalDerivedMemories('owner')
      if (!fact) throw new Error('Expected one distilled fact')
      const sourceRunIds = fact.metadata.source_run_ids
      expect(Array.isArray(sourceRunIds)).toBe(true)
      expect((sourceRunIds as string[]).length).toBe(2)
      store.tombstoneDerivedMemory('owner', fact.id, 'user deleted')
      store.invalidateLocalDerivedMemory('owner', fact.id, 'user deleted')
      // Re-settling either contributing Run must not revive the fact.
      for (const runId of sourceRunIds as string[]) {
        expect(
          store.isDerivedMemorySuppressed('owner', {
            id: 'rebuilt',
            text: fact.text,
            type: 'experience',
            tags: [],
            metadata: { run_id: runId },
          }),
        ).toBe(true)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
      store.close()
    }
  })

  it('a batch transport failure retries every member with its own budget', async () => {
    let now = new Date('2026-11-25T00:00:00.000Z')
    const store = new PegasStore(':memory:', {
      derivedMemoryEnabled: true,
      clock: { now: () => now },
    })
    let failures = 0
    const provider = new LocalDerivedMemoryProvider(store, {
      hmacKey: HMAC_KEY,
      distill: () => {
        failures += 1
        return Promise.reject(new Error('429 rate limited'))
      },
    })
    const service = new PegasDerivedMemoryService(provider, {
      hmacKey: HMAC_KEY,
      providerName: 'local',
    })
    const root = mkdtempSync(join(tmpdir(), 'pegas-coalesce-retry-'))
    try {
      const project = join(root, 'repo')
      initRepository(project, 'git@github.com:example/a.git')
      settleRun(store, project)
      settleRun(store, project)
      now = new Date(now.getTime() + 61_000)
      expect(await processNextDerivedMemoryJob(store, service, 'mw')).toBe(true)
      expect(failures).toBe(1)
      // Both members are parked for retry, neither lost nor completed.
      now = new Date(now.getTime() + 2_000)
      expect(await processNextDerivedMemoryJob(store, service, 'mw')).toBe(true)
      expect(failures).toBe(2)
      expect(store.listLocalDerivedMemories('owner')).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
      store.close()
    }
  })
})
