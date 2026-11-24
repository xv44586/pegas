import { describe, expect, it } from 'vitest'

import {
  attentionDeepLink,
  attentionNotificationText,
  createDesktopAttentionMonitor,
  parseOutboxSnapshot,
} from '../src/desktop/attention.js'

interface FakeMessage {
  id: string
  createdAt: string
  readAt?: string
  status?: string
  payload?: unknown
}

function message(overrides: Partial<FakeMessage> & { id: string }): unknown {
  return {
    userId: 'owner',
    channel: 'web',
    dedupeKey: `dedupe-${overrides.id}`,
    status: 'sent',
    attempts: 1,
    createdAt: '2026-11-24T10:00:00.000Z',
    updatedAt: '2026-11-24T10:00:00.000Z',
    payload: { type: 'run.completed', text: '结果已就绪' },
    ...overrides,
  }
}

function createHarness(options: { supported?: boolean } = {}) {
  const notified: { title: string; body?: string; deepLink: string }[] = []
  const opened: string[] = []
  const badges: (string | undefined)[] = []
  const monitor = createDesktopAttentionMonitor({
    fetchSnapshot: () => Promise.resolve(snapshot),
    notificationsSupported: () => options.supported ?? true,
    notify: notice => {
      notified.push(notice)
      return () => opened.push(notice.deepLink)
    },
    setBadge: value => badges.push(value),
  })
  let snapshot: unknown = { messages: [] }
  return {
    monitor,
    notified,
    opened,
    badges,
    setSnapshot(value: unknown) {
      snapshot = value
    },
  }
}

describe('desktop attention monitor', () => {
  it('parses only owner-visible unread outbox facts', () => {
    const parsed = parseOutboxSnapshot({
      messages: [
        message({ id: 'a' }),
        message({ id: 'b', readAt: '2026-11-24T10:05:00.000Z' }),
        message({ id: 'c', status: 'merged' }),
        { id: 'broken' },
      ],
    })
    expect(parsed).toHaveLength(3)
    expect(parsed?.map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(parsed?.[0]?.unread).toBe(true)
    expect(parsed?.[1]?.unread).toBe(false)
    expect(parseOutboxSnapshot({ messages: 'nope' })).toBeUndefined()
    expect(parseOutboxSnapshot(undefined)).toBeUndefined()
  })

  it('notifies once per new unread message and never replays history after restart', async () => {
    const harness = createHarness()
    harness.setSnapshot({
      messages: [
        message({ id: 'historic', createdAt: '2026-11-23T09:00:00.000Z' }),
      ],
    })
    await harness.monitor.poll()
    expect(harness.notified).toHaveLength(0)
    expect(harness.badges.at(-1)).toBe('1')

    harness.setSnapshot({
      messages: [
        message({ id: 'historic', createdAt: '2026-11-23T09:00:00.000Z' }),
        message({ id: 'fresh', createdAt: '2026-11-24T11:00:00.000Z' }),
      ],
    })
    await harness.monitor.poll()
    await harness.monitor.poll()
    expect(harness.notified.map(item => item.deepLink)).toEqual([
      attentionDeepLink('fresh'),
    ])
    expect(harness.badges.at(-1)).toBe('2')
  })

  it('clears the dock badge when everything is read and drops fake zero on failure', async () => {
    const harness = createHarness()
    harness.setSnapshot({ messages: [message({ id: 'a' })] })
    await harness.monitor.poll()
    expect(harness.badges.at(-1)).toBe('1')

    harness.setSnapshot({
      messages: [message({ id: 'a', readAt: '2026-11-24T12:00:00.000Z' })],
    })
    await harness.monitor.poll()
    expect(harness.badges.at(-1)).toBe('')

    harness.setSnapshot(undefined)
    await harness.monitor.poll()
    expect(harness.badges.at(-1)).toBe('')
    expect(harness.monitor.consecutiveFailures).toBe(1)
  })

  it('degrades to badge-only when system notifications are unavailable', async () => {
    const harness = createHarness({ supported: false })
    harness.setSnapshot({ messages: [] })
    await harness.monitor.poll()
    harness.setSnapshot({
      messages: [
        message({ id: 'fresh', createdAt: '2026-11-24T11:00:00.000Z' }),
      ],
    })
    await harness.monitor.poll()
    expect(harness.notified).toHaveLength(0)
    expect(harness.badges.at(-1)).toBe('1')
  })

  it('routes notification clicks through the existing outbox deep link', () => {
    expect(attentionDeepLink('msg with space')).toBe(
      '/?view=outbox&outbox=msg%20with%20space',
    )
  })

  it('builds honest notification text from the message projection only', () => {
    const withTitle = attentionNotificationText({
      id: 'a',
      createdAt: '2026-11-24T10:00:00.000Z',
      unread: true,
      status: 'pending',
      payload: {
        type: 'approval.required',
        title: '需要你批准',
        prompt: { command: 'rm -rf /' },
      },
    })
    expect(withTitle.title).toBe('需要你批准')
    expect(withTitle.body ?? '').not.toContain('rm -rf')

    const plain = attentionNotificationText({
      id: 'b',
      createdAt: '2026-11-24T10:00:00.000Z',
      unread: true,
      status: 'pending',
      payload: { type: 'run.completed', text: '报告写完了。剩余风险见详情。' },
    })
    expect(plain.title.length).toBeGreaterThan(0)
    expect(plain.title.length).toBeLessThanOrEqual(80)
  })
})
