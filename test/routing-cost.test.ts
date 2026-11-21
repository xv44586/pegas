import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../src/core/config.js'
import type { InboxEvent, RoutingCandidate } from '../src/core/domain.js'
import { MeteredJsonModelProvider } from '../src/model/metered-provider.js'
import { OpenAiCompatibleProvider } from '../src/model/openai-compatible-provider.js'
import { AnthropicProvider } from '../src/model/anthropic-provider.js'
import type { JsonModelProvider } from '../src/model/provider.js'
import { prefilterDecision } from '../src/router/prefilter.js'
import { ModelTaskRouter } from '../src/router/router.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function humanEvent(text: string, id?: string): InboxEvent {
  return {
    id: id ?? `event-${text}`,
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
    status: 'pending',
    attempts: 0,
    createdAt: '2026-11-22T00:00:00.000Z',
  }
}

function startedCandidate(title: string, id: string): RoutingCandidate {
  return {
    task: {
      id,
      userId: 'owner',
      originEventId: `origin-${id}`,
      title,
      goal: title,
      status: 'started',
      kind: 'work',
      workerIconId: 'computer',
      mandate: {
        strength: 'explicit',
        policyVersion: 'pegas-mandate-v1',
        basis: {
          source: 'web',
          scope: { conversation: 'owner' },
          via: 'router',
          sender: 'owner',
        },
        actor: { source: 'web', id: 'owner' },
        scope: title,
      },
      createdAt: '2026-11-22T00:00:00.000Z',
      updatedAt: '2026-11-22T00:00:00.000Z',
    },
  }
}

describe('PLAN-001 P2 deterministic prefilter', () => {
  it('cancels on a unique exact stop-command title match', () => {
    const candidates = [
      startedCandidate('整理知识库', 'task-1'),
      startedCandidate('写周报', 'task-2'),
    ]
    expect(
      prefilterDecision(humanEvent('停掉 整理知识库'), candidates, {
        chatLaneEnabled: false,
      }),
    ).toEqual({
      kind: 'cancel_task',
      taskId: 'task-1',
      reason: 'Deterministic stop command matched exactly one started task.',
    })
  })

  it('never bypasses the model when the stop target is ambiguous or absent', () => {
    const duplicates = [
      startedCandidate('整理知识库', 'task-1'),
      startedCandidate('整理知识库', 'task-2'),
    ]
    expect(
      prefilterDecision(humanEvent('停掉 整理知识库'), duplicates, {
        chatLaneEnabled: false,
      }),
    ).toBeUndefined()
    expect(
      prefilterDecision(humanEvent('停掉 不存在的任务'), duplicates, {
        chatLaneEnabled: false,
      }),
    ).toBeUndefined()
    expect(
      prefilterDecision(humanEvent('帮我停掉那个很烦人的东西'), [], {
        chatLaneEnabled: false,
      }),
    ).toBeUndefined()
  })

  it('routes greetings to reply only when the chat lane is enabled', () => {
    expect(
      prefilterDecision(humanEvent('你好'), [], { chatLaneEnabled: true }),
    ).toMatchObject({ kind: 'reply', input: '你好' })
    expect(
      prefilterDecision(humanEvent('谢谢啦！'), [], { chatLaneEnabled: true }),
    ).toMatchObject({ kind: 'reply' })
    expect(
      prefilterDecision(humanEvent('你好'), [], { chatLaneEnabled: false }),
    ).toBeUndefined()
    expect(
      prefilterDecision(humanEvent('你好，帮我查一下明天的日程'), [], {
        chatLaneEnabled: true,
      }),
    ).toBeUndefined()
  })

  it('never prefilters machine input, explicit references or non-messages', () => {
    const machine = { ...humanEvent('你好'), authenticatedActor: undefined }
    expect(
      prefilterDecision(machine, [], { chatLaneEnabled: true }),
    ).toBeUndefined()
    const explicit = {
      ...humanEvent('停掉 整理知识库'),
      payload: { text: '停掉 整理知识库', taskId: 'task-1' },
    }
    expect(
      prefilterDecision(explicit, [startedCandidate('整理知识库', 'task-1')], {
        chatLaneEnabled: true,
      }),
    ).toBeUndefined()
    const automation = { ...humanEvent('你好'), source: 'automation' }
    expect(
      prefilterDecision(automation, [], { chatLaneEnabled: true }),
    ).toBeUndefined()
  })

  it('bypasses the model end to end through the same control transaction', async () => {
    const store = new PegasStore(':memory:')
    store.initializeRuntimeSettings(runtimeSettingsDefaults(loadConfig({})))
    const seed = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '整理知识库' },
    }).event
    const claimedSeed = store.claimNextEvent('seed-router')
    if (!claimedSeed) throw new Error('Expected seed claim')
    const { task } = store.applyRoutingDecision(
      claimedSeed,
      {
        kind: 'create_task',
        title: '整理知识库',
        goal: '整理知识库',
        input: '整理知识库',
        reason: 'seed',
      },
      'echo-test',
    )
    store.completeEvent(seed.id, 'seed-router')
    const run = store.claimNextRun('seed-worker')
    if (!run) throw new Error('Expected seed run')

    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '停掉 整理知识库' },
    })
    let modelCalls = 0
    const counting: JsonModelProvider = {
      name: 'counting',
      generateJson: () => {
        modelCalls += 1
        return Promise.resolve({
          kind: 'create_task',
          taskId: '',
          title: 'x',
          goal: 'x',
          reason: 'x',
        })
      },
    }
    await processNextEvent(
      store,
      new RoutingEventHandler(
        new ModelTaskRouter({ provider: counting }),
        'echo-test',
      ),
      'router-1',
    )
    expect(modelCalls).toBe(0)
    expect(store.findTask(task.id, 'owner')?.status).toBe('cancelled')
    store.close()
  })
})

