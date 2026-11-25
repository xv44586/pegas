import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../src/executor/executor.js'
import { ModelTaskRouter } from '../src/router/router.js'
import type { JsonModelProvider } from '../src/model/provider.js'
import {
  buildSelfChangeCandidate,
  materializeCandidateDependencies,
  verifyCandidateReleaseTree,
} from '../src/self-change/candidate-builder.js'
import { SelfChangeExecutor } from '../src/self-change/self-change-executor.js'
import { SelfChangeRoutingExecutor } from '../src/self-change/routing-executor.js'
import { createControlPlane } from '../src/control-plane/server.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import { createRecoveryServer } from '../src/supervisor/recovery-server.js'
import { ReleaseStateStore } from '../src/supervisor/release-state.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('SELF-001 self-change Task intake', () => {
  it('marks Pegas-repository tasks from the model router and persists them immutably', async () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const router = new ModelTaskRouter({
      provider: new StubProvider({
        kind: 'create_task',
        taskId: '',
        title: '给 Pegas 增加导出按钮',
        goal: '在封板 UI 中增加导出按钮',
        reason: 'The user asks to change Pegas itself.',
        targetResource: 'pegas_repository',
      }),
    })
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '给 Pegas 自己加一个导出按钮' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(router, 'echo'),
      'worker-self-intake',
    )
    const task = store.listTasks('owner')[0]
    expect(task?.targetResource).toBe('pegas_repository')
    const database = new PegasStore(':memory:')
    cleanups.push(() => database.close())
    expect(() =>
      database.applyRoutingDecision(
        database.enqueueEvent({
          userId: 'owner',
          type: 'user.message',
          source: 'automation',
          payload: { text: '机器要求修改 Pegas' },
        }).event,
        {
          kind: 'create_task',
          title: 'machine self change',
          goal: 'machine self change',
          input: 'machine self change',
          reason: 'machine',
          targetResource: 'pegas_repository',
        },
        'echo',
      ),
    ).toThrow(/authenticated human/)
  })

  it('dispatches only pegas_repository Runs to the self-change executor', async () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const selfEvent = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '修改 Pegas 自身' },
    }).event
    store.applyRoutingDecision(
      selfEvent,
      {
        kind: 'create_task',
        title: '修改 Pegas 自身',
        goal: '修改 Pegas 自身',
        input: '修改 Pegas 自身',
        reason: 'self',
        targetResource: 'pegas_repository',
      },
      'echo',
    )
    const plainEvent = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '普通工作' },
    }).event
    store.applyRoutingDecision(
      plainEvent,
      {
        kind: 'create_task',
        title: '普通工作',
        goal: '普通工作',
        input: '普通工作',
        reason: 'plain',
      },
      'echo',
    )
    const defaultExecutor = new TaggedExecutor('default')
    const selfExecutor = new TaggedExecutor('self')
    const dispatcher = new SelfChangeRoutingExecutor(
      store,
      defaultExecutor,
      selfExecutor,
    )
    const first = store.claimNextRun('worker-dispatch')
    if (!first) throw new Error('Expected first Run')
    await dispatcher.execute(runInput(first.run.id, first.task.id))
    expect(selfExecutor.calls).toBe(1)
    expect(defaultExecutor.calls).toBe(0)
    store.completeRun(first.run.id, 'worker-dispatch', {
      executorRef: 's',
      output: 'done',
    })
    const second = store.claimNextRun('worker-dispatch')
    if (!second) throw new Error('Expected second Run')
    await dispatcher.execute(runInput(second.run.id, second.task.id))
    expect(defaultExecutor.calls).toBe(1)
    expect(selfExecutor.calls).toBe(1)
  })
})

