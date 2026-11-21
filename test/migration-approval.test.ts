import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../src/executor/executor.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import { buildSelfChangeCandidate } from '../src/self-change/candidate-builder.js'
import { SelfChangeExecutor } from '../src/self-change/self-change-executor.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import { pendingDestructiveMigrations } from '../src/storage/migration-policy.js'
import {
  createRecoveryServer,
  MigrationApprovalRequiredError,
} from '../src/supervisor/recovery-server.js'
import {
  assertMigrationApproval,
  liveSchemaVersion,
  rehearseMigrations,
} from '../src/supervisor/migration-approval.js'
import { ReleaseStateStore } from '../src/supervisor/release-state.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => {
    restoreWritable(directory)
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

function restoreWritable(directory: string): void {
  execFileSync('chmod', ['-R', 'u+w', directory])
}

/**
 * Creates a pre-v30 database: the outbox table keeps its legacy status CHECK
 * and none of the v30 structures exist, matching a real v29 deployment.
 */
function databaseAtSchema(path: string, version: number): void {
  if (version !== 29) throw new Error('Only the v29 fixture is supported')
  const store = new PegasStore(path)
  store.close()
  const database = new DatabaseSync(path)
  database.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  database.exec(`
    DROP TRIGGER IF EXISTS outbox_messages_merged_guard;
    DROP TRIGGER IF EXISTS outbox_messages_resolved_guard;
    DROP TABLE IF EXISTS outbox_resolutions;
    DROP TABLE IF EXISTS notification_preferences;
    PRAGMA legacy_alter_table = ON;
    ALTER TABLE outbox_messages RENAME TO outbox_v30_tmp;
    PRAGMA legacy_alter_table = OFF;
    CREATE TABLE outbox_messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(id),
      channel TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
      created_at TEXT NOT NULL,
      sent_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT,
      lease_until TEXT,
      next_attempt_at TEXT,
      last_error TEXT,
      updated_at TEXT,
      read_at TEXT
    );
    INSERT INTO outbox_messages
      (id, user_id, task_id, channel, dedupe_key, payload_json, status,
       created_at, sent_at, attempts, claimed_by, lease_until,
       next_attempt_at, last_error, updated_at, read_at)
    SELECT id, user_id, task_id, channel, dedupe_key, payload_json, status,
       created_at, sent_at, attempts, claimed_by, lease_until,
       next_attempt_at, last_error, updated_at, read_at
    FROM outbox_v30_tmp;
    DROP TABLE outbox_v30_tmp;
    DELETE FROM schema_migrations WHERE version >= 30;
  `)
  database.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  database.close()
}

/** Rewinds an existing database file to the pre-v30 shape in place. */
function downgradeToV29(path: string): void {
  const database = new DatabaseSync(path)
  database.exec(`
    DROP TRIGGER IF EXISTS outbox_messages_merged_guard;
    DROP TRIGGER IF EXISTS outbox_messages_resolved_guard;
    DROP TABLE IF EXISTS outbox_resolutions;
    DROP TABLE IF EXISTS notification_preferences;
    PRAGMA legacy_alter_table = ON;
    ALTER TABLE outbox_messages RENAME TO outbox_v30_tmp;
    PRAGMA legacy_alter_table = OFF;
    CREATE TABLE outbox_messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(id),
      channel TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
      created_at TEXT NOT NULL,
      sent_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT,
      lease_until TEXT,
      next_attempt_at TEXT,
      last_error TEXT,
      updated_at TEXT,
      read_at TEXT
    );
    INSERT INTO outbox_messages
      (id, user_id, task_id, channel, dedupe_key, payload_json, status,
       created_at, sent_at, attempts, claimed_by, lease_until,
       next_attempt_at, last_error, updated_at, read_at)
    SELECT id, user_id, task_id, channel, dedupe_key, payload_json, status,
       created_at, sent_at, attempts, claimed_by, lease_until,
       next_attempt_at, last_error, updated_at, read_at
    FROM outbox_v30_tmp;
    DROP TABLE outbox_v30_tmp;
    DELETE FROM schema_migrations WHERE version >= 30;
  `)
  database.close()
}

interface GrantedApproval {
  actionId: string
  approvalId: string
}

