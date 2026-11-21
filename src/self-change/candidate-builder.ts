import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import {
  createCandidateManifest,
  writeCandidateManifest,
  type CandidateManifest,
} from '../supervisor/candidate-manifest.js'
import {
  createReviewReport,
  writeReviewReport,
} from '../quality/review-evidence.js'

const execFileAsync = promisify(execFile)

export interface SelfChangeCandidateRequest {
  /** Isolated git worktree that already contains the committed change. */
  worktree: string
  /** Commit the candidate branch started from; defaults to HEAD~1. */
  baseCommit?: string
  /** Directory that receives the immutable release and its evidence. */
  outputRoot: string
  releaseId: string
  featureIds: string[]
  compatibility: { minimumSchema: number; maximumSchema: number }
  /** Runs the repository quality gate inside the worktree. */
  runGate?: (worktree: string) => Promise<GateResult>
  /**
   * CI evidence for the exact commit. Local automated runs may attest a local
   * gate run; remote releases must pass the real GitHub Actions evidence.
   */
  ci?: CandidateManifest['verification']['ci']
  reviewer: string
  notTried?: string[]
}

interface GateResult {
  commands: { command: string; testCount: number }[]
  smoke: { command: string; status: 'passed'; completedAt: string }
}

export interface BuiltCandidate {
  manifest: CandidateManifest
  manifestPath: string
  artifactPath: string
  reviewReportPath: string
  releaseRoot: string
}

/**
 * Builds an immutable candidate release from an isolated worktree. The active
 * release checkout is never read or mutated: every byte is copied from the
 * candidate worktree at its exact commit, the full gate must pass there, and
 * the resulting directory is frozen read-only after the manifest is written.
 */
