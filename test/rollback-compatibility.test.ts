import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ClaimedRun } from '../src/core/domain.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  assertRollbackCompatible,
  RollbackCompatibilityError,
} from '../src/supervisor/rollback-compatibility.js'

describe('durable state rollback compatibility', () => {
  it('blocks a v17 rollback while collaboration is live and allows it after settlement', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-rollback-'))
    const path = join(directory, 'pegas.sqlite')
    const store = new PegasStore(path)
    try {
      const source = createClaimedTask(store, 'owner', 'Source', 'source')
      const target = createClaimedTask(store, 'owner', 'Target', 'target')
      store.createCollaboration(source.run.id, source.claimToken, {
        commandId: 'rollback-live-note',
        kind: 'context_note',
        targetChannelId: target.task.id,
        text: 'Pending context',
        sourceRefs: [],
      })
      expect(() => assertRollbackCompatible(path, 17)).toThrow(
        RollbackCompatibilityError,
      )
      expect(() => assertRollbackCompatible(path, 19)).not.toThrow()

      store.stopTask(target.task.id, 'owner', 'settle-target')
      expect(() => assertRollbackCompatible(path, 17)).not.toThrow()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('blocks a v19 rollback while an Automation is active and allows it after cancellation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-rollback-'))
    const path = join(directory, 'pegas.sqlite')
    const store = new PegasStore(path)
    try {
      const automation = store.createAutomation({
        userId: 'owner',
        commandId: 'rollback-automation',
        automation: {
          title: 'Future task',
          prompt: 'Run later',
          schedule: { kind: 'once', at: '2030-01-01T00:00:00.000Z' },
          target: { kind: 'new_task' },
        },
      })
      expect(() => assertRollbackCompatible(path, 19)).toThrow(
        RollbackCompatibilityError,
      )
      store.cancelAutomation(automation.id, {
        userId: 'owner',
        commandId: 'cancel-for-rollback',
        expectedRevision: automation.revision,
      })
      expect(() => assertRollbackCompatible(path, 19)).not.toThrow()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('blocks a v20 rollback while Memory exists and allows it after deletion', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-rollback-'))
    const path = join(directory, 'pegas.sqlite')
    const store = new PegasStore(path)
    try {
      const memory = store.createMemory({
        userId: 'owner',
        commandId: 'rollback-memory',
        memory: {
          scope: 'global',
          category: 'preference',
          content: '默认使用中文回复',
          source: { kind: 'user_confirmation' },
        },
      })
      expect(() => assertRollbackCompatible(path, 20)).toThrow(
        RollbackCompatibilityError,
      )
      expect(() => assertRollbackCompatible(path, 21)).not.toThrow()
      store.deleteMemory(memory.id, {
        userId: 'owner',
        commandId: 'delete-for-rollback',
        expectedRevision: memory.revision,
      })
      expect(() => assertRollbackCompatible(path, 20)).not.toThrow()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function createClaimedTask(
  store: PegasStore,
  userId: string,
  text: string,
  workerId: string,
): ClaimedRun {
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'web',
    payload: { text },
  }).event
  const claimedEvent = store.claimNextEvent(`${workerId}-router`)
  if (claimedEvent?.id !== event.id) throw new Error('Expected Event claim')
  store.applyRoutingDecision(
    claimedEvent,
    {
      kind: 'create_task',
      title: text,
      goal: text,
      input: text,
      reason: 'test setup',
    },
    'echo',
  )
  store.completeEvent(event.id, `${workerId}-router`)
  const claimed = store.claimNextRun(workerId)
  if (!claimed) throw new Error('Expected Run claim')
  return claimed
}
