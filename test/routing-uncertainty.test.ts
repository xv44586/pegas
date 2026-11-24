import { describe, expect, it } from 'vitest'

import type { InboxEvent } from '../src/core/domain.js'
import type { JsonModelProvider } from '../src/model/provider.js'
import { ModelTaskRouter } from '../src/router/router.js'
import { loadConfig } from '../src/core/config.js'
import {
  parseRuntimeSettingsUpdate,
  runtimeSettingsDefaults,
  settingsCapabilities,
} from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

describe('routing uncertainty policy', () => {
  it('defaults to new_task and keeps the prompt byte-identical', async () => {
    const bare = new CapturingProvider(createAnswer())
    const explicit = new CapturingProvider(createAnswer())
    await new ModelTaskRouter({ provider: bare }).route(message('hi'), [])
    await new ModelTaskRouter({
      provider: explicit,
      uncertainty: 'new_task',
    }).route(message('hi'), [])
    expect(explicit.system).toBe(bare.system)
    expect(bare.system).not.toContain('clarify')
  })

  it('accepts a clarify decision only under ask_first and keeps the original input', async () => {
    const answer = {
      kind: 'clarify',
      taskId: '',
      title: '',
      goal: '',
      question: '这条消息属于「调研 NAS」还是一个新事情？',
      reason: 'ownership ambiguous',
    }
    const askFirst = new ModelTaskRouter({
      provider: new CapturingProvider(answer),
      uncertainty: 'ask_first',
    })
    const decision = await askFirst.route(message('再补充一点'), [])
    expect(decision).toEqual({
      kind: 'clarify',
      input: '再补充一点',
      question: '这条消息属于「调研 NAS」还是一个新事情？',
      reason: 'ownership ambiguous',
    })

    const conservative = new ModelTaskRouter({
      provider: new CapturingProvider(answer),
    })
    const fallback = await conservative.route(message('再补充一点'), [])
    expect(fallback).toMatchObject({ kind: 'create_task' })
  })

  it('injects the continue_recent preference without changing candidates', async () => {
    const provider = new CapturingProvider(createAnswer())
    await new ModelTaskRouter({
      provider,
      uncertainty: 'continue_recent',
    }).route(message('随便'), [])
    expect(provider.system).toContain('prefer continue_task')
    expect(provider.system).toContain('most recently updated')
  })

  it('persists the policy with omit-to-keep semantics and validates values', () => {
    const store = new PegasStore(':memory:')
    try {
      const defaults = runtimeSettingsDefaults(loadConfig({}))
      const initialized = store.initializeRuntimeSettings(defaults)
      expect(initialized.routingUncertainty).toBe('new_task')
      const updated = store.updateRuntimeSettings(initialized.revision, {
        ...defaults,
        routingUncertainty: 'ask_first',
      })
      expect(updated.routingUncertainty).toBe('ask_first')
      const withoutPolicy = { ...defaults }
      delete withoutPolicy.routingUncertainty
      const kept = store.updateRuntimeSettings(updated.revision, withoutPolicy)
      expect(kept.routingUncertainty).toBe('ask_first')
      const capabilities = settingsCapabilities(loadConfig({}))
      expect(() =>
        parseRuntimeSettingsUpdate(
          {
            ...settingsBody(),
            expectedRevision: kept.revision,
            routingUncertainty: 'sometimes',
          },
          capabilities,
        ),
      ).toThrow('routingUncertainty must be one of')
      const parsed = parseRuntimeSettingsUpdate(
        {
          ...settingsBody(),
          expectedRevision: kept.revision,
          routingUncertainty: 'continue_recent',
        },
        capabilities,
      )
      expect(parsed.settings.routingUncertainty).toBe('continue_recent')
    } finally {
      store.close()
    }
  })

  it('turns clarify into an owner-scoped todo without creating a Task, idempotently', async () => {
    const store = new PegasStore(':memory:')
    try {
      store.initializeRuntimeSettings({
        ...runtimeSettingsDefaults(loadConfig({})),
        routingUncertainty: 'ask_first',
      })
      const router = new ModelTaskRouter({
        provider: new CapturingProvider({
          kind: 'clarify',
          taskId: '',
          title: '',
          goal: '',
          question: '这是新事情还是继续已有的事？',
          reason: 'ambiguous',
        }),
        uncertainty: 'ask_first',
      })
      store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: { text: '再补充一点' },
      })
      await processNextEvent(
        store,
        new RoutingEventHandler(router, 'echo'),
        'uncertainty-router',
      )
      expect(store.listTasks('owner')).toEqual([])
      const messages = store.listOutbox('owner')
      expect(messages).toHaveLength(1)
      expect(messages[0]?.payload).toMatchObject({
        type: 'routing.clarification_required',
        input: '再补充一点',
        question: '这是新事情还是继续已有的事？',
      })
      expect(messages[0]?.taskId).toBeUndefined()
      expect(store.listOutbox('other')).toEqual([])
      const event = store.listEvents('owner')[0]
      expect(event?.status).toBe('processed')
      if (!event) throw new Error('expected event')
      const replay = store.applyRoutingClarification(
        { ...event, claimedBy: undefined },
        {
          kind: 'clarify',
          input: '再补充一点',
          question: '这是新事情还是继续已有的事？',
          reason: 'ambiguous',
        },
      )
      expect(replay.message.id).toBe(messages[0]?.id)
      expect(store.listOutbox('owner')).toHaveLength(1)

      store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: { text: '这是一个新事情：帮我调研 NAS' },
      })
      await processNextEvent(
        store,
        new RoutingEventHandler(
          new ModelTaskRouter({
            provider: new CapturingProvider(createAnswer()),
            uncertainty: 'ask_first',
          }),
          'echo',
        ),
        'uncertainty-router',
      )
      expect(store.listTasks('owner')).toHaveLength(1)
    } finally {
      store.close()
    }
  })
})

function createAnswer(): unknown {
  return {
    kind: 'create_task',
    taskId: '',
    title: '新事情',
    goal: '新事情',
    reason: 'new idea',
  }
}

function settingsBody(): Record<string, unknown> {
  return {
    expectedRevision: 1,
    routerMode: 'model',
    modelProvider: 'magpie',
    modelName: 'discovery-api/deepseek-v4.1-flash-1017',
    agentModelMode: 'profile',
    privacyMode: 'disabled',
    rewriteMode: 'disabled',
    provider: { clearApiKey: false },
  }
}

class CapturingProvider implements JsonModelProvider {
  readonly name = 'capturing-stub'
  system = ''
  readonly #answer: unknown

  constructor(answer: unknown) {
    this.#answer = answer
  }

  generateJson(request: { system: string }): Promise<unknown> {
    this.system = request.system
    return Promise.resolve(this.#answer)
  }
}

function message(text: string): InboxEvent {
  return {
    id: 'event-1',
    userId: 'user-1',
    type: 'user.message',
    source: 'web',
    payload: { text },
    status: 'pending',
    attempts: 0,
    createdAt: '2026-11-24T00:00:00.000Z',
  }
}
