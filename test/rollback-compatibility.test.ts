import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ClaimedRun } from '../src/core/domain.js'
import { loadConfig } from '../src/core/config.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
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

  it('blocks a pre-v32 rollback while conversation Runs are active', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-rollback-chat-'))
    const path = join(directory, 'pegas.sqlite')
    const store = new PegasStore(path)
    try {
      store.initializeRuntimeSettings({
        ...runtimeSettingsDefaults(loadConfig({})),
        chatLaneEnabled: true,
      })
      const event = store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: { text: '今天星期几' },
      }).event
      const claimedEvent = store.claimNextEvent('chat-router')
      if (!claimedEvent) throw new Error('Expected Event claim')
      store.applyRoutingDecision(
        claimedEvent,
        { kind: 'reply', input: '今天星期几', reason: 'casual' },
        'echo',
        {
          executor: 'echo',
          protocol: 'conversation-v1',
          permissions: JSON.stringify({
            mode: 'read-only',
            approvalPolicy: 'never',
            additionalDirectories: [],
            privacyMode: 'disabled',
          }),
        },
      )
      store.completeEvent(event.id, 'chat-router')
      expect(() => assertRollbackCompatible(path, 31)).toThrow(
        RollbackCompatibilityError,
      )
      expect(() => assertRollbackCompatible(path, 32)).not.toThrow()

      const claimed = store.claimNextRun(
        'chat-worker',
        30_000,
        undefined,
        'conversation',
      )
      if (!claimed) throw new Error('Expected conversation Run claim')
      store.completeRun(claimed.run.id, 'chat-worker', {
        executorRef: 'chat-session',
        output: '星期六',
      })
      expect(() => assertRollbackCompatible(path, 31)).not.toThrow()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('allows a pre-v40 rollback with routing rules present because v40 is additive', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-rollback-routing-'))
    const path = join(directory, 'pegas.sqlite')
    const store = new PegasStore(path)
    try {
      store.createRoutingRule({
        userId: 'owner',
        commandId: 'rollback-routing-rule',
        rule: {
          title: '提到 X 项目优先进 X 事情',
          content: '消息提到 X 项目时，优先归入标题含 X 的开放事情。',
          enabled: true,
        },
      })
      expect(() => assertRollbackCompatible(path, 39)).not.toThrow()
      expect(() => assertRollbackCompatible(path, 40)).not.toThrow()
      const event = store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: { text: 'X 项目新想法' },
      }).event
      store.applyRoutingDecision(
        event,
        {
          kind: 'create_task',
          title: 'X 项目新想法',
          goal: 'X 项目新想法',
          input: 'X 项目新想法',
          reason: 'matches rule',
          matchedRuleId: 'rule-x',
        },
        'echo',
      )
      expect(() => assertRollbackCompatible(path, 40)).not.toThrow()
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
