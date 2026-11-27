import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createControlPlane } from '../src/control-plane/server.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

function create(store: PegasStore, title = '会议纪要', userId = 'owner') {
  const { event } = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'web',
    payload: { text: title },
  })
  return store.createTaskFromEvent(event, title)
}

describe('CHANNEL-004 organization', () => {
  it('persists independent preferences, replays assignments and rejects stale changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pegas-organization-'))
    const path = join(dir, 'db.sqlite')
    let store = new PegasStore(path)
    try {
      const task = create(store)
      const update = { pinned: true, archived: false, expectedRevision: 0 }
      expect(
        store.updateChannelOrganization(task.id, 'owner', update)?.organization,
      ).toEqual({ pinned: true, archived: false, revision: 1 })
      expect(
        store.updateChannelOrganization(task.id, 'owner', update)?.organization
          .revision,
      ).toBe(1)
      expect(() =>
        store.updateChannelOrganization(task.id, 'owner', {
          ...update,
          archived: true,
        }),
      ).toThrow('已更新')
      store.updateChannelOrganization(task.id, 'owner', {
        ...update,
        archived: true,
        expectedRevision: 1,
      })
      expect(store.findTask(task.id, 'owner')).toEqual(task)
      store.close()
      store = new PegasStore(path)
      expect(store.projectWorkChannel(task).organization).toEqual({
        pinned: true,
        archived: true,
        revision: 2,
      })
      store.updateChannelOrganization(task.id, 'owner', {
        ...update,
        expectedRevision: 2,
      })
      expect(
        store
          .searchChannels('owner', { archived: false, pinned: true, limit: 8 })
          .channels.map(c => c.id),
      ).toEqual([task.id])
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps stopped tasks separate from archived tasks and never changes runs', () => {
    const store = new PegasStore(':memory:')
    try {
      const stopped = create(store, '停止')
      store.stopTask(stopped.id, 'owner', 'stop')
      const active = create(store, '长期讨论')
      const runs = store.listRuns(active.id)
      store.updateChannelOrganization(active.id, 'owner', {
        pinned: true,
        archived: true,
        expectedRevision: 0,
      })
      expect(
        store
          .searchChannels('owner', { archived: true, limit: 8 })
          .channels.map(c => c.id),
      ).toEqual([active.id])
      expect(
        store
          .searchChannels('owner', {
            archived: false,
            statuses: ['cancelled'],
            limit: 8,
          })
          .channels.map(c => c.id),
      ).toEqual([stopped.id])
      expect(store.listRuns(active.id)).toEqual(runs)
      expect(store.findTask(active.id, 'owner')).toEqual(active)
    } finally {
      store.close()
    }
  })

  it('pages every result with filters, tie breaks and owner isolation', () => {
    const store = new PegasStore(':memory:')
    try {
      const tasks = Array.from({ length: 19 }, (_, i) =>
        create(store, `笔记 ${String(i)}`),
      )
      const first = tasks[0]
      const second = tasks[1]
      if (!first || !second) throw new Error('Missing task fixtures')
      const other = create(store, '私有笔记', 'other')
      expect(
        store.updateChannelOrganization(other.id, 'owner', {
          pinned: true,
          archived: false,
          expectedRevision: 0,
        }),
      ).toBeUndefined()
      store.updateChannelOrganization(first.id, 'owner', {
        pinned: true,
        archived: true,
        expectedRevision: 0,
      })
      for (const sort of ['updated', 'created', 'ended'] as const) {
        const ids: string[] = []
        let cursor: string | undefined
        do {
          const page = store.searchChannels('owner', {
            query: '笔记',
            archived: false,
            pinned: false,
            sort,
            limit: 4,
            ...(cursor ? { cursor } : {}),
          })
          ids.push(...page.channels.map(c => c.id))
          cursor = page.nextCursor
        } while (cursor)
        expect(ids.length).toBe(18)
        expect(new Set(ids).size).toBe(18)
        expect(ids).not.toContain(other.id)
      }
      expect(() =>
        store.searchChannels('owner', { cursor: other.id, limit: 8 }),
      ).toThrow('cursor')
      expect(() =>
        store.updateChannelOrganization(second.id, 'owner', {
          pinned: true,
          archived: false,
          expectedRevision: -1,
        }),
      ).toThrow('Invalid')
      expect(
        store.searchChannels('owner', { waiting: true, limit: 20 }).channels
          .length,
      ).toBe(19)
    } finally {
      store.close()
    }
  })

  it('enforces authentication, ownership, validation and conflict over HTTP', async () => {
    const store = new PegasStore(':memory:')
    const task = create(store)
    const server = createControlPlane({ store, apiToken: 'organization-test' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const path = `${base}/v1/channels/${task.id}/organization`
    const headers = {
      authorization: 'Bearer organization-test',
      'content-type': 'application/json',
    }
    const command = {
      userId: 'owner',
      pinned: true,
      archived: false,
      expectedRevision: 0,
    }
    const put = (body: unknown) =>
      fetch(path, { method: 'PUT', headers, body: JSON.stringify(body) })
    try {
      expect(
        (await fetch(path, { method: 'PUT', body: JSON.stringify(command) }))
          .status,
      ).toBe(401)
      expect((await put({ ...command, userId: 'other' })).status).toBe(404)
      expect((await put({ ...command, pinned: 'yes' })).status).toBe(400)
      expect((await put(command)).status).toBe(200)
      expect((await put(command)).status).toBe(200)
      expect((await put({ ...command, archived: true })).status).toBe(409)
      expect((await fetch(path, { headers })).status).toBe(405)
      const response = await fetch(
        `${base}/v1/channels/search?userId=owner&pinned=true&archived=false&limit=1`,
        { headers },
      )
      expect(await response.json()).toMatchObject({
        channels: [
          { id: task.id, organization: { pinned: true, revision: 1 } },
        ],
      })
      expect(
        (
          await fetch(`${base}/v1/channels/search?userId=owner&archived=oops`, {
            headers,
          })
        ).status,
      ).toBe(400)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })
})
