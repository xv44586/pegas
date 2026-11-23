import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type { Clock } from '../src/core/clock.js'
import type { AutomationDraft } from '../src/schedule/schedule.js'
import {
  parseAutomationCreate,
  parseAutomationDraft,
} from '../src/schedule/schedule.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import {
  AutomationCommandConflictError,
  AutomationReadOnlyError,
  AutomationRevisionConflictError,
  AutomationTargetUnavailableError,
  PegasStore,
} from '../src/storage/sqlite-store.js'
import {
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('automation scheduling', () => {
  it('validates and normalizes one-time and interval Automation contracts', () => {
    expect(
      parseAutomationDraft({
        title: 'Morning brief',
        prompt: 'Prepare the morning brief.',
        schedule: {
          kind: 'interval',
          everySeconds: 3600,
          startsAt: '2026-11-21T10:00:00+08:00',
        },
        target: { kind: 'new_task' },
      }),
    ).toEqual({
      title: 'Morning brief',
      prompt: 'Prepare the morning brief.',
      schedule: {
        kind: 'interval',
        everySeconds: 3600,
        startsAt: '2026-11-21T02:00:00.000Z',
      },
      target: { kind: 'new_task' },
    })

    expect(() =>
      parseAutomationDraft({
        title: 'Too frequent',
        prompt: 'Check.',
        schedule: { kind: 'interval', everySeconds: 1 },
        target: { kind: 'new_task' },
      }),
    ).toThrow(/between 60/)
    expect(() =>
      parseAutomationDraft({
        title: 'Unknown target',
        prompt: 'Check.',
        schedule: { kind: 'once', at: '2026-11-22T00:00:00Z' },
        target: { kind: 'all_tasks' },
      }),
    ).toThrow(/new_task or existing_task/)
  })

  it('persists idempotent create commands and isolates owners', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-schedule-store-'))
    const databasePath = join(directory, 'pegas.sqlite')
    let store = new PegasStore(databasePath)
    const command = {
      userId: 'owner',
      commandId: 'create-automation-1',
      automation: {
        title: 'Daily review',
        prompt: 'Review the active work.',
        schedule: {
          kind: 'interval' as const,
          everySeconds: 3600,
        },
        target: { kind: 'new_task' as const },
      },
    }
    const created = store.createAutomation(command)
    expect(store.createAutomation(command)).toEqual(created)
    expect(store.listAutomations('owner')).toHaveLength(1)
    expect(store.listAutomations('other')).toEqual([])
    expect(() =>
      store.createAutomation({
        ...command,
        automation: { ...command.automation, title: 'Conflicting command' },
      }),
    ).toThrow(AutomationCommandConflictError)
    store.close()

    store = new PegasStore(databasePath)
    expect(store.findAutomation(created.id, 'owner')).toEqual(created)
    expect(store.findAutomation(created.id, 'other')).toBeUndefined()
    store.close()
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  })

  it('fires once through a durable invocation and routes it into a Run', async () => {
    const clock = new MutableClock('2026-11-21T02:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const automation = store.createAutomation({
      userId: 'owner',
      commandId: 'once-command',
      automation: automationDraft({
        schedule: { kind: 'once', at: '2026-11-21T02:01:00.000Z' },
      }),
    })

    expect(store.fireDueAutomations()).toEqual([])
    clock.set('2026-11-21T02:02:00.000Z')
    const fired = store.fireDueAutomations()
    expect(fired).toHaveLength(1)
    expect(fired[0]?.automation).toMatchObject({
      id: automation.id,
      status: 'completed',
      lastFiredAt: '2026-11-21T02:01:00.000Z',
    })
    expect(fired[0]?.invocation).toMatchObject({
      status: 'pending',
      scheduledFor: '2026-11-21T02:01:00.000Z',
    })
    expect(store.fireDueAutomations()).toEqual([])

    const event = store.listEvents('owner')[0]
    expect(event).toMatchObject({
      type: 'automation.due',
      source: 'automation',
    })
    if (!event) throw new Error('Expected automation Event')
    await processNextEvent(
      store,
      new RoutingEventHandler(
        new RuleBasedTaskRouter(),
        'test-executor',
        () => ({
          executor: 'test-executor',
        }),
      ),
      'automation-router',
    )
    const task = store.listTasks('owner')[0]
    expect(task).toMatchObject({
      title: 'Daily review',
      goal: 'Review the active work.',
      status: 'unstarted',
    })
    expect(store.listRuns(task?.id)).toMatchObject([
      {
        status: 'queued',
        input: 'Review the active work.',
      },
    ])
    expect(
      store.listAutomationInvocations(automation.id, 'owner').items[0],
    ).toMatchObject({
      status: 'dispatched',
      attempts: 1,
    })
  })

  it('does not replay missed intervals and honors pause, resume, and revision fences', () => {
    const clock = new MutableClock('2026-11-21T02:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const automation = store.createAutomation({
      userId: 'owner',
      commandId: 'interval-command',
      automation: automationDraft({
        schedule: {
          kind: 'interval',
          everySeconds: 3600,
          startsAt: '2026-11-21T03:00:00.000Z',
        },
      }),
    })
    const paused = store.pauseAutomation(automation.id, {
      userId: 'owner',
      commandId: 'pause-command',
      expectedRevision: automation.revision,
    })
    expect(paused).toMatchObject({ status: 'paused', revision: 2 })
    expect(
      store.pauseAutomation(automation.id, {
        userId: 'owner',
        commandId: 'pause-command',
        expectedRevision: automation.revision,
      }),
    ).toEqual(paused)
    expect(paused.nextFireAt).toBeUndefined()
    clock.set('2026-11-21T10:00:00.000Z')
    expect(store.fireDueAutomations()).toEqual([])
    const resumed = store.resumeAutomation(automation.id, {
      userId: 'owner',
      commandId: 'resume-command',
      expectedRevision: paused.revision,
    })
    expect(resumed).toMatchObject({
      status: 'active',
      revision: 3,
      nextFireAt: '2026-11-21T11:00:00.000Z',
    })
    expect(() =>
      store.updateAutomation(automation.id, {
        userId: 'owner',
        commandId: 'stale-update',
        expectedRevision: 1,
        automation: automationDraft(),
      }),
    ).toThrow(AutomationRevisionConflictError)

    clock.set('2026-11-21T15:30:00.000Z')
    const fired = store.fireDueAutomations()
    expect(fired).toHaveLength(1)
    expect(fired[0]?.automation).toMatchObject({
      status: 'active',
      nextFireAt: '2026-11-21T16:00:00.000Z',
    })
    expect(() => store.fireDueAutomations()).not.toThrow()
    expect(store.fireDueAutomations()).toEqual([])
  })

  it('continues an explicitly selected open Task without Router reclassification', async () => {
    const clock = new MutableClock('2026-11-21T02:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: 'Create the open target' },
    }).event
    const target = store.createTaskFromEvent(event, 'Open target')
    const setupEvent = store.claimNextEvent('setup-router')
    if (setupEvent?.id !== event.id) throw new Error('Expected setup Event')
    store.completeEvent(event.id, 'setup-router')
    store.createAutomation({
      userId: 'owner',
      commandId: 'existing-target-command',
      automation: automationDraft({
        prompt: 'Continue the selected work.',
        schedule: { kind: 'once', at: '2026-11-21T02:01:00.000Z' },
        target: { kind: 'existing_task', taskId: target.id },
      }),
    })
    clock.set('2026-11-21T02:02:00.000Z')
    store.fireDueAutomations()
    await processNextEvent(
      store,
      new RoutingEventHandler(
        new RuleBasedTaskRouter(),
        'test-executor',
        () => ({
          executor: 'test-executor',
        }),
      ),
      'automation-router',
    )
    expect(store.listTasks('owner')).toHaveLength(1)
    expect(store.listRuns(target.id)).toMatchObject([
      {
        status: 'queued',
        input: 'Continue the selected work.',
      },
    ])
  })

  it('records terminal Inbox processing failure on the Invocation', () => {
    const clock = new MutableClock('2026-11-21T02:00:00.000Z')
    const store = new PegasStore(':memory:', { clock })
    cleanups.push(() => store.close())
    const automation = store.createAutomation({
      userId: 'owner',
      commandId: 'failure-command',
      automation: automationDraft({
        schedule: { kind: 'once', at: '2026-11-21T02:01:00.000Z' },
      }),
    })
    clock.set('2026-11-21T02:02:00.000Z')
    store.fireDueAutomations()
    const event = store.claimNextEvent('failing-router')
    if (!event) throw new Error('Expected Automation Event')
    store.failEvent(event.id, 'failing-router', 'synthetic failure', 1)
    expect(
      store.listAutomationInvocations(automation.id, 'owner').items[0],
    ).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'synthetic failure',
    })
  })

  it('rolls back Event completion when Invocation settlement fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-schedule-atomic-'))
    const databasePath = join(directory, 'pegas.sqlite')
    const clock = new MutableClock('2026-11-21T02:00:00.000Z')
    const store = new PegasStore(databasePath, { clock })
    const database = new DatabaseSync(databasePath)
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    cleanups.push(
      () => database.close(),
      () => store.close(),
    )
    store.createAutomation({
      userId: 'owner',
      commandId: 'atomic-failure-command',
      automation: automationDraft({
        schedule: { kind: 'once', at: '2026-11-21T02:01:00.000Z' },
      }),
    })
    clock.set('2026-11-21T02:02:00.000Z')
    store.fireDueAutomations()
    const event = store.claimNextEvent('atomic-router')
    if (!event) throw new Error('Expected Automation Event')
    database.exec(`
      CREATE TRIGGER reject_invocation_settlement
      BEFORE UPDATE ON automation_invocations
      BEGIN
        SELECT RAISE(ABORT, 'synthetic Invocation settlement failure');
      END
    `)

    expect(() => store.completeEvent(event.id, 'atomic-router')).toThrow(
      /synthetic Invocation settlement failure/,
    )
    expect(
      database
        .prepare(`SELECT status, processed_at FROM inbox_events WHERE id = ?`)
        .get(event.id),
    ).toEqual({ status: 'processing', processed_at: null })
  })

  it('rejects unavailable existing targets and leaves cancellation permanent', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const userEvent = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: 'Create the target Task' },
    }).event
    const target = store.createTaskFromEvent(userEvent, 'Target Task')
    expect(() =>
      store.createAutomation({
        userId: 'other',
        commandId: 'cross-owner-target',
        automation: automationDraft({
          target: { kind: 'existing_task', taskId: target.id },
        }),
      }),
    ).toThrow(AutomationTargetUnavailableError)
    const automation = store.createAutomation({
      userId: 'owner',
      commandId: 'cancel-command',
      automation: automationDraft({
        target: { kind: 'existing_task', taskId: target.id },
      }),
    })
    const cancelled = store.cancelAutomation(automation.id, {
      userId: 'owner',
      commandId: 'cancel-operation',
      expectedRevision: automation.revision,
    })
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      revision: 2,
    })
    expect(() =>
      store.updateAutomation(automation.id, {
        userId: 'owner',
        commandId: 'edit-cancelled',
        expectedRevision: cancelled.revision,
        automation: automationDraft(),
      }),
    ).toThrow(AutomationReadOnlyError)
  })

  it('exposes owner-scoped APIs and reserves automation ingress', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => store.close(),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const create = await fetch(`${base}/v1/automations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...parseAutomationCreate({
          userId: 'owner',
          commandId: 'http-create',
          automation: automationDraft(),
        }),
      }),
    })
    expect(create.status).toBe(201)
    const created = (await create.json()) as {
      automation: { id: string; revision: number }
    }
    expect(
      await (await fetch(`${base}/v1/automations?userId=other`)).json(),
    ).toEqual({ automations: [] })
    expect(
      await (
        await fetch(
          `${base}/v1/automations/${created.automation.id}?userId=other`,
        )
      ).json(),
    ).toEqual({ error: 'not_found' })
    const pause = await fetch(
      `${base}/v1/automations/${created.automation.id}/pause`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'owner',
          commandId: 'http-pause',
          expectedRevision: created.automation.revision,
        }),
      },
    )
    expect(pause.status).toBe(200)
    const spoofed = await fetch(`${base}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'owner',
        type: 'automation.due',
        source: 'automation',
        payload: {},
      }),
    })
    expect(spoofed.status).toBe(400)
    expect(store.listEvents('owner')).toEqual([])
  })
})

function automationDraft(
  overrides: Partial<AutomationDraft> = {},
): AutomationDraft {
  return {
    title: 'Daily review',
    prompt: 'Review the active work.',
    schedule: {
      kind: 'once',
      at: '2030-01-01T00:00:00.000Z',
    },
    target: { kind: 'new_task' },
    ...overrides,
  }
}

class MutableClock implements Clock {
  #milliseconds: number

  constructor(value: string) {
    this.#milliseconds = Date.parse(value)
  }

  now(): Date {
    return new Date(this.#milliseconds)
  }

  set(value: string): void {
    this.#milliseconds = Date.parse(value)
  }
}