describe('PLAN-001 P2 collect window', () => {
  it('merges three consecutive messages into one routing call', async () => {
    const store = new PegasStore(':memory:')
    store.initializeRuntimeSettings(runtimeSettingsDefaults(loadConfig({})))
    for (const text of [
      '帮我整理会议纪要',
      '重点是下周的排期',
      '输出成 Markdown',
    ]) {
      store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: { text },
      })
    }
    const inputs: string[] = []
    const capturing: JsonModelProvider = {
      name: 'capturing',
      generateJson: request => {
        inputs.push(request.input)
        return Promise.resolve({
          kind: 'create_task',
          taskId: '',
          title: '整理会议纪要',
          goal: '整理会议纪要',
          reason: 'merged',
        })
      },
    }
    await processNextEvent(
      store,
      new RoutingEventHandler(
        new ModelTaskRouter({ provider: capturing }),
        'echo-test',
      ),
      'router-1',
      undefined,
      { collectWindowMs: 150 },
    )
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toContain('帮我整理会议纪要')
    expect(inputs[0]).toContain('重点是下周的排期')
    expect(inputs[0]).toContain('输出成 Markdown')
    const tasks = store.listTasks('owner')
    expect(tasks).toHaveLength(1)
    const events = store.listEvents('owner')
    expect(events).toHaveLength(3)
    expect(events.every(event => event.status === 'processed')).toBe(true)
    expect(store.listRuns(tasks[0]?.id ?? '')[0]?.input).toBe(
      '帮我整理会议纪要\n重点是下周的排期\n输出成 Markdown',
    )
    store.close()
  })

  it('never delays explicit references or stop commands', async () => {
    const store = new PegasStore(':memory:')
    store.initializeRuntimeSettings(runtimeSettingsDefaults(loadConfig({})))
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '停掉 某件事' },
    })
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '另一条消息' },
    })
    let modelCalls = 0
    const counting: JsonModelProvider = {
      name: 'counting',
      generateJson: () => {
        modelCalls += 1
        return Promise.resolve({
          kind: 'create_task',
          taskId: '',
          title: 't',
          goal: 't',
          reason: 'r',
        })
      },
    }
    const startedAt = performance.now()
    await processNextEvent(
      store,
      new RoutingEventHandler(
        new ModelTaskRouter({ provider: counting }),
        'echo-test',
      ),
      'router-1',
      undefined,
      { collectWindowMs: 5_000 },
    )
    expect(performance.now() - startedAt).toBeLessThan(2_000)
    const events = store.listEvents('owner')
    const stop = events.find(event =>
      JSON.stringify(event.payload).includes('停掉'),
    )
    expect(stop?.status).toBe('processed')
    const other = events.find(event =>
      JSON.stringify(event.payload).includes('另一条消息'),
    )
    expect(other?.status).toBe('pending')
    expect(modelCalls).toBe(1)
    store.close()
  })
})

