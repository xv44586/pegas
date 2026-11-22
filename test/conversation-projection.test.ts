import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import { loadConfig } from '../src/core/config.js'
import {
  deriveConversationProjection,
  withConversationProjection,
} from '../src/conversation/projection.js'
import type { OutboxMessage } from '../src/core/domain.js'
import { OutboxDispatcher } from '../src/notification/dispatcher.js'
import type { NotificationChannel } from '../src/notification/channel.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function openStore(): PegasStore {
  const store = new PegasStore(':memory:')
  cleanups.push(() => store.close())
  return store
}

function seedTask(
  store: PegasStore,
  options: { conversation?: boolean } = {},
): { eventId: string; taskId: string; runId: string } {
  if (options.conversation) {
    store.initializeRuntimeSettings({
      ...runtimeSettingsDefaults(loadConfig({})),
      chatLaneEnabled: true,
    })
  }
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: '整理季度数据' },
  }).event
  const created = store.applyRoutingDecision(
    event,
    options.conversation
      ? { kind: 'reply', input: '整理季度数据', reason: 'conversation' }
      : {
          kind: 'create_task',
          title: '整理季度数据',
          goal: '整理季度数据',
          input: '整理季度数据',
          reason: 'work',
        },
    'test-executor',
  )
  return {
    eventId: event.id,
    taskId: created.task.id,
    runId: created.run.id,
  }
}

function messageFixture(overrides: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    id: 'message-1',
    userId: 'owner',
    channel: 'conversation',
    dedupeKey: 'fixture-1',
    payload: { type: 'agent.message', text: '你好' },
    status: 'pending',
    attempts: 0,
    createdAt: '2026-11-22T08:00:00.000Z',
    updatedAt: '2026-11-22T08:00:00.000Z',
    ...overrides,
  }
}

describe('CONV-006 deterministic projection derivation', () => {
  it('maps conversation replies and proactive agent messages to say/inline', () => {
    expect(
      deriveConversationProjection(messageFixture(), {
        task: { id: 'task-1', kind: 'conversation', originEventId: 'event-1' },
      }),
    ).toEqual({ lane: 'say', weight: 'inline' })
    expect(
      deriveConversationProjection(
        messageFixture({
          taskId: 'task-1',
          payload: { type: 'run.completed', taskId: 'task-1', text: '答案' },
        }),
        {
          task: {
            id: 'task-1',
            kind: 'conversation',
            originEventId: 'event-1',
          },
        },
      ),
    ).toMatchObject({ lane: 'work', weight: 'card' })
  })

  it.each([
    'run.completed',
    'run.failed',
    'review.ready',
    'action.failed',
    'approval.resolved',
    'collaboration.returned',
  ])('maps %s to work/card with a task anchor', type => {
    const projection = deriveConversationProjection(
      messageFixture({
        taskId: 'task-1',
        payload: { type, taskId: 'task-1', runId: 'run-1' },
      }),
      {
        task: { id: 'task-1', kind: 'work', originEventId: 'event-1' },
        runOriginEventId: 'event-2',
      },
    )
    expect(projection).toEqual({
      lane: 'work',
      weight: 'card',
      anchor: { taskId: 'task-1', eventId: 'event-2' },
    })
  })

  it.each([
    'approval.required',
    'goal.clarification_required',
    'goal.evidence_required',
    'run.waiting',
    'action.outcome_unknown',
    'action.reconciliation_required',
  ])('maps %s to decide/card', type => {
    expect(
      deriveConversationProjection(
        messageFixture({
          taskId: 'task-1',
          payload: { type, taskId: 'task-1' },
        }),
        { task: { id: 'task-1', kind: 'work', originEventId: 'event-1' } },
      ),
    ).toEqual({
      lane: 'decide',
      weight: 'card',
      anchor: { taskId: 'task-1', eventId: 'event-1' },
    })
  })

  it.each(['run.progress', 'run.acknowledged'])(
    'keeps %s silent so it never becomes a chat bubble',
    type => {
      expect(
        deriveConversationProjection(
          messageFixture({
            taskId: 'task-1',
            payload: { type, taskId: 'task-1', runId: 'run-1', text: '执行中' },
          }),
          { task: { id: 'task-1', kind: 'work', originEventId: 'event-1' } },
        ),
      ).toMatchObject({ lane: 'work', weight: 'silent' })
    },
  )

  it('falls back to a compatible default for unknown payloads without an anchor', () => {
    expect(
      deriveConversationProjection(
        messageFixture({ payload: { type: 'future.fact', text: '新事实' } }),
      ),
    ).toEqual({ lane: 'work', weight: 'card' })
    expect(
      deriveConversationProjection(
        messageFixture({ payload: { type: 'future.fact', text: '闲聊' } }),
        { task: { id: 'task-1', kind: 'conversation' } },
      ),
    ).toEqual({ lane: 'say', weight: 'inline' })
    expect(
      deriveConversationProjection(messageFixture({ payload: '纯文本回复' })),
    ).toEqual({ lane: 'say', weight: 'inline' })
  })

  it('never fabricates an anchor when the task is unknown', () => {
    const projection = deriveConversationProjection(
      messageFixture({
        payload: { type: 'run.completed', taskId: 'task-1', text: '完成' },
      }),
    )
    expect(projection.anchor).toEqual({ taskId: 'task-1' })
    expect(projection.anchor?.eventId).toBeUndefined()
  })

  it('is idempotent: replaying the same fact yields the same projection', () => {
    const message = messageFixture({
      taskId: 'task-1',
      payload: { type: 'review.ready', taskId: 'task-1', runId: 'run-1' },
    })
    const context = {
      task: {
        id: 'task-1',
        kind: 'work' as const,
        originEventId: 'event-1',
      },
    }
    const first = withConversationProjection(message, context)
    const second = withConversationProjection(first, context)
    expect(second.projection).toEqual(first.projection)
    expect(first.payload).toEqual(message.payload)
  })
})

