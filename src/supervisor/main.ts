import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { ReleaseRef } from '../core/domain.js'
import { ensureInstanceBearer } from '../core/instance-token.js'
import { createDatabaseBackup } from '../storage/backup.js'
import {
  readCandidateManifest,
  verifyCandidateManifest,
} from './candidate-manifest.js'
import { verifyCandidateReleaseTree } from '../self-change/candidate-builder.js'
import { createRecoveryServer } from './recovery-server.js'
import { createLogger } from '../observability/logger.js'
import {
  assertMigrationApproval,
  liveSchemaVersion,
  rehearseMigrations,
} from './migration-approval.js'
import { pendingDestructiveMigrations } from '../storage/migration-policy.js'
import { ReleaseStateStore } from './release-state.js'
import {
  assertRollbackCompatible,
  RollbackUnavailableError,
} from './rollback-compatibility.js'
import { LifecycleTransitionBarrier } from './lifecycle-transition.js'
import { performRollbackTransition } from './rollback-transition.js'
import { resolveSupervisorRuntimePaths } from './runtime-paths.js'
import { acquireSupervisorInstanceLock } from './instance-lock.js'
import {
  childHasExited,
  onceChildExited,
  stopChildProcesses,
} from './child-lifecycle.js'

const statePath = resolve(
  process.env.PEGAS_SUPERVISOR_STATE ?? './data/supervisor.json',
)
const { dataDir, databasePath } = resolveSupervisorRuntimePaths(
  process.env.PEGAS_DATA_DIR,
)
const instanceLock = acquireSupervisorInstanceLock(dataDir)
ensureInstanceBearer({ dataDir, environment: process.env })
const recoveryHost = process.env.PEGAS_RECOVERY_HOST ?? '127.0.0.1'
const recoveryPort = positiveInteger(process.env.PEGAS_RECOVERY_PORT, 4318)
const recoveryToken =
  process.env.PEGAS_RECOVERY_TOKEN ?? process.env.PEGAS_API_TOKEN
const startupGraceMs = positiveInteger(
  process.env.PEGAS_STARTUP_GRACE_MS,
  15_000,
)
const stabilizationMs = positiveInteger(
  process.env.PEGAS_STABILIZATION_MS,
  10_000,
)
const apiHost = process.env.PEGAS_API_HOST ?? '127.0.0.1'
const apiPort = positiveInteger(process.env.PEGAS_API_PORT, 4317)

if (!isLoopback(recoveryHost) && !recoveryToken) {
  throw new Error(
    'PEGAS_RECOVERY_TOKEN is required when recovery API is not loopback-only',
  )
}

const logger = createLogger({ service: 'supervisor' })
const state = new ReleaseStateStore(statePath)
const initialRelease: ReleaseRef = {
  id: process.env.PEGAS_RELEASE_ID ?? 'development',
  root: resolve(process.env.PEGAS_RELEASE_ROOT ?? '.'),
  ...(process.env.PEGAS_RELEASE_COMMIT
    ? { commit: process.env.PEGAS_RELEASE_COMMIT }
    : {}),
  createdAt: new Date().toISOString(),
}
try {
  state.ensure(initialRelease)
} catch (error) {
  logger.error('supervisor.state_unavailable', error, {
    message:
      'Supervisor release state is unavailable; recovery API will remain online',
  })
}

let children: ChildProcess[] = []
const lifecycle = { restartRequested: false, stopRequested: false }
const lifecycleTransitions = new LifecycleTransitionBarrier()

