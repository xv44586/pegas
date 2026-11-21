import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type { Clock } from '../src/core/clock.js'
import {
  EventAttachmentConflictError,
  EventAttachmentsUnsupportedError,
  PegasStore,
} from '../src/storage/sqlite-store.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function persistentStore(): { store: PegasStore; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-conv001-'))
  const store = new PegasStore(join(directory, 'pegas.sqlite'))
  cleanups.push(
    () => store.close(),
    () => rmSync(directory, { recursive: true, force: true }),
  )
  return { store, directory }
}

function seedMessage(
  store: PegasStore,
  userId: string,
  text: string,
  deviceId?: string,
) {
  return store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    ...(deviceId ? { deviceId } : {}),
    payload: { text },
  }).event
}

class StepClock implements Clock {
  #value: Date

  constructor(value: string) {
    this.#value = new Date(value)
  }

  now(): Date {
    return new Date(this.#value)
  }

  step(): void {
    this.#value = new Date(this.#value.getTime() + 1000)
  }
}

describe('CONV-001 device identity', () => {
  it('persists the ingress device identity on durable events', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const event = seedMessage(store, 'owner', '来自手机', 'iphone-15-pro')
    expect(event.deviceId).toBe('iphone-15-pro')
    const plain = seedMessage(store, 'owner', '来自匿名端')
    expect(plain.deviceId).toBeUndefined()
    expect(
      store.listEvents('owner').find(entry => entry.id === event.id)?.deviceId,
    ).toBe('iphone-15-pro')
  })

  it('accepts deviceId through the event API and rejects oversized values', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => store.close(),
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const accepted = await fetch(`${base}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        type: 'user.message',
        source: 'mobile',
        deviceId: 'pixel-9',
        payload: { text: '移动端输入' },
      }),
    })
    expect(accepted.status).toBe(202)
    const body = (await accepted.json()) as { event: { deviceId?: string } }
    expect(body.event.deviceId).toBe('pixel-9')

    const oversized = await fetch(`${base}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        deviceId: 'd'.repeat(129),
        payload: { text: 'x' },
      }),
    })
    expect(oversized.status).toBe(400)
  })
})

