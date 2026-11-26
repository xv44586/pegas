import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createCandidateManifest,
  writeCandidateManifest,
} from '../src/supervisor/candidate-manifest.js'
import {
  acquireReleaseDirectoryLock,
  withReleaseDirectoryLock,
} from '../src/self-change/release-directory-lock.js'
import { ReleaseStateStore } from '../src/supervisor/release-state.js'
import {
  pruneReleaseHistory,
  readStartupReferences,
  supervisorProcessProtection,
  type RetentionOptions,
} from '../src/self-change/release-retention.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pegas-retention-'))
  dirs.push(root)
  mkdirSync(join(root, 'candidates'))
  mkdirSync(join(root, 'dependencies'))
  const manifests = Array.from({ length: 8 }, (_, index) => {
    const id = `release-${String(index)}`
    const path = join(root, 'candidates', id)
    mkdirSync(path)
    mkdirSync(join(root, 'dependencies', id))
    writeFileSync(join(path, 'bytes'), id)
    symlinkSync(join(root, 'dependencies', id), join(path, 'node_modules'))
    const artifact = join(root, 'candidates', id + '.json')
    writeFileSync(artifact, '{}')
    const review = join(root, 'candidates', id + '.review.json')
    const commit = 'a'.repeat(40),
      date = `2026-11-${String(10 + index)}T00:00:00.000Z`
    writeFileSync(
      review,
      JSON.stringify({
        schemaVersion: 1,
        featureIds: ['SELF-001'],
        title: 'Retention',
        acceptanceRefs: ['docs/candidate-evidence.md'],
        status: 'ready-for-review',
        baseRef: 'main',
        headCommit: commit,
        changedFiles: ['src/self-change/release-retention.ts'],
        commands: [
          { command: 'pnpm check', status: 'passed', summary: 'passed' },
        ],
        artifacts: [],
        notTried: [],
        generatedAt: date,
      }),
    )
    const manifest = createCandidateManifest(
      {
        release: { id, root: path, commit, createdAt: date },
        compatibility: { minimumSchema: 1, maximumSchema: 59 },
        verification: {
          testedCommit: commit,
          ci: {
            workflow: 'CI',
            runId: '1',
            url: 'https://example.com/ci',
            conclusion: 'success',
            completedAt: date,
          },
          commands: [{ command: 'pnpm check', testCount: 1 }],
          smoke: { command: 'pnpm smoke', status: 'passed', completedAt: date },
          review: {
            approval: {
              reviewedCommit: commit,
              reviewer: 'test',
              reviewedAt: date,
            },
          },
          notTried: [],
        },
        createdAt: date,
      },
      artifact,
      review,
    )
    writeCandidateManifest(
      join(root, 'candidates', id + '.manifest.json'),
      manifest,
    )
    return manifest
  })
  const statePath = join(root, 'data', 'supervisor.json')
  const state = new ReleaseStateStore(statePath)
  const first = manifests[0],
    second = manifests[1]
  if (!first || !second) throw new Error('fixture missing')
  state.ensure(first.release)
  state.stage(
    second,
    join(root, 'candidates', 'release-1.json'),
    join(root, 'candidates', 'release-1.review.json'),
  )
  state.confirm()
  writeFileSync(join(root, 'data', 'supervisor.lock'), String(process.pid))
  const options: RetentionOptions = {
    releaseRoot: root,
    instances: [{ statePath, dataDirectory: join(root, 'data') }],
    inspectHost: () =>
      Promise.resolve({ paths: [], supervisorPids: [process.pid] }),
  }
  return { root, state, statePath, manifests, options }
}

