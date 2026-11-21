import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type { Clock } from '../src/core/clock.js'
import type { OutboxMessage } from '../src/core/domain.js'
import {
  DeliveryOutcomeUnknownError,
  type NotificationChannel,
} from '../src/notification/channel.js'
import { OutboxDispatcher } from '../src/notification/dispatcher.js'
import { WebhookNotificationChannel } from '../src/notification/webhook-channel.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import {
  NotificationPreferencesConflictError,
  OutboxNotFoundError,
  OutboxResolutionConflictError,
  PegasStore,
} from '../src/storage/sqlite-store.js'
import {
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

class MutableClock implements Clock {
  #value: Date

  constructor(value: string) {
    this.#value = new Date(value)
  }

  now(): Date {
    return new Date(this.#value)
  }

  set(value: string): void {
    this.#value = new Date(value)
  }
}

function seededStore(now = '2026-11-21T02:00:00.000Z'): {
  store: PegasStore
  clock: MutableClock
} {
  const clock = new MutableClock(now)
  const store = new PegasStore(':memory:', { clock })
  cleanups.push(() => store.close())
  return { store, clock }
}

describe('NOTIFY-005 quiet hours', () => {
  it('defers pending delivery until the quiet window ends in user local time', () => {
    // 02:00Z is 10:00 in UTC+8, outside the 22:00-08:00 quiet window.
    const { store, clock } = seededStore()
    store.updateNotificationPreferences('user-1', {
      expectedRevision: 0,
      quietStart: '22:00',
      quietEnd: '08:00',
      utcOffsetMinutes: 480,
    })
    const message = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'quiet-1',
      payload: { type: 'agent.message', text: '晚上不打扰' },
    })
    expect(store.claimNextOutbox('dispatcher-1')?.id).toBe(message.id)
    store.markOutboxSent(message.id, 'dispatcher-1')

    // 15:00Z is 23:00 local: inside the window, delivery is deferred.
    clock.set('2026-11-21T15:00:00.000Z')
    const night = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'quiet-2',
      payload: { type: 'agent.message', text: '明早再看' },
    })
    expect(store.claimNextOutbox('dispatcher-1')).toBeUndefined()
    const deferred = store.listOutbox('user-1').find(m => m.id === night.id)
    expect(deferred).toMatchObject({
      status: 'pending',
      // Local 08:00 on the next day is 00:00Z.
      nextAttemptAt: '2026-11-22T00:00:00.000Z',
    })
    // Other users are unaffected by user-1's quiet hours.
    const other = store.enqueueOutbox({
      userId: 'user-2',
      channel: 'conversation',
      dedupeKey: 'quiet-3',
      payload: { type: 'agent.message', text: '照常送达' },
    })
    expect(store.claimNextOutbox('dispatcher-1')?.id).toBe(other.id)
    store.markOutboxSent(other.id, 'dispatcher-1')

    clock.set('2026-11-22T00:00:00.000Z')
    expect(store.claimNextOutbox('dispatcher-1')?.id).toBe(night.id)
  })

  it('handles same-day windows, offsets and revision conflicts', () => {
    const { store, clock } = seededStore('2026-11-21T02:00:00.000Z')
    const initial = store.getNotificationPreferences('user-1')
    expect(initial).toMatchObject({ revision: 0, utcOffsetMinutes: 0 })
    expect(initial.quietStart).toBeUndefined()

    // 02:00Z with UTC-120 is 00:00 local, inside 00:00-06:00.
    const updated = store.updateNotificationPreferences('user-1', {
      expectedRevision: 0,
      quietStart: '00:00',
      quietEnd: '06:00',
      utcOffsetMinutes: -120,
    })
    expect(updated).toMatchObject({ revision: 1, quietStart: '00:00' })
    store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'quiet-offset',
      payload: { type: 'agent.message', text: '深夜' },
    })
    expect(store.claimNextOutbox('dispatcher-1')).toBeUndefined()
    // Local 06:00 with UTC-120 is 08:00Z the same day.
    expect(store.listOutbox('user-1')[0]?.nextAttemptAt).toBe(
      '2026-11-21T08:00:00.000Z',
    )

    expect(() =>
      store.updateNotificationPreferences('user-1', {
        expectedRevision: 0,
        utcOffsetMinutes: 0,
      }),
    ).toThrow(NotificationPreferencesConflictError)
    expect(() =>
      store.updateNotificationPreferences('user-1', {
        expectedRevision: 1,
        quietStart: '25:00',
        quietEnd: '08:00',
        utcOffsetMinutes: 0,
      }),
    ).toThrow(/valid time of day/)
    expect(() =>
      store.updateNotificationPreferences('user-1', {
        expectedRevision: 1,
        quietStart: '22:00',
        utcOffsetMinutes: 0,
      }),
    ).toThrow(/together/)
    expect(() =>
      store.updateNotificationPreferences('user-1', {
        expectedRevision: 1,
        utcOffsetMinutes: 900,
      }),
    ).toThrow(/between -840 and 840/)

    // Clearing the window restores immediate delivery.
    store.updateNotificationPreferences('user-1', {
      expectedRevision: 1,
      utcOffsetMinutes: 0,
    })
    clock.set('2026-11-21T08:00:00.000Z')
    expect(store.claimNextOutbox('dispatcher-1')).toBeDefined()
  })
})