describe('CONV-006 store read path projection', () => {
  it('anchors conversation Task terminal facts to their origin event', () => {
    const store = openStore()
    const seeded = seedTask(store, { conversation: true })
    const claimed = store.claimNextRun('worker-1')
    if (!claimed) throw new Error('Expected run claim')
    store.completeRun(claimed.run.id, 'worker-1', {
      executorRef: 'session-1',
      output: '季度数据整理好了。',
    })
    const message = store
      .listOutbox('owner')
      .find(item => item.taskId === seeded.taskId)
    expect(message?.projection).toEqual({
      lane: 'work',
      weight: 'card',
      anchor: { taskId: seeded.taskId, eventId: seeded.eventId },
    })
  })

  it('anchors work facts to the Run origin event and stays replay-stable', () => {
    const store = openStore()
    const seeded = seedTask(store)
    const claimed = store.claimNextRun('worker-1')
    if (!claimed) throw new Error('Expected run claim')
    store.completeRun(claimed.run.id, 'worker-1', {
      executorRef: 'session-1',
      output: '整理完成。',
    })
    const first = store.listOutbox('owner')
    const completion = first.find(
      item =>
        (item.payload as { type?: string }).type === 'run.completed' &&
        item.taskId === seeded.taskId,
    )
    expect(completion?.projection).toEqual({
      lane: 'work',
      weight: 'card',
      anchor: { taskId: seeded.taskId, eventId: seeded.eventId },
    })
    const second = store.listOutbox('owner')
    expect(second.map(item => item.projection)).toEqual(
      first.map(item => item.projection),
    )
    expect(completion?.payload).not.toHaveProperty('projection')
  })

  it('keeps run.progress silent on the read path', () => {
    const store = openStore()
    const seeded = seedTask(store)
    store.enqueueOutbox({
      userId: 'owner',
      taskId: seeded.taskId,
      channel: 'conversation',
      dedupeKey: 'progress-1',
      payload: {
        type: 'run.progress',
        taskId: seeded.taskId,
        runId: seeded.runId,
        text: '执行中',
      },
    })
    const progress = store
      .listOutbox('owner')
      .find(item => item.dedupeKey === 'progress-1')
    expect(progress?.projection).toMatchObject({ weight: 'silent' })
  })

  it('never persists projection attributes into the durable payload', () => {
    const store = openStore()
    const seeded = seedTask(store)
    store.enqueueOutbox({
      userId: 'owner',
      taskId: seeded.taskId,
      channel: 'conversation',
      dedupeKey: 'durable-1',
      payload: { type: 'agent.message', text: '提醒' },
    })
    const listed = store
      .listOutbox('owner')
      .find(item => item.dedupeKey === 'durable-1')
    expect(listed?.projection).toBeDefined()
    expect(listed?.payload).toEqual({ type: 'agent.message', text: '提醒' })
  })

  it('does not attach projection to dispatcher claims or external deliveries', async () => {
    const store = openStore()
    const seeded = seedTask(store)
    store.enqueueOutbox({
      userId: 'owner',
      taskId: seeded.taskId,
      channel: 'conversation',
      dedupeKey: 'external-1',
      payload: { type: 'agent.message', text: '外部提醒' },
    })
    const claimed = store.claimNextOutbox('dispatcher-1')
    expect(claimed?.projection).toBeUndefined()
    store.markOutboxSent(claimed?.id ?? '', 'dispatcher-1')

    store.enqueueOutbox({
      userId: 'owner',
      taskId: seeded.taskId,
      channel: 'push',
      dedupeKey: 'external-2',
      payload: { type: 'agent.message', text: '推送提醒' },
    })
    const delivered: OutboxMessage[] = []
    const channel: NotificationChannel = {
      name: 'capture',
      external: true,
      deliver: message => {
        delivered.push(message)
        return Promise.resolve()
      },
    }
    const dispatcher = new OutboxDispatcher({
      store,
      channel,
      dispatcherId: 'dispatcher-2',
    })
    expect(await dispatcher.dispatchNext()).toBe(true)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.projection).toBeUndefined()
  })

  it('projects read and resolve responses for the owner', () => {
    const store = openStore()
    const message = store.enqueueOutbox({
      userId: 'owner',
      channel: 'conversation',
      dedupeKey: 'read-projection',
      payload: { type: 'agent.message', text: '看一下结果' },
    })
    const read = store.markOutboxRead(message.id, 'owner')
    expect(read.projection).toMatchObject({ lane: 'say', weight: 'inline' })
    expect(read.payload).toEqual({ type: 'agent.message', text: '看一下结果' })
  })
})

