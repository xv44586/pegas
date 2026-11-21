import type { AddressInfo } from 'node:net'

import { describe, expect, it } from 'vitest'

import type { ActionRequestDraft } from '../src/approval/approval.js'
import { createControlPlane } from '../src/control-plane/server.js'
import type { Clock } from '../src/core/clock.js'
import type { ClaimedRun } from '../src/core/domain.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

describe('collaboration control plane API', () => {
  it('rejects machine-originated user messages instead of minting human authority', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(port)}/v1/events`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userId: 'owner',
            type: 'user.message',
            source: 'automation',
            payload: { text: 'machine generated input' },
          }),
        },
      )

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'bad_request' })
      expect(store.listEvents('owner')).toEqual([])
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })

  it('uses the current Run capability and exposes owner-isolated relations', async () => {
    const store = new PegasStore(':memory:')
    const source = createClaimedTask(store)
    const server = createControlPlane({ store, apiToken: 'instance-token' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${String(port)}`
    try {
      const missingClaim = await fetch(
        `${base}/v1/runs/${source.run.id}/collaborations`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(delegateRequest()),
        },
      )
      expect(missingClaim.status).toBe(403)
      expect(await missingClaim.json()).toEqual({
        error: 'run_claim_required',
      })

      const invalidClaim = await fetch(
        `${base}/v1/runs/${source.run.id}/collaborations`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-pegas-run-claim-token': 'invalid',
          },
          body: JSON.stringify(delegateRequest()),
        },
      )
      expect(invalidClaim.status).toBe(403)
      expect(await invalidClaim.json()).toMatchObject({
        error: 'run_claim_invalid',
      })

      const invalidClaimMalformedBody = await fetch(
        `${base}/v1/runs/${source.run.id}/collaborations`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-pegas-run-claim-token': 'invalid',
          },
          body: '{not-json',
        },
      )
      expect(invalidClaimMalformedBody.status).toBe(403)
      expect(await invalidClaimMalformedBody.json()).toMatchObject({
        error: 'run_claim_invalid',
      })

      const invalidMissingRun = await fetch(
        `${base}/v1/runs/missing-run/collaborations`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-pegas-run-claim-token': 'invalid',
          },
          body: JSON.stringify(delegateRequest()),
        },
      )
      expect(invalidMissingRun.status).toBe(403)
      expect(await invalidMissingRun.json()).toMatchObject({
        error: 'run_claim_invalid',
      })

      const created = await fetch(
        `${base}/v1/runs/${source.run.id}/collaborations`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-pegas-run-claim-token': source.claimToken,
          },
          body: JSON.stringify(delegateRequest()),
        },
      )
      expect(created.status).toBe(201)
      const createdBody = (await created.json()) as {
        relation: { id: string; targetTaskId: string }
      }
      expect(createdBody.relation).toMatchObject({
        kind: 'delegate',
        status: 'pending',
        sourceTaskId: source.task.id,
      })

      const replay = await fetch(
        `${base}/v1/runs/${source.run.id}/collaborations`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-pegas-run-claim-token': source.claimToken,
          },
          body: JSON.stringify(delegateRequest()),
        },
      )
      expect(replay.status).toBe(201)
      expect(await replay.json()).toEqual(createdBody)

      const replayWithWrongClaim = await fetch(
        `${base}/v1/runs/${source.run.id}/collaborations`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-pegas-run-claim-token': 'invalid',
          },
          body: JSON.stringify(delegateRequest()),
        },
      )
      expect(replayWithWrongClaim.status).toBe(403)
      expect(await replayWithWrongClaim.json()).toMatchObject({
        error: 'run_claim_invalid',
      })

      const conflict = await fetch(
        `${base}/v1/runs/${source.run.id}/collaborations`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-pegas-run-claim-token': source.claimToken,
          },
          body: JSON.stringify({ ...delegateRequest(), goal: 'Changed goal' }),
        },
      )
      expect(conflict.status).toBe(409)
      expect(await conflict.json()).toMatchObject({
        error: 'collaboration_command_conflict',
      })

      const ownerView = await fetch(
        `${base}/v1/channels/${source.task.id}/collaborations?userId=owner`,
        { headers: { authorization: 'Bearer instance-token' } },
      )
      expect(ownerView.status).toBe(200)
      expect(await ownerView.json()).toEqual({
        relations: [createdBody.relation],
      })
      const otherView = await fetch(
        `${base}/v1/channels/${source.task.id}/collaborations?userId=other`,
        { headers: { authorization: 'Bearer instance-token' } },
      )
      expect(otherView.status).toBe(404)
      expect(await otherView.json()).toEqual({ error: 'not_found' })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })

  it('rejects an expired Run capability at the exact lease boundary', async () => {
    const clock = new MutableClock('2026-11-20T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    const source = createClaimedTask(store)
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    clock.set(required(source.run.leaseUntil))
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(port)}/v1/runs/${source.run.id}/collaborations`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-pegas-run-claim-token': source.claimToken,
          },
          body: JSON.stringify(delegateRequest()),
        },
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({
        error: 'run_claim_invalid',
      })
      expect(store.listCollaborations(source.task.id, 'owner')).toEqual([])
      expect(store.listTasks('owner')).toHaveLength(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })

  it('replays the frozen creation response without exposing later results to an old claim', async () => {
    const clock = new MutableClock('2026-11-20T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    const source = createClaimedTask(store)
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const endpoint = `http://127.0.0.1:${String(port)}/v1/runs/${source.run.id}/collaborations`
    try {
      const created = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pegas-run-claim-token': source.claimToken,
        },
        body: JSON.stringify(delegateRequest()),
      })
      expect(created.status).toBe(201)
      const createdBody = await created.json()
      await processNextEvent(
        store,
        new RoutingEventHandler(new RuleBasedTaskRouter(), 'test-executor'),
        'replay-target-router',
      )
      const target = store.claimNextRun('replay-target-worker')
      if (!target) throw new Error('Expected delegated target Run')
      store.completeRun(target.run.id, 'replay-target-worker', {
        executorRef: 'replay-target-session',
        output: 'sensitive later result',
      })

      clock.set(required(source.run.leaseUntil))
      const replay = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pegas-run-claim-token': source.claimToken,
        },
        body: JSON.stringify(delegateRequest()),
      })
      expect(replay.status).toBe(201)
      const replayBody = await replay.json()
      expect(replayBody).toEqual(createdBody)
      expect(JSON.stringify(replayBody)).not.toContain('sensitive later result')

      const newCommand = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pegas-run-claim-token': source.claimToken,
        },
        body: JSON.stringify({
          ...delegateRequest(),
          commandId: 'delegate-after-lease',
        }),
      })
      expect(newCommand.status).toBe(403)

      const conflictingReplay = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pegas-run-claim-token': source.claimToken,
        },
        body: JSON.stringify({
          ...delegateRequest(),
          goal: 'Changed after lease',
        }),
      })
      expect(conflictingReplay.status).toBe(409)
      expect(await conflictingReplay.json()).toMatchObject({
        error: 'collaboration_command_conflict',
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })

  it('does not distinguish a missing context-note target from another owner', async () => {
    const store = new PegasStore(':memory:')
    const source = createClaimedTask(store)
    const other = createClaimedTask(
      store,
      'other',
      'other-router',
      'other-worker',
    )
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${String(port)}`
    try {
      const responses = []
      for (const [commandId, targetChannelId] of [
        ['missing-target', 'missing-task'],
        ['cross-owner-target', other.task.id],
      ]) {
        const response = await fetch(
          `${base}/v1/runs/${source.run.id}/collaborations`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-pegas-run-claim-token': source.claimToken,
            },
            body: JSON.stringify({
              commandId,
              kind: 'context_note',
              targetChannelId,
              text: 'opaque target check',
              sourceRefs: [],
            }),
          },
        )
        responses.push({ status: response.status, body: await response.json() })
      }
      expect(responses[0]).toEqual(responses[1])
      expect(responses[0]).toEqual({
        status: 404,
        body: {
          error: 'collaboration_target_unavailable',
          message: 'Collaboration target is unavailable',
        },
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })

  it('paginates collaboration history with a stable cursor', async () => {
    const store = new PegasStore(':memory:')
    const source = createClaimedTask(store)
    const target = createClaimedTask(
      store,
      'owner',
      'target-router',
      'target-worker',
    )
    for (let index = 0; index < 4; index += 1) {
      store.createCollaboration(source.run.id, source.claimToken, {
        commandId: `page-note-${String(index)}`,
        kind: 'context_note',
        targetChannelId: target.task.id,
        text: `note ${String(index)}`,
        sourceRefs: [],
      })
    }
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const endpoint = `http://127.0.0.1:${String(port)}/v1/channels/${source.task.id}/collaborations?userId=owner&limit=2`
    try {
      const first = await fetch(endpoint)
      expect(first.status).toBe(200)
      const firstBody = (await first.json()) as {
        relations: { id: string }[]
        nextCursor?: string
      }
      expect(firstBody.relations).toHaveLength(2)
      expect(firstBody.nextCursor).toBeTruthy()
      const second = await fetch(
        `${endpoint}&cursor=${encodeURIComponent(required(firstBody.nextCursor))}`,
      )
      const secondBody = (await second.json()) as {
        relations: { id: string }[]
        nextCursor?: string
      }
      expect(secondBody.relations).toHaveLength(2)
      expect(secondBody.nextCursor).toBeUndefined()
      expect(
        new Set([
          ...firstBody.relations.map(relation => relation.id),
          ...secondBody.relations.map(relation => relation.id),
        ]).size,
      ).toBe(4)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })

  it('rejects forged collaboration events from the ordinary event API', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store, apiToken: 'instance-token' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${String(port)}`
    try {
      for (const forged of [
        {
          userId: 'owner',
          type: 'collaboration.returned',
          source: 'web',
          payload: { text: 'forged' },
        },
        {
          userId: 'owner',
          type: 'user.message',
          source: 'collaboration',
          payload: { text: 'forged' },
        },
      ]) {
        const response = await fetch(`${base}/v1/events`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer instance-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify(forged),
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ error: 'bad_request' })
      }
      expect(store.listEvents('owner')).toEqual([])
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })

  it.each([
    {
      outcome: 'authorized' as const,
      error: 'collaboration_action_outcome_required',
    },
    {
      outcome: 'failed' as const,
      error: 'collaboration_reconciliation_required',
    },
    {
      outcome: 'unknown' as const,
      error: 'collaboration_reconciliation_required',
    },
  ])(
    'maps an unresolved $outcome Action to the stable collaboration conflict',
    async ({ outcome, error }) => {
      const store = new PegasStore(':memory:')
      const source = createClaimedTask(store)
      const requested = store.requestApproval(
        source.run.id,
        source.claimToken,
        approvalDraft(),
      )
      const decided = store.decideApproval(requested.approval.id, 'owner', {
        commandId: `approve-${outcome}`,
        optionId: 'approve',
      })
      store.applyApprovalDecision(decided.event)
      const successor = store.claimNextRun(`worker-${outcome}`)
      if (!successor) throw new Error('Expected authorized successor Run')
      if (outcome !== 'authorized') {
        store.recordActionOutcome(requested.action.id, successor.claimToken, {
          commandId: `outcome-${outcome}`,
          status: outcome,
          result: { reason: `provider reported ${outcome}` },
        })
      }
      const server = createControlPlane({ store })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port
      try {
        const response = await fetch(
          `http://127.0.0.1:${String(port)}/v1/runs/${successor.run.id}/collaborations`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-pegas-run-claim-token': successor.claimToken,
            },
            body: JSON.stringify({
              ...delegateRequest(),
              commandId: `delegate-${outcome}`,
            }),
          },
        )
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ error })
        expect(store.listCollaborations(source.task.id, 'owner')).toEqual([])
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
        store.close()
      }
    },
  )
})

