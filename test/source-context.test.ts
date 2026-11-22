import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import {
  deriveTaskSourceContext,
  sourceContextInput,
} from '../src/collaboration/source-context.js'
import type { GoalContractDraft } from '../src/goal/goal-delivery.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function seedTask(
  store: PegasStore,
  text: string,
  userId = 'owner',
): { taskId: string; runId: string; eventId: string } {
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
  }).event
  const claimedEvent = store.claimNextEvent('ctx-router')
  if (!claimedEvent) throw new Error('Expected event claim')
  const created = store.applyRoutingDecision(
    claimedEvent,
    { kind: 'create_task', title: text, goal: text, input: text, reason: 't' },
    'echo-test',
    { executor: 'echo-test' },
  )
  store.completeEvent(event.id, 'ctx-router')
  return {
    taskId: created.task.id,
    runId: created.run.id,
    eventId: event.id,
  }
}

function completeTask(store: PegasStore, runId: string, output: string): void {
  const claimed = store.claimNextRun('ctx-worker')
  if (claimed?.run.id !== runId) throw new Error('Expected run claim')
  store.completeRun(claimed.run.id, 'ctx-worker', {
    executorRef: 'session-ctx',
    output,
  })
}

function goalDraft(eventId: string): GoalContractDraft {
  return {
    basedOnEventIds: [eventId],
    desiredOutcome: 'Deliver the migration report.',
    beneficiaries: ['owner'],
    successCriteria: [
      {
        criterionId: 'criterion-1',
        observableStatement: 'The report is available and verified.',
        required: true,
        evidencePlanRef: 'plan-1',
      },
    ],
    nonGoals: [],
    constraints: [],
    contextSources: [
      {
        sourceRef: eventId,
        freshness: 'current',
        authority: 'user',
        conflictPriority: 0,
      },
    ],
    assumptions: [],
    unknowns: [],
    prerequisites: [],
    permissionBoundary: { externalWrites: false },
    reviewCheckpoints: ['final'],
    evidencePlan: [
      {
        id: 'plan-1',
        criterionId: 'criterion-1',
        acceptedKinds: ['observation', 'screenshot'],
        acceptedTrustClasses: ['control-plane', 'independent', 'user'],
        minimumCount: 1,
        presentation: 'inline',
      },
    ],
    failureAndRecovery: 'Keep the Task open and request valid evidence.',
    feedbackSignals: ['user_acceptance'],
  }
}

async function routeUserMessage(
  store: PegasStore,
  payload: Record<string, unknown>,
): Promise<void> {
  store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload,
  })
  await processNextEvent(
    store,
    new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
    'ctx-router',
    undefined,
    { collectWindowMs: 0 },
  )
}

