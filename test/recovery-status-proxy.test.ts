import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import { createRecoveryServer } from '../src/supervisor/recovery-server.js'
import { ReleaseStateStore } from '../src/supervisor/release-state.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function startControlPlane(
  options: Parameters<typeof createControlPlane>[0],
): Promise<string> {
  const server = createControlPlane(options)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () => new Promise<void>(resolve => server.close(() => resolve())),
  )
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

function tempStateDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => {
    rmSync(directory, { recursive: true, force: true })
    return Promise.resolve()
  })
  return directory
}

describe('control plane recovery status proxy', () => {
  it('reports an honest unavailable projection when no recovery plane is configured', async () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => Promise.resolve(store.close()))
    const base = await startControlPlane({ store })
    const response = await fetch(`${base}/v1/recovery/status`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      available: false,
      integrity: 'unavailable',
      source: 'none',
    })
    expect(JSON.stringify(body)).toContain('PEGAS_RECOVERY_BASE_URL')
  })

  it('requires the control plane bearer and rejects non-GET methods', async () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => Promise.resolve(store.close()))
    const base = await startControlPlane({ store, apiToken: 'instance-token' })
    const unauthorized = await fetch(`${base}/v1/recovery/status`)
    expect(unauthorized.status).toBe(401)
    const post = await fetch(`${base}/v1/recovery/status`, {
      method: 'POST',
      headers: { authorization: 'Bearer instance-token' },
    })
    expect(post.status).toBe(405)
    const authorized = await fetch(`${base}/v1/recovery/status`, {
      headers: { authorization: 'Bearer instance-token' },
    })
    expect(authorized.status).toBe(200)
  })

  it('proxies supervisor status with the recovery token and strips filesystem paths', async () => {
    const directory = tempStateDirectory('pegas-recovery-proxy-')
    const statePath = join(directory, 'state.json')
    const state = new ReleaseStateStore(statePath)
    state.ensure({
      id: 'release-previous',
      root: join(directory, 'releases', 'release-previous'),
      createdAt: '2026-11-19T00:00:00.000Z',
    })
    copyFileSync(statePath, `${statePath}.last-good`)
    writeFileSync(
      statePath,
      JSON.stringify({
        active: {
          id: 'release-active',
          root: join(directory, 'releases', 'release-active'),
          commit: 'abc1234',
          createdAt: '2026-11-20T00:00:00.000Z',
          compatibility: { minimumSchema: 1, maximumSchema: 30 },
        },
        previous: {
          id: 'release-previous',
          root: join(directory, 'releases', 'release-previous'),
          createdAt: '2026-11-19T00:00:00.000Z',
        },
        phase: 'stable',
        updatedAt: '2026-11-20T01:00:00.000Z',
      }),
    )
    let receivedAuthorization = ''
    const recovery = createRecoveryServer({
      state,
      token: 'recovery-token',
      onRestart: () => Promise.resolve(),
      onRollback: () => Promise.resolve(),
    })
    const wrapped = createServer((request, response) => {
      receivedAuthorization = request.headers.authorization ?? ''
      recovery.emit('request', request, response)
    })
    await new Promise<void>(resolve => wrapped.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => wrapped.close(() => resolve())),
      () => new Promise<void>(resolve => recovery.close(() => resolve())),
    )
    const recoveryBase = `http://127.0.0.1:${String((wrapped.address() as AddressInfo).port)}`
    const store = new PegasStore(':memory:')
    cleanups.push(() => Promise.resolve(store.close()))
    const base = await startControlPlane({
      store,
      recoveryStatus: { baseUrl: recoveryBase, token: 'recovery-token' },
    })
    const response = await fetch(`${base}/v1/recovery/status`)
    expect(response.status).toBe(200)
    expect(receivedAuthorization).toBe('Bearer recovery-token')
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      available: true,
      integrity: 'ok',
      source: 'primary',
      phase: 'stable',
      active: {
        id: 'release-active',
        commit: 'abc1234',
        compatibility: { minimumSchema: 1, maximumSchema: 30 },
      },
      previous: { id: 'release-previous' },
    })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(directory)
    expect(serialized).not.toContain('root')
    expect(serialized).not.toContain('recovery-token')
  })

  it('maps degraded supervisor state without inventing an active release', async () => {
    const directory = tempStateDirectory('pegas-recovery-degraded-')
    const statePath = join(directory, 'state.json')
    const state = new ReleaseStateStore(statePath)
    state.ensure({
      id: 'release-good',
      root: join(directory, 'releases', 'release-good'),
      createdAt: '2026-11-20T00:00:00.000Z',
    })
    writeFileSync(statePath, '{"schemaVersion":1,"checksum":"broken"')
    const recovery = createRecoveryServer({
      state,
      onRestart: () => Promise.resolve(),
      onRollback: () => Promise.resolve(),
    })
    await new Promise<void>(resolve => recovery.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => recovery.close(() => resolve())),
    )
    const recoveryBase = `http://127.0.0.1:${String((recovery.address() as AddressInfo).port)}`
    const store = new PegasStore(':memory:')
    cleanups.push(() => Promise.resolve(store.close()))
    const base = await startControlPlane({
      store,
      recoveryStatus: { baseUrl: recoveryBase },
    })
    const response = await fetch(`${base}/v1/recovery/status`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      available: true,
      integrity: 'degraded',
      source: 'backup',
      active: { id: 'release-good' },
    })
    expect(Array.isArray(body.diagnostics)).toBe(true)
  })

  it('reports unavailable with diagnostics when both supervisor state files are corrupt', async () => {
    const directory = tempStateDirectory('pegas-recovery-unavailable-')
    const statePath = join(directory, 'state.json')
    writeFileSync(statePath, 'corrupt-primary')
    writeFileSync(`${statePath}.last-good`, 'corrupt-backup')
    const state = new ReleaseStateStore(statePath)
    const recovery = createRecoveryServer({
      state,
      onRestart: () => Promise.resolve(),
      onRollback: () => Promise.resolve(),
    })
    await new Promise<void>(resolve => recovery.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => recovery.close(() => resolve())),
    )
    const recoveryBase = `http://127.0.0.1:${String((recovery.address() as AddressInfo).port)}`
    const store = new PegasStore(':memory:')
    cleanups.push(() => Promise.resolve(store.close()))
    const base = await startControlPlane({
      store,
      recoveryStatus: { baseUrl: recoveryBase },
    })
    const response = await fetch(`${base}/v1/recovery/status`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      available: false,
      integrity: 'unavailable',
      source: 'none',
    })
    expect(body.active).toBeUndefined()
  })

  it('returns an honest unavailable projection when the recovery plane is unreachable', async () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => Promise.resolve(store.close()))
    const base = await startControlPlane({
      store,
      recoveryStatus: {
        baseUrl: 'http://127.0.0.1:1',
        timeoutMs: 200,
      },
    })
    const response = await fetch(`${base}/v1/recovery/status`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      available: false,
      integrity: 'unavailable',
    })
    expect(JSON.stringify(body.diagnostics)).toContain('Supervisor')
  })

  it('surfaces a configuration hint when the recovery plane rejects the token', async () => {
    const directory = tempStateDirectory('pegas-recovery-auth-')
    const state = new ReleaseStateStore(join(directory, 'state.json'))
    state.ensure({
      id: 'release-active',
      root: join(directory, 'releases', 'release-active'),
      createdAt: '2026-11-20T00:00:00.000Z',
    })
    const recovery = createRecoveryServer({
      state,
      token: 'expected-token',
      onRestart: () => Promise.resolve(),
      onRollback: () => Promise.resolve(),
    })
    await new Promise<void>(resolve => recovery.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => recovery.close(() => resolve())),
    )
    const recoveryBase = `http://127.0.0.1:${String((recovery.address() as AddressInfo).port)}`
    const store = new PegasStore(':memory:')
    cleanups.push(() => Promise.resolve(store.close()))
    const base = await startControlPlane({
      store,
      recoveryStatus: { baseUrl: recoveryBase, token: 'wrong-token' },
    })
    const response = await fetch(`${base}/v1/recovery/status`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ available: false })
    expect(JSON.stringify(body.diagnostics)).toContain('PEGAS_RECOVERY_TOKEN')
    expect(JSON.stringify(body)).not.toContain('wrong-token')
  })

  it('never exposes restart or rollback recovery endpoints through the proxy', async () => {
    const directory = tempStateDirectory('pegas-recovery-readonly-')
    const state = new ReleaseStateStore(join(directory, 'state.json'))
    state.ensure({
      id: 'release-active',
      root: join(directory, 'releases', 'release-active'),
      createdAt: '2026-11-20T00:00:00.000Z',
    })
    const recovery = createRecoveryServer({
      state,
      onRestart: () => Promise.resolve(),
      onRollback: () => Promise.resolve(),
    })
    await new Promise<void>(resolve => recovery.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => recovery.close(() => resolve())),
    )
    const recoveryBase = `http://127.0.0.1:${String((recovery.address() as AddressInfo).port)}`
    const store = new PegasStore(':memory:')
    cleanups.push(() => Promise.resolve(store.close()))
    const base = await startControlPlane({
      store,
      recoveryStatus: { baseUrl: recoveryBase },
    })
    for (const path of [
      '/v1/recovery/restart',
      '/v1/recovery/rollback',
      '/v1/recovery/candidates',
    ]) {
      const response = await fetch(`${base}${path}`, { method: 'POST' })
      expect(response.status).toBe(404)
    }
  })
})
