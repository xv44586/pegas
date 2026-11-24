import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/core/config.js'
import type { Clock } from '../src/core/clock.js'
import type { InboxEvent } from '../src/core/domain.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

class MutableClock implements Clock {
  current: Date

  constructor(start = '2026-11-24T00:00:00.000Z') {
    this.current = new Date(start)
  }

  now(): Date {
    return new Date(this.current)
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds)
  }
}

const hourMs = 60 * 60 * 1000

function seedClarification(
  store: PegasStore,
  text = '再补充一点预算信息',
): { event: InboxEvent; messageId: string } {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
  }).event
  const { message } = store.applyRoutingClarification(event, {
    kind: 'clarify',
    input: text,
    question: '这条消息属于已有事情还是新事情？',
    reason: 'ambiguous',
  })
  return { event, messageId: message.id }
}

describe('routing clarification auto-expiry', () => {
  it('parses the TTL config with a 72h default and rejects invalid values', () => {
    expect(loadConfig({}).routingClarificationTtlMs).toBe(72 * hourMs)
    expect(
      loadConfig({ PEGAS_ROUTING_CLARIFICATION_TTL_MS: '1000' })
        .routingClarificationTtlMs,
    ).toBe(1000)
    for (const invalid of ['0', '-5', 'abc', '1.5']) {
      expect(() =>
        loadConfig({ PEGAS_ROUTING_CLARIFICATION_TTL_MS: invalid }),
      ).toThrow(/PEGAS_ROUTING_CLARIFICATION_TTL_MS/)
    }
  })

  it('stamps expiresAt on clarification todos and leaves other outbox messages untouched', () => {
    const clock = new MutableClock()
    const store = new PegasStore(':memory:', {
      clock,
      routingClarificationTtlMs: 2 * hourMs,
    })
    try {
      const { messageId } = seedClarification(store)
      const todo = store
        .listOutbox('owner')
        .find(message => message.id === messageId)
      expect(todo?.expiresAt).toBe('2026-11-24T02:00:00.000Z')
      const plain = store.enqueueOutbox({
        userId: 'owner',
        channel: 'conversation',
        dedupeKey: 'plain-fact',
        payload: { type: 'agent.message', text: '你好' },
      })
      expect(plain.expiresAt).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('settles due clarifications exactly once with an honest expired fact and no Task/Run/Event', () => {
    const clock = new MutableClock()
    const store = new PegasStore(':memory:', {
      clock,
      routingClarificationTtlMs: hourMs,
    })
    try {
      const { event, messageId } = seedClarification(
        store,
        '预算控制在两千以内',
      )
      const eventsBefore = store.listEvents('owner').length
      expect(store.expireDueRoutingClarifications()).toEqual([])
      clock.advance(hourMs + 1)
      const settled = store.expireDueRoutingClarifications()
      expect(settled).toHaveLength(1)
      expect(settled[0]?.todo.id).toBe(messageId)
      expect(settled[0]?.todo.readAt).toBe(clock.now().toISOString())
      expect(settled[0]?.fact.payload).toEqual({
        type: 'routing.clarification_expired',
        eventId: event.id,
        input: '预算控制在两千以内',
        question: '这条消息属于已有事情还是新事情？',
        expiredAt: clock.now().toISOString(),
        text: '归类澄清已过期：这条消息没有进入任何事情。如需处理，请重新发送。',
      })
      expect(settled[0]?.fact.taskId).toBeUndefined()
      expect(settled[0]?.fact.userId).toBe('owner')
      expect(store.expireDueRoutingClarifications()).toEqual([])
      expect(
        store
          .listOutbox('owner')
          .filter(
            message =>
              (message.payload as { type?: string }).type ===
              'routing.clarification_expired',
          ),
      ).toHaveLength(1)
      expect(store.listTasks('owner')).toHaveLength(0)
      expect(store.listEvents('owner')).toHaveLength(eventsBefore)
      const original = store
        .listOutbox('owner')
        .find(message => message.id === messageId)
      expect((original?.payload as { input?: string }).input).toBe(
        '预算控制在两千以内',
      )
    } finally {
      store.close()
    }
  })

  it('keeps the first read timestamp when an already-read todo expires and validates the batch limit', () => {
    const clock = new MutableClock()
    const store = new PegasStore(':memory:', {
      clock,
      routingClarificationTtlMs: hourMs,
    })
    try {
      const { messageId } = seedClarification(store)
      clock.advance(10 * 60 * 1000)
      const readAt = clock.now().toISOString()
      store.markOutboxRead(messageId, 'owner')
      clock.advance(hourMs)
      const settled = store.expireDueRoutingClarifications()
      expect(settled).toHaveLength(1)
      expect(settled[0]?.todo.readAt).toBe(readAt)
      for (const invalid of [0, -1, 1001, 1.5]) {
        expect(() => store.expireDueRoutingClarifications(invalid)).toThrow(
          /batch size/i,
        )
      }
    } finally {
      store.close()
    }
  })
})
