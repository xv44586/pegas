import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type {
  EvidenceRefDraft,
  GoalContractDraft,
} from '../src/goal/goal-delivery.js'
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

function goalDraft(
  eventId: string,
  acceptedKinds: string[],
): GoalContractDraft {
  return {
    basedOnEventIds: [eventId],
    desiredOutcome: '最终视觉交付可验收',
    beneficiaries: ['owner'],
    successCriteria: [
      {
        criterionId: 'criterion-1',
        observableStatement: '最终截图与关键帧已验证',
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
    permissionBoundary: {},
    reviewCheckpoints: ['final'],
    evidencePlan: [
      {
        id: 'plan-1',
        criterionId: 'criterion-1',
        acceptedKinds,
        acceptedTrustClasses: ['control-plane'],
        minimumCount: 1,
        presentation: 'preview',
      },
    ],
    failureAndRecovery: '重新截取',
    feedbackSignals: [],
  }
}

function seedGoal(
  store: PegasStore,
  acceptedKinds: string[] = ['screenshot'],
): { taskId: string; runId: string; revision: number } {
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
      reason: 'visual evidence preview test',
    },
    'test-executor',
  )
  const goal = store.createGoalContract(
    created.task.id,
    'owner',
    `goal-${randomUUID()}`,
    goalDraft(event.id, acceptedKinds),
  )
  const claimed = store.claimNextRun('worker-visual')
  if (!claimed) throw new Error('Expected claimed Run')
  store.completeRun(claimed.run.id, 'worker-visual', {
    executorRef: 'session-visual',
    output: 'Captured.',
  })
  return {
    taskId: created.task.id,
    runId: claimed.run.id,
    revision: goal.revision,
  }
}

function imageArtifact(
  store: PegasStore,
  seeded: { taskId: string; runId: string },
  name: string,
  revision: string,
  bytes: Buffer,
): { id: string; contentHash: string } {
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  const artifact = store.createArtifact(
    seeded.taskId,
    'owner',
    `artifact-${randomUUID()}`,
    {
      runId: seeded.runId,
      name,
      kind: 'image',
      mimeType: 'image/png',
      uri: `/artifacts/${name}.png`,
      revision,
      contentHash,
      metadata: {},
      sensitivity: 'private',
    },
  )
  return { id: artifact.id, contentHash }
}

function visualDraft(
  revision: number,
  artifactId: string,
  kind: string,
  overrides: Partial<EvidenceRefDraft> = {},
): EvidenceRefDraft {
  return {
    goalRevision: revision,
    criterionId: 'criterion-1',
    kind,
    artifactId,
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
    presentation: { alt: '最终视觉稿' },
    sensitivity: 'private',
    limitations: [],
    ...overrides,
  }
}

function diskStore(): { store: PegasStore; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-visual-preview-'))
  const store = new PegasStore(join(directory, 'pegas.sqlite'))
  cleanups.push(
    () => store.close(),
    () => rmSync(directory, { recursive: true, force: true }),
  )
  return { store, directory }
}

describe('GOAL-001 final-revision guard for visual evidence', () => {
  it('rejects evidence bound to a stale same-name Artifact revision', () => {
    const { store } = diskStore()
    const seeded = seedGoal(store)
    const staleBytes = pngBytes(1440, 900)
    const stale = imageArtifact(store, seeded, 'final-ui', 'rev-1', staleBytes)
    const finalBytes = pngBytes(1440, 900)
    finalBytes[32] = 7
    const final = imageArtifact(store, seeded, 'final-ui', 'rev-2', finalBytes)
    expect(() =>
      store.createEvidenceRef(
        seeded.runId,
        'owner',
        `capture-${randomUUID()}`,
        visualDraft(seeded.revision, stale.id, 'screenshot'),
        { artifactBytes: staleBytes },
      ),
    ).toThrow('Visual evidence must bind the final Artifact revision')
    const evidence = store.createEvidenceRef(
      seeded.runId,
      'owner',
      `capture-${randomUUID()}`,
      visualDraft(seeded.revision, final.id, 'screenshot'),
      { artifactBytes: finalBytes },
    )
    expect(evidence.artifactRevision).toBe('rev-2')
  })

  it('accepts the newest same-name Artifact when it is the bound one', () => {
    const { store } = diskStore()
    const seeded = seedGoal(store)
    const bytes = pngBytes(1440, 900)
    const artifact = imageArtifact(store, seeded, 'final-ui', 'rev-1', bytes)
    const evidence = store.createEvidenceRef(
      seeded.runId,
      'owner',
      `capture-${randomUUID()}`,
      visualDraft(seeded.revision, artifact.id, 'screenshot'),
      { artifactBytes: bytes },
    )
    expect(evidence.contentHash).toBe(artifact.contentHash)
  })
})

