import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ReleaseRef } from '../src/core/domain.js'
import {
  createReviewReport,
  writeReviewReport,
} from '../src/quality/review-evidence.js'
import { createCandidateManifest } from '../src/supervisor/candidate-manifest.js'
import { createRecoveryServer } from '../src/supervisor/recovery-server.js'
import { ReleaseStateStore } from '../src/supervisor/release-state.js'
import {
  RollbackCompatibilityError,
  RollbackUnavailableError,
} from '../src/supervisor/rollback-compatibility.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('recovery server', () => {
  it('waits for rollback completion before returning 202', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-recovery-wait-'))
    const state = new ReleaseStateStore(join(directory, 'state.json'))
    state.ensure({
      id: 'release-1',
      root: '/releases/release-1',
      createdAt: '2026-11-17T00:00:00.000Z',
    })
    let enterRollback: (() => void) | undefined
    let finishRollback: (() => void) | undefined
    const entered = new Promise<void>(resolve => {
      enterRollback = resolve
    })
    const gate = new Promise<void>(resolve => {
      finishRollback = resolve
    })
    const server = createRecoveryServer({
      state,
      onRestart: () => Promise.resolve(),
      onRollback: async () => {
        required(enterRollback)()
        await gate
      },
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
    let settled = false
    const request = fetch(
      `http://127.0.0.1:${String(port)}/v1/recovery/rollback`,
      { method: 'POST' },
    ).then(response => {
      settled = true
      return response
    })
    await entered
    await Promise.resolve()
    expect(settled).toBe(false)
    required(finishRollback)()
    const response = await request
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: 'rolling_back' })
  })

  it('serializes concurrent rollback requests', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-recovery-serial-'))
    const state = new ReleaseStateStore(join(directory, 'state.json'))
    state.ensure({
      id: 'release-1',
      root: '/releases/release-1',
      createdAt: '2026-11-17T00:00:00.000Z',
    })
    let enterRollback: (() => void) | undefined
    let finishRollback: (() => void) | undefined
    const entered = new Promise<void>(resolve => {
      enterRollback = resolve
    })
    const gate = new Promise<void>(resolve => {
      finishRollback = resolve
    })
    const onRollback = vi.fn(async () => {
      required(enterRollback)()
      await gate
    })
    const server = createRecoveryServer({
      state,
      onRestart: () => Promise.resolve(),
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
    const endpoint = `http://127.0.0.1:${String(port)}/v1/recovery/rollback`
    const first = fetch(endpoint, { method: 'POST' })
    await entered
    const concurrent = await fetch(endpoint, { method: 'POST' })
    expect(concurrent.status).toBe(409)
    expect(await concurrent.json()).toEqual({
      error: 'rollback_in_progress',
      message: 'A rollback is already in progress',
    })
    expect(onRollback).toHaveBeenCalledOnce()
    required(finishRollback)()
    expect((await first).status).toBe(202)
  })

  it('returns a conflict before an incompatible rollback starts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-recovery-guard-'))
    const state = new ReleaseStateStore(join(directory, 'state.json'))
    state.ensure({
      id: 'release-1',
      root: '/releases/release-1',
      createdAt: '2026-11-17T00:00:00.000Z',
    })
    const onRollback = vi.fn<(reason: string) => void>()
    const server = createRecoveryServer({
      state,
      onRestart: () => Promise.resolve(),
      onRollback: reason => {
        onRollback(reason)
        return Promise.reject(
          new RollbackCompatibilityError('live collaboration state'),
        )
      },
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
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/v1/recovery/rollback`,
      { method: 'POST' },
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'rollback_incompatible',
      message: 'live collaboration state',
    })
    expect(onRollback).toHaveBeenCalledWith(
      'Manual rollback requested through the recovery API',
    )
  })

  it('types unavailable and failed rollback checks without leaking details', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-recovery-errors-'))
    const state = new ReleaseStateStore(join(directory, 'state.json'))
    state.ensure({
      id: 'release-1',
      root: '/releases/release-1',
      createdAt: '2026-11-17T00:00:00.000Z',
    })
    let error: Error = new RollbackUnavailableError('no previous release')
    const server = createRecoveryServer({
      state,
      onRestart: () => Promise.resolve(),
      onRollback: () => {
        throw error
      },
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
    const endpoint = `http://127.0.0.1:${String(port)}/v1/recovery/rollback`
    const unavailable = await fetch(endpoint, { method: 'POST' })
    expect(unavailable.status).toBe(409)
    expect(await unavailable.json()).toEqual({
      error: 'rollback_unavailable',
      message: 'no previous release',
    })

    error = new Error('database path /secret failed')
    const failed = await fetch(endpoint, { method: 'POST' })
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({
      error: 'rollback_check_failed',
      message: 'Rollback compatibility check failed',
    })
  })

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
    const reviewReportPath = join(directory, 'feature-review.json')
    writeFileSync(artifactPath, 'immutable candidate')
    writeReviewReport(
      reviewReportPath,
      createReviewReport({
        featureIds: ['QUALITY-001'],
        title: 'Recovery candidate review',
        acceptanceRefs: ['docs/feature-map.md#quality-001'],
        baseRef: 'origin/main',
        headCommit: candidate.commit,
        changedFiles: ['src/supervisor/recovery-server.ts'],
        commands: [
          { command: 'pnpm check', status: 'passed', summary: 'passed' },
        ],
        notTried: [],
        generatedAt: '2026-11-17T01:04:00.000Z',
      }),
    )
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
            review: {
              approval: {
                reviewedCommit: candidate.commit,
                reviewer: 'release-reviewer',
                reviewedAt: '2026-11-17T01:08:00.000Z',
              },
            },
            notTried: [],
          },
        },
        artifactPath,
        reviewReportPath,
      ),
      artifactPath,
      reviewReportPath,
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

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected required value')
  return value
}