describe('NOTIFY-005 coalescing', () => {
  it('merges pending same-key updates into the newest payload with a count', () => {
    const { store } = seededStore()
    const first = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'progress-1',
      coalesceKey: 'run-progress:run-1',
      payload: { type: 'run.progress', text: '第一步完成' },
    })
    const second = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'progress-2',
      coalesceKey: 'run-progress:run-1',
      payload: { type: 'run.progress', text: '第二步完成' },
    })
    expect(second.id).toBe(first.id)
    expect(second.payload).toEqual({
      type: 'run.progress',
      text: '第二步完成',
    })
    expect(second.coalescedCount).toBe(1)
    const third = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'progress-3',
      coalesceKey: 'run-progress:run-1',
      payload: { type: 'run.progress', text: '第三步完成' },
    })
    expect(third.coalescedCount).toBe(2)

    const messages = store.listOutbox('user-1')
    expect(messages).toHaveLength(3)
    const merged = messages.filter(m => m.status === 'merged')
    expect(merged.map(m => m.mergedIntoId)).toEqual([first.id, first.id])
    expect(messages.find(m => m.id === first.id)).toMatchObject({
      status: 'pending',
      dedupeKey: 'progress-1',
    })
    // Merged rows are never claimed for delivery.
    expect(store.claimNextOutbox('dispatcher-1')?.id).toBe(first.id)
    expect(store.claimNextOutbox('dispatcher-1')).toBeUndefined()
  })

  it('never merges into sending or sent messages, other users or channels', () => {
    const { store } = seededStore()
    const sending = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'sending-1',
      coalesceKey: 'progress',
      payload: { text: 'in flight' },
    })
    store.claimNextOutbox('dispatcher-1')
    const afterSending = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'sending-2',
      coalesceKey: 'progress',
      payload: { text: 'newer' },
    })
    expect(afterSending.id).not.toBe(sending.id)
    expect(afterSending.status).toBe('pending')
    store.markOutboxSent(sending.id, 'dispatcher-1')

    const afterSent = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'sending-3',
      coalesceKey: 'progress',
      payload: { text: 'even newer' },
    })
    // sending-2 is still pending and absorbs this one.
    expect(afterSent.id).toBe(afterSending.id)

    const otherUser = store.enqueueOutbox({
      userId: 'user-2',
      channel: 'conversation',
      dedupeKey: 'other-user',
      coalesceKey: 'progress',
      payload: { text: 'other user' },
    })
    const otherChannel = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'attention',
      dedupeKey: 'other-channel',
      coalesceKey: 'progress',
      payload: { text: 'other channel' },
    })
    expect(otherUser.id).not.toBe(afterSending.id)
    expect(otherChannel.id).not.toBe(afterSending.id)
    expect(otherChannel.coalescedCount).toBeUndefined()
  })

  it('keeps dedupe replay idempotent even with a coalesce key', () => {
    const { store } = seededStore()
    const first = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'replay-1',
      coalesceKey: 'progress',
      payload: { text: 'a' },
    })
    store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'replay-2',
      coalesceKey: 'progress',
      payload: { text: 'b' },
    })
    const replay = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'replay-2',
      coalesceKey: 'progress',
      payload: { text: 'b' },
    })
    expect(replay.status).toBe('merged')
    const survivor = store.listOutbox('user-1').find(m => m.id === first.id)
    expect(survivor?.coalescedCount).toBe(1)
  })
})

