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

  it('projects tasks as user-scoped work channels and keeps the task API compatible', async () => {
    const store = new PegasStore(':memory:')
    const createTask = (userId: string, title: string) => {
      const event = store.enqueueEvent({
        userId,
        source: 'web',
        type: 'user.message',
        payload: { text: title },
      }).event
      return store.applyRoutingDecision(
        event,
        {
          kind: 'create_task',
          title,
          goal: `${title} goal`,
          input: title,
          reason: 'test',
        },
        'test',
      ).task
    }
    const ownerTask = createTask('owner', 'Owner channel')
    createTask('other', 'Other channel')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const { port } = server.address() as AddressInfo
    const base = `http://127.0.0.1:${String(port)}`

    const channelsResponse = await fetch(`${base}/v1/channels?userId=owner`)
    const tasksResponse = await fetch(`${base}/v1/tasks?userId=owner`)

    expect(channelsResponse.status).toBe(200)
    expect(await channelsResponse.json()).toEqual({
      channels: [
        expect.objectContaining({
          id: ownerTask.id,
          taskId: ownerTask.id,
          title: 'Owner channel',
          status: 'unstarted',
          workflow: { state: 'queued' },
          workerIconId: ownerTask.workerIconId,
          latestActivityAt: ownerTask.updatedAt,
        }),
      ],
    })
    expect(await tasksResponse.json()).toEqual({ tasks: [ownerTask] })
    expect((await fetch(`${base}/v1/channels`)).status).toBe(400)
  })

  it('reads and updates owner-scoped execution settings with conflict-safe replay', async () => {
    const store = new PegasStore(':memory:')
    store.initializeRuntimeSettings({
      routerMode: 'rules',
      modelProvider: 'magpie',
      modelName: 'router-model',
      agentModelMode: 'override',
      agentModelProvider: 'discovery-api',
      agentModelName: 'deepseek-v4.1-flash-1017',
      privacyMode: 'disabled',
      rewriteMode: 'disabled',
    })
    const event = store.enqueueEvent({
      userId: 'owner',
      source: 'web',
      type: 'user.message',
      payload: { text: 'Create task' },
    }).event
    const task = store.createTaskFromEvent(event, 'Execution settings')
    let catalogCalls = 0
    let catalogFails = false
    const server = createControlPlane({
      store,
      agentModelCatalogTtlMs: 0,
      agentModelCatalog: () => {
        catalogCalls += 1
        if (catalogFails) return Promise.reject(new Error('private DSH error'))
        return Promise.resolve({
          defaultProvider: 'discovery-api',
          defaultModel: 'deepseek-v4.1-flash-1017',
          models: [
            {
              provider: 'custom-provider',
              id: 'task-model',
              name: 'Task model',
            },
          ],
        })
      },
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const { port } = server.address() as AddressInfo
    const base = `http://127.0.0.1:${String(port)}`
    const resource = `${base}/v1/tasks/${encodeURIComponent(task.id)}/worker-profile`

    const initial = await fetch(`${resource}?userId=owner`)
    expect(initial.status).toBe(200)
    expect(await initial.json()).toMatchObject({
      profile: { revision: 1, modelMode: 'inherit' },
      effective: {
        source: 'global',
        modelRef: 'discovery-api/deepseek-v4.1-flash-1017',
      },
    })
    expect((await fetch(`${resource}?userId=other`)).status).toBe(404)
    expect(
      (await fetch(`${base}/v1/tasks/missing-task/worker-profile?userId=owner`))
        .status,
    ).toBe(404)

    const update = {
      userId: 'owner',
      commandId: 'execution-settings-command-1',
      expectedRevision: 1,
      modelMode: 'override',
      modelProvider: 'custom-provider',
      modelName: 'task-model',
    }
    const updated = await fetch(resource, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      profile: {
        revision: 2,
        modelMode: 'override',
        modelProvider: 'custom-provider',
        modelName: 'task-model',
      },
      effective: { source: 'task', modelRef: 'custom-provider/task-model' },
    })

    const replay = await fetch(resource, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
    })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ profile: { revision: 2 } })

    const otherOwner = await fetch(resource, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...update, userId: 'other' }),
    })
    const missing = await fetch(
      `${base}/v1/tasks/missing-task/worker-profile`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(update),
      },
    )
    expect(otherOwner.status).toBe(404)
    expect(await otherOwner.json()).toEqual({ error: 'not_found' })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not_found' })

    const stale = await fetch(resource, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...update,
        commandId: 'stale-execution-settings-command',
      }),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({
      error: 'worker_profile_conflict',
    })

    const unavailable = await fetch(resource, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...update,
        commandId: 'unavailable-model-command',
        expectedRevision: 2,
        modelName: 'unknown-model',
      }),
    })
    expect(unavailable.status).toBe(422)
    expect(await unavailable.json()).toEqual({
      error: 'worker_model_unavailable',
    })
    expect(store.getWorkerProfile(task.id, 'owner')).toMatchObject({
      revision: 2,
      modelName: 'task-model',
    })

    const providerCaseVariant = await fetch(resource, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...update,
        commandId: 'provider-case-variant-command',
        expectedRevision: 2,
        modelProvider: 'CUSTOM-PROVIDER',
      }),
    })
    expect(providerCaseVariant.status).toBe(422)
    expect(await providerCaseVariant.json()).toEqual({
      error: 'worker_model_unavailable',
    })
    expect(store.getWorkerProfile(task.id, 'owner')).toMatchObject({
      revision: 2,
      modelProvider: 'custom-provider',
    })

    store.stopTask(task.id, 'owner', 'stop-after-profile-update')
    catalogFails = true
    const callsBeforeReplay = catalogCalls
    const replayAfterStop = await fetch(resource, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
    })
    expect(replayAfterStop.status).toBe(200)
    expect(catalogCalls).toBe(callsBeforeReplay)

    const changedAfterStop = await fetch(resource, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...update,
        commandId: 'changed-after-stop',
        expectedRevision: 2,
        modelName: 'task-model-2',
      }),
    })
    expect(changedAfterStop.status).toBe(409)
    expect(await changedAfterStop.json()).toEqual({
      error: 'worker_profile_read_only',
    })
    expect(catalogCalls).toBe(callsBeforeReplay)
  })

  it('fails closed when the isolated Agent model catalog is unavailable', async () => {
    const store = new PegasStore(':memory:')
    store.initializeRuntimeSettings({
      routerMode: 'rules',
      modelProvider: 'magpie',
      modelName: 'router-model',
      agentModelMode: 'profile',
      agentModelProvider: '',
      agentModelName: '',
      privacyMode: 'disabled',
      rewriteMode: 'disabled',
    })
    const task = store.createTaskFromEvent(
      store.enqueueEvent({
        userId: 'owner',
        source: 'web',
        type: 'user.message',
        payload: { text: 'Create task' },
      }).event,
      'Execution settings',
    )
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const response = await fetch(
      `${base}/v1/tasks/${encodeURIComponent(task.id)}/worker-profile`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'owner',
          commandId: 'catalog-unavailable',
          expectedRevision: 1,
          modelMode: 'override',
          modelProvider: 'provider',
          modelName: 'model',
        }),
      },
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'agent_models_unavailable',
    })
    expect(store.getWorkerProfile(task.id, 'owner').revision).toBe(1)

    const throwingServer = createControlPlane({
      store,
      agentModelCatalog: () =>
        Promise.reject(new Error('private catalog diagnostic')),
    })
    await new Promise<void>(resolve =>
      throwingServer.listen(0, '127.0.0.1', resolve),
    )
    cleanups.push(
      () => new Promise<void>(resolve => throwingServer.close(() => resolve())),
    )
    const throwingBase = `http://127.0.0.1:${String((throwingServer.address() as AddressInfo).port)}`
    const throwingResponse = await fetch(
      `${throwingBase}/v1/tasks/${encodeURIComponent(task.id)}/worker-profile`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'owner',
          commandId: 'catalog-throws',
          expectedRevision: 1,
          modelMode: 'override',
          modelProvider: 'provider',
          modelName: 'model',
        }),
      },
    )
    expect(throwingResponse.status).toBe(503)
    expect(await throwingResponse.json()).toEqual({
      error: 'agent_models_unavailable',
    })
    expect(store.getWorkerProfile(task.id, 'owner').revision).toBe(1)
  })

  it('returns a server-authoritative timeline isolated to one owned channel', async () => {
    const store = new PegasStore(':memory:')
    const createTask = (userId: string, title: string) => {
      const event = store.enqueueEvent({
        userId,
        source: 'web',
        type: 'user.message',
        payload: { text: `${title} origin` },
      }).event
      return store.applyRoutingDecision(
        event,
        {
          kind: 'create_task',
          title,
          goal: `${title} goal`,
          input: `${title} origin`,
          reason: 'test',
        },
        'test',
      ).task
    }
    const first = createTask('owner', 'First channel')
    const second = createTask('owner', 'Second channel')
    const other = createTask('other', 'Other user channel')

    const continuation = store.enqueueEvent({
      userId: 'owner',
      source: 'web',
      type: 'user.message',
      payload: { text: 'First follow-up', taskId: first.id },
    }).event
    store.applyRoutingDecision(
      continuation,
      {
        kind: 'continue_task',
        taskId: first.id,
        input: 'First follow-up',
        reason: 'explicit channel',
      },
      'test',
    )
    const pending = store.enqueueEvent({
      userId: 'owner',
      source: 'web',
      type: 'user.message',
      payload: { text: 'First pending', taskId: first.id },
    }).event
    store.enqueueOutbox({
      userId: 'owner',
      taskId: first.id,
      channel: 'conversation',
      dedupeKey: 'first-result',
      payload: { type: 'run.completed', text: 'First result' },
    })
    store.enqueueOutbox({
      userId: 'owner',
      taskId: second.id,
      channel: 'conversation',
      dedupeKey: 'second-result',
      payload: { type: 'run.completed', text: 'Second result' },
    })

    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

    const response = await fetch(
      `${base}/v1/channels/${first.id}/timeline?userId=owner`,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      channel: { id: string }
      events: { id: string }[]
      runs: { taskId: string }[]
      messages: { taskId?: string }[]
    }
    expect(body.channel.id).toBe(first.id)
    expect(body.events.map(event => event.id)).toEqual([
      first.originEventId,
      continuation.id,
      pending.id,
    ])
    expect(body.runs).not.toHaveLength(0)
    expect(body.runs.every(run => run.taskId === first.id)).toBe(true)
    expect(body.messages).toEqual([
      expect.objectContaining({ taskId: first.id }),
    ])
    expect(JSON.stringify(body)).not.toContain('Second result')
    expect(JSON.stringify(body)).not.toContain('Other user channel')

    expect(
      (await fetch(`${base}/v1/channels/${first.id}/timeline?userId=other`))
        .status,
    ).toBe(404)

    const ownerRunsResponse = await fetch(`${base}/v1/runs?userId=owner`)
    expect(ownerRunsResponse.status).toBe(200)
    const ownerRuns = (await ownerRunsResponse.json()) as {
      runs: { taskId: string }[]
    }
    expect(new Set(ownerRuns.runs.map(run => run.taskId))).toEqual(
      new Set([first.id, second.id]),
    )
    expect(ownerRuns.runs.some(run => run.taskId === other.id)).toBe(false)
    expect((await fetch(`${base}/v1/runs`)).status).toBe(400)
    expect(
      await (
        await fetch(
          `${base}/v1/runs?userId=owner&taskId=${encodeURIComponent(other.id)}`,
        )
      ).json(),
    ).toEqual({ runs: [] })
  })

  it('stops a live channel idempotently and exposes permanent lifecycle capabilities', async () => {
    const store = new PegasStore(':memory:')
    const event = store.enqueueEvent({
      userId: 'owner',
      source: 'web',
      type: 'user.message',
      payload: { text: 'Long task' },
    }).event
    const task = store.applyRoutingDecision(
      event,
      {
        kind: 'create_task',
        title: 'Long task',
        goal: 'Long task',
        input: 'Long task',
        reason: 'test',
      },
      'test',
    ).task
    const server = createControlPlane({ store, apiToken: 'secret' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const stop = () =>
      fetch(`${base}/v1/channels/${task.id}/stop`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          userId: 'owner',
          commandId: 'stop-one',
          reason: 'No longer needed',
        }),
      })
    const first = await stop()
    const second = await stop()
    expect(first.status).toBe(200)
    expect(await second.json()).toEqual(await first.json())
    const channels = await fetch(`${base}/v1/channels?userId=owner`, {
      headers: { authorization: 'Bearer secret' },
    })
    expect(await channels.json()).toMatchObject({
      channels: [
        {
          id: task.id,
          status: 'cancelled',
          canResume: false,
          canStop: false,
          endedKind: 'stopped',
          ended: { by: 'human', outcome: 'stopped' },
        },
      ],
    })

    const rejected = await fetch(`${base}/v1/events`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        payload: { text: 'Continue anyway', taskId: task.id },
      }),
    })
    expect(rejected.status).toBe(400)
    expect(await rejected.text()).toMatch(/stopped/i)
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
    const withoutModel = await fetch(`${baseUrl}/v1/settings/models/discover`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...JSON.parse(body), modelName: undefined }),
    })
    expect(withoutModel.status).toBe(200)
    expect(await withoutModel.json()).toEqual({
      models: [{ id: 'router-model', name: 'router-model' }],
    })
    expect(store.listModelProviderConnectionSummaries()).toEqual([])
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

  it('discovers edited preset URLs without leaking saved keys or upstream errors', async () => {
    const authorizations: (string | undefined)[] = []
    let status = 200
    const upstream = createServer((request, response) => {
      authorizations.push(request.headers.authorization)
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(
        status === 200
          ? JSON.stringify({ data: [{ id: 'discovered-model' }] })
          : 'private-upstream-detail fixture-secret',
      )
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamUrl = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}/v1`
    const store = new PegasStore(':memory:')
    const vault = new ModelCredentialVault(Buffer.alloc(32, 9))
    store.initializeRuntimeSettings({
      routerMode: 'model',
      modelProvider: 'magpie',
      modelName: 'old-model',
      agentModelMode: 'profile',
      agentModelProvider: '',
      agentModelName: '',
      privacyMode: 'disabled',
      rewriteMode: 'disabled',
    })
    store.updateRuntimeSettingsAndProvider(1, store.getRuntimeSettings(), {
      id: 'magpie',
      name: 'Magpie',
      protocol: 'openai-chat',
      baseUrl: 'https://old.example/v1',
      apiKeyCiphertext: vault.encrypt('saved-fixture-key'),
      clearApiKey: false,
    })
    const server = createControlPlane({
      store,
      apiToken: 'fixture-token',
      modelCredentialVault: vault,
      settingsCapabilities: () =>
        settingsCapabilities(
          loadConfig({}),
          store.listModelProviderConnectionSummaries(),
        ),
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => new Promise<void>(resolve => upstream.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/settings/models/discover`
    const body = { modelProvider: 'magpie', provider: { baseUrl: upstreamUrl } }
    const denied = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(denied.status).toBe(401)
    expect(authorizations).toEqual([])
    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer fixture-token',
    }
    const discovered = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    expect(discovered.status).toBe(200)
    expect(await discovered.json()).toEqual({
      models: [{ id: 'discovered-model', name: 'discovered-model' }],
    })
    expect(authorizations).toEqual([undefined])
    status = 401
    const failed = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...body,
        provider: { ...body.provider, apiKey: 'new-fixture-key' },
      }),
    })
    expect(await failed.json()).toEqual({
      error: 'model_connection_failed',
      message: '密钥无效或没有模型权限，请检查 API Key。',
    })
    expect(authorizations).toEqual([undefined, 'Bearer new-fixture-key'])
    expect(store.getRuntimeSettings().revision).toBe(2)
    expect(store.getModelProviderConnection('magpie')?.baseUrl).toBe(
      'https://old.example/v1',
    )
  })

  it('shares an in-flight Agent model catalog load and retries failures', async () => {
    const store = new PegasStore(':memory:')
    let calls = 0
    let resolveFirst:
      | ((catalog: {
          defaultProvider: string
          defaultModel: string
          models: { provider: string; id: string; name: string }[]
        }) => void)
      | undefined
    const first = new Promise<{
      defaultProvider: string
      defaultModel: string
      models: { provider: string; id: string; name: string }[]
    }>(resolve => {
      resolveFirst = resolve
    })
    let failNext = false
    const catalog = {
      defaultProvider: 'isolated',
      defaultModel: 'model',
      models: [{ provider: 'isolated', id: 'model', name: 'Model' }],
    }
    const server = createControlPlane({
      store,
      agentModelCatalogTtlMs: 0,
      agentModelCatalog: () => {
        calls += 1
        if (calls === 1) return first
        if (failNext) {
          failNext = false
          return Promise.reject(new Error('temporary catalog failure'))
        }
        return Promise.resolve(catalog)
      },
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/settings/agent-models`
    const pending = [fetch(url), fetch(url)]
    await vi.waitFor(() => expect(calls).toBe(1))
    resolveFirst?.(catalog)
    const concurrent = await Promise.all(pending)
    expect(concurrent.map(response => response.status)).toEqual([200, 200])
    expect(calls).toBe(1)

    failNext = true
    expect((await fetch(url)).status).toBe(503)
    expect((await fetch(url)).status).toBe(200)
    expect(calls).toBe(3)
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

  it('marks an owned Outbox item read without changing delivery state', async () => {
    const store = new PegasStore(':memory:')
    const message = store.enqueueOutbox({
      userId: 'owner',
      channel: 'conversation',
      dedupeKey: 'read-me',
      payload: { type: 'agent.message', text: 'Review this result.' },
    })
    const server = createControlPlane({ store, apiToken: 'secret' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const markRead = (userId: string) =>
      fetch(`${base}/v1/outbox/${message.id}/read`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId }),
      })

    const response = await markRead('owner')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      message: { id: string; status: string; readAt?: string }
    }
    expect(body.message).toMatchObject({
      id: message.id,
      status: 'pending',
    })
    expect(typeof body.message.readAt).toBe('string')
    expect((await markRead('other')).status).toBe(400)
  })

  it('returns model usage only for the requested owner and Channel', async () => {
    const store = new PegasStore(':memory:')
    const createCompletedRun = (
      userId: string,
      eventId: string,
      workerId: string,
    ) => {
      const event = store.enqueueEvent({
        id: eventId,
        userId,
        source: 'web',
        type: 'user.message',
        payload: { text: 'Measure this work' },
      }).event
      const created = store.applyRoutingDecision(
        event,
        {
          kind: 'create_task',
          title: 'Measured work',
          goal: 'Measure this work',
          input: 'Measure this work',
          reason: 'usage API test',
        },
        'dsh-headless',
        {
          executor: 'dsh-headless',
          model: `magpie/${userId}`,
          workspace: `/workspace/${userId}`,
        },
      )
      expect(store.claimNextRun(workerId)?.run.id).toBe(created.run.id)
      store.completeRun(created.run.id, workerId, {
        executorRef: `session-${userId}`,
        output: 'Done',
        durationMs: 800,
        usage: {
          source: 'provider_reported',
          reportedSteps: 1,
          unreportedSteps: 0,
          tokens: { inputTokens: 30, outputTokens: 7 },
        },
      })
      return created
    }
    const owner = createCompletedRun('owner', 'usage-api-owner', 'worker-owner')
    const other = createCompletedRun('other', 'usage-api-other', 'worker-other')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${String(port)}`

    const owned = await fetch(
      `${baseUrl}/v1/usage?userId=owner&taskId=${encodeURIComponent(owner.task.id)}`,
    )
    expect(owned.status).toBe(200)
    expect(await owned.json()).toMatchObject({
      summary: { records: 1, completeRecords: 1 },
      records: [
        {
          runId: owner.run.id,
          userId: 'owner',
          inputTokens: 30,
          outputTokens: 7,
          durationMs: 800,
        },
      ],
    })

    const crossOwner = await fetch(
      `${baseUrl}/v1/usage?userId=owner&taskId=${encodeURIComponent(other.task.id)}`,
    )
    expect(await crossOwner.json()).toMatchObject({
      summary: { records: 0 },
      records: [],
    })
    const missingOwner = await fetch(`${baseUrl}/v1/usage`)
    expect(missingOwner.status).toBe(400)
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
