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
import type {
  ModelProviderConnection,
  ModelProviderConnectionSummary,
  RuntimeSettings,
  RuntimeSettingsSelection,
} from '../settings/runtime-settings.js'
import {
  modelProviderPreset,
  type ModelProviderId,
  type ModelProviderProtocol,
} from '../model/provider-catalog.js'

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

const migration4 = `
CREATE TABLE runtime_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision > 0),
  router_mode TEXT NOT NULL CHECK (router_mode IN ('model', 'rules')),
  model_provider TEXT NOT NULL CHECK (model_provider IN ('codex-cli', 'openai-compatible')),
  model_name TEXT NOT NULL,
  privacy_mode TEXT NOT NULL CHECK (privacy_mode IN ('disabled', 'mask')),
  rewrite_mode TEXT NOT NULL CHECK (rewrite_mode IN ('disabled', 'light')),
  updated_at TEXT NOT NULL
);
`

const migration5 = `
ALTER TABLE runtime_settings ADD COLUMN model_connection_id TEXT;

UPDATE runtime_settings
SET model_connection_id = CASE
  WHEN model_provider = 'openai-compatible' THEN 'custom'
  ELSE 'openai'
END;

UPDATE runtime_settings
SET router_mode = 'rules', model_provider = 'openai-compatible'
WHERE model_provider = 'codex-cli';

CREATE TABLE model_provider_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('openai-chat', 'anthropic-messages')),
  base_url TEXT NOT NULL,
  api_key_ciphertext TEXT,
  updated_at TEXT NOT NULL
);
`

const migration6 = `
ALTER TABLE runtime_settings ADD COLUMN agent_model_mode TEXT NOT NULL DEFAULT 'profile'
  CHECK (agent_model_mode IN ('profile', 'override'));
ALTER TABLE runtime_settings ADD COLUMN agent_model_provider TEXT NOT NULL DEFAULT '';
ALTER TABLE runtime_settings ADD COLUMN agent_model_name TEXT NOT NULL DEFAULT '';
`

