import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import type { ClaimedRun } from '../src/core/domain.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

describe('collaboration database integrity', () => {
  it('binds descendants to their actual parent lineage and event kind', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-collab-integrity-'))
    const path = join(directory, 'pegas.sqlite')
    const store = new PegasStore(path)
    try {
      const root = createClaimedTask(store, 'root')
      const other = createClaimedTask(store, 'other-root')
      const noteSource = createClaimedTask(store, 'note-source')
      const noteTarget = createClaimedTask(store, 'note-target')
      const settledSource = createClaimedTask(store, 'settled-source')
      const settledRelation = store.createCollaboration(
        settledSource.run.id,
        settledSource.claimToken,
        delegateRequest('settled-relation', 'Settled child'),
      )
      await processNextEvent(
        store,
        new RoutingEventHandler(new RuleBasedTaskRouter(), 'test-executor'),
        'settled-router',
      )
      const settledTarget = store.claimNextRun('settled-worker')
      if (
        !settledTarget ||
        settledTarget.task.id !== settledRelation.targetTaskId
      ) {
        throw new Error('Expected settled target Run')
      }
      store.completeRun(settledTarget.run.id, 'settled-worker', {
        executorRef: 'settled-session',
        output: 'Settled result',
      })
      const settledReturnEventId = store
        .listCollaborations(settledSource.task.id, 'owner')
        .find(relation => relation.id === settledRelation.id)?.returnEventId
      if (!settledReturnEventId)
        throw new Error('Expected settled return Event')
      await processNextEvent(
        store,
        new RoutingEventHandler(new RuleBasedTaskRouter(), 'test-executor'),
        'settled-return-router',
      )
      const settledContinuation = store.claimNextRun(
        'settled-continuation-worker',
      )
      if (settledContinuation?.task.id !== settledSource.task.id) {
        throw new Error('Expected settled source continuation')
      }
      const rootRelation = store.createCollaboration(
        root.run.id,
        root.claimToken,
        delegateRequest('root-relation', 'Root child'),
      )
      await processNextEvent(
        store,
        new RoutingEventHandler(new RuleBasedTaskRouter(), 'test-executor'),
        'root-router',
      )
      const child = store.claimNextRun('child-worker')
      if (!child || child.task.id !== rootRelation.targetTaskId) {
        throw new Error('Expected child Run')
      }
      const childRelation = store.createCollaboration(
        child.run.id,
        child.claimToken,
        delegateRequest('child-relation', 'Grandchild'),
      )

      const otherRootRelation = store.createCollaboration(
        other.run.id,
        other.claimToken,
        delegateRequest('other-root-relation', 'Other child'),
      )
      const note = store.createCollaboration(
        noteSource.run.id,
        noteSource.claimToken,
        {
          commandId: 'integrity-note',
          kind: 'context_note',
          targetChannelId: noteTarget.task.id,
          text: 'A scoped note',
          sourceRefs: [],
        },
      )
      const noteTargetEventId = note.targetEventId
      if (!noteTargetEventId) throw new Error('Expected note target Event')
      store.close()

      const database = new DatabaseSync(path)
      database.exec('PRAGMA foreign_keys = ON')
      try {
        expect(() =>
          database
            .prepare(
              `UPDATE channel_relations
               SET parent_relation_id = NULL, root_relation_id = id, depth = 0
               WHERE id = ?`,
            )
            .run(childRelation.id),
        ).toThrow(/immutable collaboration provenance/)
        expect(() =>
          database
            .prepare(
              `UPDATE channel_relations
               SET parent_relation_id = ?, root_relation_id = ?, depth = 1
               WHERE id = ?`,
            )
            .run(otherRootRelation.id, otherRootRelation.id, childRelation.id),
        ).toThrow(/immutable collaboration provenance/)

        expect(() =>
          database
            .prepare(
              'UPDATE channel_relations SET target_event_id = NULL WHERE id = ?',
            )
            .run(note.id),
        ).toThrow(/immutable collaboration provenance/)
        expect(() =>
          database
            .prepare(
              'UPDATE channel_relations SET target_event_id = ? WHERE id = ?',
            )
            .run(noteTargetEventId, rootRelation.id),
        ).toThrow(/immutable collaboration provenance/)
        expect(() =>
          database
            .prepare(
              'UPDATE channel_relations SET target_task_id = ? WHERE id = ?',
            )
            .run(noteTarget.task.id, rootRelation.id),
        ).toThrow(/immutable collaboration endpoint/)
        expect(() =>
          database
            .prepare(
              'UPDATE channel_relations SET return_event_id = target_event_id WHERE id = ?',
            )
            .run(settledRelation.id),
        ).toThrow(/immutable collaboration endpoint/)
        expect(() =>
          database
            .prepare(
              "UPDATE channel_relations SET kind = 'delegate' WHERE id = ?",
            )
            .run(note.id),
        ).toThrow(/immutable collaboration provenance/)
        expect(() =>
          database
            .prepare("UPDATE inbox_events SET payload_json = '{}' WHERE id = ?")
            .run(noteTargetEventId),
        ).toThrow(/immutable collaboration event/)
        expect(() =>
          database
            .prepare(
              'UPDATE inbox_events SET required_contract_version = 1 WHERE id = ?',
            )
            .run(noteTargetEventId),
        ).toThrow(/immutable collaboration event/)
        expect(() =>
          database
            .prepare('UPDATE task_events SET task_id = ? WHERE event_id = ?')
            .run(root.task.id, noteTargetEventId),
        ).toThrow(/immutable collaboration task event/)
        expect(() =>
          database
            .prepare('DELETE FROM task_events WHERE event_id = ?')
            .run(noteTargetEventId),
        ).toThrow(/immutable collaboration task event/)
        expect(() =>
          database
            .prepare(
              'UPDATE channel_relations SET source_run_id = ? WHERE id = ?',
            )
            .run(root.run.id, note.id),
        ).toThrow(/immutable collaboration provenance/)
        expect(() =>
          database
            .prepare(
              `UPDATE channel_relations SET creation_response_json = '{}'
               WHERE id = ?`,
            )
            .run(note.id),
        ).toThrow(/immutable collaboration provenance/)
        const sourcePagePlan = database
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT * FROM channel_relations
             WHERE user_id = ? AND source_task_id = ?
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all('owner', root.task.id, 3) as { detail: string }[]
        expect(sourcePagePlan.map(step => step.detail).join('\n')).toContain(
          'channel_relations_by_source_page',
        )
        const actionPlan = database
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT status FROM actions
             WHERE resume_run_id = ? AND protocol_version = 1
               AND status IN ('authorized','failed','unknown')
             ORDER BY updated_at DESC LIMIT 1`,
          )
          .all(root.run.id) as { detail: string }[]
        expect(actionPlan.map(step => step.detail).join('\n')).toContain(
          'actions_by_resume_run_status',
        )
      } finally {
        database.close()
      }
    } finally {
      try {
        store.close()
      } catch {
        // The store was closed before direct database tampering.
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not resume a source when a non-responsibility failure event is reclaimed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-collab-semantics-'))
    const path = join(directory, 'pegas.sqlite')
    let store: PegasStore | undefined = new PegasStore(path)
    try {
      const source = createClaimedTask(store, 'semantic-source')
      const target = createClaimedTask(store, 'semantic-target')
      const relation = store.createCollaboration(
        source.run.id,
        source.claimToken,
        {
          commandId: 'semantic-context-note',
          kind: 'context_note',
          targetChannelId: target.task.id,
          text: 'A scoped note',
          sourceRefs: [],
        },
      )
      store.stopTask(target.task.id, 'owner', 'stop-semantic-target')
      const failed = store
        .listCollaborations(source.task.id, 'owner')
        .find(item => item.id === relation.id)
      const returnEventId = failed?.returnEventId
      if (!returnEventId) throw new Error('Expected failure return Event')
      const runCount = store.listRuns(source.task.id).length
      store.close()
      store = undefined

      const database = new DatabaseSync(path)
      database
        .prepare(
          `UPDATE inbox_events SET status = 'pending', processed_at = NULL,
             claimed_by = NULL, lease_until = NULL, last_error = NULL
           WHERE id = ?`,
        )
        .run(returnEventId)
      database.close()

      store = new PegasStore(path)
      await processNextEvent(
        store,
        new RoutingEventHandler(new RuleBasedTaskRouter(), 'test-executor'),
        'semantic-router',
      )
      expect(store.listRuns(source.task.id)).toHaveLength(runCount)
      expect(
        store.listEvents('owner').find(event => event.id === returnEventId),
      ).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastError:
          'Non-responsibility collaboration failure cannot resume a Task',
      })
    } finally {
      store?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function createClaimedTask(store: PegasStore, id: string): ClaimedRun {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: id },
  }).event
  const routerId = `${id}-router`
  const claimedEvent = store.claimNextEvent(routerId)
  if (claimedEvent?.id !== event.id) throw new Error('Expected Event claim')
  store.applyRoutingDecision(
    claimedEvent,
    {
      kind: 'create_task',
      title: id,
      goal: id,
      input: id,
      reason: 'test setup',
    },
    'test-executor',
  )
  store.completeEvent(event.id, routerId)
  const claimed = store.claimNextRun(`${id}-worker`)
  if (!claimed) throw new Error('Expected Run claim')
  return claimed
}

function delegateRequest(commandId: string, goal: string) {
  return {
    commandId,
    kind: 'delegate' as const,
    goal,
    reason: 'integrity test',
    expectedOutput: 'result',
    contextRefs: [],
  }
}
