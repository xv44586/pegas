import { describe, expect, it } from 'vitest'

import { EchoExecutor } from '../src/executor/echo-executor.js'
import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../src/executor/executor.js'
import type { GoalContractDraft } from '../src/goal/goal-delivery.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  executeClaimedRun,
  localControlPlaneBaseUrl,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

describe('event and run processing', () => {
  it('keeps the Run capability transport on loopback', () => {
    expect(localControlPlaneBaseUrl('127.0.0.1', 4317)).toBe(
      'http://127.0.0.1:4317',
    )
    expect(localControlPlaneBaseUrl('localhost', 4317)).toBe(
      'http://localhost:4317',
    )
    expect(localControlPlaneBaseUrl('::1', 4317)).toBe('http://[::1]:4317')
    expect(localControlPlaneBaseUrl('0.0.0.0', 4317)).toBe(
      'http://127.0.0.1:4317',
    )
    expect(localControlPlaneBaseUrl('::', 4317)).toBe('http://[::1]:4317')
    expect(() => localControlPlaneBaseUrl('192.168.1.20', 4317)).toThrow(
      /loopback transport/,
    )
  })

  it('passes the active Run capability to the Executor', async () => {
    const store = new PegasStore(':memory:')
    const executor = new CapabilityCapturingExecutor()
    store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: 'Publish the protected release' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name, () => ({
        executor: executor.name,
        executorProfile: 'isolated-profile',
        workspace: '/snapshot-workspace',
        model: 'provider/snapshot-model',
        permissions: JSON.stringify({ mode: 'workspace-write' }),
        protocol: 'test-v1',
      })),
      'worker-capability',
    )
    const claimed = store.claimNextRun('worker-capability')
    if (!claimed) throw new Error('Expected a claimed Run')

    await executeClaimedRun(
      store,
      executor,
      claimed,
      'worker-capability',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )

    expect(executor.input).toMatchObject({
      runId: claimed.run.id,
      taskId: claimed.task.id,
      inputEventId: claimed.run.originEventId,
      workingDirectory: '/snapshot-workspace',
      executionContext: claimed.run.executionContext,
      mandate: claimed.task.mandate,
      actionCapability: {
        baseUrl: 'http://127.0.0.1:4317',
        claimToken: claimed.claimToken,
      },
    })
    store.close()
  })

  it('fails a malformed v2 snapshot before invoking the Executor', async () => {
    const store = new PegasStore(':memory:')
    const executor = new CapabilityCapturingExecutor()
    const event = store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: 'Run with the persisted permissions' },
    }).event
    const claimedEvent = store.claimNextEvent('router-v2')
    if (!claimedEvent) throw new Error('Expected event claim')
    store.applyRoutingDecision(
      claimedEvent,
      {
        kind: 'create_task',
        title: 'Strict snapshot',
        goal: 'Use only persisted permissions',
        input: 'Run with the persisted permissions',
        reason: 'test',
      },
      executor.name,
      task => ({
        executor: 'dsh-headless',
        executorProfile: 'isolated-profile',
        workspace: '/snapshot-workspace',
        model: 'profile',
        modelMode: 'profile',
        permissions: '{malformed',
        protocol: 'dsh-headless-v1',
        settingsRevision: 1,
        workerProfile: `worker-profile:${task.id}`,
        workerProfileRevision: 1,
        workerProfileSource: 'global',
      }),
    )
    store.completeEvent(event.id, 'router-v2')
    const claimed = store.claimNextRun('worker-v2')
    if (!claimed) throw new Error('Expected a claimed Run')

    await executeClaimedRun(
      store,
      executor,
      claimed,
      'worker-v2',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )

    expect(executor.input).toBeUndefined()
    expect(store.listRuns(claimed.task.id)).toMatchObject([
      {
        status: 'failed',
        lastError: 'Run execution contract v2 permissions are malformed',
      },
    ])
    store.close()
  })

  it('preserves the authenticated external input Event across a retry Run', async () => {
    const store = new PegasStore(':memory:')
    const executor = new CapabilityCapturingExecutor()
    const event = store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: 'Retry and retain handback provenance' },
    }).event
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
      'retry-router',
    )
    const first = store.claimNextRun('retry-worker-1')
    if (!first) throw new Error('Expected initial Run')
    store.failRun(first.run.id, 'retry-worker-1', 'transient failure')
    const retry = store.retryRun(first.run.id, 'user-1')
    const claimedRetry = store.claimNextRun('retry-worker-2')
    if (claimedRetry?.run.id !== retry.id) {
      throw new Error('Expected retry Run')
    }

    await executeClaimedRun(
      store,
      executor,
      claimedRetry,
      'retry-worker-2',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )

    expect(executor.input).toMatchObject({
      runId: retry.id,
      inputEventId: event.id,
    })
    expect(claimedRetry.run.originEventId).toBeUndefined()
    store.close()
  })

  it('routes a user message through a durable run', async () => {
    const store = new PegasStore(':memory:')
    store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      authenticatedActor: 'human',
      dedupeKey: 'message-1',
      payload: { text: 'Ship the first vertical slice' },
    })
    const executor = new EchoExecutor()

    const processed = await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
      'worker-1',
    )

    expect(processed).toBe(true)
    expect(store.listTasks('user-1')).toMatchObject([
      { title: 'Ship the first vertical slice', status: 'unstarted' },
    ])
    expect(store.listRuns()).toMatchObject([
      { status: 'queued', input: 'Ship the first vertical slice' },
    ])
    expect(store.listOutbox('user-1')).toEqual([])

    const claimed = store.claimNextRun('worker-1')
    expect(claimed).toBeDefined()
    if (!claimed) throw new Error('Expected a claimed run')
    await executeClaimedRun(
      store,
      executor,
      claimed,
      'worker-1',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )

    const completedRuns = store.listRuns()
    expect(completedRuns).toMatchObject([
      {
        status: 'completed',
        output: 'Ship the first vertical slice',
      },
    ])
    expect(completedRuns[0]?.executorRef).toMatch(/^echo-/)
    expect(store.listTasks('user-1')).toMatchObject([
      { status: 'completed', ended: { outcome: 'completed' } },
    ])
    store.close()
  })

  it('persists a partial structured Report for a Goal-bound Executor result', async () => {
    const store = new PegasStore(':memory:')
    const enqueued = store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: 'Deliver a verified result' },
    }).event
    const executor = new EchoExecutor()
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
      'worker-goal',
    )
    const task = store.listTasks('user-1')[0]
    if (!task) throw new Error('Expected a Task')
    store.createGoalContract(
      task.id,
      'user-1',
      'goal-processor',
      processorGoal(enqueued.id),
    )
    const claimed = store.claimNextRun('worker-goal')
    if (!claimed) throw new Error('Expected a claimed Run')
    await executeClaimedRun(
      store,
      executor,
      claimed,
      'worker-goal',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )

    expect(store.listRuns(task.id)).toMatchObject([{ status: 'waiting' }])
    expect(store.listWorkerReports(claimed.run.id, 'user-1')).toMatchObject([
      {
        reporterIdentity: 'worker-goal',
        reportSequence: 0,
        status: 'ready',
        evidenceRefIds: [],
      },
    ])
    expect(store.listReviewPacks(task.id, 'user-1')).toMatchObject([
      { finalOutcome: 'partial' },
    ])
    expect(store.findTask(task.id, 'user-1')).toMatchObject({
      status: 'started',
      statusReason: 'awaiting_evidence',
    })
    store.createEvidenceRef(claimed.run.id, 'user-1', 'processor-evidence', {
      goalRevision: claimed.run.goalRevision ?? 0,
      criterionId: 'result',
      kind: 'observation',
      producerIdentity: 'worker-goal',
      captureMechanism: 'deterministic-check',
      trustClass: 'control-plane',
      observationSnapshot: {
        observedValue: { delivered: true },
        sourceObjectId: 'processor-result',
        issuerIdentity: 'control-plane',
        observedAt: '2026-11-20T00:00:00.000Z',
        snapshotHash: 'a'.repeat(64),
      },
      verification: {
        method: 'deterministic-check',
        verifierIdentity: 'pegas-control-plane-verifier',
        verifierVersion: 'v1',
        result: 'passed',
        verifiedAt: '2026-11-20T00:00:00.000Z',
      },
      environment: {},
      presentation: {},
      sensitivity: 'private',
      limitations: [],
    })
    const reportingClaim = store.claimNextRun('worker-review')
    expect(reportingClaim).toMatchObject({
      phase: 'report',
      run: { id: claimed.run.id },
    })
    if (!reportingClaim) throw new Error('Expected a reporting claim')
    await executeClaimedRun(
      store,
      new NeverExecuteExecutor(),
      reportingClaim,
      'worker-review',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )
    expect(store.findTask(task.id, 'user-1')?.status).toBe('completed')
    expect(store.listRuns(task.id)).toMatchObject([{ status: 'completed' }])
    store.close()
  })

  it('includes Evidence captured during execution in the initial ready Report', async () => {
    const store = new PegasStore(':memory:')
    const enqueued = store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: 'Deliver evidence captured during execution' },
    }).event
    const executor = new EchoExecutor()
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
      'worker-evidence',
    )
    const task = store.listTasks('user-1')[0]
    if (!task) throw new Error('Expected a Task')
    const goal = store.createGoalContract(
      task.id,
      'user-1',
      'goal-execution-evidence',
      processorGoal(enqueued.id),
    )
    const claimed = store.claimNextRun('worker-evidence')
    if (!claimed) throw new Error('Expected a claimed Run')
    const evidence = store.createEvidenceRef(
      claimed.run.id,
      'user-1',
      'execution-evidence',
      processorEvidence(goal.revision, 'execution-result'),
    )
    await executeClaimedRun(
      store,
      executor,
      claimed,
      'worker-evidence',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )

    expect(store.listWorkerReports(claimed.run.id, 'user-1')).toMatchObject([
      { reportSequence: 0, evidenceRefIds: [evidence.id] },
    ])
    expect(store.findTask(task.id, 'user-1')?.status).toBe('completed')
    expect(store.claimNextRun('another-worker')).toBeUndefined()
    store.close()
  })

  it('continues an explicit task with the same executor session', async () => {
    const store = new PegasStore(':memory:')
    const executor = new EchoExecutor()
    const handler = new RoutingEventHandler(
      new RuleBasedTaskRouter(),
      executor.name,
    )
    store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      authenticatedActor: 'human',
      dedupeKey: 'message-1',
      payload: { text: 'Create the first version' },
    })
    await processNextEvent(store, handler, 'worker-1')
    const firstClaim = store.claimNextRun('worker-1')
    if (!firstClaim) throw new Error('Expected the first run')
    await executeClaimedRun(
      store,
      executor,
      firstClaim,
      'worker-1',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )
    const task = store.listTasks('user-1')[0]
    if (!task) throw new Error('Expected the task')
    const firstSession = store.listRuns(task.id)[0]?.executorRef
    if (!firstSession) throw new Error('Expected the first executor session')

    store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      authenticatedActor: 'human',
      dedupeKey: 'message-2',
      payload: { text: 'Now add recovery tests', taskId: task.id },
    })
    await processNextEvent(store, handler, 'worker-1')

    const runs = store.listRuns(task.id)
    expect(store.listTasks('user-1')).toHaveLength(1)
    expect(runs).toHaveLength(2)
    expect(runs[1]).toMatchObject({
      status: 'queued',
      input: 'Now add recovery tests',
      resumeFromRef: firstSession,
    })
    expect(store.listOutbox('user-1')).toHaveLength(1)
    store.close()
  })

  it('publishes the executor acknowledgement before the final result', async () => {
    const store = new PegasStore(':memory:')
    const executor = new AcknowledgingExecutor()
    store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: 'Review the release workflow' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
      'worker-1',
    )
    const claimed = store.claimNextRun('worker-1')
    if (!claimed) throw new Error('Expected a claimed run')

    await executeClaimedRun(
      store,
      executor,
      claimed,
      'worker-1',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )

    expect(store.listOutbox('user-1')).toMatchObject([
      {
        payload: {
          type: 'run.acknowledged',
          text: '我会检查发布流程和恢复路径，并给出可验证的改进结果。',
        },
      },
      {
        payload: { type: 'run.completed', text: 'Review complete' },
      },
    ])
    store.close()
  })

  it('persists executor usage when a claimed Run completes', async () => {
    const store = new PegasStore(':memory:')
    const executor = new UsageReportingExecutor()
    store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: 'Measure the model Run' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
      'worker-1',
    )
    const claimed = store.claimNextRun('worker-1')
    if (!claimed) throw new Error('Expected a claimed run')

    await executeClaimedRun(
      store,
      executor,
      claimed,
      'worker-1',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )

    expect(store.listModelUsage('user-1', claimed.task.id)).toMatchObject({
      summary: {
        records: 1,
        inputTokens: 42,
        outputTokens: 9,
        durationMs: 640,
      },
      records: [
        {
          runId: claimed.run.id,
          completeness: 'complete',
          tokenSource: 'provider_reported',
          inputTokens: 42,
          outputTokens: 9,
          durationMs: 640,
        },
      ],
    })
    store.close()
  })

  it('leaves the run recoverable when the replaceable worker runtime stops', async () => {
    const store = new PegasStore(':memory:')
    store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: 'Survive a worker restart' },
    })
    const executor = new AbortAwareExecutor()
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
      'worker-1',
    )
    const claimed = store.claimNextRun('worker-1')
    if (!claimed) throw new Error('Expected a claimed run')
    const shutdown = new AbortController()

    const execution = executeClaimedRun(
      store,
      executor,
      claimed,
      'worker-1',
      process.cwd(),
      shutdown.signal,
      'http://127.0.0.1:4317',
    )
    shutdown.abort(new Error('worker runtime stopped'))
    await execution

    expect(store.listRuns()).toMatchObject([
      { id: claimed.run.id, status: 'running', claimedBy: 'worker-1' },
    ])
    expect(store.listTasks('user-1')).toMatchObject([{ status: 'started' }])
    store.close()
  })
})