const migration7 = `
ALTER TABLE runs ADD COLUMN retry_of_run_id TEXT REFERENCES runs(id);
CREATE UNIQUE INDEX runs_retry_predecessor ON runs(retry_of_run_id);
UPDATE tasks SET status_reason = CASE
  WHEN status = 'failed' THEN 'last_run_failed'
  WHEN status = 'paused' THEN 'paused'
  WHEN status = 'waiting' THEN COALESCE(status_reason, 'awaiting_user_review')
  ELSE status_reason END;
UPDATE tasks SET status = CASE status
  WHEN 'inbox' THEN 'backlog' WHEN 'planning' THEN 'unstarted'
  WHEN 'running' THEN 'started' WHEN 'waiting' THEN 'started'
  WHEN 'failed' THEN 'started' WHEN 'paused' THEN 'started'
  ELSE status END;
CREATE TRIGGER task_status_insert BEFORE INSERT ON tasks
WHEN NEW.status NOT IN ('backlog','unstarted','started','completed','cancelled')
BEGIN SELECT RAISE(ABORT, 'Invalid task status'); END;
CREATE TRIGGER task_status_update BEFORE UPDATE OF status ON tasks
WHEN NEW.status NOT IN ('backlog','unstarted','started','completed','cancelled')
BEGIN SELECT RAISE(ABORT, 'Invalid task status'); END;
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
  retry_of_run_id: string | null
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

interface RuntimeSettingsRow {
  revision: number
  router_mode: RuntimeSettings['routerMode']
  model_provider: string
  model_connection_id: string | null
  model_name: string
  agent_model_mode: RuntimeSettings['agentModelMode']
  agent_model_provider: string
  agent_model_name: string
  privacy_mode: RuntimeSettings['privacyMode']
  rewrite_mode: RuntimeSettings['rewriteMode']
  updated_at: string
}

interface ModelProviderConnectionRow {
  id: string
  name: string
  protocol: ModelProviderProtocol
  base_url: string
  api_key_ciphertext: string | null
  updated_at: string
}

export interface ModelProviderConnectionWrite {
  id: ModelProviderId
  name: string
  protocol: ModelProviderProtocol
  baseUrl: string
  apiKeyCiphertext?: string
  clearApiKey: boolean
}

export class SettingsRevisionConflictError extends Error {
  constructor() {
    super('设置已在其他设备更新，请刷新后重试')
  }
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
    this.#migrate(4, migration4)
    this.#reconcileTaskOnlyV5()
    this.#migrate(5, migration5)
    this.#migrate(6, migration6)
    this.#migrate(7, migration7)
  }

  // An earlier UI candidate used v5 for task retries before provider v5
  // landed on main. Move only that fully applied migration marker to v7.
  #reconcileTaskOnlyV5(): void {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const hasV5 = this.#database
        .prepare('SELECT 1 FROM schema_migrations WHERE version = 5')
        .get()
      const hasTaskRetry = (
        this.#database.prepare('PRAGMA table_info(runs)').all() as {
          name: string
        }[]
      ).some(column => column.name === 'retry_of_run_id')
      const hasProviderColumn = (
        this.#database.prepare('PRAGMA table_info(runtime_settings)').all() as {
          name: string
        }[]
      ).some(column => column.name === 'model_connection_id')
      if (hasV5 && hasTaskRetry && !hasProviderColumn) {
        this.#database
          .prepare('UPDATE schema_migrations SET version = 7 WHERE version = 5')
          .run()
      }
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
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

  initializeRuntimeSettings(
    defaults: RuntimeSettingsSelection,
  ): RuntimeSettings {
    const now = this.#clock.now().toISOString()
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO runtime_settings
          (id, revision, router_mode, model_provider, model_connection_id, model_name,
           agent_model_mode, agent_model_provider, agent_model_name,
           privacy_mode, rewrite_mode, updated_at)
         VALUES (1, 1, ?, 'openai-compatible', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        defaults.routerMode,
        defaults.modelProvider,
        defaults.modelName,
        defaults.agentModelMode,
        defaults.agentModelProvider,
        defaults.agentModelName,
        defaults.privacyMode,
        defaults.rewriteMode,
        now,
      )
    return this.getRuntimeSettings()
  }

  hasRuntimeSettings(): boolean {
    return Boolean(
      this.#database
        .prepare('SELECT 1 AS present FROM runtime_settings WHERE id = 1')
        .get(),
    )
  }

  getRuntimeSettings(): RuntimeSettings {
    const row = this.#database
      .prepare('SELECT * FROM runtime_settings WHERE id = 1')
      .get() as unknown as RuntimeSettingsRow | undefined
    if (!row) throw new Error('Runtime settings have not been initialized')
    return toRuntimeSettings(row)
  }

  updateRuntimeSettings(
    expectedRevision: number,
    settings: RuntimeSettingsSelection,
  ): RuntimeSettings {
    const result = this.#database
      .prepare(
        `UPDATE runtime_settings
         SET revision = revision + 1, router_mode = ?,
             model_provider = 'openai-compatible', model_connection_id = ?,
             model_name = ?, agent_model_mode = ?, agent_model_provider = ?,
             agent_model_name = ?, privacy_mode = ?, rewrite_mode = ?, updated_at = ?
         WHERE id = 1 AND revision = ?`,
      )
      .run(
        settings.routerMode,
        settings.modelProvider,
        settings.modelName,
        settings.agentModelMode,
        settings.agentModelProvider,
        settings.agentModelName,
        settings.privacyMode,
        settings.rewriteMode,
        this.#clock.now().toISOString(),
        expectedRevision,
      )
    if (result.changes !== 1) throw new SettingsRevisionConflictError()
    return this.getRuntimeSettings()
  }

  initializeModelProviderConnection(
    connection: Omit<ModelProviderConnectionWrite, 'clearApiKey'>,
  ): ModelProviderConnection {
    const now = this.#clock.now().toISOString()
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO model_provider_connections
          (id, name, protocol, base_url, api_key_ciphertext, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        connection.id,
        connection.name,
        connection.protocol,
        connection.baseUrl,
        connection.apiKeyCiphertext ?? null,
        now,
      )
    const stored = this.getModelProviderConnection(connection.id)
    if (!stored)
      throw new Error('Model provider connection was not initialized')
    return stored
  }

  getModelProviderConnection(
    id: ModelProviderId,
  ): ModelProviderConnection | undefined {
    const row = this.#database
      .prepare('SELECT * FROM model_provider_connections WHERE id = ?')
      .get(id) as unknown as ModelProviderConnectionRow | undefined
    return row ? toModelProviderConnection(row) : undefined
  }

  listModelProviderConnections(): ModelProviderConnection[] {
    return (
      this.#database
        .prepare('SELECT * FROM model_provider_connections ORDER BY id')
        .all() as unknown as ModelProviderConnectionRow[]
    ).map(toModelProviderConnection)
  }

  listModelProviderConnectionSummaries(): ModelProviderConnectionSummary[] {
    return this.listModelProviderConnections().map(connection => ({
      id: connection.id,
      name: connection.name,
      protocol: connection.protocol,
      baseUrl: connection.baseUrl,
      hasApiKey: Boolean(connection.apiKeyCiphertext),
    }))
  }

  updateRuntimeSettingsAndProvider(
    expectedRevision: number,
    settings: RuntimeSettingsSelection,
    connection: ModelProviderConnectionWrite,
  ): RuntimeSettings {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#database
        .prepare('SELECT revision FROM runtime_settings WHERE id = 1')
        .get() as { revision: number } | undefined
      if (current?.revision !== expectedRevision) {
        throw new SettingsRevisionConflictError()
      }
      const existing = this.getModelProviderConnection(connection.id)
      const apiKeyCiphertext =
        connection.apiKeyCiphertext ??
        (connection.clearApiKey ? null : (existing?.apiKeyCiphertext ?? null))
      const now = this.#clock.now().toISOString()
      this.#database
        .prepare(
          `INSERT INTO model_provider_connections
            (id, name, protocol, base_url, api_key_ciphertext, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             protocol = excluded.protocol,
             base_url = excluded.base_url,
             api_key_ciphertext = excluded.api_key_ciphertext,
             updated_at = excluded.updated_at`,
        )
        .run(
          connection.id,
          connection.name,
          connection.protocol,
          connection.baseUrl,
          apiKeyCiphertext,
          now,
        )
      const result = this.#database
        .prepare(
          `UPDATE runtime_settings
           SET revision = revision + 1, router_mode = ?,
               model_provider = 'openai-compatible', model_connection_id = ?,
               model_name = ?, agent_model_mode = ?, agent_model_provider = ?,
               agent_model_name = ?, privacy_mode = ?, rewrite_mode = ?, updated_at = ?
           WHERE id = 1 AND revision = ?`,
        )
        .run(
          settings.routerMode,
          settings.modelProvider,
          settings.modelName,
          settings.agentModelMode,
          settings.agentModelProvider,
          settings.agentModelName,
          settings.privacyMode,
          settings.rewriteMode,
          now,
          expectedRevision,
        )
      if (result.changes !== 1) throw new SettingsRevisionConflictError()
      this.#database.exec('COMMIT')
      return this.getRuntimeSettings()
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
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
         VALUES (?, ?, ?, ?, ?, 'backlog', ?, ?)`,
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
             VALUES (?, ?, ?, ?, ?, 'unstarted', ?, ?)`,
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
          `UPDATE tasks SET status = CASE WHEN status = 'started' THEN 'started' ELSE 'unstarted' END, status_reason = NULL, updated_at = ?
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
            'SELECT * FROM runs WHERE task_id = ? ORDER BY created_at ASC, rowid ASC',
          )
          .all(taskId)
      : this.#database
          .prepare('SELECT * FROM runs ORDER BY created_at ASC, rowid ASC')
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
      let row = this.#database
        .prepare(
          `SELECT * FROM runs
           WHERE task_id IN (SELECT id FROM tasks WHERE status NOT IN ('completed','cancelled'))
           AND ((status = 'queued' AND NOT EXISTS (
             SELECT 1 FROM runs AS active WHERE active.task_id = runs.task_id AND active.status = 'running'
           )) OR (status = 'running' AND lease_until <= ?))
           ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        )
        .get(now.toISOString()) as unknown as RunRow | undefined
      if (!row) {
        this.#database.exec('COMMIT')
        return undefined
      }

      if (row.status === 'running') {
        this.#database
          .prepare(
            `UPDATE runs SET status = 'failed', last_error = 'lease_expired', claimed_by = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(now.toISOString(), row.id)
        const replacement = this.#createRetry(row, now.toISOString())
        row = this.#database
          .prepare('SELECT * FROM runs WHERE id = ?')
          .get(replacement.id) as unknown as RunRow
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
          `UPDATE tasks SET status = 'started', status_reason = NULL, updated_at = ?
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
           SET status = 'started', status_reason = 'awaiting_user_review', updated_at = ?
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
          `UPDATE tasks SET status = 'started', status_reason = 'last_run_failed', updated_at = ?
           WHERE id = ?`,
        )
        .run(now, task.id)
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

  retryRun(runId: string, userId: string): Run {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#database
        .prepare('SELECT * FROM runs WHERE id = ?')
        .get(runId) as unknown as RunRow | undefined
      if (!row) throw new Error('Run not found')
      const task = this.#taskById(row.task_id)
      if (task.userId !== userId)
        throw new Error('Task belongs to another user')
      const existing = this.#database
        .prepare('SELECT * FROM runs WHERE retry_of_run_id = ?')
        .get(runId) as unknown as RunRow | undefined
      if (existing) {
        this.#database.exec('COMMIT')
        return toRun(existing)
      }
      if (task.status === 'completed' || task.status === 'cancelled')
        throw new Error('Task is closed')
      if (row.status !== 'failed')
        throw new Error('Only failed runs can be retried')
      if (
        this.#database
          .prepare(
            `SELECT 1 FROM runs WHERE task_id = ? AND status IN ('queued','running')`,
          )
          .get(task.id)
      )
        throw new Error('Task already has active work')
      if (this.listRuns(task.id).at(-1)?.id !== runId)
        throw new Error('Only the latest failed run can be retried')
      const now = this.#clock.now().toISOString()
      const run = this.#createRetry(row, now)
      this.#database
        .prepare(
          `UPDATE tasks SET status = 'started', status_reason = 'retry_queued', updated_at = ? WHERE id = ?`,
        )
        .run(now, task.id)
      this.#database.exec('COMMIT')
      return run
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #createRetry(row: RunRow, now: string): Run {
    const id = randomUUID()
    this.#database
      .prepare(
        `INSERT INTO runs
      (id, task_id, executor, resume_from_ref, retry_of_run_id, status, input_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(
        id,
        row.task_id,
        row.executor,
        row.executor_ref ?? row.resume_from_ref,
        row.id,
        row.input_json,
        now,
        now,
      )
    return this.#runById(id)
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

function toRuntimeSettings(row: RuntimeSettingsRow): RuntimeSettings {
  const modelProvider = row.model_connection_id ?? 'openai'
  if (!modelProviderPreset(modelProvider)) {
    throw new Error(`Unknown stored model provider: ${modelProvider}`)
  }
  return {
    revision: row.revision,
    routerMode: row.router_mode,
    modelProvider: modelProvider as ModelProviderId,
    modelName: row.model_name,
    agentModelMode: row.agent_model_mode,
    agentModelProvider: row.agent_model_provider,
    agentModelName: row.agent_model_name,
    privacyMode: row.privacy_mode,
    rewriteMode: row.rewrite_mode,
    updatedAt: row.updated_at,
  }
}

function toModelProviderConnection(
  row: ModelProviderConnectionRow,
): ModelProviderConnection {
  if (!modelProviderPreset(row.id)) {
    throw new Error(`Unknown stored model provider: ${row.id}`)
  }
  return {
    id: row.id as ModelProviderId,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.base_url,
    ...(row.api_key_ciphertext
      ? { apiKeyCiphertext: row.api_key_ciphertext }
      : {}),
    updatedAt: row.updated_at,
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
    ...(row.retry_of_run_id ? { retryOfRunId: row.retry_of_run_id } : {}),
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
