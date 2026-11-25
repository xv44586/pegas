import { describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'

import { createControlPlane } from '../src/control-plane/server.js'
import type { GoalContractDraft } from '../src/goal/goal-delivery.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

describe('derived memory durable jobs', () => {
  it('atomically enqueues one idempotent retain job when a work Run completes', () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const claimed = createClaimedRun(store, 'owner', 'worker')
    store.completeRun(claimed.run.id, 'worker', {
      executorRef: 'session',
      output: '实现完成，验证通过',
    })

    const job = store.claimNextDerivedMemoryJob('memory-worker', 30_000)
    expect(job).toMatchObject({
      userId: 'owner',
      taskId: claimed.task.id,
      runId: claimed.run.id,
      kind: 'run_success',
      documentId: `pegas:run:${claimed.run.id}`,
      attempts: 1,
    })
    expect(job?.content).toContain('实现完成，验证通过')
    expect(job?.content).not.toContain('sk-proj-abc123def456ghi789jkl012')
    expect(
      store.claimNextDerivedMemoryJob('other-worker', 30_000),
    ).toBeUndefined()

    store.markDerivedMemoryJobSubmitted(
      job?.id ?? '',
      'memory-worker',
      'provider-operation',
    )
    const polling = store.claimNextDerivedMemoryJob('memory-worker', 30_000)
    expect(polling?.providerOperationId).toBe('provider-operation')
    store.completeDerivedMemoryJob(polling?.id ?? '', 'memory-worker')
    expect(
      store.claimNextDerivedMemoryJob('memory-worker', 30_000),
    ).toBeUndefined()
    store.close()
  })

  it('records observed failure without inventing a cause', () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const claimed = createClaimedRun(store, 'owner', 'worker')
    store.failRun(claimed.run.id, 'worker', 'command exited with status 2')
    const job = store.claimNextDerivedMemoryJob('memory-worker', 30_000)
    expect(job).toMatchObject({ kind: 'run_failure' })
    expect(job?.content).toContain(
      'Observed failure: command exited with status 2',
    )
    expect(job?.content).not.toContain('Root cause')
    store.close()
  })

  it('redacts common credential formats before evidence leaves Pegas', () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const secrets = [
      'ghp_' + 'A'.repeat(36),
      'github_pat_' + 'B'.repeat(50),
      'AKIA' + 'C'.repeat(16),
      'xoxb-' + '123456789012-abcdef',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
      'postgres://admin:pass@db.internal/app',
      'password is Hunter2Hunter2',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    ]
    const claimed = createClaimedRun(store, 'owner', 'worker')
    store.completeRun(claimed.run.id, 'worker', {
      executorRef: 'session',
      output: `deploy finished\n${secrets.join('\n')}`,
    })
    const job = store.claimNextDerivedMemoryJob('memory-worker', 30_000)
    expect(job?.content).toContain('deploy finished')
    expect(job?.content).toContain('[REDACTED_CREDENTIAL]')
    for (const secret of secrets) {
      expect(job?.content).not.toContain(secret)
    }
    expect(job?.content).not.toContain('superSecret123')
    expect(job?.content).not.toContain('Hunter2Hunter2')
    expect(job?.content).not.toContain('MIIEpAIBAAKCAQEA')
    store.close()
  })

  it('does not retain a waiting goal Run as a verified success', () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const seeded = createClaimedRun(store, 'owner', 'worker')
    store.completeRun(seeded.run.id, 'worker', {
      executorRef: 'session',
      output: 'first result',
    })
    store.claimNextDerivedMemoryJob('memory-worker', 30_000)
    const continued = continueMemoryTask(store, seeded.task.id)
    const goal = store.createGoalContract(
      seeded.task.id,
      'owner',
      'goal-waiting-memory',
      memoryGoalDraft(continued.eventId),
    )
    const goalRun = store.claimNextRun('worker')
    if (!goalRun) throw new Error('Expected goal Run')
    store.completeRun(goalRun.run.id, 'worker', {
      executorRef: 'session',
      output: 'unverified draft output',
    })
    expect(store.listRuns(seeded.task.id).at(-1)).toMatchObject({
      status: 'waiting',
    })
    expect(
      store.claimNextDerivedMemoryJob('memory-worker', 30_000),
    ).toBeUndefined()

    const failed = store.submitWorkerReport(goalRun.run.id, 'owner', 'worker', {
      goalRevision: goal.revision,
      reportSequence: 0,
      status: 'failed',
      evidenceRefIds: [],
      summary: 'verification failed: output missing',
      limitations: [],
      remainingRisks: [],
    })
    expect(failed.completed).toBe(false)
    const failureJob = store.claimNextDerivedMemoryJob('memory-worker', 30_000)
    expect(failureJob).toMatchObject({
      runId: goalRun.run.id,
      kind: 'run_failure',
    })
    expect(failureJob?.content).toContain(
      'Observed failure: verification failed: output missing',
    )
    expect(failureJob?.content).not.toContain('Verified outcome')
    store.close()
  })

  it('retains the verified goal outcome only after the review completes', () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const seeded = createClaimedRun(store, 'owner', 'worker')
    store.completeRun(seeded.run.id, 'worker', {
      executorRef: 'session',
      output: 'first result',
    })
    store.claimNextDerivedMemoryJob('memory-worker', 30_000)
    const continued = continueMemoryTask(store, seeded.task.id)
    const goal = store.createGoalContract(
      seeded.task.id,
      'owner',
      'goal-verified-memory',
      memoryGoalDraft(continued.eventId),
    )
    const goalRun = store.claimNextRun('worker')
    if (!goalRun) throw new Error('Expected goal Run')
    store.completeRun(goalRun.run.id, 'worker', {
      executorRef: 'session',
      output: 'verified draft output',
    })
    expect(
      store.claimNextDerivedMemoryJob('memory-worker', 30_000),
    ).toBeUndefined()
    const evidence = store.createEvidenceRef(
      goalRun.run.id,
      'owner',
      'goal-memory-evidence',
      memoryObservationEvidence(goal.revision),
    )
    const result = store.submitWorkerReport(goalRun.run.id, 'owner', 'worker', {
      goalRevision: goal.revision,
      reportSequence: 0,
      status: 'ready',
      evidenceRefIds: [evidence.id],
      summary: 'verified final outcome',
      limitations: [],
      remainingRisks: [],
    })
    expect(result.completed).toBe(true)
    const successJob = store.claimNextDerivedMemoryJob('memory-worker', 30_000)
    expect(successJob).toMatchObject({
      runId: goalRun.run.id,
      kind: 'run_success',
    })
    expect(successJob?.content).toContain(
      'Verified outcome: verified final outcome',
    )
    store.close()
  })

  it('requeues provider invalidation when a restore revives a deleted memory', () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const claimed = createClaimedRun(store, 'owner', 'worker')
    const revived = {
      id: 'memory-restored',
      text: 'deleted personal fact',
      type: 'world' as const,
      tags: ['pegas:global'],
      metadata: {},
      state: 'valid' as const,
    }
    store.recordDerivedMemoryRecall(claimed.run.id, 'owner', [revived])
    store.tombstoneDerivedMemory('owner', 'memory-restored', 'user deleted')
    const curation = store.claimNextDerivedMemoryCurationJob(
      'memory-worker',
      30_000,
    )
    if (!curation) throw new Error('Expected curation job')
    store.completeDerivedMemoryCurationJob(curation.id, 'memory-worker')
    expect(
      store.claimNextDerivedMemoryCurationJob('memory-worker', 30_000),
    ).toBeUndefined()

    store.replaceDerivedMemoryCache('owner', [revived])
    expect(store.listDerivedMemories('owner')).toEqual([])
    const requeued = store.claimNextDerivedMemoryCurationJob(
      'memory-worker',
      30_000,
    )
    expect(requeued).toMatchObject({
      userId: 'owner',
      memoryId: 'memory-restored',
      memoryType: 'world',
      attempts: 1,
    })
    store.close()
  })

  it('keeps tombstoned derived memories out of later recall projections', () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const claimed = createClaimedRun(store, 'owner', 'worker')
    store.recordDerivedMemoryRecall(claimed.run.id, 'owner', [
      {
        id: 'memory-1',
        text: 'use pnpm',
        type: 'world',
        tags: ['pegas:global'],
        metadata: { task_id: claimed.task.id },
      },
    ])
    expect(store.listDerivedMemories('owner')).toHaveLength(1)

    store.tombstoneDerivedMemory('owner', 'memory-1', 'user deleted')
    store.recordDerivedMemoryRecall(claimed.run.id, 'owner', [
      {
        id: 'memory-1',
        text: 'use pnpm',
        type: 'world',
        tags: ['pegas:global'],
        metadata: { task_id: claimed.task.id },
      },
    ])
    expect(store.listDerivedMemories('owner')).toEqual([])
    store.close()
  })

  it('suppresses regenerated memories with the same normalized content', () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const claimed = createClaimedRun(store, 'owner', 'worker')
    store.recordDerivedMemoryRecall(claimed.run.id, 'owner', [
      {
        id: 'old-id',
        text: 'Always use PNPM for this repository.',
        type: 'world',
        tags: ['pegas:global'],
        metadata: {},
      },
    ])
    store.tombstoneDerivedMemory('owner', 'old-id', 'user deleted')

    const regenerated = {
      id: 'new-id',
      text: '  always   use pnpm for this repository.  ',
      type: 'world' as const,
      tags: ['pegas:global'],
      metadata: {},
    }
    expect(store.isDerivedMemorySuppressed('owner', regenerated)).toBe(true)
    store.recordDerivedMemoryRecall(claimed.run.id, 'owner', [regenerated])
    expect(store.listDerivedMemories('owner')).toEqual([])
    store.close()
  })

  it('reconciles a complete provider listing and records sync health', () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const claimed = createClaimedRun(store, 'owner', 'worker')
    store.recordDerivedMemoryRecall(claimed.run.id, 'owner', [
      {
        id: 'stale',
        text: 'stale projection',
        type: 'world',
        tags: ['pegas:global'],
        metadata: {},
      },
    ])

    store.replaceDerivedMemoryCache('owner', [
      {
        id: 'current',
        text: 'current provider fact',
        type: 'experience',
        tags: ['pegas:global'],
        metadata: {},
        state: 'valid',
      },
    ])

    expect(store.listDerivedMemories('owner').map(memory => memory.id)).toEqual(
      ['current'],
    )
    expect(store.derivedMemorySyncState('owner')).toMatchObject({
      status: 'healthy',
      memoryCount: 1,
    })
    store.close()
  })

  it('exposes derived-memory browse and delete without an approval prompt', async () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const claimed = createClaimedRun(store, 'owner', 'worker')
    store.recordDerivedMemoryRecall(claimed.run.id, 'owner', [
      {
        id: 'memory/http',
        text: 'use pnpm',
        type: 'world',
        tags: ['pegas:global'],
        metadata: {},
      },
    ])
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const list = await fetch(`${base}/v1/derived-memories?userId=owner`)
    expect(await list.json()).toMatchObject({
      memories: [{ id: 'memory/http', text: 'use pnpm' }],
    })
    const deletion = await fetch(
      `${base}/v1/derived-memories/${encodeURIComponent('memory/http')}/delete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'owner' }),
      },
    )
    expect(await deletion.json()).toEqual({
      deletion: { id: 'memory/http', deleted: true },
    })
    expect(store.listDerivedMemories('owner')).toEqual([])
    expect(
      store.claimNextDerivedMemoryCurationJob('memory-worker', 30_000),
    ).toMatchObject({ userId: 'owner', memoryId: 'memory/http' })
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
  })

  it('accepts an idempotent user correction without creating approval work', async () => {
    const store = new PegasStore(':memory:', { derivedMemoryEnabled: true })
    const claimed = createClaimedRun(store, 'owner', 'worker')
    store.recordDerivedMemoryRecall(claimed.run.id, 'owner', [
      {
        id: 'memory-to-correct',
        text: 'Use npm.',
        type: 'world',
        tags: ['pegas:global'],
        metadata: { task_id: claimed.task.id },
      },
    ])
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const body = {
      userId: 'owner',
      commandId: 'correct-command',
      correction: 'Use pnpm.',
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(
        `${base}/v1/derived-memories/memory-to-correct/correct`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      expect(response.status).toBe(202)
      expect(await response.json()).toMatchObject({
        correction: {
          memoryId: 'memory-to-correct',
          status: 'pending',
        },
      })
    }

    expect(
      store.claimNextDerivedMemoryCorrectionJob('memory-worker', 30_000),
    ).toMatchObject({
      userId: 'owner',
      memoryId: 'memory-to-correct',
      replacementText: 'Use pnpm.',
    })
    expect(
      store.claimNextDerivedMemoryCurationJob('curation-worker', 30_000),
    ).toMatchObject({
      userId: 'owner',
      memoryId: 'memory-to-correct',
      memoryType: 'world',
      reason: 'Superseded by a user correction',
    })
    expect(
      store.pageApprovals('owner', 10, undefined, 'pending').items,
    ).toEqual([])
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
  })
})

function createClaimedRun(store: PegasStore, userId: string, workerId: string) {
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: {
      text: 'Implement memory without leaking sk-proj-abc123def456ghi789jkl012',
    },
  }).event
  const task = store.createTaskFromEvent(event, 'Memory integration')
  store.applyRoutingDecision(
    event,
    {
      kind: 'continue_task',
      taskId: task.id,
      input:
        'Implement memory without leaking sk-proj-abc123def456ghi789jkl012',
      reason: 'test',
    },
    'test-executor',
    () => ({ executor: 'test-executor', workspace: '/workspace/project' }),
  )
  const claimed = store.claimNextRun(workerId)
  if (!claimed) throw new Error('Expected claimed Run')
  return claimed
}

function continueMemoryTask(
  store: PegasStore,
  taskId: string,
): { eventId: string; runId: string } {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: 'Verify the final result', taskId },
  }).event
  const continued = store.applyRoutingDecision(
    event,
    {
      kind: 'continue_task',
      taskId,
      input: 'Verify the final result',
      reason: 'memory goal test',
    },
    'test-executor',
    () => ({ executor: 'test-executor', workspace: '/workspace/project' }),
  )
  return { eventId: event.id, runId: continued.run.id }
}

function memoryGoalDraft(eventId: string): GoalContractDraft {
  return {
    basedOnEventIds: [eventId],
    desiredOutcome: 'Deliver a verified result.',
    beneficiaries: ['owner'],
    successCriteria: [
      {
        criterionId: 'criterion-1',
        observableStatement: 'The final result is available and verified.',
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
        acceptedKinds: ['observation'],
        acceptedTrustClasses: ['control-plane', 'independent', 'user'],
        minimumCount: 1,
        presentation: 'inline',
      },
    ],
    failureAndRecovery: 'Keep the Task open and request valid evidence.',
    feedbackSignals: ['user_acceptance'],
  }
}

function memoryObservationEvidence(goalRevision: number) {
  return {
    goalRevision,
    criterionId: 'criterion-1',
    kind: 'observation' as const,
    producerIdentity: 'worker',
    captureMechanism: 'deterministic-check',
    trustClass: 'control-plane' as const,
    observationSnapshot: {
      observedValue: { available: true },
      sourceObjectId: 'result-1',
      sourceVersion: 'v1',
      issuerIdentity: 'control-plane',
      observedAt: '2026-11-25T00:00:00.000Z',
      snapshotHash: 'b'.repeat(64),
    },
    verification: {
      method: 'deterministic-check',
      verifierIdentity: 'pegas-control-plane-verifier',
      verifierVersion: 'v1',
      result: 'passed' as const,
      verifiedAt: '2026-11-25T00:00:00.000Z',
    },
    environment: { target: 'test' },
    presentation: { format: 'summary' as const },
    sensitivity: 'private' as const,
    limitations: [],
  }
}
