import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname } from 'node:path'

type ReviewArtifactKind = 'screenshot' | 'video' | 'audio' | 'trace' | 'log'

export interface ReviewReport {
  schemaVersion: 1
  featureIds: string[]
  title: string
  acceptanceRefs: string[]
  status: 'ready-for-review' | 'incomplete'
  baseRef: string
  headCommit: string
  changedFiles: string[]
  commands: {
    command: string
    status: 'passed'
    summary: string
  }[]
  artifacts: {
    file: string
    kind: ReviewArtifactKind
    sha256: string
    sizeBytes: number
  }[]
  notTried: {
    item: string
    reason: string
    critical: boolean
  }[]
  generatedAt: string
}

export interface ReviewReportInput {
  featureIds: string[]
  title: string
  acceptanceRefs: string[]
  baseRef: string
  headCommit: string
  changedFiles: string[]
  commands: ReviewReport['commands']
  notTried: ReviewReport['notTried']
  generatedAt?: string
}

export interface ReviewReportEvidence {
  file: string
  sha256: string
  featureIds: string[]
  testedCommit: string
  status: 'ready-for-review'
}

const featureIdPattern = /^[A-Z]+-\d{3}$/
const commitPattern = /^[0-9a-f]{40,64}$/
const sha256Pattern = /^[0-9a-f]{64}$/
const artifactKinds = new Set<ReviewArtifactKind>([
  'screenshot',
  'video',
  'audio',
  'trace',
  'log',
])

export function createReviewReport(
  input: ReviewReportInput,
  artifactPaths: string[] = [],
): ReviewReport {
  return parseReviewReport({
    schemaVersion: 1,
    featureIds: input.featureIds,
    title: input.title,
    acceptanceRefs: input.acceptanceRefs,
    status: input.notTried.some(item => item.critical)
      ? 'incomplete'
      : 'ready-for-review',
    baseRef: input.baseRef,
    headCommit: input.headCommit,
    changedFiles: [...new Set(input.changedFiles)].sort(),
    commands: input.commands,
    artifacts: artifactPaths.map(path => {
      const stat = statSync(path)
      if (!stat.isFile())
        throw new Error(`Review artifact is not a file: ${path}`)
      return {
        file: basename(path),
        kind: artifactKind(path),
        sha256: hashFile(path),
        sizeBytes: stat.size,
      }
    }),
    notTried: input.notTried,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  })
}

