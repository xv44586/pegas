import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/core/config.js'
import type { RunExecutor } from '../src/executor/executor.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  effectiveWorkerProfile,
  parseWorkerProfileUpdate,
  workerExecutionContext,
} from '../src/worker/worker-profile.js'
import {
  globalDefaultPoolModel,
  parseExecutionPools,
  resolveExecutionPool,
} from '../src/worker/execution-pools.js'
import { isTerminalProviderError } from '../src/worker/provider-errors.js'
import {
  decodeDshExecutionSnapshot,
  dshExecutorOptionsFromSnapshot,
} from '../src/worker/run-execution-snapshot.js'
import { executeClaimedRun } from '../src/worker/processor.js'
import { sameExecutionContext } from '../src/task/task-lifecycle.js'

function initialize(store: PegasStore): void {
  store.initializeRuntimeSettings(runtimeSettingsDefaults(loadConfig({})))
}

function seedTask(store: PegasStore, text: string) {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
  }).event
  const claimedEvent = store.claimNextEvent('pool-router')
  if (!claimedEvent) throw new Error('Expected event claim')
  const created = store.applyRoutingDecision(
    claimedEvent,
    { kind: 'create_task', title: text, goal: text, input: text, reason: 't' },
    'echo-test',
    task =>
      store.resolveWorkerExecutionContext(task.id, task.userId, {
        executor: 'echo-test',
        protocol: 'echo-v1',
      }),
  )
  store.completeEvent(event.id, 'pool-router')
  return created
}

describe('WORKER-002 pool resolution', () => {
  const pools = parseExecutionPools({
    fast: { provider: 'magpie', model: 'flash' },
    deep: { provider: 'magpie', model: 'pro' },
  })

  it('resolves configured pools exactly', () => {
    expect(resolveExecutionPool('fast', pools, undefined)).toEqual({
      requested: 'fast',
      actual: 'fast',
      model: { provider: 'magpie', model: 'flash' },
    })
    expect(resolveExecutionPool('deep', pools, undefined).model).toEqual({
      provider: 'magpie',
      model: 'pro',
    })
  })

  it('degrades fast to balanced to global default with a recorded reason', () => {
    const balancedOnly = parseExecutionPools({
      balanced: { provider: 'magpie', model: 'balanced-model' },
    })
    const toBalanced = resolveExecutionPool('fast', balancedOnly, undefined)
    expect(toBalanced.actual).toBe('balanced')
    expect(toBalanced.downgradeReason).toContain('fast')
    const toDefault = resolveExecutionPool(
      'fast',
      {},
      {
        provider: 'magpie',
        model: 'global',
      },
    )
    expect(toDefault.actual).toBeUndefined()
    expect(toDefault.model).toEqual({ provider: 'magpie', model: 'global' })
    expect(toDefault.downgradeReason).toContain('global default')
  })

  it('never silently upgrades deep and rejects unresolvable requests', () => {
    const rejected = resolveExecutionPool('deep', pools, undefined)
    expect(rejected.model).toEqual({ provider: 'magpie', model: 'pro' })
    const fastOnly = parseExecutionPools({
      fast: { provider: 'magpie', model: 'flash' },
    })
    const deepRejected = resolveExecutionPool('deep', fastOnly, undefined)
    expect(deepRejected.model).toBeUndefined()
    expect(deepRejected.downgradeReason).toContain('deep')
    expect(
      resolveExecutionPool('balanced', {}, undefined).model,
    ).toBeUndefined()
  })

  it('keeps single-model behavior unchanged without pools', () => {
    const settings = runtimeSettingsDefaults(loadConfig({}))
    expect(globalDefaultPoolModel(settings)).toBeUndefined()
    expect(resolveExecutionPool(undefined, {}, undefined)).toEqual({})
  })

  it('rejects unknown pool keys and malformed entries', () => {
    expect(() => parseExecutionPools({ turbo: {} })).toThrow('Unknown')
    expect(() =>
      parseExecutionPools({ fast: { provider: '', model: 'x' } }),
    ).toThrow('fast.provider')
    expect(parseExecutionPools({ fast: null })).toEqual({})
  })
})