describe('GOAL-001 review preview carries inspectable visual metadata', () => {
  it('projects viewport, keyframe timecode, hash, revision and content availability', () => {
    const { store } = diskStore()
    const seeded = seedGoal(store, ['screenshot', 'keyframe'])
    const shotBytes = pngBytes(1440, 900)
    const shot = imageArtifact(store, seeded, 'final-ui', 'rev-1', shotBytes)
    const screenshot = store.createEvidenceRef(
      seeded.runId,
      'owner',
      `capture-${randomUUID()}`,
      visualDraft(seeded.revision, shot.id, 'screenshot'),
      { artifactBytes: shotBytes },
    )
    const frameBytes = pngBytes(1920, 1080)
    const frame = imageArtifact(
      store,
      seeded,
      'hero-frame',
      'rev-1',
      frameBytes,
    )
    const keyframe = store.createEvidenceRef(
      seeded.runId,
      'owner',
      `capture-${randomUUID()}`,
      visualDraft(seeded.revision, frame.id, 'keyframe', {
        environment: { source: 'hero-video.mp4' },
        presentation: { timecode: 12.5 },
      }),
      { artifactBytes: frameBytes },
    )
    store.submitWorkerReport(seeded.runId, 'owner', 'worker-visual', {
      goalRevision: seeded.revision,
      reportSequence: 1,
      status: 'ready',
      evidenceRefIds: [screenshot.id, keyframe.id],
      summary: '视觉稿已交付',
      limitations: [],
      remainingRisks: [],
    })
    const message = store.listOutbox('owner', seeded.taskId).find(item => {
      const payload = item.payload as { type?: string }
      return payload.type === 'review.ready'
    })
    if (!message) throw new Error('Expected review.ready outbox message')
    const review = (
      message.payload as {
        review: { evidence: Record<string, unknown>[] }
      }
    ).review
    expect(review.evidence).toHaveLength(2)
    const shotPreview = review.evidence.find(
      item => item.evidenceId === screenshot.id,
    )
    const framePreview = review.evidence.find(
      item => item.evidenceId === keyframe.id,
    )
    expect(shotPreview).toEqual(
      expect.objectContaining({
        kind: 'screenshot',
        verification: 'passed',
        sensitivity: 'private',
        contentHash: shot.contentHash,
        artifactRevision: 'rev-1',
        viewport: { width: 1440, height: 900 },
        hasContent: true,
      }),
    )
    expect(framePreview).toEqual(
      expect.objectContaining({
        kind: 'keyframe',
        timecode: 12.5,
        contentHash: frame.contentHash,
        hasContent: true,
      }),
    )
    // Raw capture environment stays server-side.
    expect(JSON.stringify(review)).not.toContain('hero-video.mp4')
    expect(JSON.stringify(review)).not.toContain('playwright')
  })

  it('marks evidence without stored bytes as preview-unavailable', () => {
    const { store } = diskStore()
    const seeded = seedGoal(store)
    const bytes = pngBytes(1440, 900)
    const artifact = imageArtifact(store, seeded, 'final-ui', 'rev-1', bytes)
    const evidence = store.createEvidenceRef(
      seeded.runId,
      'owner',
      `capture-${randomUUID()}`,
      visualDraft(seeded.revision, artifact.id, 'screenshot'),
    )
    store.submitWorkerReport(seeded.runId, 'owner', 'worker-visual', {
      goalRevision: seeded.revision,
      reportSequence: 1,
      status: 'ready',
      evidenceRefIds: [evidence.id],
      summary: '视觉稿已交付',
      limitations: [],
      remainingRisks: [],
    })
    const message = store.listOutbox('owner', seeded.taskId).find(item => {
      const payload = item.payload as { type?: string }
      return payload.type === 'review.ready'
    })
    if (!message) throw new Error('Expected review.ready outbox message')
    const review = (
      message.payload as { review: { evidence: Record<string, unknown>[] } }
    ).review
    expect(review.evidence[0]?.hasContent).toBe(false)
    expect(() => store.evidenceArtifactContent(evidence.id, 'owner')).toThrow(
      'Evidence has no stored artifact content',
    )
  })
})

