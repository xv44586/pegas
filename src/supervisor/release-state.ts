import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

import type { ReleaseRef, SupervisorState } from '../core/domain.js'
import {
  verifyCandidateManifest,
  type CandidateManifest,
} from './candidate-manifest.js'

interface StoredSupervisorState {
  schemaVersion: 1
  checksum: string
  state: SupervisorState
}

interface StateFileRead {
  state?: SupervisorState
  raw?: string
  missing: boolean
  error?: string
}

export interface ReleaseStateInspection {
  integrity: 'ok' | 'degraded' | 'unavailable'
  source: 'primary' | 'backup' | 'none'
  state?: SupervisorState
  diagnostics: string[]
}

export class RecoveryStateUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecoveryStateUnavailableError'
  }
}

export class ReleaseStateStore {
  readonly path: string
  readonly backupPath: string

  constructor(path: string) {
    this.path = path
    this.backupPath = `${path}.last-good`
  }

  ensure(initial: ReleaseRef): SupervisorState {
    const files = this.#readFiles()
    const inspection = inspectFiles(files)
    if (inspection.state) return inspection.state
    if (!files.primary.missing || !files.backup.missing) {
      throw unavailableError(inspection)
    }
    const state: SupervisorState = {
      active: initial,
      phase: 'stable',
      updatedAt: new Date().toISOString(),
    }
    this.#write(state)
    return state
  }

  inspect(): ReleaseStateInspection {
    return inspectFiles(this.#readFiles())
  }

  read(): SupervisorState {
    const inspection = this.inspect()
    if (!inspection.state) throw unavailableError(inspection)
    return inspection.state
  }

  stage(
    manifest: CandidateManifest,
    artifactPath: string,
    reviewReportPath: string,
  ): SupervisorState {
    const candidate = verifyCandidateManifest(
      manifest,
      artifactPath,
      reviewReportPath,
    )
    const release = candidate.release
    const candidateRef: ReleaseRef = {
      ...release,
      compatibility: candidate.compatibility,
    }
    const current = this.read()
    if (candidateRef.id === current.active.id) return current
    const next: SupervisorState = {
      active: candidateRef,
      previous: current.active,
      phase: 'verifying',
      updatedAt: new Date().toISOString(),
    }
    this.#write(next)
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
    this.#write(next)
    return next
  }

  recordFailure(reason: string): SupervisorState {
    const current = this.read()
    const next: SupervisorState = {
      ...current,
      updatedAt: new Date().toISOString(),
      lastFailure: reason,
    }
    this.#write(next)
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
    this.#write(next)
    return next
  }

  #readFiles(): { primary: StateFileRead; backup: StateFileRead } {
    return {
      primary: readStateFile(this.path),
      backup: readStateFile(this.backupPath),
    }
  }

  #write(state: SupervisorState): void {
    const directory = dirname(this.path)
    mkdirSync(directory, { recursive: true })
    const current = readStateFile(this.path)
    const backup = readStateFile(this.backupPath)
    if (current.state && current.raw) {
      writeAtomic(this.backupPath, current.raw)
    }
    const encoded = encodeState(state)
    writeAtomic(this.path, encoded)
    if (current.missing && backup.missing) {
      writeAtomic(this.backupPath, encoded)
    }
    syncDirectory(directory)
  }
}

function inspectFiles(files: {
  primary: StateFileRead
  backup: StateFileRead
}): ReleaseStateInspection {
  if (files.primary.state) {
    return {
      integrity: 'ok',
      source: 'primary',
      state: files.primary.state,
      diagnostics: [],
    }
  }

  const diagnostics = [
    ...(files.primary.error ? [`primary: ${files.primary.error}`] : []),
  ]
  if (files.backup.state) {
    return {
      integrity: 'degraded',
      source: 'backup',
      state: files.backup.state,
      diagnostics,
    }
  }
  if (files.backup.error) diagnostics.push(`backup: ${files.backup.error}`)
  return {
    integrity: 'unavailable',
    source: 'none',
    diagnostics,
  }
}

function readStateFile(path: string): StateFileRead {
  try {
    const raw = readFileSync(path, 'utf8')
    return { state: parseState(raw), raw, missing: false }
  } catch (error) {
    return {
      missing: isMissingFile(error),
      error: error instanceof Error ? error.message : 'Unknown read error',
    }
  }
}

function parseState(raw: string): SupervisorState {
  const parsed = JSON.parse(raw) as unknown
  if (isSupervisorState(parsed)) return parsed
  if (!isStoredSupervisorState(parsed)) {
    throw new Error('State has an unsupported structure')
  }
  const expected = checksum(parsed.state)
  if (parsed.checksum !== expected) {
    throw new Error('State checksum does not match its contents')
  }
  return parsed.state
}

function encodeState(state: SupervisorState): string {
  const stored: StoredSupervisorState = {
    schemaVersion: 1,
    checksum: checksum(state),
    state,
  }
  return `${JSON.stringify(stored, null, 2)}\n`
}

function checksum(state: SupervisorState): string {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex')
}

function writeAtomic(path: string, contents: string): void {
  const temporaryPath = `${path}.tmp-${String(process.pid)}-${randomUUID()}`
  try {
    writeFileSync(temporaryPath, contents, { mode: 0o600, flush: true })
    renameSync(temporaryPath, path)
  } finally {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // rename removes the temporary path; cleanup after a failed write is best effort.
    }
  }
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(directory, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function unavailableError(
  inspection: ReleaseStateInspection,
): RecoveryStateUnavailableError {
  const detail =
    inspection.diagnostics.length > 0
      ? inspection.diagnostics.join('; ')
      : 'primary and backup state are missing'
  return new RecoveryStateUnavailableError(
    `Supervisor state is unavailable: ${detail}`,
  )
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isStoredSupervisorState(
  value: unknown,
): value is StoredSupervisorState {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.checksum === 'string' &&
    isSupervisorState(value.state)
  )
}

function isSupervisorState(value: unknown): value is SupervisorState {
  if (!isRecord(value) || !isReleaseRef(value.active)) return false
  if (value.previous !== undefined && !isReleaseRef(value.previous))
    return false
  if (typeof value.updatedAt !== 'string') return false
  if (value.lastFailure !== undefined && typeof value.lastFailure !== 'string')
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
    (value.commit === undefined || typeof value.commit === 'string') &&
    (value.compatibility === undefined ||
      (isRecord(value.compatibility) &&
        Number.isSafeInteger(value.compatibility.minimumSchema) &&
        Number.isSafeInteger(value.compatibility.maximumSchema) &&
        (value.compatibility.taskWorkflowVersion === undefined ||
          (Number.isSafeInteger(value.compatibility.taskWorkflowVersion) &&
            Number(value.compatibility.taskWorkflowVersion) >= 0)) &&
        Number(value.compatibility.minimumSchema) >= 0 &&
        Number(value.compatibility.minimumSchema) <=
          Number(value.compatibility.maximumSchema))) &&
    typeof value.createdAt === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
