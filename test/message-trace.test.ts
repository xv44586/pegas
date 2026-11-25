import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

describe('OBS-001 review regressions', () => {
  it('commits batch membership with its clarification even without a task decision', async () => {
    const store = new PegasStore(':memory:')
    try {
      const head = enqueue(store, '核对一张报表')
      const member = enqueue(store, '范围是十一月')
      const router = {
        route: () => {
          expect(store.messageTrace(member.id, 'owner')?.rootEventId).toBe(
            member.id,
          )
          return Promise.resolve({
            kind: 'clarify' as const,
            input: '核对一张报表',
            reason: '需要确定答复对象',
            question: '请问要核对哪张报表？',
          })
        },
      }
      await processNextEvent(
        store,
        new RoutingEventHandler(router, 'echo'),
        'worker',
        undefined,
        { collectWindowMs: 12 },
      )
      const trace = store.messageTrace(member.id, 'owner')
      expect(trace?.rootEventId).toBe(head.id)
      expect(trace?.events.map(event => event.status)).toEqual([
        'processed',
        'processed',
      ])
      expect(trace?.decision).toBeUndefined()
      expect(trace?.results.map(result => result.type)).toContain(
        'routing.clarification_required',
      )
    } finally {
      store.close()
    }
  })

  it('anchors a single retry to its own Run after a failed two-message batch', async () => {
    const store = new PegasStore(':memory:')
    try {
      const first = enqueue(store, '先核对第一张表')
      const second = enqueue(store, '再核对第二张表')
      const failingHandler = {
        handle: () => Promise.reject(new Error('fixture route failure')),
      }
      for (let attempt = 0; attempt < 5; attempt += 1)
        await processNextEvent(store, failingHandler, 'worker', undefined, {
          collectWindowMs: 12,
        })
      expect(store.messageTrace(second.id, 'owner')?.rootEventId).toBe(first.id)
      expect(store.retryEvent(second.id, 'owner').status).toBe('pending')
      await processNextEvent(
        store,
        new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo'),
        'worker',
      )
      const run = store.listRunsForUser('owner')[0]
      expect(run?.originEventId).toBe(second.id)
      expect(store.messageTrace(second.id, 'owner')).toMatchObject({
        rootEventId: second.id,
        decision: { kind: 'create_task' },
        runs: [{ id: run?.id }],
      })
      expect(
        store.messageTrace(first.id, 'owner')?.events.map(event => event.id),
      ).toEqual([first.id])
    } finally {
      store.close()
    }
  })

  it('shows an independently retried clarification on its own message trace', async () => {
    const store = new PegasStore(':memory:')
    try {
      const head = enqueue(store, '先核对第一张表')
      const member = enqueue(store, '再核对第二张表')
      const failingHandler = {
        handle: () => Promise.reject(new Error('fixture route failure')),
      }
      for (let attempt = 0; attempt < 5; attempt += 1)
        await processNextEvent(store, failingHandler, 'worker', undefined, {
          collectWindowMs: 12,
        })
      expect(store.messageTrace(member.id, 'owner')?.rootEventId).toBe(head.id)
      expect(store.retryEvent(member.id, 'owner').status).toBe('pending')
      const question = '请问要核对第二张表的哪一列？'
      const router = {
        route: () =>
          Promise.resolve({
            kind: 'clarify' as const,
            input: '再核对第二张表',
            reason: '需要范围',
            question,
          }),
      }
      await processNextEvent(
        store,
        new RoutingEventHandler(router, 'echo'),
        'worker',
      )
      expect(store.messageTrace(member.id, 'owner')).toMatchObject({
        rootEventId: member.id,
        events: [{ id: member.id, status: 'processed' }],
        results: [
          {
            type: 'routing.clarification_required',
            output: { text: question },
          },
        ],
      })
      expect(
        store.messageTrace(head.id, 'owner')?.events.map(event => event.id),
      ).toEqual([head.id])
    } finally {
      store.close()
    }
  })

  it('links queued updates and every running correction to the affected Run and its successor', async () => {
    const store = new PegasStore(':memory:')
    const handler = new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo')
    try {
      const original = enqueue(store, '整理季度数据')
      await processNextEvent(store, handler, 'worker')
      const originalRun = store.listRunsForUser('owner')[0]
      if (!originalRun) throw new Error('Missing original Run')
      const update = (text: string, intent?: 'steer') =>
        store.enqueueEvent({
          userId: 'owner',
          type: 'user.message',
          source: 'web',
          authenticatedActor: 'human',
          payload: {
            text,
            taskId: originalRun.taskId,
            ...(intent ? { intent } : {}),
          },
        }).event

      const queuedContinuation = update('范围补充：只看已结账数据')
      await processNextEvent(store, handler, 'worker')
      const queuedSteer = update('改用季度口径', 'steer')
      await processNextEvent(store, handler, 'worker')
      const claimed = store.claimNextRun('worker')
      expect(claimed?.run.input).toContain('改用季度口径')
      expect(claimed?.run.input).toContain('只看已结账数据')
      for (const event of [queuedContinuation, queuedSteer])
        expect(
          store.messageTrace(event.id, 'owner')?.runs.map(run => run.id),
        ).toEqual([originalRun.id])

      const firstSteer = update('加入分区域汇总', 'steer')
      await processNextEvent(store, handler, 'worker')
      const secondSteer = update('增加总计', 'steer')
      await processNextEvent(store, handler, 'worker')
      const successor = store.supersedeRunForSteering(originalRun.id, 'worker')
      expect(successor.input).toContain('加入分区域汇总')
      expect(successor.input).toContain('增加总计')
      for (const event of [
        original,
        queuedContinuation,
        queuedSteer,
        firstSteer,
        secondSteer,
      ])
        expect(
          store.messageTrace(event.id, 'owner')?.runs.map(run => run.id),
        ).toEqual([originalRun.id, successor.id])
    } finally {
      store.close()
    }
  })

  it('redacts explicit authentication headers and localized credential values from persisted model call previews', async () => {
    const store = new PegasStore(':memory:')
    try {
      const localizedFields = [
        ['访问密钥', 'fixture-prefixed-key-value'],
        ['登录密码', 'fixture-login-value'],
        ['这是我的密码', 'fixture-sentence-value'],
      ] as const
      const fields = [
        ...localizedFields.map(([label, value]) => label + '：' + value),
        'Authorization: Basic sample-basic-value',
        'Cookie: sid=sample-cookie-value; csrf=sample-csrf-value',
        '密钥：sample-localized-key',
      ]
      const prompt = fields.join('\n')
      const event = enqueue(store, prompt)
      const router = new ModelTaskRouter({
        provider: {
          name: 'fixture',
          generateJson: () =>
            Promise.resolve({
              kind: 'create_task',
              title: '验证',
              goal: '验证',
              reason: prompt,
            }),
        },
        observeCall: (eventId, call) =>
          store.recordMessageTraceRouterCall(eventId, call),
      })
      await processNextEvent(
        store,
        new RoutingEventHandler(router, 'echo'),
        'worker',
      )
      const trace = JSON.stringify(store.messageTrace(event.id, 'owner'))
      for (const value of [
        ...localizedFields.map(([, value]) => value),
        'sample-basic-value',
        'sample-cookie-value',
        'sample-csrf-value',
        'sample-localized-key',
      ])
        expect(trace).not.toContain(value)
      expect(trace).toContain('[已脱敏]')
    } finally {
      store.close()
    }
  })

  it('upgrades v57 diagnostics by scrubbing stored previews and recovering known steering edges', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-trace-upgrade-'))
    const path = join(directory, 'pegas.sqlite')
    let store: PegasStore | undefined
    try {
      store = new PegasStore(path)
      const handler = new RoutingEventHandler(new RuleBasedTaskRouter(), 'echo')
      const original = enqueue(store, '整理历史记录')
      await processNextEvent(store, handler, 'worker')
      const claim = store.claimNextRun('worker')
      if (!claim) throw new Error('Missing original Run')
      const correction = store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: {
          text: '只整理上个月',
          taskId: claim.run.taskId,
          intent: 'steer',
        },
      }).event
      await processNextEvent(store, handler, 'worker')
      store.close()
      store = undefined

      const database = new DatabaseSync(path)
      try {
        database.exec(`
          DROP TABLE message_trace_run_inputs;
          DELETE FROM schema_migrations WHERE version = 58;
        `)
        const previous = [
          'Cookie: sid=legacy-fixture-value',
          '访问密钥' + '：' + 'earlier-key-fixture',
          '登录密码' + '：' + 'earlier-password-fixture',
        ].join('\n')
        database
          .prepare(
            'INSERT INTO message_trace_router_calls (event_id, detail_json) VALUES (?, ?)',
          )
          .run(
            original.id,
            JSON.stringify({
              component: 'router',
              model: 'fixture',
              durationMs: 1,
              at: original.createdAt,
              outcome: 'ok',
              input: {
                text: previous,
                characters: previous.length,
                truncated: false,
              },
              output: {
                text: previous,
                characters: previous.length,
                truncated: false,
              },
            }),
          )
      } finally {
        database.close()
      }

      store = new PegasStore(path)
      expect(
        store.messageTrace(correction.id, 'owner')?.runs.map(run => run.id),
      ).toEqual([claim.run.id])
      const upgraded = store.messageTrace(original.id, 'owner')?.calls[0]
      const sanitized = [
        'Cookie: [已脱敏]',
        '访问密钥: [已脱敏]',
        '登录密码: [已脱敏]',
      ].join('\n')
      expect(upgraded?.input.text).toBe(sanitized)
      expect(upgraded?.output?.text).toBe(sanitized)
      const raw = new DatabaseSync(path, { readOnly: true })
      try {
        expect(
          raw
            .prepare('SELECT detail_json FROM message_trace_router_calls')
            .get(),
        ).toMatchObject({ detail_json: JSON.stringify(upgraded) })
      } finally {
        raw.close()
      }
    } finally {
      store?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
