import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createControlPlane,
  type ControlPlaneOptions,
} from '../src/control-plane/server.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () => new Promise<void>(resolve => server.close(() => resolve())),
  )
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

async function startControlPlane(
  options: Omit<ControlPlaneOptions, 'store'>,
): Promise<string> {
  const store = new PegasStore(':memory:')
  cleanups.push(() => Promise.resolve(store.close()))
  return listen(createControlPlane({ ...options, store }))
}

function fakeDesktopMain(options: { failSwitch?: boolean } = {}) {
  let resident = false
  const switches: boolean[] = []
  const server = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer desktop-token') {
      response.writeHead(401).end()
      return
    }
    if (request.url !== '/desktop/residency') {
      response.writeHead(404).end()
      return
    }
    if (request.method === 'GET') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ resident, loginItemRegistered: resident }))
      return
    }
    let body = ''
    request.on('data', chunk => (body += String(chunk)))
    request.on('end', () => {
      const parsed = JSON.parse(body) as { resident: boolean }
      if (options.failSwitch) {
        response.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: 'residency_switch_failed',
            message: 'login item registration failed',
          }),
        )
        return
      }
      switches.push(parsed.resident)
      resident = parsed.resident
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ resident, loginItemRegistered: resident }))
    })
  })
  return { server, switches, current: () => resident }
}

describe('control plane desktop residency proxy', () => {
  it('plain server deployments get an honest read-only projection, never a fake toggle', async () => {
    const base = await startControlPlane({})
    const response = await fetch(`${base}/v1/desktop/residency`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.managed).toBe(false)
    expect(JSON.stringify(body)).toContain('部署方式')
    const put = await fetch(`${base}/v1/desktop/residency`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resident: true }),
    })
    expect(put.status).toBe(200)
    expect(((await put.json()) as { managed: boolean }).managed).toBe(false)
  })

  it('requires the instance bearer and rejects unsupported methods', async () => {
    const base = await startControlPlane({ apiToken: 'cp-token' })
    expect((await fetch(`${base}/v1/desktop/residency`)).status).toBe(401)
    const post = await fetch(`${base}/v1/desktop/residency`, {
      method: 'POST',
      headers: { authorization: 'Bearer cp-token' },
    })
    expect(post.status).toBe(405)
  })

  it('proxies reads and switches with the server-side token only', async () => {
    const desktop = fakeDesktopMain()
    const desktopBase = await listen(desktop.server)
    const base = await startControlPlane({
      desktopResidency: { baseUrl: desktopBase, token: 'desktop-token' },
    })
    const initial = (await (
      await fetch(`${base}/v1/desktop/residency`)
    ).json()) as Record<string, unknown>
    expect(initial).toMatchObject({
      managed: true,
      resident: false,
      loginItemRegistered: false,
    })
    const switched = await fetch(`${base}/v1/desktop/residency`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resident: true }),
    })
    expect(switched.status).toBe(200)
    expect(await switched.json()).toMatchObject({
      managed: true,
      resident: true,
      loginItemRegistered: true,
    })
    expect(desktop.switches).toEqual([true])
    const back = await fetch(`${base}/v1/desktop/residency`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resident: false }),
    })
    expect(back.status).toBe(200)
    expect(desktop.current()).toBe(false)
  })

  it('rejects malformed switch bodies before touching the desktop main', async () => {
    const desktop = fakeDesktopMain()
    const desktopBase = await listen(desktop.server)
    const base = await startControlPlane({
      desktopResidency: { baseUrl: desktopBase, token: 'desktop-token' },
    })
    const bad = await fetch(`${base}/v1/desktop/residency`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resident: 'yes' }),
    })
    expect(bad.status).toBe(400)
    expect(desktop.switches).toEqual([])
  })

  it('failed switches surface honestly and keep the previous state', async () => {
    const desktop = fakeDesktopMain({ failSwitch: true })
    const desktopBase = await listen(desktop.server)
    const base = await startControlPlane({
      desktopResidency: { baseUrl: desktopBase, token: 'desktop-token' },
    })
    const failed = await fetch(`${base}/v1/desktop/residency`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resident: true }),
    })
    expect(failed.status).toBe(502)
    const body = (await failed.json()) as { message: string }
    expect(body.message).toContain('login item registration failed')
    expect(desktop.current()).toBe(false)
  })

  it('an unreachable desktop main degrades to readable diagnostics, not fake state', async () => {
    const desktop = fakeDesktopMain()
    const desktopBase = await listen(desktop.server)
    await new Promise<void>(resolve => desktop.server.close(() => resolve()))
    const base = await startControlPlane({
      desktopResidency: { baseUrl: desktopBase, token: 'desktop-token' },
    })
    const read = (await (
      await fetch(`${base}/v1/desktop/residency`)
    ).json()) as Record<string, unknown>
    expect(read.managed).toBe(true)
    expect(read.resident).toBeUndefined()
    expect(JSON.stringify(read.diagnostics)).toContain('无法连接桌面主进程')
    const put = await fetch(`${base}/v1/desktop/residency`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resident: true }),
    })
    expect(put.status).toBe(503)
  })
})
