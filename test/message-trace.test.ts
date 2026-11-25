import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createControlPlane } from '../src/control-plane/server.js'
import { ModelTaskRouter, RuleBasedTaskRouter } from '../src/router/router.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

function enqueue(store: PegasStore, text: string, userId = 'owner') {
  return store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
  }).event
}

describe('OBS-001 message trace', () => {
  it('links a model fallback, the run, policy, tool output and browser arrival without exposing unrelated data', async () => {
    const store = new PegasStore(':memory:')
    try {
      const secret = 'samplecredentialnotfortrace'
      const event = enqueue(store, `检查季度数据 Bearer ${secret}`)
      const router = new ModelTaskRouter({
        provider: {
          name: 'fixture-model',
          generateJson: () =>
            Promise.resolve({ kind: 'unsupported', extra: secret }),
        },
        observeCall: (eventId, call) =>
          store.recordMessageTraceRouterCall(eventId, call),
      })
      await processNextEvent(
        store,
        new RoutingEventHandler(router, 'echo'),
        'worker',
      )
      const claim = store.claimNextRun('worker')
      if (!claim) throw new Error('Missing claimed run')
      await executeClaimedRun(
        store,
        {
          name: 'echo',
          execute: input => {
            input.onProgress?.({
              type: 'policy_decision',
              callId: 'call-1',
              tool: 'bash',
              category: 'read',
              risk: 'low',
              decision: 'allow',
              reason: 'authorized read',
            })
            input.onProgress?.({
              type: 'tool_call',
              callId: 'call-1',
              tool: 'bash',
              input: '{"command":"pwd"}',
            })
            input.onProgress?.({
              type: 'tool_result',
              callId: 'call-1',
              status: 'completed',
              result: 'fixture output',
            })
            return Promise.resolve({
              executorRef: 'fixture',
              output: '完成核对',
            })
          },
        },
        claim,
        'worker',
        process.cwd(),
        new AbortController().signal,
        'http://127.0.0.1:1',
      )
      const other = enqueue(store, '另一个任务的私人数据')
      await processNextEvent(
        store,
        new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo'),
        'worker',
      )
      const trace = store.messageTrace(event.id, 'owner')
      expect(trace?.rootEventId).toBe(event.id)
      expect(trace?.calls[0]).toMatchObject({
        outcome: 'invalid_response',
        input: { text: '检查季度数据 Bearer [已脱敏]' },
        candidates: [],
      })
      expect(trace?.decision?.kind).toBe('create_task')
      expect(trace?.runs).toHaveLength(1)
      expect(trace?.runs[0]).toMatchObject({
        id: claim.run.id,
        status: 'completed',
        starts: [{ phase: 'execute' }],
      })
      expect(trace?.policy[0]).toMatchObject({
        callId: 'call-1',
        decision: 'allow',
      })
      expect(
        await store.readRunActivityOutput(claim.run.id, 'owner', 'call-1'),
      ).toMatchObject({ content: 'fixture output' })
      const result = trace?.results.find(
        message => message.type === 'run.completed',
      )
      if (!result) throw new Error('Missing completion card')
      expect(result.fetchedAt).toBeUndefined()
      expect(
        store.recordMessageTraceReceipt('stranger', {
          phase: 'rendered',
          messageId: result.id,
        }),
      ).toBe(false)
      expect(
        store.recordMessageTraceReceipt('owner', {
          phase: 'accepted',
          eventId: event.id,
          durationMs: 13,
        }),
      ).toBe(true)
      expect(
        store.recordMessageTraceReceipt('owner', {
          phase: 'accepted',
          eventId: event.id,
          durationMs: 99,
        }),
      ).toBe(true)
      for (const phase of [
        'fetched',
        'rendered',
        'settled',
        'visible',
      ] as const)
        expect(
          store.recordMessageTraceReceipt('owner', {
            phase,
            messageId: result.id,
          }),
        ).toBe(true)
      const settled = store.messageTrace(event.id, 'owner')
      expect(settled?.events[0]?.submitMs).toBe(13)
      const browserResult = settled?.results.find(
        message => message.id === result.id,
      )
      expect(browserResult?.fetchedAt).toBeTypeOf('string')
      expect(browserResult?.renderedAt).toBeTypeOf('string')
      expect(browserResult?.settledAt).toBeTypeOf('string')
      expect(browserResult?.visibleAt).toBeTypeOf('string')
      expect(JSON.stringify(settled)).not.toContain(secret)
      expect(JSON.stringify(settled)).not.toContain(other.id)
      expect(store.messageTrace(event.id, 'stranger')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('preserves batch membership and retry links while keeping separate owner events isolated', async () => {
    const store = new PegasStore(':memory:')
    try {
      const first = enqueue(store, '第一条输入')
      const second = enqueue(store, '第二条输入')
      const third = enqueue(store, '其他用户', 'stranger')
      await processNextEvent(
        store,
        new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo'),
        'worker',
        undefined,
        { collectWindowMs: 15 },
      )
      const claim = store.claimNextRun('worker')
      if (!claim) throw new Error('Missing claimed run')
      store.failRun(claim.run.id, 'worker', 'fixture failure')
      const retry = store.retryRun(claim.run.id, 'owner')
      const trace = store.messageTrace(second.id, 'owner')
      expect(trace?.rootEventId).toBe(first.id)
      expect(trace?.events.map(event => event.id)).toEqual([
        first.id,
        second.id,
      ])
      expect(trace?.runs.map(run => run.id)).toEqual([claim.run.id, retry.id])
      expect(trace?.runs[1]?.retryOf).toBe(claim.run.id)
      expect(store.messageTrace(third.id, 'owner')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('protects trace reads and accepts only valid, owner-scoped browser observations', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store, apiToken: 'fixture-token' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const event = enqueue(store, '只看自己的消息')
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      const path = `${base}/v1/events/${event.id}/trace`
      const headers = {
        authorization: 'Bearer fixture-token',
        'content-type': 'application/json',
      }
      expect((await fetch(`${path}?userId=owner`)).status).toBe(401)
      expect((await fetch(`${path}?userId=stranger`, { headers })).status).toBe(
        404,
      )
      const response = await fetch(`${path}?userId=owner`, { headers })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const receipts = `${base}/v1/observability/browser-receipts`
      const record = (userId: string, durationMs: number) =>
        fetch(receipts, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            userId,
            receipts: [{ phase: 'accepted', eventId: event.id, durationMs }],
          }),
        })
      expect((await record('owner', -1)).status).toBe(400)
      expect(await (await record('stranger', 1)).json()).toEqual({
        recorded: [false],
      })
      expect(await (await record('owner', 1)).json()).toEqual({
        recorded: [true],
      })
      expect(store.messageTrace(event.id, 'owner')?.events[0]?.submitMs).toBe(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })
})
