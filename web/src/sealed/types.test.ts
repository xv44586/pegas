import { describe, expect, it } from 'vitest'

import type { OutboxMessage, WorkChannel } from '../types'
import {
  attentionActionKind,
  attentionActivityPage,
  attentionBoard,
  attentionKind,
  attentionSection,
  attentionSummary,
  conversationAnchor,
  conversationLane,
  hasActiveAutomationFact,
  isAttentionMessage,
  isResolvedDecisionMessage,
  isSilentConversationMessage,
  isStreamingSayMessage,
  sortWorkChannels,
  taskAutomationActive,
} from './types'

describe('CONV-006 lane and anchor projection helpers', () => {
  const base: OutboxMessage = {
    id: 'message-lane',
    userId: 'owner',
    taskId: 'task-1',
    payload: { type: 'run.completed', text: '完成' },
    status: 'sent',
    createdAt: '2026-11-22T00:00:00.000Z',
  }

  it('reads lane and anchor from the server projection only', () => {
    const projected: OutboxMessage = {
      ...base,
      projection: {
        lane: 'work',
        weight: 'card',
        anchor: { taskId: 'task-1', eventId: 'event-1' },
      },
    }
    expect(conversationLane(projected)).toBe('work')
    expect(conversationAnchor(projected)).toEqual({
      taskId: 'task-1',
      eventId: 'event-1',
    })
  })

  it('degrades to inline say and no anchor without projection', () => {
    expect(conversationLane(base)).toBe('say')
    expect(conversationAnchor(base)).toBeUndefined()
  })

  it('marks approvals resolved only when a matching resolution exists', () => {
    const required: OutboxMessage = {
      ...base,
      id: 'approval-required',
      payload: { type: 'approval.required', approvalId: 'approval-1' },
      projection: { lane: 'decide', weight: 'card' },
    }
    const otherResolved: OutboxMessage = {
      ...base,
      id: 'approval-other',
      payload: { type: 'approval.resolved', approvalId: 'approval-2' },
    }
    const matchedResolved: OutboxMessage = {
      ...base,
      id: 'approval-matched',
      payload: { type: 'approval.resolved', approvalId: 'approval-1' },
    }
    expect(isResolvedDecisionMessage(required, [required])).toBe(false)
    expect(isResolvedDecisionMessage(required, [required, otherResolved])).toBe(
      false,
    )
    expect(
      isResolvedDecisionMessage(required, [required, matchedResolved]),
    ).toBe(true)
    expect(
      isResolvedDecisionMessage({ ...required, projection: undefined }, [
        required,
        matchedResolved,
      ]),
    ).toBe(false)
  })

  it('marks reconciliations resolved by a matching action.reconciled fact', () => {
    const required: OutboxMessage = {
      ...base,
      id: 'reconcile-required',
      payload: {
        type: 'action.reconciliation_required',
        actionId: 'action-1',
      },
      projection: { lane: 'decide', weight: 'card' },
    }
    const reconciled: OutboxMessage = {
      ...base,
      id: 'reconciled',
      payload: { type: 'action.reconciled', actionId: 'action-1' },
    }
    expect(isResolvedDecisionMessage(required, [required])).toBe(false)
    expect(isResolvedDecisionMessage(required, [required, reconciled])).toBe(
      true,
    )
  })
})

