import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import type { RuntimeSettings } from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  effectiveWorkerProfile,
  parseWorkerProfileUpdate,
  workerExecutionContext,
  type WorkerProfile,
} from '../src/worker/worker-profile.js'

const profile: WorkerProfile = {
  id: 'worker-profile:task-1',
  taskId: 'task-1',
  revision: 1,
  modelMode: 'inherit',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
}

const settings: RuntimeSettings = {
  revision: 7,
  routerMode: 'rules',
  modelProvider: 'magpie',
  modelName: 'router-model',
  agentModelMode: 'override',
  agentModelProvider: 'discovery-api',
  agentModelName: 'deepseek-v4.1-flash-1017',
  privacyMode: 'disabled',
  rewriteMode: 'disabled',
  updatedAt: '2026-11-20T00:00:00.000Z',
}

describe('WORKER-001 profile contracts', () => {
  it('validates inherit and override updates without accepting ambiguous input', () => {
    expect(
      parseWorkerProfileUpdate({
        commandId: 'inherit-1',
        expectedRevision: 1,
        modelMode: 'inherit',
      }),
    ).toEqual({
      commandId: 'inherit-1',
      expectedRevision: 1,
      modelMode: 'inherit',
    })
    expect(
      parseWorkerProfileUpdate({
        commandId: 'override-1',
        expectedRevision: 1,
        modelMode: 'override',
        modelProvider: 'discovery-api',
        modelName: 'worker-model',
      }),
    ).toMatchObject({
      modelMode: 'override',
      modelProvider: 'discovery-api',
      modelName: 'worker-model',
    })
    expect(() =>
      parseWorkerProfileUpdate({
        commandId: 'invalid-inherit',
        expectedRevision: 1,
        modelMode: 'inherit',
        modelProvider: 'discovery-api',
      }),
    ).toThrow(/不能同时指定/)
    expect(() =>
      parseWorkerProfileUpdate({
        commandId: 'invalid-override',
        expectedRevision: 1,
        modelMode: 'override',
      }),
    ).toThrow(/需要 provider 和 model/)
  })

  it.each([
    ['blank command', { commandId: ' ' }],
    ['long command', { commandId: 'x'.repeat(241) }],
    ['zero revision', { expectedRevision: 0 }],
    ['fractional revision', { expectedRevision: 1.5 }],
    ['invalid mode', { modelMode: 'channel' }],
    [
      'long provider',
      {
        modelMode: 'override',
        modelProvider: 'p'.repeat(161),
        modelName: 'model',
      },
    ],
    [
      'long model',
      {
        modelMode: 'override',
        modelProvider: 'provider',
        modelName: 'm'.repeat(241),
      },
    ],
  ])('rejects %s at the API parser boundary', (_name, patch) => {
    expect(() =>
      parseWorkerProfileUpdate({
        commandId: 'command',
        expectedRevision: 1,
        modelMode: 'inherit',
        ...patch,
      }),
    ).toThrow()
  })

  it('resolves global inheritance and task override into explainable contexts', () => {
    const inherited = effectiveWorkerProfile(profile, settings)
    expect(inherited).toMatchObject({
      source: 'global',
      modelMode: 'override',
      modelProvider: 'discovery-api',
      modelName: 'deepseek-v4.1-flash-1017',
      modelRef: 'discovery-api/deepseek-v4.1-flash-1017',
    })
    expect(
      workerExecutionContext(
        inherited,
        {
          executor: 'dsh-headless',
          executorProfile: 'isolated-headless',
          workspace: '/workspace',
          permissions: '{"mode":"workspace-write"}',
          protocol: 'dsh-headless-v1',
        },
        settings.revision,
      ),
    ).toEqual({
      executor: 'dsh-headless',
      executorProfile: 'isolated-headless',
      workspace: '/workspace',
      permissions: '{"mode":"workspace-write"}',
      protocol: 'dsh-headless-v1',
      model: 'discovery-api/deepseek-v4.1-flash-1017',
      modelMode: 'override',
      modelProvider: 'discovery-api',
      modelName: 'deepseek-v4.1-flash-1017',
      settingsRevision: 7,
      workerProfile: profile.id,
      workerProfileRevision: 1,
      workerProfileSource: 'global',
      permissionTier: 'standard',
    })

    const overridden = effectiveWorkerProfile(
      {
        ...profile,
        revision: 2,
        modelMode: 'override',
        modelProvider: 'custom-provider',
        modelName: 'task-model',
      },
      settings,
    )
    expect(overridden).toMatchObject({
      source: 'task',
      modelRef: 'custom-provider/task-model',
    })
  })

  it('persists owner-scoped optimistic updates with immutable command replay', () => {
    const store = new PegasStore(':memory:')
    store.initializeRuntimeSettings(settings)
    const task = createTask(store, 'owner')
    expect(store.getWorkerProfile(task.id, 'owner')).toMatchObject({
      id: `worker-profile:${task.id}`,
      revision: 1,
      modelMode: 'inherit',
    })
    expect(() => store.getWorkerProfile(task.id, 'other')).toThrow(
      /another user/,
    )

    const update = {
      commandId: 'worker-profile-command-1',
      expectedRevision: 1,
      modelMode: 'override' as const,
      modelProvider: 'discovery-api',
      modelName: 'task-model',
    }
    const updated = store.updateWorkerProfile(task.id, 'owner', update)
    expect(updated).toMatchObject({
      revision: 2,
      modelMode: 'override',
      modelProvider: 'discovery-api',
      modelName: 'task-model',
    })
    expect(store.updateWorkerProfile(task.id, 'owner', update)).toEqual(updated)
    expect(() =>
      store.updateWorkerProfile(task.id, 'owner', {
        ...update,
        modelName: 'conflicting-model',
      }),
    ).toThrow(/command ID is already used/)
    expect(() =>
      store.updateWorkerProfile(task.id, 'owner', {
        ...update,
        commandId: 'stale-worker-profile-command',
        expectedRevision: 1,
      }),
    ).toThrow(/其他设备更新/)

    const unchanged = store.updateWorkerProfile(task.id, 'owner', {
      ...update,
      commandId: 'no-op-worker-profile-command',
      expectedRevision: 2,
    })
    expect(unchanged.revision).toBe(2)
    store.close()
  })

  it('resumes a completed work session after a routing-only settings save', () => {
    const store = new PegasStore(':memory:')
    try {
      const initialized = store.initializeRuntimeSettings(settings)
      const context = (task: { id: string; userId: string }) =>
        store.resolveWorkerExecutionContext(task.id, task.userId, {
          executor: 'dsh-headless',
          workspace: '/workspace',
          protocol: 'dsh-headless-v1',
        })
      const original = store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: { text: 'Review the project' },
      }).event
      const { task, run } = store.applyRoutingDecision(
        original,
        {
          kind: 'create_task',
          title: 'Review',
          goal: 'Review the project',
          input: 'Review the project',
          reason: 'test',
        },
        'dsh-headless',
        context,
      )
      expect(store.claimNextRun('worker-1')?.run.id).toBe(run.id)
      store.completeRun(run.id, 'worker-1', {
        executorRef: 'original-work-session',
        output: 'Draft findings',
      })

      const saved = store.updateRuntimeSettings(initialized.revision, {
        ...initialized,
        routingUncertainty: 'ask_first',
      })
      const followUp = store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: { taskId: task.id, text: 'Why the first finding?' },
      }).event
      const next = store.applyRoutingDecision(
        followUp,
        {
          kind: 'continue_task',
          taskId: task.id,
          input: 'Why the first finding?',
          reason: 'explicit follow-up',
        },
        'dsh-headless',
        context,
      )
      expect(next.run).toMatchObject({
        taskId: task.id,
        resumeFromRef: 'original-work-session',
        executionContext: { settingsRevision: saved.revision },
      })
    } finally {
      store.close()
    }
  })

  it('snapshots the effective profile per Run and rolls over incompatible sessions', () => {
    const store = new PegasStore(':memory:')
    store.initializeRuntimeSettings(settings)
    const firstEvent = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: 'Start the task' },
    }).event
    const claimedEvent = store.claimNextEvent('router-1')
    if (!claimedEvent) throw new Error('Expected event claim')
    const first = store.applyRoutingDecision(
      claimedEvent,
      {
        kind: 'create_task',
        title: 'Task',
        goal: 'Complete task',
        input: 'Start the task',
        reason: 'test',
      },
      'dsh-headless',
      task =>
        store.resolveWorkerExecutionContext(task.id, task.userId, {
          executor: 'dsh-headless',
          workspace: '/workspace',
          protocol: 'dsh-headless-v1',
        }),
    )
    store.completeEvent(firstEvent.id, 'router-1')
    expect(first.run.executionContext).toMatchObject({
      model: 'discovery-api/deepseek-v4.1-flash-1017',
      workerProfileSource: 'global',
      workerProfileRevision: 1,
    })
    const firstClaim = store.claimNextRun('worker-1')
    if (!firstClaim) throw new Error('Expected first Run claim')
    expect(firstClaim.run.executionContractVersion).toBe(2)
    store.recordExecutorRef(first.run.id, 'worker-1', 'session-global')
    store.completeRun(first.run.id, 'worker-1', {
      executorRef: 'session-global',
      output: 'First result',
    })

    store.updateWorkerProfile(first.task.id, 'owner', {
      commandId: 'override-before-continuation',
      expectedRevision: 1,
      modelMode: 'override',
      modelProvider: 'custom-provider',
      modelName: 'task-model',
    })
    expect(first.run.executionContext.model).toBe(
      'discovery-api/deepseek-v4.1-flash-1017',
    )

    const continuation = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { taskId: first.task.id, text: 'Continue' },
    }).event
    const claimedContinuation = store.claimNextEvent('router-2')
    if (!claimedContinuation) throw new Error('Expected continuation claim')
    const second = store.applyRoutingDecision(
      claimedContinuation,
      {
        kind: 'continue_task',
        taskId: first.task.id,
        input: 'Continue',
        reason: 'test override',
      },
      'dsh-headless',
      task =>
        store.resolveWorkerExecutionContext(task.id, task.userId, {
          executor: 'dsh-headless',
          workspace: '/workspace',
          protocol: 'dsh-headless-v1',
        }),
    )
    store.completeEvent(continuation.id, 'router-2')
    expect(second.run.executionContext).toMatchObject({
      model: 'custom-provider/task-model',
      workerProfileSource: 'task',
      workerProfileRevision: 2,
    })
    expect(second.run.resumeFromRef).toBeUndefined()

    const secondClaim = store.claimNextRun('worker-2')
    if (!secondClaim) throw new Error('Expected second Run claim')
    store.recordExecutorRef(second.run.id, 'worker-2', 'session-task-model')
    store.completeRun(second.run.id, 'worker-2', {
      executorRef: 'session-task-model',
      output: 'Second result',
    })
    const compatibleEvent = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { taskId: first.task.id, text: 'Continue again' },
    }).event
    const claimedCompatible = store.claimNextEvent('router-3')
    if (!claimedCompatible) throw new Error('Expected compatible claim')
    const third = store.applyRoutingDecision(
      claimedCompatible,
      {
        kind: 'continue_task',
        taskId: first.task.id,
        input: 'Continue again',
        reason: 'same execution settings',
      },
      'dsh-headless',
      task =>
        store.resolveWorkerExecutionContext(task.id, task.userId, {
          executor: 'dsh-headless',
          workspace: '/workspace',
          protocol: 'dsh-headless-v1',
        }),
    )
    store.completeEvent(compatibleEvent.id, 'router-3')
    expect(third.run.resumeFromRef).toBe('session-task-model')
    store.close()
  })

  it('bounds durable command replay history per Task', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-worker-profile-'))
    const path = join(directory, 'pegas.sqlite')
    try {
      const store = new PegasStore(path)
      store.initializeRuntimeSettings(settings)
      const task = createTask(store, 'owner')
      for (let index = 0; index < 300; index += 1) {
        store.updateWorkerProfile(task.id, 'owner', {
          commandId: `bounded-command-${String(index)}`,
          expectedRevision: 1,
          modelMode: 'inherit',
        })
      }
      store.close()

      const database = new DatabaseSync(path)
      try {
        const row = database
          .prepare(
            'SELECT COUNT(*) AS count FROM worker_profile_commands WHERE task_id = ?',
          )
          .get(task.id) as { count: number }
        expect(row.count).toBe(256)
      } finally {
        database.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('lazily restores an inherit profile for legacy tasks without a profile row', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-legacy-profile-'))
    const path = join(directory, 'pegas.sqlite')
    try {
      const store = new PegasStore(path)
      store.initializeRuntimeSettings(settings)
      const task = createTask(store, 'owner')
      store.close()

      const database = new DatabaseSync(path)
      database
        .prepare('DELETE FROM worker_profiles WHERE task_id = ?')
        .run(task.id)
      database.close()

      const reopened = new PegasStore(path)
      reopened.initializeRuntimeSettings(settings)
      const profile = reopened.getWorkerProfile(task.id, 'owner')
      expect(profile).toMatchObject({
        taskId: task.id,
        revision: 1,
        modelMode: 'inherit',
        createdAt: task.createdAt,
      })
      const context = reopened.resolveWorkerExecutionContext(task.id, 'owner', {
        executor: 'dsh-headless',
        workspace: '/workspace',
        protocol: 'dsh-headless-v1',
      })
      expect(context).toMatchObject({
        model: 'discovery-api/deepseek-v4.1-flash-1017',
        workerProfileSource: 'global',
      })
      const updated = reopened.updateWorkerProfile(task.id, 'owner', {
        commandId: 'legacy-profile-update',
        expectedRevision: 1,
        modelMode: 'inherit',
      })
      expect(updated.revision).toBe(1)
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function createTask(store: PegasStore, userId: string) {
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'test',
    payload: { text: 'Create task' },
  }).event
  return store.createTaskFromEvent(event, 'Task')
}
