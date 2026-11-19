import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'

import {
  availableLoopbackPort,
  desktopServiceEnvironment,
  desktopServiceRoot,
  isLoopbackAppUrl,
  isTrustedAppUrl,
  signalDesktopChild,
  terminateDesktopChildren,
  waitForControlPlane,
} from '../src/desktop/runtime.js'

describe('desktop runtime', () => {
  it('builds an isolated loopback service environment', () => {
    const environment = desktopServiceEnvironment({
      port: 41234,
      dataDir: '/tmp/pegas-desktop-test',
      testMode: true,
      environment: { PATH: '/usr/bin' },
    })
    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      PEGAS_API_HOST: '127.0.0.1',
      PEGAS_API_PORT: '41234',
      PEGAS_DATA_DIR: '/tmp/pegas-desktop-test',
      PEGAS_EXECUTOR: 'echo',
    })
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
