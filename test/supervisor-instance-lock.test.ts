import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireSupervisorInstanceLock,
  SupervisorInstanceConflictError,
} from '../src/supervisor/instance-lock.js'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-lock-test-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('supervisor instance lock', () => {
  it('acquires the lock and records the owning pid', () => {
    const dataDir = temporaryDirectory()
    const lock = acquireSupervisorInstanceLock(dataDir, { pid: 4242 })
    expect(readFileSync(join(dataDir, 'supervisor.lock'), 'utf8').trim()).toBe(
      '4242',
    )
    lock.release()
    expect(() => readFileSync(join(dataDir, 'supervisor.lock'))).toThrow()
  })

  it('rejects a second live supervisor on the same data directory', () => {
    const dataDir = temporaryDirectory()
    const lock = acquireSupervisorInstanceLock(dataDir, {
      pid: 4242,
      isAlive: () => true,
    })
    expect(() =>
      acquireSupervisorInstanceLock(dataDir, {
        pid: 4243,
        isAlive: () => true,
      }),
    ).toThrow(SupervisorInstanceConflictError)
    lock.release()
  })

  it('reclaims a stale lock whose owner is gone', () => {
    const dataDir = temporaryDirectory()
    writeFileSync(join(dataDir, 'supervisor.lock'), '9999\n')
    const lock = acquireSupervisorInstanceLock(dataDir, {
      pid: 4242,
      isAlive: pid => pid !== 9999,
    })
    expect(readFileSync(join(dataDir, 'supervisor.lock'), 'utf8').trim()).toBe(
      '4242',
    )
    lock.release()
  })

  it('reclaims a corrupt lock file instead of failing open', () => {
    const dataDir = temporaryDirectory()
    writeFileSync(join(dataDir, 'supervisor.lock'), 'not-a-pid')
    const lock = acquireSupervisorInstanceLock(dataDir, { pid: 4242 })
    lock.release()
  })

  it('release is idempotent and never removes a newer owner lock', () => {
    const dataDir = temporaryDirectory()
    const lock = acquireSupervisorInstanceLock(dataDir, { pid: 4242 })
    writeFileSync(join(dataDir, 'supervisor.lock'), '5252\n')
    lock.release()
    lock.release()
    expect(readFileSync(join(dataDir, 'supervisor.lock'), 'utf8').trim()).toBe(
      '5252',
    )
  })
})
