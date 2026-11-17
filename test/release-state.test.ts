import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ReleaseRef } from '../src/core/domain.js'
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
    expect(state.stage(second)).toMatchObject({
      active: second,
      previous: first,
      phase: 'verifying',
    })
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
    state.stage(release('release-2'))

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
    state.stage(release('release-2'))
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
    state.stage(release('release-2'))
    expect(readFileSync(state.path, 'utf8')).toContain('"schemaVersion": 1')
  })
})

function release(id: string): ReleaseRef {
  return {
    id,
    root: `/releases/${id}`,
    createdAt: '2026-11-16T00:00:00.000Z',
  }
}
