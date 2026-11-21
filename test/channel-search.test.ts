import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type { Clock } from '../src/core/clock.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

class MutableClock implements Clock {
  #now: Date

  constructor(value: string) {
    this.#now = new Date(value)
  }

  now(): Date {
    return this.#now
  }

  advance(milliseconds: number): void {
    this.#now = new Date(this.#now.getTime() + milliseconds)
  }
}

describe('CHANNEL-003 Channel search', () => {
  it('searches only the owner’s visible Channel content and returns snippets', () => {
    const store = new PegasStore(':memory:')
    const ownerEvent = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: '整理 Telegram 产品方案' },
    }).event
    const otherEvent = store.enqueueEvent({
      userId: 'other',
      type: 'user.message',
      source: 'web',
      payload: { text: '整理 Telegram 私人内容' },
    }).event
    const ownerTask = store.applyRoutingDecision(
      ownerEvent,
      {
        kind: 'create_task',
        title: 'Telegram 产品方案',
        goal: '整理 Telegram 产品方案',
        input: '整理 Telegram 产品方案',
        reason: 'separate work',
      },
      'test',
    ).task
    store.applyRoutingDecision(
      otherEvent,
      {
        kind: 'create_task',
        title: 'Telegram 私人内容',
        goal: '整理 Telegram 私人内容',
        input: '整理 Telegram 私人内容',
        reason: 'separate work',
      },
      'test',
    )

    const result = store.searchChannels('owner', {
      query: 'Telegram',
      limit: 20,
    })

    expect(result.channels.map(channel => channel.id)).toEqual([ownerTask.id])
    const match = result.matches.find(
      item => item.channelId === ownerTask.id && item.sourceKind === 'input',
    )
    expect(match?.sourceKind).toBe('input')
    expect(match?.snippet).toContain('Telegram')
    expect(JSON.stringify(result)).not.toContain('私人内容')
    expect(() =>
      store.searchChannels('owner', {
        query: '界'.repeat(201),
        limit: 20,
      }),
    ).toThrow('Search query must contain at most 200 characters')
    store.close()
  })

  it('indexes pending explicit Channel inputs before routing', () => {
    const store = new PegasStore(':memory:')
    const origin = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: 'Create a launch plan' },
    }).event
    const task = store.createTaskFromEvent(origin, 'Launch plan')
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: '增加 Telegram 渠道', taskId: task.id },
    })

    const result = store.searchChannels('owner', {
      query: 'Telegram',
      limit: 20,
    })

    expect(result.channels.map(channel => channel.id)).toEqual([task.id])
    expect(result.matches[0]?.sourceKind).toBe('input')
    store.close()
  })

  it('filters by lifecycle and attention state with stable cursor pagination', () => {
    const clock = new MutableClock('2026-11-21T01:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    const firstEvent = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: 'First task' },
    }).event
    const first = store.createTaskFromEvent(firstEvent, 'First task')
    clock.advance(1_000)
    const secondEvent = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: 'Second task' },
    }).event
    const second = store.createTaskFromEvent(secondEvent, 'Second task')
    clock.advance(1_000)
    store.stopTask(second.id, 'owner', 'stop-second')
    store.enqueueOutbox({
      userId: 'owner',
      taskId: first.id,
      channel: 'conversation',
      dedupeKey: 'first-needs-read',
      payload: { type: 'run.failed', text: 'First task needs review' },
    })

    const pageOne = store.searchChannels('owner', {
      sort: 'created',
      limit: 1,
    })
    const pageTwo = store.searchChannels('owner', {
      sort: 'created',
      limit: 1,
      cursor: pageOne.nextCursor,
    })
    const ended = store.searchChannels('owner', {
      ended: true,
      limit: 20,
    })
    const attention = store.searchChannels('owner', {
      needsAttention: true,
      limit: 20,
    })

    expect(pageOne.channels.map(channel => channel.id)).toEqual([second.id])
    expect(pageOne.nextCursor).toBe(second.id)
    expect(pageTwo.channels.map(channel => channel.id)).toEqual([first.id])
    expect(ended.channels.map(channel => channel.id)).toEqual([second.id])
    expect(attention.channels.map(channel => channel.id)).toEqual([first.id])
    store.close()
  })

  it('serves the search contract through the Control Plane', async () => {
    const store = new PegasStore(':memory:')
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: 'Research weekly reporting' },
    }).event
    const task = store.createTaskFromEvent(event, 'Weekly reporting')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

    const response = await fetch(
      `${base}/v1/channels/search?userId=owner&q=weekly&status=backlog&sort=created`,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      channels: [{ id: task.id, title: 'Weekly reporting' }],
      matches: [{ channelId: task.id }],
    })

    const invalidIcon = await fetch(
      `${base}/v1/channels/search?userId=owner&workerIconId=blue-comet`,
    )
    expect(invalidIcon.status).toBe(400)
    expect(await invalidIcon.json()).toEqual({
      error: 'bad_request',
      message: 'workerIconId must be car, camera, computer or phone',
    })
  })

  it('reopens a migrated database with the search index intact', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-channel-search-'))
    const path = join(directory, 'pegas.sqlite')
    const firstStore = new PegasStore(path)
    const event = firstStore.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: '维护季度复盘文档' },
    }).event
    const task = firstStore.createTaskFromEvent(event, '季度复盘')
    firstStore.close()

    const reopened = new PegasStore(path)
    expect(
      reopened
        .searchChannels('owner', {
          query: '季度复盘',
          limit: 10,
        })
        .channels.map(channel => channel.id),
    ).toEqual([task.id])
    reopened.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('does not index a cross-owner task-event association', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-channel-search-user-'))
    const path = join(directory, 'pegas.sqlite')
    const firstStore = new PegasStore(path)
    const ownerEvent = firstStore.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: 'Owner visible work' },
    }).event
    const ownerTask = firstStore.createTaskFromEvent(ownerEvent, 'Owner task')
    const crossOwnerEvent = firstStore.enqueueEvent({
      userId: 'other',
      type: 'user.message',
      source: 'web',
      payload: { text: 'cross-owner-secret' },
    }).event
    firstStore.close()

    const database = new DatabaseSync(path)
    database.exec('PRAGMA busy_timeout = 5000;')
    database
      .prepare(
        `INSERT INTO task_events (event_id, task_id, relation, created_at)
         VALUES (?, ?, 'continuation', ?)`,
      )
      .run(crossOwnerEvent.id, ownerTask.id, '2026-11-21T00:00:00.000Z')
    database.close()

    const reopened = new PegasStore(path)
    expect(
      reopened.searchChannels('owner', {
        query: 'cross-owner-secret',
        limit: 10,
      }),
    ).toEqual({ channels: [], matches: [] })
    reopened.close()
    rmSync(directory, { recursive: true, force: true })
  })
})
