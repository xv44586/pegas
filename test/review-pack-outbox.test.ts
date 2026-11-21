import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { GoalContractDraft } from '../src/goal/goal-delivery.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function seedGoal(store: PegasStore): {
  taskId: string
  runId: string
  revision: number
} {
  const event = store.enqueueEvent({
    id: `event-${randomUUID()}`,
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: '交付最终 UI' },
  }).event
  const created = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: '交付最终 UI',
      goal: '交付最终 UI',
      input: '交付最终 UI',
      reason: 'review pack outbox test',
    },
    'test-executor',
  )
  const draft: GoalContractDraft = {
    basedOnEventIds: [event.id],
    desiredOutcome: '最终 UI 可验收',
    beneficiaries: ['owner'],
    successCriteria: [
      {
        criterionId: 'criterion-1',
        observableStatement: '最终截图已验证',
        required: true,
        evidencePlanRef: 'plan-1',
      },
    ],
    nonGoals: [],
    constraints: [],
    contextSources: [
      {
        sourceRef: event.id,
        freshness: 'current',
        authority: 'user',
        conflictPriority: 0,
      },
    ],
    assumptions: [],
    unknowns: [],
    prerequisites: [],
    permissionBoundary: {},
    reviewCheckpoints: ['final'],
    evidencePlan: [
      {
        id: 'plan-1',
        criterionId: 'criterion-1',
        acceptedKinds: ['screenshot'],
        acceptedTrustClasses: ['control-plane'],
        minimumCount: 1,
        presentation: 'preview',
      },
    ],
    failureAndRecovery: '重新截图',
    feedbackSignals: [],
  }
  const goal = store.createGoalContract(
    created.task.id,
    'owner',
    `goal-${randomUUID()}`,
    draft,
  )
  const claimed = store.claimNextRun('worker-review')
  if (!claimed) throw new Error('Expected claimed Run')
  store.completeRun(claimed.run.id, 'worker-review', {
    executorRef: 'session-review',
    output: 'Captured.',
  })
  return {
    taskId: created.task.id,
    runId: claimed.run.id,
    revision: goal.revision,
  }
}

describe('NOTIFY-004 Review Pack Outbox preview', () => {
  it('aggregates criteria, evidence previews, risks, rollback and audit entry into review.ready', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-review-outbox-'))
    const store = new PegasStore(join(directory, 'pegas.sqlite'))
    cleanups.push(
      () => store.close(),
      () => rmSync(directory, { recursive: true, force: true }),
    )
    const seeded = seedGoal(store)
    const bytes = pngBytes(1440, 900)
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    const artifact = store.createArtifact(
      seeded.taskId,
      'owner',
      'artifact-1',
      {
        runId: seeded.runId,
        name: 'Final UI',
        kind: 'image',
        mimeType: 'image/png',
        uri: '/artifacts/final-ui.png',
        revision: 'rev-1',
        contentHash,
        metadata: {},
        sensitivity: 'private',
      },
    )
    const evidence = store.createEvidenceRef(
      seeded.runId,
      'owner',
      'capture-1',
      {
        goalRevision: seeded.revision,
        criterionId: 'criterion-1',
        kind: 'screenshot',
        artifactId: artifact.id,
        producerIdentity: 'worker-1',
        captureMechanism: 'playwright',
        trustClass: 'control-plane',
        verification: {
          method: 'visual-container-viewport-check',
          verifierIdentity: 'pegas-control-plane-verifier',
          verifierVersion: 'v1',
          result: 'passed',
          verifiedAt: '2026-11-21T00:00:00.000Z',
        },
        environment: { viewport: { width: 1440, height: 900 } },
        presentation: { alt: 'Final UI screenshot' },
        sensitivity: 'private',
        limitations: ['暗色主题未截图'],
      },
      { artifactBytes: bytes },
    )
    const result = store.submitWorkerReport(
      seeded.runId,
      'owner',
      'worker-review',
      {
        goalRevision: seeded.revision,
        reportSequence: 1,
        status: 'ready',
        evidenceRefIds: [evidence.id],
        summary: '最终 UI 已交付',
        limitations: [],
        remainingRisks: ['移动端视口未验证'],
        rollback: { step: 'restore-previous-release' },
      },
    )
    expect(result.completed).toBe(true)
    const message = store.listOutbox('owner', seeded.taskId).find(item => {
      const payload = item.payload as { type?: string }
      return payload.type === 'review.ready'
    })
    if (!message) throw new Error('Expected review.ready outbox message')
    const payload = message.payload as {
      reviewPackId: string
      review: {
        finalOutcome: string
        goalRevision: number
        criteria: {
          criterionId: string
          completionStatus: string
          explanation: string
          limitations: string[]
          evidenceCount: number
        }[]
        evidence: {
          evidenceId: string
          kind: string
          verification: string
          artifact?: {
            id: string
            revision: string
            mimeType?: string
            uri?: string
          }
          presentation: Record<string, unknown>
          limitations: string[]
        }[]
        remainingRisks: string[]
        rollback?: Record<string, unknown>
        auditLink: string
      }
    }
    expect(payload.review.finalOutcome).toBe('completed')
    expect(payload.review.goalRevision).toBe(seeded.revision)
    expect(payload.review.criteria).toEqual([
      expect.objectContaining({
        criterionId: 'criterion-1',
        completionStatus: 'satisfied',
        evidenceCount: 1,
        limitations: ['暗色主题未截图'],
      }),
    ])
    expect(payload.review.evidence).toEqual([
      expect.objectContaining({
        evidenceId: evidence.id,
        kind: 'screenshot',
        verification: 'passed',
        artifact: expect.objectContaining({
          id: artifact.id,
          revision: 'rev-1',
          mimeType: 'image/png',
          uri: '/artifacts/final-ui.png',
        }) as unknown,
        limitations: ['暗色主题未截图'],
      }),
    ])
    expect(payload.review.remainingRisks).toEqual(['移动端视口未验证'])
    expect(payload.review.rollback).toEqual({
      step: 'restore-previous-release',
    })
    expect(payload.review.auditLink).toContain(seeded.taskId)
    expect(payload.review.evidence[0]).toEqual(
      expect.objectContaining({
        sensitivity: 'private',
        contentHash: expect.any(String) as unknown,
        artifactRevision: 'rev-1',
        viewport: { width: 1440, height: 900 },
        hasContent: true,
      }),
    )
    // Execution logs and hidden capture environment data never enter the
    // preview; only the curated viewport dimensions are projected.
    expect(JSON.stringify(payload.review)).not.toContain('environment')
    expect(JSON.stringify(payload.review)).not.toContain('playwright')
  })

  it('keeps partial deliveries explicit about unverified criteria', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const seeded = seedGoal(store)
    const result = store.submitWorkerReport(
      seeded.runId,
      'owner',
      'worker-review',
      {
        goalRevision: seeded.revision,
        reportSequence: 1,
        status: 'ready',
        evidenceRefIds: [],
        summary: '尚无证据',
        limitations: [],
        remainingRisks: ['缺少最终截图'],
      },
    )
    expect(result.completed).toBe(false)
    const pack = result.reviewPack
    expect(pack?.finalOutcome).toBe('partial')
    // Partial reports do not emit review.ready; the Task stays awaiting evidence.
    const messages = store.listOutbox('owner', seeded.taskId)
    expect(
      messages.some(
        item => (item.payload as { type?: string }).type === 'review.ready',
      ),
    ).toBe(false)
    expect(store.findTask(seeded.taskId, 'owner')?.statusReason).toBe(
      'awaiting_evidence',
    )
  })
})