describe('GOAL-001 owner-scoped evidence content API', () => {
  async function serve(store: PegasStore): Promise<{
    base: string
    headers: Record<string, string>
  }> {
    const server = createControlPlane({
      store,
      apiToken: '{{SECRET_visual0token}}',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    return {
      base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
      headers: { authorization: 'Bearer {{SECRET_visual0token}}' },
    }
  }

  it('serves attested bytes with content type, length and digest headers', async () => {
    const { store } = diskStore()
    const seeded = seedGoal(store)
    const bytes = pngBytes(1440, 900)
    const artifact = imageArtifact(store, seeded, 'final-ui', 'rev-1', bytes)
    const evidence = store.createEvidenceRef(
      seeded.runId,
      'owner',
      `capture-${randomUUID()}`,
      visualDraft(seeded.revision, artifact.id, 'screenshot'),
      { artifactBytes: bytes },
    )
    const { base, headers } = await serve(store)
    const denied = await fetch(
      `${base}/v1/evidence/${evidence.id}/content?userId=owner`,
    )
    expect(denied.status).toBe(401)
    const response = await fetch(
      `${base}/v1/evidence/${evidence.id}/content?userId=owner`,
      { headers },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe(
      String(bytes.byteLength),
    )
    expect(response.headers.get('x-pegas-content-sha256')).toBe(
      artifact.contentHash,
    )
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-security-policy')).toBe('sandbox')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    const served = Buffer.from(await response.arrayBuffer())
    expect(served.equals(bytes)).toBe(true)
  })

  it('hides other owners and missing evidence behind 404', async () => {
    const { store } = diskStore()
    const seeded = seedGoal(store)
    const bytes = pngBytes(1440, 900)
    const artifact = imageArtifact(store, seeded, 'final-ui', 'rev-1', bytes)
    const evidence = store.createEvidenceRef(
      seeded.runId,
      'owner',
      `capture-${randomUUID()}`,
      visualDraft(seeded.revision, artifact.id, 'screenshot'),
      { artifactBytes: bytes },
    )
    const { base, headers } = await serve(store)
    const crossOwner = await fetch(
      `${base}/v1/evidence/${evidence.id}/content?userId=intruder`,
      { headers },
    )
    expect(crossOwner.status).toBe(404)
    expect(await crossOwner.json()).toEqual({ error: 'not_found' })
    const missing = await fetch(
      `${base}/v1/evidence/evidence-missing/content?userId=owner`,
      { headers },
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not_found' })
  })

  it('returns content_unavailable for evidence without stored bytes', async () => {
    const { store } = diskStore()
    const seeded = seedGoal(store)
    const bytes = pngBytes(1440, 900)
    const artifact = imageArtifact(store, seeded, 'final-ui', 'rev-1', bytes)
    const evidence = store.createEvidenceRef(
      seeded.runId,
      'owner',
      `capture-${randomUUID()}`,
      visualDraft(seeded.revision, artifact.id, 'screenshot'),
    )
    const { base, headers } = await serve(store)
    const response = await fetch(
      `${base}/v1/evidence/${evidence.id}/content?userId=owner`,
      { headers },
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'content_unavailable' })
  })

  it('refuses to serve tampered storage bytes', async () => {
    const { store, directory } = diskStore()
    const seeded = seedGoal(store)
    const bytes = pngBytes(1440, 900)
    const artifact = imageArtifact(store, seeded, 'final-ui', 'rev-1', bytes)
    const evidence = store.createEvidenceRef(
      seeded.runId,
      'owner',
      `capture-${randomUUID()}`,
      visualDraft(seeded.revision, artifact.id, 'screenshot'),
      { artifactBytes: bytes },
    )
    const stored = findStoredEvidence(directory, evidence.id)
    writeFileSync(stored, Buffer.concat([bytes, Buffer.from('tampered')]))
    expect(() => store.evidenceArtifactContent(evidence.id, 'owner')).toThrow(
      'Stored evidence bytes do not match the content hash',
    )
    const { base, headers } = await serve(store)
    const response = await fetch(
      `${base}/v1/evidence/${evidence.id}/content?userId=owner`,
      { headers },
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'bad_request',
      message: 'Stored evidence bytes do not match the content hash',
    })
  })
})

function findStoredEvidence(directory: string, evidenceId: string): string {
  const walk = (current: string): string | undefined => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        const found = walk(path)
        if (found) return found
      } else if (entry.name.startsWith(`evidence-${evidenceId}-`)) {
        return path
      }
    }
    return undefined
  }
  const found = walk(directory)
  if (!found) throw new Error('Stored evidence file not found')
  return found
}
