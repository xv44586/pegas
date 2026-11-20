import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type { GoalContractDraft } from '../src/goal/goal-delivery.js'
import {
  parseEvidenceClaimDraft,
  parseEvidenceRefDraft,
  parseGoalContractDraft,
  parseWorkerReportDraft,
} from '../src/goal/goal-delivery.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('GOAL-001 delivery contracts', () => {
  it('validates criterion-to-evidence-plan references and immutable evidence', () => {
    expect(() =>
      parseGoalContractDraft({
        ...goalDraft('event-1'),
        successCriteria: [
          {
            criterionId: 'criterion-1',
            observableStatement: 'The result is visible.',
            required: true,
            evidencePlanRef: 'missing-plan',
          },
        ],
      }),
    ).toThrow('Unknown evidence plan')
    expect(() =>
      parseGoalContractDraft({
        ...goalDraft('event-1'),
        successCriteria: [
          {
            criterionId: 'criterion-1',
            observableStatement: 'First result.',
            required: true,
            evidencePlanRef: 'plan-2',
          },
          {
            criterionId: 'criterion-2',
            observableStatement: 'Second result.',
            required: true,
            evidencePlanRef: 'plan-1',
          },
        ],
        evidencePlan: [
          ...goalDraft('event-1').evidencePlan,
          {
            id: 'plan-2',
            criterionId: 'criterion-2',
            acceptedKinds: ['observation'],
            acceptedTrustClasses: ['control-plane'],
            minimumCount: 1,
            presentation: 'inline',
          },
        ],
      }),
    ).toThrow('belongs to')
    expect(() =>
      parseEvidenceRefDraft({
        goalRevision: 1,
        criterionId: 'criterion-1',
        kind: 'observation',
        producerIdentity: 'worker',
        captureMechanism: 'model-claim',
        trustClass: 'executor',
        verification: verification('pending'),
        environment: {},
        presentation: {},
        sensitivity: 'private',
        limitations: [],
      }),
    ).toThrow('immutable observationSnapshot')
    expect(() =>
      parseEvidenceRefDraft({
        ...observationEvidence(1, 'passed'),
        verification: {
          method: 'deterministic-check',
          verifierIdentity: 'control-plane',
          verifierVersion: 'v1',
          result: 'passed',
        },
      }),
    ).toThrow('verification.verifiedAt is required')
    expect(() =>
      parseEvidenceClaimDraft(observationEvidence(1, 'passed')),
    ).toThrow('verification is issued by the server')
    expect(() =>
      parseWorkerReportDraft({
        goalRevision: 1,
        reportSequence: 1,
        status: 'ready',
        evidenceRefIds: ['evidence-1', 'evidence-1'],
        summary: 'Duplicate evidence cannot increase coverage.',
        limitations: [],
        remainingRisks: [],
      }),
    ).toThrow('evidenceRefIds values must be unique')
  })

  it('binds the first Goal revision when the Executor has already claimed the Run', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedRun(store)
    expect(store.claimNextRun('worker-running')?.run.id).toBe(seeded.runId)
    const goal = store.createGoalContract(
      seeded.taskId,
      'owner',
      'goal-after-claim',
      goalDraft(seeded.eventId),
    )
    expect(store.listRuns(seeded.taskId)[0]?.goalRevision).toBe(goal.revision)
    store.completeRun(seeded.runId, 'worker-running', {
      executorRef: 'session-running',
      output: 'Awaiting evidence.',
    })
    expect(store.listRuns(seeded.taskId)[0]).toMatchObject({
      status: 'waiting',
      claimedBy: 'worker-running',
    })
    store.close()
  })

  it('recovers an abandoned post-execution reporting lease with a new claim capability', () => {
    let now = '2026-11-20T00:00:00.000Z'
    const store = new PegasStore(':memory:', {
      clock: { now: () => new Date(now) },
    })
    const seeded = seedRun(store)
    const goal = store.createGoalContract(
      seeded.taskId,
      'owner',
      'goal-report-recovery',
      goalDraft(seeded.eventId),
    )
    const firstClaim = store.claimNextRun('worker-abandoned')
    expect(firstClaim?.run.id).toBe(seeded.runId)
    store.completeRun(seeded.runId, 'worker-abandoned', {
      executorRef: 'session-abandoned',
      output: 'Execution finished before the Worker exited.',
    })
    now = '2026-11-20T00:00:31.000Z'
    const recovered = store.claimNextRun('worker-recovered')
    expect(recovered).toMatchObject({
      phase: 'report',
      run: {
        id: seeded.runId,
        goalRevision: goal.revision,
        status: 'waiting',
      },
    })
    expect(recovered?.claimToken).not.toBe(firstClaim?.claimToken)
    expect(() =>
      store.submitWorkerReport(
        recovered?.run.id ?? '',
        'owner',
        { claimToken: firstClaim?.claimToken ?? '' },
        {
          goalRevision: goal.revision,
          reportSequence: 0,
          status: 'progress',
          evidenceRefIds: [],
          summary: 'A stale capability must be fenced.',
          limitations: [],
          remainingRisks: [],
        },
      ),
    ).toThrow('claim capability')
    store.close()
  })

  it('keeps a Goal-bound Run waiting until verified evidence satisfies every required criterion', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedRun(store)
    const contract = store.createGoalContract(
      seeded.taskId,
      'owner',
      'goal-command-1',
      goalDraft(seeded.eventId),
    )
    expect(
      store.createGoalContract(
        seeded.taskId,
        'owner',
        'goal-command-1',
        goalDraft(seeded.eventId),
      ).id,
    ).toBe(contract.id)

    const claimed = store.claimNextRun('worker-1')
    expect(claimed?.run.id).toBe(seeded.runId)
    store.completeRun(seeded.runId, 'worker-1', {
      executorRef: 'session-1',
      output: 'The implementation is ready.',
    })
    expect(store.listRuns(seeded.taskId)[0]).toMatchObject({
      status: 'waiting',
      output: 'The implementation is ready.',
    })
    expect(store.findTask(seeded.taskId, 'owner')).toMatchObject({
      status: 'started',
      statusReason: 'awaiting_evidence',
    })
    expect(store.listOutbox('owner').at(-1)?.payload).toMatchObject({
      type: 'goal.report_required',
    })

    const artifact = store.createArtifact(
      seeded.taskId,
      'owner',
      'artifact-command-1',
      {
        runId: seeded.runId,
        name: 'Final UI',
        kind: 'image',
        mimeType: 'image/png',
        uri: '/artifacts/final-ui.png',
        revision: 'git:abc123',
        contentHash: 'a'.repeat(64),
        sizeBytes: 1024,
        metadata: { width: 1440, height: 900 },
        sensitivity: 'private',
      },
    )
    expect(() =>
      store.createEvidenceRef(seeded.runId, 'owner', 'invalid-viewport-null', {
        goalRevision: contract.revision,
        criterionId: 'criterion-1',
        kind: 'screenshot',
        artifactId: artifact.id,
        producerIdentity: 'worker-1',
        captureMechanism: 'playwright',
        trustClass: 'control-plane',
        verification: verification('passed'),
        environment: { viewport: null },
        presentation: { alt: 'Invalid UI capture' },
        sensitivity: 'private',
        limitations: [],
      }),
    ).toThrow('capture viewport')
    expect(() =>
      store.createEvidenceRef(seeded.runId, 'owner', 'invalid-viewport-size', {
        goalRevision: contract.revision,
        criterionId: 'criterion-1',
        kind: 'screenshot',
        artifactId: artifact.id,
        producerIdentity: 'worker-1',
        captureMechanism: 'playwright',
        trustClass: 'control-plane',
        verification: verification('passed'),
        environment: { viewport: { width: -1, height: 900 } },
        presentation: { alt: 'Invalid UI capture' },
        sensitivity: 'private',
        limitations: [],
      }),
    ).toThrow('dimensions must be positive')
    const textArtifact = store.createArtifact(
      seeded.taskId,
      'owner',
      'artifact-command-text',
      {
        runId: seeded.runId,
        name: 'Not a screenshot',
        kind: 'document',
        mimeType: 'text/plain',
        revision: 'git:text',
        contentHash: 'f'.repeat(64),
        metadata: {},
        sensitivity: 'private',
      },
    )
    expect(() =>
      store.createEvidenceRef(seeded.runId, 'owner', 'text-as-screenshot', {
        goalRevision: contract.revision,
        criterionId: 'criterion-1',
        kind: 'screenshot',
        artifactId: textArtifact.id,
        producerIdentity: 'worker-1',
        captureMechanism: 'invalid-capture',
        trustClass: 'control-plane',
        verification: verification('passed'),
        environment: { viewport: { width: 1440, height: 900 } },
        presentation: { alt: 'Invalid screenshot' },
        sensitivity: 'private',
        limitations: [],
      }),
    ).toThrow('image Artifact')
    const evidence = store.createEvidenceRef(
      seeded.runId,
      'owner',
      'evidence-command-1',
      {
        goalRevision: contract.revision,
        criterionId: 'criterion-1',
        kind: 'screenshot',
        artifactId: artifact.id,
        producerIdentity: 'worker-1',
        captureMechanism: 'playwright',
        trustClass: 'control-plane',
        verification: verification('passed'),
        environment: { viewport: { width: 1440, height: 900 } },
        presentation: { alt: 'Final UI' },
        sensitivity: 'private',
        limitations: [],
      },
    )
    expect(
      store.createEvidenceRef(
        seeded.runId,
        'owner',
        'evidence-command-response-retry',
        {
          goalRevision: contract.revision,
          criterionId: 'criterion-1',
          kind: 'screenshot',
          artifactId: artifact.id,
          producerIdentity: 'worker-1',
          captureMechanism: 'playwright',
          trustClass: 'control-plane',
          verification: verification('passed'),
          environment: { viewport: { width: 1440, height: 900 } },
          presentation: { alt: 'Final UI' },
          sensitivity: 'private',
          limitations: [],
        },
      ).id,
    ).toBe(evidence.id)
    expect(store.listEvidenceRefs(seeded.taskId, 'owner')).toHaveLength(1)
    const delivered = store.submitWorkerReport(
      seeded.runId,
      'owner',
      'worker-1',
      {
        goalRevision: contract.revision,
        reportSequence: 1,
        status: 'ready',
        evidenceRefIds: [evidence.id],
        summary: 'The requested result is ready for review.',
        limitations: [],
        remainingRisks: ['The app is not notarized.'],
        rollback: { command: 'git revert abc123' },
      },
    )

    expect(delivered.completed).toBe(true)
    expect(delivered.reviewPack).toMatchObject({
      finalOutcome: 'completed',
      criteria: [
        {
          criterionId: 'criterion-1',
          completionStatus: 'satisfied',
          currentValidity: 'valid',
          evidenceRefs: [evidence.id],
        },
      ],
    })
    expect(store.findTask(seeded.taskId, 'owner')).toMatchObject({
      status: 'completed',
    })
    expect(store.listRuns(seeded.taskId)[0]).toMatchObject({
      status: 'completed',
    })
    expect(() =>
      store.submitWorkerReport(seeded.runId, 'owner', 'worker-other', {
        goalRevision: contract.revision,
        reportSequence: 1,
        status: 'ready',
        evidenceRefIds: [evidence.id],
        summary: 'Another worker cannot replay this report.',
        limitations: [],
        remainingRisks: [],
      }),
    ).toThrow('another reporter')
    expect(
      store.submitWorkerReport(seeded.runId, 'owner', 'worker-1', {
        goalRevision: contract.revision,
        reportSequence: 1,
        status: 'ready',
        evidenceRefIds: [evidence.id],
        summary: 'A response retry must return the same completion chain.',
        limitations: [],
        remainingRisks: [],
      }).reviewPack?.id,
    ).toBe(delivered.reviewPack?.id)
    expect(store.listReviewPacks(seeded.taskId, 'owner')).toHaveLength(1)
    expect(store.listOutbox('owner').at(-1)?.payload).toMatchObject({
      type: 'review.ready',
      reviewPackId: delivered.reviewPack?.id,
    })
    expect(() =>
      store.createArtifact(seeded.taskId, 'owner', 'artifact-after-close', {
        runId: seeded.runId,
        name: 'Late artifact',
        kind: 'file',
        revision: 'late',
        contentHash: 'd'.repeat(64),
        metadata: {},
        sensitivity: 'private',
      }),
    ).toThrow('Closed Task')
    store.close()
  })

  it('paginates append-only Goal history with an owner-scoped cursor', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedRun(store)
    for (let revision = 1; revision <= 3; revision += 1) {
      store.createGoalContract(
        seeded.taskId,
        'owner',
        `goal-page-${String(revision)}`,
        goalDraft(seeded.eventId, `Outcome ${String(revision)}`),
      )
    }

    const first = store.pageGoalContracts(seeded.taskId, 'owner', 2)
    expect(first.items.map(item => item.revision)).toEqual([3, 2])
    expect(first.nextCursor).toBeTruthy()
    const second = store.pageGoalContracts(
      seeded.taskId,
      'owner',
      2,
      first.nextCursor,
    )
    expect(second.items.map(item => item.revision)).toEqual([1])
    expect(second.nextCursor).toBeUndefined()
    expect(() =>
      store.pageGoalContracts(seeded.taskId, 'owner', 2, 'not-a-cursor'),
    ).toThrow('cursor is invalid')
    store.close()
  })

  it('appends trusted verification without replacing Evidence capture identity', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedRun(store)
    const goal = store.createGoalContract(
      seeded.taskId,
      'owner',
      'goal-verification-upgrade',
      goalDraft(seeded.eventId),
    )
    expect(store.claimNextRun('worker-verify')?.run.id).toBe(seeded.runId)
    store.completeRun(seeded.runId, 'worker-verify', {
      executorRef: 'session-verify',
      output: 'Captured; awaiting verification.',
    })
    const pending = store.createEvidenceRef(
      seeded.runId,
      'owner',
      'pending-capture',
      observationEvidence(goal.revision, 'pending'),
    )
    const verified = store.recordEvidenceVerification(
      pending.id,
      'owner',
      'verification-passed',
      verification('passed'),
    )
    expect(verified).toMatchObject({
      id: pending.id,
      runId: pending.runId,
      verification: { result: 'passed' },
    })
    expect(
      store.recordEvidenceVerification(
        pending.id,
        'owner',
        'verification-passed',
        verification('passed'),
      ).id,
    ).toBe(pending.id)
    const result = store.submitWorkerReport(
      seeded.runId,
      'owner',
      'worker-verify',
      {
        goalRevision: goal.revision,
        reportSequence: 1,
        status: 'ready',
        evidenceRefIds: [pending.id],
        summary: 'Verification completed.',
        limitations: [],
        remainingRisks: [],
      },
    )
    expect(result.completed).toBe(true)
    store.close()
  })

  it('re-reads current Run Evidence inside the ready Report transaction', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedRun(store)
    const goal = store.createGoalContract(
      seeded.taskId,
      'owner',
      'goal-transactional-evidence',
      goalDraft(seeded.eventId),
    )
    expect(store.claimNextRun('worker-race')?.run.id).toBe(seeded.runId)
    store.completeRun(seeded.runId, 'worker-race', {
      executorRef: 'session-race',
      output: 'The Worker captured a stale empty Evidence snapshot.',
    })
    const evidence = store.createEvidenceRef(
      seeded.runId,
      'owner',
      'evidence-after-worker-snapshot',
      observationEvidence(goal.revision, 'passed'),
    )
    const result = store.submitWorkerReport(
      seeded.runId,
      'owner',
      'worker-race',
      {
        goalRevision: goal.revision,
        reportSequence: 0,
        status: 'ready',
        evidenceRefIds: [],
        summary: 'The Control Plane must refresh Evidence transactionally.',
        limitations: [],
        remainingRisks: [],
      },
    )
    expect(result.completed).toBe(true)
    expect(result.report.evidenceRefIds).toEqual([evidence.id])
    expect(result.reviewPack?.criteria[0]?.evidenceRefs).toEqual([evidence.id])
    store.close()
  })

  it('rejects Agent self-claims, old revisions, unrelated users, and incomplete visual evidence', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedRun(store)
    const first = store.createGoalContract(
      seeded.taskId,
      'owner',
      'goal-command-1',
      goalDraft(seeded.eventId),
    )
    const second = store.createGoalContract(
      seeded.taskId,
      'owner',
      'goal-command-2',
      goalDraft(seeded.eventId, 'Updated desired outcome'),
    )
    expect(second.revision).toBe(first.revision + 1)
    const claimed = store.claimNextRun('worker-1')
    expect(claimed?.run.id).toBe(seeded.runId)
    store.completeRun(seeded.runId, 'worker-1', {
      executorRef: 'session-1',
      output: 'Awaiting evidence.',
    })
    expect(() =>
      store.createEvidenceRef(
        seeded.runId,
        'owner',
        'old-evidence',
        observationEvidence(first.revision, 'passed'),
      ),
    ).toThrow('current Goal revision')
    expect(() =>
      store.createEvidenceRef(
        seeded.runId,
        'other',
        'cross-user-evidence',
        observationEvidence(second.revision, 'passed'),
      ),
    ).toThrow('another user')
    expect(() =>
      store.createEvidenceRef(seeded.runId, 'owner', 'visual-without-file', {
        ...observationEvidence(second.revision, 'passed'),
        kind: 'screenshot',
      }),
    ).toThrow('Visual evidence requires an immutable Artifact')

    const pending = store.createEvidenceRef(
      seeded.runId,
      'owner',
      'pending-evidence',
      observationEvidence(second.revision, 'pending'),
    )
    expect(() =>
      store.createEvidenceRef(
        seeded.runId,
        'owner',
        'conflicting-attestation',
        {
          ...observationEvidence(second.revision, 'passed'),
          presentation: { format: 'conflicting' },
        },
      ),
    ).toThrow('conflicting attestation')
    const result = store.submitWorkerReport(seeded.runId, 'owner', 'worker-1', {
      goalRevision: second.revision,
      reportSequence: 1,
      status: 'ready',
      evidenceRefIds: [pending.id],
      summary: 'The Agent says it is done.',
      limitations: [],
      remainingRisks: [],
    })
    expect(result.completed).toBe(false)
    expect(result.reviewPack?.criteria[0]).toMatchObject({
      completionStatus: 'unverified',
    })
    expect(store.findTask(seeded.taskId, 'owner')).toMatchObject({
      status: 'started',
      statusReason: 'awaiting_evidence',
    })
    expect(() =>
      store.createEvidenceRef(seeded.runId, 'owner', 'self-verified-evidence', {
        ...observationEvidence(second.revision, 'passed'),
        producerIdentity: 'control-plane',
      }),
    ).toThrow('cannot be its sole verifier')
    expect(() =>
      store.submitWorkerReport(seeded.runId, 'owner', 'worker-1', {
        goalRevision: second.revision,
        reportSequence: 2,
        status: 'ready',
        evidenceRefIds: [pending.id, pending.id],
        summary: 'One evidence item must not count twice.',
        limitations: [],
        remainingRisks: [],
      }),
    ).toThrow('must be unique')
    store.close()
  })

  it.each([
    {
      status: 'started' as const,
      runStatus: 'running',
      outboxType: undefined,
      reason: undefined,
    },
    {
      status: 'progress' as const,
      runStatus: 'running',
      outboxType: undefined,
      reason: undefined,
    },
    {
      status: 'waiting' as const,
      runStatus: 'waiting',
      outboxType: 'run.waiting',
      reason: 'awaiting_user_input',
    },
    {
      status: 'blocked' as const,
      runStatus: 'waiting',
      outboxType: 'run.blocked',
      reason: 'blocked',
    },
    {
      status: 'failed' as const,
      runStatus: 'failed',
      outboxType: 'run.failed',
      reason: 'last_run_failed',
    },
  ])(
    'applies the $status Worker Report transition atomically',
    ({ status, runStatus, outboxType, reason }) => {
      const store = new PegasStore(':memory:')
      const seeded = seedRun(store)
      const goal = store.createGoalContract(
        seeded.taskId,
        'owner',
        `goal-${status}`,
        goalDraft(seeded.eventId),
      )
      expect(store.claimNextRun(`worker-${status}`)?.run.id).toBe(seeded.runId)

      const result = store.submitWorkerReport(
        seeded.runId,
        'owner',
        `worker-${status}`,
        {
          goalRevision: goal.revision,
          reportSequence: 0,
          status,
          evidenceRefIds: [],
          summary: `${status} report`,
          limitations: [],
          remainingRisks: [],
        },
      )

      expect(result.completed).toBe(false)
      expect(store.listRuns(seeded.taskId)[0]?.status).toBe(runStatus)
      expect(store.findTask(seeded.taskId, 'owner')?.statusReason).toBe(reason)
      expect(
        (
          store.listOutbox('owner').at(-1)?.payload as
            { type?: string } | undefined
        )?.type,
      ).toBe(outboxType)
      expect(store.listWorkerReports(seeded.runId, 'owner')).toHaveLength(1)
      if (status === 'failed')
        expect(store.listReviewPacks(seeded.taskId, 'owner')).toMatchObject([
          { finalOutcome: 'failed' },
        ])
      else expect(store.listReviewPacks(seeded.taskId, 'owner')).toHaveLength(0)
      store.close()
    },
  )

  it('rejects stale Run reports and evidence from another Run', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedRun(store)
    const goal = store.createGoalContract(
      seeded.taskId,
      'owner',
      'goal-stale-run',
      goalDraft(seeded.eventId),
    )
    expect(store.claimNextRun('worker-1')?.run.id).toBe(seeded.runId)
    store.completeRun(seeded.runId, 'worker-1', {
      executorRef: 'session-1',
      output: 'First attempt output.',
    })
    const oldEvidence = store.createEvidenceRef(
      seeded.runId,
      'owner',
      'old-run-evidence',
      observationEvidence(goal.revision, 'passed'),
    )
    store.submitWorkerReport(seeded.runId, 'owner', 'worker-1', {
      goalRevision: goal.revision,
      reportSequence: 1,
      status: 'failed',
      evidenceRefIds: [],
      summary: 'First attempt failed after evidence capture.',
      limitations: [],
      remainingRisks: [],
    })
    const retry = store.retryRun(seeded.runId, 'owner')
    expect(store.claimNextRun('worker-2')?.run.id).toBe(retry.id)
    store.completeRun(retry.id, 'worker-2', {
      executorRef: 'session-2',
      output: 'Second attempt output.',
    })
    expect(
      store.currentReviewPack(seeded.taskId, 'owner', goal.revision),
    ).toBeUndefined()
    const retryEvidence = store.createEvidenceRef(
      retry.id,
      'owner',
      'retry-same-source-evidence',
      observationEvidence(goal.revision, 'passed'),
    )
    expect(retryEvidence.id).not.toBe(oldEvidence.id)
    expect(
      store
        .pageEvidenceRefs(
          seeded.taskId,
          'owner',
          50,
          undefined,
          goal.revision,
          retry.id,
        )
        .items.map(item => item.id),
    ).toEqual([retryEvidence.id])

    expect(() =>
      store.submitWorkerReport(retry.id, 'owner', 'worker-2', {
        goalRevision: goal.revision,
        reportSequence: 1,
        status: 'ready',
        evidenceRefIds: [oldEvidence.id],
        summary: 'Stale evidence must not complete the retry.',
        limitations: [],
        remainingRisks: [],
      }),
    ).toThrow('unrelated evidence')
    expect(() =>
      store.submitWorkerReport(seeded.runId, 'owner', 'worker-1', {
        goalRevision: goal.revision,
        reportSequence: 2,
        status: 'ready',
        evidenceRefIds: [oldEvidence.id],
        summary: 'The stale Run must be fenced.',
        limitations: [],
        remainingRisks: [],
      }),
    ).toThrow('does not own run')
    expect(store.findTask(seeded.taskId, 'owner')).toMatchObject({
      status: 'started',
      statusReason: 'awaiting_evidence',
    })
    store.close()
  })

  it('supersedes older nonterminal Runs when the current Run satisfies the Goal', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedRun(store)
    const goal = store.createGoalContract(
      seeded.taskId,
      'owner',
      'goal-supersede',
      goalDraft(seeded.eventId),
    )
    expect(store.claimNextRun('worker-old')?.run.id).toBe(seeded.runId)
    store.completeRun(seeded.runId, 'worker-old', {
      executorRef: 'session-old',
      output: 'Old attempt is waiting.',
    })
    const continuationEvent = store.enqueueEvent({
      userId: 'owner',
      type: 'message.received',
      source: 'web',
      payload: { text: 'Continue with the final result.' },
    }).event
    const continuation = store.applyRoutingDecision(
      continuationEvent,
      {
        kind: 'continue_task',
        taskId: seeded.taskId,
        input: 'Continue with the final result.',
        reason: 'test continuation',
      },
      'test-executor',
    )
    expect(store.claimNextRun('worker-current')?.run.id).toBe(
      continuation.run.id,
    )
    store.completeRun(continuation.run.id, 'worker-current', {
      executorRef: 'session-current',
      output: 'Current attempt is ready.',
    })
    const evidence = store.createEvidenceRef(
      continuation.run.id,
      'owner',
      'current-run-evidence',
      observationEvidence(goal.revision, 'passed'),
    )
    const result = store.submitWorkerReport(
      continuation.run.id,
      'owner',
      'worker-current',
      {
        goalRevision: goal.revision,
        reportSequence: 1,
        status: 'ready',
        evidenceRefIds: [evidence.id],
        summary: 'The current Run satisfies the Goal.',
        limitations: [],
        remainingRisks: [],
      },
    )
    expect(result.completed).toBe(true)
    expect(store.listRuns(seeded.taskId)).toMatchObject([
      { id: seeded.runId, status: 'cancelled' },
      { id: continuation.run.id, status: 'completed' },
    ])
    store.close()
  })

  it('does not project an older Goal Review Pack as the current delivery', async () => {
    const store = new PegasStore(':memory:')
    const seeded = seedRun(store)
    const first = store.createGoalContract(
      seeded.taskId,
      'owner',
      'goal-v1',
      goalDraft(seeded.eventId, 'First outcome'),
    )
    expect(store.claimNextRun('worker-1')?.run.id).toBe(seeded.runId)
    store.completeRun(seeded.runId, 'worker-1', {
      executorRef: 'session-1',
      output: 'Partial first outcome.',
    })
    const pending = store.createEvidenceRef(
      seeded.runId,
      'owner',
      'pending-v1',
      observationEvidence(first.revision, 'pending'),
    )
    store.submitWorkerReport(seeded.runId, 'owner', 'worker-1', {
      goalRevision: first.revision,
      reportSequence: 1,
      status: 'ready',
      evidenceRefIds: [pending.id],
      summary: 'First revision remains unverified.',
      limitations: [],
      remainingRisks: [],
    })
    const second = store.createGoalContract(
      seeded.taskId,
      'owner',
      'goal-v2',
      goalDraft(seeded.eventId, 'Second outcome'),
    )
    expect(() =>
      store.createEvidenceRef(
        seeded.runId,
        'owner',
        'v2-evidence-on-v1-run',
        observationEvidence(second.revision, 'passed'),
      ),
    ).toThrow('latest Run')
    const successor = store.listRuns(seeded.taskId).at(-1)
    expect(successor).toMatchObject({
      goalRevision: second.revision,
      status: 'queued',
    })
    const server = createControlPlane({ store, apiToken: 'secret' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const response = await fetch(
      `${base}/v1/tasks/${seeded.taskId}/delivery?userId=owner`,
      { headers: { authorization: 'Bearer secret' } },
    )

    expect(response.status).toBe(200)
    const delivery = (await response.json()) as Record<string, unknown>
    expect(delivery).toMatchObject({ goal: { revision: second.revision } })
    expect(delivery).not.toHaveProperty('reviewPack')
    const claimedSuccessor = store.claimNextRun('worker-2')
    expect(claimedSuccessor?.run.id).toBe(successor?.id)
    store.completeRun(successor?.id ?? '', 'worker-2', {
      executorRef: 'session-2',
      output: 'Second Goal revision result.',
    })
    const secondEvidence = store.createEvidenceRef(
      successor?.id ?? '',
      'owner',
      'v2-evidence',
      observationEvidence(second.revision, 'passed'),
    )
    const completed = store.submitWorkerReport(
      successor?.id ?? '',
      'owner',
      'worker-2',
      {
        goalRevision: second.revision,
        reportSequence: 1,
        status: 'ready',
        evidenceRefIds: [secondEvidence.id],
        summary: 'Corrected Goal revision completed.',
        limitations: [],
        remainingRisks: [],
      },
    )
    expect(completed.completed).toBe(true)
  })

  it('exposes idempotent Goal, Artifact, Evidence, Report and delivery APIs', async () => {
    const store = new PegasStore(':memory:')
    const seeded = seedRun(store)
    const server = createControlPlane({ store, apiToken: 'secret' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => Promise.resolve(store.close()),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const headers = {
      authorization: 'Bearer secret',
      'content-type': 'application/json',
    }
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

    const goalResponse = await post(`/v1/tasks/${seeded.taskId}/goals`, {
      userId: 'owner',
      commandId: 'api-goal-1',
      goal: goalDraft(seeded.eventId),
    })
    expect(goalResponse.status).toBe(201)
    const goal = (await goalResponse.json()) as {
      contract: { revision: number }
    }
    const claimed = store.claimNextRun('worker-1')
    expect(claimed?.run.id).toBe(seeded.runId)
    store.completeRun(seeded.runId, 'worker-1', {
      executorRef: 'session-1',
      output: 'Awaiting user acceptance.',
    })
    const goalHistory = await fetch(
      `${base}/v1/tasks/${seeded.taskId}/goals?userId=owner`,
      { headers },
    )
    expect(goalHistory.status).toBe(200)
    expect(await goalHistory.json()).toMatchObject({
      contracts: [{ revision: goal.contract.revision }],
      current: { revision: goal.contract.revision },
    })
    expect(
      (
        await fetch(
          `${base}/v1/tasks/${seeded.taskId}/goals?userId=owner&limit=201`,
          { headers },
        )
      ).status,
    ).toBe(400)
    const artifactResponse = await post(
      `/v1/tasks/${seeded.taskId}/artifacts`,
      {
        userId: 'owner',
        commandId: 'api-artifact-1',
        artifact: {
          runId: seeded.runId,
          name: 'API result',
          kind: 'document',
          mimeType: 'text/plain',
          uri: '/artifacts/api-result.txt',
          revision: 'git:api-result',
          contentHash: 'c'.repeat(64),
          sizeBytes: 10,
          metadata: {},
          sensitivity: 'private',
        },
      },
    )
    expect(artifactResponse.status).toBe(201)
    const artifacts = await fetch(
      `${base}/v1/tasks/${seeded.taskId}/artifacts?userId=owner`,
      { headers },
    )
    expect(artifacts.status).toBe(200)
    expect(await artifacts.json()).toMatchObject({
      artifacts: [{ name: 'API result', revision: 'git:api-result' }],
    })
    const unaccepted = await post(`/v1/runs/${seeded.runId}/evidence`, {
      userId: 'owner',
      commandId: 'api-evidence-unaccepted',
      confirmedForCapture: false,
      evidence: evidenceClaim(
        observationEvidence(goal.contract.revision, 'passed'),
      ),
    })
    expect(unaccepted.status).toBe(400)
    const evidenceResponse = await post(`/v1/runs/${seeded.runId}/evidence`, {
      userId: 'owner',
      commandId: 'api-evidence-1',
      confirmedForCapture: true,
      evidence: evidenceClaim(
        observationEvidence(goal.contract.revision, 'passed'),
      ),
    })
    expect(evidenceResponse.status).toBe(201)
    const evidence = (await evidenceResponse.json()) as {
      evidence: { id: string; verification: { result: string } }
    }
    expect(evidence.evidence.verification.result).toBe('pending')
    store.recordEvidenceVerification(
      evidence.evidence.id,
      'owner',
      'api-verification-1',
      verification('passed'),
    )
    const filteredEvidence = await fetch(
      `${base}/v1/tasks/${seeded.taskId}/evidence?userId=owner&goalRevision=${String(goal.contract.revision)}`,
      { headers },
    )
    expect(filteredEvidence.status).toBe(200)
    expect(await filteredEvidence.json()).toMatchObject({
      evidence: [{ id: evidence.evidence.id }],
    })
    expect(
      (
        await fetch(
          `${base}/v1/tasks/${seeded.taskId}/evidence?userId=owner&goalRevision=invalid`,
          { headers },
        )
      ).status,
    ).toBe(400)
    const reportBody = {
      report: {
        goalRevision: goal.contract.revision,
        reportSequence: 1,
        status: 'ready',
        evidenceRefIds: [evidence.evidence.id],
        summary: 'API delivery ready.',
        limitations: [],
        remainingRisks: [],
      },
    }
    const unauthorizedReport = await fetch(
      `${base}/v1/runs/${seeded.runId}/reports`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify(reportBody),
      },
    )
    expect(unauthorizedReport.status).toBe(403)
    const reportResponse = await fetch(
      `${base}/v1/runs/${seeded.runId}/reports`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pegas-run-claim-token': claimed?.claimToken ?? '',
        },
        body: JSON.stringify(reportBody),
      },
    )
    expect(reportResponse.status).toBe(200)
    const reportDelivery = (await reportResponse.json()) as {
      completed: boolean
      reviewPack: { id: string; finalOutcome: string }
    }
    expect(reportDelivery).toMatchObject({
      completed: true,
      reviewPack: { finalOutcome: 'completed' },
    })
    const retriedReport = await fetch(
      `${base}/v1/runs/${seeded.runId}/reports`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pegas-run-claim-token': claimed?.claimToken ?? '',
        },
        body: JSON.stringify(reportBody),
      },
    )
    expect(retriedReport.status).toBe(200)
    expect(await retriedReport.json()).toMatchObject({
      completed: true,
      reviewPack: { id: reportDelivery.reviewPack.id },
    })
    const invalidClaim = await fetch(
      `${base}/v1/runs/${seeded.runId}/reports`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pegas-run-claim-token': 'invalid-claim',
        },
        body: JSON.stringify(reportBody),
      },
    )
    expect(invalidClaim.status).toBe(403)
    const reports = await fetch(
      `${base}/v1/runs/${seeded.runId}/reports?userId=owner`,
      { headers },
    )
    expect(reports.status).toBe(200)
    expect(await reports.json()).toMatchObject({
      reports: [{ reportSequence: 1, status: 'ready' }],
    })
    const reviewPacks = await fetch(
      `${base}/v1/tasks/${seeded.taskId}/review-packs?userId=owner`,
      { headers },
    )
    expect(reviewPacks.status).toBe(200)
    expect(await reviewPacks.json()).toMatchObject({
      reviewPacks: [{ finalOutcome: 'completed' }],
      current: { finalOutcome: 'completed' },
    })
    const delivery = await fetch(
      `${base}/v1/tasks/${seeded.taskId}/delivery?userId=owner`,
      { headers },
    )
    expect(delivery.status).toBe(200)
    expect(await delivery.json()).toMatchObject({
      goal: { revision: goal.contract.revision },
      artifacts: [],
      evidence: [{ id: evidence.evidence.id }],
      reviewPack: { finalOutcome: 'completed' },
    })
    const lateArtifact = await post(`/v1/tasks/${seeded.taskId}/artifacts`, {
      userId: 'owner',
      commandId: 'api-artifact-after-close',
      artifact: {
        runId: seeded.runId,
        name: 'Late API result',
        kind: 'document',
        revision: 'late',
        contentHash: 'e'.repeat(64),
        metadata: {},
        sensitivity: 'private',
      },
    })
    expect(lateArtifact.status).toBe(400)
    expect(
      (
        await fetch(`${base}/v1/tasks/${seeded.taskId}/delivery?userId=other`, {
          headers,
        })
      ).status,
    ).toBe(400)
    const spoofed = await post(`/v1/runs/${seeded.runId}/evidence`, {
      userId: 'owner',
      commandId: 'api-evidence-spoofed',
      confirmedForCapture: true,
      evidence: observationEvidence(goal.contract.revision, 'passed'),
    })
    expect(spoofed.status).toBe(400)
    for (const path of ['goals', 'artifacts', 'evidence', 'review-packs']) {
      const response = await fetch(
        `${base}/v1/tasks/${seeded.taskId}/${path}?userId=other`,
        { headers },
      )
      expect(response.status).toBe(400)
    }
  })
})