describe('COLLAB-001 sourceContext derivation', () => {
  it('derives terminal facts from a completed Task without a Review Pack', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, '整理供应商清单')
    store.createArtifact(seeded.taskId, 'owner', 'artifact-1', {
      name: 'suppliers.csv',
      kind: 'dataset',
      revision: '1',
      contentHash: 'a'.repeat(64),
      metadata: {},
      sensitivity: 'private',
      uri: 'pegas://artifacts/suppliers.csv',
    })
    completeTask(store, seeded.runId, '清单已完成：共 12 家供应商。')
    const context = deriveTaskSourceContext(store, seeded.taskId, 'owner')
    expect(context).toMatchObject({
      sourceTaskId: seeded.taskId,
      sourceStatus: 'completed',
      sourceTitle: '整理供应商清单',
    })
    expect(context?.summary).toContain('12 家供应商')
    expect(context?.artifactRefs).toEqual([
      expect.objectContaining({ name: 'suppliers.csv', kind: 'dataset' }),
    ])
    expect(context?.reviewPackId).toBeUndefined()
    store.close()
  })

  it('prefers the latest Review Pack summary, decisions and risks', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, '完成迁移报告')
    const goal = store.createGoalContract(
      seeded.taskId,
      'owner',
      'goal-ctx',
      goalDraft(seeded.eventId),
    )
    const claimed = store.claimNextRun('ctx-worker')
    if (!claimed) throw new Error('Expected run claim')
    store.completeRun(claimed.run.id, 'ctx-worker', {
      executorRef: 'session-ctx',
      output: '迁移完成。',
    })
    const evidence = store.createEvidenceRef(
      claimed.run.id,
      'owner',
      'evidence-ctx',
      {
        goalRevision: goal.revision,
        criterionId: 'criterion-1',
        kind: 'observation',
        producerIdentity: 'worker-1',
        captureMechanism: 'deterministic-check',
        trustClass: 'control-plane',
        observationSnapshot: {
          observedValue: { available: true },
          sourceObjectId: 'report-1',
          sourceVersion: 'v1',
          issuerIdentity: 'control-plane',
          observedAt: '2026-11-20T00:00:00.000Z',
          snapshotHash: 'b'.repeat(64),
        },
        verification: {
          method: 'deterministic-check',
          verifierIdentity: 'pegas-control-plane-verifier',
          verifierVersion: 'v1',
          result: 'passed',
          verifiedAt: '2026-11-20T00:00:00.000Z',
        },
        environment: { target: 'test' },
        presentation: { format: 'summary' },
        sensitivity: 'private',
        limitations: [],
      },
    )
    const result = store.submitWorkerReport(
      claimed.run.id,
      'owner',
      'ctx-worker',
      {
        goalRevision: goal.revision,
        reportSequence: 0,
        status: 'ready',
        evidenceRefIds: [evidence.id],
        summary: '迁移完成并通过校验。',
        limitations: [],
        remainingRisks: ['旧接口将在两周后下线。'],
      },
    )
    expect(result.completed).toBe(true)
    const context = deriveTaskSourceContext(store, seeded.taskId, 'owner')
    expect(context?.reviewPackId).toBe(result.reviewPack?.id)
    expect(context?.summary).toContain('completed')
    expect(context?.summary).toContain('旧接口将在两周后下线')
    expect(context?.keyDecisions.join('\n')).toContain('criterion-1')
    store.close()
  })

  it('returns undefined for open Tasks and foreign owners', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, '还在进行的任务')
    expect(
      deriveTaskSourceContext(store, seeded.taskId, 'owner'),
    ).toBeUndefined()
    completeTask(store, seeded.runId, '完成')
    expect(
      deriveTaskSourceContext(store, seeded.taskId, 'intruder'),
    ).toBeUndefined()
    expect(deriveTaskSourceContext(store, 'missing', 'owner')).toBeUndefined()
    store.close()
  })

  it('supports cancelled sources with their stopped reason', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, '被取消的调研')
    store.stopTask(seeded.taskId, 'owner', 'stop-ctx', '方向调整，不再继续')
    const context = deriveTaskSourceContext(store, seeded.taskId, 'owner')
    expect(context?.sourceStatus).toBe('cancelled')
    expect(context?.summary).toContain('方向调整')
    store.close()
  })
})

describe('COLLAB-001 sourceContext routing', () => {
  it('injects the handoff into the new Task first Run input without touching the source session', async () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, '完成竞品调研')
    completeTask(store, seeded.runId, '调研结论：方案 B 成本最低。')
    const sourceRunsBefore = store.listRuns(seeded.taskId)

    await routeUserMessage(store, {
      text: '基于调研结论做一份实施计划',
      sourceTaskId: seeded.taskId,
    })
    const tasks = store.listTasks('owner')
    expect(tasks).toHaveLength(2)
    const created = tasks.find(task => task.id !== seeded.taskId)
    if (!created) throw new Error('Expected new task')
    const runs = store.listRuns(created.id)
    expect(runs).toHaveLength(1)
    const input = runs[0]?.input ?? ''
    expect(input).toContain('基于调研结论做一份实施计划')
    expect(input).toContain('sourceContext')
    expect(input).toContain(seeded.taskId)
    expect(input).toContain('方案 B 成本最低')
    expect(input).toContain('不构成新授权')
    // No session resume: the new Run has no resume ref from the source.
    expect(runs[0]?.resumeFromRef).toBeUndefined()
    expect(runs[0]?.executorRef).toBeUndefined()
    // Source Task untouched.
    expect(store.listRuns(seeded.taskId)).toEqual(sourceRunsBefore)
    expect(store.findTask(seeded.taskId, 'owner')?.status).toBe('completed')
    // Mandate is minted from the new human input, not the source.
    expect(created.mandate.actor.id).toBe('owner')
    expect(created.mandate.scope).toContain('实施计划')
    store.close()
  })

  it('rejects open or unknown source references instead of silently dropping them', async () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, '仍在进行')
    await routeUserMessage(store, {
      text: '参考它新建',
      sourceTaskId: seeded.taskId,
    })
    const events = store.listEvents('owner')
    const rejected = events.find(
      event =>
        event.id !== seeded.eventId &&
        (event.status === 'failed' || event.status === 'pending'),
    )
    expect(rejected?.lastError).toContain('no terminal facts')
    expect(store.listTasks('owner')).toHaveLength(1)
    store.close()
  })

  it('keeps behavior unchanged for messages without sourceTaskId', async () => {
    const store = new PegasStore(':memory:')
    await routeUserMessage(store, { text: '普通的新任务' })
    const tasks = store.listTasks('owner')
    expect(tasks).toHaveLength(1)
    const runs = store.listRuns(tasks[0]?.id ?? '')
    expect(runs[0]?.input).toBe('普通的新任务')
    expect(runs[0]?.input).not.toContain('sourceContext')
    store.close()
  })

  it('does not expand authority: the handoff never carries source permissions', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, '有权限的旧任务')
    completeTask(store, seeded.runId, '完成')
    const context = deriveTaskSourceContext(store, seeded.taskId, 'owner')
    if (!context) throw new Error('Expected context')
    const rendered = sourceContextInput('新目标', context)
    expect(rendered).not.toContain('permissions')
    expect(rendered).not.toContain('mandate')
    expect(Object.keys(context).sort()).toEqual(
      [
        'artifactRefs',
        'keyDecisions',
        'sourceStatus',
        'sourceTaskId',
        'sourceTitle',
        'summary',
      ].sort(),
    )
    store.close()
  })
})