/** Requests and approves a dedicated migration Action through real APIs. */
async function approveMigration(
  store: PegasStore,
  baseUrl: string,
  releaseId: string,
  versions: number[],
  decision: 'approve' | 'reject' = 'approve',
): Promise<GrantedApproval> {
  store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: `迁移审批 ${releaseId}` },
  })
  await processNextEvent(
    store,
    new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
    'worker-migration',
  )
  const claimed = store.claimNextRun('worker-migration')
  if (!claimed) throw new Error('Expected claimed Run')
  const requested = await fetch(
    `${baseUrl}/v1/runs/${claimed.run.id}/approvals`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pegas-run-claim-token': claimed.claimToken,
      },
      body: JSON.stringify({
        action: {
          kind: 'self_change.migration',
          risk: 'critical',
          idempotencyKey: `migration:${releaseId}`,
          request: { releaseId, destructiveMigrations: versions },
          recoveryPoint: { step: 'before_destructive_migration' },
          approval: {
            summary: `批准破坏性数据迁移 ${versions.join('、')}`,
            impact: '重建持久表结构',
            recommendedOptionId: 'approve',
            options: [
              { id: 'approve', label: '批准', kind: 'approve' },
              { id: 'reject', label: '拒绝', kind: 'reject' },
            ],
          },
        },
      }),
    },
  )
  if (!requested.ok) throw new Error('Approval request failed')
  const { action, approval } = (await requested.json()) as {
    action: { id: string }
    approval: { id: string }
  }
  store.decideApproval(approval.id, 'owner', {
    commandId: `migration-decision:${releaseId}`,
    optionId: decision,
  })
  await processNextEvent(
    store,
    new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
    'worker-migration',
  )
  return { actionId: action.id, approvalId: approval.id }
}

describe('SELF-001 destructive migration policy', () => {
  it('computes pending destructive migrations from the live schema', () => {
    expect(pendingDestructiveMigrations(29, 30)).toEqual([30])
    expect(pendingDestructiveMigrations(30, 30)).toEqual([])
    expect(pendingDestructiveMigrations(0, 29)).toEqual([])
    expect(pendingDestructiveMigrations(0, 31)).toEqual([30])
  })

  it('requires a dedicated approved grant bound to the release and migrations', async () => {
    const directory = tempDirectory('pegas-migration-policy-')
    const databasePath = join(directory, 'pegas.sqlite')
    databaseAtSchema(databasePath, 29)
    expect(liveSchemaVersion(databasePath)).toBe(29)
    // Approvals are recorded in a durable store, then that exact database
    // file becomes the pre-v30 live database the Supervisor inspects.
    const grantPath = join(directory, 'grants.sqlite')
    const store = new PegasStore(grantPath)
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => {
        try {
          store.close()
        } catch {
          // already closed inside the test
        }
      },
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

    const base = {
      databasePath: grantPath,
      releaseId: 'release-candidate',
      targetMaximumSchema: 30,
    }
    // Without a grant the switch is refused with the pending versions.
    const pristine = { ...base, databasePath }
    expect(() => assertMigrationApproval(pristine)).toThrow(
      MigrationApprovalRequiredError,
    )
    try {
      assertMigrationApproval(pristine)
    } catch (error) {
      expect((error as MigrationApprovalRequiredError).versions).toEqual([30])
    }
    // A candidate cannot declare migrations outside the pending range.
    expect(() =>
      assertMigrationApproval({ ...pristine, declaredMigrations: [28] }),
    ).toThrow(/outside the pending range/)

    const grant = await approveMigration(
      store,
      baseUrl,
      'release-candidate',
      [30],
    )
    store.close()
    // The grant database itself becomes the pre-v30 live database.
    downgradeToV29(grantPath)
    expect(liveSchemaVersion(grantPath)).toBe(29)
    expect(
      assertMigrationApproval({
        ...base,
        declaredMigrations: [30],
        grant,
      }),
    ).toEqual([30])
    // The grant is bound to the exact release id.
    expect(() =>
      assertMigrationApproval({ ...base, releaseId: 'other-release', grant }),
    ).toThrow(/does not match/)
    // A fabricated grant does not pass.
    expect(() =>
      assertMigrationApproval({
        ...base,
        grant: { actionId: 'made-up', approvalId: grant.approvalId },
      }),
    ).toThrow(MigrationApprovalRequiredError)

    // Once the live schema already includes the migration nothing is needed.
    const migratedPath = join(directory, 'migrated.sqlite')
    const migrated = new PegasStore(migratedPath)
    migrated.close()
    expect(
      assertMigrationApproval({
        ...base,
        databasePath: migratedPath,
      }),
    ).toEqual([])
    // Missing database files mean a fresh install: the dedicated approval
    // still applies before the first destructive migration runs.
    expect(() =>
      assertMigrationApproval({
        ...base,
        databasePath: join(directory, 'absent.sqlite'),
      }),
    ).toThrow(MigrationApprovalRequiredError)
  })

  it('rejects a rejected migration approval as a substitute grant', async () => {
    const directory = tempDirectory('pegas-migration-rejected-')
    const databasePath = join(directory, 'pegas.sqlite')
    databaseAtSchema(databasePath, 29)
    const grantPath = join(directory, 'grants.sqlite')
    const store = new PegasStore(grantPath)
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => {
        try {
          store.close()
        } catch {
          // already closed inside the test
        }
      },
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const grant = await approveMigration(
      store,
      baseUrl,
      'release-rejected',
      [30],
      'reject',
    )
    store.close()
    downgradeToV29(grantPath)
    expect(() =>
      assertMigrationApproval({
        databasePath: grantPath,
        releaseId: 'release-rejected',
        targetMaximumSchema: 30,
        grant,
      }),
    ).toThrow(MigrationApprovalRequiredError)
  })

  it('rehearses migrations on a verified copy without touching the live file', async () => {
    const directory = tempDirectory('pegas-migration-rehearsal-')
    const databasePath = join(directory, 'pegas.sqlite')
    databaseAtSchema(databasePath, 29)
    const backupDirectory = join(directory, 'backups')
    await rehearseMigrations({ databasePath, backupDirectory })
    // The live database still reports the old schema; only the copy migrated.
    expect(liveSchemaVersion(databasePath)).toBe(29)
    const backups = readdirSync(backupDirectory)
    expect(backups.some(name => name.endsWith('.manifest.json'))).toBe(true)
    expect(backups.some(name => name.startsWith('migration-rehearsal-'))).toBe(
      false,
    )
    // A missing database is a no-op (fresh install path).
    await rehearseMigrations({
      databasePath: join(directory, 'absent.sqlite'),
      backupDirectory,
    })
  })
})

