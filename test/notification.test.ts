import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { OutboxDispatcher } from '../src/notification/dispatcher.js'
import { WebhookNotificationChannel } from '../src/notification/webhook-channel.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('OutboxDispatcher', () => {
  it('delivers a durable agent message with an idempotency key', async () => {
    let receivedBody: unknown
    let idempotencyKey: string | undefined
    const server = createServer(async (request, response) => {
      const header = request.headers['idempotency-key']
      idempotencyKey = Array.isArray(header) ? header[0] : header
      const chunks: Buffer[] = []
      for await (const rawChunk of request) {
        const chunk: unknown = rawChunk
        if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
        else if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      }
      receivedBody = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      ) as unknown
      response.writeHead(204).end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const { port } = server.address() as AddressInfo
    const store = new PegasStore(':memory:')
    store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'agent-message-1',
      payload: { type: 'agent.message', text: 'I need your decision.' },
    })
    const dispatcher = new OutboxDispatcher({
      store,
      dispatcherId: 'dispatcher-1',
      channel: new WebhookNotificationChannel({
        url: `http://127.0.0.1:${String(port)}/push`,
      }),
    })

    await expect(dispatcher.dispatchNext()).resolves.toBe(true)

    expect(idempotencyKey).toBe('agent-message-1')
    expect(receivedBody).toMatchObject({
      userId: 'user-1',
      payload: { type: 'agent.message', text: 'I need your decision.' },
    })
    expect(store.listOutbox('user-1')[0]).toMatchObject({
      status: 'sent',
      attempts: 1,
    })
    store.close()
  })

  it('returns a failed delivery to the retry queue', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503).end('not ready')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const { port } = server.address() as AddressInfo
    const store = new PegasStore(':memory:')
    store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'agent-message-2',
      payload: { type: 'agent.message', text: 'Retry me' },
    })
    const dispatcher = new OutboxDispatcher({
      store,
      dispatcherId: 'dispatcher-1',
      retryBaseMs: 60_000,
      channel: new WebhookNotificationChannel({
        url: `http://127.0.0.1:${String(port)}/push`,
      }),
    })

    await dispatcher.dispatchNext()

    expect(store.listOutbox('user-1')[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'Webhook returned 503: not ready',
    })
    expect(store.claimNextOutbox('dispatcher-2')).toBeUndefined()
    store.close()
  })
})