const recoveryServer = createRecoveryServer({
  state,
  ...(recoveryToken ? { token: recoveryToken } : {}),
  onRestart: () =>
    lifecycleTransitions.begin(async () => {
      lifecycle.restartRequested = true
      await stopChildren()
    }),
  onStage: async input =>
    lifecycleTransitions.begin(async () => {
      const manifest = readCandidateManifest(input.manifestPath)
      verifyCandidateManifest(
        manifest,
        input.artifactPath,
        input.reviewReportPath,
      )
      verifyCandidateReleaseTree(manifest.release.root, input.artifactPath)
      const current = state.read()
      const currentMaximum = current.active.compatibility?.maximumSchema
      if (
        currentMaximum !== undefined &&
        manifest.compatibility.minimumSchema > currentMaximum
      ) {
        throw new Error(
          'Candidate minimum schema exceeds the active release compatibility',
        )
      }
      const destructive = assertMigrationApproval({
        databasePath,
        releaseId: manifest.release.id,
        targetMaximumSchema: manifest.compatibility.maximumSchema,
        ...(manifest.compatibility.destructiveMigrations
          ? {
              declaredMigrations: manifest.compatibility.destructiveMigrations,
            }
          : {}),
        ...(input.migrationApproval ? { grant: input.migrationApproval } : {}),
      })
      if (destructive.length > 0) {
        // Prove the migration on a verified copy and keep a fresh backup
        // before the switch; the live database is not touched here.
        await rehearseMigrations({
          databasePath,
          backupDirectory: resolve(
            process.env.PEGAS_BACKUP_DIR ?? join(dataDir, 'backups'),
          ),
        })
      }
      lifecycle.restartRequested = true
      await stopChildren()
      state.stage(manifest, input.artifactPath, input.reviewReportPath)
    }),
  onRollback: reason =>
    lifecycleTransitions.begin(() =>
      performRollbackTransition({
        stopChildren,
        assertRollbackAllowed,
        rollback: () => state.rollback(reason),
        requestRestart: () => {
          lifecycle.restartRequested = true
        },
      }).then(() => undefined),
    ),
})

recoveryServer.listen(recoveryPort, recoveryHost, () => {
  logger.info('recovery.listening', {
    host: recoveryHost,
    port: recoveryPort,
    message: `Pegas recovery API listening on http://${recoveryHost}:${String(recoveryPort)}`,
  })
})

process.on('SIGINT', () => requestStop('SIGINT'))
process.on('SIGTERM', () => requestStop('SIGTERM'))

while (!lifecycle.stopRequested) {
  await lifecycleTransitions.wait()
  // A termination signal can arrive while a rollback/restart transition owns
  // the barrier. Do not start another release after that transition finishes.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (lifecycle.stopRequested) break
  lifecycle.restartRequested = false
  const inspection = state.inspect()
  if (!inspection.state) {
    await wait(1000)
    continue
  }
  const release = inspection.state.active
  logger.info('release.starting', {
    releaseId: release.id,
    message: `Starting Pegas release ${release.id} from ${release.root}`,
  })

  // A restart must never bypass the dedicated destructive-migration
  // approval, even if the state file was staged by an older Supervisor.
  const targetMaximumSchema = release.compatibility?.maximumSchema
  if (targetMaximumSchema !== undefined) {
    const destructive = pendingDestructiveMigrations(
      liveSchemaVersion(databasePath),
      targetMaximumSchema,
    )
    if (destructive.length > 0) {
      logger.error('release.migration_approval_missing', undefined, {
        releaseId: release.id,
        versions: destructive,
        message: `Release ${release.id} requires unapproved destructive migrations: ${destructive.join(', ')}`,
      })
      await stopChildren()
      await recoverFromFailure(
        `Release ${release.id} requires a dedicated migration approval`,
      )
      await wait(1000)
      continue
    }
  }

  if (existsSync(databasePath)) {
    try {
      const created = await createDatabaseBackup(
        databasePath,
        resolve(process.env.PEGAS_BACKUP_DIR ?? join(dataDir, 'backups')),
      )
      logger.info('backup.verified', {
        message: `Pre-start database backup verified: ${created.path}`,
      })
    } catch (error) {
      logger.error('backup.failed', error, {
        message: 'Pre-start database backup failed; continuing',
      })
    }
  }

  const controlPlane = startProcess(release, 'control-plane/main.js')
  children = [controlPlane]
  const healthy = await waitForHealth(controlPlane, startupGraceMs)

  if (!healthy) {
    if (restartWasRequested()) {
      await lifecycleTransitions.wait()
      continue
    }
    await stopChildren()
    await recoverFromFailure(
      `Release ${release.id} failed its startup health check`,
    )
    await wait(1000)
    continue
  }

  const worker = startProcess(release, 'worker/main.js')
  const scheduler = startProcess(release, 'scheduler/main.js')
  const reconciliation = startProcess(
    release,
    'observability/reconciliation-main.js',
  )
  const dispatcher =
    process.env.PEGAS_PUSH_MODE === 'webhook'
      ? startProcess(release, 'notification/main.js')
      : undefined
  children = [
    controlPlane,
    worker,
    scheduler,
    reconciliation,
    ...(dispatcher ? [dispatcher] : []),
  ]

  if (state.read().phase === 'verifying') {
    const stable = await staysAlive(children, stabilizationMs)
    if (!stable) {
      if (restartWasRequested()) {
        await lifecycleTransitions.wait()
        continue
      }
      await stopChildren()
      await recoverFromFailure(
        `Release ${release.id} failed during stabilization`,
      )
      continue
    }
    state.confirm()
    logger.info('release.stabilized', {
      releaseId: release.id,
      message: `Release ${release.id} passed stabilization`,
    })
  }

  await Promise.race(children.map(child => onceChildExited(child)))
  if (restartWasRequested()) {
    await lifecycleTransitions.wait()
    continue
  }
  // These flags can change in signal and recovery API callbacks while awaiting child exit.
  if (!stopWasRequested() && !restartWasRequested()) {
    await stopChildren()
    state.recordFailure(
      `A process in release ${release.id} exited unexpectedly`,
    )
    if (process.env.PEGAS_SUPERVISOR_RESTART === 'disabled') {
      // Desktop app-lifecycle mode: an unexpected business-process death is
      // terminal for this run. Exit honestly so the shell can show its failure
      // page instead of silently resurrecting services the user quit.
      logger.error('supervisor.exiting_after_failure', undefined, {
        releaseId: release.id,
        message: 'Automatic restart is disabled; supervisor exiting',
      })
      break
    }
    await wait(1000)
  }
}