export function writeReviewReport(path: string, report: ReviewReport): void {
  const valid = parseReviewReport(report)
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

export function readReviewReport(path: string): ReviewReport {
  return parseReviewReport(JSON.parse(readFileSync(path, 'utf8')) as unknown)
}

export function createReviewReportEvidence(path: string): ReviewReportEvidence {
  const contents = readFileSync(path)
  const report = parseReviewReport(
    JSON.parse(contents.toString('utf8')) as unknown,
  )
  if (report.status !== 'ready-for-review') {
    throw new Error(
      'Candidate requires review evidence with no critical Not tried',
    )
  }
  return {
    file: basename(path),
    sha256: createHash('sha256').update(contents).digest('hex'),
    featureIds: report.featureIds,
    testedCommit: report.headCommit,
    status: 'ready-for-review',
  }
}

export function verifyReviewReportEvidence(
  evidence: ReviewReportEvidence,
  path: string,
): void {
  const expected = createReviewReportEvidence(path)
  if (evidence.file !== expected.file) {
    throw new Error('Temporary review report filename does not match')
  }
  if (evidence.sha256 !== expected.sha256) {
    throw new Error('Temporary review report checksum does not match')
  }
  if (evidence.testedCommit !== expected.testedCommit) {
    throw new Error('Temporary review report commit does not match')
  }
  if (
    evidence.featureIds.length !== expected.featureIds.length ||
    evidence.featureIds.some(
      (featureId, index) => featureId !== expected.featureIds[index],
    )
  ) {
    throw new Error('Temporary review report Feature IDs do not match')
  }
}

export function parseFeatureIds(value: string): string[] {
  const ids = [...new Set(value.match(/[A-Z]+-\d{3}/g) ?? [])]
  if (ids.length === 0) {
    throw new Error('A Feature ID is required in the PR title or CLI arguments')
  }
  return ids
}

export function renderReviewSummary(report: ReviewReport): string {
  const lines = [
    `## Feature review · ${report.featureIds.join(', ')}`,
    '',
    `- Commit: \`${report.headCommit}\``,
    `- Status: **${report.status}**`,
    `- Changed files: ${String(report.changedFiles.length)}`,
    `- Temporary artifacts: ${String(report.artifacts.length)}`,
    '',
    '### Verification',
    '',
    ...report.commands.map(
      item => `- ✅ \`${item.command}\` — ${item.summary}`,
    ),
  ]
  if (report.artifacts.length > 0) {
    lines.push(
      '',
      '### Review artifacts',
      '',
      ...report.artifacts.map(
        item =>
          `- ${item.kind}: \`${item.file}\` (${String(item.sizeBytes)} bytes, SHA-256 \`${item.sha256}\`)`,
      ),
    )
  }
  if (report.notTried.length > 0) {
    lines.push(
      '',
      '### Not tried',
      '',
      ...report.notTried.map(
        item =>
          `- ${item.critical ? '❌ critical' : '⚠️ noncritical'}: ${item.item} — ${item.reason}`,
      ),
    )
  }
  return `${lines.join('\n')}\n`
}

function parseReviewReport(value: unknown): ReviewReport {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Review report schema version is unsupported')
  }
  if (!validFeatureIds(value.featureIds)) {
    throw new Error('Review report Feature IDs are invalid')
  }
  if (
    !nonempty(value.title) ||
    !Array.isArray(value.acceptanceRefs) ||
    value.acceptanceRefs.length === 0 ||
    !value.acceptanceRefs.every(nonempty)
  ) {
    throw new Error(
      'Review report title and acceptance references are required',
    )
  }
  if (value.status !== 'ready-for-review' && value.status !== 'incomplete') {
    throw new Error('Review report status is invalid')
  }
  if (
    !nonempty(value.baseRef) ||
    !commitPattern.test(stringValue(value.headCommit))
  ) {
    throw new Error('Review report Git references are invalid')
  }
  if (
    !Array.isArray(value.changedFiles) ||
    !value.changedFiles.every(nonempty) ||
    !Array.isArray(value.commands) ||
    value.commands.length === 0 ||
    !value.commands.every(isCommand)
  ) {
    throw new Error(
      'Review report changed files or command evidence is invalid',
    )
  }
  if (!Array.isArray(value.artifacts) || !value.artifacts.every(isArtifact)) {
    throw new Error('Review report artifacts are invalid')
  }
  if (!Array.isArray(value.notTried) || !value.notTried.every(isNotTried)) {
    throw new Error('Review report Not tried entries are invalid')
  }
  const hasCritical = value.notTried.some(
    item => isRecord(item) && item.critical === true,
  )
  if (
    (hasCritical && value.status !== 'incomplete') ||
    (!hasCritical && value.status !== 'ready-for-review')
  ) {
    throw new Error('Review report status does not match critical Not tried')
  }
  if (!isTimestamp(value.generatedAt)) {
    throw new Error('Review report generation time is invalid')
  }
  return value as unknown as ReviewReport
}

function artifactKind(path: string): ReviewArtifactKind {
  switch (extname(path).toLowerCase()) {
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.webp':
      return 'screenshot'
    case '.mp4':
    case '.webm':
      return 'video'
    case '.wav':
    case '.mp3':
    case '.m4a':
      return 'audio'
    case '.zip':
      return 'trace'
    default:
      return 'log'
  }
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function validFeatureIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      item => typeof item === 'string' && featureIdPattern.test(item),
    ) &&
    new Set(value).size === value.length
  )
}

function isCommand(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonempty(value.command) &&
    value.status === 'passed' &&
    nonempty(value.summary)
  )
}

function isArtifact(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonempty(value.file) &&
    typeof value.kind === 'string' &&
    artifactKinds.has(value.kind as ReviewArtifactKind) &&
    typeof value.sha256 === 'string' &&
    sha256Pattern.test(value.sha256) &&
    Number.isSafeInteger(value.sizeBytes) &&
    typeof value.sizeBytes === 'number' &&
    value.sizeBytes >= 0
  )
}

function isNotTried(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonempty(value.item) &&
    nonempty(value.reason) &&
    typeof value.critical === 'boolean'
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

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
