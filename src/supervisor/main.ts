import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'

import type { ReleaseRef } from '../core/domain.js'
import { createRecoveryServer } from './recovery-server.js'
import { ReleaseStateStore } from './release-state.js'

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
state.ensure(initialRelease)

let children: ChildProcess[] = []
const lifecycle = { restartRequested: false, stopRequested: false }

const recoveryServer = createRecoveryServer({
  state,
  ...(recoveryToken ? { token: recoveryToken } : {}),
  onRestart: async () => {
    lifecycle.restartRequested = true
    await stopChildren()
  },
  onRollback: async reason => {
    state.rollback(reason)
    lifecycle.restartRequested = true
    await stopChildren()
  },
})

recoveryServer.listen(recoveryPort, recoveryHost, () => {
  console.log(
    `Pegas recovery API listening on http://${recoveryHost}:${String(recoveryPort)}`,
  )
})

process.on('SIGINT', () => requestStop('SIGINT'))
process.on('SIGTERM', () => requestStop('SIGTERM'))

while (!lifecycle.stopRequested) {
  lifecycle.restartRequested = false
  const release = state.read().active
  console.log(`Starting Pegas release ${release.id} from ${release.root}`)

  const controlPlane = startProcess(release, 'control-plane/main.js')
  children = [controlPlane]
  const healthy = await waitForHealth(controlPlane, startupGraceMs)

  if (!healthy) {
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
      env: process.env,
      stdio: 'inherit',
    },
  )
  return child
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
    const rolledBack = state.rollback(reason)
    console.error(`${reason}; rolling back to ${rolledBack.active.id}`)
  } else {
    state.recordFailure(reason)
    console.error(`${reason}; restarting the active release`)
  }
  await Promise.resolve()
}

async function stopChildren(): Promise<void> {
  const running = children.filter(child => child.exitCode === null)
  for (const child of running) child.kill('SIGTERM')
  await Promise.race([
    Promise.all(running.map(child => onceExited(child))),
    wait(5000),
  ])
  for (const child of running) {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
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