describe('SELF-001 migration approval staging surface', () => {
  it('maps missing grants to 409 migration_approval_required and passes grants through', async () => {
    const directory = tempDirectory('pegas-migration-recovery-')
    const state = new ReleaseStateStore(join(directory, 'state.json'))
    state.ensure({
      id: 'release-1',
      root: '/releases/release-1',
      createdAt: '2026-11-21T00:00:00.000Z',
    })
    const staged: {
      migrationApproval?: { actionId: string; approvalId: string }
    }[] = []
    let refuse = true
    const server = createRecoveryServer({
      state,
      onRestart: () => Promise.resolve(),
      onRollback: () => Promise.resolve(),
      onStage: input => {
        if (refuse) {
          return Promise.reject(new MigrationApprovalRequiredError([30]))
        }
        staged.push({
          ...(input.migrationApproval
            ? { migrationApproval: input.migrationApproval }
            : {}),
        })
        return Promise.resolve()
      },
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/recovery/candidates`
    const paths = {
      manifestPath: '/candidate/manifest.json',
      artifactPath: '/candidate/release.tar',
      reviewReportPath: '/candidate/review.json',
    }
    const denied = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(paths),
    })
    expect(denied.status).toBe(409)
    expect(await denied.json()).toMatchObject({
      error: 'migration_approval_required',
      versions: [30],
    })

    const invalidGrant = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...paths,
        migrationApproval: { actionId: 'a', approvalId: 3 },
      }),
    })
    expect(invalidGrant.status).toBe(400)

    refuse = false
    const granted = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...paths,
        migrationApproval: { actionId: 'action-1', approvalId: 'approval-1' },
      }),
    })
    expect(granted.status).toBe(202)
    expect(staged).toEqual([
      { migrationApproval: { actionId: 'action-1', approvalId: 'approval-1' } },
    ])
  })
})

describe('SELF-001 executor migration approval loop', () => {
  it('parks staging behind a dedicated approval, then stages with the grant', async () => {
    const directory = tempDirectory('pegas-migration-loop-')
    const repository = join(directory, 'repo')
    initRepository(repository)
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => {
        try {
          store.close()
        } catch {
          // already closed inside the test
        }
      },
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

    const stageCalls: {
      migrationApproval?: { actionId: string; approvalId: string }
    }[] = []
    const executor = new SelfChangeExecutor({
      repositoryRoot: repository,
      selfChangeRoot: join(directory, 'self-change'),
      recoveryBaseUrl: 'http://127.0.0.1:1',
      editor: new CommittingExecutor(),
      compatibility: { minimumSchema: 1, maximumSchema: 30 },
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
        stageCalls.push({
          ...(input.migrationApproval
            ? { migrationApproval: input.migrationApproval }
            : {}),
        })
        if (!input.migrationApproval) {
          return Promise.reject(new MigrationApprovalRequiredError([30]))
        }
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
      payload: { text: '升级 Pegas 数据结构' },
    })
    const handler = new RoutingEventHandler(
      new StaticSelfRouter(),
      executor.name,
    )
    await processNextEvent(store, handler, 'worker-loop')
    const first = store.claimNextRun('worker-loop')
    if (!first) throw new Error('Expected first claim')
    await executeClaimedRun(
      store,
      executor,
      first,
      'worker-loop',
      repository,
      new AbortController().signal,
      baseUrl,
    )
    const publishApproval = store
      .pageApprovals('owner', 20)
      .items.find(entry => entry.taskId === first.task.id)
    if (!publishApproval) throw new Error('Expected publish approval')
    store.decideApproval(publishApproval.id, 'owner', {
      commandId: 'publish-approve',
      optionId: 'approve',
    })
    await processNextEvent(store, handler, 'worker-loop')
    const second = store.claimNextRun('worker-loop')
    if (!second) throw new Error('Expected publish successor')
    await executeClaimedRun(
      store,
      executor,
      second,
      'worker-loop',
      repository,
      new AbortController().signal,
      baseUrl,
    )
    // The publish approval alone never stages a destructive candidate.
    expect(stageCalls).toEqual([{}])
    expect(
      store.listRuns(first.task.id).find(r => r.id === second.run.id),
    ).toMatchObject({ status: 'waiting' })
    const publishAction = store.getAction(publishApproval.actionId, 'owner')
    expect(publishAction?.status).toBe('succeeded')

    const migrationApproval = store
      .pageApprovals('owner', 20)
      .items.find(
        entry =>
          entry.taskId === first.task.id && entry.id !== publishApproval.id,
      )
    if (!migrationApproval) throw new Error('Expected migration approval')
    expect(migrationApproval.prompt.summary).toContain('破坏性数据迁移')
    const migrationAction = store.getAction(migrationApproval.actionId, 'owner')
    expect(migrationAction).toMatchObject({
      kind: 'self_change.migration',
      risk: 'critical',
    })
    expect(migrationAction?.request.destructiveMigrations).toEqual([30])

    store.decideApproval(migrationApproval.id, 'owner', {
      commandId: 'migration-approve',
      optionId: 'approve',
    })
    await processNextEvent(store, handler, 'worker-loop')
    const third = store.claimNextRun('worker-loop')
    if (!third) throw new Error('Expected migration successor')
    await executeClaimedRun(
      store,
      executor,
      third,
      'worker-loop',
      repository,
      new AbortController().signal,
      baseUrl,
    )
    expect(stageCalls[1]?.migrationApproval).toEqual({
      actionId: migrationApproval.actionId,
      approvalId: migrationApproval.id,
    })
    expect(store.getAction(migrationApproval.actionId, 'owner')?.status).toBe(
      'succeeded',
    )
    expect(
      store.listRuns(first.task.id).find(r => r.id === third.run.id)?.status,
    ).toBe('completed')
  })

  it('records a definite failure when a granted migration staging fails', async () => {
    const directory = tempDirectory('pegas-migration-fail-')
    const repository = join(directory, 'repo')
    initRepository(repository)
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => {
        try {
          store.close()
        } catch {
          // already closed inside the test
        }
      },
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const grant = await approveMigration(store, baseUrl, 'release-fail', [30])
    const executor = new SelfChangeExecutor({
      repositoryRoot: repository,
      selfChangeRoot: join(directory, 'self-change'),
      recoveryBaseUrl: 'http://127.0.0.1:1',
      editor: new CommittingExecutor(),
      compatibility: { minimumSchema: 1, maximumSchema: 30 },
      reviewer: 'test-reviewer',
      stageCandidate: () =>
        Promise.reject(new Error('Supervisor rejected the candidate (409)')),
      awaitRelease: () => Promise.resolve(),
    })
    const claimed = store.claimNextRun('worker-fail')
    if (!claimed) throw new Error('Expected claim')
    await executeClaimedRun(
      store,
      executor,
      claimed,
      'worker-fail',
      repository,
      new AbortController().signal,
      baseUrl,
    )
    const action = store.getAction(grant.actionId, 'owner')
    expect(action?.status).toBe('failed')
    expect(action?.result).toMatchObject({
      reason: 'migration_staging_failed',
    })
    expect(
      store.listRuns(claimed.task.id).find(run => run.id === claimed.run.id)
        ?.status,
    ).toBe('failed')
  })
})

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
      reason: 'self-change migration test',
      targetResource: 'pegas_repository',
    })
  }
}

class CommittingExecutor implements RunExecutor {
  readonly name = 'committing-editor'

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    writeFileSync(
      join(input.workingDirectory, 'dist/change.txt'),
      'edited by migration test\n',
    )
    execFileSync('git', ['add', '-A'], { cwd: input.workingDirectory })
    execFileSync('git', ['commit', '-m', 'self-change edit'], {
      cwd: input.workingDirectory,
    })
    return Promise.resolve({
      executorRef: 'editor-session',
      output: 'edited',
    })
  }
}

function initRepository(path: string): void {
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: path })
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
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: path })
}