describe('PLAN-001 P2 router metering', () => {
  it('records provider-reported tokens and observed latency per event', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"kind":"create_task","taskId":"","title":"t","goal":"t","reason":"r"}',
              },
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        }),
      )
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const { port } = server.address() as AddressInfo
    const store = new PegasStore(':memory:')
    const inner = new OpenAiCompatibleProvider({
      baseUrl: `http://127.0.0.1:${String(port)}/v1`,
      model: 'router-model',
    })
    const metered = new MeteredJsonModelProvider(
      inner,
      store,
      'router',
      () => ({
        userId: 'owner',
        eventId: 'event-1',
        modelRef: 'openai/router-model',
      }),
    )
    await metered.generateJson({ system: 'route', input: 'hello' })
    await metered.generateJson({ system: 'route', input: 'hello again' })

    const report = store.listRouterUsage('owner')
    expect(report.summary.calls).toBe(1)
    expect(report.summary.okCalls).toBe(1)
    expect(report.records[0]).toMatchObject({
      component: 'router',
      eventId: 'event-1',
      modelRef: 'openai/router-model',
      completeness: 'complete',
      tokenSource: 'provider_reported',
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cacheReadTokens: 40,
      outcome: 'ok',
    })
    expect(report.records[0]?.durationMs).toBeGreaterThanOrEqual(0)
    expect(store.listRouterUsage('other').records).toHaveLength(0)
    store.close()
  })

  it('records failed calls as errors without fabricating tokens', async () => {
    const store = new PegasStore(':memory:')
    const failing: JsonModelProvider = {
      name: 'failing',
      generateJson: () => Promise.reject(new Error('provider down')),
    }
    const metered = new MeteredJsonModelProvider(
      failing,
      store,
      'router',
      () => ({
        userId: 'owner',
        eventId: 'event-err',
        modelRef: 'openai/router-model',
      }),
    )
    await expect(
      metered.generateJson({ system: 'route', input: 'hello' }),
    ).rejects.toThrow('provider down')
    const report = store.listRouterUsage('owner')
    expect(report.summary.errorCalls).toBe(1)
    expect(report.records[0]).toMatchObject({
      outcome: 'error',
      completeness: 'unavailable',
    })
    expect(report.records[0]?.inputTokens).toBeUndefined()
    store.close()
  })

  it('parses Anthropic usage buckets without guessing', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          content: [
            { type: 'tool_use', name: 'return_json', input: { ok: true } },
          ],
          usage: {
            input_tokens: 90,
            output_tokens: 12,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 8,
          },
        }),
      )
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const { port } = server.address() as AddressInfo
    const provider = new AnthropicProvider({
      baseUrl: `http://127.0.0.1:${String(port)}`,
      model: 'claude-test',
    })
    const result = await provider.generateJsonWithUsage({
      system: 'route',
      input: 'hello',
    })
    expect(result.value).toEqual({ ok: true })
    expect(result.usage).toEqual({
      inputTokens: 90,
      outputTokens: 12,
      totalTokens: 102,
      cacheReadTokens: 30,
      cacheWriteTokens: 8,
    })
  })

  it('keeps metering optional for providers without usage support', async () => {
    const store = new PegasStore(':memory:')
    const plain: JsonModelProvider = {
      name: 'plain',
      generateJson: () => Promise.resolve({ ok: true }),
    }
    const metered = new MeteredJsonModelProvider(
      plain,
      store,
      'rewrite',
      () => ({
        userId: 'owner',
        eventId: 'event-plain',
        modelRef: 'openai/router-model',
      }),
    )
    await expect(
      metered.generateJson({ system: 'rewrite', input: 'hello' }),
    ).resolves.toEqual({ ok: true })
    expect(store.listRouterUsage('owner').records[0]).toMatchObject({
      component: 'rewrite',
      completeness: 'unavailable',
      outcome: 'ok',
    })
    store.close()
  })
})
