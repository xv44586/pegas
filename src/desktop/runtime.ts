import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'

import { defaultAgentWorkspace } from '../core/config.js'
import { ReleaseStateStore } from '../supervisor/release-state.js'

export interface DesktopServiceOptions {
  port: number
  dataDir: string
  apiToken: string
  testMode?: boolean
  environment?: NodeJS.ProcessEnv
}

export function desktopServiceRoot(options: {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, 'app.asar.unpacked')
    : options.appPath
}

/**
 * Hot-release boot: when the Supervisor state names a staged release whose
 * Supervisor entry exists on disk, boot that release instead of the copy
 * bundled inside the app. The app bundle then only carries the Electron
 * shell, and server/web fixes ship as immutable candidates without
 * repackaging. Missing or unreadable state falls back to the bundled
 * release, so a fresh install and a wiped state file still start.
 */
export function desktopSupervisorRoot(options: {
  fallbackRoot: string
  statePath: string
}): string {
  try {
    const inspection = new ReleaseStateStore(options.statePath).inspect()
    const root = inspection.state?.active.root
    if (
      inspection.integrity === 'ok' &&
      root &&
      existsSync(join(root, 'dist', 'supervisor', 'main.js'))
    )
      return root
  } catch {
    // Unreadable state must never block startup; the bundled release runs.
  }
  return options.fallbackRoot
}

export async function terminateDesktopChildren(
  children: ChildProcess[],
  options: {
    graceMs?: number
    finalWaitMs?: number
    signal?: (child: ChildProcess, signal: NodeJS.Signals) => void
  } = {},
): Promise<void> {
  const graceMs = options.graceMs ?? 7_000
  const finalWaitMs = options.finalWaitMs ?? 1_000
  const signal = options.signal ?? signalDesktopChild
  await Promise.all(
    children.map(
      child =>
        new Promise<void>(resolve => {
          if (child.exitCode !== null || child.signalCode !== null) {
            signal(child, 'SIGKILL')
            resolve()
            return
          }
          const timers: {
            force?: NodeJS.Timeout
            settle?: NodeJS.Timeout
          } = {}
          const finish = () => {
            if (timers.force) clearTimeout(timers.force)
            if (timers.settle) clearTimeout(timers.settle)
            child.removeListener('exit', finish)
            resolve()
          }
          child.once('exit', finish)
          signal(child, 'SIGTERM')
          timers.force = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null)
              signal(child, 'SIGKILL')
            timers.settle = setTimeout(finish, finalWaitMs)
          }, graceMs)
        }),
    ),
  )
}

export function signalDesktopChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
  options: {
    platform?: NodeJS.Platform
    killProcess?: (pid: number, signal: NodeJS.Signals) => boolean
  } = {},
): void {
  const platform = options.platform ?? process.platform
  const killProcess =
    options.killProcess ??
    ((pid: number, requestedSignal: NodeJS.Signals) =>
      process.kill(pid, requestedSignal))
  if (platform !== 'win32' && child.pid) {
    try {
      killProcess(-child.pid, signal)
      return
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error)) throw error
    }
  }
  child.kill(signal)
}

export function desktopServiceEnvironment({
  port,
  dataDir,
  apiToken,
  testMode = false,
  environment = process.env,
}: DesktopServiceOptions): NodeJS.ProcessEnv {
  return {
    ...environment,
    ELECTRON_RUN_AS_NODE: '1',
    PEGAS_API_HOST: '127.0.0.1',
    PEGAS_API_PORT: String(port),
    PEGAS_API_TOKEN: apiToken,
    PEGAS_DATA_DIR: dataDir,
    PEGAS_WORKSPACE_ROOT: defaultAgentWorkspace(dataDir),
    PEGAS_PUSH_MODE: 'disabled',
    ...(testMode
      ? {
          PEGAS_EXECUTOR: 'echo',
          PEGAS_ROUTER: 'rules',
          PEGAS_EVENT_POLL_MS: '25',
          PEGAS_SPEECH_PROVIDER: 'disabled',
        }
      : {}),
  }
}

export function desktopRequestHeaders(
  requestUrl: string,
  trustedUrl: string,
  apiToken: string,
  headers: Record<string, string>,
): Record<string, string> {
  if (!isTrustedAppUrl(requestUrl, trustedUrl)) return headers
  return { ...headers, Authorization: `Bearer ${apiToken}` }
}

export function isTrustedAppUrl(candidate: string, appUrl: string): boolean {
  try {
    const candidateUrl = new URL(candidate)
    const trustedUrl = new URL(appUrl)
    return (
      isLoopbackAppUrl(trustedUrl) && candidateUrl.origin === trustedUrl.origin
    )
  } catch {
    return false
  }
}

export function isLoopbackAppUrl(candidate: string | URL): boolean {
  try {
    const url = candidate instanceof URL ? candidate : new URL(candidate)
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    )
  } catch {
    return false
  }
}

export async function availableLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  )
  if (!port) throw new Error('Unable to allocate a loopback port')
  return port
}

export async function waitForControlPlane(
  appUrl: string,
  options: {
    timeoutMs?: number
    intervalMs?: number
    fetcher?: typeof fetch
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const intervalMs = options.intervalMs ?? 75
  const fetcher = options.fetcher ?? fetch
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetcher(`${appUrl}/readyz`)
      if (response.ok) return
    } catch {
      // The local process is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error('Pegas Control Plane did not become ready in time')
}