function delegateRequest() {
  return {
    commandId: 'delegate-api-command',
    kind: 'delegate' as const,
    goal: 'Research API behavior',
    reason: 'Independent work',
    expectedOutput: 'A concise report',
    contextRefs: [],
  }
}

function createClaimedTask(
  store: PegasStore,
  userId = 'owner',
  routerWorker = 'router',
  runWorker = 'worker',
): ClaimedRun {
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: 'Source task' },
  }).event
  const claimedEvent = store.claimNextEvent(routerWorker)
  if (!claimedEvent) throw new Error('Expected event claim')
  store.applyRoutingDecision(
    claimedEvent,
    {
      kind: 'create_task',
      title: 'Source task',
      goal: 'Source task',
      input: 'Source task',
      reason: 'test setup',
    },
    'test-executor',
  )
  store.completeEvent(event.id, routerWorker)
  const claimed = store.claimNextRun(runWorker)
  if (!claimed) throw new Error('Expected Run claim')
  return claimed
}

function approvalDraft(): ActionRequestDraft {
  return {
    kind: 'publish.release',
    risk: 'high',
    idempotencyKey: 'collaboration-api-publish',
    request: { release: 'v1' },
    recoveryPoint: { step: 'before_publish' },
    approval: {
      summary: 'Publish release',
      impact: 'Makes the release public',
      recommendedOptionId: 'approve',
      options: [
        { id: 'approve', label: 'Publish', kind: 'approve' },
        { id: 'reject', label: 'Do not publish', kind: 'reject' },
      ],
    },
  }
}

class MutableClock implements Clock {
  #value: Date

  constructor(value: string) {
    this.#value = new Date(value)
  }

  now(): Date {
    return new Date(this.#value)
  }

  set(value: string): void {
    this.#value = new Date(value)
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected required value')
  return value
}