describe('NOTIFY-005 unknown delivery outcomes', () => {
  it('parks an unknown outcome without retrying and requires resolution', async () => {
    const { store } = seededStore()
    const message = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'unknown-1',
      payload: { type: 'agent.message', text: '可能已送达' },
    })
    const channel: NotificationChannel = {
      name: 'flaky',
      deliver: () =>
        Promise.reject(
          new DeliveryOutcomeUnknownError('Webhook outcome unknown: timeout'),
        ),
    }
    const dispatcher = new OutboxDispatcher({
      store,
      channel,
      dispatcherId: 'dispatcher-1',
    })
    await expect(dispatcher.dispatchNext()).resolves.toBe(true)
    expect(store.listOutbox('user-1')[0]).toMatchObject({
      id: message.id,
      status: 'unknown',
      lastError: 'Webhook outcome unknown: timeout',
    })
    // Unknown outcomes never re-enter the retry queue, even after leases.
    expect(store.claimNextOutbox('dispatcher-2')).toBeUndefined()

    expect(() =>
      store.resolveOutboxMessage(message.id, 'intruder', {
        commandId: 'resolve-x',
        resolution: 'sent',
        note: 'x',
      }),
    ).toThrow(OutboxNotFoundError)

    const resolved = store.resolveOutboxMessage(message.id, 'user-1', {
      commandId: 'resolve-1',
      resolution: 'sent',
      note: '已在接收端日志确认送达',
    })
    expect(resolved).toMatchObject({ status: 'sent' })
    expect(resolved.sentAt).toBeDefined()
    expect(resolved.resolution).toMatchObject({
      resolution: 'sent',
      previousStatus: 'unknown',
      resolvedBy: 'user-1',
      note: '已在接收端日志确认送达',
    })

    const replay = store.resolveOutboxMessage(message.id, 'user-1', {
      commandId: 'resolve-1',
      resolution: 'sent',
      note: '已在接收端日志确认送达',
    })
    expect(replay).toEqual(resolved)
    expect(() =>
      store.resolveOutboxMessage(message.id, 'user-1', {
        commandId: 'resolve-1',
        resolution: 'failed',
        note: '改口',
      }),
    ).toThrow(OutboxResolutionConflictError)
    expect(() =>
      store.resolveOutboxMessage(message.id, 'user-1', {
        commandId: 'resolve-2',
        resolution: 'failed',
        note: '第二次核对',
      }),
    ).toThrow(OutboxResolutionConflictError)
  })

  it('resolves an exhausted failed message and rejects resolving live ones', () => {
    const { store } = seededStore()
    const pending = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'failed-pending',
      payload: { text: 'still pending' },
    })
    expect(() =>
      store.resolveOutboxMessage(pending.id, 'user-1', {
        commandId: 'resolve-pending',
        resolution: 'failed',
        note: 'not allowed',
      }),
    ).toThrow(OutboxResolutionConflictError)

    const claimed = store.claimNextOutbox('dispatcher-1')
    if (!claimed) throw new Error('Expected claim')
    store.failOutbox(
      claimed.id,
      'dispatcher-1',
      'Webhook returned 503',
      new Date('2026-11-21T03:00:00.000Z'),
      1,
    )
    expect(store.listOutbox('user-1')[0]?.status).toBe('failed')
    const resolved = store.resolveOutboxMessage(claimed.id, 'user-1', {
      commandId: 'resolve-failed',
      resolution: 'failed',
      note: '接收端确认从未收到',
    })
    expect(resolved).toMatchObject({ status: 'failed' })
    expect(resolved.sentAt).toBeUndefined()
    expect(resolved.resolution).toMatchObject({
      resolution: 'failed',
      previousStatus: 'failed',
    })
    // A failed resolution does not resurrect the message for delivery.
    expect(store.claimNextOutbox('dispatcher-1')).toBeUndefined()
  })

  it('classifies webhook transport failures as unknown and HTTP errors as retryable', async () => {
    const { store } = seededStore()
    const refused = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'transport-1',
      payload: { text: 'connection refused' },
    })
    const refusedDispatcher = new OutboxDispatcher({
      store,
      dispatcherId: 'dispatcher-1',
      channel: new WebhookNotificationChannel({
        url: 'http://127.0.0.1:1/push',
        timeoutMs: 2000,
      }),
    })
    await refusedDispatcher.dispatchNext()
    expect(store.listOutbox('user-1')[0]).toMatchObject({
      id: refused.id,
      status: 'unknown',
    })

    const httpServer = createServer((_request, response) => {
      response.writeHead(503).end('not ready')
    })
    await new Promise<void>(resolve =>
      httpServer.listen(0, '127.0.0.1', resolve),
    )
    cleanups.push(
      () => new Promise<void>(resolve => httpServer.close(() => resolve())),
    )
    const port = (httpServer.address() as AddressInfo).port
    const retryable = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'transport-2',
      payload: { text: 'definite 503' },
    })
    const httpDispatcher = new OutboxDispatcher({
      store,
      dispatcherId: 'dispatcher-1',
      retryBaseMs: 60_000,
      channel: new WebhookNotificationChannel({
        url: `http://127.0.0.1:${String(port)}/push`,
      }),
    })
    await httpDispatcher.dispatchNext()
    const retried = store.listOutbox('user-1').find(m => m.id === retryable.id)
    expect(retried).toMatchObject({
      status: 'pending',
      lastError: 'Webhook returned 503: not ready',
    })
  })

  it('keeps resolution records immutable at the storage layer', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-outbox-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'pegas.db')
    const store = new PegasStore(path)
    const message = store.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'immutable-1',
      payload: { text: 'unknown' },
    })
    store.claimNextOutbox('dispatcher-1')
    store.markOutboxUnknown(message.id, 'dispatcher-1', 'timeout')
    store.resolveOutboxMessage(message.id, 'user-1', {
      commandId: 'resolve-immutable',
      resolution: 'sent',
      note: '确认送达',
    })
    store.close()

    const database = new DatabaseSync(path)
    cleanups.push(() => database.close())
    expect(() =>
      database.prepare("UPDATE outbox_resolutions SET note = 'tampered'").run(),
    ).toThrow(/immutable/)
    expect(() =>
      database.prepare('DELETE FROM outbox_resolutions').run(),
    ).toThrow(/immutable/)
    expect(() =>
      database
        .prepare('UPDATE outbox_messages SET status = ? WHERE id = ?')
        .run('failed', message.id),
    ).toThrow(/resolution record/)
    expect(() =>
      database
        .prepare('UPDATE outbox_messages SET status = ? WHERE id = ?')
        .run('pending', message.id),
    ).toThrow(/resolution record/)
  })

  it('coalesces inside an outer store transaction without nested BEGIN', async () => {
    const { store } = seededStore()
    store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '推进任务' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
      'worker-1',
    )
    const claimed = store.claimNextRun('worker-1')
    if (!claimed) throw new Error('Expected run claim')
    // failRun enqueues Outbox rows inside its own transaction; the new
    // enqueue path must join it via savepoint instead of failing.
    store.failRun(claimed.run.id, 'worker-1', 'executor crashed')
    const messages = store.listOutbox('user-1')
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.some(m => m.status === 'pending')).toBe(true)
  })
})

