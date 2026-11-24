import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import {
  childHasExited,
  onceChildExited,
  signalChildGroup,
  stopChildProcesses,
} from '../src/supervisor/child-lifecycle.js'

const spawned: ChildProcess[] = []

function spawnSleeper(script: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', script], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  })
  spawned.push(child)
  return child
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve()
  return new Promise(resolveExit => child.once('exit', () => resolveExit()))
}

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        signalChildGroup(child, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      await exited(child)
    }
  }
})

describe('supervisor child lifecycle', () => {
  it('treats a signal-terminated child as exited', async () => {
    const child = spawnSleeper('setInterval(() => {}, 1000)')
    child.kill('SIGKILL')
    await exited(child)
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBe('SIGKILL')
    expect(childHasExited(child)).toBe(true)
    await expect(
      Promise.race([
        onceChildExited(child),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('onceChildExited hung')), 500),
        ),
      ]),
    ).resolves.toBeUndefined()
  })

  it('stops children that only die by signal without hanging', async () => {
    const stubborn = spawnSleeper(
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    )
    const graceful = spawnSleeper('setInterval(() => {}, 1000)')
    await expect(
      Promise.race([
        stopChildProcesses([stubborn, graceful], { graceMs: 200 }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('stopChildProcesses hung')), 3000),
        ),
      ]),
    ).resolves.toBeUndefined()
    expect(childHasExited(stubborn)).toBe(true)
    expect(childHasExited(graceful)).toBe(true)
  }, 10_000)

  it('is a no-op for children that already exited', async () => {
    const child = spawnSleeper('process.exit(0)')
    await exited(child)
    await stopChildProcesses([child], { graceMs: 100 })
    expect(child.exitCode).toBe(0)
  })

  it('falls back to child.kill when the process group is gone', async () => {
    const child = spawnSleeper('process.exit(0)')
    await exited(child)
    expect(() => signalChildGroup(child, 'SIGTERM')).not.toThrow()
  })

  it('tolerates a recycled or foreign process group instead of crashing', () => {
    const child = spawnSleeper('setInterval(() => {}, 1000)')
    expect(() =>
      signalChildGroup(child, 'SIGTERM', {
        killGroup: () => {
          throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
        },
      }),
    ).not.toThrow()
  })

  it('stopChildProcesses survives signal races on already-exited children', async () => {
    const child = spawnSleeper('setInterval(() => {}, 1000)')
    child.kill('SIGKILL')
    await exited(child)
    await expect(
      stopChildProcesses([child], {
        graceMs: 100,
        signal: target =>
          signalChildGroup(target, 'SIGTERM', {
            killGroup: () => {
              throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
            },
          }),
      }),
    ).resolves.toBeUndefined()
  })
})
