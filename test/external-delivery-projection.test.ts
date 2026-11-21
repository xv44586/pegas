import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { GoalContractDraft } from '../src/goal/goal-delivery.js'
import {
  DeliveryOutcomeUnknownError,
  type NotificationChannel,
} from '../src/notification/channel.js'
import { externalDeliveryPayload } from '../src/notification/delivery-projection.js'
import { OutboxDispatcher } from '../src/notification/dispatcher.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import type { OutboxMessage } from '../src/core/domain.js'

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
    payload: { text: '交付最终视觉稿' },
  }).event
  const created = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: '交付最终视觉稿',
      goal: '交付最终视觉稿',
      input: '交付最终视觉稿',
      reason: 'external delivery projection test',
    },
    'test-executor',
  )
  const draft: GoalContractDraft = {
    basedOnEventIds: [event.id],
    desiredOutcome: '最终视觉稿可验收',
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
  const claimed = store.claimNextRun('worker-projection')
  if (!claimed) throw new Error('Expected claimed Run')
  store.completeRun(claimed.run.id, 'worker-projection', {
    executorRef: 'session-projection',
    output: 'Captured.',
  })
  return {
    taskId: created.task.id,
    runId: claimed.run.id,
    revision: goal.revision,
  }
}

function seedReviewReady(
  store: PegasStore,
  sensitivity: string,
): { taskId: string; evidenceId: string; message: OutboxMessage } {
  const seeded = seedGoal(store)
  const bytes = pngBytes(1440, 900)
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  const artifact = store.createArtifact(
    seeded.taskId,
    'owner',
    `artifact-${randomUUID()}`,
    {
      runId: seeded.runId,
      name: 'final-ui',
      kind: 'image',
      mimeType: 'image/png',
      uri: '/artifacts/final-ui.png',
      revision: 'rev-1',
      contentHash,
      metadata: {},
      sensitivity,
    },
  )
  const evidence = store.createEvidenceRef(
    seeded.runId,
    'owner',
    `capture-${randomUUID()}`,
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
      sensitivity,
      limitations: ['暗色主题未截图'],
    },
    { artifactBytes: bytes },
  )
  store.submitWorkerReport(seeded.runId, 'owner', 'worker-projection', {
    goalRevision: seeded.revision,
    reportSequence: 1,
    status: 'ready',
    evidenceRefIds: [evidence.id],
    summary: '最终视觉稿已交付',
    limitations: [],
    remainingRisks: ['移动端视口未验证'],
    rollback: { step: 'restore-previous-release' },
  })
  const message = store.listOutbox('owner', seeded.taskId).find(item => {
    const payload = item.payload as { type?: string }
    return payload.type === 'review.ready'
  })
  if (!message) throw new Error('Expected review.ready outbox message')
  return { taskId: seeded.taskId, evidenceId: evidence.id, message }
}

function recordingChannel(external: boolean): {
  channel: NotificationChannel
  delivered: OutboxMessage[]
} {
  const delivered: OutboxMessage[] = []
  return {
    delivered,
    channel: {
      name: external ? 'recording-external' : 'recording-in-app',
      external,
      deliver(message) {
        delivered.push(message)
        return Promise.resolve()
      },
    },
  }
}

function diskStore(): PegasStore {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-delivery-projection-'))
  const store = new PegasStore(join(directory, 'pegas.sqlite'))
  cleanups.push(
    () => store.close(),
    () => rmSync(directory, { recursive: true, force: true }),
  )
  return store
}