describe('NOTIFY-005 HTTP surface', () => {
  it('upgrades a v29 database in place and keeps existing outbox rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-outbox-v29-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'pegas.db')
    const clock = new MutableClock('2026-11-20T10:00:00.000Z')
    const first = new PegasStore(path, { clock })
    const legacy = first.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'legacy-sent',
      payload: { type: 'agent.message', text: '历史消息' },
    })
    first.claimNextOutbox('dispatcher-1')
    first.markOutboxSent(legacy.id, 'dispatcher-1')
    const legacyPending = first.enqueueOutbox({
      userId: 'user-1',
      channel: 'conversation',
      dedupeKey: 'legacy-pending',
      payload: { type: 'agent.message', text: '待发送' },
    })
    first.close()

    // Reopening exercises the idempotent migration path on a live database.
    const upgraded = new PegasStore(path, { clock })
    cleanups.push(() => upgraded.close())
    const messages = upgraded.listOutbox('user-1')
    expect(messages.find(m => m.id === legacy.id)).toMatchObject({
      status: 'sent',
      payload: { type: 'agent.message', text: '历史消息' },
    })
    expect(messages.find(m => m.id === legacyPending.id)).toMatchObject({
      status: 'pending',
    })
    expect(upgraded.claimNextOutbox('dispatcher-2')?.id).toBe(legacyPending.id)
    // The rebuilt table keeps the channel search trigger alive.
    const db = new DatabaseSync(path)
    cleanups.push(() => db.close())
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'channel_search_outbox_after_insert'",
        )
        .get(),
    ).toEqual({ name: 'channel_search_outbox_after_insert' })
  })

  it('serves notification preferences with optimistic revisions', async () => {
    const { store } = seededStore()
    const server = createControlPlane({
      store,
      apiToken: '{{SECRET_x9wk2p7q}}',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

    const read = await fetch(
      `${base}/v1/settings/notifications?userId=user-1`,
      {
        headers: { authorization: 'Bearer {{SECRET_x9wk2p7q}}' },
      },
    )
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({
      preferences: { userId: 'user-1', revision: 0, utcOffsetMinutes: 0 },
    })

    const update = await fetch(`${base}/v1/settings/notifications`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer {{SECRET_x9wk2p7q}}',
      },
      body: JSON.stringify({
        userId: 'user-1',
        expectedRevision: 0,
        quietStart: '22:00',
        quietEnd: '08:00',
        utcOffsetMinutes: 480,
      }),
    })
    expect(update.status).toBe(200)
    expect(await update.json()).toMatchObject({
      preferences: {
        revision: 1,
        quietStart: '22:00',
        quietEnd: '08:00',
        utcOffsetMinutes: 480,
      },
    })

    const stale = await fetch(`${base}/v1/settings/notifications`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer {{SECRET_x9wk2p7q}}',
      },
      body: JSON.stringify({
        userId: 'user-1',
        expectedRevision: 0,
        utcOffsetMinutes: 0,
      }),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({
      error: 'notification_preferences_conflict',
    })

    const invalid = await fetch(`${base}/v1/settings/notifications`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer {{SECRET_x9wk2p7q}}',
      },
      body: JSON.stringify({
        userId: 'user-1',
        expectedRevision: 1,
        quietStart: '22:00',
        utcOffsetMinutes: 0,
      }),
    })
    expect(invalid.status).toBe(400)
  })

  it('resolves unknown deliveries over HTTP with auth, replay and 409', async () => {
    const { store } = seededStore()
    const message = store.enqueueOutbox({
      userId: 'owner',
      channel: 'conversation',
      dedupeKey: 'http-unknown',
      payload: { text: 'unknown outcome' },
    })
    store.claimNextOutbox('dispatcher-1')
    store.markOutboxUnknown(message.id, 'dispatcher-1', 'timeout')
    const server = createControlPlane({
      store,
      apiToken: '{{SECRET_x9wk2p7q}}',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const url = `${base}/v1/outbox/${message.id}/resolve`
    const body = JSON.stringify({
      userId: 'owner',
      commandId: 'http-resolve',
      resolution: 'sent',
      note: '接收端确认送达',
    })

    const unauthorized = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(unauthorized.status).toBe(401)

    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer {{SECRET_x9wk2p7q}}',
    }
    const created = await fetch(url, { method: 'POST', headers, body })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as {
      message: OutboxMessage
    }
    expect(createdBody.message.status).toBe('sent')
    expect(createdBody.message.resolution).toMatchObject({
      resolution: 'sent',
      previousStatus: 'unknown',
    })

    const replay = await fetch(url, { method: 'POST', headers, body })
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(createdBody)

    const conflict = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userId: 'owner',
        commandId: 'http-resolve',
        resolution: 'failed',
        note: '不同的结论',
      }),
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      error: 'outbox_resolution_conflict',
    })

    const intruder = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userId: 'intruder',
        commandId: 'http-resolve-2',
        resolution: 'sent',
        note: '越权',
      }),
    })
    expect(intruder.status).toBe(404)

    const enqueued = await fetch(`${base}/v1/outbox`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userId: 'owner',
        dedupeKey: 'http-coalesce-1',
        coalesceKey: 'progress',
        payload: { text: 'first' },
      }),
    })
    expect(enqueued.status).toBe(202)
    const firstBody = (await enqueued.json()) as { message: OutboxMessage }
    const coalesced = await fetch(`${base}/v1/outbox`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userId: 'owner',
        dedupeKey: 'http-coalesce-2',
        coalesceKey: 'progress',
        payload: { text: 'second' },
      }),
    })
    expect(coalesced.status).toBe(202)
    const secondBody = (await coalesced.json()) as { message: OutboxMessage }
    expect(secondBody.message.id).toBe(firstBody.message.id)
    expect(secondBody.message.coalescedCount).toBe(1)
    expect(secondBody.message.payload).toEqual({ text: 'second' })
  })
})
