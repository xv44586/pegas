import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type { GoalContractDraft } from '../src/goal/goal-delivery.js'
import { trustedVerifierIdentity } from '../src/goal/goal-delivery.js'
import { verifyVisualEvidence } from '../src/goal/trusted-verifier.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Builds a structurally valid PNG container with the given dimensions. */
function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function gifBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(13)
  bytes.write('GIF89a', 0, 'ascii')
  bytes.writeUInt16LE(width, 6)
  bytes.writeUInt16LE(height, 8)
  return bytes
}

function jpegBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(20)
  bytes[0] = 0xff
  bytes[1] = 0xd8
  bytes[2] = 0xff
  bytes[3] = 0xc0
  bytes.writeUInt16BE(17, 4)
  bytes[6] = 8
  bytes.writeUInt16BE(height, 7)
  bytes.writeUInt16BE(width, 9)
  return bytes
}

function webpVp8xBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'ascii')
  bytes.write('WEBP', 8, 'ascii')
  bytes.write('VP8X', 12, 'ascii')
  bytes.writeUIntLE(width - 1, 24, 3)
  bytes.writeUIntLE(height - 1, 27, 3)
  return bytes
}

function seedGoal(store: PegasStore): {
  taskId: string
  runId: string
  eventId: string
  revision: number
} {
  const event = store.enqueueEvent({
    id: `event-${randomUUID()}`,
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: '交付最终 UI 截图' },
  }).event
  const created = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: '交付最终 UI',
      goal: '交付最终 UI',
      input: '交付最终 UI',
      reason: 'trusted verifier test',
    },
    'test-executor',
  )
  const draft: GoalContractDraft = {
    basedOnEventIds: [event.id],
    desiredOutcome: '最终 UI 截图可验证',
    beneficiaries: ['owner'],
    successCriteria: [
      {
        criterionId: 'criterion-1',
        observableStatement: '最终截图与声明视口一致',
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
        acceptedKinds: ['screenshot', 'observation'],
        acceptedTrustClasses: ['control-plane', 'user'],
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
  const claimed = store.claimNextRun('worker-verifier')
  if (!claimed) throw new Error('Expected claimed Run')
  store.completeRun(claimed.run.id, 'worker-verifier', {
    executorRef: 'session-verifier',
    output: 'Captured; awaiting trusted verification.',
  })
  return {
    taskId: created.task.id,
    runId: claimed.run.id,
    eventId: event.id,
    revision: goal.revision,
  }
}

function screenshotDraft(
  revision: number,
  artifactId: string,
  viewport: { width: number; height: number },
) {
  return {
    goalRevision: revision,
    criterionId: 'criterion-1',
    kind: 'screenshot',
    artifactId,
    producerIdentity: 'worker-1',
    captureMechanism: 'playwright',
    trustClass: 'control-plane',
    verification: {
      method: 'awaiting-trusted-verification',
      verifierIdentity: 'pending',
      verifierVersion: 'v1',
      result: 'pending' as const,
    },
    environment: { viewport },
    presentation: { alt: 'Final UI' },
    sensitivity: 'private',
    limitations: [],
  }
}

describe('GOAL-001 trusted verifier identity gate', () => {
  it('rejects passed evidence and verification from untrusted identities', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const seeded = seedGoal(store)
    expect(() =>
      store.createEvidenceRef(seeded.runId, 'owner', 'forged-pass', {
        goalRevision: seeded.revision,
        criterionId: 'criterion-1',
        kind: 'observation',
        producerIdentity: 'worker-1',
        captureMechanism: 'model-claim',
        trustClass: 'control-plane',
        observationSnapshot: {
          observedValue: { done: true },
          sourceObjectId: 'result-1',
          issuerIdentity: 'worker-1',
          observedAt: '2026-11-21T00:00:00.000Z',
          snapshotHash: 'c'.repeat(64),
        },
        verification: {
          method: 'deterministic-check',
          verifierIdentity: 'worker-9',
          verifierVersion: 'v1',
          result: 'passed',
          verifiedAt: '2026-11-21T00:00:00.000Z',
        },
        environment: {},
        presentation: {},
        sensitivity: 'private',
        limitations: [],
      }),
    ).toThrow('in-process trusted verifier')

    const pending = store.createEvidenceRef(
      seeded.runId,
      'owner',
      'pending-1',
      {
        goalRevision: seeded.revision,
        criterionId: 'criterion-1',
        kind: 'observation',
        producerIdentity: 'worker-1',
        captureMechanism: 'deterministic-check',
        trustClass: 'control-plane',
        observationSnapshot: {
          observedValue: { done: true },
          sourceObjectId: 'result-2',
          issuerIdentity: 'control-plane',
          observedAt: '2026-11-21T00:00:00.000Z',
          snapshotHash: 'd'.repeat(64),
        },
        verification: {
          method: 'awaiting-trusted-verification',
          verifierIdentity: 'pending',
          verifierVersion: 'v1',
          result: 'pending',
        },
        environment: {},
        presentation: {},
        sensitivity: 'private',
        limitations: [],
      },
    )
    expect(() =>
      store.recordEvidenceVerification(pending.id, 'owner', 'forge-verify', {
        method: 'deterministic-check',
        verifierIdentity: 'independent-party',
        verifierVersion: 'v1',
        result: 'passed',
        verifiedAt: '2026-11-21T00:00:00.000Z',
      }),
    ).toThrow('in-process trusted verifier')
    // Failed results from other identities remain appendable audit facts.
    const failed = store.recordEvidenceVerification(
      pending.id,
      'owner',
      'external-failed',
      {
        method: 'external-audit',
        verifierIdentity: 'independent-party',
        verifierVersion: 'v1',
        result: 'failed',
        verifiedAt: '2026-11-21T00:00:00.000Z',
      },
    )
    expect(failed.verification.result).toBe('failed')
  })
})

describe('GOAL-001 deterministic visual verifier', () => {
  it('verifies attested bytes, container signature and viewport dimensions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-verifier-'))
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
        revision: 'rev-1',
        contentHash,
        sizeBytes: bytes.byteLength,
        metadata: {},
        sensitivity: 'private',
      },
    )
    const evidence = store.createEvidenceRef(
      seeded.runId,
      'owner',
      'capture-1',
      screenshotDraft(seeded.revision, artifact.id, {
        width: 1440,
        height: 900,
      }),
      { artifactBytes: bytes },
    )
    expect(evidence.verification.result).toBe('pending')

    const verified = store.verifyEvidenceWithTrustedVerifier(
      evidence.id,
      'owner',
      'verify-1',
      verifyVisualEvidence,
    )
    expect(verified.verification).toMatchObject({
      result: 'passed',
      verifierIdentity: trustedVerifierIdentity,
      method: 'visual-container-viewport-check',
    })
    // Idempotent replay returns the same verification.
    expect(
      store.verifyEvidenceWithTrustedVerifier(
        evidence.id,
        'owner',
        'verify-1',
        verifyVisualEvidence,
      ).id,
    ).toBe(evidence.id)

    const report = store.submitWorkerReport(
      seeded.runId,
      'owner',
      'worker-verifier',
      {
        goalRevision: seeded.revision,
        reportSequence: 1,
        status: 'ready',
        evidenceRefIds: [evidence.id],
        summary: 'Trusted verification completed.',
        limitations: [],
        remainingRisks: [],
      },
    )
    expect(report.completed).toBe(true)
    expect(report.reviewPack?.criteria[0]?.completionStatus).toBe('satisfied')
  })

  it('fails viewport mismatch, forged containers and tampered stored bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-verifier-bad-'))
    const store = new PegasStore(join(directory, 'pegas.sqlite'))
    cleanups.push(
      () => store.close(),
      () => rmSync(directory, { recursive: true, force: true }),
    )
    const seeded = seedGoal(store)
    const bytes = pngBytes(800, 600)
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    const artifact = store.createArtifact(
      seeded.taskId,
      'owner',
      'artifact-2',
      {
        runId: seeded.runId,
        name: 'Wrong viewport',
        kind: 'image',
        mimeType: 'image/png',
        revision: 'rev-2',
        contentHash,
        metadata: {},
        sensitivity: 'private',
      },
    )
    const mismatched = store.createEvidenceRef(
      seeded.runId,
      'owner',
      'capture-mismatch',
      screenshotDraft(seeded.revision, artifact.id, {
        width: 1440,
        height: 900,
      }),
      { artifactBytes: bytes },
    )
    const failed = store.verifyEvidenceWithTrustedVerifier(
      mismatched.id,
      'owner',
      'verify-mismatch',
      verifyVisualEvidence,
    )
    expect(failed.verification.result).toBe('failed')

    // Bytes must match the Artifact digest at capture time.
    expect(() =>
      store.createEvidenceRef(
        seeded.runId,
        'owner',
        'capture-forged-bytes',
        screenshotDraft(seeded.revision, artifact.id, {
          width: 800,
          height: 600,
        }),
        { artifactBytes: pngBytes(800, 601) },
      ),
    ).toThrow('do not match the Artifact digest')

    // A GIF container declared as PNG fails the signature check.
    const gif = gifBytes(800, 600)
    const gifHash = createHash('sha256').update(gif).digest('hex')
    const gifArtifact = store.createArtifact(
      seeded.taskId,
      'owner',
      'artifact-3',
      {
        runId: seeded.runId,
        name: 'GIF as PNG',
        kind: 'image',
        mimeType: 'image/png',
        revision: 'rev-3',
        contentHash: gifHash,
        metadata: {},
        sensitivity: 'private',
      },
    )
    const forged = store.createEvidenceRef(
      seeded.runId,
      'owner',
      'capture-forged-container',
      screenshotDraft(seeded.revision, gifArtifact.id, {
        width: 800,
        height: 600,
      }),
      { artifactBytes: gif },
    )
    expect(
      store.verifyEvidenceWithTrustedVerifier(
        forged.id,
        'owner',
        'verify-forged',
        verifyVisualEvidence,
      ).verification.result,
    ).toBe('failed')

    // Tampering with the stored bytes is detected before verification.
    const goodBytes = pngBytes(1024, 768)
    const goodHash = createHash('sha256').update(goodBytes).digest('hex')
    const goodArtifact = store.createArtifact(
      seeded.taskId,
      'owner',
      'artifact-4',
      {
        runId: seeded.runId,
        name: 'Tampered',
        kind: 'image',
        mimeType: 'image/png',
        revision: 'rev-4',
        contentHash: goodHash,
        metadata: {},
        sensitivity: 'private',
      },
    )
    const tampered = store.createEvidenceRef(
      seeded.runId,
      'owner',
      'capture-tampered',
      screenshotDraft(seeded.revision, goodArtifact.id, {
        width: 1024,
        height: 768,
      }),
      { artifactBytes: goodBytes },
    )
    writeFileSync(
      join(directory, 'attachments', `evidence-${tampered.id}-${goodHash}`),
      pngBytes(9999, 9999),
    )
    expect(() =>
      store.verifyEvidenceWithTrustedVerifier(
        tampered.id,
        'owner',
        'verify-tampered',
        verifyVisualEvidence,
      ),
    ).toThrow('do not match the content hash')
  })

  it('parses GIF, JPEG and WebP container dimensions', () => {
    const base = {
      kind: 'screenshot',
      trustClass: 'control-plane',
      environment: { viewport: { width: 320, height: 240 } },
    }
    const evidence = {
      ...base,
      id: 'e',
      taskId: 't',
      runId: 'r',
      commandId: 'c',
      goalRevision: 1,
      criterionId: 'criterion-1',
      producerIdentity: 'worker-1',
      captureMechanism: 'playwright',
      contentHash: 'x'.repeat(64),
      verification: {
        method: 'pending',
        verifierIdentity: 'pending',
        verifierVersion: 'v1',
        result: 'pending' as const,
      },
      presentation: {},
      sensitivity: 'private',
      limitations: [],
      capturedAt: '2026-11-21T00:00:00.000Z',
    }
    const artifact = {
      id: 'a',
      taskId: 't',
      commandId: 'ac',
      name: 'img',
      kind: 'image' as const,
      revision: 'r1',
      contentHash: 'x'.repeat(64),
      metadata: {},
      sensitivity: 'private',
      createdAt: '2026-11-21T00:00:00.000Z',
    }
    for (const [mimeType, bytes] of [
      ['image/gif', gifBytes(320, 240)],
      ['image/jpeg', jpegBytes(320, 240)],
      ['image/webp', webpVp8xBytes(320, 240)],
    ] as const) {
      expect(
        verifyVisualEvidence({
          evidence: { ...evidence },
          artifact: { ...artifact, mimeType },
          artifactBytes: bytes,
        }).result,
      ).toBe('passed')
    }
    // Missing bytes never pass.
    expect(
      verifyVisualEvidence({
        evidence: { ...evidence },
        artifact: { ...artifact, mimeType: 'image/png' },
      }).result,
    ).toBe('failed')
  })
})

