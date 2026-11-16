import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('control plane', () => {
  it('accepts authenticated events and deduplicates retries', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store, apiToken: 'secret' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${String(port)}`
    const body = {
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      dedupeKey: 'message-1',
      payload: { text: 'Hello Pegas' },
    }

    const unauthorized = await fetch(`${baseUrl}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const first = await fetch(`${baseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const duplicate = await fetch(`${baseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const events = await fetch(`${baseUrl}/v1/events?userId=user-1`, {
      headers: { authorization: 'Bearer secret' },
    })
    const eventBody = (await events.json()) as {
      events: { payload: unknown }[]
    }

    expect(unauthorized.status).toBe(401)
    expect(first.status).toBe(202)
    expect(duplicate.status).toBe(200)
    expect(events.status).toBe(200)
    expect(eventBody.events).toHaveLength(1)
    expect(eventBody.events[0]?.payload).toEqual({ text: 'Hello Pegas' })
  })
})