describe('SELF-001 candidate builder', () => {
  it('builds an immutable candidate from an isolated worktree at its exact commit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-self-build-'))
    cleanups.push(() => {
      restoreWritable(directory)
      rmSync(directory, { recursive: true, force: true })
    })
    const repository = join(directory, 'repo')
    initRepository(repository)
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'second base'], {
      cwd: repository,
    })
    const worktree = join(directory, 'worktree')
    execFileSync('git', ['worktree', 'add', '-b', 'self/test', worktree], {
      cwd: repository,
    })
    mkdirSync(join(worktree, 'node_modules'))
    writeFileSync(join(worktree, 'dist/change.txt'), 'candidate change\n')
    for (const tree of ['src', 'dist']) {
      const path = join(worktree, tree, 'supervisor')
      mkdirSync(path, { recursive: true })
      writeFileSync(
        join(path, 'task-workflow-contract.json'),
        JSON.stringify({ version: 1, maximumSchema: 56 }),
      )
    }

    execFileSync('git', ['add', '-A'], { cwd: worktree })
    execFileSync('git', ['commit', '-m', 'self change'], { cwd: worktree })
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktree,
      encoding: 'utf8',
    }).trim()

    const built = await buildSelfChangeCandidate({
      worktree,
      outputRoot: join(directory, 'candidates'),
      releaseId: 'self-test-1',
      featureIds: ['SELF-001'],
      compatibility: { minimumSchema: 1, maximumSchema: 25 },
      reviewer: 'test-reviewer',
      runGate: () =>
        Promise.resolve({
          commands: [{ command: 'pnpm check', testCount: 5 }],
          smoke: {
            command: 'pnpm smoke',
            status: 'passed',
            completedAt: new Date().toISOString(),
          },
        }),
    })
    expect(built.manifest.compatibility.taskWorkflowVersion).toBe(1)
    expect(built.manifest.release.commit).toBe(commit)
    expect(built.manifest.verification.testedCommit).toBe(commit)
    expect(
      readFileSync(join(built.releaseRoot, 'dist/change.txt'), 'utf8'),
    ).toBe('candidate change\n')
    // The active checkout was never touched.
    expect(readFileSync(join(repository, 'dist/change.txt'), 'utf8')).toBe(
      'base\n',
    )
    // Frozen files are read-only.
    expect(
      statSync(join(built.releaseRoot, 'dist/change.txt')).mode & 0o222,
    ).toBe(0)
    verifyCandidateReleaseTree(built.releaseRoot, built.artifactPath)

    // Tampering with the frozen tree is detected before staging.
    chmodSync(join(built.releaseRoot, 'dist/change.txt'), 0o644)
    writeFileSync(join(built.releaseRoot, 'dist/change.txt'), 'tampered\n')
    expect(() =>
      verifyCandidateReleaseTree(built.releaseRoot, built.artifactPath),
    ).toThrow(/attestation/)
  })

  it('refuses dirty worktrees and duplicate release directories', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-self-dirty-'))
    cleanups.push(() => {
      restoreWritable(directory)
      rmSync(directory, { recursive: true, force: true })
    })
    const repository = join(directory, 'repo')
    initRepository(repository)
    writeFileSync(join(repository, 'uncommitted.txt'), 'dirty')
    await expect(
      buildSelfChangeCandidate({
        worktree: repository,
        outputRoot: join(directory, 'candidates'),
        releaseId: 'self-dirty',
        featureIds: ['SELF-001'],
        compatibility: { minimumSchema: 1, maximumSchema: 25 },
        reviewer: 'test-reviewer',
        runGate: () =>
          Promise.resolve({
            commands: [{ command: 'pnpm check', testCount: 1 }],
            smoke: {
              command: 'pnpm smoke',
              status: 'passed',
              completedAt: new Date().toISOString(),
            },
          }),
      }),
    ).rejects.toThrow(/uncommitted/)
  })

  it('materializes candidate dependencies so the release survives worktree cleanup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-self-materialize-'))
    cleanups.push(() => {
      restoreWritable(directory)
      rmSync(directory, { recursive: true, force: true })
    })
    const repository = join(directory, 'repo')
    initRepository(repository)
    const worktree = join(directory, 'worktree')
    execFileSync(
      'git',
      ['worktree', 'add', '-b', 'self/materialize', worktree],
      {
        cwd: repository,
      },
    )
    mkdirSync(join(worktree, 'node_modules'), { recursive: true })
    mkdirSync(join(worktree, 'node_modules/dep'), { recursive: true })
    writeFileSync(
      join(worktree, 'node_modules/dep/index.js'),
      'module.exports={}\n',
    )
    writeFileSync(join(worktree, 'dist/change.txt'), 'materialize\n')
    execFileSync('git', ['add', '-A'], { cwd: worktree })
    execFileSync('git', ['commit', '-qm', 'materialize'], { cwd: worktree })

    const outputRoot = join(directory, 'candidates')
    const built = await buildSelfChangeCandidate({
      worktree,
      outputRoot,
      releaseId: 'self-materialize-1',
      featureIds: ['SELF-001'],
      compatibility: { minimumSchema: 1, maximumSchema: 25 },
      reviewer: 'test-reviewer',
      runGate: () =>
        Promise.resolve({
          commands: [{ command: 'pnpm check', testCount: 3 }],
          smoke: {
            command: 'pnpm smoke',
            status: 'passed',
            completedAt: new Date().toISOString(),
          },
        }),
    })
    // Fresh builds point node_modules at the worktree; that link must not
    // be the release's long-term dependency source.
    expect(
      statSync(join(built.releaseRoot, 'node_modules')).isDirectory(),
    ).toBe(true)

    const result = materializeCandidateDependencies({
      releaseRoot: built.releaseRoot,
      artifactPath: built.artifactPath,
      manifestPath: built.manifestPath,
      reviewReportPath: built.reviewReportPath,
      dependencyRoot: join(directory, 'dependencies', 'self-materialize-1'),
    })
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/)
    verifyCandidateReleaseTree(built.releaseRoot, built.artifactPath)

    // The dependency store is read-only and self-contained.
    expect(
      statSync(join(directory, 'dependencies', 'self-materialize-1')).mode &
        0o222,
    ).toBe(0)
    expect(
      readFileSync(
        join(directory, 'dependencies', 'self-materialize-1', 'dep/index.js'),
        'utf8',
      ),
    ).toBe('module.exports={}\n')

    // Removing the build worktree must not break the release.
    restoreWritable(worktree)
    rmSync(worktree, { recursive: true, force: true })
    verifyCandidateReleaseTree(built.releaseRoot, built.artifactPath)
    expect(
      readFileSync(
        join(built.releaseRoot, 'node_modules/dep/index.js'),
        'utf8',
      ),
    ).toBe('module.exports={}\n')

    // A second materialization with the same content is idempotent.
    const again = materializeCandidateDependencies({
      releaseRoot: built.releaseRoot,
      artifactPath: built.artifactPath,
      manifestPath: built.manifestPath,
      reviewReportPath: built.reviewReportPath,
      dependencyRoot: join(directory, 'dependencies', 'self-materialize-1'),
    })
    expect(again.digest).toBe(result.digest)
  })
})