describe('CONV-001 cross-device event cursor', () => {
  it('pages strictly after the cursor with a stable order and owner isolation', () => {
    const clock = new StepClock('2026-11-21T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const first = seedMessage(store, 'owner', '一', 'mac')
    clock.step()
    const second = seedMessage(store, 'owner', '二', 'iphone')
    clock.step()
    const third = seedMessage(store, 'owner', '三', 'mac')
    clock.step()
    seedMessage(store, 'other', '别人的事件')

    const fromStart = store.pageEventsAfter('owner', 2)
    expect(fromStart.events.map(event => event.id)).toEqual([
      first.id,
      second.id,
    ])
    expect(fromStart.nextCursor).toBe(second.id)

    const resumed = store.pageEventsAfter('owner', 2, fromStart.nextCursor)
    expect(resumed.events.map(event => event.id)).toEqual([third.id])
    expect(resumed.nextCursor).toBeUndefined()
    expect(resumed.events[0]?.deviceId).toBe('mac')

    const exhausted = store.pageEventsAfter('owner', 2, third.id)
    expect(exhausted.events).toEqual([])
    expect(() => store.pageEventsAfter('owner', 2, 'missing')).toThrow(
      'Pagination cursor is invalid',
    )
    expect(() => store.pageEventsAfter('other', 2, first.id)).toThrow(
      'Pagination cursor is invalid',
    )
    expect(() => store.pageEventsAfter('owner', 0)).toThrow(
      'Pagination limit must be between 1 and 200',
    )
  })

  it('serves the incremental cursor contract over HTTP', async () => {
    const clock = new StepClock('2026-11-21T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => store.close(),
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const first = seedMessage(store, 'owner', '第一条')
    clock.step()
    seedMessage(store, 'owner', '第二条')

    const response = await fetch(
      `${base}/v1/events?userId=owner&cursor=${first.id}&limit=10`,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      events: { id: string; payload: { text: string } }[]
    }
    expect(body.events).toHaveLength(1)
    expect(body.events[0]?.payload.text).toBe('第二条')

    const invalid = await fetch(
      `${base}/v1/events?userId=owner&cursor=missing-event`,
    )
    expect(invalid.status).toBe(400)

    const full = await fetch(`${base}/v1/events?userId=owner`)
    expect(full.status).toBe(200)
    expect(((await full.json()) as { events: unknown[] }).events).toHaveLength(
      2,
    )
  })
})

describe('CONV-001 event attachments', () => {
  it('stores content-addressed bytes idempotently and rejects conflicts', () => {
    const { store, directory } = persistentStore()
    const event = seedMessage(store, 'owner', '带附件的消息')
    const bytes = Buffer.from('attachment-bytes')
    const attachment = store.attachEventFile(event.id, 'owner', {
      fileName: 'notes.txt',
      mediaType: 'text/plain',
      bytes,
    })
    expect(attachment.byteSize).toBe(bytes.byteLength)
    expect(attachment.sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    )
    const replay = store.attachEventFile(event.id, 'owner', {
      fileName: 'notes.txt',
      mediaType: 'text/plain',
      bytes,
    })
    expect(replay.id).toBe(attachment.id)
    expect(() =>
      store.attachEventFile(event.id, 'owner', {
        fileName: 'notes.txt',
        mediaType: 'text/plain',
        bytes: Buffer.from('different'),
      }),
    ).toThrow(EventAttachmentConflictError)
    expect(() =>
      store.attachEventFile(event.id, 'other', {
        fileName: 'notes.txt',
        mediaType: 'text/plain',
        bytes,
      }),
    ).toThrow('Event does not exist for user')

    const read = store.readEventAttachmentBytes(event.id, 'owner')
    expect(read?.bytes.equals(bytes)).toBe(true)
    expect(store.getEventAttachment(event.id, 'other')).toBeUndefined()

    // The stored file lives inside the data directory, content-addressed.
    const stored = store.readEventAttachmentBytes(event.id, 'owner')
    expect(stored?.attachment.sha256).toBe(attachment.sha256)
    const files = readFileSync(
      join(directory, 'attachments', `${attachment.sha256}-${attachment.id}`),
    )
    expect(files.equals(bytes)).toBe(true)
  })

  it('projects attachment metadata onto event lists and channel timelines', () => {
    const { store } = persistentStore()
    const event = seedMessage(store, 'owner', '请查这份计划')
    const created = store.applyRoutingDecision(
      event,
      {
        kind: 'create_task',
        title: '请查这份计划',
        goal: '请查这份计划',
        input: '请查这份计划',
        reason: 'attachment projection test',
      },
      'echo',
    )
    const attachment = store.attachEventFile(event.id, 'owner', {
      fileName: 'plan.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('plan-bytes'),
    })
    const listed = store
      .listEvents('owner')
      .find(entry => entry.id === event.id)
    expect(listed?.attachment?.id).toBe(attachment.id)
    expect(listed?.attachment?.fileName).toBe('plan.txt')
    const timeline = store.pageChannelEvents(created.task.id, 'owner')
    const timelineEvent = timeline.events.find(entry => entry.id === event.id)
    expect(timelineEvent?.attachment?.sha256).toBe(attachment.sha256)
    const withoutAttachment = seedMessage(store, 'owner', '没有附件')
    expect(
      store.listEvents('owner').find(entry => entry.id === withoutAttachment.id)
        ?.attachment,
    ).toBeUndefined()
  })

  it('detects tampered attachment bytes before serving them', () => {
    const { store, directory } = persistentStore()
    const event = seedMessage(store, 'owner', '附件篡改')
    const attachment = store.attachEventFile(event.id, 'owner', {
      fileName: 'a.bin',
      mediaType: 'application/octet-stream',
      bytes: Buffer.from('original'),
    })
    writeFileSync(
      join(directory, 'attachments', `${attachment.sha256}-${attachment.id}`),
      'tampered!',
    )
    expect(() => store.readEventAttachmentBytes(event.id, 'owner')).toThrow(
      'Attachment bytes do not match the stored digest',
    )
  })

  it('refuses attachments on in-memory databases and unknown events', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const event = seedMessage(store, 'owner', 'x')
    expect(() =>
      store.attachEventFile(event.id, 'owner', {
        fileName: 'a.txt',
        mediaType: 'text/plain',
        bytes: Buffer.from('x'),
      }),
    ).toThrow(EventAttachmentsUnsupportedError)
    const { store: persistent } = persistentStore()
    expect(() =>
      persistent.attachEventFile('missing', 'owner', {
        fileName: 'a.txt',
        mediaType: 'text/plain',
        bytes: Buffer.from('x'),
      }),
    ).toThrow('Event does not exist for user')
  })

  it('uploads and downloads attachments through the Control Plane', async () => {
    const { store } = persistentStore()
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const event = seedMessage(store, 'owner', '截图消息')
    const bytes = Buffer.from('png-bytes')
    const upload = await fetch(
      `${base}/v1/events/${event.id}/attachments?userId=owner&fileName=${encodeURIComponent('截图.png')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: bytes,
      },
    )
    expect(upload.status).toBe(201)
    const uploaded = (await upload.json()) as {
      attachment: { sha256: string; fileName: string }
    }
    expect(uploaded.attachment.fileName).toBe('截图.png')

    const download = await fetch(
      `${base}/v1/events/${event.id}/attachments?userId=owner`,
    )
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('image/png')
    expect(download.headers.get('x-pegas-attachment-sha256')).toBe(
      uploaded.attachment.sha256,
    )
    expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true)

    const crossOwner = await fetch(
      `${base}/v1/events/${event.id}/attachments?userId=other`,
    )
    expect(crossOwner.status).toBe(404)

    const conflict = await fetch(
      `${base}/v1/events/${event.id}/attachments?userId=owner&fileName=${encodeURIComponent('截图.png')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: Buffer.from('different'),
      },
    )
    expect(conflict.status).toBe(409)

    const empty = await fetch(
      `${base}/v1/events/${event.id}/attachments?userId=owner&fileName=empty.txt`,
      { method: 'POST', body: Buffer.alloc(0) },
    )
    expect(empty.status).toBe(400)

    const missingEvent = await fetch(
      `${base}/v1/events/missing/attachments?userId=owner&fileName=a.txt`,
      { method: 'POST', body: Buffer.from('x') },
    )
    expect(missingEvent.status).toBe(400)
  })
})
