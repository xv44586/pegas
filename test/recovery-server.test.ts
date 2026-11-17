import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ReleaseRef } from '../src/core/domain.js'
import { createCandidateManifest } from '../src/supervisor/candidate-manifest.js'
import { createRecoveryServer } from '../src/supervisor/recovery-server.js'
import { ReleaseStateStore } from '../src/supervisor/release-state.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('recovery server', () => {
  it('keeps health public and protects recovery operations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-recovery-server-'))
    const state = new ReleaseStateStore(join(directory, 'state.json'))
    const release: ReleaseRef = {
      id: 'release-1',
      root: '/releases/release-1',
      createdAt: '2026-11-17T00:00:00.000Z',
    }
    state.ensure(release)
    const onRestart = vi.fn(() => Promise.resolve())
    const onRollback = vi.fn(() => Promise.resolve())
    const server = createRecoveryServer({
      state,
      token: 'recovery-secret',
      onRestart,
      onRollback,
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => {
        rmSync(directory, { recursive: true, force: true })
        return Promise.resolve()
      },
    )
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${String(port)}`
    const authorization = { authorization: 'Bearer recovery-secret' }

    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200)
    expect((await fetch(`${baseUrl}/v1/recovery/status`)).status).toBe(401)

    const status = await fetch(`${baseUrl}/v1/recovery/status`, {
      headers: authorization,
    })
    expect(await status.json()).toMatchObject({
      active: release,
      recoveryState: { integrity: 'ok', source: 'primary' },
    })
    expect(
      (
        await fetch(`${baseUrl}/v1/recovery/restart`, {
          method: 'POST',
          headers: authorization,
        })
      ).status,
    ).toBe(202)
    expect(
      (
        await fetch(`${baseUrl}/v1/recovery/rollback`, {
          method: 'POST',
          headers: authorization,
        })
      ).status,
    ).toBe(202)
    expect(
      (
        await fetch(`${baseUrl}/v1/recovery/missing`, {
          headers: authorization,
        })
      ).status,
    ).toBe(404)

    await vi.waitFor(() => {
      expect(onRestart).toHaveBeenCalledOnce()
      expect(onRollback).toHaveBeenCalledWith(
        'Manual rollback requested through the recovery API',
      )
    })
  })

  it('keeps status available when both state copies are corrupt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-recovery-server-'))
    const state = new ReleaseStateStore(join(directory, 'state.json'))
    state.ensure({
      id: 'release-1',
      root: '/releases/release-1',
      createdAt: '2026-11-17T00:00:00.000Z',
    })
    const candidate = {
      id: 'release-2',
      root: '/releases/release-2',
      commit: 'b'.repeat(40),
      createdAt: '2026-11-17T01:00:00.000Z',
    }
    const artifactPath = join(directory, 'release-2.tar')
    writeFileSync(artifactPath, 'immutable candidate')
    state.stage(
      createCandidateManifest(
        {
          release: candidate,
          compatibility: { minimumSchema: 1, maximumSchema: 3 },
          verification: {
            testedCommit: candidate.commit,
            ci: {
              workflow: 'CI',
              runId: 'run-123',
              url: 'https://ci.example/runs/123',
              conclusion: 'success',
              completedAt: '2026-11-17T01:05:00.000Z',
            },
            commands: [{ command: 'pnpm check', testCount: 44 }],
            smoke: {
              command: 'pnpm smoke',
              status: 'passed',
              completedAt: '2026-11-17T01:07:00.000Z',
            },
            notTried: [],
          },
        },
        artifactPath,
      ),
      artifactPath,
    )
    writeFileSync(state.path, '{bad primary')
    writeFileSync(state.backupPath, '{bad backup')
    const server = createRecoveryServer({
      state,
      onRestart: () => Promise.resolve(),
      onRollback: () => Promise.resolve(),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => {
        rmSync(directory, { recursive: true, force: true })
        return Promise.resolve()
      },
    )
    const { port } = server.address() as AddressInfo

    expect(
      (await fetch(`http://127.0.0.1:${String(port)}/healthz`)).status,
    ).toBe(200)
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/v1/recovery/status`,
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      recoveryState: { integrity: 'unavailable', source: 'none' },
    })
  })
})