class AcknowledgingExecutor implements RunExecutor {
  readonly name = 'acknowledging-test'

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    input.onExecutorRef?.('session-ack')
    input.onProgress?.({
      type: 'acknowledgement',
      text: '我会检查发布流程和恢复路径，并给出可验证的改进结果。',
    })
    return Promise.resolve({
      executorRef: 'session-ack',
      output: 'Review complete',
    })
  }
}

class CapabilityCapturingExecutor implements RunExecutor {
  readonly name = 'capability-capturing-test'
  input?: ExecutorInput

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    this.input = input
    return Promise.resolve({
      executorRef: 'session-capability',
      output: 'Protected release handled',
    })
  }
}

class AbortAwareExecutor implements RunExecutor {
  readonly name = 'abort-aware-test'

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    return new Promise((_, reject) => {
      input.signal?.addEventListener(
        'abort',
        () => reject(new Error('executor aborted')),
        { once: true },
      )
    })
  }
}

class UsageReportingExecutor implements RunExecutor {
  readonly name = 'usage-reporting-test'

  execute(): Promise<ExecutorResult> {
    return Promise.resolve({
      executorRef: 'session-usage',
      output: 'Measured',
      durationMs: 640,
      usage: {
        source: 'provider_reported',
        reportedSteps: 1,
        unreportedSteps: 0,
        tokens: { inputTokens: 42, outputTokens: 9 },
      },
    })
  }
}