function seedRun(store: PegasStore): {
  eventId: string
  taskId: string
  runId: string
} {
  const event = store.enqueueEvent({
    id: `event-${crypto.randomUUID()}`,
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    payload: { text: 'Build the result.' },
  }).event
  const created = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: 'Build the result',
      goal: 'Build the result',
      input: 'Build the result',
      reason: 'GOAL-001 test',
    },
    'test-executor',
  )
  return {
    eventId: event.id,
    taskId: created.task.id,
    runId: created.run.id,
  }
}

function goalDraft(
  eventId: string,
  desiredOutcome = 'Deliver a verified final UI.',
): GoalContractDraft {
  return {
    basedOnEventIds: [eventId],
    desiredOutcome,
    beneficiaries: ['owner'],
    successCriteria: [
      {
        criterionId: 'criterion-1',
        observableStatement: 'The final result is available and verified.',
        required: true,
        evidencePlanRef: 'plan-1',
      },
    ],
    nonGoals: ['Do not publish externally.'],
    constraints: ['Keep user data private.'],
    contextSources: [
      {
        sourceRef: eventId,
        freshness: 'current',
        authority: 'user',
        conflictPriority: 0,
      },
    ],
    assumptions: [
      {
        statement: 'The owner wants a private result.',
        status: 'user_fact',
        sourceEventId: eventId,
      },
    ],
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

function observationEvidence(
  goalRevision: number,
  result: 'passed' | 'pending' | 'failed',
) {
  return {
    goalRevision,
    criterionId: 'criterion-1',
    kind: 'observation',
    producerIdentity: 'worker-1',
    captureMechanism: 'deterministic-check',
    trustClass: 'control-plane',
    observationSnapshot: {
      observedValue: { available: true },
      sourceObjectId: 'result-1',
      sourceVersion: 'v1',
      issuerIdentity: 'control-plane',
      observedAt: '2026-11-20T00:00:00.000Z',
      snapshotHash: 'b'.repeat(64),
    },
    verification: verification(result),
    environment: { target: 'test' },
    presentation: { format: 'summary' },
    sensitivity: 'private',
    limitations: [],
  }
}

function evidenceClaim(
  evidence: ReturnType<typeof observationEvidence>,
): Omit<ReturnType<typeof observationEvidence>, 'trustClass' | 'verification'> {
  const claim: Partial<ReturnType<typeof observationEvidence>> = {
    ...evidence,
  }
  delete claim.trustClass
  delete claim.verification
  return claim as Omit<
    ReturnType<typeof observationEvidence>,
    'trustClass' | 'verification'
  >
}

function verification(result: 'passed' | 'pending' | 'failed') {
  return {
    method: 'deterministic-check',
    verifierIdentity: 'control-plane',
    verifierVersion: 'v1',
    result,
    verifiedAt: '2026-11-20T00:00:00.000Z',
  }
}