describe('post-release retention', () => {
  it('detects legacy bundled, foreign-root and missing registered Supervisor processes', () => {
    const f = fixture(),
      supported = join(f.root, 'candidates/release-7')
    mkdirSync(join(supported, 'dist/self-change'), { recursive: true })
    writeFileSync(
      join(supported, 'dist/self-change/release-directory-lock.js'),
      'protocol',
    )
    const listing = `101 /usr/bin/node ${supported}/dist/supervisor/main.js\n102 /Applications/Pegas.app/Contents/MacOS/Pegas /Applications/Pegas.app/Contents/Resources/app/dist/supervisor/main.js\n103 /usr/bin/node /another/releases/candidates/old/dist/supervisor/main.js`
    const result = supervisorProcessProtection(
      listing,
      f.root,
      [101, 102, 103, 104],
    )
    expect(result.unsupportedSupervisors).toEqual([102, 103, 104])
    expect(result.supervisorPids).toEqual([101, 102, 103])
  })

  it('fences concurrent staging throughout the protection check and deletion', async () => {
    const f = fixture()
    let attempts = 0
    f.options.inspectHost = async () => {
      attempts++
      await expect(
        withReleaseDirectoryLock(f.root, () => {
          throw new Error('staging must never start during cleanup')
        }),
      ).rejects.toThrow(/maintenance/)
      return { paths: [], supervisorPids: [process.pid] }
    }
    const result = await pruneReleaseHistory(f.options)
    expect(result.status).toBe('completed')
    expect(attempts).toBeGreaterThan(1)
    expect(f.state.read().active.id).toBe('release-1')
    expect(existsSync(f.state.read().active.root)).toBe(true)
  })
  it('never reclaims an abandoned lock automatically or releases a replacement owner', async () => {
    const f = fixture(),
      lock = join(f.root, '.release-directory.lock')
    writeFileSync(lock, JSON.stringify({ pid: 999999, token: 'abandoned' }))
    expect((await pruneReleaseHistory(f.options)).status).toBe('skipped')
    expect(readFileSync(lock, 'utf8')).toContain('abandoned')
    rmSync(lock)
    const unlock = acquireReleaseDirectoryLock(f.root)
    rmSync(lock)
    writeFileSync(lock, 'replacement')
    unlock()
    expect(readFileSync(lock, 'utf8')).toBe('replacement')
  })
  it('retains another instance rollback and refuses legacy coordinators', async () => {
    const f = fixture(),
      statePath = join(f.root, 'other', 'supervisor.json')
    const other = new ReleaseStateStore(statePath),
      candidate = f.manifests[3]
    if (!candidate) throw new Error('fixture')
    other.ensure(candidate.release)
    f.options.instances?.push({
      statePath,
      dataDirectory: join(f.root, 'other'),
    })
    expect(
      (await pruneReleaseHistory({ ...f.options, dryRun: true })).kept,
    ).toContain('release-3')
    f.options.inspectHost = () =>
      Promise.resolve({
        paths: [],
        supervisorPids: [process.pid],
        unsupportedSupervisors: [process.pid],
      })
    expect((await pruneReleaseHistory(f.options)).reason).toMatch(
      /lock support/,
    )
    expect(existsSync(join(f.root, 'candidates/release-4'))).toBe(true)
  })

  it('keeps latest three plus active, previous, runtime and startup references; removes associated dependencies', async () => {
    const f = fixture()
    f.options.inspectHost = () =>
      Promise.resolve({
        paths: [
          join(f.root, 'candidates/release-2/dist/supervisor/main.js'),
          join(f.root, 'candidates/release-3/dist/supervisor/main.js'),
        ],
        supervisorPids: [process.pid],
      })
    const result = await pruneReleaseHistory(f.options)
    expect(result.status).toBe('completed')
    expect(result.deleted).toEqual(['release-4'])
    expect(result.kept).toEqual([
      'release-0',
      'release-1',
      'release-2',
      'release-3',
      'release-5',
      'release-6',
      'release-7',
    ])
    expect(existsSync(join(f.root, 'dependencies/release-4'))).toBe(false)
    expect(existsSync(join(f.root, 'candidates/release-4.manifest.json'))).toBe(
      false,
    )
    expect((await pruneReleaseHistory(f.options)).deleted).toEqual([])
  })
  it('protects cross-release dependency links and leaves unfinished builds and unrelated files alone', async () => {
    const f = fixture()
    symlinkSync(
      join(f.root, 'dependencies/release-4'),
      join(f.root, 'candidates/release-7/shared'),
    )
    mkdirSync(join(f.root, 'candidates/incomplete'))
    writeFileSync(join(f.root, 'candidates/notes.txt'), 'keep')
    const result = await pruneReleaseHistory(f.options)
    expect(result.deleted).toContain('release-3')
    expect(existsSync(join(f.root, 'dependencies/release-4'))).toBe(true)
    expect(existsSync(join(f.root, 'candidates/incomplete'))).toBe(true)
    expect(existsSync(join(f.root, 'candidates/notes.txt'))).toBe(true)
  })
  it('retains every intermediate Candidate in a multi-hop symlink chain', async () => {
    const f = fixture()
    symlinkSync(
      join(f.root, 'candidates/release-3/node_modules'),
      join(f.root, 'candidates/release-4/shared'),
    )
    symlinkSync(
      join(f.root, 'candidates/release-4/shared'),
      join(f.root, 'candidates/release-7/shared'),
    )
    writeFileSync(
      join(f.root, 'dependencies/release-3/value'),
      'still readable',
    )
    const result = await pruneReleaseHistory(f.options)
    expect(result.kept).toEqual(
      expect.arrayContaining(['release-3', 'release-4']),
    )
    expect(
      readFileSync(join(f.root, 'candidates/release-7/shared/value'), 'utf8'),
    ).toBe('still readable')
  })
  it('protects directories traversed before dotdot and resolves dotdot after symlinks', async () => {
    const f = fixture()
    symlinkSync(
      join(f.root, 'candidates/release-3'),
      join(f.root, 'candidates/release-4/alias'),
    )
    symlinkSync(
      f.root + '/candidates/release-4/../release-3/node_modules',
      join(f.root, 'candidates/release-7/shared'),
    )
    symlinkSync(
      f.root + '/candidates/release-4/alias/../release-2/node_modules',
      join(f.root, 'candidates/release-7/other'),
    )
    writeFileSync(join(f.root, 'dependencies/release-2/value'), 'two')
    writeFileSync(join(f.root, 'dependencies/release-3/value'), 'three')
    const result = await pruneReleaseHistory(f.options)
    expect(result.status).toBe('completed')
    expect(result.kept).toEqual(
      expect.arrayContaining(['release-2', 'release-3', 'release-4']),
    )
    expect(
      readFileSync(join(f.root, 'candidates/release-7/shared/value'), 'utf8'),
    ).toBe('three')
    expect(
      readFileSync(join(f.root, 'candidates/release-7/other/value'), 'utf8'),
    ).toBe('two')
  })
  it('reads symlink startup configurations and protects their offline bootstrap release', async () => {
    const f = fixture(),
      configs = join(f.root, 'LaunchAgents')
    mkdirSync(configs)
    const source = join(f.root, 'startup-config')
    writeFileSync(
      source,
      join(f.root, 'candidates/release-3/dist/supervisor/main.js'),
    )
    symlinkSync(source, join(configs, 'pegas.plist'))
    f.options.inspectHost = async () => ({
      paths: await readStartupReferences([configs]),
      supervisorPids: [process.pid],
    })
    const result = await pruneReleaseHistory(f.options)
    expect(result.status).toBe('completed')
    expect(result.kept).toContain('release-3')
    expect(existsSync(join(f.root, 'candidates/release-3'))).toBe(true)
  })
  it('skips cleanup when a startup configuration symlink is unreadable', async () => {
    const f = fixture(),
      configs = join(f.root, 'LaunchAgents')
    mkdirSync(configs)
    symlinkSync(join(f.root, 'missing-config'), join(configs, 'pegas.service'))
    f.options.inspectHost = async () => ({
      paths: await readStartupReferences([configs]),
      supervisorPids: [process.pid],
    })
    const result = await pruneReleaseHistory(f.options)
    expect(result.status).toBe('skipped')
    expect(result.deleted).toEqual([])
  })
  it('removes frozen directories without following a symlink outside the release tree', async () => {
    const f = fixture(),
      external = join(f.root, 'user-data')
    mkdirSync(external)
    writeFileSync(join(external, 'secret'), 'keep')
    symlinkSync(external, join(f.root, 'candidates/release-4/outside'))
    chmodSync(join(f.root, 'candidates/release-4'), 0o555)
    expect((await pruneReleaseHistory(f.options)).deleted).toContain(
      'release-4',
    )
    expect(readFileSync(join(external, 'secret'), 'utf8')).toBe('keep')
  })
  it.each([
    'verifying',
    'corrupt',
    'missing',
    'unknown-supervisor',
    'inventory-failure',
    'symlink-root',
  ])('does not delete when protection is uncertain: %s', async mode => {
    const f = fixture()
    if (mode === 'verifying') {
      const m = f.manifests[2]
      if (!m) throw new Error('fixture')
      f.state.stage(
        m,
        join(f.root, 'candidates/release-2.json'),
        join(f.root, 'candidates/release-2.review.json'),
      )
    }
    if (mode === 'corrupt') writeFileSync(f.statePath, 'broken')
    if (mode === 'missing') rmSync(f.statePath)
    if (mode === 'unknown-supervisor')
      f.options.inspectHost = () =>
        Promise.resolve({ paths: [], supervisorPids: [999999] })
    if (mode === 'inventory-failure')
      f.options.inspectHost = () => Promise.reject(new Error('ps unavailable'))
    if (mode === 'symlink-root') {
      rmSync(join(f.root, 'candidates/release-4'), { recursive: true })
      symlinkSync(
        join(f.root, 'dependencies/release-4'),
        join(f.root, 'candidates/release-4'),
      )
    }
    const result = await pruneReleaseHistory(f.options)
    expect(result.status).toBe('skipped')
    expect(result.deleted).toEqual([])
    expect(existsSync(join(f.root, 'candidates/release-3'))).toBe(true)
  })
  it('aborts if protection changes after planning and respects an existing cleanup owner', async () => {
    const f = fixture()
    let checks = 0
    f.options.inspectHost = () => {
      checks++
      return Promise.resolve({
        paths:
          checks > 1 ? [join(f.root, 'candidates/release-4/dist/main.js')] : [],
        supervisorPids: [process.pid],
      })
    }
    expect((await pruneReleaseHistory(f.options)).deleted).toEqual([])
    writeFileSync(join(f.root, '.release-directory.lock'), String(process.pid))
    expect((await pruneReleaseHistory(f.options)).reason).toMatch(
      /cleanup.*running/,
    )
    expect(existsSync(join(f.root, 'candidates/release-3'))).toBe(true)
  })
  it('reports dry-run without mutations and keeps malformed candidates', async () => {
    const f = fixture()
    const result = await pruneReleaseHistory({ ...f.options, dryRun: true })
    expect(result.planned).toEqual(['release-2', 'release-3', 'release-4'])
    expect(result.deleted).toEqual([])
    writeFileSync(join(f.root, 'candidates/release-3.manifest.json'), '{}')
    expect((await pruneReleaseHistory(f.options)).status).toBe('skipped')
    expect(existsSync(join(f.root, 'candidates/release-4'))).toBe(true)
  })
})
