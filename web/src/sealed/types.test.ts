import { describe, expect, it } from 'vitest'

import type { OutboxMessage } from '../types'
import { attentionKind, isAttentionMessage } from './types'

describe('Goal delivery attention messages', () => {
  it.each([
    ['review.ready', 'result'],
    ['goal.evidence_required', 'input'],
    ['run.blocked', 'input'],
    ['run.waiting', 'input'],
  ] as const)('maps %s to the %s attention kind', (type, expected) => {
    const message: OutboxMessage = {
      id: `message-${type}`,
      userId: 'owner',
      taskId: 'task-1',
      payload: { type, taskId: 'task-1', runId: 'run-1' },
      status: 'pending',
      createdAt: '2026-11-20T00:00:00.000Z',
    }

    expect(attentionKind(message)).toBe(expected)
    expect(isAttentionMessage(message)).toBe(true)
  })
})
