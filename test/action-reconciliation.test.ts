import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { parseActionReconciliationDraft } from '../src/approval/approval.js'
import { createControlPlane } from '../src/control-plane/server.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('APPROVAL-001 human action reconciliation', () => {
  it('parses only succeeded/failed resolutions with a bounded note', () => {
    expect(
      parseActionReconciliationDraft({
        commandId: 'reconcile-1',
        resolution: 'succeeded',
        note: '已在供应商后台确认发布成功',
      }),
    ).toEqual({
      commandId: 'reconcile-1',
      resolution: 'succeeded',
      note: '已在供应商后台确认发布成功',
    })
    expect(() =>
      parseActionReconciliationDraft({
        commandId: 'reconcile-1',
        resolution: 'unknown',
        note: 'x',
      }),
    ).toThrow(/resolution must be succeeded or failed/)
    expect(() =>
      parseActionReconciliationDraft({
        commandId: 'reconcile-1',
        resolution: 'failed',
        note: ' ',
      }),
    ).toThrow(/note is required/)
    expect(() =>
      parseActionReconciliationDraft({
        commandId: 'reconcile-1',
        resolution: 'failed',
        note: 'x'.repeat(2001),
      }),
    ).toThrow(/at most 2000/)
  })

  it('reconciles an unknown outcome as succeeded and unblocks continuation', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const blocked = createBlockedAction(store, 'unknown')

    const parked = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '继续推进', taskId: blocked.taskId },
    }).event
    expect(() =>
      store.applyRoutingDecision(
        parked,
        {
          kind: 'continue_task',
          taskId: blocked.taskId,
          input: '继续推进',
          reason: 'blocked continuation',
        },
        'echo',
      ),
    ).toThrow(/cannot continue/)

    const reconciled = store.reconcileAction(blocked.actionId, 'owner', {
      commandId: 'reconcile-unknown-success',
      resolution: 'succeeded',
      note: '供应商后台确认请求已成功落地',
    })

    expect(reconciled).toMatchObject({
      status: 'reconciled',
      reconciliation: {
        resolution: 'succeeded',
        previousStatus: 'unknown',
        note: '供应商后台确认请求已成功落地',
        reconciledBy: 'owner',
      },
    })
    expect(reconciled.reconciliation?.previousResult).toEqual({
      providerRequestId: 'request-unknown',
    })
    expect(store.findTask(blocked.taskId, 'owner')).toMatchObject({
      statusReason: 'action_reconciled',
    })
    expect(store.listOutbox('owner').at(-1)?.payload).toMatchObject({
      type: 'action.reconciled',
      actionId: blocked.actionId,
      resolution: 'succeeded',
    })

    // Continuation is allowed again and creates a new Run.
    const continued = store.applyRoutingDecision(
      parked,
      {
        kind: 'continue_task',
        taskId: blocked.taskId,
        input: '继续推进',
        reason: 'after reconciliation',
      },
      'echo',
    )
    expect(continued.run.status).toBe('queued')
  })

  it('keeps failed resolutions blocking retry, Goal revision and collaboration', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const blocked = createBlockedAction(store, 'failed')
    store.failRun(blocked.resumeRunId, 'worker-resumed', 'executor crashed')

    store.reconcileAction(blocked.actionId, 'owner', {
      commandId: 'reconcile-failed',
      resolution: 'failed',
      note: '供应商确认没有产生任何外部变更',
    })

    expect(() => store.retryRun(blocked.resumeRunId, 'owner')).toThrow(
      /human-confirmed failed Action blocks retrying/,
    )
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '换个目标', taskId: blocked.taskId },
    }).event
    expect(() =>
      store.applyRoutingDecision(
        event,
        {
          kind: 'continue_task',
          taskId: blocked.taskId,
          input: '换个目标',
          reason: 'goal change attempt',
        },
        'echo',
      ),
    ).not.toThrow()
    const claimed = store.claimNextRun('worker-after-failed-reconcile')
    if (!claimed) throw new Error('Expected a claimed Run')
    expect(() =>
      store.proposeGoalFromRun(claimed.run.id, claimed.claimToken, 'g-failed', {
        ...minimalGoalDraft(blocked.originEventId),
      }),
    ).toThrow(/human-confirmed failed Action/)
    expect(() =>
      store.createCollaboration(claimed.run.id, claimed.claimToken, {
        commandId: 'collab-after-failed',
        kind: 'context_note',
        targetChannelId: blocked.taskId,
        text: 'note',
        sourceRefs: [],
      }),
    ).toThrow()
  })

  it('allows retry after a succeeded reconciliation of a failed Run', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const blocked = createBlockedAction(store, 'unknown')
    store.failRun(blocked.resumeRunId, 'worker-resumed', 'executor crashed')
    expect(() => store.retryRun(blocked.resumeRunId, 'owner')).toThrow(
      /reconciled before retrying/,
    )

    store.reconcileAction(blocked.actionId, 'owner', {
      commandId: 'reconcile-before-retry',
      resolution: 'succeeded',
      note: '外部系统确认副作用已经成功',
    })

    const retry = store.retryRun(blocked.resumeRunId, 'owner')
    expect(retry.status).toBe('queued')
    expect(store.retryRun(blocked.resumeRunId, 'owner').id).toBe(retry.id)
  })

  it('replays the same command, rejects conflicts and second reconciliations', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const blocked = createBlockedAction(store, 'unknown')
    const draft = {
      commandId: 'reconcile-replay',
      resolution: 'succeeded' as const,
      note: '确认成功',
    }
    const first = store.reconcileAction(blocked.actionId, 'owner', draft)
    expect(store.reconcileAction(blocked.actionId, 'owner', draft)).toEqual(
      first,
    )
    expect(() =>
      store.reconcileAction(blocked.actionId, 'owner', {
        ...draft,
        resolution: 'failed',
      }),
    ).toThrow(/different payload/)
    expect(() =>
      store.reconcileAction(blocked.actionId, 'owner', {
        commandId: 'second-reconciliation',
        resolution: 'failed',
        note: '想覆盖第一次结论',
      }),
    ).toThrow(/already has a reconciliation record/)
    // The immutable record keeps the first resolution.
    expect(store.getAction(blocked.actionId, 'owner')).toMatchObject({
      status: 'reconciled',
      reconciliation: { resolution: 'succeeded' },
    })
  })

  it('rejects cross-owner access, missing Actions and non-blocked statuses', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const blocked = createBlockedAction(store, 'unknown')
    expect(() =>
      store.reconcileAction(blocked.actionId, 'intruder', {
        commandId: 'intruder-reconcile',
        resolution: 'succeeded',
        note: 'x',
      }),
    ).toThrow(/not found/)
    expect(() =>
      store.reconcileAction('missing-action', 'owner', {
        commandId: 'missing-reconcile',
        resolution: 'succeeded',
        note: 'x',
      }),
    ).toThrow(/not found/)

    // An authorized (not yet failed/unknown) Action cannot be reconciled.
    const other = createAuthorizedAction(store)
    expect(() =>
      store.reconcileAction(other.actionId, 'owner', {
        commandId: 'too-early',
        resolution: 'succeeded',
        note: 'x',
      }),
    ).toThrow(/Only a failed or unknown Action/)
  })

  it('serves owner-authenticated reconciliation over HTTP with replay and 409', async () => {
    const store = new PegasStore(':memory:')
    const blocked = createBlockedAction(store, 'unknown')
    const server = createControlPlane({ store, apiToken: 'owner-token' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => store.close(),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const url = `${base}/v1/actions/${blocked.actionId}/reconcile`
    const body = JSON.stringify({
      userId: 'owner',
      commandId: 'http-reconcile',
      resolution: 'succeeded',
      note: '人工核对成功',
    })

    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(401)

    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer owner-token',
    }
    const created = await fetch(url, { method: 'POST', headers, body })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as {
      action: { status: string }
    }
    expect(createdBody.action.status).toBe('reconciled')

    const replay = await fetch(url, { method: 'POST', headers, body })
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(createdBody)

    const conflict = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userId: 'owner',
        commandId: 'http-reconcile',
        resolution: 'failed',
        note: '不同的结论',
      }),
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      error: 'action_reconciliation_conflict',
    })

    const intruder = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userId: 'intruder',
        commandId: 'http-reconcile',
        resolution: 'succeeded',
        note: '人工核对成功',
      }),
    })
    expect(intruder.status).toBe(404)

    const read = await fetch(
      `${base}/v1/actions/${blocked.actionId}?userId=owner`,
      { headers },
    )
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({
      action: {
        status: 'reconciled',
        reconciliation: { resolution: 'succeeded', note: '人工核对成功' },
      },
    })
  })

  it('counts a succeeded reconciliation towards Review Pack side effects', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const blocked = createBlockedAction(store, 'unknown')
    store.reconcileAction(blocked.actionId, 'owner', {
      commandId: 'reconcile-for-review',
      resolution: 'succeeded',
      note: '确认发布成功',
    })
    const goal = store.createGoalContract(
      blocked.taskId,
      'owner',
      'goal-after-reconcile',
      minimalGoalDraft(blocked.originEventId),
    )
    // The resumed Run can now finish its report; evidence is still required.
    store.completeRun(blocked.resumeRunId, 'worker-resumed', {
      executorRef: 'session-reconciled',
      output: '外部动作已确认成功。',
    })
    const evidence = store.createEvidenceRef(
      blocked.resumeRunId,
      'owner',
      'evidence-after-reconcile',
      {
        goalRevision: goal.revision,
        criterionId: 'result',
        kind: 'observation',
        producerIdentity: 'worker-resumed',
        captureMechanism: 'deterministic-check',
        trustClass: 'control-plane',
        observationSnapshot: {
          observedValue: { published: true },
          sourceObjectId: 'release-1',
          issuerIdentity: 'control-plane',
          observedAt: '2026-11-21T00:00:00.000Z',
          snapshotHash: 'c'.repeat(64),
        },
        verification: {
          method: 'deterministic-check',
          verifierIdentity: 'control-plane',
          verifierVersion: 'v1',
          result: 'passed',
          verifiedAt: '2026-11-21T00:00:00.000Z',
        },
        environment: {},
        presentation: {},
        sensitivity: 'private',
        limitations: [],
      },
    )
    const result = store.submitWorkerReport(
      blocked.resumeRunId,
      'owner',
      'worker-resumed',
      {
        goalRevision: goal.revision,
        reportSequence: 0,
        status: 'ready',
        evidenceRefIds: [evidence.id],
        summary: '已确认成功的交付。',
        limitations: [],
        remainingRisks: [],
      },
    )
    expect(result.completed).toBe(true)
    const sideEffect = result.reviewPack?.sideEffects.find(
      effect => effect.actionId === blocked.actionId,
    )
    expect(sideEffect).toMatchObject({
      status: 'reconciled',
      reconciliation: { resolution: 'succeeded' },
    })
    expect(store.findTask(blocked.taskId, 'owner')?.status).toBe('completed')
  })
})

