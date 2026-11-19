import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ReleaseRef } from '../src/core/domain.js'
import {
  createReviewReport,
  writeReviewReport,
} from '../src/quality/review-evidence.js'
import { createCandidateManifest } from '../src/supervisor/candidate-manifest.js'
import {
  RecoveryStateUnavailableError,
  ReleaseStateStore,
} from '../src/supervisor/release-state.js'

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('ReleaseStateStore', () => {
  it('atomically stages, confirms, and rolls back releases', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-release-state-'))
    temporaryDirectories.push(directory)
    const state = new ReleaseStateStore(join(directory, 'supervisor.json'))
    const first = release('release-1')
    const second = release('release-2')

    expect(state.ensure(first)).toMatchObject({
      active: first,
      phase: 'stable',
    })
    const artifactPath = join(directory, 'release-2.tar')
    const reviewReportPath = reviewPath(directory, second.commit ?? '')
    writeFileSync(artifactPath, 'immutable candidate')
    const manifest = candidateManifest(second, artifactPath, reviewReportPath)
    expect(state.stage(manifest, artifactPath, reviewReportPath)).toMatchObject(
      {
        active: second,
        previous: first,
        phase: 'verifying',
      },
    )
    rmSync(reviewReportPath)
    expect(state.confirm().phase).toBe('stable')
    expect(state.rollback('failed health check')).toMatchObject({
      active: first,
      previous: second,
      phase: 'rolled_back',
      lastFailure: 'failed health check',
    })
    expect(state.inspect()).toMatchObject({
      integrity: 'ok',
      source: 'primary',
    })
    expect(readFileSync(state.path, 'utf8')).toContain('"schemaVersion": 1')
  })

  it('uses the last verified state when the primary is truncated', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-release-state-'))
    temporaryDirectories.push(directory)
    const state = new ReleaseStateStore(join(directory, 'supervisor.json'))
    const first = release('release-1')
    state.ensure(first)
    stageCandidate(state, release('release-2'), directory)

    writeFileSync(state.path, '{"schemaVersion": 1')

    expect(state.read()).toMatchObject({ active: first, phase: 'stable' })
    expect(state.inspect()).toMatchObject({
      integrity: 'degraded',
      source: 'backup',
      state: { active: first },
    })
  })

  it('does not replace corrupt primary and backup state with defaults', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-release-state-'))
    temporaryDirectories.push(directory)
    const state = new ReleaseStateStore(join(directory, 'supervisor.json'))
    state.ensure(release('release-1'))
    stageCandidate(state, release('release-2'), directory)
    writeFileSync(state.path, '{bad primary')
    writeFileSync(state.backupPath, '{bad backup')

    expect(state.inspect()).toMatchObject({
      integrity: 'unavailable',
      source: 'none',
    })
    expect(() => state.read()).toThrow(RecoveryStateUnavailableError)
    expect(() => state.ensure(release('replacement'))).toThrow(
      RecoveryStateUnavailableError,
    )
    expect(readFileSync(state.path, 'utf8')).toBe('{bad primary')
  })

  it('rejects valid JSON whose checksum no longer matches', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-release-state-'))
    temporaryDirectories.push(directory)
    const state = new ReleaseStateStore(join(directory, 'supervisor.json'))
    state.ensure(release('release-1'))
    const stored = JSON.parse(readFileSync(state.path, 'utf8')) as {
      state: { active: { id: string } }
    }
    stored.state.active.id = 'tampered-release'
    writeFileSync(state.path, JSON.stringify(stored))

    expect(state.inspect()).toMatchObject({
      integrity: 'degraded',
      source: 'backup',
      diagnostics: [expect.stringContaining('checksum')],
    })
    expect(state.read().active.id).toBe('release-1')
  })

  it('reads the legacy state shape and rewrites it on the next change', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-release-state-'))
    temporaryDirectories.push(directory)
    const state = new ReleaseStateStore(join(directory, 'supervisor.json'))
    const legacy = {
      active: release('release-1'),
      phase: 'stable' as const,
      updatedAt: '2026-11-17T00:00:00.000Z',
    }
    writeFileSync(state.path, JSON.stringify(legacy))

    expect(state.read()).toEqual(legacy)
    stageCandidate(state, release('release-2'), directory)
    expect(readFileSync(state.path, 'utf8')).toContain('"schemaVersion": 1')
  })

  it('keeps the active release when candidate evidence no longer matches', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-release-state-'))
    temporaryDirectories.push(directory)
    const state = new ReleaseStateStore(join(directory, 'supervisor.json'))
    const first = release('release-1')
    const second = release('release-2')
    state.ensure(first)
    const artifactPath = join(directory, 'release-2.tar')
    const reviewReportPath = reviewPath(directory, second.commit ?? '')
    writeFileSync(artifactPath, 'immutable candidate')
    const manifest = candidateManifest(second, artifactPath, reviewReportPath)
    writeFileSync(artifactPath, 'candidate changed after verification')

    expect(() => state.stage(manifest, artifactPath, reviewReportPath)).toThrow(
      /artifact size does not match|artifact checksum does not match/,
    )
    expect(state.read()).toMatchObject({ active: first, phase: 'stable' })
  })
})

