import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { ReleaseRef, SupervisorState } from '../core/domain.js'

export class ReleaseStateStore {
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  ensure(initial: ReleaseRef): SupervisorState {
    try {
      return this.read()
    } catch (error) {
      if (!isMissingFile(error)) throw error
      const state: SupervisorState = {
        active: initial,
        phase: 'stable',
        updatedAt: new Date().toISOString(),
      }
      this.write(state)
      return state
    }
  }

  read(): SupervisorState {
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
    if (!isSupervisorState(parsed))
      throw new Error(`Invalid supervisor state at ${this.path}`)
    return parsed
  }

  stage(candidate: ReleaseRef): SupervisorState {
    const current = this.read()
    if (candidate.id === current.active.id) return current
    const next: SupervisorState = {
      active: candidate,
      previous: current.active,
      phase: 'verifying',
      updatedAt: new Date().toISOString(),
    }
    this.write(next)
    return next
  }

  confirm(): SupervisorState {
    const current = this.read()
    const next: SupervisorState = {
      ...current,
      phase: 'stable',
      updatedAt: new Date().toISOString(),
      lastFailure: undefined,
    }
    this.write(next)
    return next
  }

  recordFailure(reason: string): SupervisorState {
    const current = this.read()
    const next: SupervisorState = {
      ...current,
      updatedAt: new Date().toISOString(),
      lastFailure: reason,
    }
    this.write(next)
    return next
  }

  rollback(reason: string): SupervisorState {
    const current = this.read()
    if (!current.previous)
      throw new Error('No previous release is available for rollback')
    const next: SupervisorState = {
      active: current.previous,
      previous: current.active,
      phase: 'rolled_back',
      updatedAt: new Date().toISOString(),
      lastFailure: reason,
    }
    this.write(next)
    return next
  }

  private write(state: SupervisorState): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    })
    renameSync(temporaryPath, this.path)
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isSupervisorState(value: unknown): value is SupervisorState {
  if (!isRecord(value) || !isReleaseRef(value.active)) return false
  if (value.previous !== undefined && !isReleaseRef(value.previous))
    return false
  return (
    value.phase === 'stable' ||
    value.phase === 'verifying' ||
    value.phase === 'rolled_back'
  )
}

function isReleaseRef(value: unknown): value is ReleaseRef {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.root === 'string' &&
    typeof value.createdAt === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
