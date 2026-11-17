import { describe, expect, it, vi } from 'vitest'

import type { InboxEvent } from '../src/core/domain.js'
import type { JsonModelProvider } from '../src/model/provider.js'
import { ModelInputRewriter } from '../src/rewrite/model-input-rewriter.js'
import { RewritingTaskRouter } from '../src/rewrite/rewriting-router.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'

describe('model input rewriting', () => {
  it('uses a rewritten execution view without modifying the canonical event', async () => {
    const provider: JsonModelProvider = {
      name: 'rewrite-test',
      generateJson: vi.fn(() =>
        Promise.resolve({ text: '请整理今天的会议记录。' }),
      ),
    }
    const event: InboxEvent = {
      id: 'event-1',
      userId: 'user-1',
      type: 'user.message',
      source: 'voice',
      payload: { text: '请 整理今天会议记录啊' },
      status: 'processing',
      attempts: 1,
      createdAt: '2026-11-17T00:00:00.000Z',
    }
    const router = new RewritingTaskRouter(
      new RuleBasedTaskRouter(),
      new ModelInputRewriter(provider),
    )

    const decision = await router.route(event, [])

    expect(decision).toMatchObject({
      kind: 'create_task',
      input: '请整理今天的会议记录。',
      goal: '请整理今天的会议记录。',
    })
    expect(event.payload).toEqual({ text: '请 整理今天会议记录啊' })
  })

  it('falls back to the original text when rewriting fails or is invalid', async () => {
    const failing: JsonModelProvider = {
      name: 'rewrite-test',
      generateJson: () => Promise.reject(new Error('offline')),
    }
    const invalid: JsonModelProvider = {
      name: 'rewrite-test',
      generateJson: () => Promise.resolve({ text: '' }),
    }

    await expect(new ModelInputRewriter(failing).rewrite('原文')).resolves.toBe(
      '原文',
    )
    await expect(new ModelInputRewriter(invalid).rewrite('原文')).resolves.toBe(
      '原文',
    )
  })
})