describe('WORKER-002 profile pool and effort', () => {
  it('rejects pool combined with a direct model override', () => {
    expect(() =>
      parseWorkerProfileUpdate({
        commandId: 'c1',
        expectedRevision: 1,
        modelMode: 'override',
        modelProvider: 'magpie',
        modelName: 'x',
        pool: 'fast',
      }),
    ).toThrow('不能同时指定')
    expect(() =>
      parseWorkerProfileUpdate({
        commandId: 'c1',
        expectedRevision: 1,
        modelMode: 'inherit',
        pool: 'turbo',
      }),
    ).toThrow('pool must be')
  })

  it('persists pool and effort with revision bump and command replay', () => {
    const store = new PegasStore(':memory:')
    initialize(store)
    const { task } = seedTask(store, '整理资料')
    const updated = store.updateWorkerProfile(task.id, 'owner', {
      commandId: 'pool-set-1',
      expectedRevision: 1,
      modelMode: 'inherit',
      pool: 'fast',
      effort: 'low',
    })
    expect(updated).toMatchObject({ pool: 'fast', effort: 'low', revision: 2 })
    const replay = store.replayWorkerProfileUpdate(task.id, 'owner', {
      commandId: 'pool-set-1',
      expectedRevision: 1,
      modelMode: 'inherit',
      pool: 'fast',
      effort: 'low',
    })
    expect(replay).toEqual(updated)
    store.close()
  })

  it('records pool, effort and downgrade reason in the Run snapshot', () => {
    const store = new PegasStore(':memory:')
    initialize(store)
    const settings = store.getRuntimeSettings()
    store.updateRuntimeSettings(settings.revision, {
      ...settings,
      executionPools: { balanced: { provider: 'magpie', model: 'balanced' } },
    })
    const { task } = seedTask(store, '写报告')
    store.updateWorkerProfile(task.id, 'owner', {
      commandId: 'pool-set-2',
      expectedRevision: 1,
      modelMode: 'inherit',
      pool: 'fast',
      effort: 'high',
    })
    const context = store.resolveWorkerExecutionContext(task.id, 'owner', {
      executor: 'echo-test',
      protocol: 'echo-v1',
    })
    expect(context).toMatchObject({
      model: 'magpie/balanced',
      modelMode: 'override',
      executionPool: 'balanced',
      requestedPool: 'fast',
      reasoningEffort: 'high',
    })
    expect(context.poolDowngradeReason).toContain('fast')
    store.close()
  })

  it('refuses to route into an unresolvable pool instead of silently switching', () => {
    const store = new PegasStore(':memory:')
    initialize(store)
    const { task } = seedTask(store, '深度研究')
    store.updateWorkerProfile(task.id, 'owner', {
      commandId: 'pool-set-3',
      expectedRevision: 1,
      modelMode: 'inherit',
      pool: 'deep',
    })
    expect(() =>
      store.resolveWorkerExecutionContext(task.id, 'owner', {
        executor: 'echo-test',
        protocol: 'echo-v1',
      }),
    ).toThrow('deep')
    store.close()
  })

  it('keeps old profiles without pool fields fully compatible', () => {
    const store = new PegasStore(':memory:')
    initialize(store)
    const { task } = seedTask(store, '旧任务')
    const profile = store.getWorkerProfile(task.id, 'owner')
    expect(profile.pool).toBeUndefined()
    expect(profile.effort).toBeUndefined()
    const context = store.resolveWorkerExecutionContext(task.id, 'owner', {
      executor: 'echo-test',
      protocol: 'echo-v1',
    })
    expect(context.executionPool).toBeUndefined()
    expect(context.reasoningEffort).toBeUndefined()
    expect(context.model).toBe('profile')
    store.close()
  })

  it('includes pool and effort in session compatibility checks', () => {
    const base = {
      executor: 'dsh-headless',
      protocol: 'dsh-headless-v1',
      model: 'magpie/x',
      modelMode: 'override' as const,
      modelProvider: 'magpie',
      modelName: 'x',
    }
    expect(
      sameExecutionContext(base, { ...base, reasoningEffort: 'high' }),
    ).toBe(false)
    expect(
      sameExecutionContext(base, { ...base, executionPool: 'fast' as const }),
    ).toBe(false)
  })

  it('passes reasoning effort through the execution snapshot only with an explicit model', () => {
    const defaults = {
      executorProfile: 'headless',
      workspace: '/tmp',
      permissionMode: 'workspace-write',
      approvalPolicy: 'never' as const,
      additionalDirectories: [],
      privacyMode: 'disabled' as const,
    }
    const withModel = decodeDshExecutionSnapshot(
      {
        executionContext: {
          executor: 'dsh-headless',
          modelMode: 'override',
          modelProvider: 'magpie',
          modelName: 'x',
          model: 'magpie/x',
          reasoningEffort: 'high',
        },
      },
      defaults,
    )
    expect(
      dshExecutorOptionsFromSnapshot(withModel, {
        command: 'dsh',
        timeoutMs: 1000,
      }),
    ).toMatchObject({
      agentModel: { provider: 'magpie', model: 'x' },
      reasoningEffort: 'high',
    })
    const profileOnly = decodeDshExecutionSnapshot(
      {
        executionContext: {
          executor: 'dsh-headless',
          modelMode: 'profile',
          model: 'profile',
          reasoningEffort: 'high',
        },
      },
      defaults,
    )
    expect(profileOnly.reasoningEffort).toBeUndefined()
  })

  it('effective profile exposes pool resolution for the settings UI', () => {
    const settings = {
      ...runtimeSettingsDefaults(loadConfig({})),
      executionPools: parseExecutionPools({
        fast: { provider: 'magpie', model: 'flash' },
      }),
    }
    const effective = effectiveWorkerProfile(
      {
        id: 'p1',
        taskId: 't1',
        revision: 2,
        modelMode: 'inherit',
        pool: 'fast',
        effort: 'low',
        createdAt: '2026-11-22T00:00:00.000Z',
        updatedAt: '2026-11-22T00:00:00.000Z',
      },
      settings,
    )
    expect(effective).toMatchObject({
      modelRef: 'magpie/flash',
      pool: 'fast',
      effort: 'low',
      source: 'task',
    })
    const context = workerExecutionContext(effective, { executor: 'e' }, 3)
    expect(context.reasoningEffort).toBe('low')
  })
})