function release(id: string): ReleaseRef {
  return {
    id,
    root: `/releases/${id}`,
    commit: 'a'.repeat(40),
    createdAt: '2026-11-16T00:00:00.000Z',
  }
}

function candidateManifest(
  releaseRef: ReleaseRef,
  artifactPath: string,
  reviewReportPath: string,
) {
  if (!releaseRef.commit) throw new Error('Candidate commit is required')
  return createCandidateManifest(
    {
      release: { ...releaseRef, commit: releaseRef.commit },
      compatibility: { minimumSchema: 1, maximumSchema: 3 },
      verification: {
        testedCommit: releaseRef.commit,
        ci: {
          workflow: 'CI',
          runId: 'run-123',
          url: 'https://ci.example/runs/123',
          conclusion: 'success',
          completedAt: '2026-11-16T00:10:00.000Z',
        },
        commands: [{ command: 'pnpm check', testCount: 35 }],
        smoke: {
          command: 'pnpm smoke',
          status: 'passed',
          completedAt: '2026-11-16T00:12:00.000Z',
        },
        review: {
          approval: {
            reviewedCommit: releaseRef.commit,
            reviewer: 'release-reviewer',
            reviewedAt: '2026-11-16T00:14:00.000Z',
          },
        },
        notTried: [],
      },
      createdAt: '2026-11-16T00:15:00.000Z',
    },
    artifactPath,
    reviewReportPath,
  )
}

function stageCandidate(
  state: ReleaseStateStore,
  releaseRef: ReleaseRef,
  directory: string,
) {
  const artifactPath = join(directory, `${releaseRef.id}.tar`)
  const reviewReportPath = reviewPath(directory, releaseRef.commit ?? '')
  writeFileSync(artifactPath, `immutable candidate ${releaseRef.id}`)
  return state.stage(
    candidateManifest(releaseRef, artifactPath, reviewReportPath),
    artifactPath,
    reviewReportPath,
  )
}

function reviewPath(directory: string, commit: string): string {
  const path = join(directory, `feature-review-${commit.slice(0, 7)}.json`)
  writeReviewReport(
    path,
    createReviewReport({
      featureIds: ['QUALITY-001'],
      title: 'Candidate review',
      acceptanceRefs: ['docs/feature-map.md#quality-001'],
      baseRef: 'origin/main',
      headCommit: commit,
      changedFiles: ['src/supervisor/candidate-manifest.ts'],
      commands: [
        { command: 'pnpm check', status: 'passed', summary: 'passed' },
      ],
      notTried: [],
      generatedAt: '2026-11-16T00:13:00.000Z',
    }),
  )
  return path
}
