import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import { loadConfig } from '../src/core/config.js'
import type { ClaimedRun, ExecutionContext } from '../src/core/domain.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { PegasStore, RunClaimError } from '../src/storage/sqlite-store.js'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function initializeSettings(store: PegasStore): void {
  store.initializeRuntimeSettings({
    ...runtimeSettingsDefaults(loadConfig({})),
    chatLaneEnabled: true,
  })
}

function conversationContext(): ExecutionContext {
  return {
    executor: 'dsh-headless',
    protocol: 'conversation-v1',
    permissions: JSON.stringify({
      mode: 'read-only',
      approvalPolicy: 'never',
      additionalDirectories: [],
      privacyMode: 'disabled',
    }),
  }
}

function seedConversationRun(store: PegasStore): ClaimedRun {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: '你好' },
  }).event
  const claimedEvent = store.claimNextEvent('setup-router')
  if (!claimedEvent) throw new Error('Expected the setup event claim')
  store.applyRoutingDecision(
    claimedEvent,
    { kind: 'reply', input: '你好', reason: 'casual' },
    'dsh-headless',
    conversationContext(),
  )
  store.completeEvent(event.id, 'setup-router')
  const claimed = store.claimNextRun(
    'chat-worker',
    30_000,
    undefined,
    'conversation',
  )
  if (!claimed) throw new Error('Expected the conversation Run claim')
  return claimed
}

function seedWorkTask(store: PegasStore, title: string): string {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: title },
  }).event
  const claimedEvent = store.claimNextEvent('setup-work')
  if (!claimedEvent) throw new Error('Expected the work event claim')
  const { task } = store.applyRoutingDecision(
    claimedEvent,
    {
      kind: 'create_task',
      title,
      goal: title,
      input: title,
      reason: 'test',
    },
    'dsh-headless',
  )
  store.completeEvent(event.id, 'setup-work')
  return task.id
}

describe('EXEC-005 conversation state read capability', () => {
  it('projects the owner open work tasks and memories for a live conversation claim', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    initializeSettings(store)
    seedWorkTask(store, '调研 LoopForge 项目')
    store.createMemory({
      userId: 'owner',
      commandId: 'memory-1',
      memory: {
        scope: 'global',
        category: 'fact',
        content: '用户偏好中文回复',
        source: { kind: 'user_confirmation' },
      },
    })
    const claimed = seedConversationRun(store)

    const tasks = store.conversationStateForRun(
      claimed.run.id,
      claimed.claimToken,
      'tasks',
    ) as { tasks: { title: string; status: string }[] }
    expect(tasks.tasks).toHaveLength(1)
    expect(tasks.tasks[0]).toMatchObject({
      title: '调研 LoopForge 项目',
      status: 'unstarted',
    })
    expect(JSON.stringify(tasks)).not.toContain('你好')

    const memories = store.conversationStateForRun(
      claimed.run.id,
      claimed.claimToken,
      'memories',
    ) as { memories: { content: string; scope: string }[] }
    expect(memories.memories).toEqual([
      expect.objectContaining({
        scope: 'global',
        content: '用户偏好中文回复',
      }),
    ])
  })

  it('rejects invalid claims and work-run claims', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    initializeSettings(store)
    const workTaskId = seedWorkTask(store, '重活')
    const workClaim = store.claimNextRun('work-worker')
    if (!workClaim) throw new Error('Expected the work Run claim')
    const claimed = seedConversationRun(store)

    expect(() =>
      store.conversationStateForRun(claimed.run.id, 'forged-token', 'tasks'),
    ).toThrow(RunClaimError)
    expect(() =>
      store.conversationStateForRun(
        workClaim.run.id,
        workClaim.claimToken,
        'tasks',
      ),
    ).toThrow('conversation Run claim')
    expect(store.findTask(workTaskId, 'owner')?.kind).toBe('work')
  })

  it('serves the projection over HTTP with the claim header and rejects everything else', async () => {
    const store = new PegasStore(':memory:')
    initializeSettings(store)
    seedWorkTask(store, '整理知识库')
    const claimed = seedConversationRun(store)
    const server = createControlPlane({
      store,
      apiToken: '{{SECRET_8kx2mv0q}}',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => store.close(),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const path = `/v1/runs/${claimed.run.id}/conversation-state/tasks`

    const authorized = await fetch(`${base}${path}`, {
      headers: { 'x-pegas-run-claim-token': claimed.claimToken },
    })
    expect(authorized.status).toBe(200)
    const projection = (await authorized.json()) as {
      tasks: { title: string }[]
    }
    expect(projection.tasks[0]?.title).toBe('整理知识库')

    const noToken = await fetch(`${base}${path}`)
    expect(noToken.status).toBe(403)
    const forged = await fetch(`${base}${path}`, {
      headers: { 'x-pegas-run-claim-token': 'forged' },
    })
    expect(forged.status).toBe(403)
    const wrongResource = await fetch(
      `${base}/v1/runs/${claimed.run.id}/conversation-state/secrets`,
      { headers: { 'x-pegas-run-claim-token': claimed.claimToken } },
    )
    expect(wrongResource.status).toBe(401)
  })
})