describe('SELF-001 supervisor staging API', () => {
  it('requires auth, validates paths and reports missing staging support', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-self-stage-'))
    const state = new ReleaseStateStore(join(directory, 'state.json'))
    state.ensure({
      id: 'active',
      root: '/releases/active',
      createdAt: '2026-11-21T00:00:00.000Z',
    })
    const server = createRecoveryServer({
      state,
      token: 'stage-token',
      onRestart: () => Promise.resolve(),
      onRollback: () => Promise.resolve(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => rmSync(directory, { recursive: true, force: true }),
    )
    const { port } = server.address() as AddressInfo
    const endpoint = `http://127.0.0.1:${String(port)}/v1/recovery/candidates`
    const unauthorized = await fetch(endpoint, { method: 'POST' })
    expect(unauthorized.status).toBe(401)
    const unsupported = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer stage-token' },
      body: JSON.stringify({
        manifestPath: '/m.json',
        artifactPath: '/a.json',
        reviewReportPath: '/r.json',
      }),
    })
    expect(unsupported.status).toBe(409)
    expect(await unsupported.json()).toMatchObject({
      error: 'staging_unavailable',
    })
  })

  it('stages a verified candidate and rejects a tampered one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-self-stage2-'))
    cleanups.push(() => {
      restoreWritable(directory)
      rmSync(directory, { recursive: true, force: true })
    })
    const repository = join(directory, 'repo')
    initRepository(repository)
    const worktree = join(directory, 'worktree')
    execFileSync('git', ['worktree', 'add', '-b', 'self/stage', worktree], {
      cwd: repository,
    })
    mkdirSync(join(worktree, 'node_modules'))
    writeFileSync(join(worktree, 'dist/change.txt'), 'second\n')
    execFileSync('git', ['add', '-A'], { cwd: worktree })
    execFileSync('git', ['commit', '-m', 'change'], { cwd: worktree })
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim()
    const built = await buildSelfChangeCandidate({
      worktree,
      baseCommit: base,
      outputRoot: join(directory, 'candidates'),
      releaseId: 'self-stage-1',
      featureIds: ['SELF-001'],
      compatibility: { minimumSchema: 1, maximumSchema: 25 },
      reviewer: 'test-reviewer',
      runGate: () =>
        Promise.resolve({
          commands: [{ command: 'pnpm check', testCount: 2 }],
          smoke: {
            command: 'pnpm smoke',
            status: 'passed',
            completedAt: new Date().toISOString(),
          },
        }),
    })
    const state = new ReleaseStateStore(join(directory, 'state.json'))
    state.ensure({
      id: 'active',
      root: '/releases/active',
      createdAt: '2026-11-21T00:00:00.000Z',
    })
    const server = createRecoveryServer({
      state,
      onRestart: () => Promise.resolve(),
      onRollback: () => Promise.resolve(),
      onStage: input => {
        verifyCandidateReleaseTree(built.releaseRoot, input.artifactPath)
        state.stage(built.manifest, input.artifactPath, input.reviewReportPath)
        return Promise.resolve()
      },
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const { port } = server.address() as AddressInfo
    const endpoint = `http://127.0.0.1:${String(port)}/v1/recovery/candidates`
    const invalid = await fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({ manifestPath: 'relative.json' }),
    })
    expect(invalid.status).toBe(400)
    const accepted = await fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        manifestPath: built.manifestPath,
        artifactPath: built.artifactPath,
        reviewReportPath: built.reviewReportPath,
      }),
    })
    expect(accepted.status).toBe(202)
    expect(state.read()).toMatchObject({
      phase: 'verifying',
      active: { id: 'self-stage-1' },
      previous: { id: 'active' },
    })

    // Tamper and try to stage a second candidate built from the same tree.
    chmodSync(join(built.releaseRoot, 'dist/change.txt'), 0o644)
    writeFileSync(join(built.releaseRoot, 'dist/change.txt'), 'tampered\n')
    const rejected = await fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        manifestPath: built.manifestPath,
        artifactPath: built.artifactPath,
        reviewReportPath: built.reviewReportPath,
      }),
    })
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({
      error: 'candidate_rejected',
    })
  })
})