function createBlockedAction(
  store: PegasStore,
  outcome: 'failed' | 'unknown',
): {
  taskId: string
  actionId: string
  resumeRunId: string
  originEventId: string
} {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: '发布版本' },
  }).event
  const created = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: '发布版本',
      goal: '发布版本',
      input: '发布版本',
      reason: 'reconciliation test',
    },
    'echo',
  )
  const claimed = store.claimNextRun('worker-request')
  if (!claimed) throw new Error('Expected a claimed Run')
  const requested = store.requestApproval(claimed.run.id, claimed.claimToken, {
    kind: 'publish.release',
    risk: 'high',
    idempotencyKey: `publish-${outcome}-${created.task.id}`,
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
  })
  store.decideApproval(requested.approval.id, 'owner', {
    commandId: `approve-${created.task.id}`,
    optionId: 'approve',
  })
  const resumed = store.claimNextRun('worker-resumed')
  if (!resumed) throw new Error('Expected resumed Run')
  store.recordActionOutcome(requested.action.id, resumed.claimToken, {
    commandId: `outcome-${created.task.id}`,
    status: outcome,
    result:
      outcome === 'unknown'
        ? { providerRequestId: 'request-unknown' }
        : { providerError: 'rejected' },
  })
  return {
    taskId: created.task.id,
    actionId: requested.action.id,
    resumeRunId: resumed.run.id,
    originEventId: event.id,
  }
}