describe('GOAL-001 trusted verification HTTP contract', () => {
  it('captures attested bytes and verifies them through the Control Plane', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-verifier-http-'))
    const store = new PegasStore(join(directory, 'pegas.sqlite'))
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => store.close(),
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => rmSync(directory, { recursive: true, force: true }),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const seeded = seedGoal(store)
    const bytes = pngBytes(1440, 900)
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    const artifact = store.createArtifact(
      seeded.taskId,
      'owner',
      'artifact-http',
      {
        runId: seeded.runId,
        name: 'Final UI',
        kind: 'image',
        mimeType: 'image/png',
        revision: 'rev-http',
        contentHash,
        metadata: {},
        sensitivity: 'private',
      },
    )
    const capture = await fetch(`${base}/v1/runs/${seeded.runId}/evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        commandId: 'capture-http',
        confirmedForCapture: true,
        artifactBase64: bytes.toString('base64'),
        evidence: {
          ...screenshotDraft(seeded.revision, artifact.id, {
            width: 1440,
            height: 900,
          }),
          trustClass: undefined,
          verification: undefined,
        },
      }),
    })
    expect(capture.status).toBe(201)
    const captured = (await capture.json()) as {
      evidence: {
        id: string
        trustClass: string
        verification: { result: string }
      }
    }
    // HTTP capture stays a pending user claim; the trust class is server-set.
    expect(captured.evidence.trustClass).toBe('user')
    expect(captured.evidence.verification.result).toBe('pending')

    const verify = await fetch(
      `${base}/v1/evidence/${captured.evidence.id}/verify`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'owner', commandId: 'verify-http' }),
      },
    )
    expect(verify.status).toBe(200)
    const verified = (await verify.json()) as {
      evidence: { verification: { result: string; verifierIdentity: string } }
    }
    // The user-claim trust class is not accepted by the visual verifier.
    expect(verified.evidence.verification.result).toBe('failed')
    expect(verified.evidence.verification.verifierIdentity).toBe(
      trustedVerifierIdentity,
    )

    const crossOwner = await fetch(
      `${base}/v1/evidence/${captured.evidence.id}/verify`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'other', commandId: 'verify-other' }),
      },
    )
    expect(crossOwner.status).toBe(400)
  })

  it('lets control-plane captures pass trusted verification and complete the Task over HTTP', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-verifier-e2e-'))
    const store = new PegasStore(join(directory, 'pegas.sqlite'))
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => store.close(),
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => rmSync(directory, { recursive: true, force: true }),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const seeded = seedGoal(store)
    const bytes = pngBytes(1440, 900)
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    const artifact = store.createArtifact(
      seeded.taskId,
      'owner',
      'artifact-e2e',
      {
        runId: seeded.runId,
        name: 'Final UI',
        kind: 'image',
        mimeType: 'image/png',
        revision: 'rev-e2e',
        contentHash,
        metadata: {},
        sensitivity: 'private',
      },
    )
    const evidence = store.createEvidenceRef(
      seeded.runId,
      'owner',
      'capture-e2e',
      screenshotDraft(seeded.revision, artifact.id, {
        width: 1440,
        height: 900,
      }),
      { artifactBytes: bytes },
    )
    const verify = await fetch(`${base}/v1/evidence/${evidence.id}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'owner', commandId: 'verify-e2e' }),
    })
    expect(verify.status).toBe(200)
    expect(
      (
        (await verify.json()) as {
          evidence: { verification: { result: string } }
        }
      ).evidence.verification.result,
    ).toBe('passed')

    const report = store.submitWorkerReport(
      seeded.runId,
      'owner',
      'worker-verifier',
      {
        goalRevision: seeded.revision,
        reportSequence: 1,
        status: 'ready',
        evidenceRefIds: [evidence.id],
        summary: 'Verified final UI.',
        limitations: [],
        remainingRisks: [],
      },
    )
    expect(report.completed).toBe(true)
    const delivery = await fetch(
      `${base}/v1/tasks/${seeded.taskId}/delivery?userId=owner`,
    )
    expect(delivery.status).toBe(200)
    const body = (await delivery.json()) as {
      reviewPack?: { criteria: { completionStatus: string }[] }
    }
    expect(body.reviewPack?.criteria[0]?.completionStatus).toBe('satisfied')
  })
})
