-- Historical Pegas schema v4, captured before TASK-001 five-state migration.

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


ALTER TABLE outbox_messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox_messages ADD COLUMN claimed_by TEXT;
ALTER TABLE outbox_messages ADD COLUMN lease_until TEXT;
ALTER TABLE outbox_messages ADD COLUMN next_attempt_at TEXT;
ALTER TABLE outbox_messages ADD COLUMN last_error TEXT;
ALTER TABLE outbox_messages ADD COLUMN updated_at TEXT;

UPDATE outbox_messages SET updated_at = created_at WHERE updated_at IS NULL;

CREATE INDEX outbox_messages_claim
ON outbox_messages (status, next_attempt_at, lease_until, created_at);


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

INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-11-17'), (2, '2026-11-17'), (3, '2026-11-17'), (4, '2026-11-17');