function createAuthorizedAction(store: PegasStore): { actionId: string } {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: '另一个发布' },
  }).event
  store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: '另一个发布',
      goal: '另一个发布',
      input: '另一个发布',
      reason: 'authorized test',
    },
    'echo',
  )
  const claimed = store.claimNextRun('worker-authorized')
  if (!claimed) throw new Error('Expected a claimed Run')
  const requested = store.requestApproval(claimed.run.id, claimed.claimToken, {
    kind: 'publish.release',
    risk: 'high',
    idempotencyKey: 'publish-authorized',
    request: { release: 'v2' },
    recoveryPoint: { step: 'before_publish' },
    approval: {
      summary: '发布 v2',
      impact: '对外可见',
      recommendedOptionId: 'approve',
      options: [
        { id: 'approve', label: '发布', kind: 'approve' },
        { id: 'reject', label: '不发布', kind: 'reject' },
      ],
    },
  })
  store.decideApproval(requested.approval.id, 'owner', {
    commandId: 'approve-authorized',
    optionId: 'approve',
  })
  return { actionId: requested.action.id }
}

function minimalGoalDraft(
  eventId: string,
): import('../src/goal/goal-delivery.js').GoalContractDraft {
  return {
    basedOnEventIds: [eventId],
    desiredOutcome: '发布并验证',
    beneficiaries: ['owner'],
    successCriteria: [
      {
        criterionId: 'result',
        observableStatement: '发布结果可见且验证通过',
        required: true,
        evidencePlanRef: 'plan-result',
      },
    ],
    nonGoals: [],
    constraints: [],
    contextSources: [],
    assumptions: [],
    unknowns: [],
    prerequisites: [],
    permissionBoundary: { externalWrites: true },
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
    failureAndRecovery: '保持 Task 开放并要求有效证据',
    feedbackSignals: ['user_acceptance'],
  }
}