describe('COLLAB-001 delegate return handoff', () => {
  it('carries the target terminal facts into the source continuation Run', async () => {
    const store = new PegasStore(':memory:')
    const source = seedTask(store, '主任务需要子调研')
    const claimed = store.claimNextRun('source-worker')
    if (!claimed) throw new Error('Expected source claim')
    store.createCollaboration(claimed.run.id, claimed.claimToken, {
      commandId: 'ctx-delegate',
      kind: 'delegate',
      goal: '独立子调研',
      reason: '可并行',
      expectedOutput: '子调研结论',
      contextRefs: [],
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
      'ctx-target-router',
      undefined,
      { collectWindowMs: 0 },
    )
    const target = store.claimNextRun('target-worker')
    if (!target) throw new Error('Expected target claim')
    store.completeRun(target.run.id, 'target-worker', {
      executorRef: 'session-target',
      output: '子调研结论：接口兼容。',
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo-test'),
      'ctx-return-router',
      undefined,
      { collectWindowMs: 0 },
    )
    const runs = store.listRuns(source.taskId)
    const continuation = runs.at(-1)
    expect(continuation?.id).not.toBe(source.runId)
    expect(continuation?.input).toContain('Delegated work returned.')
    expect(continuation?.input).toContain('sourceContext')
    expect(continuation?.input).toContain(target.task.id)
    expect(continuation?.input).toContain('接口兼容')
    store.close()
  })
})

describe('COLLAB-001 sourceContext ingress boundary', () => {
  it('validates sourceTaskId at the API and rejects client-authored facts', async () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, '已结束的旧任务')
    completeTask(store, seeded.runId, '旧任务完成')
    const open = seedTask(store, '仍开放的旧任务')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => store.close(),
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const post = async (payload: Record<string, unknown>) =>
      fetch(`${base}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'owner',
          type: 'user.message',
          source: 'web',
          payload,
        }),
      })

    const accepted = await post({
      text: '基于旧任务新建',
      sourceTaskId: seeded.taskId,
    })
    expect(accepted.status).toBe(202)

    const openSource = await post({
      text: '参考开放任务',
      sourceTaskId: open.taskId,
    })
    expect(openSource.status).toBe(400)

    const forged = await post({
      text: '自带摘要',
      sourceTaskId: seeded.taskId,
      sourceContext: { summary: '客户端伪造的事实' },
    })
    expect(forged.status).toBe(400)

    const combined = await post({
      text: '混合引用',
      taskId: seeded.taskId,
      sourceTaskId: seeded.taskId,
    })
    expect(combined.status).toBe(400)

    const unknown = await post({
      text: '引用不存在的任务',
      sourceTaskId: 'missing-task',
    })
    expect(unknown.status).toBe(400)
  })
})
