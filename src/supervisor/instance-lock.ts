import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class SupervisorInstanceConflictError extends Error {
  constructor(pid: number) {
    super(
      `Another Supervisor (pid ${String(pid)}) already owns this data directory`,
    )
    this.name = 'SupervisorInstanceConflictError'
  }
}

export interface SupervisorInstanceLock {
  release: () => void
}

/**
 * One data directory, one Supervisor. The lock fails closed against a live
 * owner and reclaims locks whose owner is gone, so a crashed Supervisor can
 * never permanently block restarts and an old auto-restarting shell can never
 * steal the port from the running instance.
 */
export function acquireSupervisorInstanceLock(
  dataDir: string,
  options: {
    pid?: number
    isAlive?: (pid: number) => boolean
  } = {},
): SupervisorInstanceLock {
  const pid = options.pid ?? process.pid
  const isAlive = options.isAlive ?? defaultIsAlive
  const lockPath = join(dataDir, 'supervisor.lock')
  mkdirSync(dataDir, { recursive: true })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, `${String(pid)}\n`, { flag: 'wx', mode: 0o600 })
      return createLock(lockPath, pid)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const owner = readOwner(lockPath)
    if (owner !== undefined && owner !== pid && isAlive(owner))
      throw new SupervisorInstanceConflictError(owner)
    // Stale or corrupt lock: the owner is gone (or unreadable). Reclaim it.
    try {
      unlinkSync(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new Error(`Supervisor lock ${lockPath} could not be acquired`)
}

function createLock(lockPath: string, pid: number): SupervisorInstanceLock {
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      // Never remove a lock that a newer owner already wrote.
      if (readOwner(lockPath) !== pid) return
      try {
        unlinkSync(lockPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
  }
}

function readOwner(lockPath: string): number | undefined {
  let contents: string
  try {
    contents = readFileSync(lockPath, 'utf8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed = Number(contents)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
