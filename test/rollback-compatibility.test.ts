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

describe('collaboration rollback compatibility', () => {
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