describe('SELF-001 executor approval loop', () => {
  it('prepares a candidate, requests Approval, then publishes and records the outcome after approval', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-self-loop-'))
    cleanups.push(() => {
      restoreWritable(directory)
      rmSync(directory, { recursive: true, force: true })
    })
    const repository = join(directory, 'repo')
    initRepository(repository)
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => store.close(),
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${String(port)}`

    const editor = new CommittingExecutor()
    let staged: { releaseId: string } | undefined
    const executor = new SelfChangeExecutor({
      repositoryRoot: repository,
      selfChangeRoot: join(directory, 'self-change'),
      recoveryBaseUrl: 'http://127.0.0.1:1',
      editor,
      compatibility: { minimumSchema: 1, maximumSchema: 25 },
      reviewer: 'test-reviewer',
      buildCandidate: request =>
        buildSelfChangeCandidate({
          ...request,
          runGate: () =>
            Promise.resolve({
              commands: [{ command: 'pnpm check', testCount: 3 }],
              smoke: {
                command: 'pnpm smoke',
                status: 'passed',
                completedAt: new Date().toISOString(),
              },
            }),
        }),
      stageCandidate: input => {
        staged = { releaseId: input.manifestPath }
        return Promise.resolve()
      },
      awaitRelease: () => Promise.resolve(),
      installDependencies: worktree => {
        mkdirSync(join(worktree, 'node_modules'))
        return Promise.resolve()
      },
    })

    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '给 Pegas 加导出按钮' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new StaticSelfRouter(), executor.name),
      'worker-self-loop',
    )
    const claimed = store.claimNextRun('worker-self-loop')
    if (!claimed) throw new Error('Expected claimed Run')
    await executeClaimedRun(
      store,
      executor,
      claimed,
      'worker-self-loop',
      repository,
      new AbortController().signal,
      baseUrl,
    )
    const waiting = store.listRuns(claimed.task.id)[0]
    expect(waiting?.lastError).toBeUndefined()
    expect(waiting?.status).toBe('waiting')
    const approval = store
      .pageApprovals('owner', 20)
      .items.find(entry => entry.taskId === claimed.task.id)
    if (!approval) throw new Error('Expected pending approval')
    expect(approval.prompt.summary).toContain('发布 Pegas 候选版本')

    store.decideApproval(approval.id, 'owner', {
      commandId: 'self-approve-1',
      optionId: 'approve',
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new StaticSelfRouter(), executor.name),
      'worker-self-loop',
    )
    const successor = store.claimNextRun('worker-self-loop')
    if (!successor) throw new Error('Expected approval successor Run')
    await executeClaimedRun(
      store,
      executor,
      successor,
      'worker-self-loop',
      repository,
      new AbortController().signal,
      baseUrl,
    )
    expect(staged).toBeDefined()
    const action = store.getAction(approval.actionId, 'owner')
    expect(action?.status).toBe('succeeded')
    const finalRun = store
      .listRuns(claimed.task.id)
      .find(run => run.id === successor.run.id)
    expect(finalRun?.status).toBe('completed')
    expect(finalRun?.output).toContain('接管服务')
  })
})

class StubProvider implements JsonModelProvider {
  readonly name = 'stub'
  readonly #answer: unknown

  constructor(answer: unknown) {
    this.#answer = answer
  }

  generateJson(): Promise<unknown> {
    return Promise.resolve(this.#answer)
  }
}

class StaticSelfRouter extends RuleBasedTaskRouter {
  override route(
    event: Parameters<RuleBasedTaskRouter['route']>[0],
  ): ReturnType<RuleBasedTaskRouter['route']> {
    if (event.type !== 'user.message') return Promise.resolve(undefined)
    const payload = event.payload as { text: string }
    return Promise.resolve({
      kind: 'create_task',
      title: payload.text,
      goal: payload.text,
      input: payload.text,
      reason: 'self-change test',
      targetResource: 'pegas_repository',
    })
  }
}

class TaggedExecutor implements RunExecutor {
  readonly name: string
  calls = 0

  constructor(name: string) {
    this.name = name
  }

  execute(): Promise<ExecutorResult> {
    this.calls += 1
    return Promise.resolve({ executorRef: this.name, output: this.name })
  }
}

class CommittingExecutor implements RunExecutor {
  readonly name = 'committing-editor'

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    writeFileSync(
      join(input.workingDirectory, 'dist/change.txt'),
      'edited by self-change\n',
    )
    execFileSync('git', ['add', '-A'], { cwd: input.workingDirectory })
    execFileSync('git', ['commit', '-m', 'self change edit'], {
      cwd: input.workingDirectory,
    })
    return Promise.resolve({
      executorRef: `editor-${input.runId}`,
      output: '已在隔离 worktree 中完成修改',
    })
  }
}

function runInput(runId: string, taskId: string): ExecutorInput {
  return {
    runId,
    taskId,
    prompt: 'test',
    workingDirectory: process.cwd(),
  }
}

function initRepository(path: string): void {
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: path })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: path,
  })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: path })
  mkdirSync(join(path, 'dist'), { recursive: true })
  mkdirSync(join(path, 'node_modules/dep'), { recursive: true })
  writeFileSync(join(path, 'dist/change.txt'), 'base\n')
  writeFileSync(join(path, 'package.json'), '{"name":"fixture"}\n')
  writeFileSync(join(path, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(path, 'node_modules/dep/index.js'), 'module.exports={}\n')
  writeFileSync(join(path, '.gitignore'), 'node_modules/\n')
  execFileSync('git', ['add', '-A'], { cwd: path })
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: path })
}

function restoreWritable(directory: string): void {
  execFileSync('chmod', ['-R', 'u+w', directory])
}
