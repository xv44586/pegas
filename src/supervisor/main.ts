import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'

import type { ReleaseRef } from '../core/domain.js'
import { createRecoveryServer } from './recovery-server.js'
import { ReleaseStateStore } from './release-state.js'
import {
  assertRollbackCompatible,
  RollbackUnavailableError,
} from './rollback-compatibility.js'
import { LifecycleTransitionBarrier } from './lifecycle-transition.js'
import { performRollbackTransition } from './rollback-transition.js'
import { resolveSupervisorRuntimePaths } from './runtime-paths.js'

const statePath = resolve(
  process.env.PEGAS_SUPERVISOR_STATE ?? './data/supervisor.json',
)
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
const { dataDir, databasePath } = resolveSupervisorRuntimePaths(
  process.env.PEGAS_DATA_DIR,
)

if (!isLoopback(recoveryHost) && !recoveryToken) {
  throw new Error(
    'PEGAS_RECOVERY_TOKEN is required when recovery API is not loopback-only',
  )
}

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
  console.error(
    'Supervisor release state is unavailable; recovery API will remain online',
    error,
  )
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
  console.log(
    `Pegas recovery API listening on http://${recoveryHost}:${String(recoveryPort)}`,
  )
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
  console.log(`Starting Pegas release ${release.id} from ${release.root}`)

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
  const dispatcher =
    process.env.PEGAS_PUSH_MODE === 'webhook'
      ? startProcess(release, 'notification/main.js')
      : undefined
  children = [controlPlane, worker, ...(dispatcher ? [dispatcher] : [])]

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
    console.log(`Release ${release.id} passed stabilization`)
  }

  await Promise.race(children.map(child => onceExited(child)))
  if (restartWasRequested()) {
    await lifecycleTransitions.wait()
    continue
  }
  // These flags can change in signal and recovery API callbacks while awaiting child exit.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!lifecycle.stopRequested && !lifecycle.restartRequested) {
    await stopChildren()
    state.recordFailure(
      `A process in release ${release.id} exited unexpectedly`,
    )
    await wait(1000)
  }
}

await stopChildren()
await new Promise<void>(resolveClose =>
  recoveryServer.close(() => resolveClose()),
)

function startProcess(release: ReleaseRef, entrypoint: string): ChildProcess {
  const child = spawn(
    process.execPath,
    [resolve(release.root, 'dist', entrypoint)],
    {
      cwd: release.root,
      env: { ...process.env, PEGAS_DATA_DIR: dataDir },
      stdio: 'inherit',
    },
  )
  return child
}

function restartWasRequested(): boolean {
  // Recovery callbacks can mutate this flag while the main loop awaits I/O.
  return lifecycle.restartRequested
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
    Promise.race(processes.map(child => onceExited(child))).then(() => true),
    wait(durationMs).then(() => false),
  ])
  return !exited && processes.every(child => child.exitCode === null)
}

async function recoverFromFailure(reason: string): Promise<void> {
  const current = state.read()
  if (current.phase === 'verifying' && current.previous) {
    try {
      assertRollbackAllowed()
      const rolledBack = state.rollback(reason)
      console.error(`${reason}; rolling back to ${rolledBack.active.id}`)
    } catch (error) {
      state.recordFailure(
        `${reason}; rollback blocked: ${error instanceof Error ? error.message : String(error)}`,
      )
      console.error(`${reason}; rollback was blocked`, error)
    }
  } else {
    state.recordFailure(reason)
    console.error(`${reason}; restarting the active release`)
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
  const running = children.filter(child => child.exitCode === null)
  for (const child of running) child.kill('SIGTERM')
  await Promise.race([
    Promise.all(running.map(child => onceExited(child))),
    wait(5000),
  ])
  const stubborn = running.filter(child => child.exitCode === null)
  for (const child of stubborn) child.kill('SIGKILL')
  await Promise.all(stubborn.map(child => onceExited(child)))
  children = []
}

function onceExited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise(resolveExit => child.once('exit', () => resolveExit()))
}

function requestStop(signal: string): void {
  console.log(`Received ${signal}; stopping supervisor`)
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
