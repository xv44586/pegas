import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { systemClock, type Clock } from '../core/clock.js'
import type {
  ClaimedRun,
  InboxEvent,
  NewInboxEvent,
  OutboxMessage,
  RoutingDecision,
  Run,
  Task,
} from '../core/domain.js'

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  dedupe_key TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  last_error TEXT,
  UNIQUE (user_id, source, dedupe_key)
);

CREATE INDEX IF NOT EXISTS inbox_events_claim
ON inbox_events (status, lease_until, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  origin_event_id TEXT NOT NULL UNIQUE REFERENCES inbox_events(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  status_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_by_user
ON tasks (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  executor TEXT NOT NULL,
  executor_ref TEXT,
  status TEXT NOT NULL,
  recovery_point_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT REFERENCES runs(id),
  kind TEXT NOT NULL,
  risk TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  action_id TEXT NOT NULL UNIQUE REFERENCES actions(id),
  status TEXT NOT NULL,
  prompt_json TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  next_fire_at TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id),
  channel TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
  created_at TEXT NOT NULL,
  sent_at TEXT
);
`

const schemaInitializationAttempts = 3
const schemaRetryDelayMs = 100

const migration2 = `
ALTER TABLE tasks ADD COLUMN goal TEXT NOT NULL DEFAULT '';

ALTER TABLE runs ADD COLUMN origin_event_id TEXT REFERENCES inbox_events(id);
ALTER TABLE runs ADD COLUMN resume_from_ref TEXT;
ALTER TABLE runs ADD COLUMN input_json TEXT NOT NULL DEFAULT '""';
ALTER TABLE runs ADD COLUMN output_json TEXT;
ALTER TABLE runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN claimed_by TEXT;
ALTER TABLE runs ADD COLUMN lease_until TEXT;
ALTER TABLE runs ADD COLUMN last_error TEXT;

CREATE UNIQUE INDEX runs_by_origin_event ON runs (origin_event_id);
CREATE INDEX runs_claim ON runs (status, lease_until, created_at);

CREATE TABLE task_events (
  event_id TEXT PRIMARY KEY REFERENCES inbox_events(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX task_events_by_task ON task_events (task_id, created_at);

CREATE TABLE routing_decisions (
  event_id TEXT PRIMARY KEY REFERENCES inbox_events(id),
  kind TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

const migration3 = `
ALTER TABLE outbox_messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox_messages ADD COLUMN claimed_by TEXT;
ALTER TABLE outbox_messages ADD COLUMN lease_until TEXT;
ALTER TABLE outbox_messages ADD COLUMN next_attempt_at TEXT;
ALTER TABLE outbox_messages ADD COLUMN last_error TEXT;
ALTER TABLE outbox_messages ADD COLUMN updated_at TEXT;

UPDATE outbox_messages SET updated_at = created_at WHERE updated_at IS NULL;

CREATE INDEX outbox_messages_claim
ON outbox_messages (status, next_attempt_at, lease_until, created_at);
`

interface InboxRow {
  id: string
  user_id: string
  type: string
  source: string
  dedupe_key: string | null
  payload_json: string
  status: InboxEvent['status']
  attempts: number
  claimed_by: string | null
  lease_until: string | null
  created_at: string
  processed_at: string | null
  last_error: string | null
}

interface TaskRow {
  id: string
  user_id: string
  origin_event_id: string
  title: string
  goal: string
  status: Task['status']
  status_reason: string | null
  created_at: string
  updated_at: string
}

interface RunRow {
  id: string
  task_id: string
  executor: string
  executor_ref: string | null
  resume_from_ref: string | null
  status: Run['status']
  input_json: string
  output_json: string | null
  attempts: number
  claimed_by: string | null
  lease_until: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

interface OutboxRow {
  id: string
  user_id: string
  task_id: string | null
  channel: string
  dedupe_key: string
  payload_json: string
  status: OutboxMessage['status']
  attempts: number
  claimed_by: string | null
  lease_until: string | null
  next_attempt_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string | null
  sent_at: string | null
}

export class PegasStore {
  readonly #database: DatabaseSync
  readonly #clock: Clock

  constructor(path: string, options: { clock?: Clock } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#clock = options.clock ?? systemClock
    this.#database = new DatabaseSync(path)
    // Apply the lock wait before any WAL/schema statement so multiple Pegas
    // processes can safely perform a cold start against the same database.
    this.#database.exec('PRAGMA busy_timeout = 5000;')
    initializeSchema(this.#database)
    this.#database
      .prepare(
        'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)',
      )
      .run(this.#clock.now().toISOString())
    this.#migrate(2, migration2)
    this.#migrate(3, migration3)
  }

  #migrate(version: number, sql: string): void {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const applied = this.#database
        .prepare('SELECT 1 AS applied FROM schema_migrations WHERE version = ?')
        .get(version)
      if (applied) {
        this.#database.exec('COMMIT')
        return
      }
      this.#database.exec(sql)
      this.#database
        .prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(version, this.#clock.now().toISOString())
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.#database.close()
  }

  ready(): boolean {
    const row = this.#database.prepare('SELECT 1 AS ok').get() as
      { ok: number } | undefined
    return row?.ok === 1
  }

  enqueueEvent(input: NewInboxEvent): { event: InboxEvent; inserted: boolean } {
    const id = input.id ?? randomUUID()
    const createdAt = this.#clock.now().toISOString()
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO inbox_events
          (id, user_id, type, source, dedupe_key, payload_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        input.userId,
        input.type,
        input.source,
        input.dedupeKey ?? null,
        JSON.stringify(input.payload),
        createdAt,
      )

    const row = input.dedupeKey
      ? this.#database
          .prepare(
            `SELECT * FROM inbox_events
             WHERE user_id = ? AND source = ? AND dedupe_key = ?`,
          )
          .get(input.userId, input.source, input.dedupeKey)
      : this.#database
          .prepare('SELECT * FROM inbox_events WHERE id = ?')
          .get(id)

    if (!row) throw new Error('Failed to read the enqueued event')
    return {
      event: toInboxEvent(row as unknown as InboxRow),
      inserted: result.changes === 1,
    }
  }

  claimNextEvent(workerId: string, leaseMs = 30_000): InboxEvent | undefined {
    const now = this.#clock.now()
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString()
    this.#database.exec('BEGIN IMMEDIATE')

    try {
      const row = this.#database
        .prepare(
          `SELECT * FROM inbox_events
           WHERE status = 'pending'
              OR (status = 'processing' AND lease_until <= ?)
           ORDER BY created_at ASC
           LIMIT 1`,
        )
        .get(now.toISOString()) as unknown as InboxRow | undefined

      if (!row) {
        this.#database.exec('COMMIT')
        return undefined
      }

      this.#database
        .prepare(
          `UPDATE inbox_events
           SET status = 'processing', claimed_by = ?, lease_until = ?, attempts = attempts + 1
           WHERE id = ?`,
        )
        .run(workerId, leaseUntil, row.id)
      this.#database.exec('COMMIT')

      return {
        ...toInboxEvent(row),
        status: 'processing',
        attempts: row.attempts + 1,
        claimedBy: workerId,
        leaseUntil,
      }
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  completeEvent(eventId: string, workerId: string): void {
    const result = this.#database
      .prepare(
        `UPDATE inbox_events
         SET status = 'processed', processed_at = ?, lease_until = NULL, last_error = NULL
         WHERE id = ? AND status = 'processing' AND claimed_by = ?`,
      )
      .run(this.#clock.now().toISOString(), eventId, workerId)
    if (result.changes !== 1)
      throw new Error(`Worker ${workerId} does not own event ${eventId}`)
  }

  failEvent(
    eventId: string,
    workerId: string,
    error: string,
    maxAttempts = 5,
  ): void {
    const row = this.#database
      .prepare(
        'SELECT attempts FROM inbox_events WHERE id = ? AND claimed_by = ?',
      )
      .get(eventId, workerId) as { attempts: number } | undefined
    if (!row)
      throw new Error(`Worker ${workerId} does not own event ${eventId}`)
    const nextStatus = row.attempts >= maxAttempts ? 'failed' : 'pending'
    this.#database
      .prepare(
        `UPDATE inbox_events
         SET status = ?, claimed_by = NULL, lease_until = NULL, last_error = ?
         WHERE id = ? AND claimed_by = ?`,
      )
      .run(nextStatus, error, eventId, workerId)
  }

  createTaskFromEvent(event: InboxEvent, title: string): Task {
    const now = this.#clock.now().toISOString()
    const id = randomUUID()
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO tasks
          (id, user_id, origin_event_id, title, goal, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'inbox', ?, ?)`,
      )
      .run(id, event.userId, event.id, title, title, now, now)
    const row = this.#database
      .prepare('SELECT * FROM tasks WHERE origin_event_id = ?')
      .get(event.id)
    if (!row) throw new Error(`Failed to create task for event ${event.id}`)
    return toTask(row as unknown as TaskRow)
  }

  applyRoutingDecision(
    event: InboxEvent,
    decision: RoutingDecision,
    executor: string,
  ): { task: Task; run: Run } {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const existingRun = this.#database
        .prepare('SELECT * FROM runs WHERE origin_event_id = ?')
        .get(event.id) as unknown as RunRow | undefined
      if (existingRun) {
        const existingTask = this.#taskById(existingRun.task_id)
        this.#database.exec('COMMIT')
        return { task: existingTask, run: toRun(existingRun) }
      }

      const now = this.#clock.now().toISOString()
      let task: Task
      if (decision.kind === 'create_task') {
        const taskId = randomUUID()
        this.#database
          .prepare(
            `INSERT INTO tasks
              (id, user_id, origin_event_id, title, goal, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'planning', ?, ?)`,
          )
          .run(
            taskId,
            event.userId,
            event.id,
            decision.title,
            decision.goal,
            now,
            now,
          )
        task = this.#taskById(taskId)
      } else {
        task = this.#taskById(decision.taskId)
        if (task.userId !== event.userId)
          throw new Error('Task belongs to another user')
      }

      this.#database
        .prepare(
          `INSERT INTO task_events (event_id, task_id, relation, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          event.id,
          task.id,
          decision.kind === 'create_task' ? 'origin' : 'continuation',
          now,
        )
      this.#database
        .prepare(
          `INSERT INTO routing_decisions (event_id, kind, task_id, reason, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(event.id, decision.kind, task.id, decision.reason, now)

      const previous = this.#database
        .prepare(
          `SELECT executor_ref FROM runs
           WHERE task_id = ? AND executor_ref IS NOT NULL
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(task.id) as { executor_ref: string } | undefined
      const runId = randomUUID()
      this.#database
        .prepare(
          `INSERT INTO runs
            (id, task_id, origin_event_id, executor, resume_from_ref, status,
             input_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(
          runId,
          task.id,
          event.id,
          executor,
          previous?.executor_ref ?? null,
          JSON.stringify(decision.input),
          now,
          now,
        )
      this.#database
        .prepare(
          `UPDATE tasks SET status = 'planning', status_reason = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, task.id)

      const run = this.#runById(runId)
      task = this.#taskById(task.id)
      this.#database.exec('COMMIT')
      return { task, run }
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  listRuns(taskId?: string): Run[] {
    const rows = taskId
      ? this.#database
          .prepare(
            'SELECT * FROM runs WHERE task_id = ? ORDER BY created_at ASC',
          )
          .all(taskId)
      : this.#database
          .prepare('SELECT * FROM runs ORDER BY created_at ASC')
          .all()
    return rows.map(row => toRun(row as unknown as RunRow))
  }

  listEvents(userId: string): InboxEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM inbox_events
         WHERE user_id = ? ORDER BY created_at ASC`,
      )
      .all(userId)
    return rows.map(row => toInboxEvent(row as unknown as InboxRow))
  }

  listTasks(userId?: string): Task[] {
    const rows = userId
      ? this.#database
          .prepare(
            'SELECT * FROM tasks WHERE user_id = ? ORDER BY updated_at DESC',
          )
          .all(userId)
      : this.#database
          .prepare('SELECT * FROM tasks ORDER BY updated_at DESC')
          .all()
    return rows.map(row => toTask(row as unknown as TaskRow))
  }

  claimNextRun(workerId: string, leaseMs = 30_000): ClaimedRun | undefined {
    const now = this.#clock.now()
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#database
        .prepare(
          `SELECT * FROM runs
           WHERE status = 'queued'
              OR (status = 'running' AND lease_until <= ?)
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(now.toISOString()) as unknown as RunRow | undefined
      if (!row) {
        this.#database.exec('COMMIT')
        return undefined
      }

      this.#database
        .prepare(
          `UPDATE runs
           SET status = 'running', claimed_by = ?, lease_until = ?,
               attempts = attempts + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(workerId, leaseUntil, now.toISOString(), row.id)
      this.#database
        .prepare(
          `UPDATE tasks SET status = 'running', status_reason = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(now.toISOString(), row.task_id)
      const run = this.#runById(row.id)
      const task = this.#taskById(row.task_id)
      this.#database.exec('COMMIT')
      return { run, task }
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  renewRunLease(runId: string, workerId: string, leaseMs = 30_000): void {
    const now = this.#clock.now()
    const result = this.#database
      .prepare(
        `UPDATE runs SET lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND claimed_by = ?`,
      )
      .run(
        new Date(now.getTime() + leaseMs).toISOString(),
        now.toISOString(),
        runId,
        workerId,
      )
    if (result.changes !== 1)
      throw new Error(`Worker ${workerId} does not own run ${runId}`)
  }

  recordExecutorRef(
    runId: string,
    workerId: string,
    executorRef: string,
  ): void {
    const result = this.#database
      .prepare(
        `UPDATE runs SET executor_ref = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND claimed_by = ?`,
      )
      .run(executorRef, this.#clock.now().toISOString(), runId, workerId)
    if (result.changes !== 1)
      throw new Error(`Worker ${workerId} does not own run ${runId}`)
  }

  completeRun(
    runId: string,
    workerId: string,
    result: { executorRef: string; output: string },
  ): void {
    const now = this.#clock.now().toISOString()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const run = this.#runById(runId)
      if (run.claimedBy !== workerId || run.status !== 'running') {
        throw new Error(`Worker ${workerId} does not own run ${runId}`)
      }
      const task = this.#taskById(run.taskId)
      this.#database
        .prepare(
          `UPDATE runs
           SET status = 'completed', executor_ref = ?, output_json = ?,
               claimed_by = NULL, lease_until = NULL, last_error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(result.executorRef, JSON.stringify(result.output), now, runId)
      this.#database
        .prepare(
          `UPDATE tasks
           SET status = 'waiting', status_reason = 'awaiting_user_review', updated_at = ?
           WHERE id = ?`,
        )
        .run(now, task.id)
      this.enqueueOutbox({
        userId: task.userId,
        taskId: task.id,
        channel: 'conversation',
        dedupeKey: `run-completed:${runId}`,
        payload: {
          type: 'run.completed',
          taskId: task.id,
          runId,
          text: result.output,
        },
      })
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  failRun(runId: string, workerId: string, error: string): void {
    const now = this.#clock.now().toISOString()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const run = this.#runById(runId)
      if (run.claimedBy !== workerId || run.status !== 'running') {
        throw new Error(`Worker ${workerId} does not own run ${runId}`)
      }
      const task = this.#taskById(run.taskId)
      this.#database
        .prepare(
          `UPDATE runs
           SET status = 'failed', claimed_by = NULL, lease_until = NULL,
               last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(error, now, runId)
      this.#database
        .prepare(
          `UPDATE tasks SET status = 'failed', status_reason = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(error, now, task.id)
      this.enqueueOutbox({
        userId: task.userId,
        taskId: task.id,
        channel: 'conversation',
        dedupeKey: `run-failed:${runId}`,
        payload: { type: 'run.failed', taskId: task.id, runId, error },
      })
      this.#database.exec('COMMIT')
    } catch (caught) {
      this.#database.exec('ROLLBACK')
      throw caught
    }
  }

  enqueueOutbox(input: {
    userId: string
    taskId?: string
    channel: string
    dedupeKey: string
    payload: unknown
  }): OutboxMessage {
    const id = randomUUID()
    const createdAt = this.#clock.now().toISOString()
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO outbox_messages
          (id, user_id, task_id, channel, dedupe_key, payload_json, status,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.taskId ?? null,
        input.channel,
        input.dedupeKey,
        JSON.stringify(input.payload),
        createdAt,
        createdAt,
      )
    const row = this.#database
      .prepare('SELECT * FROM outbox_messages WHERE dedupe_key = ?')
      .get(input.dedupeKey)
    if (!row)
      throw new Error(`Failed to enqueue outbox message ${input.dedupeKey}`)
    return toOutboxMessage(row as unknown as OutboxRow)
  }

  listOutbox(userId: string): OutboxMessage[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM outbox_messages
         WHERE user_id = ? ORDER BY created_at ASC`,
      )
      .all(userId)
    return rows.map(row => toOutboxMessage(row as unknown as OutboxRow))
  }

  claimNextOutbox(
    dispatcherId: string,
    leaseMs = 30_000,
  ): OutboxMessage | undefined {
    const now = this.#clock.now()
    const nowIso = now.toISOString()
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#database
        .prepare(
          `SELECT * FROM outbox_messages
           WHERE (status = 'pending' AND
                    (next_attempt_at IS NULL OR next_attempt_at <= ?))
              OR (status = 'sending' AND lease_until <= ?)
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(nowIso, nowIso) as unknown as OutboxRow | undefined
      if (!row) {
        this.#database.exec('COMMIT')
        return undefined
      }

      this.#database
        .prepare(
          `UPDATE outbox_messages
           SET status = 'sending', claimed_by = ?, lease_until = ?,
               attempts = attempts + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(dispatcherId, leaseUntil, nowIso, row.id)
      const claimed = this.#outboxById(row.id)
      this.#database.exec('COMMIT')
      return claimed
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  markOutboxSent(messageId: string, dispatcherId: string): void {
    const now = this.#clock.now().toISOString()
    const result = this.#database
      .prepare(
        `UPDATE outbox_messages
         SET status = 'sent', claimed_by = NULL, lease_until = NULL,
             next_attempt_at = NULL, last_error = NULL, sent_at = ?, updated_at = ?
         WHERE id = ? AND status = 'sending' AND claimed_by = ?`,
      )
      .run(now, now, messageId, dispatcherId)
    if (result.changes !== 1)
      throw new Error(
        `Dispatcher ${dispatcherId} does not own message ${messageId}`,
      )
  }

  failOutbox(
    messageId: string,
    dispatcherId: string,
    error: string,
    retryAt: Date,
    maxAttempts = 5,
  ): void {
    const row = this.#database
      .prepare(
        `SELECT attempts FROM outbox_messages
         WHERE id = ? AND status = 'sending' AND claimed_by = ?`,
      )
      .get(messageId, dispatcherId) as { attempts: number } | undefined
    if (!row)
      throw new Error(
        `Dispatcher ${dispatcherId} does not own message ${messageId}`,
      )
    const exhausted = row.attempts >= maxAttempts
    const now = this.#clock.now().toISOString()
    const result = this.#database
      .prepare(
        `UPDATE outbox_messages
         SET status = ?, claimed_by = NULL, lease_until = NULL,
             next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND claimed_by = ?`,
      )
      .run(
        exhausted ? 'failed' : 'pending',
        exhausted ? null : retryAt.toISOString(),
        error,
        now,
        messageId,
        dispatcherId,
      )
    if (result.changes !== 1)
      throw new Error(
        `Dispatcher ${dispatcherId} lost ownership of message ${messageId}`,
      )
  }

  #taskById(taskId: string): Task {
    const row = this.#database
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(taskId)
    if (!row) throw new Error(`Task ${taskId} does not exist`)
    return toTask(row as unknown as TaskRow)
  }

  #runById(runId: string): Run {
    const row = this.#database
      .prepare('SELECT * FROM runs WHERE id = ?')
      .get(runId)
    if (!row) throw new Error(`Run ${runId} does not exist`)
    return toRun(row as unknown as RunRow)
  }

  #outboxById(messageId: string): OutboxMessage {
    const row = this.#database
      .prepare('SELECT * FROM outbox_messages WHERE id = ?')
      .get(messageId)
    if (!row) throw new Error(`Outbox message ${messageId} does not exist`)
    return toOutboxMessage(row as unknown as OutboxRow)
  }
}

function initializeSchema(database: DatabaseSync): void {
  for (let attempt = 1; attempt <= schemaInitializationAttempts; attempt += 1) {
    try {
      database.exec(schema)
      return
    } catch (error) {
      if (!isSqliteBusy(error) || attempt === schemaInitializationAttempts)
        throw error
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        schemaRetryDelayMs * attempt,
      )
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ERR_SQLITE_ERROR' &&
    'errcode' in error &&
    error.errcode === 5
  )
}

function toInboxEvent(row: InboxRow): InboxEvent {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    source: row.source,
    ...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
    payload: JSON.parse(row.payload_json) as unknown,
    status: row.status,
    attempts: row.attempts,
    ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
    ...(row.lease_until ? { leaseUntil: row.lease_until } : {}),
    createdAt: row.created_at,
    ...(row.processed_at ? { processedAt: row.processed_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  }
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    userId: row.user_id,
    originEventId: row.origin_event_id,
    title: row.title,
    goal: row.goal || row.title,
    status: row.status,
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    executor: row.executor,
    ...(row.executor_ref ? { executorRef: row.executor_ref } : {}),
    ...(row.resume_from_ref ? { resumeFromRef: row.resume_from_ref } : {}),
    status: row.status,
    input: JSON.parse(row.input_json) as string,
    ...(row.output_json
      ? { output: JSON.parse(row.output_json) as string }
      : {}),
    attempts: row.attempts,
    ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
    ...(row.lease_until ? { leaseUntil: row.lease_until } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toOutboxMessage(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    channel: row.channel,
    dedupeKey: row.dedupe_key,
    payload: JSON.parse(row.payload_json) as unknown,
    status: row.status,
    attempts: row.attempts,
    ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
    ...(row.lease_until ? { leaseUntil: row.lease_until } : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    ...(row.sent_at ? { sentAt: row.sent_at } : {}),
  }
}
