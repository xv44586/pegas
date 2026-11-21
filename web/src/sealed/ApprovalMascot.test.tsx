// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Approval, DurableAction } from '../types'
import { DetailDrawer } from './DetailDrawer'

afterEach(cleanup)

function approvalFixture(status: Approval['status']): Approval {
  return {
    id: 'approval-blocked',
    taskId: 'task-1',
    actionId: 'action-1',
    requestRunId: 'run-1',
    status,
    prompt: {
      summary: '发布候选版本',
      impact: '这会把候选版本公开给所有用户。',
      recommendedOptionId: 'reject',
      options: [
        { id: 'approve', label: '发布', kind: 'approve' },
        { id: 'reject', label: '暂不发布', kind: 'reject' },
      ],
    },
    createdAt: '2026-11-20T00:00:00.000Z',
    ...(status === 'pending'
      ? {}
      : {
          resolvedAt: '2026-11-20T01:00:00.000Z',
          decision: {
            id: 'decision-1',
            approvalId: 'approval-blocked',
            eventId: 'event-decision-1',
            commandId: 'command-decision-1',
            userId: 'owner',
            optionId: 'reject',
            kind: 'reject',
            rationale: '先确认回滚开关',
            decidedAt: '2026-11-20T01:00:00.000Z',
          },
        }),
  }
}

function actionFixture(approval: Approval): DurableAction {
  return {
    id: approval.actionId,
    taskId: approval.taskId,
    requestRunId: approval.requestRunId,
    kind: 'publish.release',
    risk: 'high',
    idempotencyKey: 'action-1',
    status: approval.status === 'pending' ? 'awaiting_approval' : 'authorized',
    request: { release: 'v1' },
    recoveryPoint: { step: 'before_publish' },
    createdAt: approval.createdAt,
    updatedAt: approval.resolvedAt ?? approval.createdAt,
  }
}

function renderApproval(approval: Approval) {
  return render(
    <DetailDrawer
      onChange={vi.fn()}
      onClose={vi.fn()}
      onDecideApproval={vi.fn(() => Promise.resolve())}
      onRetry={vi.fn()}
      view={{
        kind: 'approval',
        approval,
        action: actionFixture(approval),
        message: {
          id: 'approval-message',
          userId: 'owner',
          taskId: approval.taskId,
          status: 'sent',
          payload: { type: 'approval.required', approvalId: approval.id },
          createdAt: approval.createdAt,
        },
      }}
    />,
  )
}

describe('approval drawer mascot', () => {
  it('shows the blocked pose while a decision is pending', () => {
    const { container } = renderApproval(approvalFixture('pending'))
    const card = container.querySelector('.approval-card')
    const mascot = card?.querySelector('img[data-pose="blocked"]')
    expect(mascot).toBeTruthy()
    expect(mascot?.getAttribute('aria-label')).toBe('Pegas 等待你的决定')
  })

  it('drops the mascot once the approval is resolved', () => {
    const { container } = renderApproval(approvalFixture('approved'))
    expect(
      container.querySelector('.approval-card img.pegas-mascot'),
    ).toBeNull()
  })
})
