import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import type { Clock } from '../src/core/clock.js'
import { workerIconIds } from '../src/brand/agent-icon.js'
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
      /does not hold the claim/,
    )
    store.completeEvent(event?.id ?? '', 'worker-1')
    expect(store.claimNextEvent('worker-1')).toBeUndefined()
    store.close()
  })

  it('releases an expired reserved event before assigning a new v2 claim', () => {
    const clock = new MutableClock('2026-11-19T09:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'collaboration.delegated',
      source: 'collaboration',
      payload: { relationId: 'reserved-retry' },
    }).event

    expect(store.claimNextEvent('v2-first', 1_000, 2)).toMatchObject({
      id: event.id,
      claimedBy: 'v2-first',
    })
    clock.set('2026-11-19T09:00:01.000Z')
    expect(store.claimNextEvent('v1-worker', 1_000, 1)).toBeUndefined()
    expect(store.claimNextEvent('v2-second', 1_000, 2)).toMatchObject({
      id: event.id,
      claimedBy: 'v2-second',
      attempts: 2,
    })

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
    expect(taskB.workerIconId).toBe(taskA.workerIconId)
    expect(workerIconIds).toContain(taskA.workerIconId)
    expect(messageB.id).toBe(messageA.id)
    expect(store.listTasks()).toHaveLength(1)
    store.close()
  })

  it('tracks product read state separately from delivery state', () => {
    const clock = new MutableClock('2026-11-19T09:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    const message = store.enqueueOutbox({
      userId: 'owner',
      channel: 'conversation',
      dedupeKey: 'attention-one',
      payload: { type: 'run.failed', error: 'Needs attention' },
    })

    expect(message.readAt).toBeUndefined()
    expect(message.status).toBe('pending')
    const read = store.markOutboxRead(message.id, 'owner')
    expect(read.readAt).toBe('2026-11-19T09:00:00.000Z')
    expect(read.status).toBe('pending')

    clock.set('2026-11-19T10:00:00.000Z')
    expect(store.markOutboxRead(message.id, 'owner').readAt).toBe(
      '2026-11-19T09:00:00.000Z',
    )
    expect(() => store.markOutboxRead(message.id, 'other')).toThrow(
      'does not exist for user',
    )
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

  it('prefers the authoritative task event relation over a conflicting payload taskId', () => {
    const store = new PegasStore(':memory:')
    const { event: firstEvent } = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: 'Create first' },
    })
    const first = store.applyRoutingDecision(
      firstEvent,
      {
        kind: 'create_task',
        title: 'First',
        goal: 'First',
        input: 'Create first',
        reason: 'test',
      },
      'test-executor',
    )
    const { event: secondEvent } = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: 'Create second' },
    })
    const second = store.applyRoutingDecision(
      secondEvent,
      {
        kind: 'create_task',
        title: 'Second',
        goal: 'Second',
        input: 'Create second',
        reason: 'test',
      },
      'test-executor',
    )
    const { event: conflicting } = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: 'Continue second', taskId: first.task.id },
    })
    store.applyRoutingDecision(
      conflicting,
      {
        kind: 'continue_task',
        taskId: second.task.id,
        input: 'Continue second',
        reason: 'authoritative relation wins',
      },
      'test-executor',
    )

    expect(store.listChannelEvents(first.task.id, 'owner')).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: conflicting.id })]),
    )
    expect(store.listChannelEvents(second.task.id, 'owner')).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: conflicting.id })]),
    )
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
      status: 'completed',
      ended: { by: 'executor', outcome: 'completed' },
    })
    expect(store.listRuns()).toHaveLength(3)
    store.close()
  })

  it('resumes completed work under its mandate and permanently rejects stopped work', () => {
    const store = new PegasStore(':memory:')
    const event = (id: string, text: string) =>
      store.enqueueEvent({
        id,
        userId: 'owner',
        source: 'web',
        type: 'user.message',
        payload: { text },
      }).event
    const initial = store.applyRoutingDecision(
      event('event-initial', 'Build it'),
      {
        kind: 'create_task',
        title: 'Build it',
        goal: 'Build it',
        input: 'Build it',
        reason: 'test',
      },
      'test-executor',
      { executor: 'test-executor', workspace: '/workspace', model: 'model-a' },
    )
    store.claimNextRun('worker-1')
    store.completeRun(initial.run.id, 'worker-1', {
      executorRef: 'session-1',
      output: 'Done',
    })
    expect(store.listTasks()[0]).toMatchObject({
      status: 'completed',
      mandate: {
        strength: 'explicit',
        policyVersion: 'pegas-mandate-v1',
        actor: { source: 'web', id: 'owner' },
        scope: 'Build it',
      },
      ended: { by: 'executor', outcome: 'completed' },
    })

    const resumed = store.applyRoutingDecision(
      event('event-resume', 'Add recovery'),
      {
        kind: 'continue_task',
        taskId: initial.task.id,
        input: 'Add recovery',
        reason: 'test',
      },
      'test-executor',
      { executor: 'test-executor', workspace: '/workspace', model: 'model-a' },
    )
    expect(resumed.task).toMatchObject({ status: 'unstarted' })
    expect(resumed.task.ended).toBeUndefined()
    expect(resumed.run).toMatchObject({
      status: 'queued',
      resumeFromRef: 'session-1',
      executionContext: {
        executor: 'test-executor',
        workspace: '/workspace',
        model: 'model-a',
      },
    })

    const claimed = store.claimNextRun('worker-2')
    expect(claimed?.run.id).toBe(resumed.run.id)
    const stopped = store.stopTask(
      initial.task.id,
      'owner',
      'stop-command-1',
      'User stopped the channel',
    )
    expect(stopped).toMatchObject({
      status: 'cancelled',
      ended: {
        by: 'human',
        outcome: 'stopped',
        reason: 'User stopped the channel',
      },
    })
    expect(store.stopTask(initial.task.id, 'owner', 'stop-command-1')).toEqual(
      stopped,
    )
    expect(store.stopTask(initial.task.id, 'owner', 'stop-command-2')).toEqual(
      stopped,
    )
    expect(store.listRuns(initial.task.id).at(-1)).toMatchObject({
      status: 'cancelled',
    })
    expect(() =>
      store.completeRun(resumed.run.id, 'worker-2', {
        executorRef: 'session-stale',
        output: 'stale result',
      }),
    ).toThrow(/does not own/)
    expect(() =>
      store.applyRoutingDecision(
        event('event-after-stop', 'Continue anyway'),
        {
          kind: 'continue_task',
          taskId: initial.task.id,
          input: 'Continue anyway',
          reason: 'test',
        },
        'test-executor',
      ),
    ).toThrow(/stopped/)
    expect(store.listRuns(initial.task.id)).toHaveLength(2)
    store.close()
  })

  it('records provider-reported model usage and isolates reports by owner and Channel', () => {
    const store = new PegasStore(':memory:')
    const createRun = (userId: string, eventId: string, model: string) => {
      const event = store.enqueueEvent({
        id: eventId,
        userId,
        source: 'web',
        type: 'user.message',
        payload: { text: `Work for ${userId}` },
      }).event
      return store.applyRoutingDecision(
        event,
        {
          kind: 'create_task',
          title: `Channel for ${userId}`,
          goal: `Work for ${userId}`,
          input: `Work for ${userId}`,
          reason: 'usage test',
        },
        'dsh-headless',
        {
          executor: 'dsh-headless',
          workspace: `/workspace/${userId}`,
          model,
        },
      )
    }

    const owner = createRun('owner', 'usage-owner', 'magpie/model-a')
    expect(store.claimNextRun('worker-owner')?.run.id).toBe(owner.run.id)
    store.completeRun(owner.run.id, 'worker-owner', {
      executorRef: 'session-owner',
      output: 'Owner result',
      durationMs: 1234,
      usage: {
        source: 'provider_reported',
        reportedSteps: 2,
        unreportedSteps: 1,
        tokens: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 210,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
          reasoningTokens: 5,
        },
      },
    })

    const other = createRun('other', 'usage-other', 'magpie/model-b')
    expect(store.claimNextRun('worker-other')?.run.id).toBe(other.run.id)
    store.completeRun(other.run.id, 'worker-other', {
      executorRef: 'session-other',
      output: 'Other result',
    })

    const ownerReport = store.listModelUsage('owner', owner.task.id)
    expect(ownerReport.records).toHaveLength(1)
    expect(ownerReport.records[0]).toMatchObject({
      runId: owner.run.id,
      taskId: owner.task.id,
      userId: 'owner',
      executor: 'dsh-headless',
      modelRef: 'magpie/model-a',
      completeness: 'partial',
      tokenSource: 'provider_reported',
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 210,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
      reportedSteps: 2,
      unreportedSteps: 1,
      durationMs: 1234,
      latencySource: 'pegas_observed',
    })
    expect(ownerReport.summary).toEqual({
      records: 1,
      completeRecords: 0,
      partialRecords: 1,
      unavailableRecords: 0,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
      durationMs: 1234,
    })
    expect(store.listModelUsage('owner', other.task.id).records).toEqual([])
    expect(store.listModelUsage('other').records[0]).toMatchObject({
      runId: other.run.id,
      userId: 'other',
      completeness: 'unavailable',
      reportedSteps: 0,
      unreportedSteps: 0,
    })
    expect(store.listModelUsage('other').summary).toMatchObject({
      records: 1,
      unavailableRecords: 1,
      inputTokens: 0,
      outputTokens: 0,
    })
    store.close()
  })

  it('keeps the task active until every queued continuation run is terminal', () => {
    const store = new PegasStore(':memory:')
    const nextEvent = (id: string) =>
      store.enqueueEvent({
        id,
        userId: 'owner',
        source: 'automation',
        type: 'user.message',
        payload: { text: id },
      }).event
    const first = store.applyRoutingDecision(
      nextEvent('first'),
      {
        kind: 'create_task',
        title: 'Ordered work',
        goal: 'Ordered work',
        input: 'first',
        reason: 'test',
      },
      'test-executor',
    )
    const second = store.applyRoutingDecision(
      nextEvent('second'),
      {
        kind: 'continue_task',
        taskId: first.task.id,
        input: 'second',
        reason: 'test',
      },
      'test-executor',
    )
    const claimedFirst = store.claimNextRun('worker')
    expect(claimedFirst?.run.id).toBe(first.run.id)

    store.completeRun(first.run.id, 'worker', {
      executorRef: 'session-one',
      output: 'first done',
    })

    expect(store.listTasks('owner')[0]).toMatchObject({ status: 'started' })
    expect(store.listTasks('owner')[0]?.ended).toBeUndefined()
    expect(store.claimNextRun('worker')?.run.id).toBe(second.run.id)
    store.close()
  })

  it('starts a fresh executor session when the execution context changed', () => {
    const store = new PegasStore(':memory:')
    const nextEvent = (id: string) =>
      store.enqueueEvent({
        id,
        userId: 'owner',
        source: 'web',
        type: 'user.message',
        payload: { text: id },
      }).event
    const initial = store.applyRoutingDecision(
      nextEvent('one'),
      {
        kind: 'create_task',
        title: 'Context',
        goal: 'Context',
        input: 'one',
        reason: 'test',
      },
      'dsh-cli',
      { executor: 'dsh-cli', workspace: '/one', model: 'model-a' },
    )
    store.claimNextRun('worker')
    store.completeRun(initial.run.id, 'worker', {
      executorRef: 'session-one',
      output: 'done',
    })
    const continuation = store.applyRoutingDecision(
      nextEvent('two'),
      {
        kind: 'continue_task',
        taskId: initial.task.id,
        input: 'two',
        reason: 'test',
      },
      'dsh-cli',
      { executor: 'dsh-cli', workspace: '/two', model: 'model-a' },
    )
    expect(continuation.run.resumeFromRef).toBeUndefined()
    store.close()
  })

  it('serializes runs for one task and rejects retrying superseded failures', () => {
    const store = new PegasStore(':memory:')
    const event = () =>
      store.enqueueEvent({
        userId: 'owner',
        source: 'automation',
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
    store.claimNextRun('worker')
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
      expect(
        store
          .listTasks()
          .every(task => workerIconIds.includes(task.workerIconId)),
      ).toBe(true)
      expect(store.listRuns('failed')[0]).toMatchObject({
        status: 'failed',
        lastError: 'Keep this error',
        input: 'Original',
      })
      expect(store.listChannelEvents('inbox', 'owner')).toEqual([
        expect.objectContaining({ id: 'inbox', userId: 'owner' }),
      ])
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
      legacy
        .prepare(
          "INSERT INTO actions (id,task_id,run_id,kind,risk,idempotency_key,status,request_json,created_at,updated_at) VALUES ('legacy-action','task',NULL,'legacy','high','legacy-key','pending','{}','2026-11-18','2026-11-18')",
        )
        .run()
      legacy
        .prepare(
          "INSERT INTO actions (id,task_id,run_id,kind,risk,idempotency_key,status,request_json,created_at,updated_at) VALUES ('other-legacy-action','task',NULL,'legacy','high','legacy:legacy-action','pending','{}','2026-11-18','2026-11-18')",
        )
        .run()
      legacy
        .prepare(
          "INSERT INTO approvals (id,task_id,action_id,status,prompt_json,created_at) VALUES ('legacy-approval','task','legacy-action','pending','{}','2026-11-18')",
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
          1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
          21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37,
          38, 39, 40, 41, 42,
        ])
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_relations'",
            )
            .get(),
        ).toEqual({ name: 'channel_relations' })
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automations'",
            )
            .get(),
        ).toEqual({ name: 'automations' })
        expect(
          (
            db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('worker_profiles', 'worker_profile_commands') ORDER BY name",
              )
              .all() as { name: string }[]
          ).map(row => row.name),
        ).toEqual(['worker_profile_commands', 'worker_profiles'])
        expect(
          db
            .prepare(
              "SELECT task_id, revision, model_mode FROM worker_profiles WHERE task_id = 'task'",
            )
            .get(),
        ).toMatchObject({
          task_id: 'task',
          revision: 1,
          model_mode: 'inherit',
        })
        expect(
          (
            db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]
          ).map(column => column.name),
        ).toEqual(
          expect.arrayContaining([
            'execution_contract_version',
            'claimed_contract_version',
          ]),
        )
        expect(
          (
            db.prepare('PRAGMA table_info(inbox_events)').all() as {
              name: string
            }[]
          ).map(column => column.name),
        ).toEqual(
          expect.arrayContaining([
            'required_contract_version',
            'claimed_contract_version',
          ]),
        )
        db.prepare(
          "INSERT INTO inbox_events (id,user_id,type,source,payload_json,status,required_contract_version,created_at) VALUES ('future-event','owner','collaboration.delegated','collaboration','{}','pending',2,'2026-11-20')",
        ).run()
        expect(() =>
          db
            .prepare(
              "UPDATE inbox_events SET status = 'processing', claimed_by = 'old-worker' WHERE id = 'future-event'",
            )
            .run(),
        ).toThrow(/unsupported inbox event contract/)
        db.prepare(
          "UPDATE inbox_events SET status = 'processing', claimed_by = 'new-worker', claimed_contract_version = 2 WHERE id = 'future-event'",
        ).run()
        db.prepare(
          "UPDATE inbox_events SET lease_until = '2026-11-19' WHERE id = 'future-event'",
        ).run()
        expect(() =>
          db
            .prepare(
              "UPDATE inbox_events SET status = 'processing', claimed_by = 'old-retry-worker' WHERE id = 'future-event'",
            )
            .run(),
        ).toThrow(/claim must be released before transfer/)
        db.prepare(
          "UPDATE inbox_events SET status = 'pending', claimed_by = NULL, lease_until = NULL WHERE id = 'future-event'",
        ).run()
        expect(
          db
            .prepare(
              "SELECT claimed_contract_version FROM inbox_events WHERE id = 'future-event'",
            )
            .get(),
        ).toEqual({ claimed_contract_version: null })
        expect(() =>
          db
            .prepare(
              "UPDATE inbox_events SET status = 'processing', claimed_by = 'old-worker' WHERE id = 'future-event'",
            )
            .run(),
        ).toThrow(/unsupported inbox event contract/)
        db.prepare(
          "UPDATE inbox_events SET status = 'processing', claimed_by = 'new-retry-worker', claimed_contract_version = 2 WHERE id = 'future-event'",
        ).run()
        db.prepare("DELETE FROM inbox_events WHERE id = 'future-event'").run()
        db.prepare(
          "INSERT INTO inbox_events (id,user_id,type,source,payload_json,status,created_at) VALUES ('mixed-writer-event','owner','user.message','old-worker','{}','processed','2026-11-20')",
        ).run()
        db.prepare(
          "INSERT INTO tasks (id,user_id,origin_event_id,title,goal,status,created_at,updated_at) VALUES ('mixed-writer-task','owner','mixed-writer-event','Mixed writer','Mixed writer','completed','2026-11-20','2026-11-20')",
        ).run()
        expect(
          db
            .prepare(
              "SELECT task_id, revision FROM worker_profiles WHERE task_id = 'mixed-writer-task'",
            )
            .get(),
        ).toMatchObject({ task_id: 'mixed-writer-task', revision: 1 })
        db.prepare(
          "DELETE FROM worker_profiles WHERE task_id = 'mixed-writer-task'",
        ).run()
        db.prepare("DELETE FROM tasks WHERE id = 'mixed-writer-task'").run()
        db.prepare(
          "DELETE FROM inbox_events WHERE id = 'mixed-writer-event'",
        ).run()

        db.prepare(
          "INSERT INTO runs (id,task_id,executor,status,execution_contract_version,created_at,updated_at) VALUES ('future-run','task','dsh-headless','queued',2,'2026-11-20','2026-11-20')",
        ).run()
        expect(() =>
          db
            .prepare(
              "UPDATE runs SET status = 'running', claimed_by = 'old-worker' WHERE id = 'future-run'",
            )
            .run(),
        ).toThrow(/unsupported execution contract/)
        db.prepare(
          "UPDATE runs SET status = 'running', claimed_by = 'new-worker', claimed_contract_version = 2 WHERE id = 'future-run'",
        ).run()
        db.prepare(
          "UPDATE runs SET status = 'waiting', lease_until = '2026-11-19' WHERE id = 'future-run'",
        ).run()
        expect(() =>
          db
            .prepare(
              "UPDATE runs SET claimed_by = 'old-report-worker' WHERE id = 'future-run'",
            )
            .run(),
        ).toThrow(/unsupported execution contract handoff/)
        db.prepare(
          "UPDATE runs SET claimed_by = NULL, claimed_contract_version = NULL WHERE id = 'future-run'",
        ).run()
        db.prepare(
          "UPDATE runs SET claimed_by = 'new-report-worker', claimed_contract_version = 2 WHERE id = 'future-run'",
        ).run()
        expect(() =>
          db
            .prepare(
              "INSERT INTO runs (id,task_id,retry_of_run_id,executor,status,created_at,updated_at) VALUES ('downgraded-retry','task','future-run','dsh-headless','queued','2026-11-20','2026-11-20')",
            )
            .run(),
        ).toThrow(/execution contract downgrade/)
        db.prepare("DELETE FROM runs WHERE id = 'future-run'").run()
        expect(
          (
            db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('goal_contracts', 'task_artifacts', 'evidence_refs', 'evidence_commands', 'evidence_verification_events', 'worker_reports', 'review_packs') ORDER BY name",
              )
              .all() as { name: string }[]
          ).map(row => row.name),
        ).toEqual([
          'evidence_commands',
          'evidence_refs',
          'evidence_verification_events',
          'goal_contracts',
          'review_packs',
          'task_artifacts',
          'worker_reports',
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
            db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('approval_decisions', 'action_outcomes') ORDER BY name",
              )
              .all() as { name: string }[]
          ).map(row => row.name),
        ).toEqual(['action_outcomes', 'approval_decisions'])
        expect(
          (
            db.prepare('PRAGMA table_info(actions)').all() as {
              name: string
            }[]
          ).map(column => column.name),
        ).toEqual(
          expect.arrayContaining([
            'resume_run_id',
            'recovery_point_json',
            'request_claim_hash',
            'request_fingerprint',
            'protocol_version',
          ]),
        )
        expect(
          (
            db.prepare('PRAGMA table_info(approvals)').all() as {
              name: string
            }[]
          ).map(column => column.name),
        ).toEqual(expect.arrayContaining(['user_id', 'protocol_version']))
        expect(
          (
            db
              .prepare(
                "SELECT user_id FROM approvals WHERE id = 'legacy-approval'",
              )
              .get() as { user_id: string } | undefined
          )?.user_id,
        ).toBe('owner')
        expect(
          (
            db.prepare("PRAGMA index_list('approvals')").all() as {
              name: string
            }[]
          ).map(index => index.name),
        ).toEqual(
          expect.arrayContaining([
            'approvals_by_user_time',
            'approvals_by_user_status_time',
          ]),
        )
        const legacyApproval = db
          .prepare(
            "SELECT status, response_json, resolved_at, protocol_version FROM approvals WHERE id = 'legacy-approval'",
          )
          .get() as
          | {
              status: string
              response_json: string | null
              resolved_at: string | null
              protocol_version: number
            }
          | undefined
        expect(legacyApproval).toMatchObject({
          status: 'pending',
          response_json: null,
          resolved_at: null,
          protocol_version: 0,
        })
        const legacyAction = db
          .prepare(
            "SELECT status, idempotency_key, result_json, protocol_version FROM actions WHERE id = 'legacy-action'",
          )
          .get() as
          | {
              status: string
              idempotency_key: string
              result_json: string | null
              protocol_version: number
            }
          | undefined
        expect(legacyAction).toMatchObject({
          status: 'pending',
          idempotency_key: 'legacy-key',
          result_json: null,
          protocol_version: 0,
        })
        expect(
          (
            db.prepare("PRAGMA index_list('actions')").all() as {
              name: string
              unique: number
              partial: number
            }[]
          ).find(index => index.name === 'actions_v1_idempotency_key'),
        ).toMatchObject({ unique: 1, partial: 1 })
        expect(upgraded.getApproval('legacy-approval', 'owner')).toBeUndefined()
        expect(
          (
            db.prepare('PRAGMA table_info(outbox_messages)').all() as {
              name: string
            }[]
          ).some(column => column.name === 'read_at'),
        ).toBe(true)
        expect(
          (
            db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]
          ).some(column => column.name === 'retry_of_run_id'),
        ).toBe(true)
        expect(
          (
            db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]
          ).some(column => column.name === 'goal_revision'),
        ).toBe(true)
        expect(
          (
            db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]
          ).some(column => column.name === 'claim_token_hash'),
        ).toBe(true)
        expect(
          (
            db.prepare('PRAGMA table_info(worker_reports)').all() as {
              name: string
            }[]
          ).some(column => column.name === 'claim_token_hash'),
        ).toBe(true)
        expect(
          (
            db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
          ).some(column => column.name === 'mandate_json'),
        ).toBe(true)
        expect(
          (
            db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
          ).some(column => column.name === 'worker_icon_id'),
        ).toBe(true)
        expect(
          (
            db.prepare('PRAGMA table_info(model_usage_records)').all() as {
              name: string
            }[]
          ).map(column => column.name),
        ).toEqual(
          expect.arrayContaining([
            'run_id',
            'model_ref',
            'completeness',
            'cache_read_tokens',
            'duration_ms',
            'cost_usd',
          ]),
        )
      } finally {
        db.close()
      }

      const event = upgraded.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'migration-test',
        payload: { text: 'Create a v1 Action.' },
      }).event
      const claimedEvent = upgraded.claimNextEvent('migration-event-worker')
      if (claimedEvent?.id !== event.id)
        throw new Error('Expected migration Event claim')
      const applied = upgraded.applyRoutingDecision(
        claimedEvent,
        {
          kind: 'create_task',
          title: 'Create a v1 Action',
          goal: 'Create a v1 Action',
          input: 'Create a v1 Action',
          reason: 'migration idempotency isolation test',
        },
        'echo',
      )
      upgraded.completeEvent(event.id, 'migration-event-worker')
      const claimedRun = upgraded.claimNextRun('migration-run-worker')
      if (claimedRun?.task.id !== applied.task.id)
        throw new Error('Expected migration Run claim')
      expect(
        upgraded.requestApproval(claimedRun.run.id, claimedRun.claimToken, {
          kind: 'publish.release',
          risk: 'high',
          idempotencyKey: 'legacy-key',
          request: { release: 'v1' },
          recoveryPoint: { step: 'before_publish' },
          approval: {
            summary: 'Publish release',
            impact: 'Makes the release public',
            recommendedOptionId: 'reject',
            options: [
              { id: 'approve', label: 'Publish', kind: 'approve' },
              { id: 'reject', label: 'Do not publish', kind: 'reject' },
            ],
          },
        }),
      ).toMatchObject({
        action: { idempotencyKey: 'legacy-key', status: 'awaiting_approval' },
        approval: { status: 'pending' },
      })
    } finally {
      upgraded.close()
    }
    const reopened = new PegasStore(path)
    try {
      expect(reopened.listTasks()).toHaveLength(2)
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

  it('enforces collaboration ownership and Run linkage at the database boundary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-relation-integrity-'))
    const path = join(directory, 'pegas.sqlite')
    const store = new PegasStore(path)
    const sourceEvent = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: 'Source' },
    }).event
    const source = store.applyRoutingDecision(
      sourceEvent,
      {
        kind: 'create_task',
        title: 'Source',
        goal: 'Source',
        input: 'Source',
        reason: 'test',
      },
      'echo',
    )
    const otherEvent = store.enqueueEvent({
      userId: 'other',
      type: 'user.message',
      source: 'web',
      payload: { text: 'Other' },
    }).event
    const other = store.applyRoutingDecision(
      otherEvent,
      {
        kind: 'create_task',
        title: 'Other',
        goal: 'Other',
        input: 'Other',
        reason: 'test',
      },
      'echo',
    )
    store.close()

    const db = new DatabaseSync(path)
    db.exec('PRAGMA foreign_keys = ON')
    const insert = db.prepare(
      `INSERT INTO channel_relations
       (id, command_id, command_fingerprint, request_claim_hash, user_id,
        kind, status, source_task_id, source_run_id, root_relation_id, depth,
        target_task_id, request_json, created_at, updated_at)
       VALUES (?, ?, 'fingerprint', 'claim', ?, 'delegate', 'pending', ?, ?, ?, 0,
        ?, '{}', '2026-11-20', '2026-11-20')`,
    )
    try {
      expect(() =>
        insert.run(
          'bad-source',
          'bad-source-command',
          'owner',
          other.task.id,
          source.run.id,
          'bad-source',
          null,
        ),
      ).toThrow(/invalid collaboration source/)
      expect(() =>
        insert.run(
          'bad-target',
          'bad-target-command',
          'owner',
          source.task.id,
          source.run.id,
          'bad-target',
          other.task.id,
        ),
      ).toThrow(/invalid collaboration target/)
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
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
