import type { AddressInfo } from 'node:net'
import { createServer, type ServerResponse } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import { loadConfig } from '../src/core/config.js'
import { ModelCredentialVault } from '../src/model/model-credential-vault.js'
import { settingsCapabilities } from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function startJsonServer(
  respond: (path: string, response: ServerResponse) => void,
): Promise<{ server: ReturnType<typeof createServer>; baseUrl: string }> {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    respond(request.url ?? '/', response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${String(port)}/v1` }
}

describe('control plane', () => {
  it('tests a draft rewrite connection without saving it or creating an event', async () => {
    let receivedAuthorization = ''
    let upstreamStatus = 200
    const upstream = createServer((request, response) => {
      receivedAuthorization = request.headers.authorization ?? ''
      request.resume()
      response.setHeader('content-type', 'application/json')
      if (upstreamStatus !== 200) {
        response.statusCode = upstreamStatus
        response.end('upstream private diagnostic')
        return
      }
      response.end(
        JSON.stringify({
          choices: [{ message: { content: '{"text":"请安排明天的会议。"}' } }],
        }),
      )
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as AddressInfo).port
    const store = new PegasStore(':memory:')
    store.initializeRuntimeSettings({
      routerMode: 'rules',
      modelProvider: 'openai',
      modelName: 'unused',
      agentModelMode: 'profile',
      agentModelProvider: '',
      agentModelName: '',
      privacyMode: 'disabled',
      rewriteMode: 'disabled',
    })
    const vault = new ModelCredentialVault(Buffer.alloc(32, 9))
    const server = createControlPlane({
      store,
      modelCredentialVault: vault,
      settingsCapabilities: settingsCapabilities(loadConfig()),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => new Promise<void>(resolve => upstream.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const result = await fetch(`${base}/v1/settings/rewrite/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '呃，请安排明天的会议',
        rewrite: {
          mode: 'custom',
          protocol: 'openai-chat',
          baseUrl: `http://127.0.0.1:${String(upstreamPort)}/v1`,
          model: 'rewrite-test',
          apiKey: 'probe-credential',
          clearApiKey: false,
        },
      }),
    })
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({
      original: '呃，请安排明天的会议',
      rewritten: '请安排明天的会议。',
      changed: true,
    })
    expect(receivedAuthorization).toBe('Bearer probe-credential')
    expect(store.getRuntimeSettings().revision).toBe(1)
    expect(store.listEvents('owner')).toEqual([])
    upstreamStatus = 401
    const failed = await fetch(`${base}/v1/settings/rewrite/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '请安排会议',
        rewrite: {
          mode: 'custom',
          protocol: 'openai-chat',
          baseUrl: `http://127.0.0.1:${String(upstreamPort)}/v1`,
          model: 'rewrite-test',
          apiKey: 'probe-credential',
          clearApiKey: false,
        },
      }),
    })
    expect(failed.status).toBe(400)
    const failedText = await failed.text()
    expect(failedText).toContain('密钥无效')
    expect(failedText).not.toContain('upstream private diagnostic')
    expect(failedText).not.toContain('probe-credential')
    upstreamStatus = 200
    store.updateRuntimeSettingsAndProvider(
      1,
      store.getRuntimeSettings(),
      {
        id: 'openai',
        name: 'OpenAI',
        protocol: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        clearApiKey: false,
      },
      undefined,
      {
        mode: 'custom',
        protocol: 'openai-chat',
        baseUrl: `http://127.0.0.1:${String(upstreamPort)}/old`,
        model: 'saved-model',
        apiKeyCiphertext: vault.encrypt('saved-credential'),
        clearApiKey: false,
      },
    )
    const differentTarget = await fetch(`${base}/v1/settings/rewrite/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '呃，请安排明天的会议',
        rewrite: {
          mode: 'custom',
          protocol: 'openai-chat',
          baseUrl: `http://127.0.0.1:${String(upstreamPort)}/v1`,
          model: 'rewrite-test',
          clearApiKey: false,
        },
      }),
    })
    expect(differentTarget.status).toBe(200)
    expect(receivedAuthorization).toBe('')
    const settingsResponse = await fetch(`${base}/v1/settings`)
    const settingsText = await settingsResponse.text()
    expect(settingsText).toContain('"hasApiKey":true')
    expect(settingsText).not.toContain('saved-credential')
  })

  it('reads and atomically updates server-authoritative runtime settings', async () => {
    const store = new PegasStore(':memory:')
    store.initializeRuntimeSettings({
      routerMode: 'model',
      modelProvider: 'openai',
      modelName: 'gpt-default',
      agentModelMode: 'profile',
      agentModelProvider: '',
      agentModelName: '',
      privacyMode: 'disabled',
      rewriteMode: 'disabled',
    })
    const modelCredentialVault = new ModelCredentialVault(Buffer.alloc(32, 3))
    store.initializeModelProviderConnection({
      id: 'openai',
      name: 'OpenAI',
      protocol: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyCiphertext: modelCredentialVault.encrypt('openai-secret'),
    })
    const config = loadConfig({
      PEGAS_PRIVACY_HMAC_KEY: 'privacy-key-long-enough',
    })
    const capabilities = () =>
      settingsCapabilities(config, store.listModelProviderConnectionSummaries())
    const server = createControlPlane({
      store,
      apiToken: 'secret',
      settingsCapabilities: capabilities,
      modelCredentialVault,
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${String(port)}/v1/settings`
    const headers = {
      authorization: 'Bearer secret',
      'content-type': 'application/json',
    }

    const initial = await fetch(url, { headers })
    const initialText = await initial.text()
    expect(initialText).not.toContain('openai-secret')
    expect(initialText).not.toContain('v1.')
    expect(JSON.parse(initialText)).toMatchObject({
      settings: { modelName: 'gpt-default', revision: 1 },
      capabilities: capabilities(),
    })

    const updateBody = {
      expectedRevision: 1,
      routerMode: 'rules',
      modelProvider: 'openai',
      modelName: 'gpt-updated',
      agentModelMode: 'override',
      agentModelProvider: 'magpie',
      agentModelName: 'agent-model',
      privacyMode: 'mask',
      rewriteMode: 'light',
    }
    const updated = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(updateBody),
    })
    expect(updated.status).toBe(200)
    const updatedText = await updated.text()
    expect(updatedText).not.toContain('openai-secret')
    expect(updatedText).not.toContain('v1.')
    expect(JSON.parse(updatedText)).toMatchObject({
      settings: {
        routerMode: 'rules',
        modelProvider: 'openai',
        modelName: 'gpt-updated',
        agentModelMode: 'override',
        agentModelProvider: 'magpie',
        agentModelName: 'agent-model',
        privacyMode: 'mask',
        rewriteMode: 'light',
        revision: 2,
      },
    })

    const stale = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(updateBody),
    })
    expect(stale.status).toBe(409)

    const unavailable = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        ...updateBody,
        expectedRevision: 2,
        modelProvider: 'anthropic',
      }),
    })
    expect(unavailable.status).toBe(400)
    expect(await unavailable.json()).toMatchObject({
      message: '尚未配置 API key',
    })
  })

  it('authenticates retries and creates only one successor for repeated requests', async () => {
    const store = new PegasStore(':memory:')
    const event = store.enqueueEvent({
      userId: 'owner',
      source: 'web',
      type: 'user.message',
      payload: { text: 'Retry me' },
    }).event
    const initial = store.applyRoutingDecision(
      event,
      {
        kind: 'create_task',
        title: 'Retry',
        goal: 'Retry',
        input: 'Retry',
        reason: 'test',
      },
      'test',
    )
    store.claimNextRun('worker')
    store.failRun(initial.run.id, 'worker', 'timeout')
    const server = createControlPlane({ store, apiToken: 'secret' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${String(port)}/v1/runs/${initial.run.id}/retry`
    const headers = {
      authorization: 'Bearer secret',
      'content-type': 'application/json',
    }
    expect(
      (
        await fetch(url, {
          method: 'POST',
          body: JSON.stringify({ userId: 'owner' }),
        })
      ).status,
    ).toBe(401)
    expect(
      (await fetch(url, { method: 'POST', headers, body: '{}' })).status,
    ).toBe(400)
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ userId: 'other' }),
        })
      ).status,
    ).toBe(400)
    const first = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: 'owner' }),
    })
    const replay = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: 'owner' }),
    })
    expect(first.status).toBe(200)
    expect(await replay.json()).toEqual(await first.json())
    expect(store.listRuns()).toHaveLength(2)
    expect(store.listTasks()).toHaveLength(1)
  })

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

  it('discovers and tests the draft model connection and exposes DSH models', async () => {
    const upstream = await startJsonServer((path, response) => {
      if (path === '/v1/models') {
        response.end(JSON.stringify({ data: [{ id: 'router-model' }] }))
        return
      }
      response.end(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
        }),
      )
    })
    const store = new PegasStore(':memory:')
    store.initializeRuntimeSettings({
      routerMode: 'rules',
      modelProvider: 'custom',
      modelName: 'router-model',
      agentModelMode: 'profile',
      agentModelProvider: '',
      agentModelName: '',
      privacyMode: 'disabled',
      rewriteMode: 'disabled',
    })
    const config = loadConfig()
    const server = createControlPlane({
      store,
      settingsCapabilities: () =>
        settingsCapabilities(
          config,
          store.listModelProviderConnectionSummaries(),
        ),
      modelCredentialVault: new ModelCredentialVault(Buffer.alloc(32, 9)),
      agentModelCatalog: () =>
        Promise.resolve({
          defaultProvider: 'magpie',
          defaultModel: 'agent-default',
          models: [
            { provider: 'magpie', id: 'agent-default', name: 'Agent default' },
          ],
        }),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () =>
        new Promise<void>(resolve => upstream.server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${String(port)}`
    const body = JSON.stringify({
      modelProvider: 'custom',
      modelName: 'router-model',
      provider: {
        name: 'Local test',
        protocol: 'openai-chat',
        baseUrl: upstream.baseUrl,
        apiKey: '',
        clearApiKey: false,
      },
    })
    const headers = { 'content-type': 'application/json' }

    const discovered = await fetch(`${baseUrl}/v1/settings/models/discover`, {
      method: 'POST',
      headers,
      body,
    })
    const tested = await fetch(`${baseUrl}/v1/settings/models/test`, {
      method: 'POST',
      headers,
      body,
    })
    const agentModels = await fetch(`${baseUrl}/v1/settings/agent-models`)

    expect(await discovered.json()).toEqual({
      models: [{ id: 'router-model', name: 'router-model' }],
    })
    expect(await tested.json()).toMatchObject({ ok: true })
    expect(await agentModels.json()).toMatchObject({
      defaultProvider: 'magpie',
      defaultModel: 'agent-default',
    })
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

  it('saves a speech connection and uses it for the next transcription without exposing its key', async () => {
    let upstreamAuthorization = ''
    const upstream = createServer((request, response) => {
      upstreamAuthorization = request.headers.authorization ?? ''
      request.resume()
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ text: '语音设置已生效' }))
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as AddressInfo).port
    const store = new PegasStore(':memory:')
    store.initializeRuntimeSettings({
      routerMode: 'rules',
      modelProvider: 'openai',
      modelName: 'gpt-test',
      agentModelMode: 'profile',
      agentModelProvider: '',
      agentModelName: '',
      privacyMode: 'disabled',
      rewriteMode: 'disabled',
    })
    const vault = new ModelCredentialVault(Buffer.alloc(32, 5))
    const server = createControlPlane({
      store,
      modelCredentialVault: vault,
      settingsCapabilities: settingsCapabilities(loadConfig()),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => new Promise<void>(resolve => upstream.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const before = await fetch(`${baseUrl}/v1/voice/transcriptions`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: Buffer.from('audio'),
    })
    expect(before.status).toBe(503)

    const updateBody = {
      expectedRevision: 1,
      routerMode: 'rules',
      modelProvider: 'openai',
      modelName: 'gpt-test',
      agentModelMode: 'profile',
      agentModelProvider: '',
      agentModelName: '',
      privacyMode: 'disabled',
      rewriteMode: 'disabled',
      speech: {
        provider: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${String(upstreamPort)}/v1`,
        model: 'asr-test',
        apiKey: 'fixture-key',
        clearApiKey: false,
      },
    }
    const saved = await fetch(`${baseUrl}/v1/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updateBody),
    })
    expect(saved.status).toBe(200)
    const savedText = await saved.text()
    expect(savedText).not.toContain('fixture-key')
    expect(JSON.parse(savedText)).toMatchObject({
      speech: {
        provider: 'openai-compatible',
        model: 'asr-test',
        hasApiKey: true,
      },
    })
    const storedKey = store.getSpeechConnection().apiKeyCiphertext
    expect(storedKey).toBeDefined()
    expect(storedKey).not.toBe('fixture-key')
    if (!storedKey) throw new Error('Speech key was not stored')
    expect(vault.decrypt(storedKey)).toBe('fixture-key')
    store.initializeSpeechConnection({
      provider: 'disabled',
      baseUrl: '',
      model: 'other',
    })
    expect(store.getSpeechSettings().model).toBe('asr-test')
    const stale = await fetch(`${baseUrl}/v1/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...updateBody,
        speech: {
          ...updateBody.speech,
          provider: 'disabled',
          clearApiKey: true,
        },
      }),
    })
    expect(stale.status).toBe(409)
    expect(store.getSpeechSettings()).toMatchObject({
      provider: 'openai-compatible',
      hasApiKey: true,
    })

    const transcript = await fetch(`${baseUrl}/v1/voice/transcriptions`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: Buffer.from('audio'),
    })
    expect(transcript.status).toBe(200)
    expect(await transcript.json()).toMatchObject({
      transcript: { text: '语音设置已生效' },
      model: 'asr-test',
    })
    expect(upstreamAuthorization).toBe('Bearer fixture-key')
  })

  it('tests an unsaved speech connection with sample audio without persisting it', async () => {
    let upstreamAuthorization = ''
    let upstreamModel = ''
    let failWithUnauthorized = false
    const upstream = createServer(async (request, response) => {
      upstreamAuthorization = request.headers.authorization ?? ''
      const chunks: Buffer[] = []
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Buffer))
      upstreamModel = Buffer.concat(chunks)
        .toString('utf8')
        .includes('asr-test')
        ? 'asr-test'
        : ''
      response.setHeader('content-type', 'application/json')
      response.statusCode = failWithUnauthorized ? 401 : 200
      response.end(
        failWithUnauthorized
          ? JSON.stringify({ error: 'private upstream detail' })
          : JSON.stringify({ text: '这是测试转写' }),
      )
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const store = new PegasStore(':memory:')
    const vault = new ModelCredentialVault(Buffer.alloc(32, 7))
    const server = createControlPlane({ store, modelCredentialVault: vault })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => new Promise<void>(resolve => upstream.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const speech = {
      provider: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}/v1`,
      model: 'asr-test',
      apiKey: 'probe-key',
      clearApiKey: false,
    }
    const sample = () => {
      const form = new FormData()
      form.set('speech', JSON.stringify(speech))
      form.set(
        'audio',
        new Blob(['audio-test'], { type: 'audio/webm' }),
        'test.webm',
      )
      return form
    }
    const tested = await fetch(`${baseUrl}/v1/settings/speech/test`, {
      method: 'POST',
      body: sample(),
    })
    expect(tested.status).toBe(200)
    const testedBody = (await tested.json()) as {
      transcript: { text: string }
      latencyMs: number
    }
    expect(testedBody).toMatchObject({
      transcript: { text: '这是测试转写' },
    })
    expect(testedBody.latencyMs).toBeGreaterThanOrEqual(0)
    expect(upstreamAuthorization).toBe('Bearer probe-key')
    expect(upstreamModel).toBe('asr-test')
    expect(store.getSpeechSettings().provider).toBe('disabled')
    expect(store.listEvents('owner')).toHaveLength(0)

    store.initializeSpeechConnection({
      provider: 'openai-compatible',
      baseUrl: 'http://different.example/v1',
      model: 'saved-model',
      apiKeyCiphertext: vault.encrypt('saved-credential'),
    })
    speech.apiKey = ''
    const changedTarget = await fetch(`${baseUrl}/v1/settings/speech/test`, {
      method: 'POST',
      body: sample(),
    })
    expect(changedTarget.status).toBe(200)
    expect(upstreamAuthorization).toBe('')

    failWithUnauthorized = true
    const failed = await fetch(`${baseUrl}/v1/settings/speech/test`, {
      method: 'POST',
      body: sample(),
    })
    expect(failed.status).toBe(502)
    const failedText = await failed.text()
    expect(failedText).toContain('密钥')
    expect(failedText).not.toContain('private upstream detail')
  })
})
