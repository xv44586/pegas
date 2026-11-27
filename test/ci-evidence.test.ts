import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { archiveEvidence } from '../scripts/archive-ci-evidence.js'

const directories: string[] = []
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-ci-evidence-'))
  directories.push(directory)
  const workspace = join(directory, 'workspace')
  const root = join(directory, 'archive')
  mkdirSync(join(workspace, 'output', 'nightly'), { recursive: true })
  return {
    workspace,
    root,
    runId: '123',
    attempt: '1',
    job: 'nightly-baseline',
    sha: 'a'.repeat(40),
    steps: { check: { outcome: 'failure' } },
    now: new Date('2026-11-27T00:00:00Z'),
  }
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('self-hosted CI evidence', () => {
  it('retains only expected outputs with exact SHA and failed outcomes', () => {
    const options = fixture()
    writeFileSync(
      join(options.workspace, 'output', 'nightly', 'check.log'),
      'test failed',
    )
    writeFileSync(join(options.workspace, '.env'), 'do-not-copy')
    const destination = archiveEvidence(options)
    expect(
      readFileSync(join(destination, 'nightly', 'check.log'), 'utf8'),
    ).toBe('test failed')
    expect(existsSync(join(destination, '.env'))).toBe(false)
    expect(
      JSON.parse(readFileSync(join(destination, 'evidence.json'), 'utf8')),
    ).toMatchObject({ sha: options.sha, steps: options.steps })
    expect(() => archiveEvidence(options)).toThrow()
    expect(archiveEvidence({ ...options, attempt: '2' })).not.toBe(destination)
  })
  it.each(['../escape', '/absolute', 'with space'])(
    'rejects unsafe run identity %s',
    runId => {
      expect(() => archiveEvidence({ ...fixture(), runId })).toThrow(
        'Unsafe evidence identity',
      )
    },
  )
  it('requires an exact tested commit', () => {
    expect(() => archiveEvidence({ ...fixture(), sha: 'main' })).toThrow(
      'exact commit SHA',
    )
  })
  it('prunes only recognized evidence older than seven days', () => {
    const options = fixture()
    const old = archiveEvidence({
      ...options,
      runId: 'old',
      now: new Date('2026-11-10T00:00:00Z'),
    })
    const recent = archiveEvidence({
      ...options,
      runId: 'recent',
      now: new Date('2026-11-25T00:00:00Z'),
    })
    const unrelated = join(options.root, 'ci-unknown')
    mkdirSync(unrelated)
    writeFileSync(join(unrelated, 'evidence.json'), 'broken')
    archiveEvidence(options)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })
})
