import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

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
    expect(store.listOutbox('user-1')).toEqual([])
  })

  it('accepts authenticated proactive agent messages', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store, apiToken: 'secret' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/outbox`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        userId: 'user-1',
        dedupeKey: 'agent-message-1',
        payload: { type: 'agent.message', text: 'A decision is needed.' },
      }),
    })

    expect(response.status).toBe(202)
    expect(store.listOutbox('user-1')).toMatchObject([
      {
        channel: 'conversation',
        status: 'pending',
        payload: { type: 'agent.message', text: 'A decision is needed.' },
      },
    ])
  })

  it('transcribes a draft without enqueueing it and can accept a direct voice message', async () => {
    const store = new PegasStore(':memory:')
    const transcribe = vi.fn(() =>
      Promise.resolve({ text: '整理今天的会议记录', language: 'zh' }),
    )
    const server = createControlPlane({
      store,
      apiToken: 'secret',
      speechProvider: {
        name: 'test-speech',
        model: 'test-asr',
        transcribe,
      },
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${String(port)}`
    const headers = {
      authorization: 'Bearer secret',
      'content-type': 'audio/webm;codecs=opus',
    }

    const transcription = await fetch(
      `${baseUrl}/v1/voice/transcriptions?language=zh`,
      {
        method: 'POST',
        headers,
        body: Buffer.from('audio-draft'),
      },
    )

    expect(transcription.status).toBe(200)
    expect(await transcription.json()).toEqual({
      transcript: { text: '整理今天的会议记录', language: 'zh' },
      provider: 'test-speech',
      model: 'test-asr',
    })
    expect(store.listEvents('user-1')).toEqual([])
    expect(transcribe).toHaveBeenLastCalledWith(
      expect.objectContaining({
        contentType: 'audio/webm',
        filename: 'utterance.webm',
        language: 'zh',
      }),
    )

    const direct = await fetch(
      `${baseUrl}/v1/voice/messages?userId=user-1&source=ios&language=zh`,
      {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'voice-message-1' },
        body: Buffer.from('audio-direct'),
      },
    )

    expect(direct.status).toBe(202)
    expect(store.listEvents('user-1')).toMatchObject([
      {
        source: 'ios',
        payload: {
          text: '整理今天的会议记录',
          inputMode: 'voice',
          voice: {
            provider: 'test-speech',
            model: 'test-asr',
            requestedLanguage: 'zh',
            detectedLanguage: 'zh',
          },
        },
      },
    ])
  })

  it('reports unavailable speech recognition without accepting audio', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const { port } = server.address() as AddressInfo
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/v1/voice/transcriptions`,
      {
        method: 'POST',
        headers: { 'content-type': 'audio/webm' },
        body: Buffer.from('audio'),
      },
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: 'speech_unavailable',
    })
  })
})
