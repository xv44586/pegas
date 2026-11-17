import { describe, expect, it } from 'vitest'

import type { InboxEvent } from '../src/core/domain.js'
import type { RunExecutor } from '../src/executor/executor.js'
import type { TaskRouter } from '../src/router/router.js'
import {
  SettingsAwareExecutor,
  SettingsAwareTaskRouter,
} from '../src/settings/settings-aware-runtime.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

describe('settings-aware Worker boundaries', () => {
  it('resolves the latest settings before each route and execution', async () => {
    const store = new PegasStore(':memory:')
    const defaults = {
      routerMode: 'model' as const,
      modelProvider: 'openai' as const,
      modelName: 'model-one',
      agentModelMode: 'profile' as const,
      agentModelProvider: '',
      agentModelName: '',
      privacyMode: 'disabled' as const,
      rewriteMode: 'disabled' as const,
    }
    store.initializeRuntimeSettings(defaults)
    const seenRouterModels: string[] = []
    const seenExecutorModels: string[] = []
    const router = new SettingsAwareTaskRouter(store, settings => {
      seenRouterModels.push(settings.modelName)
      return passthroughRouter
    })
    const executor = new SettingsAwareExecutor(
      store,
      'settings-test',
      settings => {
        seenExecutorModels.push(settings.modelName)
        return echoExecutor
      },
    )
    const event = userEvent()
    const input = {
      runId: 'run-1',
      taskId: 'task-1',
      prompt: 'hello',
      workingDirectory: '/workspace',
      signal: new AbortController().signal,
    }

    await router.route(event, [])
    await executor.execute(input)
    store.updateRuntimeSettings(1, { ...defaults, modelName: 'model-two' })
    await router.route(event, [])
    await executor.execute(input)

    expect(seenRouterModels).toEqual(['model-one', 'model-two'])
    expect(seenExecutorModels).toEqual(['model-one', 'model-two'])
    expect(executor.name).toBe('settings-test')
    store.close()
  })
})

const passthroughRouter: TaskRouter = {
  route: () => Promise.resolve(undefined),
}

const echoExecutor: RunExecutor = {
  name: 'echo',
  execute: input =>
    Promise.resolve({ executorRef: 'ref', output: input.prompt }),
}

function userEvent(): InboxEvent {
  return {
    id: 'event-1',
    userId: 'user-1',
    type: 'user.message',
    source: 'web',
    payload: { text: 'hello' },
    status: 'processing',
    attempts: 1,
    createdAt: '2026-11-17T00:00:00.000Z',
  }
}
