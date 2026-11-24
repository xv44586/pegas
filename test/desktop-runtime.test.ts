import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'

import {
  availableLoopbackPort,
  desktopRequestHeaders,
  desktopServiceEnvironment,
  desktopServiceRoot,
  isLoopbackAppUrl,
  isTrustedAppUrl,
  signalDesktopChild,
  terminateDesktopChildren,
  waitForControlPlane,
} from '../src/desktop/runtime.js'
import { defaultAgentWorkspace } from '../src/core/config.js'

const desktopSmoke = readFileSync(
  new URL('../scripts/smoke-desktop.mjs', import.meta.url),
  'utf8',
)
const desktopMain = readFileSync(
  new URL('../src/desktop/main.ts', import.meta.url),
  'utf8',
)

describe('desktop runtime', () => {
  it('clears first-run setup before exercising the composer', () => {
    expect(desktopSmoke).toContain("name: '稍后设置'")
  })

  it('targets the send button exactly so the dictation toggle cannot match', () => {
    expect(desktopSmoke).toContain(
      "getByRole('button', { name: '发送', exact: true })",
    )
    expect(desktopSmoke).not.toContain("getByRole('button', { name: '发送' })")
  })

  it('starts database writers only after the Control Plane is ready', () => {
    // DESKTOP-001: the shell spawns exactly one Supervisor before waiting for
    // readiness; business processes are the Supervisor's children, never
    // direct Electron children.
    const supervisor = desktopMain.indexOf('startSupervisorEntry(')
    const ready = desktopMain.indexOf('await waitForControlPlane(appUrl)')
    expect(supervisor).toBeGreaterThanOrEqual(0)
    expect(desktopMain).toContain("'supervisor/main.js'")
    expect(desktopMain).not.toContain("['control-plane/main.js']")
    expect(desktopMain).not.toContain("'worker/main.js',")
    const spawnCall = desktopMain.indexOf(
      'startSupervisorEntry(port, recoveryPort, residencyPort, dataDir, apiToken)',
    )
    expect(spawnCall).toBeGreaterThanOrEqual(0)
    expect(spawnCall).toBeLessThan(ready)
    expect(desktopMain).toContain("PEGAS_SUPERVISOR_RESTART: 'disabled'")
  })

  it('keeps residency machine-local and default-off with honest window semantics', () => {
    expect(desktopMain).toContain(
      'residentMode = readResidencyPreference(preferenceDirectory).resident',
    )
    const windowClosed = desktopMain.indexOf("app.on('window-all-closed'")
    const residentGuard = desktopMain.indexOf('if (residentMode) return')
    expect(windowClosed).toBeGreaterThanOrEqual(0)
    expect(residentGuard).toBeGreaterThan(windowClosed)
    expect(desktopMain).toContain('app.setLoginItemSettings(settings)')
    expect(desktopMain).toContain('PEGAS_DESKTOP_RESIDENCY_URL')
  })

  it('test mode uses deterministic rules routing so smoke never depends on a live model', () => {
    const environment = desktopServiceEnvironment({
      port: 41234,
      dataDir: '/tmp/pegas-desktop-test',
      apiToken: 'debug-token',
      testMode: true,
      environment: {},
    })
    expect(environment.PEGAS_ROUTER).toBe('rules')
  })

  it('wires native attention to the trusted origin with main-process bearer only', () => {
    expect(desktopMain).toContain('startAttentionMonitor(appUrl, apiToken)')
    expect(desktopMain).toContain('/v1/outbox?userId=owner')
    expect(desktopMain).toContain('Notification.isSupported()')
    expect(desktopMain).toContain('app.dock?.setBadge(value)')
    const monitorStart = desktopMain.indexOf('function startAttentionMonitor')
    expect(monitorStart).toBeGreaterThanOrEqual(0)
    expect(desktopMain).not.toContain('notification-permission')
  })

  it('stops the attention poll and clears the badge during shutdown', () => {
    const stopChildren = desktopMain.indexOf('function stopChildren')
    const clearTimer = desktopMain.indexOf('clearTimeout(attentionTimer)')
    const clearBadge = desktopMain.indexOf("app.dock?.setBadge('')")
    expect(stopChildren).toBeGreaterThanOrEqual(0)
    expect(clearTimer).toBeGreaterThan(stopChildren)
    expect(clearBadge).toBeGreaterThan(stopChildren)
  })

  it('smoke asserts the dock badge lifecycle against real unread facts', () => {
    expect(desktopSmoke).toContain('waitForUnreadBadge(application)')
    expect(desktopSmoke).toContain('markFirstUnreadRead(window)')
    expect(desktopSmoke).toContain(
      'waitForBadgeBelow(application, unreadBefore)',
    )
    expect(desktopSmoke).toContain('app.dock?.getBadge()')
  })

  it('builds an isolated loopback service environment', () => {
    const environment = desktopServiceEnvironment({
      port: 41234,
      dataDir: '/tmp/pegas-desktop-test',
      apiToken: 'desktop-instance-token',
      testMode: true,
      environment: { PATH: '/usr/bin' },
    })
    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      PEGAS_API_HOST: '127.0.0.1',
      PEGAS_API_PORT: '41234',
      PEGAS_API_TOKEN: 'desktop-instance-token',
      PEGAS_DATA_DIR: '/tmp/pegas-desktop-test',
      PEGAS_EXECUTOR: 'echo',
    })
    expect(environment.PEGAS_WORKSPACE_ROOT).toBe(
      defaultAgentWorkspace('/tmp/pegas-desktop-test'),
    )
  })

  it('keeps the desktop agent workspace out of the application checkout', () => {
    const environment = desktopServiceEnvironment({
      port: 41234,
      dataDir: '/tmp/pegas-desktop-test',
      apiToken: 'token',
      environment: {
        PATH: '/usr/bin',
        PEGAS_WORKSPACE_ROOT: '/Users/dev/pegas',
      },
    })
    expect(environment.PEGAS_WORKSPACE_ROOT).toBe(
      defaultAgentWorkspace('/tmp/pegas-desktop-test'),
    )
  })

  it('authenticates only requests to the trusted desktop service origin', () => {
    const headers = { Accept: 'application/json' }
    expect(
      desktopRequestHeaders(
        'http://127.0.0.1:41234/v1/approvals',
        'http://127.0.0.1:41234',
        'desktop-instance-token',
        headers,
      ),
    ).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer desktop-instance-token',
    })
    expect(
      desktopRequestHeaders(
        'https://example.com/v1/approvals',
        'http://127.0.0.1:41234',
        'desktop-instance-token',
        headers,
      ),
    ).toBe(headers)
  })

  it('uses the unpacked service directory in packaged applications', () => {
    expect(
      desktopServiceRoot({
        isPackaged: true,
        appPath: '/Applications/Pegas.app/Contents/Resources/app.asar',
        resourcesPath: '/Applications/Pegas.app/Contents/Resources',
      }),
    ).toBe('/Applications/Pegas.app/Contents/Resources/app.asar.unpacked')
    expect(
      desktopServiceRoot({
        isPackaged: false,
        appPath: '/workspace/pegas',
        resourcesPath: '/workspace/pegas',
      }),
    ).toBe('/workspace/pegas')
  })

  it('trusts only the application origin', () => {
    const appUrl = 'http://127.0.0.1:41234'
    expect(isTrustedAppUrl(`${appUrl}/settings`, appUrl)).toBe(true)
    expect(isTrustedAppUrl('https://example.com', appUrl)).toBe(false)
    expect(isTrustedAppUrl('not a url', appUrl)).toBe(false)
    expect(
      isTrustedAppUrl('https://example.com/a', 'https://example.com'),
    ).toBe(false)
    expect(isLoopbackAppUrl('http://localhost:41234')).toBe(true)
    expect(isLoopbackAppUrl('http://[::1]:41234')).toBe(true)
    expect(isLoopbackAppUrl('https://127.0.0.1:41234')).toBe(false)
    expect(isLoopbackAppUrl('http://192.168.1.10:41234')).toBe(false)
  })

  it('allocates a real loopback port', async () => {
    await expect(availableLoopbackPort()).resolves.toBeGreaterThan(0)
  })

  it('waits until the control plane reports ready', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('starting'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    await expect(
      waitForControlPlane('http://127.0.0.1:41234', {
        timeoutMs: 100,
        intervalMs: 1,
        fetcher,
      }),
    ).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('waits for graceful child shutdown', async () => {
    const child = managedChild()
    const stopping = terminateDesktopChildren([child.process], {
      graceMs: 20,
      finalWaitMs: 20,
    })
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.exit(0)
    await stopping
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
  })

  it('escalates a stuck child to SIGKILL before resolving', async () => {
    vi.useFakeTimers()
    try {
      const child = managedChild()
      const stopping = terminateDesktopChildren([child.process], {
        graceMs: 20,
        finalWaitMs: 20,
      })
      await vi.advanceTimersByTimeAsync(20)
      expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
      child.exit(null, 'SIGKILL')
      await stopping
    } finally {
      vi.useRealTimers()
    }
  })

  it('signals the whole service process group on macOS', () => {
    const child = managedChild(4242)
    const killProcess = vi.fn(() => true)
    signalDesktopChild(child.process, 'SIGTERM', {
      platform: 'darwin',
      killProcess,
    })
    expect(killProcess).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('kills process-group descendants when the service leader already exited', async () => {
    const child = managedChild(4242)
    child.exit(1)
    const signal = vi.fn()
    await terminateDesktopChildren([child.process], { signal })
    expect(signal).toHaveBeenCalledWith(child.process, 'SIGKILL')
  })
})

function managedChild(pid?: number): {
  process: ChildProcess
  kill: ReturnType<typeof vi.fn>
  exit: (code: number | null, signal?: NodeJS.Signals | null) => void
} {
  const emitter = new EventEmitter()
  const kill = vi.fn(() => true)
  const process = emitter as ChildProcess
  Object.defineProperties(process, {
    pid: { value: pid },
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
    kill: { value: kill },
  })
  return {
    process,
    kill,
    exit(code, signal = null) {
      Object.defineProperty(process, 'exitCode', {
        value: code,
        writable: true,
      })
      Object.defineProperty(process, 'signalCode', {
        value: signal,
        writable: true,
      })
      emitter.emit('exit', code, signal)
    },
  }
}
