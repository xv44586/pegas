import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'

import { createControlPlane } from '../src/control-plane/server.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function startControlPlane(
  linkPreview: Parameters<typeof createControlPlane>[0]['linkPreview'],
  apiToken?: string,
) {
  const store = new PegasStore(':memory:')
  const server = createControlPlane({ store, apiToken, linkPreview })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () => new Promise<void>(resolve => server.close(() => resolve())),
    () => Promise.resolve(store.close()),
  )
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${String(port)}`
}

describe('CONV-005 GET /v1/link-preview', () => {
  it('returns the preview projection for a fetchable page', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          '<head><meta property="og:title" content="Preview title"></head>',
          { headers: { 'content-type': 'text/html' } },
        ),
      ),
    )
    const base = await startControlPlane({
      fetchImpl,
      resolveHost: () => Promise.resolve([{ address: '93.184.216.34' }]),
    })
    const response = await fetch(
      `${base}/v1/link-preview?url=${encodeURIComponent('https://example.com/page')}`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ready',
      title: 'Preview title',
      description: null,
      image: null,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects unsafe targets without contacting the network', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('')))
    const base = await startControlPlane({ fetchImpl })
    for (const target of [
      'http://example.com/',
      'https://127.0.0.1/',
      'https://localhost/admin',
      'file:///etc/passwd',
    ]) {
      const response = await fetch(
        `${base}/v1/link-preview?url=${encodeURIComponent(target)}`,
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: 'unavailable' })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('requires the url parameter and GET method', async () => {
    const base = await startControlPlane({})
    const missing = await fetch(`${base}/v1/link-preview`)
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'url_required' })
    const posted = await fetch(
      `${base}/v1/link-preview?url=${encodeURIComponent('https://example.com/')}`,
      { method: 'POST' },
    )
    expect(posted.status).toBe(405)
  })

  it('stays behind bearer auth when a token is configured', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('')))
    const base = await startControlPlane({ fetchImpl }, 'secret-token')
    const query = `url=${encodeURIComponent('https://example.com/')}`
    const anonymous = await fetch(`${base}/v1/link-preview?${query}`)
    expect(anonymous.status).toBe(401)
    expect(fetchImpl).not.toHaveBeenCalled()
    const authorized = await fetch(`${base}/v1/link-preview?${query}`, {
      headers: { authorization: 'Bearer secret-token' },
    })
    expect(authorized.status).toBe(200)
    expect(await authorized.json()).toEqual({ status: 'unavailable' })
  })

  it('never fetches non-https targets even when private targets are allowed', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('')))
    const base = await startControlPlane({
      fetchImpl,
      allowPrivateTargets: true,
    })
    const response = await fetch(
      `${base}/v1/link-preview?url=${encodeURIComponent('http://127.0.0.1:9/')}`,
    )
    expect(await response.json()).toEqual({ status: 'unavailable' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