describe('CONV-006 projection API', () => {
  async function openServer(store: PegasStore): Promise<string> {
    const server = createControlPlane({ store, apiToken: 'secret' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${String(port)}`
  }

  it('returns projection attributes on GET /v1/outbox', async () => {
    const store = openStore()
    const seeded = seedTask(store)
    store.enqueueOutbox({
      userId: 'owner',
      taskId: seeded.taskId,
      channel: 'conversation',
      dedupeKey: 'api-progress',
      payload: {
        type: 'run.progress',
        taskId: seeded.taskId,
        runId: seeded.runId,
        text: '执行中',
      },
    })
    const base = await openServer(store)
    const response = await fetch(`${base}/v1/outbox?userId=owner`, {
      headers: { authorization: 'Bearer secret' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { messages: OutboxMessage[] }
    const progress = body.messages.find(
      item => item.dedupeKey === 'api-progress',
    )
    expect(progress?.projection).toMatchObject({
      lane: 'work',
      weight: 'silent',
      anchor: { taskId: seeded.taskId },
    })
  })

  it('returns projection attributes on the channel timeline', async () => {
    const store = openStore()
    const seeded = seedTask(store)
    const claimed = store.claimNextRun('worker-1')
    if (!claimed) throw new Error('Expected run claim')
    store.completeRun(claimed.run.id, 'worker-1', {
      executorRef: 'session-1',
      output: '完成。',
    })
    const base = await openServer(store)
    const response = await fetch(
      `${base}/v1/channels/${seeded.taskId}/timeline?userId=owner`,
      { headers: { authorization: 'Bearer secret' } },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { messages: OutboxMessage[] }
    const completion = body.messages.find(
      item => (item.payload as { type?: string }).type === 'run.completed',
    )
    expect(completion?.projection).toEqual({
      lane: 'work',
      weight: 'card',
      anchor: { taskId: seeded.taskId, eventId: seeded.eventId },
    })
  })

  it('ignores client-supplied projection attributes on POST /v1/outbox', async () => {
    const store = openStore()
    const base = await openServer(store)
    const response = await fetch(`${base}/v1/outbox`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        userId: 'owner',
        dedupeKey: 'spoofed-projection',
        payload: { type: 'agent.message', text: '正文' },
        projection: { lane: 'decide', weight: 'silent' },
      }),
    })
    expect(response.status).toBe(202)
    const stored = store
      .listOutbox('owner')
      .find(item => item.dedupeKey === 'spoofed-projection')
    expect(stored?.projection).toMatchObject({ lane: 'say', weight: 'inline' })
    const timeline = await fetch(`${base}/v1/outbox?userId=owner`, {
      headers: { authorization: 'Bearer secret' },
    })
    const body = (await timeline.json()) as { messages: OutboxMessage[] }
    const message = body.messages.find(
      item => item.dedupeKey === 'spoofed-projection',
    )
    expect(message?.projection).toMatchObject({ lane: 'say', weight: 'inline' })
  })
})
