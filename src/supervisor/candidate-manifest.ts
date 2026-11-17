import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname } from 'node:path'

import type { ReleaseRef } from '../core/domain.js'

export interface CandidateManifest {
  schemaVersion: 1
  release: ReleaseRef & { commit: string }
  artifact: {
    file: string
    sha256: string
    sizeBytes: number
  }
  compatibility: {
    minimumSchema: number
    maximumSchema: number
  }
  verification: {
    testedCommit: string
    ci: {
      workflow: string
      runId: string
      url: string
      conclusion: 'success'
      completedAt: string
    }
    commands: {
      command: string
      testCount: number
    }[]
    smoke: {
      command: string
      status: 'passed'
      completedAt: string
    }
    notTried: string[]
  }
  createdAt: string
}

export interface CandidateManifestInput {
  release: ReleaseRef & { commit: string }
  compatibility: CandidateManifest['compatibility']
  verification: CandidateManifest['verification']
  createdAt?: string
}

export function createCandidateManifest(
  input: CandidateManifestInput,
  artifactPath: string,
): CandidateManifest {
  const artifact = statSync(artifactPath)
  if (!artifact.isFile()) throw new Error('Candidate artifact must be a file')
  return parseCandidateManifest({
    schemaVersion: 1,
    release: input.release,
    artifact: {
      file: basename(artifactPath),
      sha256: hashFile(artifactPath),
      sizeBytes: artifact.size,
    },
    compatibility: input.compatibility,
    verification: input.verification,
    createdAt: input.createdAt ?? new Date().toISOString(),
  })
}

export function writeCandidateManifest(
  path: string,
  manifest: CandidateManifest,
): void {
  const valid = parseCandidateManifest(manifest)
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp-${String(process.pid)}-${randomUUID()}`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(valid, null, 2)}\n`, {
      mode: 0o600,
      flush: true,
    })
    renameSync(temporaryPath, path)
  } finally {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // rename removes the temporary path; cleanup after a failed write is best effort.
    }
  }
}

export function readCandidateManifest(path: string): CandidateManifest {
  return parseCandidateManifest(
    JSON.parse(readFileSync(path, 'utf8')) as unknown,
  )
}

export function verifyCandidateManifest(
  value: unknown,
  artifactPath: string,
): CandidateManifest {
  const manifest = parseCandidateManifest(value)
  if (basename(artifactPath) !== manifest.artifact.file) {
    throw new Error('Candidate artifact filename does not match the manifest')
  }
  const artifact = statSync(artifactPath)
  if (!artifact.isFile()) throw new Error('Candidate artifact must be a file')
  if (artifact.size !== manifest.artifact.sizeBytes) {
    throw new Error('Candidate artifact size does not match the manifest')
  }
  if (hashFile(artifactPath) !== manifest.artifact.sha256) {
    throw new Error('Candidate artifact checksum does not match the manifest')
  }
  return manifest
}

function parseCandidateManifest(value: unknown): CandidateManifest {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Candidate manifest schema version is unsupported')
  }
  if (!isRelease(value.release) || typeof value.release.commit !== 'string') {
    throw new Error('Candidate release is invalid or has no commit')
  }
  if (!commitPattern.test(value.release.commit)) {
    throw new Error('Candidate release commit must be a full Git hash')
  }
  if (!isArtifact(value.artifact)) {
    throw new Error('Candidate artifact evidence is invalid')
  }
  if (!isCompatibility(value.compatibility)) {
    throw new Error('Candidate schema compatibility is invalid')
  }
  if (!isVerification(value.verification)) {
    throw new Error('Candidate verification evidence is incomplete')
  }
  if (value.verification.testedCommit !== value.release.commit) {
    throw new Error('Candidate tested commit does not match the release commit')
  }
  if (!isTimestamp(value.createdAt)) {
    throw new Error('Candidate manifest creation time is invalid')
  }
  return value as unknown as CandidateManifest
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const commitPattern = /^[0-9a-f]{40,64}$/
const sha256Pattern = /^[0-9a-f]{64}$/

function isRelease(value: unknown): value is ReleaseRef & { commit: string } {
  return (
    isRecord(value) &&
    nonempty(value.id) &&
    nonempty(value.root) &&
    typeof value.commit === 'string' &&
    isTimestamp(value.createdAt)
  )
}

function isArtifact(value: unknown): value is CandidateManifest['artifact'] {
  return (
    isRecord(value) &&
    nonempty(value.file) &&
    typeof value.sha256 === 'string' &&
    sha256Pattern.test(value.sha256) &&
    Number.isSafeInteger(value.sizeBytes) &&
    typeof value.sizeBytes === 'number' &&
    value.sizeBytes >= 0
  )
}

function isCompatibility(
  value: unknown,
): value is CandidateManifest['compatibility'] {
  return (
    isRecord(value) &&
    nonnegativeInteger(value.minimumSchema) &&
    nonnegativeInteger(value.maximumSchema) &&
    value.minimumSchema <= value.maximumSchema
  )
}

function isVerification(
  value: unknown,
): value is CandidateManifest['verification'] {
  if (!isRecord(value) || !commitPattern.test(stringValue(value.testedCommit)))
    return false
  if (!isRecord(value.ci) || value.ci.conclusion !== 'success') return false
  if (
    !nonempty(value.ci.workflow) ||
    !nonempty(value.ci.runId) ||
    !nonempty(value.ci.url) ||
    !isTimestamp(value.ci.completedAt)
  ) {
    return false
  }
  if (
    !Array.isArray(value.commands) ||
    value.commands.length === 0 ||
    !value.commands.every(
      command =>
        isRecord(command) &&
        nonempty(command.command) &&
        nonnegativeInteger(command.testCount),
    )
  ) {
    return false
  }
  if (
    !isRecord(value.smoke) ||
    value.smoke.status !== 'passed' ||
    !nonempty(value.smoke.command) ||
    !isTimestamp(value.smoke.completedAt)
  ) {
    return false
  }
  return (
    Array.isArray(value.notTried) &&
    value.notTried.every(item => nonempty(item))
  )
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  )
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
