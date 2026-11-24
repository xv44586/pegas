import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import { loadConfig } from '../src/core/config.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('routing preview (dry-run)', () => {
  it('previews deterministic routing without any persisted side effects', async () => {
    const store = new PegasStore(':memory:')
    store.initializeRuntimeSettings({
      ...runtimeSettingsDefaults(loadConfig({})),
      routerMode: 'rules',
    })
    const seeded = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '帮我调研 NAS' },
    }).event
    const { task } = store.applyRoutingDecision(
      seeded,
      {
        kind: 'create_task',
        title: '调研 NAS',
        goal: '调研 NAS',
        input: '帮我调研 NAS',
        reason: 'seed',
      },
      'echo',
    )
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => store.close(),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const before = {
      tasks: store.listTasks('owner').length,
      events: store.listEvents('owner').length,
      outbox: store.listOutbox('owner').length,
    }
    const response = await fetch(`${base}/v1/routing/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'owner', text: '再补充一点预算信息' }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      preview: {
        kind: string
        reason: string
        routerMode: string
        dryRun: boolean
      }
    }
    expect(body.preview).toMatchObject({
      kind: 'create_task',
      routerMode: 'rules',
      dryRun: true,
    })
    expect(body.preview.reason).toBeTruthy()

    const explicit = await fetch(`${base}/v1/routing/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        text: `继续 ${task.id}`,
        taskId: task.id,
      }),
    })
    expect(explicit.status).toBe(200)

    expect(store.listTasks('owner')).toHaveLength(before.tasks)
    expect(store.listEvents('owner')).toHaveLength(before.events)
    expect(store.listOutbox('owner')).toHaveLength(before.outbox)
    expect(store.listChannelRoutingDecisions(task.id, 'owner')).toHaveLength(1)

    const invalid = await fetch(`${base}/v1/routing/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'owner', text: ' ' }),
    })
    expect(invalid.status).toBe(400)
    const tooLong = await fetch(`${base}/v1/routing/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'owner', text: '长'.repeat(4001) }),
    })
    expect(tooLong.status).toBe(400)
  })

  it('requires the instance bearer and reports model failures honestly', async () => {
    const store = new PegasStore(':memory:')
    store.initializeRuntimeSettings(runtimeSettingsDefaults(loadConfig({})))
    const server = createControlPlane({
      store,
      apiToken: '{{SECRET_p4w8n2q6}}',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => store.close(),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const anonymous = await fetch(`${base}/v1/routing/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'owner', text: '测试' }),
    })
    expect(anonymous.status).toBe(401)
    const authorized = await fetch(`${base}/v1/routing/preview`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer {{SECRET_p4w8n2q6}}',
      },
      body: JSON.stringify({ userId: 'owner', text: '测试' }),
    })
    expect(authorized.status).toBe(502)
    expect(await authorized.json()).toMatchObject({
      error: 'routing_preview_failed',
    })
    expect(store.listTasks('owner')).toEqual([])
    expect(store.listEvents('owner')).toEqual([])
  })
})
