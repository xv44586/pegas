import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createReviewReport,
  parseFeatureIds,
  readReviewReport,
  renderReviewSummary,
  writeReviewReport,
} from '../src/quality/review-evidence.js'

const temporaryDirectories: string[] = []
const commit = '1'.repeat(40)

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('ephemeral feature review evidence', () => {
  it('runs CI against the immutable PR head instead of a synthetic merge commit', () => {
    const workflow = readFileSync(
      join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'),
      'utf8',
    )

    expect(workflow).toContain(
      'ref: ${{ github.event.pull_request.head.sha || github.sha }}',
    )
  })

  it('builds a SHA-bound report from commands and temporary media', () => {
    const directory = temporaryDirectory()
    const screenshot = join(directory, 'workspace-open.png')
    writeFileSync(screenshot, 'image bytes')

    const report = createReviewReport(
      {
        featureIds: ['QUALITY-001'],
        title: 'Temporary review evidence',
        acceptanceRefs: ['docs/feature-map.md#quality-001'],
        baseRef: 'origin/main',
        headCommit: commit,
        changedFiles: ['src/quality/review-evidence.ts'],
        commands: [
          { command: 'pnpm check', status: 'passed', summary: '121 tests' },
        ],
        notTried: [],
        generatedAt: '2026-11-19T10:00:00.000Z',
      },
      [screenshot],
    )

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: 'ready-for-review',
      featureIds: ['QUALITY-001'],
      headCommit: commit,
      artifacts: [
        {
          file: 'workspace-open.png',
          kind: 'screenshot',
          sizeBytes: 11,
        },
      ],
    })
    expect(report.artifacts[0]?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates an incomplete report instead of hiding a critical untried path', () => {
    const report = createReviewReport({
      featureIds: ['CONV-002'],
      title: 'Conversation UI',
      acceptanceRefs: ['docs/feature-map.md#conv-002'],
      baseRef: 'origin/main',
      headCommit: commit,
      changedFiles: ['web/src/App.tsx'],
      commands: [
        { command: 'pnpm check', status: 'passed', summary: 'passed' },
      ],
      notTried: [
        {
          item: 'workspace-open screenshot',
          reason: 'browser collector did not run',
          critical: true,
        },
      ],
      generatedAt: '2026-11-19T10:00:00.000Z',
    })

    expect(report.status).toBe('incomplete')
    expect(renderReviewSummary(report)).toContain('workspace-open screenshot')
  })

  it('writes only to the requested temporary path and round-trips the report', () => {
    const directory = temporaryDirectory()
    const reportPath = join(directory, 'feature-review.json')
    const report = createReviewReport({
      featureIds: ['QUALITY-001'],
      title: 'Temporary review evidence',
      acceptanceRefs: ['docs/feature-map.md#quality-001'],
      baseRef: 'origin/main',
      headCommit: commit,
      changedFiles: ['scripts/generate-review-evidence.ts'],
      commands: [
        { command: 'pnpm check', status: 'passed', summary: 'passed' },
      ],
      notTried: [],
      generatedAt: '2026-11-19T10:00:00.000Z',
    })

    writeReviewReport(reportPath, report)

    expect(readReviewReport(reportPath)).toEqual(report)
    expect(readFileSync(reportPath, 'utf8')).not.toContain('apiKey')
  })

  it('extracts stable Feature IDs from a PR title without inventing one', () => {
    expect(
      parseFeatureIds('fix(CONV-002): workspace layout; VOICE-001 regression'),
    ).toEqual(['CONV-002', 'VOICE-001'])
    expect(() => parseFeatureIds('Fix the workspace')).toThrow(/Feature ID/)
  })
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-review-evidence-'))
  temporaryDirectories.push(directory)
  return directory
}
