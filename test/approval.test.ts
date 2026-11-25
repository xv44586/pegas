import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { describe, expect, it, vi } from 'vitest'

import {
  approvalRequired,
  parseActionRequestDraft,
  parseActionOutcomeDraft,
  parseApprovalDecisionDraft,
  type ActionRequestDraft,
} from '../src/approval/approval.js'
import { createControlPlane } from '../src/control-plane/server.js'
import type { InboxEvent } from '../src/core/domain.js'
import { DshCliExecutor } from '../src/executor/dsh-cli-executor.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

describe('durable approval', () => {
  it('requires structured approval only for high-risk actions', () => {
    expect(approvalRequired('low')).toBe(false)
    expect(approvalRequired('medium')).toBe(false)
    expect(approvalRequired('high')).toBe(true)
    expect(approvalRequired('critical')).toBe(true)
    expect(() =>
      parseActionRequestDraft({
        ...approvalDraft(),
        risk: 'medium',
      }),
    ).toThrow(/only required for high or critical/)
    expect(() =>
      parseActionRequestDraft({
        ...approvalDraft(),
        approval: {
          ...approvalDraft().approval,
          recommendedOptionId: 'missing',
        },
      }),
    ).toThrow(/Recommended option/)
  })

  it('rejects malformed decision and Action outcome payloads', () => {
    for (const value of [
      null,
      [],
      {},
      { commandId: ' ', optionId: 'approve' },
    ]) {
      expect(() => parseApprovalDecisionDraft(value)).toThrow()
    }
    expect(() =>
      parseApprovalDecisionDraft({
        commandId: 'decision',
        optionId: 'approve',
        rationale: ' ',
      }),
    ).toThrow(/rationale/)
    for (const value of [
      null,
      [],
      {},
      { commandId: 'outcome', status: 'maybe', result: {} },
      { commandId: 'outcome', status: 'failed', result: [] },
    ]) {
      expect(() => parseActionOutcomeDraft(value)).toThrow()
    }
  })

  it('releases the Worker while preserving a restart-safe pending approval', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-approval-'))
    const path = join(directory, 'pegas.sqlite')
    try {
      let store = new PegasStore(path)
      const first = createClaimedRun(store, 'user-1', 'worker-1', 'first task')
      createClaimedRun(store, 'user-1', 'worker-2', 'second task', false)
      store.recordExecutorRef(
        first.run.id,
        'worker-1',
        'session-before-approval',
      )

      const requested = store.requestApproval(
        first.run.id,
        first.claimToken,
        approvalDraft(),
      )

      expect(requested).toMatchObject({
        action: { status: 'awaiting_approval', risk: 'high' },
        approval: { status: 'pending', requestRunId: first.run.id },
      })
      const waitingRun = store.listRuns(first.task.id)[0]
      expect(waitingRun).toMatchObject({ status: 'waiting' })
      expect(waitingRun).not.toHaveProperty('claimedBy')
      expect(waitingRun).not.toHaveProperty('leaseUntil')
      expect(store.findTask(first.task.id, 'user-1')).toMatchObject({
        status: 'started',
        statusReason: 'awaiting_approval',
      })
      expect(store.listOutbox('user-1')).toMatchObject([
        {
          payload: {
            type: 'approval.required',
            approvalId: requested.approval.id,
          },
        },
      ])
      expect(store.claimNextRun('available-worker')?.task.title).toBe(
        'second task',
      )
      store.close()

      store = new PegasStore(path)
      expect(store.getApproval(requested.approval.id, 'user-1')).toMatchObject({
        id: requested.approval.id,
        status: 'pending',
      })
      expect(store.claimNextRun('worker-after-restart')).toBeUndefined()
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('records the decision as an Inbox event and resumes exactly once', async () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'user-1', 'worker-1', 'publish')
    store.recordExecutorRef(claimed.run.id, 'worker-1', 'session-approval')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft(),
    )

    const decided = store.decideApproval(requested.approval.id, 'user-1', {
      commandId: 'decision-command-1',
      optionId: 'approve',
      rationale: 'Ship it',
    })
    expect(decided).toMatchObject({
      approval: { status: 'approved' },
      decision: { kind: 'approve' },
      event: { type: 'approval.decided', status: 'pending' },
    })
    expect(decided.decision.appliedAt).toBeTypeOf('string')
    expect(
      store.decideApproval(requested.approval.id, 'user-1', {
        commandId: 'replacement-command-after-response-loss',
        optionId: 'approve',
        rationale: 'Ship it',
      }).decision.id,
    ).toBe(decided.decision.id)
    expect(store.listRuns(claimed.task.id)).toHaveLength(2)

    expect(
      await processNextEvent(
        store,
        { handle: async () => Promise.resolve() },
        'event-worker',
      ),
    ).toBe(true)
    const successor = store.listRuns(claimed.task.id)[1]
    expect(successor).toMatchObject({
      retryOfRunId: claimed.run.id,
      status: 'queued',
      resumeFromRef: 'session-approval',
    })
    expect(store.applyApprovalDecision(decided.event)?.id).toBe(successor?.id)
    expect(store.listEvents('user-1').at(-1)?.status).toBe('processed')
    expect(store.listRuns(claimed.task.id)).toHaveLength(2)
    const resolvedApproval = store.getApproval(requested.approval.id, 'user-1')
    expect(resolvedApproval).toMatchObject({
      status: 'approved',
      decision: { kind: 'approve' },
    })
    expect(resolvedApproval?.decision?.appliedAt).toBeTypeOf('string')

    const resumed = store.claimNextRun('worker-resumed')
    expect(resumed?.run.id).toBe(successor?.id)
    if (!resumed) throw new Error('Expected resumed Run')
    const action = store.recordActionOutcome(
      requested.action.id,
      resumed.claimToken,
      {
        commandId: 'outcome-command-1',
        status: 'unknown',
        result: { reason: 'provider timed out after submission' },
      },
    )
    expect(action).toMatchObject({
      status: 'unknown',
      result: { reason: 'provider timed out after submission' },
    })
    expect(
      store.recordActionOutcome(requested.action.id, resumed.claimToken, {
        commandId: 'outcome-command-1',
        status: 'unknown',
        result: { reason: 'provider timed out after submission' },
      }),
    ).toMatchObject({ status: 'unknown' })
    expect(() =>
      store.recordActionOutcome(requested.action.id, 'wrong-token', {
        commandId: 'outcome-command-1',
        status: 'unknown',
        result: { reason: 'provider timed out after submission' },
      }),
    ).toThrow(/claim capability/)
    expect(
      store.requestApproval(
        claimed.run.id,
        claimed.claimToken,
        approvalDraft(),
      ),
    ).toEqual(requested)
    store.close()
  })

  it('replays a pending decision through the real handler after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-approval-replay-'))
    const path = join(directory, 'pegas.sqlite')
    try {
      let store = new PegasStore(path)
      const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
      const requested = store.requestApproval(
        claimed.run.id,
        claimed.claimToken,
        approvalDraft(),
      )
      store.decideApproval(requested.approval.id, 'owner', {
        commandId: 'restart-decision',
        optionId: 'approve',
      })
      expect(store.listRuns(claimed.task.id)).toHaveLength(2)
      store.close()

      store = new PegasStore(path)
      const route = vi.fn()
      expect(
        await processNextEvent(
          store,
          new RoutingEventHandler({ route }, 'echo'),
          'restarted-worker',
        ),
      ).toBe(true)
      expect(route).not.toHaveBeenCalled()
      expect(store.listRuns(claimed.task.id)).toHaveLength(2)
      expect(store.listEvents('owner').at(-1)?.status).toBe('processed')
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['approve', 'approved', true],
    ['reject', 'rejected', false],
    ['revise', 'revision_requested', false],
  ] as const)(
    'applies %s without confusing authorization with Action completion',
    (optionId, approvalStatus, outcomeAllowed) => {
      const store = new PegasStore(':memory:')
      const claimed = createClaimedRun(store, 'owner', 'worker-1', optionId)
      const draft = approvalDraft()
      draft.idempotencyKey = `decision-${optionId}`
      const requested = store.requestApproval(
        claimed.run.id,
        claimed.claimToken,
        draft,
      )
      store.decideApproval(requested.approval.id, 'owner', {
        commandId: `command-${optionId}`,
        optionId,
      })
      expect(store.getApproval(requested.approval.id, 'owner')?.status).toBe(
        approvalStatus,
      )
      expect(store.getAction(requested.action.id, 'owner')?.status).toBe(
        outcomeAllowed ? 'authorized' : 'rejected',
      )
      const resumed = store.claimNextRun(`worker-${optionId}`)
      if (!resumed) throw new Error('Expected successor Run')
      const record = () =>
        store.recordActionOutcome(requested.action.id, resumed.claimToken, {
          commandId: `outcome-${optionId}`,
          status: 'succeeded',
          result: { ok: true },
        })
      if (outcomeAllowed)
        expect(record()).toMatchObject({ status: 'succeeded' })
      else expect(record).toThrow(/authorized Action/)
      store.close()
    },
  )

  it('marks a missing Action outcome unknown instead of completing the Task', () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft(),
    )
    store.decideApproval(requested.approval.id, 'owner', {
      commandId: 'approve-without-outcome',
      optionId: 'approve',
    })
    const resumed = store.claimNextRun('worker-resumed')
    if (!resumed) throw new Error('Expected resumed Run')

    store.completeRun(resumed.run.id, 'worker-resumed', {
      executorRef: 'session-after-action',
      output: 'Executor returned without recording the Action outcome.',
    })

    expect(store.getAction(requested.action.id, 'owner')).toMatchObject({
      status: 'unknown',
      result: { reason: 'executor_completed_without_outcome' },
    })
    expect(store.findTask(claimed.task.id, 'owner')).toMatchObject({
      status: 'started',
      statusReason: 'action_outcome_unknown',
    })
    expect(store.listRuns(claimed.task.id).at(-1)).toMatchObject({
      status: 'waiting',
    })
    expect(store.listOutbox('owner').at(-1)?.payload).toMatchObject({
      type: 'action.outcome_unknown',
      actionId: requested.action.id,
    })
    store.close()
  })

  it('does not let an ordinary continuation bypass an unknown Action outcome', () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft(),
    )
    store.decideApproval(requested.approval.id, 'owner', {
      commandId: 'approve-before-unknown-continuation',
      optionId: 'approve',
    })
    const resumed = store.claimNextRun('worker-resumed')
    if (!resumed) throw new Error('Expected resumed Run')
    store.recordActionOutcome(requested.action.id, resumed.claimToken, {
      commandId: 'unknown-before-continuation',
      status: 'unknown',
      result: { reason: 'provider response lost' },
    })
    store.completeRun(resumed.run.id, 'worker-resumed', {
      executorRef: 'session-after-unknown',
      output: 'Action outcome remains unknown.',
    })

    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'test',
      payload: { text: 'Continue with unrelated analysis.' },
    }).event
    expect(() =>
      store.applyRoutingDecision(
        event,
        {
          kind: 'continue_task',
          taskId: claimed.task.id,
          input: 'Continue with unrelated analysis.',
          reason: 'test unresolved Action fence',
        },
        'echo',
      ),
    ).toThrow(/Action status is unknown/)
    expect(store.findTask(claimed.task.id, 'owner')).toMatchObject({
      statusReason: 'action_outcome_unknown',
    })
    expect(store.listRuns(claimed.task.id)).toHaveLength(2)
    expect(store.claimNextRun('worker-continuation')).toBeUndefined()
    expect(store.getAction(requested.action.id, 'owner')).toMatchObject({
      status: 'unknown',
      result: { reason: 'provider response lost' },
    })
    store.close()
  })

  it('does not let a continuation resume an Executor around pending approval', () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
    store.recordExecutorRef(claimed.run.id, 'worker-1', 'session-before-pause')
    store.requestApproval(claimed.run.id, claimed.claimToken, approvalDraft())
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'test',
      payload: { text: 'Continue anyway.' },
    }).event

    expect(() =>
      store.applyRoutingDecision(
        event,
        {
          kind: 'continue_task',
          taskId: claimed.task.id,
          input: 'Continue anyway.',
          reason: 'test pending Approval fence',
        },
        'echo',
        { executor: 'echo' },
      ),
    ).toThrow(/Action status is awaiting_approval/)
    expect(store.listRuns(claimed.task.id)).toHaveLength(1)
    expect(store.claimNextRun('worker-bypass')).toBeUndefined()
    store.close()
  })

  it('parks a blocked continuation and replays it after rejection', async () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft(),
    )
    const continuation = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'test',
      payload: { text: 'Use a safer alternative.' },
    }).event
    const route = vi.fn(() =>
      Promise.resolve({
        kind: 'continue_task' as const,
        taskId: claimed.task.id,
        input: 'Use a safer alternative.',
        reason: 'test parked continuation',
      }),
    )
    const handler = new RoutingEventHandler({ route }, 'echo')

    expect(await processNextEvent(store, handler, 'event-worker')).toBe(true)
    expect(
      store.listEvents('owner').find(event => event.id === continuation.id),
    ).toMatchObject({
      status: 'processing',
      attempts: 1,
      lastError: 'blocked_by_action:awaiting_approval',
    })
    expect(store.listRuns(claimed.task.id)).toHaveLength(1)

    store.decideApproval(requested.approval.id, 'owner', {
      commandId: 'reject-before-parked-replay',
      optionId: 'reject',
    })
    expect(
      store.listEvents('owner').find(event => event.id === continuation.id),
    ).toMatchObject({ status: 'pending', attempts: 1 })

    expect(await processNextEvent(store, handler, 'event-worker')).toBe(true)
    expect(
      store.listEvents('owner').find(event => event.id === continuation.id),
    ).toMatchObject({ status: 'processed', attempts: 2 })
    expect(store.listRuns(claimed.task.id)).toHaveLength(2)
    expect(store.listRuns(claimed.task.id).at(-1)).toMatchObject({
      status: 'queued',
    })
    expect(store.listRuns(claimed.task.id).at(-1)?.input).toContain(
      'Use a safer alternative.',
    )
    store.close()
  })

  it('atomically releases a continuation when approval resolves before parking', () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft(),
    )
    const continuation = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'test',
      payload: { text: 'Use a safer alternative.' },
    }).event
    expect(store.claimNextEvent('event-worker')?.id).toBe(continuation.id)

    store.decideApproval(requested.approval.id, 'owner', {
      commandId: 'reject-before-atomic-park',
      optionId: 'reject',
    })

    expect(
      store.parkEventForBlockedAction(
        continuation.id,
        'event-worker',
        claimed.task.id,
      ),
    ).toBe('released')
    expect(
      store.listEvents('owner').find(event => event.id === continuation.id),
    ).toMatchObject({ status: 'pending', attempts: 1 })
    store.close()
  })

  it('atomically fails a continuation when its Task stops before parking', () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
    store.requestApproval(claimed.run.id, claimed.claimToken, approvalDraft())
    const continuation = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'test',
      payload: { text: 'Continue.' },
    }).event
    expect(store.claimNextEvent('event-worker')?.id).toBe(continuation.id)

    store.stopTask(
      claimed.task.id,
      'owner',
      'stop-before-atomic-park',
      'Stop now',
    )

    expect(
      store.parkEventForBlockedAction(
        continuation.id,
        'event-worker',
        claimed.task.id,
      ),
    ).toBe('failed')
    expect(
      store.listEvents('owner').find(event => event.id === continuation.id),
    ).toMatchObject({
      status: 'failed',
      lastError: 'blocked_task_stopped',
    })
    store.close()
  })

  it('parks a continuation when an Action starts during Router evaluation', async () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
    const continuation = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'test',
      payload: { text: 'Continue.' },
    }).event
    const handler = new RoutingEventHandler(
      {
        route: () => {
          store.requestApproval(
            claimed.run.id,
            claimed.claimToken,
            approvalDraft(),
          )
          return Promise.resolve({
            kind: 'continue_task' as const,
            taskId: claimed.task.id,
            input: 'Continue.',
            reason: 'Action appeared while routing',
          })
        },
      },
      'echo',
    )

    expect(await processNextEvent(store, handler, 'event-worker')).toBe(true)
    expect(
      store.listEvents('owner').find(event => event.id === continuation.id),
    ).toMatchObject({
      status: 'processing',
      lastError: 'blocked_by_action:awaiting_approval',
    })
    expect(store.listRuns(claimed.task.id)).toHaveLength(1)
    store.close()
  })

  it('does not retry a high-risk Action after its successor lease expires', () => {
    let now = new Date('2026-11-20T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock: { now: () => now } })
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft(),
    )
    store.decideApproval(requested.approval.id, 'owner', {
      commandId: 'approve-before-crash',
      optionId: 'approve',
    })
    const resumed = store.claimNextRun('worker-crashed')
    if (!resumed) throw new Error('Expected resumed Run')

    now = new Date('2026-11-20T00:00:31.000Z')
    expect(store.claimNextRun('replacement-worker')).toBeUndefined()
    expect(store.listRuns(claimed.task.id)).toHaveLength(2)
    expect(store.getAction(requested.action.id, 'owner')).toMatchObject({
      status: 'unknown',
      result: { reason: 'run_lease_expired_before_outcome' },
    })
    expect(() => store.retryRun(resumed.run.id, 'owner')).toThrow(
      /reconciled before retrying/,
    )
    store.close()
  })

  it('requires the prior authorized Action outcome before another Approval', () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
    const first = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft(),
    )
    store.decideApproval(first.approval.id, 'owner', {
      commandId: 'approve-first-before-second',
      optionId: 'approve',
    })
    const resumed = store.claimNextRun('worker-resumed')
    if (!resumed) throw new Error('Expected resumed Run')
    const secondDraft = approvalDraft()
    secondDraft.idempotencyKey = 'publish-release-2'

    expect(() =>
      store.requestApproval(resumed.run.id, resumed.claimToken, secondDraft),
    ).toThrow(/outcome must be recorded/)
    expect(store.pageApprovals('owner', 10).items).toHaveLength(1)

    store.recordActionOutcome(first.action.id, resumed.claimToken, {
      commandId: 'first-outcome-before-second',
      status: 'succeeded',
      result: { release: 'v1' },
    })
    expect(
      store.requestApproval(resumed.run.id, resumed.claimToken, secondDraft),
    ).toMatchObject({
      action: { status: 'awaiting_approval' },
      approval: { status: 'pending' },
    })
    store.close()
  })

  it('replays an identical Approval request while the authorized Action is still unresolved', () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
    const first = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft(),
    )
    store.decideApproval(first.approval.id, 'owner', {
      commandId: 'approve-before-replay',
      optionId: 'approve',
    })
    const resumed = store.claimNextRun('worker-replay')
    if (!resumed) throw new Error('Expected resumed Run')

    expect(
      store.requestApproval(
        resumed.run.id,
        resumed.claimToken,
        approvalDraft(),
      ),
    ).toMatchObject({
      action: { id: first.action.id, status: 'authorized' },
      approval: { id: first.approval.id, status: 'approved' },
    })

    const differentDraft = approvalDraft()
    differentDraft.idempotencyKey = 'publish-release-2'
    expect(() =>
      store.requestApproval(resumed.run.id, resumed.claimToken, differentDraft),
    ).toThrow(/outcome must be recorded/)
    store.close()
  })

  it('preserves a recorded unknown outcome and does not retry after lease expiry', () => {
    let now = new Date('2026-11-20T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock: { now: () => now } })
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft(),
    )
    store.decideApproval(requested.approval.id, 'owner', {
      commandId: 'approve-before-unknown',
      optionId: 'approve',
    })
    const resumed = store.claimNextRun('worker-uncertain')
    if (!resumed) throw new Error('Expected resumed Run')
    store.recordActionOutcome(requested.action.id, resumed.claimToken, {
      commandId: 'record-unknown-before-crash',
      status: 'unknown',
      result: { providerRequestId: 'request-1' },
    })

    now = new Date('2026-11-20T00:00:31.000Z')
    expect(store.claimNextRun('replacement-worker')).toBeUndefined()
    expect(store.listRuns(claimed.task.id)).toHaveLength(2)
    expect(store.getAction(requested.action.id, 'owner')).toMatchObject({
      status: 'unknown',
      result: { providerRequestId: 'request-1' },
    })
    store.close()
  })

  it('preserves a recorded Action outcome when the resumed Run fails', () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft(),
    )
    store.decideApproval(requested.approval.id, 'owner', {
      commandId: 'approve-before-recorded-failure',
      optionId: 'approve',
    })
    const resumed = store.claimNextRun('worker-resumed')
    if (!resumed) throw new Error('Expected resumed Run')
    store.recordActionOutcome(requested.action.id, resumed.claimToken, {
      commandId: 'record-unknown-before-run-failure',
      status: 'unknown',
      result: { providerRequestId: 'request-unknown' },
    })

    store.failRun(resumed.run.id, 'worker-resumed', 'executor crashed')

    expect(store.getAction(requested.action.id, 'owner')).toMatchObject({
      status: 'unknown',
      result: { providerRequestId: 'request-unknown' },
    })
    expect(store.findTask(claimed.task.id, 'owner')).toMatchObject({
      statusReason: 'action_outcome_unknown',
    })
    expect(store.listOutbox('owner').at(-1)?.payload).toMatchObject({
      type: 'action.outcome_unknown',
      actionId: requested.action.id,
      error: 'executor crashed',
    })
    store.close()
  })

  it('replays an immutable Approval response after the active claim expires', () => {
    let now = new Date('2026-11-20T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock: { now: () => now } })
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft(),
    )
    expect(
      store.requestApproval(claimed.run.id, claimed.claimToken, approvalDraft())
        .approval.id,
    ).toBe(requested.approval.id)

    now = new Date('2026-11-20T00:00:31.000Z')
    expect(
      store.requestApproval(claimed.run.id, claimed.claimToken, approvalDraft())
        .approval.id,
    ).toBe(requested.approval.id)
    store.close()
  })

  it('rejects forged events, ownership violations, and conflicting retries', () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'delete')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft(),
    )
    expect(() =>
      store.requestApproval(claimed.run.id, claimed.claimToken, {
        ...approvalDraft(),
        kind: 'different',
      }),
    ).toThrow(/idempotency key/)
    expect(store.getApproval(requested.approval.id, 'other')).toBeUndefined()
    expect(() =>
      store.decideApproval(requested.approval.id, 'other', {
        commandId: 'other-decision',
        optionId: 'approve',
      }),
    ).toThrow(/another user/)
    expect(() =>
      store.applyApprovalDecision(forgedEvent(requested.approval.id)),
    ).toThrow(/not trusted/)
    expect(store.listRuns(claimed.task.id)).toHaveLength(1)
    store.close()
  })

  it('cancels an unresolved approval when its Task is stopped', () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'danger')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft(),
    )

    store.stopTask(claimed.task.id, 'owner', 'stop-command', 'changed mind')

    const cancelled = store.getApproval(requested.approval.id, 'owner')
    expect(cancelled).toMatchObject({
      status: 'cancelled',
    })
    expect(cancelled?.resolvedAt).toBeTypeOf('string')
    expect(() =>
      store.decideApproval(requested.approval.id, 'owner', {
        commandId: 'late-decision',
        optionId: 'approve',
      }),
    ).toThrow(/closed/)
    expect(store.listOutbox('owner').at(-1)?.payload).toMatchObject({
      type: 'approval.resolved',
      approvalId: requested.approval.id,
      decision: 'cancelled',
    })
    store.close()
  })

  it('marks an authorized Action unknown when its Task is stopped', () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft(),
    )
    store.decideApproval(requested.approval.id, 'owner', {
      commandId: 'approve-before-stop',
      optionId: 'approve',
    })

    store.stopTask(claimed.task.id, 'owner', 'stop-approved', 'changed mind')

    expect(store.getAction(requested.action.id, 'owner')).toMatchObject({
      status: 'unknown',
      result: { reason: 'task_stopped_before_outcome' },
    })
    expect(store.listOutbox('owner').at(-1)?.payload).toMatchObject({
      type: 'action.reconciliation_required',
      actionId: requested.action.id,
      reason: 'changed mind',
    })
    store.close()
  })

  it('preserves and reports a recorded unknown Action when its Task is stopped', () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-1', 'publish')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      approvalDraft(),
    )
    store.decideApproval(requested.approval.id, 'owner', {
      commandId: 'approve-before-recorded-unknown-stop',
      optionId: 'approve',
    })
    const resumed = store.claimNextRun('worker-resumed-before-stop')
    if (!resumed) throw new Error('Expected resumed Run')
    store.recordActionOutcome(requested.action.id, resumed.claimToken, {
      commandId: 'record-unknown-before-stop',
      status: 'unknown',
      result: { providerRequestId: 'request-needs-reconciliation' },
    })

    store.stopTask(
      claimed.task.id,
      'owner',
      'stop-recorded-unknown',
      'Stop and verify provider state',
    )

    expect(store.getAction(requested.action.id, 'owner')).toMatchObject({
      status: 'unknown',
      result: { providerRequestId: 'request-needs-reconciliation' },
    })
    expect(store.listOutbox('owner').at(-1)?.payload).toMatchObject({
      type: 'action.reconciliation_required',
      actionId: requested.action.id,
      reason: 'Stop and verify provider state',
    })
    store.close()
  })

  it('paginates owner-scoped approvals without duplicates', () => {
    const store = new PegasStore(':memory:')
    const approvalIds = Array.from({ length: 3 }, (_, index) => {
      const claimed = createClaimedRun(
        store,
        'owner',
        `worker-page-${String(index)}`,
        `approval ${String(index)}`,
      )
      const draft = approvalDraft()
      draft.idempotencyKey = `approval-page-${String(index)}`
      return store.requestApproval(claimed.run.id, claimed.claimToken, draft)
        .approval.id
    })

    const first = store.pageApprovals('owner', 2)
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBeTypeOf('string')
    const second = store.pageApprovals('owner', 2, first.nextCursor)
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeUndefined()
    expect(
      new Set([...first.items, ...second.items].map(item => item.id)),
    ).toEqual(new Set(approvalIds))
    expect(store.pageApprovals('other', 2).items).toEqual([])
    const resolvedId = approvalIds[0]
    if (!resolvedId) throw new Error('Expected an Approval ID')
    store.decideApproval(resolvedId, 'owner', {
      commandId: 'pagination-decision',
      optionId: 'approve',
    })
    expect(
      store.pageApprovals('owner', 2, undefined, 'approved').items,
    ).toHaveLength(1)
    expect(() =>
      store.pageApprovals('owner', 2, resolvedId, 'pending'),
    ).toThrow(/cursor is invalid/)
    store.close()
  })

  it('exposes scoped creation and owner-authorized decision APIs', async () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-api', 'publish')
    const server = createControlPlane({ store, apiToken: 'owner-token' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      const missingClaim = await fetch(
        `${base}/v1/runs/${claimed.run.id}/approvals`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: approvalDraft() }),
        },
      )
      expect(missingClaim.status).toBe(403)
      const malformedWrongClaim = await fetch(
        `${base}/v1/runs/${claimed.run.id}/approvals`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-pegas-run-claim-token': 'wrong-token',
          },
          body: JSON.stringify({ action: { risk: 'invalid' } }),
        },
      )
      expect(malformedWrongClaim.status).toBe(403)

      const forgedEvent = await fetch(`${base}/v1/events`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer owner-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          userId: 'owner',
          type: 'approval.decided',
          source: 'approval',
          dedupeKey: 'approval-decision:forged',
          payload: { approvalId: 'forged' },
        }),
      })
      expect(forgedEvent.status).toBe(400)
      const forgedBody = (await forgedEvent.json()) as { message: string }
      expect(forgedBody.message).toMatch(/reserved/)

      const created = await fetch(
        `${base}/v1/runs/${claimed.run.id}/approvals`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-pegas-run-claim-token': claimed.claimToken,
          },
          body: JSON.stringify({ action: approvalDraft() }),
        },
      )
      expect(created.status).toBe(201)
      const createdBody = (await created.json()) as {
        approval: { id: string }
        action: { id: string }
      }

      expect((await fetch(`${base}/v1/approvals?userId=owner`)).status).toBe(
        401,
      )
      const listed = await fetch(`${base}/v1/approvals?userId=owner`, {
        headers: { authorization: 'Bearer owner-token' },
      })
      expect(listed.status).toBe(200)
      expect(await listed.json()).toMatchObject({
        approvals: [{ id: createdBody.approval.id, status: 'pending' }],
      })

      const decided = await fetch(
        `${base}/v1/approvals/${createdBody.approval.id}/decisions`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer owner-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            userId: 'owner',
            commandId: 'api-decision',
            optionId: 'approve',
          }),
        },
      )
      expect(decided.status).toBe(202)
      const decidedBody = (await decided.json()) as {
        approval: { status: string }
        decision: { kind: string; appliedAt?: string }
        event: { status: string }
      }
      expect(decidedBody).toMatchObject({
        approval: { status: 'approved' },
        decision: { kind: 'approve' },
        event: { status: 'pending' },
      })
      expect(decidedBody.decision.appliedAt).toBeTypeOf('string')

      const resumed = store.claimNextRun('worker-api-resumed')
      if (!resumed) throw new Error('Expected resumed Run')
      const outcomeUrl = `${base}/v1/actions/${createdBody.action.id}/outcomes`
      expect(
        (
          await fetch(outcomeUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              commandId: 'api-outcome',
              status: 'succeeded',
              result: { release: 'published' },
            }),
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await fetch(outcomeUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-pegas-run-claim-token': 'wrong-token',
            },
            body: JSON.stringify({ status: 'maybe' }),
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await fetch(outcomeUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-pegas-run-claim-token': 'wrong-token',
            },
            body: JSON.stringify({
              commandId: 'api-outcome',
              status: 'succeeded',
              result: { release: 'published' },
            }),
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await fetch(outcomeUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-pegas-run-claim-token': resumed.claimToken,
            },
            body: JSON.stringify({
              commandId: 'api-outcome-invalid',
              status: 'maybe',
              result: {},
            }),
          })
        ).status,
      ).toBe(400)
      const outcomeRequest = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pegas-run-claim-token': resumed.claimToken,
        },
        body: JSON.stringify({
          commandId: 'api-outcome',
          status: 'succeeded',
          result: { release: 'published' },
        }),
      }
      const recorded = await fetch(outcomeUrl, outcomeRequest)
      expect(recorded.status).toBe(201)
      expect(await recorded.json()).toMatchObject({
        action: {
          id: createdBody.action.id,
          status: 'succeeded',
          result: { release: 'published' },
        },
      })
      const actionProjection = await fetch(
        `${base}/v1/actions/${createdBody.action.id}?userId=owner`,
        { headers: { authorization: 'Bearer owner-token' } },
      )
      expect(actionProjection.status).toBe(200)
      expect(await actionProjection.json()).toMatchObject({
        action: {
          id: createdBody.action.id,
          status: 'succeeded',
          result: { release: 'published' },
        },
      })
      expect(
        (
          await fetch(
            `${base}/v1/actions/${createdBody.action.id}?userId=other`,
            { headers: { authorization: 'Bearer owner-token' } },
          )
        ).status,
      ).toBe(404)
      expect((await fetch(outcomeUrl, outcomeRequest)).status).toBe(201)
      const conflicting = await fetch(outcomeUrl, {
        ...outcomeRequest,
        body: JSON.stringify({
          commandId: 'api-outcome',
          status: 'failed',
          result: { release: 'failed' },
        }),
      })
      expect(conflicting.status).toBe(400)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })

  it('runs the DSH capability contract through Approval and outcome replay', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-approval-dsh-'))
    const command = join(directory, 'dsh')
    writeFileSync(command, fakeApprovalDshSource(), { mode: 0o700 })
    chmodSync(command, 0o700)
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(
      store,
      'owner',
      'worker-dsh-contract',
      'publish',
    )
    if (!('phase' in claimed)) throw new Error('Expected a claimed Run')
    const server = createControlPlane({ store, apiToken: 'owner-token' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const executor = new DshCliExecutor({ command })
    try {
      await executeClaimedRun(
        store,
        executor,
        claimed,
        'worker-dsh-contract',
        process.cwd(),
        new AbortController().signal,
        baseUrl,
      )

      const approval = store.pageApprovals('owner', 10).items[0]
      if (!approval) throw new Error('Expected DSH to request Approval')
      expect(store.listRuns(claimed.task.id).at(-1)).toMatchObject({
        id: claimed.run.id,
        status: 'waiting',
      })
      store.decideApproval(approval.id, 'owner', {
        commandId: 'approve-dsh-contract',
        optionId: 'approve',
      })
      const resumed = store.claimNextRun('worker-dsh-resumed')
      if (!resumed) throw new Error('Expected approved successor Run')

      await executeClaimedRun(
        store,
        executor,
        resumed,
        'worker-dsh-resumed',
        process.cwd(),
        new AbortController().signal,
        baseUrl,
      )

      expect(store.getAction(approval.actionId, 'owner')).toMatchObject({
        status: 'succeeded',
        result: { release: 'published' },
      })
      expect(store.listRuns(claimed.task.id).at(-1)).toMatchObject({
        id: resumed.run.id,
        status: 'completed',
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails closed for Approval user APIs when no instance token is configured', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      expect((await fetch(`${base}/v1/approvals?userId=owner`)).status).toBe(
        401,
      )
      expect(
        (await fetch(`${base}/v1/approvals/approval-1?userId=owner`)).status,
      ).toBe(401)
      expect(
        (
          await fetch(`${base}/v1/approvals/approval-1/decisions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              userId: 'owner',
              commandId: 'decision',
              optionId: 'approve',
            }),
          })
        ).status,
      ).toBe(401)
      expect(
        (await fetch(`${base}/v1/actions/action-1?userId=owner`)).status,
      ).toBe(401)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })
})

function approvalDraft(): ActionRequestDraft {
  return {
    kind: 'publish.release',
    risk: 'high',
    idempotencyKey: 'publish-release-1',
    request: { release: 'v1' },
    recoveryPoint: { step: 'before_publish' },
    approval: {
      summary: 'Publish release v1',
      impact: 'Makes the release public',
      recommendedOptionId: 'approve',
      options: [
        { id: 'approve', label: 'Publish', kind: 'approve' },
        { id: 'reject', label: 'Do not publish', kind: 'reject' },
        { id: 'revise', label: 'Revise first', kind: 'revise' },
      ],
    },
  }
}

function fakeApprovalDshSource(): string {
  return `#!/usr/bin/env node
async function main() {
let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
const prompt = input.split('\\n\\n<pegas_execution_contract>')[0]
const baseUrl = process.env.PEGAS_CONTROL_PLANE_URL
const runId = process.env.PEGAS_RUN_ID
const claimToken = process.env.PEGAS_RUN_CLAIM_TOKEN
if (!baseUrl || !runId || !claimToken) throw new Error('missing capability')
const headers = {
  'content-type': 'application/json',
  'x-pegas-run-claim-token': claimToken
}
let output = 'Approval requested'
if (prompt.startsWith('{"type":"approval.decision"')) {
  const context = JSON.parse(prompt)
  if (context.decision !== 'approve') throw new Error('expected approval')
  const body = JSON.stringify({
    commandId: 'fake-dsh-outcome',
    status: 'succeeded',
    result: { release: 'published' }
  })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(baseUrl + '/v1/actions/' + context.actionId + '/outcomes', {
      method: 'POST', headers, body
    })
    if (!response.ok) throw new Error('outcome failed: ' + response.status)
  }
  output = 'Action outcome recorded'
} else {
  const response = await fetch(baseUrl + '/v1/runs/' + runId + '/approvals', {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: {
      kind: 'publish.release',
      risk: 'high',
      idempotencyKey: 'fake-dsh-approval',
      request: { release: 'v1' },
      recoveryPoint: { step: 'before_publish' },
      approval: {
        summary: 'Publish release v1',
        impact: 'Makes release v1 public',
        recommendedOptionId: 'approve',
        options: [
          { id: 'approve', label: 'Publish', kind: 'approve' },
          { id: 'reject', label: 'Do not publish', kind: 'reject' }
        ]
      }
    }})
  })
  if (!response.ok) throw new Error('approval failed: ' + response.status)
}
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-approval-contract',
  text: output,
  reason: { kind: 'completed' }
}))
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
`
}

function createClaimedRun(
  store: PegasStore,
  userId: string,
  workerId: string,
  text: string,
  claim = true,
) {
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'test',
    payload: { text },
  }).event
  const claimedEvent = store.claimNextEvent(`setup-${workerId}`)
  if (claimedEvent?.id !== event.id)
    throw new Error('Expected setup Event claim')
  const applied = store.applyRoutingDecision(
    claimedEvent,
    {
      kind: 'create_task',
      title: text,
      goal: text,
      input: text,
      reason: 'test',
    },
    'echo',
    { executor: 'echo' },
  )
  store.completeEvent(event.id, `setup-${workerId}`)
  if (!claim) return { ...applied, claimToken: '' }
  const claimed = store.claimNextRun(workerId)
  if (!claimed) throw new Error('Expected claimed Run')
  return claimed
}

function forgedEvent(approvalId: string): InboxEvent {
  return {
    id: 'forged-event',
    userId: 'owner',
    type: 'approval.decided',
    source: 'approval',
    payload: { approvalId },
    status: 'processing',
    attempts: 1,
    createdAt: '2026-11-20T00:00:00.000Z',
  }
}