class NeverExecuteExecutor implements RunExecutor {
  readonly name = 'must-not-execute'

  execute(): Promise<ExecutorResult> {
    return Promise.reject(new Error('Report recovery must not re-execute'))
  }
}

function processorGoal(eventId: string): GoalContractDraft {
  return {
    basedOnEventIds: [eventId],
    desiredOutcome: 'Deliver a verified result.',
    beneficiaries: ['user-1'],
    successCriteria: [
      {
        criterionId: 'result',
        observableStatement: 'The result is independently verified.',
        required: true,
        evidencePlanRef: 'result-evidence',
      },
    ],
    nonGoals: [],
    constraints: [],
    contextSources: [],
    assumptions: [],
    unknowns: [],
    prerequisites: [],
    permissionBoundary: {},
    reviewCheckpoints: ['final'],
    evidencePlan: [
      {
        id: 'result-evidence',
        criterionId: 'result',
        acceptedKinds: ['observation'],
        acceptedTrustClasses: ['control-plane'],
        minimumCount: 1,
        presentation: 'inline',
      },
    ],
    failureAndRecovery: 'Keep the Task open.',
    feedbackSignals: [],
  }
}

function processorEvidence(goalRevision: number, sourceObjectId: string) {
  return {
    goalRevision,
    criterionId: 'result',
    kind: 'observation',
    producerIdentity: 'worker-evidence',
    captureMechanism: 'deterministic-check',
    trustClass: 'control-plane',
    observationSnapshot: {
      observedValue: { delivered: true },
      sourceObjectId,
      issuerIdentity: 'control-plane',
      observedAt: '2026-11-20T00:00:00.000Z',
      snapshotHash: 'b'.repeat(64),
    },
    verification: {
      method: 'deterministic-check',
      verifierIdentity: 'pegas-control-plane-verifier',
      verifierVersion: 'v1',
      result: 'passed' as const,
      verifiedAt: '2026-11-20T00:00:00.000Z',
    },
    environment: {},
    presentation: {},
    sensitivity: 'private',
    limitations: [],
  }
}