await stopChildren()
await new Promise<void>(resolveClose =>
  recoveryServer.close(() => resolveClose()),
)
instanceLock.release()

function startProcess(release: ReleaseRef, entrypoint: string): ChildProcess {
  const child = spawn(
    process.execPath,
    [resolve(release.root, 'dist', entrypoint)],
    {
      cwd: release.root,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PEGAS_DATA_DIR: dataDir,
        PEGAS_RELEASE_ID: release.id,
      },
      stdio: 'inherit',
    },
  )
  return child
}

function restartWasRequested(): boolean {
  // Recovery callbacks can mutate this flag while the main loop awaits I/O.
  return lifecycle.restartRequested
}

function stopWasRequested(): boolean {
  // Signal handlers can mutate this flag while the main loop awaits I/O.
  return lifecycle.stopRequested
}

async function waitForHealth(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (
    Date.now() < deadline &&
    child.exitCode === null &&
    !lifecycle.stopRequested
  ) {
    try {
      const response = await fetch(
        `http://${apiHost}:${String(apiPort)}/readyz`,
        {
          signal: AbortSignal.timeout(1000),
        },
      )
      if (response.ok) return true
    } catch {
      // The process is still within its startup grace period.
    }
    await wait(250)
  }
  return false
}

async function staysAlive(
  processes: ChildProcess[],
  durationMs: number,
): Promise<boolean> {
  const exited = await Promise.race([
    Promise.race(processes.map(child => onceChildExited(child))).then(
      () => true,
    ),
    wait(durationMs).then(() => false),
  ])
  return !exited && processes.every(child => !childHasExited(child))
}

async function recoverFromFailure(reason: string): Promise<void> {
  const current = state.read()
  if (current.phase === 'verifying' && current.previous) {
    try {
      assertRollbackAllowed()
      const rolledBack = state.rollback(reason)
      logger.error('release.rolling_back', undefined, {
        releaseId: rolledBack.active.id,
        message: `${reason}; rolling back to ${rolledBack.active.id}`,
      })
    } catch (error) {
      state.recordFailure(
        `${reason}; rollback blocked: ${error instanceof Error ? error.message : String(error)}`,
      )
      logger.error('release.rollback_blocked', error, {
        message: `${reason}; rollback was blocked`,
      })
    }
  } else {
    state.recordFailure(reason)
    logger.error('release.restarting', undefined, {
      message: `${reason}; restarting the active release`,
    })
  }
  await Promise.resolve()
}

function assertRollbackAllowed(): void {
  const current = state.read()
  if (!current.previous)
    throw new RollbackUnavailableError(
      'No previous release is available for rollback',
    )
  assertRollbackCompatible(
    databasePath,
    current.previous.compatibility?.maximumSchema ?? 17,
  )
}

async function stopChildren(): Promise<void> {
  await stopChildProcesses(children)
  children = []
}

function requestStop(signal: string): void {
  logger.info('service.stopping', {
    signal,
    message: `Received ${signal}; stopping supervisor`,
  })
  lifecycle.stopRequested = true
  void stopChildren()
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error('Expected a positive integer')
  return parsed
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
}