describe('NOTIFY-004 external delivery projection', () => {
  it('redacts restricted evidence to an authenticated reference for external channels', () => {
    const store = diskStore()
    const seeded = seedReviewReady(store, 'restricted')
    const projected = externalDeliveryPayload(seeded.message.payload) as {
      type: string
      reviewPackId: string
      review: {
        finalOutcome: string
        criteria: unknown[]
        evidence: Record<string, unknown>[]
        redactedEvidenceCount: number
        remainingRisks: string[]
        auditLink: string
        rollback?: unknown
      }
    }
    expect(projected.type).toBe('review.ready')
    expect(projected.review.finalOutcome).toBe('completed')
    expect(projected.review.criteria).toHaveLength(1)
    expect(projected.review.redactedEvidenceCount).toBe(1)
    expect(projected.review.evidence[0]).toEqual({
      evidenceId: seeded.evidenceId,
      kind: 'screenshot',
      verification: 'passed',
      sensitivity: 'restricted',
      redacted: true,
      previewRef: `/v1/evidence/${seeded.evidenceId}/content`,
    })
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain('contentHash')
    expect(serialized).not.toContain('viewport')
    expect(serialized).not.toContain('final-ui')
    expect(serialized).not.toContain('暗色主题未截图')
    expect(serialized).not.toContain('restore-previous-release')
    expect(projected.review.auditLink).toContain(seeded.taskId)
  })

  it('keeps private evidence previewable metadata but never embeds bytes or local paths', () => {
    const store = diskStore()
    const seeded = seedReviewReady(store, 'private')
    const projected = externalDeliveryPayload(seeded.message.payload) as {
      review: { evidence: Record<string, unknown>[] }
    }
    expect(projected.review.evidence[0]).toEqual(
      expect.objectContaining({
        evidenceId: seeded.evidenceId,
        sensitivity: 'private',
        redacted: false,
        contentHash: expect.any(String) as unknown,
        artifactRevision: 'rev-1',
        viewport: { width: 1440, height: 900 },
        artifactName: 'final-ui',
        previewRef: `/v1/evidence/${seeded.evidenceId}/content`,
      }),
    )
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain('/artifacts/final-ui.png')
    expect(serialized).not.toContain('hasContent')
    expect(serialized).not.toContain('iVBOR')
  })

  it('fails closed for unknown sensitivity labels', () => {
    const projected = externalDeliveryPayload({
      type: 'review.ready',
      review: {
        evidence: [{ evidenceId: 'e-1', sensitivity: 'top-secret' }],
      },
    }) as { review: { evidence: Record<string, unknown>[] } }
    expect(projected.review.evidence[0]?.redacted).toBe(true)
  })

  it('passes non-review payloads through unchanged', () => {
    const payload = { type: 'run.failed', taskId: 't-1', error: 'boom' }
    expect(externalDeliveryPayload(payload)).toBe(payload)
    expect(externalDeliveryPayload('plain')).toBe('plain')
  })
})

describe('NOTIFY-004 dispatcher applies projection only to external channels', () => {
  it('external channel receives the redacted projection; the durable row keeps the full preview', async () => {
    const store = diskStore()
    const seeded = seedReviewReady(store, 'restricted')
    const { channel, delivered } = recordingChannel(true)
    const dispatcher = new OutboxDispatcher({
      store,
      channel,
      dispatcherId: 'dispatcher-projection',
    })
    let worked = await dispatcher.dispatchNext()
    while (worked) worked = await dispatcher.dispatchNext()
    const reviewDelivery = delivered.find(
      item => (item.payload as { type?: string }).type === 'review.ready',
    )
    if (!reviewDelivery) throw new Error('Expected review.ready delivery')
    const deliveredReview = (
      reviewDelivery.payload as {
        review: { evidence: Record<string, unknown>[] }
      }
    ).review
    expect(deliveredReview.evidence[0]?.redacted).toBe(true)
    expect(JSON.stringify(reviewDelivery.payload)).not.toContain('contentHash')
    const durable = store
      .listOutbox('owner', seeded.taskId)
      .find(item => item.id === seeded.message.id)
    const durableReview = (
      durable?.payload as {
        review: { evidence: Record<string, unknown>[] }
      }
    ).review
    expect(durableReview.evidence[0]?.contentHash).toEqual(expect.any(String))
    expect(durableReview.evidence[0]?.hasContent).toBe(true)
    expect(durable?.status).toBe('sent')
  })

  it('in-app trusted channel keeps the full preview projection', async () => {
    const store = diskStore()
    seedReviewReady(store, 'restricted')
    const { channel, delivered } = recordingChannel(false)
    const dispatcher = new OutboxDispatcher({
      store,
      channel,
      dispatcherId: 'dispatcher-in-app',
    })
    let worked = await dispatcher.dispatchNext()
    while (worked) worked = await dispatcher.dispatchNext()
    const reviewDelivery = delivered.find(
      item => (item.payload as { type?: string }).type === 'review.ready',
    )
    if (!reviewDelivery) throw new Error('Expected review.ready delivery')
    const deliveredReview = (
      reviewDelivery.payload as {
        review: { evidence: Record<string, unknown>[] }
      }
    ).review
    expect(deliveredReview.evidence[0]?.contentHash).toEqual(expect.any(String))
    expect(deliveredReview.evidence[0]?.hasContent).toBe(true)
  })

  it('projection does not change unknown-outcome parking semantics', async () => {
    const store = diskStore()
    const seeded = seedReviewReady(store, 'private')
    const channel: NotificationChannel = {
      name: 'flaky-external',
      external: true,
      deliver() {
        return Promise.reject(new DeliveryOutcomeUnknownError('lost ack'))
      },
    }
    const dispatcher = new OutboxDispatcher({
      store,
      channel,
      dispatcherId: 'dispatcher-unknown',
    })
    let worked = await dispatcher.dispatchNext()
    while (worked) worked = await dispatcher.dispatchNext()
    const durable = store
      .listOutbox('owner', seeded.taskId)
      .find(item => item.id === seeded.message.id)
    expect(durable?.status).toBe('unknown')
  })
})
