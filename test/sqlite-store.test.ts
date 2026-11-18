import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import type { Clock } from '../src/core/clock.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

describe('PegasStore', () => {
  it('persists runtime settings without overwriting saved choices', () => {
    const store = new PegasStore(':memory:')
    const defaults = {
      routerMode: 'model' as const,
      modelProvider: 'openai' as const,
      modelName: 'gpt-default',
      agentModelMode: 'profile' as const,
      agentModelProvider: '',
      agentModelName: '',
      privacyMode: 'disabled' as const,
      rewriteMode: 'disabled' as const,
    }

    expect(store.initializeRuntimeSettings(defaults)).toMatchObject({
      ...defaults,
      revision: 1,
    })
    const saved = store.updateRuntimeSettings(1, {
      ...defaults,
      modelName: 'gpt-saved',
      privacyMode: 'mask',
      rewriteMode: 'light',
    })

    expect(saved).toMatchObject({
      modelName: 'gpt-saved',
      privacyMode: 'mask',
      rewriteMode: 'light',
      revision: 2,
    })
    expect(
      store.initializeRuntimeSettings({
        ...defaults,
        modelName: 'gpt-new-env',
      }),
    ).toEqual(saved)
    expect(() => store.updateRuntimeSettings(1, defaults)).toThrow(
      '其他设备更新',
    )
    store.close()
  })

  it('updates a provider connection and runtime selection in one revision transaction', () => {
    const store = new PegasStore(':memory:')
    const defaults = {
      routerMode: 'rules' as const,
      modelProvider: 'openai' as const,
      modelName: 'gpt-5-mini',
      agentModelMode: 'profile' as const,
      agentModelProvider: '',
      agentModelName: '',
      privacyMode: 'disabled' as const,
      rewriteMode: 'disabled' as const,
    }
    store.initializeRuntimeSettings(defaults)

    const saved = store.updateRuntimeSettingsAndProvider(
      1,
      { ...defaults, routerMode: 'model' },
      {
        id: 'openai',
        name: 'OpenAI',
        protocol: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyCiphertext: 'encrypted-key-one',
        clearApiKey: false,
      },
    )

    expect(saved).toMatchObject({ revision: 2, routerMode: 'model' })
    expect(store.getModelProviderConnection('openai')).toMatchObject({
      apiKeyCiphertext: 'encrypted-key-one',
    })
    expect(() =>
      store.updateRuntimeSettingsAndProvider(1, defaults, {
        id: 'openai',
        name: 'OpenAI',
        protocol: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyCiphertext: 'must-not-win',
        clearApiKey: false,
      }),
    ).toThrow('其他设备更新')
    expect(store.getModelProviderConnection('openai')).toMatchObject({
      apiKeyCiphertext: 'encrypted-key-one',
    })
    store.close()
  })

  it('saves a rewrite connection with the settings revision and clears a key when its address changes', () => {
    const store = new PegasStore(':memory:')
    const settings = {
      routerMode: 'rules' as const,
      modelProvider: 'openai' as const,
      modelName: 'router-model',
      agentModelMode: 'profile' as const,
      agentModelProvider: '',
      agentModelName: '',
      privacyMode: 'disabled' as const,
      rewriteMode: 'light' as const,
    }
    store.initializeRuntimeSettings(settings)
    const provider = {
      id: 'openai' as const,
      name: 'OpenAI',
      protocol: 'openai-chat' as const,
      baseUrl: 'https://api.openai.com/v1',
      clearApiKey: false,
    }
    store.updateRuntimeSettingsAndProvider(1, settings, provider, undefined, {
      mode: 'custom',
      protocol: 'openai-chat',
      baseUrl: 'https://one.example/v1',
      model: 'rewrite-one',
      apiKeyCiphertext: 'encrypted-one',
      clearApiKey: false,
    })
    expect(store.getRewriteSettings()).toMatchObject({
      mode: 'custom',
      hasApiKey: true,
    })
    expect(() =>
      store.updateRuntimeSettingsAndProvider(1, settings, provider, undefined, {
        mode: 'custom',
        protocol: 'openai-chat',
        baseUrl: 'https://two.example/v1',
        model: 'rewrite-two',
        clearApiKey: false,
      }),
    ).toThrow('其他设备更新')
    expect(store.getRewriteConnection().baseUrl).toBe('https://one.example/v1')
    store.updateRuntimeSettingsAndProvider(2, settings, provider, undefined, {
      mode: 'custom',
      protocol: 'openai-chat',
      baseUrl: 'https://two.example/v1',
      model: 'rewrite-two',
      clearApiKey: false,
    })
    expect(store.getRewriteSettings()).toMatchObject({
      baseUrl: 'https://two.example/v1',
      hasApiKey: false,
    })
    store.close()
  })

  it('deduplicates source events without losing the original event', () => {
    const store = new PegasStore(':memory:')
    const input = {
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      dedupeKey: 'message-1',
      payload: { text: 'Build a feature' },
    }

    const first = store.enqueueEvent(input)
    const duplicate = store.enqueueEvent(input)

    expect(first.inserted).toBe(true)
    expect(duplicate.inserted).toBe(false)
    expect(duplicate.event.id).toBe(first.event.id)
    store.close()
  })

  it('leases events and only lets the owner complete them', () => {
    const store = new PegasStore(':memory:')
    store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      payload: { text: 'Hello' },
    })

    const event = store.claimNextEvent('worker-1')

    expect(event?.status).toBe('processing')
    expect(() => store.completeEvent(event?.id ?? '', 'worker-2')).toThrow(
      /does not own/,
    )
    store.completeEvent(event?.id ?? '', 'worker-1')
    expect(store.claimNextEvent('worker-1')).toBeUndefined()
    store.close()
  })

  it('creates one task and one outbox message when an event is retried', () => {
    const store = new PegasStore(':memory:')
    const { event } = store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      payload: { text: 'Add self recovery' },
    })

    const taskA = store.createTaskFromEvent(event, 'Add self recovery')
    const taskB = store.createTaskFromEvent(event, 'A duplicate title')
    const messageA = store.enqueueOutbox({
      userId: event.userId,
      taskId: taskA.id,
      channel: 'mobile',
      dedupeKey: `task-created:${taskA.id}`,
      payload: { taskId: taskA.id },
    })
    const messageB = store.enqueueOutbox({
      userId: event.userId,
      taskId: taskA.id,
      channel: 'mobile',
      dedupeKey: `task-created:${taskA.id}`,
      payload: { taskId: taskA.id },
    })

    expect(taskB.id).toBe(taskA.id)
    expect(messageB.id).toBe(messageA.id)
    expect(store.listTasks()).toHaveLength(1)
    store.close()
  })

  it('does not duplicate a run when routing is replayed after a crash', () => {
    const store = new PegasStore(':memory:')
    const { event } = store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      payload: { text: 'Implement durable routing' },
    })
    const decision = {
      kind: 'create_task' as const,
      title: 'Implement durable routing',
      goal: 'Implement durable routing',
      input: 'Implement durable routing',
      reason: 'test',
    }

    const first = store.applyRoutingDecision(event, decision, 'test-executor')
    const replay = store.applyRoutingDecision(event, decision, 'test-executor')

    expect(replay.task.id).toBe(first.task.id)
    expect(replay.run.id).toBe(first.run.id)
    expect(store.listRuns()).toHaveLength(1)
    store.close()
  })

  it('retries with a new immutable execution record and idempotent lineage', () => {
    const store = new PegasStore(':memory:')
    const { event } = store.enqueueEvent({
      userId: 'owner',
      source: 'web',
      type: 'user.message',
      payload: { text: 'Build' },
    })
    const decision = {
      kind: 'create_task' as const,
      title: 'Build',
      goal: 'Build',
      input: 'Original input',
      reason: 'test',
    }
    const initial = store.applyRoutingDecision(event, decision, 'test-executor')
    expect(initial.task.status).toBe('unstarted')
    expect(() => store.retryRun(initial.run.id, 'owner')).toThrow('Only failed')
    const claimed = store.claimNextRun('worker')
    expect(claimed?.task.status).toBe('started')
    store.recordExecutorRef(initial.run.id, 'worker', 'session-1')
    store.failRun(initial.run.id, 'worker', 'provider unavailable')
    const failed = store.listRuns()[0]
    expect(store.listTasks()[0]).toMatchObject({
      status: 'started',
      statusReason: 'last_run_failed',
    })
    expect(() => store.retryRun(initial.run.id, 'someone-else')).toThrow(
      'another user',
    )
    expect(() => store.retryRun('missing', 'owner')).toThrow('not found')
    const retry = store.retryRun(initial.run.id, 'owner')
    expect(retry.id).not.toBe(initial.run.id)
    expect(retry).toMatchObject({
      taskId: initial.task.id,
      retryOfRunId: initial.run.id,
      status: 'queued',
      input: 'Original input',
      resumeFromRef: 'session-1',
      attempts: 0,
    })
    expect(store.retryRun(initial.run.id, 'owner')).toEqual(retry)
    expect(
      store.applyRoutingDecision(event, decision, 'test-executor').run.id,
    ).toBe(initial.run.id)
    expect(store.listRuns()[0]).toEqual(failed)
    expect(store.listTasks()).toHaveLength(1)
    expect(store.listRuns()).toHaveLength(2)
    expect(store.claimNextRun('worker-2')?.run.id).toBe(retry.id)
    store.failRun(retry.id, 'worker-2', 'failed again')
    const secondRetry = store.retryRun(retry.id, 'owner')
    expect(secondRetry.retryOfRunId).toBe(retry.id)
    expect(secondRetry.resumeFromRef).toBe('session-1')
    expect(store.claimNextRun('worker-3')?.run.id).toBe(secondRetry.id)
    store.completeRun(secondRetry.id, 'worker-3', {
      executorRef: 'session-1',
      output: 'Ready for review',
    })
    expect(store.listTasks()[0]).toMatchObject({
      status: 'started',
      statusReason: 'awaiting_user_review',
    })
    expect(store.listRuns()).toHaveLength(3)
    store.close()
  })

  it('serializes runs for one task and rejects retrying superseded failures', () => {
    const store = new PegasStore(':memory:')
    const event = () =>
      store.enqueueEvent({
        userId: 'owner',
        source: 'web',
        type: 'user.message',
        payload: { text: 'Build' },
      }).event
    const initial = store.applyRoutingDecision(
      event(),
      {
        kind: 'create_task',
        title: 'Build',
        goal: 'Build',
        input: 'First',
        reason: 'test',
      },
      'test',
    )
    store.claimNextRun('worker')
    const continuation = store.applyRoutingDecision(
      event(),
      {
        kind: 'continue_task',
        taskId: initial.task.id,
        input: 'Follow up',
        reason: 'test',
      },
      'test',
    )
    expect(store.claimNextRun('worker-2')).toBeUndefined()
    store.failRun(initial.run.id, 'worker', 'error')
    expect(() => store.retryRun(initial.run.id, 'owner')).toThrow('active work')
    expect(store.claimNextRun('worker-2')?.run.id).toBe(continuation.run.id)
    store.failRun(continuation.run.id, 'worker-2', 'later error')
    expect(() => store.retryRun(initial.run.id, 'owner')).toThrow(
      'latest failed',
    )
    store.close()
  })

  it('upgrades every legacy task state without losing failed runs or reopening closed work', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-task-migration-'))
    const path = join(directory, 'pegas.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(
      readFileSync(
        new URL('./fixtures/schema-v4.sql', import.meta.url),
        'utf8',
      ),
    )
    const statuses = [
      'inbox',
      'planning',
      'running',
      'waiting',
      'failed',
      'paused',
      'completed',
      'cancelled',
    ]
    for (const status of statuses) {
      legacy
        .prepare(
          `INSERT INTO inbox_events (id,user_id,type,source,payload_json,status,created_at) VALUES (?,'owner','user.message','web','{}','processed','2026-11-17')`,
        )
        .run(status)
      legacy
        .prepare(
          `INSERT INTO tasks (id,user_id,origin_event_id,title,goal,status,created_at,updated_at) VALUES (?,'owner',?,?,?,?,'2026-11-17','2026-11-17')`,
        )
        .run(status, status, status, status, status)
      legacy
        .prepare(
          `INSERT INTO runs (id,task_id,executor,status,input_json,last_error,created_at,updated_at) VALUES (?,?,'test','failed','"Original"','Keep this error','2026-11-17','2026-11-17')`,
        )
        .run(status, status)
    }
    legacy.close()
    const store = new PegasStore(path)
    try {
      const mapped = Object.fromEntries(
        store.listTasks().map(task => [task.id, task.status]),
      )
      expect(mapped).toEqual({
        inbox: 'backlog',
        planning: 'unstarted',
        running: 'started',
        waiting: 'started',
        failed: 'started',
        paused: 'started',
        completed: 'completed',
        cancelled: 'cancelled',
      })
      expect(store.listRuns('failed')[0]).toMatchObject({
        status: 'failed',
        lastError: 'Keep this error',
        input: 'Original',
      })
      expect(() => store.retryRun('completed', 'owner')).toThrow('closed')
      expect(() => store.retryRun('cancelled', 'owner')).toThrow('closed')
      const db = new DatabaseSync(path)
      expect(() => db.exec("UPDATE tasks SET status = 'failed'")).toThrow(
        'Invalid task status',
      )
      db.close()
    } finally {
      store.close()
    }
    const reopened = new PegasStore(path)
    try {
      expect(reopened.listTasks()).toHaveLength(8)
    } finally {
      reopened.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('upgrades task-only v5 databases alongside provider settings', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'pegas-task-provider-upgrade-'),
    )
    const path = join(directory, 'pegas.sqlite')
    const legacy = new DatabaseSync(path)
    try {
      legacy.exec(
        readFileSync(
          new URL('./fixtures/schema-v4.sql', import.meta.url),
          'utf8',
        ),
      )
      legacy.exec(
        readFileSync(
          new URL('./fixtures/task-migration-v5.sql', import.meta.url),
          'utf8',
        ),
      )
      legacy
        .prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (5, '2026-11-18')",
        )
        .run()
      legacy
        .prepare(
          "INSERT INTO inbox_events (id,user_id,type,source,payload_json,status,created_at) VALUES ('event','owner','user.message','web','{}','processed','2026-11-18')",
        )
        .run()
      legacy
        .prepare(
          "INSERT INTO tasks (id,user_id,origin_event_id,title,goal,status,created_at,updated_at) VALUES ('task','owner','event','Goal','Goal','started','2026-11-18','2026-11-18')",
        )
        .run()
    } finally {
      legacy.close()
    }
    const upgraded = new PegasStore(path)
    try {
      expect(upgraded.listTasks()[0]).toMatchObject({
        status: 'started',
        title: 'Goal',
      })
      const db = new DatabaseSync(path)
      try {
        const versions = db
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all() as { version: number }[]
        expect(versions.map(row => row.version)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8, 9,
        ])
        expect(
          (
            db
              .prepare(
                "SELECT name FROM sqlite_master WHERE name = 'speech_connections'",
              )
              .get() as { name: string } | undefined
          )?.name,
        ).toBe('speech_connections')
        expect(
          (
            db.prepare('PRAGMA table_info(runtime_settings)').all() as {
              name: string
            }[]
          ).some(column => column.name === 'model_connection_id'),
        ).toBe(true)
        expect(
          (
            db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]
          ).some(column => column.name === 'retry_of_run_id'),
        ).toBe(true)
      } finally {
        db.close()
      }
    } finally {
      upgraded.close()
    }
    const reopened = new PegasStore(path)
    try {
      expect(reopened.listTasks()).toHaveLength(1)
    } finally {
      reopened.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('lets a new worker resume exactly when the durable lease expires', () => {
    const clock = new MutableClock('2026-11-17T00:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    const { event } = store.enqueueEvent({
      userId: 'user-1',
      type: 'user.message',
      source: 'mobile',
      payload: { text: 'Recover this run' },
    })
    store.applyRoutingDecision(
      event,
      {
        kind: 'create_task',
        title: 'Recover this run',
        goal: 'Recover this run',
        input: 'Recover this run',
        reason: 'test',
      },
      'test-executor',
    )
    const firstClaim = store.claimNextRun('worker-1', 1000)
    if (!firstClaim) throw new Error('Expected the first claim')
    store.recordExecutorRef(firstClaim.run.id, 'worker-1', 'session-durable')

    clock.set('2026-11-17T00:00:00.999Z')
    expect(store.claimNextRun('worker-2')).toBeUndefined()

    clock.set('2026-11-17T00:00:01.000Z')

    const recovered = store.claimNextRun('worker-2')

    expect(recovered?.run).toMatchObject({
      retryOfRunId: firstClaim.run.id,
      resumeFromRef: 'session-durable',
      claimedBy: 'worker-2',
      attempts: 1,
    })
    expect(recovered?.run.id).not.toBe(firstClaim.run.id)
    expect(store.listRuns()[0]).toMatchObject({
      status: 'failed',
      lastError: 'lease_expired',
    })
    expect(() =>
      store.completeRun(firstClaim.run.id, 'worker-1', {
        executorRef: 'stale',
        output: 'stale',
      }),
    ).toThrow(/does not own/)
    store.close()
  })
})

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