describe('WORKER-002 terminal provider errors', () => {
  it('classifies auth/model errors as terminal and throttling as transient', () => {
    expect(
      isTerminalProviderError('Model provider returned 401: invalid key'),
    ).toBe(true)
    expect(
      isTerminalProviderError('Model provider returned 403: forbidden'),
    ).toBe(true)
    expect(
      isTerminalProviderError('Model provider returned 404: model not found'),
    ).toBe(true)
    expect(isTerminalProviderError('Missing API key for OpenAI')).toBe(true)
    expect(
      isTerminalProviderError(
        'dsh: all_proxy names a SOCKS proxy, connecting directly\ndsh: PI_AI_ERROR: No API key for provider: magpie',
      ),
    ).toBe(true)
    expect(
      isTerminalProviderError('dsh: no credential for provider route "openai"'),
    ).toBe(true)
    expect(isTerminalProviderError('dsh: all_proxy names a SOCKS proxy')).toBe(
      false,
    )
    expect(
      isTerminalProviderError('Model provider returned 429: rate limited'),
    ).toBe(false)
    expect(
      isTerminalProviderError('Model provider returned 500: upstream'),
    ).toBe(false)
    expect(isTerminalProviderError('DSH execution timed out')).toBe(false)
    expect(isTerminalProviderError('fetch failed')).toBe(false)
  })

  it('parks the Task on the first DSH credential failure without a retry successor', async () => {
    const store = new PegasStore(':memory:')
    initialize(store)
    const { task } = seedTask(store, '调用坏密钥的模型')
    const claimed = store.claimNextRun('pool-worker')
    if (!claimed) throw new Error('Expected run claim')
    const failing: RunExecutor = {
      name: 'echo-test',
      execute: () =>
        Promise.reject(
          new Error('dsh: PI_AI_ERROR: No API key for provider: magpie'),
        ),
    }
    await executeClaimedRun(
      store,
      failing,
      claimed,
      'pool-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )
    const parked = store.findTask(task.id, 'owner')
    expect(parked?.statusReason).toBe('awaiting_provider_condition')
    const runs = store.listRuns(task.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('failed')
    const outbox = store.listOutbox('owner')
    expect(outbox[0]?.payload).toMatchObject({
      type: 'run.provider_terminal',
      runId: claimed.run.id,
    })
    store.close()
  })

  it('keeps transient failures on the existing retry path', async () => {
    const store = new PegasStore(':memory:')
    initialize(store)
    const { task } = seedTask(store, '偶发限流')
    const claimed = store.claimNextRun('pool-worker')
    if (!claimed) throw new Error('Expected run claim')
    const failing: RunExecutor = {
      name: 'echo-test',
      execute: () =>
        Promise.reject(new Error('Model provider returned 429: slow down')),
    }
    await executeClaimedRun(
      store,
      failing,
      claimed,
      'pool-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
    )
    expect(store.findTask(task.id, 'owner')?.statusReason).toBe(
      'last_run_failed',
    )
    const retried = store.retryRun(claimed.run.id, 'owner')
    expect(retried.retryOfRunId).toBe(claimed.run.id)
    store.close()
  })
})
