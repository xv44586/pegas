import { describe, expect, it } from 'vitest'

import type { OutboxMessage } from '../types'
import {
  attentionKind,
  attentionSummary,
  isAttentionMessage,
  isSilentConversationMessage,
} from './types'

describe('CONV-006 silent conversation projection', () => {
  const base: OutboxMessage = {
    id: 'message-silent',
    userId: 'owner',
    taskId: 'task-1',
    payload: { type: 'run.progress', text: '执行中' },
    status: 'pending',
    createdAt: '2026-11-22T00:00:00.000Z',
  }

  it('trusts the server projection when present', () => {
    expect(
      isSilentConversationMessage({
        ...base,
        projection: { lane: 'work', weight: 'silent' },
      }),
    ).toBe(true)
    expect(
      isSilentConversationMessage({
        ...base,
        payload: { type: 'future.process', text: '未知过程事实' },
        projection: { lane: 'work', weight: 'silent' },
      }),
    ).toBe(true)
    expect(
      isSilentConversationMessage({
        ...base,
        projection: { lane: 'say', weight: 'inline' },
      }),
    ).toBe(false)
  })

  it('falls back to legacy payload types without projection attributes', () => {
    expect(isSilentConversationMessage(base)).toBe(true)
    expect(
      isSilentConversationMessage({
        ...base,
        payload: { type: 'run.acknowledged', text: '接单' },
      }),
    ).toBe(true)
    expect(
      isSilentConversationMessage({
        ...base,
        payload: { type: 'run.completed', text: '完成' },
      }),
    ).toBe(false)
    expect(
      isSilentConversationMessage({
        ...base,
        payload: { type: 'future.process', text: '未知事实' },
      }),
    ).toBe(false)
  })
})

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

describe('attention summaries', () => {
  const message: OutboxMessage = {
    id: 'message-summary',
    userId: 'owner',
    taskId: 'task-1',
    payload: {},
    status: 'pending',
    createdAt: '2026-11-22T00:00:00.000Z',
  }

  it('prefers an explicit structured title over the response body', () => {
    expect(
      attentionSummary({
        ...message,
        payload: {
          type: 'run.completed',
          title: '候选版本已交付',
          text: '这是完整回复。\n\n- 第一项\n- 第二项',
        },
      }),
    ).toEqual({
      title: '候选版本已交付',
      preview: '这是完整回复。',
    })
  })

  it('uses a structured summary before the response body', () => {
    expect(
      attentionSummary({
        ...message,
        payload: {
          type: 'approval.required',
          summary: '发布前需要确认影响范围',
          text: '完整审批说明。',
        },
      }),
    ).toEqual({
      title: '发布前需要确认影响范围',
      preview: '完整审批说明。',
    })
  })

  it('derives a short plain-text title from the first meaningful sentence', () => {
    const text =
      '这是测试相关事情的入口。我目前可以处理你在这条对话里提出的测试类需求，例如：\n\n- **测试规划**：要测什么、验收条件、非目标、风险边界\n- **测试编写**：为某个 Feature 写自动化测试\n- **测试执行与门禁**：跑 `pnpm check`、`pnpm smoke`'
    expect(
      attentionSummary({
        ...message,
        payload: { type: 'run.completed', text },
      }),
    ).toEqual({
      title: '这是测试相关事情的入口。',
      preview:
        '我目前可以处理你在这条对话里提出的测试类需求，例如： 测试规划：要测什么、验收条件、非目标、风险边界 测试编写：为某个 Feature 写自动化测试 测试执行与门禁：跑 pnpm check、pnpm smoke',
    })
  })

  it('strips Markdown headings and emphasis without rendering the full response', () => {
    expect(
      attentionSummary({
        ...message,
        payload: {
          type: 'run.failed',
          error: '## 执行失败\n\n**上游模型超时**，请稍后重试。',
        },
      }),
    ).toEqual({
      title: '执行失败',
      preview: '上游模型超时，请稍后重试。',
    })
  })

  it('keeps a single long sentence bounded instead of using the whole body', () => {
    const longSentence = '这是一条没有句号的长回复'.repeat(20)
    const summary = attentionSummary({
      ...message,
      payload: { type: 'run.completed', text: longSentence },
    })
    expect(summary.title.length).toBeLessThanOrEqual(80)
    expect(summary.title.endsWith('…')).toBe(true)
    expect(summary.preview).toBeUndefined()
  })

  it('falls back honestly when the server provides no readable body', () => {
    expect(
      attentionSummary({
        ...message,
        payload: { type: 'run.waiting' },
      }),
    ).toEqual({ title: 'Pegas 有一项更新' })
  })
})
