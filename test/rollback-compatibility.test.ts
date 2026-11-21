import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ClaimedRun } from '../src/core/domain.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  assertRollbackCompatible,
  RollbackCompatibilityError,
} from '../src/supervisor/rollback-compatibility.js'

describe('durable state rollback compatibility', () => {
  it('blocks a v17 rollback while collaboration is live and allows it after settlement', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-rollback-'))
    const path = join(directory, 'pegas.sqlite')
    const store = new PegasStore(path)
    try {
      const source = createClaimedTask(store, 'owner', 'Source', 'source')
      const target = createClaimedTask(store, 'owner', 'Target', 'target')
      store.createCollaboration(source.run.id, source.claimToken, {
        commandId: 'rollback-live-note',
        kind: 'context_note',
        targetChannelId: target.task.id,
        text: 'Pending context',
        sourceRefs: [],
      })
      expect(() => assertRollbackCompatible(path, 17)).toThrow(
        RollbackCompatibilityError,
      )
      expect(() => assertRollbackCompatible(path, 19)).not.toThrow()

      store.stopTask(target.task.id, 'owner', 'settle-target')
      expect(() => assertRollbackCompatible(path, 17)).not.toThrow()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('blocks a v19 rollback while an Automation is active and allows it after cancellation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-rollback-'))
    const path = join(directory, 'pegas.sqlite')
    const store = new PegasStore(path)
    try {
      const automation = store.createAutomation({
        userId: 'owner',
        commandId: 'rollback-automation',
        automation: {
          title: 'Future task',
          prompt: 'Run later',
          schedule: { kind: 'once', at: '2030-01-01T00:00:00.000Z' },
          target: { kind: 'new_task' },
        },
      })
      expect(() => assertRollbackCompatible(path, 19)).toThrow(
        RollbackCompatibilityError,
      )
      store.cancelAutomation(automation.id, {
        userId: 'owner',
        commandId: 'cancel-for-rollback',
        expectedRevision: automation.revision,
      })
      expect(() => assertRollbackCompatible(path, 19)).not.toThrow()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('blocks a v20 rollback while Memory exists and allows it after deletion', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-rollback-'))
    const path = join(directory, 'pegas.sqlite')
    const store = new PegasStore(path)
    try {
      const memory = store.createMemory({
        userId: 'owner',
        commandId: 'rollback-memory',
        memory: {
          scope: 'global',
          category: 'preference',
          content: '默认使用中文回复',
          source: { kind: 'user_confirmation' },
        },
      })
      expect(() => assertRollbackCompatible(path, 20)).toThrow(
        RollbackCompatibilityError,
      )
      expect(() => assertRollbackCompatible(path, 21)).not.toThrow()
      store.deleteMemory(memory.id, {
        userId: 'owner',
        commandId: 'delete-for-rollback',
        expectedRevision: memory.revision,
      })
      expect(() => assertRollbackCompatible(path, 20)).not.toThrow()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('blocks a v21 rollback while a Task awaits Goal clarification', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-rollback-'))
    const path = join(directory, 'pegas.sqlite')
    const store = new PegasStore(path)
    try {
      const claimed = createClaimedTask(store, 'owner', '模糊目标', 'goal')
      const draft = clarificationGoalDraft(claimed.run.originEventId ?? '')
      store.proposeGoalFromRun(
        claimed.run.id,
        claimed.claimToken,
        'rollback-clarification',
        draft,
      )
      expect(() => assertRollbackCompatible(path, 21)).toThrow(
        RollbackCompatibilityError,
      )
      expect(() => assertRollbackCompatible(path, 22)).not.toThrow()

      store.stopTask(claimed.task.id, 'owner', 'settle-clarification')
      expect(() => assertRollbackCompatible(path, 21)).not.toThrow()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('blocks a v22 rollback while a reconciled Action outcome exists', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-rollback-'))
    const path = join(directory, 'pegas.sqlite')
    const store = new PegasStore(path)
    try {
      const claimed = createClaimedTask(store, 'owner', '发布', 'reconcile')
      const requested = store.requestApproval(
        claimed.run.id,
        claimed.claimToken,
        {
          kind: 'publish.release',
          risk: 'high',
          idempotencyKey: 'rollback-reconcile-publish',
          request: { release: 'v1' },
          recoveryPoint: { step: 'before_publish' },
          approval: {
            summary: '发布 v1',
            impact: '对外可见',
            recommendedOptionId: 'approve',
            options: [
              { id: 'approve', label: '发布', kind: 'approve' },
              { id: 'reject', label: '不发布', kind: 'reject' },
            ],
          },
        },
      )
      store.decideApproval(requested.approval.id, 'owner', {
        commandId: 'rollback-reconcile-approve',
        optionId: 'approve',
      })
      const resumed = store.claimNextRun('reconcile-resumed')
      if (!resumed) throw new Error('Expected resumed Run')
      store.recordActionOutcome(requested.action.id, resumed.claimToken, {
        commandId: 'rollback-reconcile-outcome',
        status: 'unknown',
        result: { providerRequestId: 'request-1' },
      })
      // An unreconciled unknown outcome is representable in v22.
      expect(() => assertRollbackCompatible(path, 22)).not.toThrow()
      store.reconcileAction(requested.action.id, 'owner', {
        commandId: 'rollback-reconcile-command',
        resolution: 'succeeded',
        note: '人工确认成功',
      })
      expect(() => assertRollbackCompatible(path, 22)).toThrow(
        RollbackCompatibilityError,
      )
      expect(() => assertRollbackCompatible(path, 23)).not.toThrow()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function clarificationGoalDraft(
  eventId: string,
): import('../src/goal/goal-delivery.js').GoalContractDraft {
  return {
    basedOnEventIds: [eventId],
    desiredOutcome: '澄清后的结果',
    beneficiaries: ['owner'],
    successCriteria: [
      {
        criterionId: 'result',
        observableStatement: '结果可见且可验证',
        required: true,
        evidencePlanRef: 'plan-result',
      },
    ],
    nonGoals: [],
    constraints: [],
    contextSources: [],
    assumptions: [],
    unknowns: [{ question: '交付到哪里？', blocking: true }],
    prerequisites: [],
    permissionBoundary: { externalWrites: false },
    reviewCheckpoints: ['final'],
    evidencePlan: [
      {
        id: 'plan-result',
        criterionId: 'result',
        acceptedKinds: ['observation'],
        acceptedTrustClasses: ['control-plane', 'user'],
        minimumCount: 1,
        presentation: 'inline',
      },
    ],
    failureAndRecovery: '等待用户澄清',
    feedbackSignals: ['user_acceptance'],
  }
}

function createClaimedTask(
  store: PegasStore,
  userId: string,
  text: string,
  workerId: string,
): ClaimedRun {
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'web',
    payload: { text },
  }).event
  const claimedEvent = store.claimNextEvent(`${workerId}-router`)
  if (claimedEvent?.id !== event.id) throw new Error('Expected Event claim')
  store.applyRoutingDecision(
    claimedEvent,
    {
      kind: 'create_task',
      title: text,
      goal: text,
      input: text,
      reason: 'test setup',
    },
    'echo',
  )
  store.completeEvent(event.id, `${workerId}-router`)
  const claimed = store.claimNextRun(workerId)
  if (!claimed) throw new Error('Expected Run claim')
  return claimed
}
