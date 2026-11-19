import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createCandidateManifest,
  readCandidateManifest,
  verifyCandidateManifest,
  writeCandidateManifest,
  type CandidateManifest,
} from '../src/supervisor/candidate-manifest.js'

const temporaryDirectories: string[] = []
const commit = '1'.repeat(40)

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('candidate evidence manifest', () => {
  it('binds successful verification to the exact commit and artifact bytes', () => {
    const { artifactPath, reviewPath, directory } = artifact('release bytes')
    const manifest = validManifest(artifactPath, reviewPath)
    const manifestPath = join(directory, 'candidate.json')

    writeCandidateManifest(manifestPath, manifest)
    const loaded = readCandidateManifest(manifestPath)

    expect(verifyCandidateManifest(loaded, artifactPath, reviewPath)).toEqual(
      manifest,
    )
    expect(loaded).toMatchObject({
      release: { commit },
      verification: {
        testedCommit: commit,
        ci: { conclusion: 'success' },
        review: {
          report: { status: 'ready-for-review', testedCommit: commit },
          approval: { reviewedCommit: commit, reviewer: 'ming' },
        },
        smoke: { status: 'passed' },
      },
    })
  })

  it('rejects evidence produced for a different commit', () => {
    const { artifactPath, reviewPath } = artifact('release bytes')
    const manifest = validManifest(artifactPath, reviewPath)
    manifest.verification.testedCommit = '2'.repeat(40)

    expect(() =>
      verifyCandidateManifest(manifest, artifactPath, reviewPath),
    ).toThrow(/tested commit does not match/)
  })

  it.each(['failure', 'cancelled'])(
    'rejects a %s CI conclusion',
    conclusion => {
      const { artifactPath, reviewPath } = artifact('release bytes')
      const manifest = validManifest(artifactPath, reviewPath) as unknown as {
        verification: { ci: { conclusion: string } }
      }
      manifest.verification.ci.conclusion = conclusion

      expect(() =>
        verifyCandidateManifest(manifest, artifactPath, reviewPath),
      ).toThrow(/verification evidence is incomplete/)
    },
  )

  it('rejects a smoke result that did not pass', () => {
    const { artifactPath, reviewPath } = artifact('release bytes')
    const manifest = validManifest(artifactPath, reviewPath) as unknown as {
      verification: { smoke: { status: string } }
    }
    manifest.verification.smoke.status = 'failed'

    expect(() =>
      verifyCandidateManifest(manifest, artifactPath, reviewPath),
    ).toThrow(/verification evidence is incomplete/)
  })

  it('rejects an artifact changed after the manifest was created', () => {
    const { artifactPath, reviewPath } = artifact('release bytes')
    const manifest = validManifest(artifactPath, reviewPath)
    writeFileSync(artifactPath, 'release bytes changed')

    expect(() =>
      verifyCandidateManifest(manifest, artifactPath, reviewPath),
    ).toThrow(/artifact size does not match|artifact checksum does not match/)
  })

  it('rejects temporary review evidence changed after the candidate was created', () => {
    const { artifactPath, reviewPath } = artifact('release bytes')
    const manifest = validManifest(artifactPath, reviewPath)
    writeFileSync(
      reviewPath,
      JSON.stringify({ ...reviewReport(), title: 'Changed title' }),
    )

    expect(() =>
      verifyCandidateManifest(manifest, artifactPath, reviewPath),
    ).toThrow(/review report checksum does not match/)
  })

  it('rejects approval for a different commit', () => {
    const { artifactPath, reviewPath } = artifact('release bytes')
    const manifest = validManifest(artifactPath, reviewPath)
    manifest.verification.review.approval.reviewedCommit = '3'.repeat(40)

    expect(() =>
      verifyCandidateManifest(manifest, artifactPath, reviewPath),
    ).toThrow(/reviewed commit does not match/)
  })
})

function artifact(contents: string): {
  artifactPath: string
  reviewPath: string
  directory: string
} {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-candidate-'))
  temporaryDirectories.push(directory)
  const artifactPath = join(directory, 'release.tar')
  const reviewPath = join(directory, 'feature-review.json')
  writeFileSync(artifactPath, contents)
  writeFileSync(reviewPath, JSON.stringify(reviewReport()))
  return { artifactPath, reviewPath, directory }
}

function validManifest(
  artifactPath: string,
  reviewPath: string,
): CandidateManifest {
  return createCandidateManifest(
    {
      release: {
        id: 'release-1',
        root: '/releases/release-1',
        commit,
        createdAt: '2026-11-17T00:00:00.000Z',
      },
      compatibility: { minimumSchema: 1, maximumSchema: 3 },
      verification: {
        testedCommit: commit,
        ci: {
          workflow: 'CI',
          runId: 'run-123',
          url: 'https://ci.example/runs/123',
          conclusion: 'success',
          completedAt: '2026-11-17T00:10:00.000Z',
        },
        commands: [
          { command: 'pnpm check', testCount: 35 },
          { command: 'pnpm smoke', testCount: 1 },
        ],
        smoke: {
          command: 'pnpm smoke',
          status: 'passed',
          completedAt: '2026-11-17T00:12:00.000Z',
        },
        review: {
          approval: {
            reviewedCommit: commit,
            reviewer: 'ming',
            reviewedAt: '2026-11-17T00:14:00.000Z',
          },
        },
        notTried: ['real DSH provider canary'],
      },
      createdAt: '2026-11-17T00:15:00.000Z',
    },
    artifactPath,
    reviewPath,
  )
}

function reviewReport() {
  return {
    schemaVersion: 1,
    featureIds: ['QUALITY-001'],
    title: 'Candidate evidence binding',
    acceptanceRefs: ['docs/feature-map.md#quality-001'],
    status: 'ready-for-review',
    baseRef: 'origin/main',
    headCommit: commit,
    changedFiles: ['src/supervisor/candidate-manifest.ts'],
    commands: [
      { command: 'pnpm check', status: 'passed', summary: 'test passed' },
    ],
    artifacts: [],
    notTried: [],
    generatedAt: '2026-11-17T00:13:00.000Z',
  }
}