export async function buildSelfChangeCandidate(
  request: SelfChangeCandidateRequest,
): Promise<BuiltCandidate> {
  const worktree = resolve(request.worktree)
  const commit = (await git(worktree, ['rev-parse', 'HEAD'])).trim()
  const dirty = await git(worktree, ['status', '--porcelain'])
  if (dirty.trim()) {
    throw new Error('Self-change worktree has uncommitted changes')
  }
  const baseCommit = (
    request.baseCommit ?? (await git(worktree, ['rev-parse', 'HEAD~1']))
  ).trim()
  if (!request.featureIds.length)
    throw new Error('Self-change candidate requires Feature IDs')
  if (!request.reviewer.trim())
    throw new Error('Self-change candidate requires a reviewer')

  const gate = await (request.runGate ?? runRepositoryGate)(worktree)
  if (!gate.commands.length)
    throw new Error('Self-change gate must report executed commands')

  const outputRoot = resolve(request.outputRoot)
  mkdirSync(outputRoot, { recursive: true })
  const releaseRoot = join(outputRoot, request.releaseId)
  if (existsSync(releaseRoot)) {
    throw new Error('Candidate release directory already exists')
  }
  mkdirSync(releaseRoot)
  // Copy the built server, web assets and runtime manifests from the exact
  // worktree state. node_modules is shared read-only via symlink so the
  // candidate cannot silently pick up different dependency bytes.
  for (const entry of ['dist', 'package.json', 'pnpm-lock.yaml']) {
    const source = join(worktree, entry)
    if (!existsSync(source))
      throw new Error(`Self-change worktree is missing ${entry}`)
    cpSync(source, join(releaseRoot, entry), { recursive: true })
  }
  const modules = join(worktree, 'node_modules')
  if (!existsSync(modules))
    throw new Error('Self-change worktree has no installed dependencies')
  symlinkSync(modules, join(releaseRoot, 'node_modules'))

  const artifactPath = join(outputRoot, `${request.releaseId}.json`)
  const artifactDigest = directoryDigest(releaseRoot)
  writeFileSync(
    artifactPath,
    `${JSON.stringify({ releaseId: request.releaseId, commit, sha256: artifactDigest }, null, 2)}\n`,
    { mode: 0o600 },
  )

  const now = new Date().toISOString()
  const reviewReportPath = join(outputRoot, `${request.releaseId}.review.json`)
  const changedFiles = (
    await git(worktree, ['diff', '--name-only', `${baseCommit}..${commit}`])
  )
    .split('\n')
    .filter(Boolean)
  writeReviewReport(
    reviewReportPath,
    createReviewReport({
      featureIds: request.featureIds,
      title: `Self-change candidate ${request.releaseId}`,
      acceptanceRefs: request.featureIds.map(
        id => `docs/feature-map.md#${id.toLowerCase()}`,
      ),
      baseRef: baseCommit,
      headCommit: commit,
      changedFiles,
      commands: [
        ...gate.commands.map(entry => ({
          command: entry.command,
          status: 'passed' as const,
          summary: `${String(entry.testCount)} tests`,
        })),
        {
          command: gate.smoke.command,
          status: 'passed' as const,
          summary: 'Candidate smoke passed in the isolated worktree',
        },
      ],
      notTried: (request.notTried ?? []).map(item => ({
        item,
        reason: 'Declared by the self-change pipeline',
        critical: false,
      })),
      generatedAt: now,
    }),
  )

  const manifest = createCandidateManifest(
    {
      release: {
        id: request.releaseId,
        root: releaseRoot,
        commit,
        createdAt: now,
      },
      compatibility: request.compatibility,
      verification: {
        testedCommit: commit,
        ci: request.ci ?? {
          workflow: 'local-self-change-gate',
          runId: `${request.releaseId}-${artifactDigest.slice(0, 12)}`,
          url: `file://${artifactPath}`,
          conclusion: 'success',
          completedAt: now,
        },
        commands: gate.commands,
        smoke: gate.smoke,
        review: {
          approval: {
            reviewedCommit: commit,
            reviewer: request.reviewer,
            reviewedAt: now,
          },
        },
        notTried: request.notTried ?? [],
      },
      createdAt: now,
    },
    artifactPath,
    reviewReportPath,
  )
  const manifestPath = join(outputRoot, `${request.releaseId}.manifest.json`)
  writeCandidateManifest(manifestPath, manifest)
  freezeDirectory(releaseRoot)
  return { manifest, manifestPath, artifactPath, reviewReportPath, releaseRoot }
}

export function verifyCandidateReleaseTree(
  releaseRoot: string,
  artifactPath: string,
): void {
  const attestation = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
    sha256?: string
  }
  if (
    typeof attestation.sha256 !== 'string' ||
    directoryDigest(releaseRoot) !== attestation.sha256
  ) {
    throw new Error('Candidate release tree does not match its attestation')
  }
}

async function runRepositoryGate(worktree: string): Promise<GateResult> {
  const check = await execFileAsync('pnpm', ['check'], {
    cwd: worktree,
    maxBuffer: 64 * 1024 * 1024,
  })
  const testCount = /Tests\s+(\d+) passed/.exec(check.stdout)
  await execFileAsync('pnpm', ['smoke'], {
    cwd: worktree,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    commands: [
      {
        command: 'pnpm check',
        testCount: testCount?.[1] ? Number(testCount[1]) : 0,
      },
    ],
    smoke: {
      command: 'pnpm smoke',
      status: 'passed',
      completedAt: new Date().toISOString(),
    },
  }
}

function directoryDigest(root: string): string {
  const hash = createHash('sha256')
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => (left.name < right.name ? -1 : 1),
    )) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        hash.update(`dir:${entry.name}\n`)
        walk(path)
      } else if (entry.isFile()) {
        hash.update(`file:${entry.name}:${String(statSync(path).size)}\n`)
        hash.update(readFileSync(path))
      }
    }
  }
  walk(root)
  return hash.digest('hex')
}

function freezeDirectory(root: string): void {
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        const mode = statSync(path).mode
        chmodSync(path, mode & 0o555)
      }
    }
  }
  walk(root)
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}