describe('CONV-006 silent conversation projection', () => {
  it('EXEC-005: streaming state is a server fact on agent.message only', () => {
    const draft: OutboxMessage = {
      id: 'message-stream',
      userId: 'owner',
      taskId: 'task-1',
      payload: { type: 'agent.message', text: '今天是', streaming: true },
      status: 'sent',
      createdAt: '2026-11-23T00:00:00.000Z',
    }
    expect(isStreamingSayMessage(draft)).toBe(true)
    expect(
      isStreamingSayMessage({
        ...draft,
        payload: { type: 'agent.message', text: '今天是星期六。' },
      }),
    ).toBe(false)
    expect(
      isStreamingSayMessage({
        ...draft,
        payload: { type: 'run.progress', text: 'x', streaming: true },
      }),
    ).toBe(false)
  })

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

describe('DESIGN-007 attention sections and grouping', () => {
  const base: OutboxMessage = {
    id: 'message-base',
    userId: 'owner',
    taskId: 'task-1',
    payload: { type: 'run.completed', text: '完成' },
    status: 'sent',
    createdAt: '2026-11-23T00:00:00.000Z',
  }
  function outbox(
    id: string,
    type: string,
    overrides: Partial<OutboxMessage> = {},
  ): OutboxMessage {
    return {
      ...base,
      id,
      payload: { type, text: `内容 ${id}` },
      ...overrides,
    }
  }

  it.each([
    ['approval.required', 'todo', 'confirm'],
    ['input.required', 'todo', 'answer'],
    ['goal.clarification_required', 'todo', 'answer'],
    ['routing.clarification_required', 'todo', 'answer'],
    ['run.blocked', 'todo', 'answer'],
    ['review.ready', 'todo', 'review'],
    ['action.outcome_unknown', 'todo', 'reconcile'],
    ['action.reconciliation_required', 'todo', 'reconcile'],
    ['run.failed', 'failed', undefined],
    ['action.failed', 'failed', undefined],
    ['run.completed', 'activity', undefined],
  ] as const)(
    'maps %s to section %s with action %s',
    (type, section, action) => {
      const message = outbox(`kind-${type}`, type, {
        payload: {
          type,
          actionId: 'action-1',
          approvalId: 'approval-1',
          ...(type === 'review.ready' ? { requiresAcceptance: true } : {}),
        },
      })
      expect(attentionSection(message)).toBe(section)
      expect(attentionActionKind(message)).toBe(action)
    },
  )

  it('keeps automatic and decided deliveries in activity without calling them todos', () => {
    const auto = outbox('review-auto', 'review.ready')
    const pending = outbox('review-pending', 'review.ready', {
      payload: { type: 'review.ready', requiresAcceptance: true },
      readAt: base.createdAt,
    })
    expect(
      attentionBoard([auto, pending]).todo.map(message => message.id),
    ).toEqual([pending.id])
    const decided: OutboxMessage = { ...pending, deliveryDecision: 'accept' }
    const board = attentionBoard([auto, decided])
    expect(board.todo).toHaveLength(0)
    expect(
      board.activity
        .flatMap(group => group.messages)
        .map(message => message.id)
        .sort(),
    ).toEqual([auto.id, pending.id])
  })

  it('routes delivery failures needing manual resolution to reconcile, not activity', () => {
    const message = outbox('delivery-unknown', 'run.completed', {
      status: 'unknown',
    })
    expect(attentionSection(message)).toBe('todo')
    expect(attentionActionKind(message)).toBe('reconcile')
    const resolved: OutboxMessage = {
      ...message,
      resolution: {
        resolution: 'sent',
        note: '人工确认已送达',
        previousStatus: 'unknown',
        resolvedBy: 'owner',
        createdAt: '2026-11-23T00:01:00.000Z',
      },
    }
    expect(attentionSection(resolved)).toBe('activity')
  })

  it('keeps update messages out of the board', () => {
    const board = attentionBoard([outbox('agent-note', 'agent.message')])
    expect(board.totalNotifications).toBe(0)
    expect(board.todo).toHaveLength(0)
    expect(board.failed).toHaveLength(0)
    expect(board.activity).toHaveLength(0)
  })

  it('moves an expired routing clarification out of todo and keeps the honest fact as an update', () => {
    const settledTodo = outbox(
      'routing-todo',
      'routing.clarification_required',
      {
        taskId: undefined,
        readAt: '2026-11-24T03:00:00.000Z',
        payload: {
          type: 'routing.clarification_required',
          eventId: 'event-expiry-1',
          input: '再补充一点',
          question: '这是新事情还是继续已有的事？',
          text: '这是新事情还是继续已有的事？',
        },
      },
    )
    const expiredFact = outbox(
      'routing-expired',
      'routing.clarification_expired',
      {
        taskId: undefined,
        payload: {
          type: 'routing.clarification_expired',
          eventId: 'event-expiry-1',
          input: '再补充一点',
          question: '这是新事情还是继续已有的事？',
          expiredAt: '2026-11-24T03:00:00.000Z',
          text: '归类澄清已过期：这条消息没有进入任何事情。如需处理，请重新发送。',
        },
      },
    )
    expect(isAttentionMessage(settledTodo)).toBe(false)
    expect(attentionKind(expiredFact)).toBe('update')
    expect(attentionSection(expiredFact)).toBeUndefined()
    expect(isAttentionMessage(expiredFact)).toBe(false)
    const board = attentionBoard([settledTodo, expiredFact])
    expect(board.todo).toHaveLength(0)
    expect(board.totalNotifications).toBe(0)
    expect(board.totalUnread).toBe(0)
  })

  it('keeps every actionable message as its own pinned row', () => {
    const board = attentionBoard([
      outbox('approval-a', 'approval.required', {
        payload: { type: 'approval.required', approvalId: 'approval-a' },
      }),
      outbox('approval-b', 'approval.required', {
        payload: { type: 'approval.required', approvalId: 'approval-b' },
      }),
      outbox('review-a', 'review.ready', {
        payload: { type: 'review.ready', requiresAcceptance: true },
      }),
    ])
    expect(board.todo.map(message => message.id)).toEqual([
      'approval-a',
      'approval-b',
      'review-a',
    ])
    expect(board.totalThings).toBe(3)
  })

  it('drops resolved approvals from the board', () => {
    const board = attentionBoard([
      outbox('approval-open', 'approval.required', {
        payload: { type: 'approval.required', approvalId: 'approval-open' },
      }),
      outbox('approval-done', 'approval.required', {
        payload: { type: 'approval.required', approvalId: 'approval-done' },
      }),
      outbox('approval-resolution', 'approval.resolved', {
        payload: { type: 'approval.resolved', approvalId: 'approval-done' },
      }),
    ])
    expect(board.todo.map(message => message.id)).toEqual(['approval-open'])
  })

  it('groups routine results per task, newest first inside and across groups', () => {
    const board = attentionBoard([
      outbox('count-8', 'run.completed', {
        createdAt: '2026-11-23T00:08:00.000Z',
      }),
      outbox('count-10', 'run.completed', {
        createdAt: '2026-11-23T00:10:00.000Z',
      }),
      outbox('count-9', 'run.completed', {
        createdAt: '2026-11-23T00:09:00.000Z',
        readAt: '2026-11-23T00:11:00.000Z',
      }),
      outbox('backup-result', 'run.completed', {
        taskId: 'task-2',
        createdAt: '2026-11-23T00:11:00.000Z',
      }),
    ])
    expect(board.activity).toHaveLength(2)
    const [first, second] = board.activity
    expect(first?.taskId).toBe('task-2')
    expect(second?.taskId).toBe('task-1')
    expect(second?.messages.map(message => message.id)).toEqual([
      'count-10',
      'count-9',
      'count-8',
    ])
    expect(second?.latest.id).toBe('count-10')
    expect(second?.unreadCount).toBe(2)
    expect(board.totalNotifications).toBe(4)
    expect(board.totalUnread).toBe(3)
    expect(board.totalThings).toBe(2)
  })

  it('groups repeated failures per task but keeps them in the failed section', () => {
    const board = attentionBoard([
      outbox('fail-1', 'run.failed', {
        createdAt: '2026-11-23T00:01:00.000Z',
      }),
      outbox('fail-2', 'run.failed', {
        createdAt: '2026-11-23T00:02:00.000Z',
      }),
      outbox('result-1', 'run.completed'),
    ])
    expect(board.failed).toHaveLength(1)
    expect(board.failed[0]?.messages.map(message => message.id)).toEqual([
      'fail-2',
      'fail-1',
    ])
    expect(board.failed[0]?.unreadCount).toBe(2)
    expect(board.activity).toHaveLength(1)
  })

  it('never merges messages without a task id', () => {
    const board = attentionBoard([
      outbox('loose-1', 'run.completed', { taskId: undefined }),
      outbox('loose-2', 'run.completed', { taskId: undefined }),
      outbox('loose-fail', 'run.failed', { taskId: undefined }),
    ])
    expect(board.activity).toHaveLength(2)
    expect(board.failed).toHaveLength(1)
    expect(board.totalThings).toBe(3)
  })

  it('pages activity groups by task with stable boundaries', () => {
    const groups = attentionBoard(
      Array.from({ length: 45 }, (_, index) =>
        outbox(`result-${String(index)}`, 'run.completed', {
          taskId: `task-${String(index)}`,
          createdAt: new Date(Date.UTC(2026, 10, 23, 0, index)).toISOString(),
        }),
      ),
    ).activity
    const first = attentionActivityPage(groups, 1)
    expect(first.pageCount).toBe(3)
    expect(first.groups).toHaveLength(20)
    expect(first.rangeStart).toBe(1)
    expect(first.rangeEnd).toBe(20)
    expect(first.groups[0]?.taskId).toBe('task-44')
    const last = attentionActivityPage(groups, 3)
    expect(last.groups).toHaveLength(5)
    expect(last.rangeStart).toBe(41)
    expect(last.rangeEnd).toBe(45)
  })

  it('clamps out-of-range pages instead of showing an empty page', () => {
    const groups = attentionBoard([
      outbox('only-result', 'run.completed'),
    ]).activity
    expect(attentionActivityPage(groups, 9).page).toBe(1)
    expect(attentionActivityPage(groups, 0).page).toBe(1)
    const empty = attentionActivityPage([], 4)
    expect(empty.page).toBe(1)
    expect(empty.pageCount).toBe(1)
    expect(empty.groups).toHaveLength(0)
    expect(empty.rangeStart).toBe(0)
    expect(empty.rangeEnd).toBe(0)
  })
})

describe('DESIGN-008 automationActive fact helpers', () => {
  const scheduled: OutboxMessage = {
    id: 'fact-scheduled',
    userId: 'owner',
    taskId: 'task-1',
    payload: {
      type: 'run.completed',
      automationActive: true,
      text: '周期自动化已创建并生效',
    },
    status: 'sent',
    createdAt: '2026-11-23T02:00:00.000Z',
  }
  const finished: OutboxMessage = {
    ...scheduled,
    id: 'fact-finished',
    payload: { type: 'run.completed', text: '已数到 10，自动化已取消。' },
    createdAt: '2026-11-23T02:10:00.000Z',
  }

  it('reads automationActive only from run.completed payloads', () => {
    expect(hasActiveAutomationFact(scheduled.payload)).toBe(true)
    expect(hasActiveAutomationFact(finished.payload)).toBe(false)
    expect(
      hasActiveAutomationFact({
        type: 'agent.message',
        automationActive: true,
        text: '1',
      }),
    ).toBe(false)
    expect(hasActiveAutomationFact('纯文本')).toBe(false)
    expect(hasActiveAutomationFact(undefined)).toBe(false)
  })

  it('lets the newest completion fact win regardless of input order', () => {
    expect(taskAutomationActive([scheduled], 'task-1')).toBe(true)
    expect(taskAutomationActive([scheduled, finished], 'task-1')).toBe(false)
    expect(taskAutomationActive([finished, scheduled], 'task-1')).toBe(false)
    expect(
      taskAutomationActive(
        [{ ...finished, taskId: 'task-2' }, scheduled],
        'task-1',
      ),
    ).toBe(true)
    expect(taskAutomationActive([], 'task-1')).toBe(false)
  })
})

describe('DESIGN-002 work list sort projection', () => {
  const base: WorkChannel = {
    id: 'task-base',
    taskId: 'task-base',
    userId: 'owner',
    originEventId: 'event-base',
    title: '基础事情',
    goal: '目标',
    status: 'started',
    workerIconId: 'computer',
    canResume: false,
    canStop: true,
    createdAt: '2026-11-19T07:00:00.000Z',
    updatedAt: '2026-11-19T08:00:00.000Z',
    latestActivityAt: '2026-11-19T08:00:00.000Z',
  }
  const earlyCreated: WorkChannel = {
    ...base,
    id: 'task-early',
    taskId: 'task-early',
    createdAt: '2026-11-19T06:00:00.000Z',
    updatedAt: '2026-11-19T09:00:00.000Z',
    latestActivityAt: '2026-11-19T09:00:00.000Z',
  }
  const endedLater: WorkChannel = {
    ...base,
    id: 'task-ended',
    taskId: 'task-ended',
    status: 'completed',
    canResume: true,
    canStop: false,
    createdAt: '2026-11-19T06:30:00.000Z',
    updatedAt: '2026-11-19T08:30:00.000Z',
    latestActivityAt: '2026-11-19T08:30:00.000Z',
    endedAt: '2026-11-19T09:30:00.000Z',
    endedKind: 'completed',
  }

  it('orders by activity, creation and end time without mutating input', () => {
    const channels = [endedLater, base, earlyCreated]
    expect(sortWorkChannels(channels, 'updated').map(item => item.id)).toEqual([
      'task-early',
      'task-ended',
      'task-base',
    ])
    expect(sortWorkChannels(channels, 'created').map(item => item.id)).toEqual([
      'task-base',
      'task-ended',
      'task-early',
    ])
    expect(sortWorkChannels(channels, 'ended').map(item => item.id)).toEqual([
      'task-ended',
      'task-early',
      'task-base',
    ])
    expect(channels.map(item => item.id)).toEqual([
      'task-ended',
      'task-base',
      'task-early',
    ])
  })

  it('falls back to updatedAt for unfinished work and breaks ties by id', () => {
    const tie: WorkChannel = { ...base, id: 'task-aaa', taskId: 'task-aaa' }
    expect(sortWorkChannels([base, tie], 'ended').map(item => item.id)).toEqual(
      ['task-base', 'task-aaa'],
    )
    const broken: WorkChannel = {
      ...base,
      id: 'task-broken',
      taskId: 'task-broken',
      latestActivityAt: 'not-a-date',
    }
    expect(
      sortWorkChannels([broken, base], 'updated').map(item => item.id),
    ).toEqual(['task-base', 'task-broken'])
  })
})
