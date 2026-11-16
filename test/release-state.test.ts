import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ReleaseRef } from '../src/core/domain.js'
import { ReleaseStateStore } from '../src/supervisor/release-state.js'

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
  })
})

function release(id: string): ReleaseRef {
  return {
    id,
    root: `/releases/${id}`,
    createdAt: '2026-11-16T00:00:00.000Z',
  }
}
