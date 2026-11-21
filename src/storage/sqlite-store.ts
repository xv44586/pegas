import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { systemClock, type Clock } from '../core/clock.js'
import { assignWorkerIconId, isWorkerIconId } from '../brand/agent-icon.js'
import {
  projectWorkChannel,
  type ChannelSearchOptions,
  type ChannelSearchResult,
} from '../channel/work-channel.js'
import {
  collaborationRequestFingerprint,
  intersectContextNoteAuthority,
  type ChannelRelation,
  type CollaborationKind,
  type CollaborationResult,
  type CollaborationStatus,
  type WorkerCollaborationRequest,
} from '../collaboration/collaboration.js'
import type {
  ActionOutcomeDraft,
  ActionReconciliation,
  ActionReconciliationDraft,
  ActionRequestDraft,
  Approval,
  ApprovalDecision,
  ApprovalDecisionDraft,
  ApprovalPrompt,
  DurableAction,
} from '../approval/approval.js'
import type {
  ClaimedRun,
  EventAttachment,
  ExecutionContext,
  InboxEvent,
  ModelUsageRecord,
  ModelUsageReport,
  NewInboxEvent,
  OutboxMessage,
  RoutingDecision,
  Run,
  Task,
} from '../core/domain.js'
import type { ExecutorResult } from '../executor/executor.js'
import type {
  ArtifactDraft,
  EvidenceVerification,
  EvidenceRef,
  EvidenceRefDraft,
  GoalContract,
  GoalContractDraft,
  ReviewCriterion,
  ReviewPack,
  TaskArtifact,
  WorkerReport,
  WorkerReportDraft,
} from '../goal/goal-delivery.js'
import {
  createMandate,
  revalidateMandate,
  sameExecutionContext,
} from '../task/task-lifecycle.js'
import type {
  ModelProviderConnection,
  ModelProviderConnectionSummary,
  RuntimeSettings,
  RuntimeSettingsSelection,
} from '../settings/runtime-settings.js'
import {
  memoryFingerprint,
  toMemoryContext,
  type MemoryCategory,
  type MemoryCreateCommand,
  type MemoryDeleteCommand,
  type MemoryDeletion,
  type MemoryListOptions,
  type MemoryRecord,
  type MemoryScope,
  type MemorySource,
  type MemoryUpdateCommand,
} from '../memory/memory.js'
import {
  modelProviderPreset,
  type ModelProviderId,
  type ModelProviderProtocol,
} from '../model/provider-catalog.js'
import {
  defaultSpeechConnection,
  type SpeechConnection,
  type SpeechSettingsSummary,
} from '../speech/speech-settings.js'
import {
  defaultRewriteConnection,
  type RewriteConnection,
  type RewriteSettingsSummary,
} from '../rewrite/rewrite-settings.js'
import {
  automationFingerprint,
  firstAutomaticFireAt,
  nextIntervalFireAt,
  resumedFireAt,
  type Automation,
  type AutomationCreateCommand,
  type AutomationInvocation,
  type AutomationInvocationStatus,
  type AutomationSchedule,
  type AutomationStatus,
  type AutomationStatusCommand,
  type AutomationTarget,
  type AutomationUpdateCommand,
} from '../schedule/schedule.js'
import {
  effectiveWorkerProfile,
  workerExecutionContext,
  workerProfileFingerprint,
  type EffectiveWorkerProfile,
  type WorkerProfile,
  type WorkerProfileUpdate,
} from '../worker/worker-profile.js'

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
const workerProfileCommandRetention = 256
const maximumActiveChildCollaborations = 8
const maximumCollaborationsPerRun = 32
const maximumCollaborationsPerRoot = 32
const maximumCollaborationDepth = 4
const maximumPendingContextNotesPerTarget = 4
const maximumActiveCollaborationsPerOwner = 64
const currentInboxContractVersion = 2

const migration20 = `
CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  next_fire_at TEXT,
  last_fired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX automations_by_user
ON automations (user_id, updated_at DESC);

CREATE INDEX automations_due
ON automations (status, next_fire_at);

CREATE TABLE automation_commands (
  user_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  operation TEXT NOT NULL,
  automation_id TEXT NOT NULL REFERENCES automations(id),
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, command_id)
);

CREATE TABLE automation_invocations (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id),
  user_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE REFERENCES inbox_events(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'dispatched', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (automation_id, scheduled_for)
);

CREATE INDEX automation_invocations_by_automation
ON automation_invocations (automation_id, scheduled_for DESC);
`

const migration21 = `
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'worker', 'channel')),
  scope_task_id TEXT REFERENCES tasks(id),
  category TEXT NOT NULL CHECK (category IN (
    'preference', 'fact', 'context', 'experience', 'procedure',
    'sensitive_reference'
  )),
  content TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'user_confirmation', 'task', 'run', 'artifact'
  )),
  source_id TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  CHECK (
    (scope = 'global' AND scope_task_id IS NULL)
    OR (scope IN ('worker', 'channel') AND scope_task_id IS NOT NULL)
  ),
  CHECK (
    (source_kind = 'user_confirmation' AND source_id IS NULL)
    OR (source_kind != 'user_confirmation' AND source_id IS NOT NULL)
  )
);

CREATE INDEX memories_by_user_updated
ON memories (user_id, updated_at DESC, id DESC);

CREATE INDEX memories_by_task_scope
ON memories (user_id, scope_task_id, scope, updated_at DESC);

CREATE TRIGGER memories_scope_task_owner_insert
BEFORE INSERT ON memories
WHEN NEW.scope_task_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.scope_task_id AND user_id = NEW.user_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Memory scope Task does not belong to owner');
END;

CREATE TRIGGER memories_scope_task_owner_update
BEFORE UPDATE OF user_id, scope_task_id ON memories
WHEN NEW.scope_task_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.scope_task_id AND user_id = NEW.user_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Memory scope Task does not belong to owner');
END;

CREATE TABLE memory_commands (
  user_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  memory_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, command_id)
);

CREATE INDEX memory_commands_by_memory
ON memory_commands (memory_id);
`

const migration22 = `
CREATE TABLE goal_proposal_commands (
  run_id TEXT NOT NULL REFERENCES runs(id),
  command_id TEXT NOT NULL,
  request_claim_hash TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  contract_id TEXT NOT NULL REFERENCES goal_contracts(id),
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, command_id)
);
`

const migration23 = `
CREATE TABLE action_reconciliations (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL UNIQUE REFERENCES actions(id),
  command_id TEXT NOT NULL UNIQUE,
  resolution TEXT NOT NULL CHECK (resolution IN ('succeeded','failed')),
  note TEXT NOT NULL,
  previous_status TEXT NOT NULL CHECK (previous_status IN ('failed','unknown')),
  previous_result_json TEXT,
  request_fingerprint TEXT NOT NULL,
  reconciled_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER action_reconciliations_immutable
BEFORE UPDATE ON action_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'Action reconciliation records are immutable');
END;

CREATE TRIGGER action_reconciliations_delete_guard
BEFORE DELETE ON action_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'Action reconciliation records are immutable');
END;

CREATE TRIGGER action_reconciliations_action_guard
BEFORE INSERT ON action_reconciliations
WHEN (
  SELECT protocol_version FROM actions WHERE id = NEW.action_id
) <> 1 OR (
  SELECT status FROM actions WHERE id = NEW.action_id
) NOT IN ('failed','unknown') OR NEW.previous_status <> (
  SELECT status FROM actions WHERE id = NEW.action_id
)
BEGIN
  SELECT RAISE(ABORT, 'Only a failed or unknown Action can be reconciled');
END;
`

const migration24 = `
ALTER TABLE runs ADD COLUMN steering_json TEXT;
ALTER TABLE runs ADD COLUMN steering_of_run_id TEXT REFERENCES runs(id);
CREATE UNIQUE INDEX runs_by_steering_source
ON runs (steering_of_run_id) WHERE steering_of_run_id IS NOT NULL;
`

const migration25 = `
ALTER TABLE tasks ADD COLUMN target_resource TEXT;

CREATE TRIGGER tasks_target_resource_guard
BEFORE UPDATE OF target_resource ON tasks
WHEN OLD.target_resource IS NOT NULL
  AND NEW.target_resource IS NOT OLD.target_resource
BEGIN
  SELECT RAISE(ABORT, 'Task target resource is immutable');
END;
`

const migration26 = `
ALTER TABLE inbox_events ADD COLUMN device_id TEXT;

CREATE TABLE IF NOT EXISTS event_attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE REFERENCES inbox_events(id),
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

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

const migration8 = `
CREATE TABLE speech_connections (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL CHECK (provider IN ('disabled', 'openai-compatible')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  api_key_ciphertext TEXT,
  updated_at TEXT NOT NULL
);
`

const migration9 = `
CREATE TABLE rewrite_connections (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('router', 'custom')),
  protocol TEXT NOT NULL CHECK (protocol IN ('openai-chat', 'anthropic-messages')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  api_key_ciphertext TEXT,
  updated_at TEXT NOT NULL
);
`

const migration10 = `
ALTER TABLE tasks ADD COLUMN mandate_json TEXT;
ALTER TABLE tasks ADD COLUMN ended_json TEXT;
ALTER TABLE runs ADD COLUMN execution_context_json TEXT;

UPDATE tasks
SET mandate_json = json_object(
  'strength', 'explicit',
  'policyVersion', 'pegas-mandate-v1',
  'basis', json_object(
    'source', COALESCE((SELECT source FROM inbox_events WHERE id = tasks.origin_event_id), 'legacy'),
    'scope', json_object('conversation', user_id),
    'via', 'router',
    'sender', user_id
  ),
  'actor', json_object(
    'source', COALESCE((SELECT source FROM inbox_events WHERE id = tasks.origin_event_id), 'legacy'),
    'id', user_id
  ),
  'scope', goal
)
WHERE mandate_json IS NULL;

UPDATE tasks
SET ended_json = CASE status
  WHEN 'completed' THEN json_object('at', updated_at, 'by', 'executor', 'outcome', 'completed')
  WHEN 'cancelled' THEN json_object('at', updated_at, 'by', 'human', 'outcome', 'stopped', 'reason', COALESCE(status_reason, 'legacy_stop'))
  ELSE NULL
END;

UPDATE runs
SET execution_context_json = json_object('executor', executor)
WHERE execution_context_json IS NULL;

CREATE TABLE task_commands (
  command_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX task_commands_by_task ON task_commands(task_id, created_at);
`

const migration11 = `
ALTER TABLE tasks ADD COLUMN worker_icon_id TEXT
  CHECK (worker_icon_id IN ('car', 'camera', 'computer', 'phone'));
`

const migration12 = `
ALTER TABLE outbox_messages ADD COLUMN read_at TEXT;
CREATE INDEX outbox_messages_by_user_read
ON outbox_messages (user_id, read_at, created_at DESC);
`

const migration13 = `
CREATE TABLE model_usage_records (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  user_id TEXT NOT NULL,
  executor TEXT NOT NULL,
  model_ref TEXT,
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'partial', 'unavailable')),
  token_source TEXT CHECK (token_source IN ('provider_reported')),
  input_tokens INTEGER CHECK (input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens >= 0),
  reported_steps INTEGER NOT NULL CHECK (reported_steps >= 0),
  unreported_steps INTEGER NOT NULL CHECK (unreported_steps >= 0),
  duration_ms INTEGER CHECK (duration_ms >= 0),
  latency_source TEXT CHECK (latency_source IN ('pegas_observed')),
  cost_usd REAL CHECK (cost_usd >= 0),
  cost_source TEXT CHECK (cost_source IN ('provider_reported')),
  observed_at TEXT NOT NULL
);

CREATE INDEX model_usage_by_user_time
ON model_usage_records (user_id, observed_at DESC);
CREATE INDEX model_usage_by_task_time
ON model_usage_records (task_id, observed_at DESC);
`

const migration14 = `
CREATE INDEX runs_by_task_time ON runs (task_id, created_at);
CREATE INDEX outbox_messages_by_user_task_time
ON outbox_messages (user_id, task_id, created_at);
CREATE INDEX inbox_events_by_user_status_time
ON inbox_events (user_id, status, created_at);
`

const migration15 = `
ALTER TABLE runs ADD COLUMN goal_revision INTEGER;
ALTER TABLE runs ADD COLUMN claim_token_hash TEXT;

CREATE TABLE goal_contracts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  command_id TEXT NOT NULL UNIQUE,
  based_on_event_ids_json TEXT NOT NULL,
  desired_outcome TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, revision)
);

CREATE INDEX goal_contracts_by_task_revision
ON goal_contracts (task_id, revision DESC);

CREATE TABLE task_artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT REFERENCES runs(id),
  command_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime_type TEXT,
  uri TEXT,
  revision TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER,
  metadata_json TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX task_artifacts_by_task_time
ON task_artifacts (task_id, created_at DESC);

CREATE TABLE evidence_refs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  command_id TEXT NOT NULL UNIQUE,
  source_key TEXT NOT NULL,
  goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
  criterion_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  artifact_id TEXT REFERENCES task_artifacts(id),
  external_ref TEXT,
  producer_identity TEXT NOT NULL,
  capture_mechanism TEXT NOT NULL,
  trust_class TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  artifact_revision TEXT,
  observation_snapshot_json TEXT,
  verification_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  environment_json TEXT NOT NULL,
  presentation_json TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  limitations_json TEXT NOT NULL
);

CREATE INDEX evidence_refs_by_task_goal_criterion
ON evidence_refs (task_id, goal_revision, criterion_id, captured_at);

CREATE UNIQUE INDEX evidence_refs_semantic_dedupe
ON evidence_refs (task_id, run_id, goal_revision, criterion_id, source_key, kind);

CREATE TABLE evidence_commands (
  command_id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES evidence_refs(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  created_at TEXT NOT NULL
);

CREATE TABLE evidence_verification_events (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES evidence_refs(id),
  command_id TEXT NOT NULL UNIQUE,
  verification_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX evidence_verifications_by_evidence_time
ON evidence_verification_events (evidence_id, created_at);

CREATE TABLE review_packs (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
  basis_event_ids_json TEXT NOT NULL,
  basis_event_set_hash TEXT NOT NULL,
  projection_as_of TEXT NOT NULL,
  final_outcome TEXT NOT NULL CHECK (final_outcome IN ('completed','partial','failed')),
  criteria_json TEXT NOT NULL,
  side_effects_json TEXT NOT NULL,
  remaining_risks_json TEXT NOT NULL,
  rollback_json TEXT,
  audit_link TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, goal_revision, basis_event_set_hash)
);

CREATE INDEX review_packs_by_task_revision
ON review_packs (task_id, revision DESC);

CREATE TABLE worker_reports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  worker_id TEXT NOT NULL,
  claim_token_hash TEXT,
  goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
  report_sequence INTEGER NOT NULL CHECK (report_sequence >= 0),
  status TEXT NOT NULL,
  evidence_ref_ids_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  limitations_json TEXT NOT NULL,
  remaining_risks_json TEXT NOT NULL,
  rollback_json TEXT,
  review_pack_id TEXT REFERENCES review_packs(id),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, report_sequence)
);

CREATE INDEX worker_reports_by_run_sequence
ON worker_reports (run_id, report_sequence);
`

const migration16 = `
PRAGMA defer_foreign_keys = ON;

CREATE TABLE actions_v16 (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT REFERENCES runs(id),
  kind TEXT NOT NULL,
  risk TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resume_run_id TEXT REFERENCES runs(id),
  recovery_point_json TEXT NOT NULL DEFAULT '{}',
  request_claim_hash TEXT,
  request_fingerprint TEXT,
  protocol_version INTEGER NOT NULL DEFAULT 0
);

INSERT INTO actions_v16
  (id, task_id, run_id, kind, risk, idempotency_key, status,
   request_json, result_json, created_at, updated_at)
SELECT id, task_id, run_id, kind, risk, idempotency_key, status,
       request_json, result_json, created_at, updated_at
FROM actions;

CREATE TABLE approvals_v16 (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  action_id TEXT NOT NULL UNIQUE REFERENCES actions_v16(id),
  status TEXT NOT NULL,
  prompt_json TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  user_id TEXT,
  protocol_version INTEGER NOT NULL DEFAULT 0
);

INSERT INTO approvals_v16
  (id, task_id, action_id, status, prompt_json, response_json,
   created_at, resolved_at, user_id)
SELECT approvals.id, approvals.task_id, approvals.action_id, approvals.status,
       approvals.prompt_json, approvals.response_json, approvals.created_at,
       approvals.resolved_at, tasks.user_id
FROM approvals
INNER JOIN tasks ON tasks.id = approvals.task_id;

DROP TABLE approvals;
DROP TABLE actions;
ALTER TABLE actions_v16 RENAME TO actions;
ALTER TABLE approvals_v16 RENAME TO approvals;

CREATE INDEX actions_by_task_time ON actions (task_id, created_at DESC);
CREATE UNIQUE INDEX actions_v1_idempotency_key
ON actions (idempotency_key) WHERE protocol_version = 1;

CREATE TABLE approval_decisions (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  event_id TEXT NOT NULL UNIQUE REFERENCES inbox_events(id),
  command_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('approve','reject','revise')),
  rationale TEXT,
  decided_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE INDEX approvals_by_task_time ON approvals (task_id, created_at DESC);
CREATE INDEX approvals_by_user_time
ON approvals (user_id, created_at DESC, id DESC);
CREATE INDEX approvals_by_user_status_time
ON approvals (user_id, status, created_at DESC, id DESC);

CREATE TABLE action_outcomes (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL UNIQUE REFERENCES actions(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  command_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','unknown')),
  result_json TEXT NOT NULL,
  claim_token_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
`

const migration17 = `
ALTER TABLE runs ADD COLUMN execution_contract_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE runs ADD COLUMN claimed_contract_version INTEGER;

CREATE TABLE worker_profiles (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  model_mode TEXT NOT NULL CHECK (model_mode IN ('inherit','override')),
  model_provider TEXT,
  model_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (model_mode = 'inherit' AND model_provider IS NULL AND model_name IS NULL)
    OR
    (model_mode = 'override' AND model_provider IS NOT NULL AND model_name IS NOT NULL)
  )
);

INSERT INTO worker_profiles
  (id, task_id, revision, model_mode, created_at, updated_at)
SELECT 'worker-profile:' || id, id, 1, 'inherit', created_at, updated_at
FROM tasks;

CREATE TABLE worker_profile_commands (
  command_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX worker_profile_commands_by_task_time
ON worker_profile_commands (task_id, created_at DESC);

CREATE TRIGGER worker_profiles_after_task_insert
AFTER INSERT ON tasks
BEGIN
  INSERT OR IGNORE INTO worker_profiles
    (id, task_id, revision, model_mode, created_at, updated_at)
  VALUES ('worker-profile:' || NEW.id, NEW.id, 1, 'inherit', NEW.created_at, NEW.updated_at);
END;

CREATE TRIGGER runs_execution_contract_claim_guard
BEFORE UPDATE OF status ON runs
WHEN NEW.status = 'running'
  AND NEW.execution_contract_version > COALESCE(NEW.claimed_contract_version, 1)
BEGIN
  SELECT RAISE(ABORT, 'unsupported execution contract');
END;

CREATE TRIGGER runs_execution_contract_handoff_guard
BEFORE UPDATE OF claimed_by ON runs
WHEN NEW.execution_contract_version > 1
  AND OLD.claimed_by IS NOT NULL
  AND NEW.claimed_by IS NOT NULL
  AND OLD.claimed_by <> NEW.claimed_by
BEGIN
  SELECT RAISE(ABORT, 'unsupported execution contract handoff');
END;

CREATE TRIGGER runs_clear_claimed_contract
AFTER UPDATE OF claimed_by ON runs
WHEN NEW.claimed_by IS NULL AND NEW.claimed_contract_version IS NOT NULL
BEGIN
  UPDATE runs SET claimed_contract_version = NULL WHERE id = NEW.id;
END;

CREATE TRIGGER runs_retry_contract_downgrade_guard
BEFORE INSERT ON runs
WHEN NEW.retry_of_run_id IS NOT NULL
  AND NEW.execution_contract_version < COALESCE(
    (SELECT execution_contract_version FROM runs WHERE id = NEW.retry_of_run_id),
    NEW.execution_contract_version
  )
BEGIN
  SELECT RAISE(ABORT, 'execution contract downgrade');
END;
`

const migration18 = `
CREATE TABLE channel_search_documents (
  rowid INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, source_kind, source_id)
);

CREATE INDEX channel_search_documents_by_task
ON channel_search_documents (task_id);

CREATE INDEX tasks_by_user_created
ON tasks (user_id, created_at DESC, id DESC);

CREATE INDEX tasks_by_user_status
ON tasks (user_id, status, updated_at DESC, id DESC);

CREATE INDEX outbox_by_task_read
ON outbox_messages (task_id, read_at);

CREATE VIRTUAL TABLE channel_search USING fts5(
  text,
  content = 'channel_search_documents',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER channel_search_documents_after_insert
AFTER INSERT ON channel_search_documents
BEGIN
  INSERT INTO channel_search (rowid, text) VALUES (NEW.rowid, NEW.text);
END;

CREATE TRIGGER channel_search_documents_after_delete
AFTER DELETE ON channel_search_documents
BEGIN
  INSERT INTO channel_search (channel_search, rowid, text)
  VALUES ('delete', OLD.rowid, OLD.text);
END;

CREATE TRIGGER channel_search_documents_after_update
AFTER UPDATE OF text ON channel_search_documents
BEGIN
  INSERT INTO channel_search (channel_search, rowid, text)
  VALUES ('delete', OLD.rowid, OLD.text);
  INSERT INTO channel_search (rowid, text) VALUES (NEW.rowid, NEW.text);
END;

CREATE TRIGGER channel_search_tasks_after_insert
AFTER INSERT ON tasks
BEGIN
  INSERT INTO channel_search_documents
    (task_id, source_kind, source_id, text, updated_at)
  VALUES
    (NEW.id, 'channel', NEW.id, NEW.title || char(10) || NEW.goal, NEW.updated_at);
END;

CREATE TRIGGER channel_search_tasks_after_update
AFTER UPDATE OF title, goal ON tasks
BEGIN
  INSERT OR REPLACE INTO channel_search_documents
    (task_id, source_kind, source_id, text, updated_at)
  VALUES
    (NEW.id, 'channel', NEW.id, NEW.title || char(10) || NEW.goal, NEW.updated_at);
END;

CREATE TRIGGER channel_search_pending_input_after_insert
AFTER INSERT ON inbox_events
WHEN NEW.type = 'user.message'
  AND json_valid(NEW.payload_json)
  AND json_type(NEW.payload_json, '$.text') = 'text'
  AND json_type(NEW.payload_json, '$.taskId') = 'text'
BEGIN
  INSERT OR REPLACE INTO channel_search_documents
    (task_id, source_kind, source_id, text, updated_at)
  SELECT
    tasks.id,
    'input',
    NEW.id,
    json_extract(NEW.payload_json, '$.text'),
    NEW.created_at
  FROM tasks
  WHERE tasks.id = json_extract(NEW.payload_json, '$.taskId')
    AND tasks.user_id = NEW.user_id;
END;

CREATE TRIGGER channel_search_routed_input_after_insert
AFTER INSERT ON task_events
BEGIN
  INSERT OR REPLACE INTO channel_search_documents
    (task_id, source_kind, source_id, text, updated_at)
  SELECT
    NEW.task_id,
    'input',
    inbox_events.id,
    json_extract(inbox_events.payload_json, '$.text'),
    inbox_events.created_at
  FROM inbox_events
  INNER JOIN tasks ON tasks.id = NEW.task_id
  WHERE inbox_events.id = NEW.event_id
    AND tasks.user_id = inbox_events.user_id
    AND inbox_events.type = 'user.message'
    AND json_valid(inbox_events.payload_json)
    AND json_type(inbox_events.payload_json, '$.text') = 'text';
END;

CREATE TRIGGER channel_search_run_output_after_update
AFTER UPDATE OF output_json ON runs
WHEN NEW.output_json IS NOT NULL
BEGIN
  INSERT OR REPLACE INTO channel_search_documents
    (task_id, source_kind, source_id, text, updated_at)
  VALUES
    (NEW.task_id, 'run', NEW.id, json_extract(NEW.output_json, '$'), NEW.updated_at);
END;

CREATE TRIGGER channel_search_report_after_insert
AFTER INSERT ON worker_reports
BEGIN
  INSERT OR REPLACE INTO channel_search_documents
    (task_id, source_kind, source_id, text, updated_at)
  VALUES
    (NEW.task_id, 'report', NEW.id, NEW.summary, NEW.created_at);
END;

CREATE TRIGGER channel_search_artifact_after_insert
AFTER INSERT ON task_artifacts
BEGIN
  INSERT OR REPLACE INTO channel_search_documents
    (task_id, source_kind, source_id, text, updated_at)
  VALUES
    (NEW.task_id, 'artifact', NEW.id, NEW.name, NEW.created_at);
END;

CREATE TRIGGER channel_search_outbox_after_insert
AFTER INSERT ON outbox_messages
WHEN NEW.task_id IS NOT NULL
  AND json_valid(NEW.payload_json)
  AND json_type(NEW.payload_json, '$.text') = 'text'
BEGIN
  INSERT OR REPLACE INTO channel_search_documents
    (task_id, source_kind, source_id, text, updated_at)
  VALUES
    (NEW.task_id, 'outbox', NEW.id, json_extract(NEW.payload_json, '$.text'), NEW.created_at);
END;

INSERT OR REPLACE INTO channel_search_documents
  (task_id, source_kind, source_id, text, updated_at)
SELECT id, 'channel', id, title || char(10) || goal, updated_at
FROM tasks;

INSERT INTO channel_search_documents
  (task_id, source_kind, source_id, text, updated_at)
SELECT
  task_events.task_id,
  'input',
  inbox_events.id,
  json_extract(inbox_events.payload_json, '$.text'),
  inbox_events.created_at
FROM task_events
INNER JOIN inbox_events ON inbox_events.id = task_events.event_id
INNER JOIN tasks ON tasks.id = task_events.task_id
WHERE inbox_events.type = 'user.message'
  AND tasks.user_id = inbox_events.user_id
  AND json_valid(inbox_events.payload_json)
  AND json_type(inbox_events.payload_json, '$.text') = 'text'
;

INSERT OR REPLACE INTO channel_search_documents
  (task_id, source_kind, source_id, text, updated_at)
SELECT task_id, 'run', id, json_extract(output_json, '$'), updated_at
FROM runs
WHERE output_json IS NOT NULL
;

INSERT OR REPLACE INTO channel_search_documents
  (task_id, source_kind, source_id, text, updated_at)
SELECT task_id, 'report', id, summary, created_at
FROM worker_reports
;

INSERT OR REPLACE INTO channel_search_documents
  (task_id, source_kind, source_id, text, updated_at)
SELECT task_id, 'artifact', id, name, created_at
FROM task_artifacts
;

INSERT OR REPLACE INTO channel_search_documents
  (task_id, source_kind, source_id, text, updated_at)
SELECT
  task_id,
  'outbox',
  id,
  json_extract(payload_json, '$.text'),
  created_at
FROM outbox_messages
WHERE task_id IS NOT NULL
  AND json_valid(payload_json)
  AND json_type(payload_json, '$.text') = 'text';
`

const migration19 = `
ALTER TABLE inbox_events ADD COLUMN required_contract_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE inbox_events ADD COLUMN claimed_contract_version INTEGER;
ALTER TABLE inbox_events ADD COLUMN authenticated_actor TEXT CHECK (authenticated_actor IN ('human'));

CREATE TABLE channel_relations (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  request_claim_hash TEXT NOT NULL,
  creation_response_json TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('delegate','handoff','context_note','handback')),
  status TEXT NOT NULL CHECK (status IN ('pending','active','returned','completed','failed','cancelled')),
  source_task_id TEXT NOT NULL REFERENCES tasks(id),
  source_run_id TEXT NOT NULL REFERENCES runs(id),
  parent_relation_id TEXT REFERENCES channel_relations(id),
  root_relation_id TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  target_task_id TEXT REFERENCES tasks(id),
  target_event_id TEXT NOT NULL REFERENCES inbox_events(id),
  return_event_id TEXT REFERENCES inbox_events(id),
  request_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE INDEX channel_relations_by_source
ON channel_relations (source_task_id, created_at DESC);

CREATE UNIQUE INDEX channel_relations_source_command
ON channel_relations (source_run_id, command_id);

CREATE INDEX channel_relations_by_source_page
ON channel_relations (user_id, source_task_id, created_at DESC, id DESC);

CREATE INDEX channel_relations_by_target
ON channel_relations (target_task_id, created_at DESC);

CREATE INDEX channel_relations_by_target_page
ON channel_relations (user_id, target_task_id, created_at DESC, id DESC);

CREATE INDEX channel_relations_by_user_status
ON channel_relations (user_id, status, created_at DESC);

CREATE INDEX channel_relations_active_children
ON channel_relations (source_task_id, kind)
WHERE status IN ('pending','active') AND kind IN ('delegate','handoff');

CREATE INDEX channel_relations_pending_notes
ON channel_relations (target_task_id)
WHERE status IN ('pending','active') AND kind = 'context_note';

CREATE INDEX channel_relations_by_root
ON channel_relations (root_relation_id, created_at DESC);

CREATE UNIQUE INDEX channel_relations_target_event
ON channel_relations (target_event_id) WHERE target_event_id IS NOT NULL;

CREATE UNIQUE INDEX channel_relations_return_event
ON channel_relations (return_event_id) WHERE return_event_id IS NOT NULL;

CREATE INDEX actions_by_resume_run_status
ON actions (resume_run_id, protocol_version, status, updated_at DESC);

CREATE TRIGGER inbox_events_contract_claim_guard
BEFORE UPDATE OF status ON inbox_events
WHEN NEW.status = 'processing'
  AND NEW.required_contract_version > COALESCE(NEW.claimed_contract_version, 1)
BEGIN
  SELECT RAISE(ABORT, 'unsupported inbox event contract');
END;

CREATE TRIGGER inbox_events_contract_transfer_guard
BEFORE UPDATE OF claimed_by ON inbox_events
WHEN OLD.required_contract_version > 1
  AND OLD.status = 'processing'
  AND OLD.claimed_by IS NOT NULL
  AND NEW.status = 'processing'
  AND NEW.claimed_by IS NOT OLD.claimed_by
BEGIN
  SELECT RAISE(ABORT, 'reserved inbox event claim must be released before transfer');
END;

CREATE TRIGGER inbox_events_clear_claimed_contract
AFTER UPDATE OF claimed_by ON inbox_events
WHEN NEW.claimed_by IS NULL AND NEW.claimed_contract_version IS NOT NULL
BEGIN
  UPDATE inbox_events SET claimed_contract_version = NULL WHERE id = NEW.id;
END;

CREATE TRIGGER channel_relations_integrity_insert
BEFORE INSERT ON channel_relations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM runs
    INNER JOIN tasks ON tasks.id = runs.task_id
    WHERE runs.id = NEW.source_run_id
      AND runs.task_id = NEW.source_task_id
      AND tasks.user_id = NEW.user_id
  ) THEN RAISE(ABORT, 'invalid collaboration source') END;
  SELECT CASE WHEN NEW.target_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks
    WHERE tasks.id = NEW.target_task_id AND tasks.user_id = NEW.user_id
  ) THEN RAISE(ABORT, 'invalid collaboration target') END;
  SELECT CASE WHEN NEW.kind <> 'handback' AND NEW.target_task_id IS NULL
    THEN RAISE(ABORT, 'invalid collaboration target shape') END;
  SELECT CASE WHEN NEW.target_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM inbox_events
    WHERE inbox_events.id = NEW.target_event_id
      AND inbox_events.user_id = NEW.user_id
      AND inbox_events.source = 'collaboration'
      AND inbox_events.type = CASE NEW.kind
        WHEN 'delegate' THEN 'collaboration.delegated'
        WHEN 'handoff' THEN 'collaboration.handed_off'
        WHEN 'context_note' THEN 'collaboration.context_note'
        ELSE 'collaboration.handback'
      END
      AND json_valid(inbox_events.payload_json)
      AND json_extract(inbox_events.payload_json, '$.relationId') = NEW.id
      AND json_extract(inbox_events.payload_json, '$.sourceTaskId') = NEW.source_task_id
      AND (
        NEW.kind = 'handback' OR
        json_extract(inbox_events.payload_json, '$.taskId') = NEW.target_task_id
      )
      AND (
        NEW.target_task_id IS NULL OR EXISTS (
          SELECT 1 FROM task_events
          WHERE task_events.event_id = inbox_events.id
            AND task_events.task_id = NEW.target_task_id
        )
      )
  ) THEN RAISE(ABORT, 'invalid collaboration event') END;
  SELECT CASE WHEN NEW.return_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM inbox_events
    WHERE inbox_events.id = NEW.return_event_id
      AND inbox_events.user_id = NEW.user_id
      AND inbox_events.source = 'collaboration'
      AND inbox_events.type IN (
        'collaboration.returned', 'collaboration.completed',
        'collaboration.failed'
      )
      AND json_valid(inbox_events.payload_json)
      AND json_extract(inbox_events.payload_json, '$.relationId') = NEW.id
      AND json_extract(inbox_events.payload_json, '$.sourceTaskId') = NEW.source_task_id
      AND EXISTS (
        SELECT 1 FROM task_events
        WHERE task_events.event_id = inbox_events.id
          AND task_events.task_id = NEW.source_task_id
      )
  ) THEN RAISE(ABORT, 'invalid collaboration return event') END;
  SELECT CASE WHEN NEW.parent_relation_id IS NULL AND
    (NEW.depth <> 0 OR NEW.root_relation_id <> NEW.id)
    THEN RAISE(ABORT, 'invalid collaboration root') END;
  SELECT CASE WHEN NEW.depth > ${String(maximumCollaborationDepth)}
    THEN RAISE(ABORT, 'invalid collaboration depth') END;
  SELECT CASE WHEN NEW.parent_relation_id IS NULL AND EXISTS (
    SELECT 1 FROM channel_relations
    WHERE channel_relations.target_task_id = NEW.source_task_id
      AND channel_relations.kind IN ('delegate','handoff')
  ) THEN RAISE(ABORT, 'missing collaboration parent') END;
  SELECT CASE WHEN NEW.parent_relation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM channel_relations
    WHERE channel_relations.id = NEW.parent_relation_id
      AND channel_relations.user_id = NEW.user_id
      AND channel_relations.kind IN ('delegate','handoff')
      AND channel_relations.target_task_id = NEW.source_task_id
      AND channel_relations.root_relation_id = NEW.root_relation_id
      AND channel_relations.depth + 1 = NEW.depth
  ) THEN RAISE(ABORT, 'invalid collaboration parent') END;
END;

CREATE TRIGGER channel_relations_integrity_update
BEFORE UPDATE OF source_task_id, source_run_id, user_id, parent_relation_id,
  root_relation_id, depth,
  target_task_id, target_event_id, return_event_id
ON channel_relations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM runs
    INNER JOIN tasks ON tasks.id = runs.task_id
    WHERE runs.id = NEW.source_run_id
      AND runs.task_id = NEW.source_task_id
      AND tasks.user_id = NEW.user_id
  ) THEN RAISE(ABORT, 'invalid collaboration source') END;
  SELECT CASE WHEN NEW.target_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks
    WHERE tasks.id = NEW.target_task_id AND tasks.user_id = NEW.user_id
  ) THEN RAISE(ABORT, 'invalid collaboration target') END;
  SELECT CASE WHEN NEW.kind <> 'handback' AND NEW.target_task_id IS NULL
    THEN RAISE(ABORT, 'invalid collaboration target shape') END;
  SELECT CASE WHEN NEW.target_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM inbox_events
    WHERE inbox_events.id = NEW.target_event_id
      AND inbox_events.user_id = NEW.user_id
      AND inbox_events.source = 'collaboration'
      AND inbox_events.type = CASE NEW.kind
        WHEN 'delegate' THEN 'collaboration.delegated'
        WHEN 'handoff' THEN 'collaboration.handed_off'
        WHEN 'context_note' THEN 'collaboration.context_note'
        ELSE 'collaboration.handback'
      END
      AND json_valid(inbox_events.payload_json)
      AND json_extract(inbox_events.payload_json, '$.relationId') = NEW.id
      AND json_extract(inbox_events.payload_json, '$.sourceTaskId') = NEW.source_task_id
      AND (
        NEW.kind = 'handback' OR
        json_extract(inbox_events.payload_json, '$.taskId') = NEW.target_task_id
      )
      AND (
        NEW.target_task_id IS NULL OR EXISTS (
          SELECT 1 FROM task_events
          WHERE task_events.event_id = inbox_events.id
            AND task_events.task_id = NEW.target_task_id
        )
      )
  ) THEN RAISE(ABORT, 'invalid collaboration event') END;
  SELECT CASE WHEN NEW.return_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM inbox_events
    WHERE inbox_events.id = NEW.return_event_id
      AND inbox_events.user_id = NEW.user_id
      AND inbox_events.source = 'collaboration'
      AND inbox_events.type IN (
        'collaboration.returned', 'collaboration.completed',
        'collaboration.failed'
      )
      AND json_valid(inbox_events.payload_json)
      AND json_extract(inbox_events.payload_json, '$.relationId') = NEW.id
      AND json_extract(inbox_events.payload_json, '$.sourceTaskId') = NEW.source_task_id
      AND EXISTS (
        SELECT 1 FROM task_events
        WHERE task_events.event_id = inbox_events.id
          AND task_events.task_id = NEW.source_task_id
      )
  ) THEN RAISE(ABORT, 'invalid collaboration return event') END;
  SELECT CASE WHEN NEW.parent_relation_id IS NULL AND
    (NEW.depth <> 0 OR NEW.root_relation_id <> NEW.id)
    THEN RAISE(ABORT, 'invalid collaboration root') END;
  SELECT CASE WHEN NEW.depth > ${String(maximumCollaborationDepth)}
    THEN RAISE(ABORT, 'invalid collaboration depth') END;
  SELECT CASE WHEN NEW.parent_relation_id IS NULL AND EXISTS (
    SELECT 1 FROM channel_relations
    WHERE channel_relations.target_task_id = NEW.source_task_id
      AND channel_relations.kind IN ('delegate','handoff')
  ) THEN RAISE(ABORT, 'missing collaboration parent') END;
  SELECT CASE WHEN NEW.parent_relation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM channel_relations
    WHERE channel_relations.id = NEW.parent_relation_id
      AND channel_relations.user_id = NEW.user_id
      AND channel_relations.kind IN ('delegate','handoff')
      AND channel_relations.target_task_id = NEW.source_task_id
      AND channel_relations.root_relation_id = NEW.root_relation_id
      AND channel_relations.depth + 1 = NEW.depth
  ) THEN RAISE(ABORT, 'invalid collaboration parent') END;
END;

CREATE TRIGGER channel_relations_provenance_immutable
BEFORE UPDATE OF id, command_id, command_fingerprint, request_claim_hash,
  creation_response_json, user_id, kind, source_task_id, source_run_id,
  parent_relation_id, root_relation_id, depth, target_event_id, request_json,
  created_at
ON channel_relations
WHEN OLD.id IS NOT NEW.id
  OR OLD.command_id IS NOT NEW.command_id
  OR OLD.command_fingerprint IS NOT NEW.command_fingerprint
  OR OLD.request_claim_hash IS NOT NEW.request_claim_hash
  OR OLD.creation_response_json IS NOT NEW.creation_response_json
  OR OLD.user_id IS NOT NEW.user_id
  OR OLD.kind IS NOT NEW.kind
  OR OLD.source_task_id IS NOT NEW.source_task_id
  OR OLD.source_run_id IS NOT NEW.source_run_id
  OR OLD.parent_relation_id IS NOT NEW.parent_relation_id
  OR OLD.root_relation_id IS NOT NEW.root_relation_id
  OR OLD.depth IS NOT NEW.depth
  OR OLD.target_event_id IS NOT NEW.target_event_id
  OR OLD.request_json IS NOT NEW.request_json
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable collaboration provenance');
END;

CREATE TRIGGER channel_relations_endpoint_guard
BEFORE UPDATE OF target_task_id, return_event_id ON channel_relations
WHEN (
  OLD.kind <> 'handback' AND OLD.target_task_id IS NOT NEW.target_task_id
) OR (
  OLD.kind = 'handback' AND OLD.target_task_id IS NOT NULL
  AND OLD.target_task_id IS NOT NEW.target_task_id
) OR (
  OLD.return_event_id IS NOT NULL
  AND OLD.return_event_id IS NOT NEW.return_event_id
)
BEGIN
  SELECT RAISE(ABORT, 'immutable collaboration endpoint');
END;

CREATE TRIGGER channel_relation_events_immutable
BEFORE UPDATE OF user_id, type, source, dedupe_key, payload_json,
  required_contract_version, authenticated_actor
ON inbox_events
WHEN EXISTS (
  SELECT 1 FROM channel_relations
  WHERE target_event_id = OLD.id OR return_event_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'immutable collaboration event');
END;

CREATE TRIGGER channel_relation_task_event_immutable
BEFORE UPDATE OF event_id, task_id, relation ON task_events
WHEN EXISTS (
  SELECT 1 FROM channel_relations
  WHERE target_event_id = OLD.event_id OR return_event_id = OLD.event_id
)
AND (
  OLD.event_id IS NOT NEW.event_id
  OR OLD.task_id IS NOT NEW.task_id
  OR OLD.relation IS NOT NEW.relation
)
BEGIN
  SELECT RAISE(ABORT, 'immutable collaboration task event');
END;

CREATE TRIGGER channel_relation_task_event_delete_guard
BEFORE DELETE ON task_events
WHEN EXISTS (
  SELECT 1 FROM channel_relations
  WHERE target_event_id = OLD.event_id OR return_event_id = OLD.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'immutable collaboration task event');
END;
`

interface InboxRow {
  id: string
  user_id: string
  type: string
  source: string
  authenticated_actor: 'human' | null
  device_id: string | null
  dedupe_key: string | null
  payload_json: string
  status: InboxEvent['status']
  attempts: number
  claimed_by: string | null
  lease_until: string | null
  created_at: string
  processed_at: string | null
  last_error: string | null
  required_contract_version: number
  claimed_contract_version: number | null
}

interface EventAttachmentRow {
  id: string
  user_id: string
  event_id: string
  file_name: string
  media_type: string
  byte_size: number
  sha256: string
  storage_path: string
  created_at: string
}

interface TaskRow {
  id: string
  user_id: string
  origin_event_id: string
  title: string
  goal: string
  status: Task['status']
  worker_icon_id: string | null
  status_reason: string | null
  target_resource?: string | null
  mandate_json: string | null
  ended_json: string | null
  created_at: string
  updated_at: string
}

interface AutomationRow {
  id: string
  user_id: string
  revision: number
  title: string
  prompt: string
  schedule_json: string
  target_json: string
  status: AutomationStatus
  next_fire_at: string | null
  last_fired_at: string | null
  created_at: string
  updated_at: string
}

interface AutomationInvocationRow {
  id: string
  automation_id: string
  user_id: string
  scheduled_for: string
  event_id: string
  status: AutomationInvocationStatus
  attempts: number
  last_error: string | null
  created_at: string
  updated_at: string
}

interface MemoryRow {
  id: string
  user_id: string
  scope: MemoryScope
  scope_task_id: string | null
  category: MemoryCategory
  content: string
  source_kind: MemorySource['kind']
  source_id: string | null
  revision: number
  created_at: string
  updated_at: string
  last_used_at: string | null
}

interface MemoryCommandRow {
  fingerprint: string
  operation: 'create' | 'update' | 'delete'
  memory_id: string
  response_json: string
}

interface ChannelRelationRow {
  id: string
  command_id: string
  command_fingerprint: string
  request_claim_hash: string
  creation_response_json: string
  user_id: string
  kind: CollaborationKind
  status: CollaborationStatus
  source_task_id: string
  source_run_id: string
  parent_relation_id: string | null
  root_relation_id: string
  depth: number
  target_task_id: string | null
  target_event_id: string | null
  return_event_id: string | null
  request_json: string
  result_json: string | null
  created_at: string
  updated_at: string
  settled_at: string | null
}

interface RunRow {
  id: string
  retry_of_run_id: string | null
  steering_of_run_id?: string | null
  steering_json?: string | null
  task_id: string
  origin_event_id: string | null
  executor: string
  executor_ref: string | null
  resume_from_ref: string | null
  goal_revision: number | null
  claim_token_hash: string | null
  status: Run['status']
  input_json: string
  output_json: string | null
  attempts: number
  claimed_by: string | null
  lease_until: string | null
  last_error: string | null
  execution_context_json: string | null
  execution_contract_version: number
  claimed_contract_version: number | null
  created_at: string
  updated_at: string
}

interface ActionRow {
  id: string
  task_id: string
  run_id: string
  resume_run_id: string | null
  kind: string
  risk: DurableAction['risk']
  idempotency_key: string
  status: DurableAction['status']
  request_json: string
  recovery_point_json: string
  result_json: string | null
  request_claim_hash: string | null
  request_fingerprint: string | null
  created_at: string
  updated_at: string
}

interface ActionReconciliationRow {
  id: string
  action_id: string
  command_id: string
  resolution: 'succeeded' | 'failed'
  note: string
  previous_status: 'failed' | 'unknown'
  previous_result_json: string | null
  request_fingerprint: string
  reconciled_by: string
  created_at: string
}

interface ApprovalRow {
  id: string
  user_id: string | null
  task_id: string
  action_id: string
  status: Approval['status']
  prompt_json: string
  created_at: string
  resolved_at: string | null
}

interface ApprovalDecisionRow {
  id: string
  approval_id: string
  event_id: string
  command_id: string
  user_id: string
  option_id: string
  kind: ApprovalDecision['kind']
  rationale: string | null
  decided_at: string
  applied_at: string | null
}

interface ApprovalProjectionRow extends ApprovalRow {
  request_run_id: string
  decision_id: string | null
  decision_event_id: string | null
  decision_command_id: string | null
  decision_user_id: string | null
  decision_option_id: string | null
  decision_kind: ApprovalDecision['kind'] | null
  decision_rationale: string | null
  decision_decided_at: string | null
  decision_applied_at: string | null
}

interface GoalContractRow {
  id: string
  task_id: string
  revision: number
  command_id: string
  based_on_event_ids_json: string
  desired_outcome: string
  contract_json: string
  created_at: string
}

interface TaskArtifactRow {
  id: string
  task_id: string
  run_id: string | null
  command_id: string
  name: string
  kind: TaskArtifact['kind']
  mime_type: string | null
  uri: string | null
  revision: string
  content_hash: string
  size_bytes: number | null
  metadata_json: string
  sensitivity: string
  created_at: string
}

interface EvidenceRefRow {
  id: string
  task_id: string
  run_id: string
  command_id: string
  source_key: string
  goal_revision: number
  criterion_id: string
  kind: string
  artifact_id: string | null
  external_ref: string | null
  producer_identity: string
  capture_mechanism: string
  trust_class: string
  content_hash: string
  artifact_revision: string | null
  observation_snapshot_json: string | null
  verification_json: string
  captured_at: string
  environment_json: string
  presentation_json: string
  sensitivity: string
  limitations_json: string
}

interface EvidenceVerificationEventRow {
  id: string
  evidence_id: string
  command_id: string
  verification_json: string
  created_at: string
}

interface ReviewPackRow {
  id: string
  revision: number
  task_id: string
  run_id: string
  goal_revision: number
  basis_event_ids_json: string
  projection_as_of: string
  final_outcome: ReviewPack['finalOutcome']
  criteria_json: string
  side_effects_json: string
  remaining_risks_json: string
  rollback_json: string | null
  audit_link: string
  created_at: string
}

interface WorkerReportRow {
  id: string
  task_id: string
  run_id: string
  worker_id: string
  claim_token_hash: string | null
  goal_revision: number
  report_sequence: number
  status: WorkerReport['status']
  evidence_ref_ids_json: string
  summary: string
  limitations_json: string
  remaining_risks_json: string
  rollback_json: string | null
  review_pack_id: string | null
  created_at: string
}

interface CursorPage<T> {
  items: T[]
  nextCursor?: string
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
  read_at: string | null
}

interface ModelUsageRow {
  run_id: string
  task_id: string
  user_id: string
  worker_icon_id: string | null
  executor: string
  model_ref: string | null
  completeness: ModelUsageRecord['completeness'] | null
  token_source: ModelUsageRecord['tokenSource'] | null
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  reasoning_tokens: number | null
  reported_steps: number | null
  unreported_steps: number | null
  duration_ms: number | null
  latency_source: ModelUsageRecord['latencySource'] | null
  cost_usd: number | null
  cost_source: ModelUsageRecord['costSource'] | null
  observed_at: string | null
  run_updated_at: string
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

interface WorkerProfileRow {
  id: string
  task_id: string
  revision: number
  model_mode: WorkerProfile['modelMode']
  model_provider: string | null
  model_name: string | null
  created_at: string
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

export interface SpeechConnectionWrite extends SpeechConnection {
  clearApiKey?: boolean
}

export interface RewriteConnectionWrite extends RewriteConnection {
  clearApiKey?: boolean
}

export class SettingsRevisionConflictError extends Error {
  constructor() {
    super('设置已在其他设备更新，请刷新后重试')
  }
}

export class WorkerProfileRevisionConflictError extends Error {
  constructor() {
    super('事情执行设置已在其他设备更新，请刷新后重试')
  }
}

export class WorkerProfileReadOnlyError extends Error {
  constructor() {
    super('Stopped Task execution settings are read-only')
  }
}

export class RunClaimError extends Error {}

export class EventAttachmentConflictError extends Error {}

export class EventAttachmentsUnsupportedError extends Error {}

export class CollaborationCommandConflictError extends Error {}

export class CollaborationFanoutLimitError extends Error {}

export class CollaborationTargetUnavailableError extends Error {
  constructor() {
    super('Collaboration target is unavailable')
  }
}

export class CollaborationBudgetLimitError extends Error {}

export class CollaborationActionPendingError extends Error {}

export class CollaborationReconciliationRequiredError extends Error {}

export class AutomationCommandConflictError extends Error {}

export class AutomationRevisionConflictError extends Error {}

export class AutomationReadOnlyError extends Error {}

export class AutomationNotFoundError extends Error {}

export class AutomationTargetUnavailableError extends Error {}

export class MemoryCommandConflictError extends Error {}

export class GoalProposalCommandConflictError extends Error {}

export class ActionNotFoundError extends Error {}

export class ActionReconciliationConflictError extends Error {}

export class MemoryRevisionConflictError extends Error {}

export class MemoryNotFoundError extends Error {}

export class MemorySourceUnavailableError extends Error {}

export class MemoryTargetUnavailableError extends Error {}

export class MemoryLimitError extends Error {}

export class TaskActionBlockedError extends Error {
  readonly taskId: string
  readonly actionStatus: string

  constructor(taskId: string, actionStatus: string) {
    super(`Task cannot continue while Action status is ${actionStatus}`)
    this.taskId = taskId
    this.actionStatus = actionStatus
  }
}

export class PegasStore {
  readonly #database: DatabaseSync
  readonly #clock: Clock
  readonly #attachmentRoot: string | undefined

  constructor(path: string, options: { clock?: Clock } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#clock = options.clock ?? systemClock
    this.#attachmentRoot =
      path === ':memory:' ? undefined : resolve(dirname(path), 'attachments')
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
    this.#migrate(8, migration8)
    this.#migrate(9, migration9)
    this.#migrate(10, migration10)
    this.#migrate(11, migration11)
    this.#backfillWorkerIconIds()
    this.#migrate(12, migration12)
    this.#migrate(13, migration13)
    this.#migrate(14, migration14)
    this.#migrate(15, migration15)
    this.#migrate(16, migration16)
    this.#migrate(17, migration17)
    this.#migrate(18, migration18)
    this.#migrate(19, migration19)
    this.#migrate(20, migration20)
    this.#migrate(21, migration21)
    this.#migrate(22, migration22)
    this.#migrate(23, migration23)
    this.#migrate(24, migration24)
    this.#migrate(25, migration25)
    this.#migrate(26, migration26)
  }

  #backfillWorkerIconIds(): void {
    const rows = this.#database
      .prepare('SELECT id FROM tasks WHERE worker_icon_id IS NULL')
      .all() as { id: string }[]
    const update = this.#database.prepare(
      'UPDATE tasks SET worker_icon_id = ? WHERE id = ? AND worker_icon_id IS NULL',
    )
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) update.run(assignWorkerIconId(row.id), row.id)
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
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

  getWorkerProfile(taskId: string, userId: string): WorkerProfile {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    return this.#workerProfileByTaskId(taskId)
  }

  getEffectiveWorkerProfile(
    taskId: string,
    userId: string,
  ): EffectiveWorkerProfile {
    return effectiveWorkerProfile(
      this.getWorkerProfile(taskId, userId),
      this.getRuntimeSettings(),
    )
  }

  resolveWorkerExecutionContext(
    taskId: string,
    userId: string,
    base: Omit<
      ExecutionContext,
      | 'model'
      | 'settingsRevision'
      | 'workerProfile'
      | 'workerProfileRevision'
      | 'workerProfileSource'
    >,
  ): ExecutionContext {
    const settings = this.getRuntimeSettings()
    return workerExecutionContext(
      effectiveWorkerProfile(this.getWorkerProfile(taskId, userId), settings),
      base,
      settings.revision,
    )
  }

  updateWorkerProfile(
    taskId: string,
    userId: string,
    update: WorkerProfileUpdate,
  ): WorkerProfile {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const task = this.#taskById(taskId)
      if (task.userId !== userId)
        throw new Error('Task belongs to another user')
      const fingerprint = workerProfileFingerprint(update)
      const replay = this.#workerProfileCommandReplay(update.commandId)
      if (replay) {
        if (replay.task_id !== taskId || replay.fingerprint !== fingerprint)
          throw new Error('Worker Profile command ID is already used')
        const response = JSON.parse(replay.response_json) as WorkerProfile
        this.#database.exec('COMMIT')
        return response
      }
      if (task.status === 'cancelled') throw new WorkerProfileReadOnlyError()
      const current = this.#workerProfileByTaskId(taskId)
      if (current.revision !== update.expectedRevision)
        throw new WorkerProfileRevisionConflictError()
      const unchanged =
        current.modelMode === update.modelMode &&
        current.modelProvider === update.modelProvider &&
        current.modelName === update.modelName
      const now = this.#clock.now().toISOString()
      if (!unchanged) {
        this.#database
          .prepare(
            `UPDATE worker_profiles
             SET revision = revision + 1, model_mode = ?, model_provider = ?,
                 model_name = ?, updated_at = ?
             WHERE task_id = ? AND revision = ?`,
          )
          .run(
            update.modelMode,
            update.modelProvider ?? null,
            update.modelName ?? null,
            now,
            taskId,
            update.expectedRevision,
          )
      }
      const profile = this.#workerProfileByTaskId(taskId)
      this.#database
        .prepare(
          `INSERT INTO worker_profile_commands
            (command_id, task_id, fingerprint, response_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          update.commandId,
          taskId,
          fingerprint,
          JSON.stringify(profile),
          now,
        )
      this.#database
        .prepare(
          `DELETE FROM worker_profile_commands
           WHERE task_id = ? AND rowid NOT IN (
             SELECT rowid FROM worker_profile_commands
             WHERE task_id = ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?
           )`,
        )
        .run(taskId, taskId, workerProfileCommandRetention)
      this.#database.exec('COMMIT')
      return profile
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  replayWorkerProfileUpdate(
    taskId: string,
    userId: string,
    update: WorkerProfileUpdate,
  ): WorkerProfile | undefined {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const replay = this.#workerProfileCommandReplay(update.commandId)
    if (!replay) return undefined
    if (
      replay.task_id !== taskId ||
      replay.fingerprint !== workerProfileFingerprint(update)
    )
      throw new Error('Worker Profile command ID is already used')
    return JSON.parse(replay.response_json) as WorkerProfile
  }

  createCollaboration(
    runId: string,
    claimToken: string,
    request: WorkerCollaborationRequest,
  ): ChannelRelation {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const fingerprint = collaborationRequestFingerprint(request)
      const suppliedClaimHash = hashClaimToken(claimToken)
      const replay = this.#database
        .prepare(
          `SELECT * FROM channel_relations
           WHERE source_run_id = ? AND command_id = ?`,
        )
        .get(runId, request.commandId) as unknown as
        ChannelRelationRow | undefined
      if (replay) {
        if (!safeDigestEqual(suppliedClaimHash, replay.request_claim_hash)) {
          throw new RunClaimError('Run claim capability is invalid or expired')
        }
        if (replay.command_fingerprint !== fingerprint) {
          throw new CollaborationCommandConflictError(
            'Collaboration command ID is already used',
          )
        }
        this.#database.exec('COMMIT')
        return JSON.parse(replay.creation_response_json) as ChannelRelation
      }

      const run = this.#runById(runId)
      if (run.status !== 'running') {
        throw new RunClaimError('Collaboration requires a running Run')
      }
      const claim = this.#claimForCapability(runId, claimToken)
      if (run.claimedBy !== claim.workerId) {
        throw new RunClaimError('Run claim capability is invalid or expired')
      }
      const source = this.#taskById(run.taskId)
      if (source.status === 'completed' || source.status === 'cancelled') {
        throw new Error('Closed Task cannot create collaboration')
      }
      const latest = this.#database
        .prepare(
          `SELECT id FROM runs WHERE task_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(source.id) as { id: string } | undefined
      if (latest?.id !== runId) {
        throw new Error('Only the latest Run can create collaboration')
      }
      const blockingAction = this.#database
        .prepare(
          `SELECT status FROM actions
           WHERE resume_run_id = ? AND protocol_version = 1
             AND status IN ('authorized','failed','unknown')
           ORDER BY CASE status
             WHEN 'unknown' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END
           LIMIT 1`,
        )
        .get(runId) as { status: string } | undefined
      if (blockingAction?.status === 'authorized') {
        throw new CollaborationActionPendingError(
          'Record the authorized Action outcome before collaborating',
        )
      }
      if (blockingAction) {
        throw new CollaborationReconciliationRequiredError(
          'Reconcile the failed or unknown Action before collaborating',
        )
      }
      const confirmedFailedAction = this.#database
        .prepare(
          `SELECT 1 FROM action_reconciliations
           INNER JOIN actions ON actions.id = action_reconciliations.action_id
           WHERE actions.task_id = ?
             AND action_reconciliations.resolution = 'failed'
           LIMIT 1`,
        )
        .get(source.id)
      if (confirmedFailedAction) {
        throw new CollaborationReconciliationRequiredError(
          'A human-confirmed failed Action blocks collaboration on this Task',
        )
      }
      const references =
        request.kind === 'delegate' || request.kind === 'handoff'
          ? request.contextRefs
          : request.kind === 'context_note'
            ? request.sourceRefs
            : [request.inputEventId]
      this.#assertTaskReferences(source.id, references)

      const ownerActiveCount = (
        this.#database
          .prepare(
            `SELECT COUNT(*) AS count FROM channel_relations
             WHERE user_id = ? AND status IN ('pending','active')`,
          )
          .get(source.userId) as { count: number }
      ).count
      if (ownerActiveCount >= maximumActiveCollaborationsPerOwner) {
        throw new CollaborationBudgetLimitError(
          'Owner active collaboration budget reached',
        )
      }

      const sourceRunCount = (
        this.#database
          .prepare(
            'SELECT COUNT(*) AS count FROM channel_relations WHERE source_run_id = ?',
          )
          .get(runId) as { count: number }
      ).count
      if (sourceRunCount >= maximumCollaborationsPerRun) {
        throw new CollaborationBudgetLimitError(
          'Run collaboration budget reached',
        )
      }

      const parent = this.#database
        .prepare(
          `SELECT id, root_relation_id, depth FROM channel_relations
           WHERE target_task_id = ? AND user_id = ?
             AND kind IN ('delegate','handoff')
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(source.id, source.userId) as
        { id: string; root_relation_id: string; depth: number } | undefined
      const relationId = randomUUID()
      const rootRelationId = parent?.root_relation_id ?? relationId
      const depth = parent ? parent.depth + 1 : 0
      if (depth > maximumCollaborationDepth) {
        throw new CollaborationBudgetLimitError(
          'Collaboration depth limit reached',
        )
      }
      if (parent) {
        const rootCount = (
          this.#database
            .prepare(
              'SELECT COUNT(*) AS count FROM channel_relations WHERE root_relation_id = ?',
            )
            .get(rootRelationId) as { count: number }
        ).count
        if (rootCount >= maximumCollaborationsPerRoot) {
          throw new CollaborationBudgetLimitError(
            'Root collaboration budget reached',
          )
        }
      }

      if (request.kind === 'delegate' || request.kind === 'handoff') {
        const active = this.#database
          .prepare(
            `SELECT COUNT(*) AS count FROM channel_relations
             WHERE source_task_id = ? AND kind IN ('delegate','handoff')
               AND status IN ('pending','active')`,
          )
          .get(source.id) as { count: number }
        if (active.count >= maximumActiveChildCollaborations) {
          throw new CollaborationFanoutLimitError(
            'Active child collaboration limit reached',
          )
        }
      }

      const now = this.#clock.now().toISOString()
      let targetTaskId: string | undefined
      let targetEventId: string | undefined
      if (request.kind === 'delegate' || request.kind === 'handoff') {
        targetEventId = randomUUID()
        targetTaskId = randomUUID()
        const title = request.goal.replaceAll(/\s+/g, ' ').slice(0, 120)
        this.enqueueEvent({
          id: targetEventId,
          userId: source.userId,
          source: 'collaboration',
          type:
            request.kind === 'delegate'
              ? 'collaboration.delegated'
              : 'collaboration.handed_off',
          dedupeKey: `collaboration-target:${relationId}`,
          payload: {
            relationId,
            taskId: targetTaskId,
            sourceTaskId: source.id,
            text: request.goal,
            reason: request.reason,
            ...(request.kind === 'delegate'
              ? { expectedOutput: request.expectedOutput }
              : {}),
            contextRefs: request.contextRefs,
          },
        })
        this.#database
          .prepare(
            `INSERT INTO tasks
              (id, user_id, origin_event_id, title, goal, status, worker_icon_id,
               mandate_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'backlog', ?, ?, ?, ?)`,
          )
          .run(
            targetTaskId,
            source.userId,
            targetEventId,
            title,
            request.goal,
            assignWorkerIconId(targetTaskId),
            JSON.stringify(source.mandate),
            now,
            now,
          )
        this.#ensureWorkerProfile(targetTaskId, now)
        this.#database
          .prepare(
            `INSERT INTO task_events (event_id, task_id, relation, created_at)
             VALUES (?, ?, 'origin', ?)`,
          )
          .run(targetEventId, targetTaskId, now)
      } else if (request.kind === 'context_note') {
        if (request.targetChannelId === source.id) {
          throw new CollaborationTargetUnavailableError()
        }
        const targetRow = this.#database
          .prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?')
          .get(request.targetChannelId, source.userId) as
          (TaskRow & Record<string, unknown>) | undefined
        if (!targetRow) throw new CollaborationTargetUnavailableError()
        const target = toTask(targetRow)
        if (target.status === 'completed' || target.status === 'cancelled') {
          throw new CollaborationTargetUnavailableError()
        }
        const pendingNotes = (
          this.#database
            .prepare(
              `SELECT COUNT(*) AS count FROM channel_relations
               WHERE target_task_id = ?
                 AND kind = 'context_note' AND status IN ('pending','active')`,
            )
            .get(target.id) as { count: number }
        ).count
        if (pendingNotes >= maximumPendingContextNotesPerTarget) {
          throw new CollaborationBudgetLimitError(
            'Pending context note budget reached',
          )
        }
        targetTaskId = target.id
        targetEventId = randomUUID()
        this.enqueueEvent({
          id: targetEventId,
          userId: source.userId,
          source: 'collaboration',
          type: 'collaboration.context_note',
          dedupeKey: `collaboration-target:${relationId}`,
          payload: {
            relationId,
            taskId: target.id,
            sourceTaskId: source.id,
            text: request.text,
            sourceRefs: request.sourceRefs,
          },
        })
        this.#database
          .prepare(
            `INSERT INTO task_events (event_id, task_id, relation, created_at)
             VALUES (?, ?, 'context_note', ?)`,
          )
          .run(targetEventId, target.id, now)
      } else {
        const original = this.#database
          .prepare(
            `SELECT inbox_events.payload_json FROM task_events
             INNER JOIN inbox_events ON inbox_events.id = task_events.event_id
             WHERE task_events.task_id = ? AND task_events.event_id = ?
               AND inbox_events.type = 'user.message'
               AND inbox_events.authenticated_actor = 'human'`,
          )
          .get(source.id, request.inputEventId) as
          { payload_json: string } | undefined
        if (!original) throw new Error('Handback input does not belong to Task')
        const payload = JSON.parse(original.payload_json) as unknown
        const text =
          payload &&
          typeof payload === 'object' &&
          'text' in payload &&
          typeof payload.text === 'string'
            ? payload.text
            : undefined
        if (!text?.trim())
          throw new Error('Handback input has no routable text')
        targetEventId = randomUUID()
        this.enqueueEvent({
          id: targetEventId,
          userId: source.userId,
          source: 'collaboration',
          type: 'collaboration.handback',
          dedupeKey: `collaboration-target:${relationId}`,
          payload: {
            relationId,
            sourceTaskId: source.id,
            inputEventId: request.inputEventId,
            text: text.trim(),
            reason: request.reason,
          },
        })
      }

      const creationResponse: ChannelRelation = {
        id: relationId,
        commandId: request.commandId,
        userId: source.userId,
        kind: request.kind,
        status: 'pending',
        sourceTaskId: source.id,
        sourceRunId: run.id,
        ...(parent ? { parentRelationId: parent.id } : {}),
        rootRelationId,
        depth,
        ...(targetTaskId ? { targetTaskId } : {}),
        ...(targetEventId ? { targetEventId } : {}),
        request,
        createdAt: now,
        updatedAt: now,
      }
      this.#database
        .prepare(
          `INSERT INTO channel_relations
            (id, command_id, command_fingerprint, request_claim_hash,
             creation_response_json, user_id, kind, status, source_task_id,
             source_run_id, parent_relation_id, root_relation_id, depth,
             target_task_id, target_event_id, request_json, created_at,
             updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          relationId,
          request.commandId,
          fingerprint,
          claim.claimTokenHash,
          JSON.stringify(creationResponse),
          source.userId,
          request.kind,
          source.id,
          run.id,
          parent?.id ?? null,
          rootRelationId,
          depth,
          targetTaskId ?? null,
          targetEventId,
          JSON.stringify(request),
          now,
          now,
        )

      if (request.kind === 'delegate') {
        this.#database
          .prepare(
            `UPDATE runs SET status = 'waiting', claimed_by = NULL,
               lease_until = NULL, claim_token_hash = NULL,
               last_error = 'waiting_on_dependency', updated_at = ?
             WHERE id = ? AND status = 'running'`,
          )
          .run(now, run.id)
        this.#database
          .prepare(
            `UPDATE tasks SET status = 'started', status_reason = 'waiting_on_dependency',
               updated_at = ? WHERE id = ?`,
          )
          .run(now, source.id)
      } else if (request.kind === 'handoff') {
        const preservesInboundResponsibility = Boolean(
          this.#database
            .prepare(
              `SELECT 1 FROM channel_relations
               WHERE target_task_id = ? AND kind IN ('delegate','handoff')
                 AND status IN ('pending','active') LIMIT 1`,
            )
            .get(source.id),
        )
        const ended = {
          at: now,
          by: 'executor' as const,
          outcome: 'completed' as const,
          reason: request.reason,
        }
        this.#database
          .prepare(
            `UPDATE runs SET status = 'cancelled', claimed_by = NULL,
               lease_until = NULL, claim_token_hash = NULL,
               last_error = 'handed_off', updated_at = ?
             WHERE task_id = ? AND status IN ('queued','running','waiting')`,
          )
          .run(now, source.id)
        this.#database
          .prepare(
            `UPDATE tasks SET status = ?, status_reason = ?,
               ended_json = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            preservesInboundResponsibility ? 'started' : 'completed',
            preservesInboundResponsibility
              ? 'waiting_on_dependency'
              : 'handed_off',
            preservesInboundResponsibility ? null : JSON.stringify(ended),
            now,
            source.id,
          )
        this.enqueueOutbox({
          userId: source.userId,
          taskId: source.id,
          channel: 'conversation',
          dedupeKey: `collaboration-handed-off:${relationId}`,
          payload: {
            type: 'collaboration.handed_off',
            relationId,
            sourceTaskId: source.id,
            targetTaskId,
            text: request.reason,
          },
        })
      } else if (request.kind === 'handback') {
        this.#database
          .prepare(
            `UPDATE runs SET status = 'cancelled', claimed_by = NULL,
               lease_until = NULL, claim_token_hash = NULL,
               last_error = 'handed_back', updated_at = ?
             WHERE id = ? AND status = 'running'`,
          )
          .run(now, run.id)
        this.#database
          .prepare(
            `UPDATE tasks SET status = 'started', status_reason = 'handed_back',
               updated_at = ? WHERE id = ?`,
          )
          .run(now, source.id)
      }

      const relation = this.#relationById(relationId)
      this.#database.exec('COMMIT')
      return relation
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  listCollaborations(taskId: string, userId: string): ChannelRelation[] {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const rows = this.#database
      .prepare(
        `SELECT * FROM channel_relations
         WHERE user_id = ? AND (source_task_id = ? OR target_task_id = ?)
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(userId, taskId, taskId) as unknown as ChannelRelationRow[]
    return rows.map(toChannelRelation)
  }

  pageCollaborations(
    taskId: string,
    userId: string,
    limit: number,
    cursor?: string,
  ): CursorPage<ChannelRelation> {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const boundary = cursor
      ? (this.#database
          .prepare(
            `SELECT created_at, id FROM channel_relations
             WHERE id = ? AND user_id = ?
               AND (source_task_id = ? OR target_task_id = ?)`,
          )
          .get(cursor, userId, taskId, taskId) as
          { created_at: string; id: string } | undefined)
      : undefined
    if (cursor && !boundary) throw new Error('Pagination cursor is invalid')
    const sourceRows = this.#collaborationPageBranch(
      'source_task_id',
      userId,
      taskId,
      limit + 1,
      boundary,
    )
    const targetRows = this.#collaborationPageBranch(
      'target_task_id',
      userId,
      taskId,
      limit + 1,
      boundary,
    )
    const rows = [...sourceRows, ...targetRows]
      .sort((left, right) =>
        left.created_at === right.created_at
          ? right.id.localeCompare(left.id)
          : right.created_at.localeCompare(left.created_at),
      )
      .slice(0, limit + 1)
    return cursorPage(rows, limit, toChannelRelation)
  }

  listOpenTaskCandidates(
    userId: string,
    excludeTaskId: string,
    limit = 20,
  ): Task[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM tasks
         WHERE user_id = ? AND id <> ?
           AND status NOT IN ('completed','cancelled')
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(userId, excludeTaskId, limit) as unknown as TaskRow[]
    return rows.map(toTask)
  }

  listAutomations(userId: string): Automation[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM automations
         WHERE user_id = ?
         ORDER BY updated_at DESC, rowid DESC`,
      )
      .all(userId) as unknown as AutomationRow[]
    return rows.map(toAutomation)
  }

  findAutomation(automationId: string, userId: string): Automation | undefined {
    const row = this.#database
      .prepare('SELECT * FROM automations WHERE id = ? AND user_id = ?')
      .get(automationId, userId) as unknown as AutomationRow | undefined
    return row ? toAutomation(row) : undefined
  }

  createAutomation(command: AutomationCreateCommand): Automation {
    const now = this.#clock.now()
    const nowIso = now.toISOString()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const replay = this.#automationCommandReplay(
        command.userId,
        command.commandId,
        automationFingerprint({
          operation: 'create',
          automation: command.automation,
        }),
      )
      if (replay) {
        this.#database.exec('COMMIT')
        return replay
      }
      this.#assertAutomationTarget(command.userId, command.automation.target)
      const nextFireAt = firstAutomaticFireAt(command.automation.schedule, now)
      if (
        command.automation.schedule.kind === 'once' &&
        Date.parse(nextFireAt) <= now.getTime()
      ) {
        throw new Error('Once schedule must be in the future')
      }
      const id = randomUUID()
      this.#database
        .prepare(
          `INSERT INTO automations
            (id, user_id, revision, title, prompt, schedule_json, target_json,
             status, next_fire_at, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          id,
          command.userId,
          command.automation.title,
          command.automation.prompt,
          JSON.stringify(command.automation.schedule),
          JSON.stringify(command.automation.target),
          nextFireAt,
          nowIso,
          nowIso,
        )
      const automation = this.#automationById(id)
      this.#saveAutomationCommand(
        command.userId,
        command.commandId,
        automationFingerprint({
          operation: 'create',
          automation: command.automation,
        }),
        'create',
        automation,
        nowIso,
      )
      this.#database.exec('COMMIT')
      return automation
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  updateAutomation(
    automationId: string,
    command: AutomationUpdateCommand,
  ): Automation {
    const now = this.#clock.now()
    const nowIso = now.toISOString()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const fingerprint = automationFingerprint({
        operation: 'update',
        automationId,
        expectedRevision: command.expectedRevision,
        automation: command.automation,
      })
      const replay = this.#automationCommandReplay(
        command.userId,
        command.commandId,
        fingerprint,
      )
      if (replay) {
        this.#database.exec('COMMIT')
        return replay
      }
      const current = this.#automationByIdForUser(automationId, command.userId)
      this.#assertAutomationWritable(current)
      if (current.revision !== command.expectedRevision)
        throw new AutomationRevisionConflictError()
      this.#assertAutomationTarget(command.userId, command.automation.target)
      const nextFireAt = firstAutomaticFireAt(command.automation.schedule, now)
      if (
        command.automation.schedule.kind === 'once' &&
        Date.parse(nextFireAt) <= now.getTime()
      ) {
        throw new Error('Once schedule must be in the future')
      }
      const result = this.#database
        .prepare(
          `UPDATE automations
           SET revision = revision + 1, title = ?, prompt = ?,
               schedule_json = ?, target_json = ?, next_fire_at = ?,
               updated_at = ?
           WHERE id = ? AND user_id = ? AND revision = ?`,
        )
        .run(
          command.automation.title,
          command.automation.prompt,
          JSON.stringify(command.automation.schedule),
          JSON.stringify(command.automation.target),
          nextFireAt,
          nowIso,
          automationId,
          command.userId,
          command.expectedRevision,
        )
      if (result.changes !== 1) throw new AutomationRevisionConflictError()
      const automation = this.#automationById(automationId)
      this.#saveAutomationCommand(
        command.userId,
        command.commandId,
        fingerprint,
        'update',
        automation,
        nowIso,
      )
      this.#database.exec('COMMIT')
      return automation
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  pauseAutomation(
    automationId: string,
    command: AutomationStatusCommand,
  ): Automation {
    return this.#transitionAutomation(automationId, command, 'pause')
  }

  resumeAutomation(
    automationId: string,
    command: AutomationStatusCommand,
  ): Automation {
    return this.#transitionAutomation(automationId, command, 'resume')
  }

  cancelAutomation(
    automationId: string,
    command: AutomationStatusCommand,
  ): Automation {
    return this.#transitionAutomation(automationId, command, 'cancel')
  }

  listAutomationInvocations(
    automationId: string,
    userId: string,
    limit = 100,
  ): AutomationInvocation[] {
    this.#automationByIdForUser(automationId, userId)
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200)
      throw new Error('Invocation limit must be between 1 and 200')
    const rows = this.#database
      .prepare(
        `SELECT * FROM automation_invocations
         WHERE automation_id = ? AND user_id = ?
         ORDER BY scheduled_for DESC, rowid DESC LIMIT ?`,
      )
      .all(automationId, userId, limit) as unknown as AutomationInvocationRow[]
    return rows.map(toAutomationInvocation)
  }

  automationInvocationForEvent(
    eventId: string,
    userId: string,
  ): AutomationInvocation | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM automation_invocations
         WHERE event_id = ? AND user_id = ?`,
      )
      .get(eventId, userId) as unknown as AutomationInvocationRow | undefined
    return row ? toAutomationInvocation(row) : undefined
  }

  fireDueAutomations(
    limit = 100,
  ): { automation: Automation; invocation: AutomationInvocation }[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000)
      throw new Error('Scheduler batch size must be between 1 and 1000')
    const now = this.#clock.now()
    const nowIso = now.toISOString()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const rows = this.#database
        .prepare(
          `SELECT * FROM automations
           WHERE status = 'active' AND next_fire_at IS NOT NULL
             AND next_fire_at <= ?
           ORDER BY next_fire_at ASC, rowid ASC LIMIT ?`,
        )
        .all(nowIso, limit) as unknown as AutomationRow[]
      const fired: {
        automation: Automation
        invocation: AutomationInvocation
      }[] = []
      for (const row of rows) {
        const scheduledFor = row.next_fire_at
        if (!scheduledFor) continue
        const schedule = JSON.parse(row.schedule_json) as AutomationSchedule
        const target = JSON.parse(row.target_json) as AutomationTarget
        const invocationId = randomUUID()
        const eventId = randomUUID()
        this.enqueueEvent({
          id: eventId,
          userId: row.user_id,
          type: 'automation.due',
          source: 'automation',
          dedupeKey: `automation:${row.id}:${scheduledFor}`,
          payload: {
            automationId: row.id,
            invocationId,
            scheduledFor,
            title: row.title,
            prompt: row.prompt,
            target,
          },
        })
        this.#database
          .prepare(
            `INSERT INTO automation_invocations
              (id, automation_id, user_id, scheduled_for, event_id, status,
               attempts, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
          )
          .run(
            invocationId,
            row.id,
            row.user_id,
            scheduledFor,
            eventId,
            nowIso,
            nowIso,
          )
        const nextFireAt =
          schedule.kind === 'once'
            ? null
            : nextIntervalFireAt(schedule, scheduledFor, now)
        const nextStatus = schedule.kind === 'once' ? 'completed' : 'active'
        const update = this.#database
          .prepare(
            `UPDATE automations
             SET status = ?, next_fire_at = ?, last_fired_at = ?,
                 updated_at = ?
             WHERE id = ? AND user_id = ? AND status = 'active'
               AND next_fire_at = ?`,
          )
          .run(
            nextStatus,
            nextFireAt,
            scheduledFor,
            nowIso,
            row.id,
            row.user_id,
            scheduledFor,
          )
        if (update.changes !== 1)
          throw new Error('Automation changed during dispatch')
        const automation = this.#automationById(row.id)
        const invocation = this.#automationInvocationById(invocationId)
        fired.push({ automation, invocation })
      }
      this.#database.exec('COMMIT')
      return fired
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #transitionAutomation(
    automationId: string,
    command: AutomationStatusCommand,
    operation: 'pause' | 'resume' | 'cancel',
  ): Automation {
    const now = this.#clock.now()
    const nowIso = now.toISOString()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const fingerprint = automationFingerprint({
        operation,
        automationId,
        expectedRevision: command.expectedRevision,
      })
      const replay = this.#automationCommandReplay(
        command.userId,
        command.commandId,
        fingerprint,
      )
      if (replay) {
        this.#database.exec('COMMIT')
        return replay
      }
      const current = this.#automationByIdForUser(automationId, command.userId)
      if (current.revision !== command.expectedRevision)
        throw new AutomationRevisionConflictError()
      this.#assertAutomationWritable(current)
      let status: AutomationStatus
      let nextFireAt: string | null
      if (operation === 'pause') {
        if (current.status !== 'active') throw new AutomationReadOnlyError()
        status = 'paused'
        nextFireAt = null
      } else if (operation === 'resume') {
        if (current.status !== 'paused') throw new AutomationReadOnlyError()
        status = 'active'
        nextFireAt = resumedFireAt(current.schedule, now)
      } else {
        status = 'cancelled'
        nextFireAt = null
      }
      const result = this.#database
        .prepare(
          `UPDATE automations
           SET revision = revision + 1, status = ?, next_fire_at = ?,
               updated_at = ?
           WHERE id = ? AND user_id = ? AND revision = ?`,
        )
        .run(
          status,
          nextFireAt,
          nowIso,
          automationId,
          command.userId,
          command.expectedRevision,
        )
      if (result.changes !== 1) throw new AutomationRevisionConflictError()
      const automation = this.#automationById(automationId)
      this.#saveAutomationCommand(
        command.userId,
        command.commandId,
        fingerprint,
        operation,
        automation,
        nowIso,
      )
      this.#database.exec('COMMIT')
      return automation
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #assertAutomationTarget(userId: string, target: AutomationTarget): void {
    if (target.kind === 'new_task') return
    const task = this.findTask(target.taskId, userId)
    if (!task || task.status === 'completed' || task.status === 'cancelled') {
      throw new AutomationTargetUnavailableError()
    }
  }

  #assertAutomationWritable(automation: Automation): void {
    if (automation.status === 'cancelled' || automation.status === 'completed')
      throw new AutomationReadOnlyError()
  }

  #automationCommandReplay(
    userId: string,
    commandId: string,
    fingerprint: string,
  ): Automation | undefined {
    const row = this.#database
      .prepare(
        `SELECT fingerprint, response_json FROM automation_commands
         WHERE user_id = ? AND command_id = ?`,
      )
      .get(userId, commandId) as
      { fingerprint: string; response_json: string } | undefined
    if (!row) return undefined
    if (row.fingerprint !== fingerprint)
      throw new AutomationCommandConflictError()
    return JSON.parse(row.response_json) as Automation
  }

  #saveAutomationCommand(
    userId: string,
    commandId: string,
    fingerprint: string,
    operation: string,
    automation: Automation,
    createdAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO automation_commands
          (user_id, command_id, fingerprint, operation, automation_id,
           response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        commandId,
        fingerprint,
        operation,
        automation.id,
        JSON.stringify(automation),
        createdAt,
      )
  }

  #automationById(automationId: string): Automation {
    const row = this.#database
      .prepare('SELECT * FROM automations WHERE id = ?')
      .get(automationId) as unknown as AutomationRow | undefined
    if (!row) throw new Error(`Automation ${automationId} does not exist`)
    return toAutomation(row)
  }

  #automationByIdForUser(automationId: string, userId: string): Automation {
    const row = this.#database
      .prepare('SELECT * FROM automations WHERE id = ? AND user_id = ?')
      .get(automationId, userId) as unknown as AutomationRow | undefined
    if (!row) throw new AutomationNotFoundError()
    return toAutomation(row)
  }

  #automationInvocationById(invocationId: string): AutomationInvocation {
    const row = this.#database
      .prepare('SELECT * FROM automation_invocations WHERE id = ?')
      .get(invocationId) as unknown as AutomationInvocationRow | undefined
    if (!row)
      throw new Error(`Automation invocation ${invocationId} does not exist`)
    return toAutomationInvocation(row)
  }

  listMemories(
    userId: string,
    limit = 50,
    cursor?: string,
    options: MemoryListOptions = {},
  ): CursorPage<MemoryRecord> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200)
      throw new Error('Memory limit must be between 1 and 200')
    const cursorRow = cursor
      ? (this.#database
          .prepare('SELECT rowid FROM memories WHERE id = ? AND user_id = ?')
          .get(cursor, userId) as { rowid: number } | undefined)
      : undefined
    if (cursor && !cursorRow) throw new Error('Memory cursor is invalid')
    const rows = this.#database
      .prepare(
        `SELECT * FROM memories
         WHERE user_id = ?
           AND (? IS NULL OR scope = ?)
           AND (? IS NULL OR scope_task_id = ?)
           AND (? IS NULL OR category = ?)
           AND (? IS NULL OR rowid < ?)
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(
        userId,
        options.scope ?? null,
        options.scope ?? null,
        options.taskId ?? null,
        options.taskId ?? null,
        options.category ?? null,
        options.category ?? null,
        cursorRow?.rowid ?? null,
        cursorRow?.rowid ?? null,
        limit + 1,
      ) as unknown as MemoryRow[]
    return cursorPage(rows, limit, toMemoryRecord)
  }

  findMemory(memoryId: string, userId: string): MemoryRecord | undefined {
    const row = this.#database
      .prepare('SELECT * FROM memories WHERE id = ? AND user_id = ?')
      .get(memoryId, userId) as unknown as MemoryRow | undefined
    return row ? toMemoryRecord(row) : undefined
  }

  createMemory(command: MemoryCreateCommand): MemoryRecord {
    const nowIso = this.#clock.now().toISOString()
    const fingerprint = memoryFingerprint({
      operation: 'create',
      memory: command.memory,
    })
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const replay = this.#memoryCommandReplay(
        command.userId,
        command.commandId,
        'create',
        fingerprint,
      )
      if (replay) {
        this.#database.exec('COMMIT')
        return JSON.parse(replay.response_json) as MemoryRecord
      }
      this.#assertMemoryDraft(command.userId, command.memory)
      const count = this.#database
        .prepare('SELECT COUNT(*) AS count FROM memories WHERE user_id = ?')
        .get(command.userId) as { count: number }
      if (count.count >= 500) throw new MemoryLimitError()
      const id = randomUUID()
      this.#database
        .prepare(
          `INSERT INTO memories
            (id, user_id, scope, scope_task_id, category, content, source_kind,
             source_id, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          command.userId,
          command.memory.scope,
          command.memory.taskId ?? null,
          command.memory.category,
          command.memory.content,
          command.memory.source.kind,
          command.memory.source.kind === 'user_confirmation'
            ? null
            : command.memory.source.id,
          nowIso,
          nowIso,
        )
      const memory = this.#memoryById(id)
      this.#saveMemoryCommand(
        command.userId,
        command.commandId,
        'create',
        fingerprint,
        memory.id,
        memory,
        nowIso,
      )
      this.#database.exec('COMMIT')
      return memory
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  updateMemory(memoryId: string, command: MemoryUpdateCommand): MemoryRecord {
    const nowIso = this.#clock.now().toISOString()
    const fingerprint = memoryFingerprint({
      operation: 'update',
      memoryId,
      expectedRevision: command.expectedRevision,
      memory: command.memory,
    })
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const replay = this.#memoryCommandReplay(
        command.userId,
        command.commandId,
        'update',
        fingerprint,
      )
      if (replay) {
        if (replay.memory_id !== memoryId)
          throw new MemoryCommandConflictError()
        this.#database.exec('COMMIT')
        return JSON.parse(replay.response_json) as MemoryRecord
      }
      const current = this.#memoryByIdForUser(memoryId, command.userId)
      if (current.revision !== command.expectedRevision)
        throw new MemoryRevisionConflictError()
      this.#assertMemoryDraft(command.userId, command.memory)
      const result = this.#database
        .prepare(
          `UPDATE memories
           SET scope = ?, scope_task_id = ?, category = ?, content = ?,
               source_kind = ?, source_id = ?, revision = revision + 1,
               updated_at = ?
           WHERE id = ? AND user_id = ? AND revision = ?`,
        )
        .run(
          command.memory.scope,
          command.memory.taskId ?? null,
          command.memory.category,
          command.memory.content,
          command.memory.source.kind,
          command.memory.source.kind === 'user_confirmation'
            ? null
            : command.memory.source.id,
          nowIso,
          memoryId,
          command.userId,
          command.expectedRevision,
        )
      if (result.changes !== 1) throw new MemoryRevisionConflictError()
      const memory = this.#memoryById(memoryId)
      this.#saveMemoryCommand(
        command.userId,
        command.commandId,
        'update',
        fingerprint,
        memory.id,
        memory,
        nowIso,
      )
      this.#database.exec('COMMIT')
      return memory
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  deleteMemory(memoryId: string, command: MemoryDeleteCommand): MemoryDeletion {
    const nowIso = this.#clock.now().toISOString()
    const fingerprint = memoryFingerprint({
      operation: 'delete',
      memoryId,
      expectedRevision: command.expectedRevision,
    })
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const replay = this.#memoryCommandReplay(
        command.userId,
        command.commandId,
        'delete',
        fingerprint,
      )
      if (replay) {
        if (replay.memory_id !== memoryId)
          throw new MemoryCommandConflictError()
        this.#database.exec('COMMIT')
        return JSON.parse(replay.response_json) as MemoryDeletion
      }
      const current = this.#memoryByIdForUser(memoryId, command.userId)
      if (current.revision !== command.expectedRevision)
        throw new MemoryRevisionConflictError()
      const result = this.#database
        .prepare('DELETE FROM memories WHERE id = ? AND user_id = ?')
        .run(memoryId, command.userId)
      if (result.changes !== 1) throw new MemoryNotFoundError()
      const deletion: MemoryDeletion = {
        id: memoryId,
        deleted: true,
        deletedAt: nowIso,
      }
      this.#database
        .prepare(
          `UPDATE memory_commands SET response_json = ?
           WHERE memory_id = ? AND user_id = ? AND operation != 'delete'`,
        )
        .run(JSON.stringify(deletion), memoryId, command.userId)
      this.#saveMemoryCommand(
        command.userId,
        command.commandId,
        'delete',
        fingerprint,
        memoryId,
        deletion,
        nowIso,
      )
      this.#database.exec('COMMIT')
      return deletion
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  memoryContextForTask(
    userId: string,
    taskId: string,
    limit = 50,
  ): MemoryRecord[] {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new MemoryNotFoundError()
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200)
      throw new Error('Memory limit must be between 1 and 200')
    const now = this.#clock.now().toISOString()
    const rows = this.#database
      .prepare(
        `SELECT * FROM memories
         WHERE user_id = ? AND (scope = 'global' OR scope_task_id = ?)
         ORDER BY CASE scope WHEN 'channel' THEN 0 WHEN 'worker' THEN 1 ELSE 2 END,
                  updated_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(userId, taskId, limit) as unknown as MemoryRow[]
    const selected: MemoryRow[] = []
    let characters = 0
    for (const row of rows) {
      const size = Array.from(row.content).length + 200
      if (selected.length > 0 && characters + size > 24_000) break
      selected.push(row)
      characters += size
    }
    if (selected.length > 0) {
      const placeholders = selected.map(() => '?').join(',')
      this.#database
        .prepare(
          `UPDATE memories SET last_used_at = ?
           WHERE user_id = ? AND id IN (${placeholders})`,
        )
        .run(now, userId, ...selected.map(row => row.id))
    }
    return selected.map(row => toMemoryRecord({ ...row, last_used_at: now }))
  }

  memoryContextEntriesForTask(
    userId: string,
    taskId: string,
    limit = 50,
  ): ReturnType<typeof toMemoryContext>[] {
    return this.memoryContextForTask(userId, taskId, limit).map(toMemoryContext)
  }

  #memoryById(memoryId: string): MemoryRecord {
    const row = this.#database
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(memoryId) as unknown as MemoryRow | undefined
    if (!row) throw new MemoryNotFoundError()
    return toMemoryRecord(row)
  }

  #memoryByIdForUser(memoryId: string, userId: string): MemoryRecord {
    const row = this.#database
      .prepare('SELECT * FROM memories WHERE id = ? AND user_id = ?')
      .get(memoryId, userId) as unknown as MemoryRow | undefined
    if (!row) throw new MemoryNotFoundError()
    return toMemoryRecord(row)
  }

  #assertMemoryDraft(
    userId: string,
    memory: MemoryCreateCommand['memory'],
  ): void {
    if (memory.scope !== 'global' && memory.taskId) {
      const task = this.findTask(memory.taskId, userId)
      if (!task) throw new MemoryTargetUnavailableError()
    }
    if (memory.source.kind === 'user_confirmation') return
    if (memory.source.kind === 'task') {
      if (!this.findTask(memory.source.id, userId))
        throw new MemorySourceUnavailableError()
      return
    }
    if (memory.source.kind === 'run') {
      const run = this.#database
        .prepare('SELECT task_id FROM runs WHERE id = ?')
        .get(memory.source.id) as { task_id: string } | undefined
      if (!run || !this.findTask(run.task_id, userId))
        throw new MemorySourceUnavailableError()
      return
    }
    const artifact = this.#database
      .prepare('SELECT task_id FROM task_artifacts WHERE id = ?')
      .get(memory.source.id) as { task_id: string } | undefined
    if (!artifact || !this.findTask(artifact.task_id, userId))
      throw new MemorySourceUnavailableError()
  }

  #memoryCommandReplay(
    userId: string,
    commandId: string,
    operation: MemoryCommandRow['operation'],
    fingerprint: string,
  ): MemoryCommandRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT fingerprint, operation, memory_id, response_json
         FROM memory_commands WHERE user_id = ? AND command_id = ?`,
      )
      .get(userId, commandId) as unknown as MemoryCommandRow | undefined
    if (!row) return undefined
    if (row.operation !== operation || row.fingerprint !== fingerprint)
      throw new MemoryCommandConflictError()
    if (operation !== 'delete') {
      const response = JSON.parse(row.response_json) as { deleted?: boolean }
      if (response.deleted === true) throw new MemoryNotFoundError()
    }
    return row
  }

  #saveMemoryCommand(
    userId: string,
    commandId: string,
    operation: MemoryCommandRow['operation'],
    fingerprint: string,
    memoryId: string,
    response: MemoryRecord | MemoryDeletion,
    createdAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO memory_commands
          (user_id, command_id, fingerprint, operation, memory_id,
           response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        commandId,
        fingerprint,
        operation,
        memoryId,
        JSON.stringify(response),
        createdAt,
      )
  }

  initializeSpeechConnection(connection: SpeechConnection): void {
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO speech_connections
      (id, provider, base_url, model, api_key_ciphertext, updated_at)
      VALUES (1, ?, ?, ?, ?, ?)`,
      )
      .run(
        connection.provider,
        connection.baseUrl,
        connection.model,
        connection.apiKeyCiphertext ?? null,
        this.#clock.now().toISOString(),
      )
  }

  getSpeechConnection(): SpeechConnection {
    const row = this.#database
      .prepare('SELECT * FROM speech_connections WHERE id = 1')
      .get() as
      | {
          provider: SpeechConnection['provider']
          base_url: string
          model: string
          api_key_ciphertext: string | null
        }
      | undefined
    if (!row) return defaultSpeechConnection
    return {
      provider: row.provider,
      baseUrl: row.base_url,
      model: row.model,
      ...(row.api_key_ciphertext
        ? { apiKeyCiphertext: row.api_key_ciphertext }
        : {}),
    }
  }

  getSpeechSettings(): SpeechSettingsSummary {
    const connection = this.getSpeechConnection()
    return {
      provider: connection.provider,
      baseUrl: connection.baseUrl,
      model: connection.model,
      hasApiKey: Boolean(connection.apiKeyCiphertext),
    }
  }

  getRewriteConnection(): RewriteConnection {
    const row = this.#database
      .prepare('SELECT * FROM rewrite_connections WHERE id = 1')
      .get() as
      | {
          mode: RewriteConnection['mode']
          protocol: RewriteConnection['protocol']
          base_url: string
          model: string
          api_key_ciphertext: string | null
        }
      | undefined
    if (!row) return defaultRewriteConnection
    return {
      mode: row.mode,
      protocol: row.protocol,
      baseUrl: row.base_url,
      model: row.model,
      ...(row.api_key_ciphertext
        ? { apiKeyCiphertext: row.api_key_ciphertext }
        : {}),
    }
  }

  getRewriteSettings(): RewriteSettingsSummary {
    const connection = this.getRewriteConnection()
    return {
      mode: connection.mode,
      protocol: connection.protocol,
      baseUrl: connection.baseUrl,
      model: connection.model,
      hasApiKey: Boolean(connection.apiKeyCiphertext),
    }
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
    speech?: SpeechConnectionWrite,
    rewrite?: RewriteConnectionWrite,
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
      if (speech) {
        const existingSpeech = this.getSpeechConnection()
        const speechKey =
          speech.apiKeyCiphertext ??
          (speech.clearApiKey
            ? null
            : (existingSpeech.apiKeyCiphertext ?? null))
        this.#database
          .prepare(
            `INSERT INTO speech_connections
          (id, provider, base_url, model, api_key_ciphertext, updated_at)
          VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET provider = excluded.provider,
            base_url = excluded.base_url, model = excluded.model,
            api_key_ciphertext = excluded.api_key_ciphertext,
            updated_at = excluded.updated_at`,
          )
          .run(speech.provider, speech.baseUrl, speech.model, speechKey, now)
      }
      if (rewrite) {
        const existingRewrite = this.getRewriteConnection()
        const rewriteKey =
          rewrite.apiKeyCiphertext ??
          (rewrite.clearApiKey || rewrite.baseUrl !== existingRewrite.baseUrl
            ? null
            : (existingRewrite.apiKeyCiphertext ?? null))
        this.#database
          .prepare(
            `INSERT INTO rewrite_connections
            (id, mode, protocol, base_url, model, api_key_ciphertext, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET mode = excluded.mode,
             protocol = excluded.protocol, base_url = excluded.base_url,
             model = excluded.model, api_key_ciphertext = excluded.api_key_ciphertext,
             updated_at = excluded.updated_at`,
          )
          .run(
            rewrite.mode,
            rewrite.protocol,
            rewrite.baseUrl,
            rewrite.model,
            rewriteKey,
            now,
          )
      }
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
          (id, user_id, type, source, authenticated_actor, device_id, dedupe_key,
           payload_json, status, required_contract_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.type,
        input.source,
        input.authenticatedActor ?? null,
        input.deviceId ?? null,
        input.dedupeKey ?? null,
        JSON.stringify(input.payload),
        input.source === 'collaboration' ? 2 : 1,
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

  claimNextEvent(
    workerId: string,
    leaseMs = 30_000,
    supportedContractVersion = currentInboxContractVersion,
  ): InboxEvent | undefined {
    const now = this.#clock.now()
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString()
    this.#database.exec('BEGIN IMMEDIATE')

    try {
      const row = this.#database
        .prepare(
          `SELECT * FROM inbox_events
           WHERE required_contract_version <= ? AND (
             status = 'pending'
             OR (status = 'processing' AND lease_until <= ?)
           )
           ORDER BY created_at ASC
           LIMIT 1`,
        )
        .get(supportedContractVersion, now.toISOString()) as unknown as
        InboxRow | undefined

      if (!row) {
        this.#database.exec('COMMIT')
        return undefined
      }

      if (row.status === 'processing') {
        this.#database
          .prepare(
            `UPDATE inbox_events
             SET status = 'pending', claimed_by = NULL, lease_until = NULL
             WHERE id = ? AND status = 'processing' AND lease_until <= ?`,
          )
          .run(row.id, now.toISOString())
      }

      this.#database
        .prepare(
          `UPDATE inbox_events
           SET status = 'processing', claimed_by = ?, lease_until = ?,
               claimed_contract_version = ?, attempts = attempts + 1
           WHERE id = ?`,
        )
        .run(workerId, leaseUntil, supportedContractVersion, row.id)
      this.#database
        .prepare(
          `UPDATE automation_invocations
           SET status = 'processing', attempts = attempts + 1, updated_at = ?
           WHERE event_id = ?`,
        )
        .run(now.toISOString(), row.id)
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
    const now = this.#clock.now().toISOString()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#database
        .prepare(
          `UPDATE inbox_events
           SET status = 'processed', processed_at = ?, lease_until = NULL, last_error = NULL
           WHERE id = ? AND status = 'processing' AND claimed_by = ?`,
        )
        .run(now, eventId, workerId)
      if (result.changes !== 1) {
        const settled = this.#database
          .prepare(
            `SELECT 1 FROM inbox_events
             WHERE id = ? AND source = 'collaboration'
               AND status IN ('processed','failed')`,
          )
          .get(eventId)
        if (!settled)
          throw new Error(`Worker ${workerId} does not own event ${eventId}`)
        this.#database.exec('COMMIT')
        return
      }
      this.#database
        .prepare(
          `UPDATE automation_invocations
           SET status = 'dispatched', last_error = NULL, updated_at = ?
           WHERE event_id = ?`,
        )
        .run(now, eventId)
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  failEvent(
    eventId: string,
    workerId: string,
    error: string,
    maxAttempts = 5,
  ): void {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#database
        .prepare(
          `SELECT attempts FROM inbox_events
           WHERE id = ? AND status = 'processing' AND claimed_by = ?`,
        )
        .get(eventId, workerId) as { attempts: number } | undefined
      if (!row)
        if (
          this.#database
            .prepare(
              `SELECT 1 FROM inbox_events
               WHERE id = ? AND source = 'collaboration'
                 AND status IN ('processed','failed')`,
            )
            .get(eventId)
        ) {
          this.#database.exec('COMMIT')
          return
        } else {
          throw new Error(`Worker ${workerId} does not own event ${eventId}`)
        }
      const nextStatus = row.attempts >= maxAttempts ? 'failed' : 'pending'
      this.#database
        .prepare(
          `UPDATE inbox_events
           SET status = ?, claimed_by = NULL, lease_until = NULL,
               last_error = ?
           WHERE id = ? AND status = 'processing' AND claimed_by = ?`,
        )
        .run(nextStatus, error, eventId, workerId)
      this.#database
        .prepare(
          `UPDATE automation_invocations
           SET status = ?, last_error = ?, updated_at = ?
           WHERE event_id = ?`,
        )
        .run(
          nextStatus === 'failed' ? 'failed' : 'pending',
          error,
          this.#clock.now().toISOString(),
          eventId,
        )
      if (nextStatus === 'failed') {
        this.#failTerminalCollaborationEvent(eventId, error)
      }
      this.#database.exec('COMMIT')
    } catch (failure) {
      this.#database.exec('ROLLBACK')
      throw failure
    }
  }

  parkEventForBlockedAction(
    eventId: string,
    workerId: string,
    taskId: string,
  ): 'parked' | 'released' | 'failed' {
    const now = this.#clock.now().toISOString()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const event = this.#database
        .prepare(
          `SELECT user_id FROM inbox_events
           WHERE id = ? AND status = 'processing' AND claimed_by = ?`,
        )
        .get(eventId, workerId) as { user_id: string } | undefined
      if (!event)
        throw new Error(`Worker ${workerId} does not own event ${eventId}`)
      const task = this.#taskById(taskId)
      if (task.userId !== event.user_id)
        throw new Error('Task belongs to another user')
      this.#database
        .prepare(
          `INSERT INTO task_events (event_id, task_id, relation, created_at)
           VALUES (?, ?, 'blocked_action', ?)
           ON CONFLICT(event_id) DO UPDATE SET
             task_id = excluded.task_id,
             relation = CASE
               WHEN task_events.relation IN (
                 'context_note','collaboration_returned','collaboration_failed'
               ) THEN task_events.relation
               ELSE excluded.relation
             END,
             created_at = excluded.created_at`,
        )
        .run(eventId, taskId, now)
      if (task.status === 'cancelled') {
        this.#database
          .prepare(
            `UPDATE inbox_events
             SET status = 'failed', claimed_by = NULL, lease_until = NULL,
                 last_error = 'blocked_task_stopped'
             WHERE id = ? AND claimed_by = ?`,
          )
          .run(eventId, workerId)
        this.#database.exec('COMMIT')
        return 'failed'
      }
      const blockingAction = this.#database
        .prepare(
          `SELECT status FROM actions
           WHERE task_id = ? AND protocol_version = 1
             AND status IN ('awaiting_approval','authorized','failed','unknown')
           ORDER BY updated_at DESC, id DESC LIMIT 1`,
        )
        .get(taskId) as { status: string } | undefined
      if (!blockingAction) {
        this.#database
          .prepare(
            `UPDATE inbox_events
             SET status = 'pending', claimed_by = NULL, lease_until = NULL,
                 last_error = NULL
             WHERE id = ? AND claimed_by = ?`,
          )
          .run(eventId, workerId)
        this.#database.exec('COMMIT')
        return 'released'
      }
      this.#database
        .prepare(
          `UPDATE inbox_events
           SET status = 'processing', claimed_by = NULL,
               lease_until = '9999-12-31T23:59:59.999Z', last_error = ?
           WHERE id = ? AND claimed_by = ?`,
        )
        .run(`blocked_by_action:${blockingAction.status}`, eventId, workerId)
      this.#database.exec('COMMIT')
      return 'parked'
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  createTaskFromEvent(event: InboxEvent, title: string): Task {
    const now = this.#clock.now().toISOString()
    const id = randomUUID()
    const workerIconId = assignWorkerIconId(id)
    const mandate = createMandate(event, title, 'router')
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO tasks
          (id, user_id, origin_event_id, title, goal, status, worker_icon_id, mandate_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'backlog', ?, ?, ?, ?)`,
      )
      .run(
        id,
        event.userId,
        event.id,
        title,
        title,
        workerIconId,
        JSON.stringify(mandate),
        now,
        now,
      )
    const row = this.#database
      .prepare('SELECT * FROM tasks WHERE origin_event_id = ?')
      .get(event.id) as unknown as TaskRow | undefined
    if (!row) throw new Error(`Failed to create task for event ${event.id}`)
    this.#ensureWorkerProfile(row.id, row.created_at)
    return toTask(row)
  }

  #controlDecisionEvent(eventId: string): InboxEvent | undefined {
    const row = this.#database
      .prepare(
        `SELECT inbox_events.* FROM routing_decisions
         INNER JOIN inbox_events ON inbox_events.id = routing_decisions.event_id
         WHERE routing_decisions.event_id = ?
           AND routing_decisions.kind IN ('steer_task','cancel_task')`,
      )
      .get(eventId) as unknown as InboxRow | undefined
    return row ? toInboxEvent(row) : undefined
  }

  #applyControlIntentInTransaction(
    event: InboxEvent,
    decision: Extract<RoutingDecision, { kind: 'steer_task' | 'cancel_task' }>,
  ): Task {
    if (event.type !== 'user.message' || event.authenticatedActor !== 'human') {
      throw new Error('Control intents require authenticated human input')
    }
    const replay = this.#controlDecisionEvent(event.id)
    if (replay) {
      const recorded = this.#database
        .prepare(
          'SELECT kind, task_id FROM routing_decisions WHERE event_id = ?',
        )
        .get(event.id) as { kind: string; task_id: string }
      if (
        recorded.kind !== decision.kind ||
        recorded.task_id !== decision.taskId
      )
        throw new Error('Event already routed with a different decision')
      return this.#taskById(decision.taskId)
    }
    const task = this.#taskById(decision.taskId)
    if (task.userId !== event.userId)
      throw new Error('Task belongs to another user')
    const now = this.#clock.now().toISOString()

    if (decision.kind === 'cancel_task') {
      if (task.status === 'cancelled') {
        this.#recordControlDecisionInTransaction(event, decision, now)
        return task
      }
      if (task.status === 'completed') throw new Error('Task already ended')
      this.#stopTaskInTransaction(task, 'stopped_by_user', decision.reason)
      this.#recordControlDecisionInTransaction(event, decision, now)
      return this.#taskById(task.id)
    }

    if (task.status === 'cancelled')
      throw new Error('Task was stopped by the user')
    if (task.status === 'completed')
      throw new Error('A completed Task must resume through continuation')
    const blockingAction = this.#database
      .prepare(
        `SELECT status FROM actions
         WHERE task_id = ? AND protocol_version = 1
           AND status IN ('awaiting_approval','authorized','failed','unknown')
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get(task.id) as { status: string } | undefined
    if (blockingAction)
      throw new TaskActionBlockedError(task.id, blockingAction.status)
    const activeRun = this.#database
      .prepare(
        `SELECT id, status FROM runs
         WHERE task_id = ? AND status IN ('queued','running')
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(task.id) as { id: string; status: string } | undefined
    if (!activeRun) throw new Error('Steering requires a queued or running Run')
    const directive = { eventId: event.id, text: decision.input, at: now }
    if (activeRun.status === 'queued') {
      const run = this.#runById(activeRun.id)
      this.#database
        .prepare('UPDATE runs SET input_json = ?, updated_at = ? WHERE id = ?')
        .run(
          JSON.stringify(
            `${run.input}\n\n[用户纠正] 用户在执行开始前补充了以下要求，必须与原始目标合并处理：\n${decision.input}`,
          ),
          now,
          activeRun.id,
        )
    } else {
      const row = this.#database
        .prepare('SELECT steering_json FROM runs WHERE id = ?')
        .get(activeRun.id) as { steering_json: string | null }
      const directives = row.steering_json
        ? (JSON.parse(row.steering_json) as (typeof directive)[])
        : []
      directives.push(directive)
      this.#database
        .prepare(
          'UPDATE runs SET steering_json = ?, updated_at = ? WHERE id = ?',
        )
        .run(JSON.stringify(directives), now, activeRun.id)
    }
    this.#recordControlDecisionInTransaction(event, decision, now)
    return this.#taskById(task.id)
  }

  #recordControlDecisionInTransaction(
    event: InboxEvent,
    decision: Extract<RoutingDecision, { kind: 'steer_task' | 'cancel_task' }>,
    now: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO task_events (event_id, task_id, relation, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        event.id,
        decision.taskId,
        decision.kind === 'steer_task' ? 'steering' : 'control',
        now,
      )
    this.#database
      .prepare(
        `INSERT INTO routing_decisions (event_id, kind, task_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(event.id, decision.kind, decision.taskId, decision.reason, now)
  }

  listPendingRunSteering(
    runId: string,
    workerId: string,
  ): { eventId: string; text: string; at: string }[] {
    const row = this.#database
      .prepare(
        `SELECT steering_json FROM runs
         WHERE id = ? AND status = 'running' AND claimed_by = ?`,
      )
      .get(runId, workerId) as { steering_json: string | null } | undefined
    if (!row) throw new Error(`Worker ${workerId} does not own run ${runId}`)
    return row.steering_json
      ? (JSON.parse(row.steering_json) as {
          eventId: string
          text: string
          at: string
        }[])
      : []
  }

  supersedeRunForSteering(runId: string, workerId: string): Run {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#database
        .prepare(
          `SELECT * FROM runs
           WHERE id = ? AND status = 'running' AND claimed_by = ?`,
        )
        .get(runId, workerId) as unknown as RunRow | undefined
      if (!row) throw new Error(`Worker ${workerId} does not own run ${runId}`)
      if (!row.steering_json)
        throw new Error('Run has no pending steering directives')
      const task = this.#taskById(row.task_id)
      if (task.status === 'completed' || task.status === 'cancelled')
        throw new Error('Task is closed')
      const existing = this.#database
        .prepare(`SELECT * FROM runs WHERE steering_of_run_id = ? LIMIT 1`)
        .get(runId) as unknown as RunRow | undefined
      if (existing) {
        this.#database
          .prepare(
            `UPDATE runs SET steering_json = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(this.#clock.now().toISOString(), runId)
        const successor = toRun(existing)
        this.#database.exec('COMMIT')
        return successor
      }
      const directives = JSON.parse(row.steering_json) as {
        eventId: string
        text: string
        at: string
      }[]
      const now = this.#clock.now().toISOString()
      const steeringText = directives
        .map(directive => directive.text)
        .join('\n')
      const successorId = randomUUID()
      this.#database
        .prepare(
          `INSERT INTO runs
            (id, task_id, origin_event_id, steering_of_run_id, executor, resume_from_ref, goal_revision, status,
             input_json, execution_context_json, execution_contract_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        )
        .run(
          successorId,
          row.task_id,
          directives.at(-1)?.eventId ?? row.origin_event_id,
          runId,
          row.executor,
          row.executor_ref ?? row.resume_from_ref,
          row.goal_revision,
          JSON.stringify(
            `${JSON.parse(row.input_json) as string}\n\n[用户纠正] 用户在执行过程中发来了新的指示。请在已完成工作的基础上调整方向，不要重复已完成的副作用：\n${steeringText}`,
          ),
          row.execution_context_json,
          row.execution_contract_version,
          now,
          now,
        )
      this.#database
        .prepare(
          `UPDATE runs SET status = 'cancelled', claimed_by = NULL, lease_until = NULL,
           steering_json = NULL, last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(`superseded_by_steering:${successorId}`, now, runId)
      const successor = this.#runById(successorId)
      this.#database.exec('COMMIT')
      return successor
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  applyRoutingDecision(
    event: InboxEvent,
    decision: RoutingDecision,
    executor: string,
    executionContext: ExecutionContext | ((task: Task) => ExecutionContext) = {
      executor,
    },
    options: { collaborationRelationId?: string } = {},
  ): { task: Task; run: Run } {
    if (decision.kind === 'steer_task' || decision.kind === 'cancel_task') {
      throw new Error('Control intents must use applyControlIntent')
    }
    return this.#applyTaskRoutingDecision(
      event,
      decision,
      executor,
      executionContext,
      options,
    )
  }

  applyControlIntent(
    event: InboxEvent,
    decision: Extract<RoutingDecision, { kind: 'steer_task' | 'cancel_task' }>,
  ): { task: Task } {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      if (event.source === 'collaboration') {
        throw new Error('Control intents require direct user routing')
      }
      const task = this.#applyControlIntentInTransaction(event, decision)
      this.#database.exec('COMMIT')
      return { task }
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #applyTaskRoutingDecision(
    event: InboxEvent,
    decision: Extract<
      RoutingDecision,
      { kind: 'create_task' | 'continue_task' }
    >,
    executor: string,
    executionContext: ExecutionContext | ((task: Task) => ExecutionContext),
    options: { collaborationRelationId?: string },
  ): { task: Task; run: Run } {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const collaboration = options.collaborationRelationId
        ? this.#collaborationForDispatch(options.collaborationRelationId, event)
        : undefined
      if (event.source === 'collaboration' && !collaboration) {
        throw new Error('Collaboration routing requires its durable relation')
      }
      const existingRun = this.#database
        .prepare('SELECT * FROM runs WHERE origin_event_id = ?')
        .get(event.id) as unknown as RunRow | undefined
      if (existingRun) {
        const existingTask = this.#taskById(existingRun.task_id)
        if (collaboration) {
          if (collaboration.target_event_id === event.id) {
            this.#markCollaborationDispatchedInTransaction(
              collaboration,
              event.id,
              existingTask.id,
            )
          }
        }
        this.#database.exec('COMMIT')
        return { task: existingTask, run: toRun(existingRun) }
      }

      const now = this.#clock.now().toISOString()
      let task: Task
      if (decision.kind === 'create_task') {
        const taskId = randomUUID()
        const workerIconId = assignWorkerIconId(taskId)
        const mandate = collaboration
          ? this.#taskById(collaboration.source_task_id).mandate
          : createMandate(event, decision.goal, 'router')
        if (
          decision.targetResource === 'pegas_repository' &&
          (collaboration || event.authenticatedActor !== 'human')
        ) {
          throw new Error('Self-change Tasks require authenticated human input')
        }
        this.#database
          .prepare(
            `INSERT INTO tasks
              (id, user_id, origin_event_id, title, goal, status, worker_icon_id, target_resource, mandate_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'unstarted', ?, ?, ?, ?, ?)`,
          )
          .run(
            taskId,
            event.userId,
            event.id,
            decision.title,
            decision.goal,
            workerIconId,
            decision.targetResource ?? null,
            JSON.stringify(mandate),
            now,
            now,
          )
        this.#ensureWorkerProfile(taskId, now)
        task = this.#taskById(taskId)
      } else {
        task = this.#taskById(decision.taskId)
        if (task.userId !== event.userId)
          throw new Error('Task belongs to another user')
        if (task.status === 'cancelled')
          throw new Error('Task was stopped by the user')
        if (
          task.status === 'completed' &&
          !revalidateMandate(task.mandate, event)
        )
          throw new Error('Task mandate no longer authorizes resume')
      }
      if (
        collaboration?.target_event_id === event.id &&
        collaboration.target_task_id &&
        collaboration.target_task_id !== task.id
      ) {
        throw new Error('Collaboration target is already assigned')
      }

      const resumed =
        decision.kind === 'continue_task' && task.status === 'completed'
      let resolvedExecutionContext =
        typeof executionContext === 'function'
          ? executionContext(task)
          : executionContext
      if (collaboration) {
        resolvedExecutionContext = this.#collaborationExecutionContext(
          collaboration,
          resolvedExecutionContext,
          executor,
          task.id,
        )
      }
      const executionContractVersion =
        resolvedExecutionContext.protocol === 'dsh-headless-v1' &&
        resolvedExecutionContext.workerProfile
          ? 2
          : 1
      const blockingAction = this.#database
        .prepare(
          `SELECT status FROM actions
           WHERE task_id = ? AND protocol_version = 1
             AND status IN ('awaiting_approval','authorized','failed','unknown')
           ORDER BY updated_at DESC, id DESC LIMIT 1`,
        )
        .get(task.id) as { status: string } | undefined
      if (decision.kind === 'continue_task' && blockingAction) {
        throw new TaskActionBlockedError(task.id, blockingAction.status)
      }

      const existingTaskEvent = this.#database
        .prepare('SELECT relation FROM task_events WHERE event_id = ?')
        .get(event.id) as { relation: string } | undefined
      const taskEventRelation =
        event.id === task.originEventId
          ? 'origin'
          : existingTaskEvent?.relation === 'context_note' ||
              existingTaskEvent?.relation === 'collaboration_returned' ||
              existingTaskEvent?.relation === 'collaboration_failed'
            ? existingTaskEvent.relation
            : decision.kind === 'create_task'
              ? 'origin'
              : resumed
                ? 'resumed'
                : 'continuation'

      this.#database
        .prepare(
          `INSERT INTO task_events (event_id, task_id, relation, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(event_id) DO UPDATE SET
             task_id = excluded.task_id,
             relation = excluded.relation,
             created_at = excluded.created_at`,
        )
        .run(event.id, task.id, taskEventRelation, now)
      this.#database
        .prepare(
          `INSERT INTO routing_decisions (event_id, kind, task_id, reason, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(event.id, decision.kind, task.id, decision.reason, now)

      const previous = this.#database
        .prepare(
          `SELECT executor_ref, execution_context_json FROM runs
           WHERE task_id = ? AND executor_ref IS NOT NULL
           ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
        )
        .get(task.id) as
        | { executor_ref: string; execution_context_json: string | null }
        | undefined
      const compatible =
        previous?.execution_context_json &&
        sameExecutionContext(
          parseExecutionContext(previous.execution_context_json),
          resolvedExecutionContext,
        )
      const goalRevision = (
        this.#database
          .prepare(
            'SELECT MAX(revision) AS revision FROM goal_contracts WHERE task_id = ?',
          )
          .get(task.id) as { revision: number | null }
      ).revision
      const runId = randomUUID()
      this.#database
        .prepare(
          `INSERT INTO runs
            (id, task_id, origin_event_id, executor, resume_from_ref, goal_revision, status,
             input_json, execution_context_json, execution_contract_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          task.id,
          event.id,
          executor,
          compatible ? previous.executor_ref : null,
          goalRevision,
          JSON.stringify(decision.input),
          JSON.stringify(resolvedExecutionContext),
          executionContractVersion,
          now,
          now,
        )
      this.#database
        .prepare(
          `UPDATE tasks SET status = CASE WHEN status = 'started' THEN 'started' ELSE 'unstarted' END,
           status_reason = ?, ended_json = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          blockingAction?.status === 'unknown'
            ? 'action_outcome_unknown'
            : blockingAction?.status === 'failed'
              ? 'action_failed'
              : blockingAction?.status === 'authorized'
                ? 'action_outcome_pending'
                : blockingAction?.status === 'awaiting_approval'
                  ? 'awaiting_approval'
                  : resumed
                    ? 'resumed'
                    : null,
          now,
          task.id,
        )

      const run = this.#runById(runId)
      task = this.#taskById(task.id)
      if (collaboration) {
        if (collaboration.target_event_id === event.id) {
          this.#markCollaborationDispatchedInTransaction(
            collaboration,
            event.id,
            task.id,
          )
        }
      }
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

  resolveRunInputEventId(runId: string): string | undefined {
    const row = this.#database
      .prepare(
        `WITH RECURSIVE lineage(id, origin_event_id, retry_of_run_id, depth) AS (
           SELECT id, origin_event_id, retry_of_run_id, 0
           FROM runs WHERE id = ?
           UNION ALL
           SELECT parent.id, parent.origin_event_id, parent.retry_of_run_id,
                  lineage.depth + 1
           FROM runs AS parent
           INNER JOIN lineage ON parent.id = lineage.retry_of_run_id
           WHERE lineage.depth < 64
         )
         SELECT lineage.origin_event_id AS event_id
         FROM lineage
         INNER JOIN inbox_events
           ON inbox_events.id = lineage.origin_event_id
         WHERE inbox_events.type = 'user.message'
           AND inbox_events.authenticated_actor = 'human'
         ORDER BY lineage.depth ASC
         LIMIT 1`,
      )
      .get(runId) as { event_id: string } | undefined
    return row?.event_id
  }

  listRunsForUser(userId: string, taskId?: string): Run[] {
    const rows = taskId
      ? this.#database
          .prepare(
            `SELECT runs.* FROM runs
             INNER JOIN tasks ON tasks.id = runs.task_id
             WHERE tasks.user_id = ? AND runs.task_id = ?
             ORDER BY runs.created_at ASC, runs.rowid ASC`,
          )
          .all(userId, taskId)
      : this.#database
          .prepare(
            `SELECT runs.* FROM runs
             INNER JOIN tasks ON tasks.id = runs.task_id
             WHERE tasks.user_id = ?
             ORDER BY runs.created_at ASC, runs.rowid ASC`,
          )
          .all(userId)
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

  /**
   * Incremental cross-device sync: events strictly after the cursor event in
   * (created_at, id) order. Clients on any device resume from the last event
   * they have seen; the server clock is the single ordering authority.
   */
  pageEventsAfter(
    userId: string,
    limit: number,
    cursor?: string,
  ): { events: InboxEvent[]; nextCursor?: string } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('Pagination limit must be between 1 and 200')
    }
    let cursorCreatedAt: string | null = null
    let cursorId: string | null = null
    if (cursor) {
      const cursorRow = this.#database
        .prepare(
          'SELECT created_at, id FROM inbox_events WHERE id = ? AND user_id = ?',
        )
        .get(cursor, userId) as { created_at: string; id: string } | undefined
      if (!cursorRow) throw new Error('Pagination cursor is invalid')
      cursorCreatedAt = cursorRow.created_at
      cursorId = cursorRow.id
    }
    const rows = this.#database
      .prepare(
        `SELECT * FROM inbox_events
         WHERE user_id = ?
           AND (? IS NULL OR created_at > ?
             OR (created_at = ? AND id > ?))
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(
        userId,
        cursorCreatedAt,
        cursorCreatedAt,
        cursorCreatedAt,
        cursorId,
        limit + 1,
      ) as unknown as InboxRow[]
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore ? pageRows.at(-1)?.id : undefined
    return {
      events: pageRows.map(toInboxEvent),
      ...(nextCursor ? { nextCursor } : {}),
    }
  }

  /**
   * Persists one immutable attachment for an existing durable event. Bytes
   * are content-addressed by SHA-256 inside the data directory; replaying the
   * exact upload returns the stored record, a different payload for the same
   * event is rejected.
   */
  attachEventFile(
    eventId: string,
    userId: string,
    input: { fileName: string; mediaType: string; bytes: Buffer },
  ): EventAttachment {
    if (!this.#attachmentRoot) {
      throw new EventAttachmentsUnsupportedError(
        'Attachments require a persistent database',
      )
    }
    const event = this.#database
      .prepare('SELECT id FROM inbox_events WHERE id = ? AND user_id = ?')
      .get(eventId, userId) as { id: string } | undefined
    if (!event) throw new Error('Event does not exist for user')
    const sha256 = createHash('sha256').update(input.bytes).digest('hex')
    const existing = this.#attachmentRow(eventId, userId)
    if (existing) {
      if (
        existing.sha256 !== sha256 ||
        existing.file_name !== input.fileName ||
        existing.media_type !== input.mediaType ||
        existing.byte_size !== input.bytes.byteLength
      ) {
        throw new EventAttachmentConflictError(
          'Event already has a different attachment',
        )
      }
      return toEventAttachment(existing)
    }
    const id = randomUUID()
    const storagePath = join(this.#attachmentRoot, `${sha256}-${id}`)
    mkdirSync(this.#attachmentRoot, { recursive: true })
    writeFileSync(storagePath, input.bytes, { flag: 'wx', mode: 0o600 })
    this.#database
      .prepare(
        `INSERT INTO event_attachments
          (id, user_id, event_id, file_name, media_type, byte_size, sha256,
           storage_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        eventId,
        input.fileName,
        input.mediaType,
        input.bytes.byteLength,
        sha256,
        storagePath,
        this.#clock.now().toISOString(),
      )
    const stored = this.#attachmentRow(eventId, userId)
    if (!stored) throw new Error('Failed to persist the attachment')
    return toEventAttachment(stored)
  }

  getEventAttachment(
    eventId: string,
    userId: string,
  ): EventAttachment | undefined {
    const row = this.#attachmentRow(eventId, userId)
    return row ? toEventAttachment(row) : undefined
  }

  readEventAttachmentBytes(
    eventId: string,
    userId: string,
  ): { attachment: EventAttachment; bytes: Buffer } | undefined {
    const row = this.#attachmentRow(eventId, userId)
    if (!row) return undefined
    const bytes = readFileSync(row.storage_path)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== row.sha256) {
      throw new Error('Attachment bytes do not match the stored digest')
    }
    return { attachment: toEventAttachment(row), bytes }
  }

  #attachmentRow(
    eventId: string,
    userId: string,
  ): EventAttachmentRow | undefined {
    return this.#database
      .prepare(
        'SELECT * FROM event_attachments WHERE event_id = ? AND user_id = ?',
      )
      .get(eventId, userId) as unknown as EventAttachmentRow | undefined
  }

  listChannelEvents(taskId: string, userId: string): InboxEvent[] {
    const events: InboxEvent[] = []
    let cursor: string | undefined
    do {
      const page = this.pageChannelEvents(taskId, userId, 200, cursor)
      events.push(...page.events)
      cursor = page.nextCursor
    } while (cursor)
    return events
  }

  pageChannelEvents(
    taskId: string,
    userId: string,
    limit = 50,
    cursor?: string,
  ): { events: InboxEvent[]; nextCursor?: string } {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200)
      throw new Error('Timeline limit must be an integer between 1 and 200')
    const cursorRow = cursor
      ? (this.#database
          .prepare(
            'SELECT rowid FROM inbox_events WHERE id = ? AND user_id = ?',
          )
          .get(cursor, userId) as { rowid: number } | undefined)
      : undefined
    if (cursor && !cursorRow) throw new Error('Timeline cursor is invalid')
    const rows = this.#database
      .prepare(
        `SELECT * FROM (
           SELECT inbox_events.*, inbox_events.rowid AS event_rowid FROM task_events
           INNER JOIN inbox_events ON inbox_events.id = task_events.event_id
           WHERE task_events.task_id = ? AND inbox_events.user_id = ?
           UNION
           SELECT inbox_events.*, inbox_events.rowid AS event_rowid FROM tasks
           INNER JOIN inbox_events ON inbox_events.id = tasks.origin_event_id
           WHERE tasks.id = ? AND tasks.user_id = ?
           UNION
           SELECT inbox_events.*, inbox_events.rowid AS event_rowid FROM inbox_events
           WHERE inbox_events.user_id = ?
             AND inbox_events.type = 'user.message'
             AND inbox_events.status IN ('pending', 'processing', 'failed')
             AND json_valid(inbox_events.payload_json)
             AND json_extract(inbox_events.payload_json, '$.taskId') = ?
             AND NOT EXISTS (
               SELECT 1 FROM task_events
               WHERE task_events.event_id = inbox_events.id
             )
         )
         WHERE (? IS NULL OR event_rowid > ?)
         ORDER BY event_rowid ASC LIMIT ?`,
      )
      .all(
        taskId,
        userId,
        taskId,
        userId,
        userId,
        taskId,
        cursorRow?.rowid ?? null,
        cursorRow?.rowid ?? null,
        limit + 1,
      ) as unknown as (InboxRow & { event_rowid: number })[]
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore ? pageRows.at(-1)?.id : undefined
    return {
      events: pageRows.map(row => toInboxEvent(row)),
      ...(nextCursor ? { nextCursor } : {}),
    }
  }

  listChannelRoutingDecisions(
    taskId: string,
    userId: string,
  ): {
    eventId: string
    kind: string
    taskId: string
    reason: string
    createdAt: string
  }[] {
    const task = this.findTask(taskId, userId)
    if (!task) throw new Error('Task does not exist for user')
    const rows = this.#database
      .prepare(
        `SELECT routing_decisions.* FROM routing_decisions
         INNER JOIN inbox_events ON inbox_events.id = routing_decisions.event_id
         WHERE routing_decisions.task_id = ? AND inbox_events.user_id = ?
         ORDER BY routing_decisions.created_at ASC, inbox_events.rowid ASC`,
      )
      .all(taskId, userId) as unknown as {
      event_id: string
      kind: string
      task_id: string
      reason: string
      created_at: string
    }[]
    return rows.map(row => ({
      eventId: row.event_id,
      kind: row.kind,
      taskId: row.task_id,
      reason: row.reason,
      createdAt: row.created_at,
    }))
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

  searchChannels(
    userId: string,
    options: ChannelSearchOptions,
  ): ChannelSearchResult {
    const query = options.query?.trim()
    if (query && Array.from(query).length > 200)
      throw new Error('Search query must contain at most 200 characters')
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit <= 0 ||
      options.limit > 200
    )
      throw new Error('Search limit must be an integer between 1 and 200')
    const statuses = options.statuses?.length ? options.statuses : undefined
    const ended = options.ended
    let cursorValue: string | undefined
    if (options.cursor) {
      const cursorRow = this.#database
        .prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?')
        .get(options.cursor, userId) as unknown as TaskRow | undefined
      if (!cursorRow) throw new Error('Pagination cursor is invalid')
      cursorValue = taskSearchSortValue(cursorRow, options.sort ?? 'updated')
    }

    const where = [
      'tasks.user_id = ?',
      statuses
        ? `tasks.status IN (${statuses.map(() => '?').join(',')})`
        : '1 = 1',
      ended === undefined
        ? '1 = 1'
        : ended
          ? "tasks.status IN ('completed','cancelled')"
          : "tasks.status NOT IN ('completed','cancelled')",
      query
        ? `(
             instr(lower(tasks.id), lower(?)) > 0
             OR ${
               Array.from(query).length >= 3
                 ? `EXISTS (
                     SELECT 1 FROM channel_search
                     INNER JOIN channel_search_documents
                       ON channel_search_documents.rowid = channel_search.rowid
                     WHERE channel_search_documents.task_id = tasks.id
                       AND channel_search MATCH ?
                   )`
                 : `EXISTS (
                     SELECT 1 FROM channel_search_documents
                     WHERE channel_search_documents.task_id = tasks.id
                       AND instr(lower(channel_search_documents.text), lower(?)) > 0
                   )`
             }
           )`
        : '1 = 1',
      options.needsAttention
        ? `(
             EXISTS (
               SELECT 1 FROM outbox_messages
               WHERE outbox_messages.task_id = tasks.id
                 AND outbox_messages.read_at IS NULL
             )
             OR EXISTS (
               SELECT 1 FROM approvals
               WHERE approvals.task_id = tasks.id
                 AND approvals.status = 'awaiting_approval'
             )
           )`
        : '1 = 1',
      options.workerIconId ? 'tasks.worker_icon_id = ?' : '1 = 1',
    ]
    const sortExpression = taskSearchSortExpression(options.sort ?? 'updated')
    if (cursorValue !== undefined) {
      where.push(
        `(
           ${sortExpression} < ?
           OR (${sortExpression} = ? AND tasks.id < ?)
         )`,
      )
    }
    const params: (string | number)[] = [userId]
    if (statuses) params.push(...statuses)
    if (query) {
      params.push(query)
      // The short-query EXISTS branch also binds the raw query; keep the
      // parameter order aligned with the SQL placeholder order.
      params.push(
        Array.from(query).length >= 3 ? ftsTrigramQuery(query) : query,
      )
    }
    if (options.workerIconId) params.push(options.workerIconId)
    if (cursorValue !== undefined && options.cursor) {
      params.push(cursorValue, cursorValue, options.cursor)
    }
    const rows = this.#database
      .prepare(
        `SELECT tasks.* FROM tasks
         WHERE ${where.join(' AND ')}
         ORDER BY ${sortExpression} DESC, tasks.id DESC
         LIMIT ?`,
      )
      .all(...params, options.limit + 1) as unknown as TaskRow[]
    const pageRows = rows.slice(0, options.limit)
    const channels = pageRows.map(row => projectWorkChannel(toTask(row)))
    const nextCursor =
      rows.length > options.limit ? pageRows.at(-1)?.id : undefined
    return {
      channels,
      matches: query
        ? this.#channelSearchMatches(
            pageRows.map(row => row.id),
            query,
          )
        : [],
      ...(nextCursor ? { nextCursor } : {}),
    }
  }

  findTask(taskId: string, userId: string): Task | undefined {
    const row = this.#database
      .prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?')
      .get(taskId, userId) as unknown as TaskRow | undefined
    return row ? toTask(row) : undefined
  }

  #channelSearchMatches(
    taskIds: string[],
    query: string,
  ): ChannelSearchResult['matches'] {
    if (taskIds.length === 0 || !query.trim()) return []
    const placeholders = taskIds.map(() => '?').join(',')
    if (Array.from(query).length < 3) {
      const rows = this.#database
        .prepare(
          `SELECT
             channel_search_documents.task_id,
             channel_search_documents.source_kind,
             channel_search_documents.source_id,
             substr(
               channel_search_documents.text,
               max(1, instr(lower(channel_search_documents.text), lower(?)) - 32),
               96
             ) AS snippet
           FROM channel_search_documents
           WHERE channel_search_documents.task_id IN (${placeholders})
             AND instr(lower(channel_search_documents.text), lower(?)) > 0
           ORDER BY channel_search_documents.rowid ASC
           LIMIT 50`,
        )
        .all(query, ...taskIds, query) as unknown as {
        task_id: string
        source_kind: string
        source_id: string
        snippet: string
      }[]
      return rows.map(row => ({
        channelId: row.task_id,
        sourceKind: row.source_kind,
        sourceId: row.source_id,
        snippet: row.snippet,
      }))
    }
    const rows = this.#database
      .prepare(
        `SELECT
           channel_search_documents.task_id,
           channel_search_documents.source_kind,
           channel_search_documents.source_id,
           snippet(channel_search, 0, '', '', '…', 24) AS snippet
         FROM channel_search
         INNER JOIN channel_search_documents
           ON channel_search_documents.rowid = channel_search.rowid
         WHERE channel_search_documents.task_id IN (${placeholders})
           AND channel_search MATCH ?
         ORDER BY channel_search_documents.rowid ASC
         LIMIT 50`,
      )
      .all(...taskIds, ftsTrigramQuery(query)) as unknown as {
      task_id: string
      source_kind: string
      source_id: string
      snippet: string
    }[]
    return rows.map(row => ({
      channelId: row.task_id,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      snippet: row.snippet,
    }))
  }

  createGoalContract(
    taskId: string,
    userId: string,
    commandId: string,
    draft: GoalContractDraft,
  ): GoalContract {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const contract = this.#createGoalContractInTransaction(
        taskId,
        userId,
        commandId,
        draft,
      )
      this.#database.exec('COMMIT')
      return contract
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #createGoalContractInTransaction(
    taskId: string,
    userId: string,
    commandId: string,
    draft: GoalContractDraft,
  ): GoalContract {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const existing = this.#database
      .prepare('SELECT * FROM goal_contracts WHERE command_id = ?')
      .get(commandId) as unknown as GoalContractRow | undefined
    if (existing) {
      if (existing.task_id !== taskId)
        throw new Error('Command ID is already used')
      const replayDraft = JSON.parse(existing.contract_json) as unknown
      if (
        createHash('sha256').update(stableJson(replayDraft)).digest('hex') !==
        createHash('sha256').update(stableJson(draft)).digest('hex')
      )
        throw new Error('Command ID is already used with a different Goal')
      return toGoalContract(existing)
    }
    if (task.status === 'completed' || task.status === 'cancelled')
      throw new Error('Closed Task cannot accept a new Goal revision')
    const sourcePlaceholders = draft.basedOnEventIds.map(() => '?').join(',')
    const sourceRows = this.#database
      .prepare(
        `SELECT id FROM inbox_events
           WHERE user_id = ? AND id IN (${sourcePlaceholders}) AND (
             id = ? OR EXISTS (
               SELECT 1 FROM task_events
               WHERE task_events.event_id = inbox_events.id
                 AND task_events.task_id = ?
             )
           )`,
      )
      .all(userId, ...draft.basedOnEventIds, task.originEventId, taskId) as {
      id: string
    }[]
    const sourceIds = new Set(sourceRows.map(row => row.id))
    const invalidSource = draft.basedOnEventIds.find(
      eventId => !sourceIds.has(eventId),
    )
    if (invalidSource)
      throw new Error(`Event ${invalidSource} is not a source for this Task`)
    const unreconciledAction = this.#database
      .prepare(
        `SELECT status FROM actions
           WHERE task_id = ? AND protocol_version = 1
             AND status IN ('failed','unknown')
           ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get(taskId) as { status: 'failed' | 'unknown' } | undefined
    if (unreconciledAction) {
      throw new Error(
        `Goal cannot be revised until the ${unreconciledAction.status} Action outcome is reconciled`,
      )
    }
    const confirmedFailedAction = this.#database
      .prepare(
        `SELECT 1 FROM action_reconciliations
         INNER JOIN actions ON actions.id = action_reconciliations.action_id
         WHERE actions.task_id = ?
           AND action_reconciliations.resolution = 'failed'
         LIMIT 1`,
      )
      .get(taskId)
    if (confirmedFailedAction) {
      throw new Error(
        'Goal cannot be revised while a human-confirmed failed Action is unresolved',
      )
    }
    const revisionRow = this.#database
      .prepare(
        'SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM goal_contracts WHERE task_id = ?',
      )
      .get(taskId) as { revision: number }
    const id = randomUUID()
    const createdAt = this.#clock.now().toISOString()
    this.#database
      .prepare(
        `INSERT INTO goal_contracts
            (id, task_id, revision, command_id, based_on_event_ids_json,
             desired_outcome, contract_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        taskId,
        revisionRow.revision,
        commandId,
        JSON.stringify(draft.basedOnEventIds),
        draft.desiredOutcome,
        JSON.stringify(draft),
        createdAt,
      )
    this.#database
      .prepare(
        `UPDATE tasks SET goal = ?, status_reason = ?, updated_at = ?
           WHERE id = ?`,
      )
      .run(draft.desiredOutcome, 'goal_defined', createdAt, taskId)
    const latestRun = this.#database
      .prepare(
        `SELECT * FROM runs WHERE task_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(taskId) as unknown as RunRow | undefined
    const latestAction = latestRun
      ? (this.#database
          .prepare(
            `SELECT * FROM actions WHERE resume_run_id = ?
               AND protocol_version = 1
               ORDER BY created_at DESC, id DESC LIMIT 1`,
          )
          .get(latestRun.id) as unknown as ActionRow | undefined)
      : undefined
    if (
      latestRun?.status === 'running' &&
      latestAction?.status === 'authorized'
    ) {
      throw new Error(
        'Goal cannot be revised while an authorized Action is executing',
      )
    }
    if (
      latestRun &&
      (latestRun.status === 'queued' || latestRun.goal_revision === null) &&
      latestAction?.status !== 'authorized'
    ) {
      // Rebind a Run that has no Goal snapshot yet (queued, or a running
      // Run formed before any Goal existed). Bound active Runs roll to a
      // successor revision instead of changing underneath the Executor.
      this.#database
        .prepare(
          `UPDATE runs SET goal_revision = ?, updated_at = ? WHERE id = ?`,
        )
        .run(revisionRow.revision, createdAt, latestRun.id)
    } else if (latestRun?.goal_revision !== revisionRow.revision) {
      if (latestRun) {
        const supersededApprovals = this.#database
          .prepare(
            `SELECT approvals.id, approvals.action_id FROM approvals
               INNER JOIN actions ON actions.id = approvals.action_id
               WHERE approvals.protocol_version = 1
                 AND approvals.status IN ('pending','decision_recorded')
                 AND actions.protocol_version = 1 AND actions.run_id = ?`,
          )
          .all(latestRun.id) as { id: string; action_id: string }[]
        this.#database
          .prepare(
            `UPDATE approvals SET status = 'cancelled', resolved_at = ?
               WHERE protocol_version = 1 AND status IN ('pending','decision_recorded')
                 AND action_id IN (
                   SELECT id FROM actions WHERE run_id = ? AND protocol_version = 1
                 )`,
          )
          .run(createdAt, latestRun.id)
        this.#database
          .prepare(
            `UPDATE actions SET status = 'rejected', result_json = ?, updated_at = ?
               WHERE protocol_version = 1 AND status = 'awaiting_approval'
                 AND run_id = ?`,
          )
          .run(
            JSON.stringify({ reason: 'superseded_by_goal_revision' }),
            createdAt,
            latestRun.id,
          )
        if (latestAction?.status === 'authorized') {
          this.#database
            .prepare(
              `UPDATE actions SET status = 'rejected', result_json = ?, updated_at = ?
                 WHERE id = ? AND status = 'authorized'`,
            )
            .run(
              JSON.stringify({
                reason: 'superseded_by_goal_revision_before_execution',
              }),
              createdAt,
              latestAction.id,
            )
        }
        for (const approval of supersededApprovals) {
          this.enqueueOutbox({
            userId: task.userId,
            taskId: task.id,
            channel: 'conversation',
            dedupeKey: `approval-resolved:${approval.id}`,
            payload: {
              type: 'approval.resolved',
              taskId: task.id,
              approvalId: approval.id,
              actionId: approval.action_id,
              decision: 'cancelled',
            },
          })
        }
        this.#wakeBlockedTaskEvents(task.id, createdAt)
      }
      if (
        latestRun &&
        (latestRun.status === 'queued' ||
          latestRun.status === 'running' ||
          latestRun.status === 'waiting')
      ) {
        this.#database
          .prepare(
            `UPDATE runs SET status = 'cancelled', claimed_by = NULL,
               lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            `superseded_by_goal_revision:${String(revisionRow.revision)}`,
            createdAt,
            latestRun.id,
          )
      }
      if (latestRun) {
        this.#database
          .prepare(
            `INSERT INTO runs
                (id, task_id, executor, resume_from_ref, retry_of_run_id,
                 goal_revision, status, input_json, execution_context_json,
                 execution_contract_version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            taskId,
            latestRun.executor,
            latestRun.executor_ref ?? latestRun.resume_from_ref,
            latestRun.id,
            revisionRow.revision,
            JSON.stringify(draft.desiredOutcome),
            latestRun.execution_context_json,
            latestRun.execution_contract_version,
            createdAt,
            createdAt,
          )
      }
    }
    return this.#goalContractById(id)
  }

  currentGoalContract(
    taskId: string,
    userId: string,
  ): GoalContract | undefined {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const row = this.#database
      .prepare(
        `SELECT * FROM goal_contracts
         WHERE task_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(taskId) as unknown as GoalContractRow | undefined
    return row ? toGoalContract(row) : undefined
  }

  listGoalContracts(taskId: string, userId: string): GoalContract[] {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const rows = this.#database
      .prepare(
        'SELECT * FROM goal_contracts WHERE task_id = ? ORDER BY revision ASC',
      )
      .all(taskId)
    return rows.map(row => toGoalContract(row as unknown as GoalContractRow))
  }

  pageGoalContracts(
    taskId: string,
    userId: string,
    limit: number,
    cursor?: string,
  ): CursorPage<GoalContract> {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const cursorRowId = this.#cursorRowId('goal_contracts', taskId, cursor)
    const rows = this.#database
      .prepare(
        `SELECT * FROM goal_contracts
         WHERE task_id = ? AND (? IS NULL OR rowid < ?)
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(
        taskId,
        cursorRowId,
        cursorRowId,
        limit + 1,
      ) as unknown as GoalContractRow[]
    return cursorPage(rows, limit, toGoalContract)
  }

  createArtifact(
    taskId: string,
    userId: string,
    commandId: string,
    draft: ArtifactDraft,
  ): TaskArtifact {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const task = this.#taskById(taskId)
      if (task.userId !== userId)
        throw new Error('Task belongs to another user')
      const existing = this.#database
        .prepare('SELECT * FROM task_artifacts WHERE command_id = ?')
        .get(commandId) as unknown as TaskArtifactRow | undefined
      if (existing) {
        if (existing.task_id !== taskId)
          throw new Error('Command ID is already used')
        this.#database.exec('COMMIT')
        return toTaskArtifact(existing)
      }
      if (task.status === 'completed' || task.status === 'cancelled')
        throw new Error('Closed Task cannot accept Artifacts')
      if (draft.runId) {
        const run = this.#runById(draft.runId)
        if (run.taskId !== taskId)
          throw new Error('Artifact Run belongs to another Task')
        if (this.listRuns(task.id).at(-1)?.id !== run.id)
          throw new Error('Artifact must target the latest Run')
      }
      const id = randomUUID()
      const createdAt = this.#clock.now().toISOString()
      this.#database
        .prepare(
          `INSERT INTO task_artifacts
            (id, task_id, run_id, command_id, name, kind, mime_type, uri,
             revision, content_hash, size_bytes, metadata_json, sensitivity,
             created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          taskId,
          draft.runId ?? null,
          commandId,
          draft.name,
          draft.kind,
          draft.mimeType ?? null,
          draft.uri ?? null,
          draft.revision,
          draft.contentHash,
          draft.sizeBytes ?? null,
          JSON.stringify(draft.metadata),
          draft.sensitivity,
          createdAt,
        )
      const artifact = this.#artifactById(id)
      this.#database.exec('COMMIT')
      return artifact
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  listArtifacts(taskId: string, userId: string): TaskArtifact[] {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const rows = this.#database
      .prepare(
        `SELECT * FROM task_artifacts
         WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(taskId)
    return rows.map(row => toTaskArtifact(row as unknown as TaskArtifactRow))
  }

  pageArtifacts(
    taskId: string,
    userId: string,
    limit: number,
    cursor?: string,
  ): CursorPage<TaskArtifact> {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const cursorRowId = this.#cursorRowId('task_artifacts', taskId, cursor)
    const rows = this.#database
      .prepare(
        `SELECT * FROM task_artifacts
         WHERE task_id = ? AND (? IS NULL OR rowid < ?)
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(
        taskId,
        cursorRowId,
        cursorRowId,
        limit + 1,
      ) as unknown as TaskArtifactRow[]
    return cursorPage(rows, limit, toTaskArtifact)
  }

  artifactsByIds(
    taskId: string,
    userId: string,
    artifactIds: string[],
  ): TaskArtifact[] {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const uniqueIds = [...new Set(artifactIds)]
    if (uniqueIds.length === 0) return []
    const rows = this.#database
      .prepare(
        `SELECT * FROM task_artifacts
         WHERE task_id = ? AND id IN (${uniqueIds.map(() => '?').join(',')})
         ORDER BY rowid DESC`,
      )
      .all(taskId, ...uniqueIds) as unknown as TaskArtifactRow[]
    return rows.map(toTaskArtifact)
  }

  createEvidenceRef(
    runId: string,
    userId: string,
    commandId: string,
    draft: EvidenceRefDraft,
  ): EvidenceRef {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const run = this.#runById(runId)
      const task = this.#taskById(run.taskId)
      if (task.userId !== userId)
        throw new Error('Task belongs to another user')
      const existing = this.#database
        .prepare(
          `SELECT evidence_refs.* FROM evidence_commands
           JOIN evidence_refs ON evidence_refs.id = evidence_commands.evidence_id
           WHERE evidence_commands.command_id = ?`,
        )
        .get(commandId) as unknown as EvidenceRefRow | undefined
      if (existing) {
        if (existing.run_id !== runId)
          throw new Error('Command ID is already used')
        this.#database.exec('COMMIT')
        return toEvidenceRef(existing)
      }
      if (task.status === 'completed' || task.status === 'cancelled')
        throw new Error('Closed Task cannot accept Evidence')
      if (this.listRuns(task.id).at(-1)?.id !== runId)
        throw new Error('Evidence must target the latest Run')
      const goal = this.currentGoalContract(task.id, userId)
      if (goal?.revision !== draft.goalRevision)
        throw new Error('Evidence must target the current Goal revision')
      if (run.goalRevision !== draft.goalRevision)
        throw new Error('Evidence must target the Run Goal revision')
      const criterion = goal.successCriteria.find(
        item => item.criterionId === draft.criterionId,
      )
      if (!criterion) throw new Error('Evidence criterion does not exist')
      const plan = goal.evidencePlan.find(
        item => item.id === criterion.evidencePlanRef,
      )
      if (!plan) throw new Error('Evidence plan does not exist')
      if (!plan.acceptedKinds.includes(draft.kind))
        throw new Error('Evidence kind is not accepted by the criterion plan')
      if (!plan.acceptedTrustClasses.includes(draft.trustClass))
        throw new Error('Evidence trust class is not accepted by the plan')

      const artifact = draft.artifactId
        ? this.#artifactById(draft.artifactId)
        : undefined
      if (artifact && artifact.taskId !== task.id)
        throw new Error('Evidence Artifact belongs to another Task')
      if (
        ['screenshot', 'render', 'keyframe'].includes(draft.kind) &&
        !artifact
      )
        throw new Error('Visual evidence requires an immutable Artifact')
      if (
        ['screenshot', 'render', 'keyframe'].includes(draft.kind) &&
        artifact?.runId !== runId
      )
        throw new Error('Visual evidence must use an Artifact from this Run')
      validateVisualEvidence(draft, artifact)
      if (
        draft.verification.result === 'passed' &&
        draft.verification.verifierIdentity === draft.producerIdentity
      )
        throw new Error('Evidence producer cannot be its sole verifier')

      const id = randomUUID()
      const capturedAt = this.#clock.now().toISOString()
      const contentHash =
        artifact?.contentHash ?? draft.observationSnapshot?.snapshotHash
      if (!contentHash) throw new Error('Evidence content hash is required')
      const sourceKey = artifact
        ? `artifact:${artifact.revision}:${artifact.contentHash}`
        : `observation:${contentHash}`
      const semanticDuplicate = this.#database
        .prepare(
          `SELECT * FROM evidence_refs
           WHERE task_id = ? AND run_id = ? AND goal_revision = ? AND criterion_id = ?
             AND source_key = ? AND kind = ?`,
        )
        .get(
          task.id,
          runId,
          draft.goalRevision,
          draft.criterionId,
          sourceKey,
          draft.kind,
        ) as unknown as EvidenceRefRow | undefined
      if (semanticDuplicate) {
        if (
          !sameEvidenceAttestation(
            toEvidenceRef(semanticDuplicate),
            draft,
            artifact,
            contentHash,
          )
        )
          throw new Error('Evidence source has a conflicting attestation')
        this.#database
          .prepare(
            `INSERT INTO evidence_commands
              (command_id, evidence_id, run_id, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(commandId, semanticDuplicate.id, runId, capturedAt)
        this.#database.exec('COMMIT')
        return toEvidenceRef(semanticDuplicate)
      }
      this.#database
        .prepare(
          `INSERT INTO evidence_refs
            (id, task_id, run_id, command_id, source_key, goal_revision, criterion_id,
             kind, artifact_id, external_ref, producer_identity,
             capture_mechanism, trust_class, content_hash, artifact_revision,
             observation_snapshot_json, verification_json, captured_at,
             environment_json, presentation_json, sensitivity,
             limitations_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          task.id,
          runId,
          commandId,
          sourceKey,
          draft.goalRevision,
          draft.criterionId,
          draft.kind,
          artifact?.id ?? null,
          draft.externalRef ?? null,
          draft.producerIdentity,
          draft.captureMechanism,
          draft.trustClass,
          contentHash,
          artifact?.revision ?? null,
          draft.observationSnapshot
            ? JSON.stringify(draft.observationSnapshot)
            : null,
          JSON.stringify(draft.verification),
          capturedAt,
          JSON.stringify(draft.environment),
          JSON.stringify(draft.presentation),
          draft.sensitivity,
          JSON.stringify(draft.limitations),
        )
      const evidence = this.#evidenceById(id)
      this.#database
        .prepare(
          `INSERT INTO evidence_commands
            (command_id, evidence_id, run_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(commandId, evidence.id, runId, capturedAt)
      this.#database
        .prepare(
          `INSERT INTO evidence_verification_events
            (id, evidence_id, command_id, verification_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          evidence.id,
          `capture:${commandId}`,
          JSON.stringify(draft.verification),
          capturedAt,
        )
      this.#wakeEvidenceReporting(runId, capturedAt)
      this.#database.exec('COMMIT')
      return evidence
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  recordEvidenceVerification(
    evidenceId: string,
    userId: string,
    commandId: string,
    verification: EvidenceVerification,
  ): EvidenceRef {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const evidence = this.#evidenceById(evidenceId)
      const task = this.#taskById(evidence.taskId)
      if (task.userId !== userId)
        throw new Error('Task belongs to another user')
      const existing = this.#database
        .prepare(
          'SELECT * FROM evidence_verification_events WHERE command_id = ?',
        )
        .get(commandId) as EvidenceVerificationEventRow | undefined
      if (existing) {
        if (existing.evidence_id !== evidenceId)
          throw new Error('Command ID is already used')
        this.#database.exec('COMMIT')
        return this.#evidenceById(evidenceId)
      }
      if (task.status === 'completed' || task.status === 'cancelled')
        throw new Error('Closed Task cannot accept Evidence verification')
      if (this.listRuns(task.id).at(-1)?.id !== evidence.runId)
        throw new Error('Evidence verification must target the latest Run')
      if (
        verification.result === 'passed' &&
        verification.verifierIdentity === evidence.producerIdentity
      )
        throw new Error('Evidence producer cannot be its sole verifier')
      const createdAt = this.#clock.now().toISOString()
      this.#database
        .prepare(
          `INSERT INTO evidence_verification_events
            (id, evidence_id, command_id, verification_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          evidenceId,
          commandId,
          JSON.stringify(verification),
          createdAt,
        )
      this.#database
        .prepare('UPDATE evidence_refs SET verification_json = ? WHERE id = ?')
        .run(JSON.stringify(verification), evidenceId)
      this.#wakeEvidenceReporting(evidence.runId, createdAt)
      const updated = this.#evidenceById(evidenceId)
      this.#database.exec('COMMIT')
      return updated
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  listEvidenceRefs(
    taskId: string,
    userId: string,
    goalRevision?: number,
  ): EvidenceRef[] {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const rows = goalRevision
      ? this.#database
          .prepare(
            `SELECT * FROM evidence_refs
             WHERE task_id = ? AND goal_revision = ?
             ORDER BY captured_at ASC, rowid ASC`,
          )
          .all(taskId, goalRevision)
      : this.#database
          .prepare(
            `SELECT * FROM evidence_refs
             WHERE task_id = ? ORDER BY captured_at ASC, rowid ASC`,
          )
          .all(taskId)
    return rows.map(row => toEvidenceRef(row as unknown as EvidenceRefRow))
  }

  pageEvidenceRefs(
    taskId: string,
    userId: string,
    limit: number,
    cursor?: string,
    goalRevision?: number,
    runId?: string,
  ): CursorPage<EvidenceRef> {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const cursorRowId = this.#cursorRowId('evidence_refs', taskId, cursor)
    const rows = this.#database
      .prepare(
        `SELECT * FROM evidence_refs
         WHERE task_id = ? AND (? IS NULL OR rowid < ?)
           AND (? IS NULL OR goal_revision = ?)
           AND (? IS NULL OR run_id = ?)
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(
        taskId,
        cursorRowId,
        cursorRowId,
        goalRevision ?? null,
        goalRevision ?? null,
        runId ?? null,
        runId ?? null,
        limit + 1,
      ) as unknown as EvidenceRefRow[]
    return cursorPage(rows, limit, toEvidenceRef)
  }

  evidenceByIds(
    taskId: string,
    userId: string,
    evidenceIds: string[],
  ): EvidenceRef[] {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const uniqueIds = [...new Set(evidenceIds)]
    if (uniqueIds.length === 0) return []
    const rows = this.#database
      .prepare(
        `SELECT * FROM evidence_refs
         WHERE task_id = ? AND id IN (${uniqueIds.map(() => '?').join(',')})`,
      )
      .all(taskId, ...uniqueIds) as unknown as EvidenceRefRow[]
    const byId = new Map(rows.map(row => [row.id, toEvidenceRef(row)]))
    return uniqueIds.flatMap(id => {
      const evidence = byId.get(id)
      return evidence ? [evidence] : []
    })
  }

  proposeGoalFromRun(
    runId: string,
    claimToken: string,
    commandId: string,
    draft: GoalContractDraft,
  ): { contract: GoalContract; waitingOnClarification: boolean } {
    const fingerprint = createHash('sha256')
      .update(stableJson({ commandId, draft }))
      .digest('hex')
    const suppliedClaimHash = hashClaimToken(claimToken)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const replay = this.#database
        .prepare(
          `SELECT contract_id, request_claim_hash, request_fingerprint, response_json
           FROM goal_proposal_commands WHERE run_id = ? AND command_id = ?`,
        )
        .get(runId, commandId) as
        | {
            contract_id: string
            request_claim_hash: string
            request_fingerprint: string
            response_json: string
          }
        | undefined
      if (replay) {
        if (!safeDigestEqual(suppliedClaimHash, replay.request_claim_hash))
          throw new RunClaimError('Run claim capability is invalid or expired')
        if (replay.request_fingerprint !== fingerprint)
          throw new GoalProposalCommandConflictError(
            'Goal proposal command ID is already used with a different Goal',
          )
        this.#database.exec('COMMIT')
        return JSON.parse(replay.response_json) as {
          contract: GoalContract
          waitingOnClarification: boolean
        }
      }
      this.#claimForCapability(runId, claimToken)
      const run = this.#runById(runId)
      if (run.status !== 'running') throw new Error('Run is not executing')
      const task = this.#taskById(run.taskId)
      if (task.status === 'completed' || task.status === 'cancelled')
        throw new Error('Closed Task cannot accept a Goal proposal')
      const beforeLatestRunId = (
        this.#database
          .prepare(
            `SELECT id FROM runs WHERE task_id = ?
             ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          )
          .get(task.id) as { id: string } | undefined
      )?.id
      const contract = this.#createGoalContractInTransaction(
        task.id,
        task.userId,
        `goal-proposal:${runId}:${commandId}`,
        draft,
      )
      // Contract creation timestamps share the transaction clock with the
      // source Run, so identify the successor by identity, not created_at.
      const successorRunId =
        beforeLatestRunId === runId
          ? (
              this.#database
                .prepare(
                  `SELECT id FROM runs
                   WHERE task_id = ? AND retry_of_run_id = ?
                   ORDER BY rowid DESC LIMIT 1`,
                )
                .get(task.id, runId) as { id: string } | undefined
            )?.id
          : beforeLatestRunId
      const now = this.#clock.now().toISOString()
      const waitingOnClarification = draft.unknowns.some(
        unknown => unknown.blocking,
      )
      if (waitingOnClarification) {
        if (successorRunId) {
          this.#database
            .prepare(
              `UPDATE runs SET status = 'cancelled', claimed_by = NULL,
               lease_until = NULL, claim_token_hash = NULL, last_error = ?,
               updated_at = ? WHERE id = ? AND status = 'queued'`,
            )
            .run('awaiting_goal_clarification', now, successorRunId)
        }
        this.#database
          .prepare(
            `UPDATE tasks SET status = 'started', status_reason = 'awaiting_goal_clarification',
             ended_json = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(now, task.id)
        const questions = draft.unknowns.filter(unknown => unknown.blocking)
        this.enqueueOutbox({
          userId: task.userId,
          taskId: task.id,
          channel: 'conversation',
          dedupeKey: `goal-clarification:${contract.id}`,
          payload: {
            type: 'goal.clarification_required',
            taskId: task.id,
            runId,
            goalContractId: contract.id,
            goalRevision: contract.revision,
            questions: questions.map(unknown => unknown.question),
            text: questions.map(unknown => unknown.question).join('\n'),
          },
        })
      }
      const response = { contract, waitingOnClarification }
      this.#database
        .prepare(
          `INSERT INTO goal_proposal_commands
            (run_id, command_id, request_claim_hash, request_fingerprint,
             contract_id, response_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          commandId,
          suppliedClaimHash,
          fingerprint,
          contract.id,
          JSON.stringify(response),
          now,
        )
      this.#database.exec('COMMIT')
      return response
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  assertGoalProposalCapability(runId: string, claimToken: string): void {
    const suppliedHash = hashClaimToken(claimToken)
    const replayRows = this.#database
      .prepare(
        'SELECT request_claim_hash FROM goal_proposal_commands WHERE run_id = ?',
      )
      .all(runId) as { request_claim_hash: string }[]
    if (
      replayRows.some(row =>
        safeDigestEqual(suppliedHash, row.request_claim_hash),
      )
    )
      return
    this.#claimForCapability(runId, claimToken)
  }

  submitWorkerReport(
    runId: string,
    userId: string | undefined,
    workerAuthority: string | { claimToken: string },
    draft: WorkerReportDraft,
  ): { report: WorkerReport; reviewPack?: ReviewPack; completed: boolean } {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const run = this.#runById(runId)
      const task = this.#taskById(run.taskId)
      if (typeof workerAuthority === 'string' && task.userId !== userId)
        throw new Error('Task belongs to another user')
      const existing = this.#database
        .prepare(
          'SELECT * FROM worker_reports WHERE run_id = ? AND report_sequence = ?',
        )
        .get(runId, draft.reportSequence) as unknown as
        WorkerReportRow | undefined
      if (existing) {
        if (typeof workerAuthority === 'string') {
          if (existing.worker_id !== workerAuthority)
            throw new Error('Worker Report belongs to another reporter')
        } else if (
          !existing.claim_token_hash ||
          !safeDigestEqual(
            hashClaimToken(workerAuthority.claimToken),
            existing.claim_token_hash,
          )
        ) {
          throw new RunClaimError('Run claim capability is invalid or expired')
        }
        const report = toWorkerReport(existing)
        const reviewPack = existing.review_pack_id
          ? this.#reviewPackById(existing.review_pack_id)
          : undefined
        this.#database.exec('COMMIT')
        return {
          report,
          ...(reviewPack ? { reviewPack } : {}),
          completed: reviewPack?.finalOutcome === 'completed',
        }
      }
      const claim =
        typeof workerAuthority === 'string'
          ? this.#claimForInternalWorker(runId, workerAuthority)
          : this.#claimForCapability(runId, workerAuthority.claimToken)
      const workerId = claim.workerId
      if (task.status === 'completed' || task.status === 'cancelled')
        throw new Error('Closed Task cannot accept Worker Reports')
      if (this.listRuns(task.id).at(-1)?.id !== runId)
        throw new Error('Worker Report must target the latest Run')
      if (run.claimedBy !== workerId)
        throw new Error(`Worker ${workerId} does not own run ${runId}`)
      if (new Set(draft.evidenceRefIds).size !== draft.evidenceRefIds.length)
        throw new Error('Worker Report evidence references must be unique')
      const latest = this.#database
        .prepare(
          'SELECT MAX(report_sequence) AS sequence FROM worker_reports WHERE run_id = ?',
        )
        .get(runId) as { sequence: number | null }
      if (latest.sequence !== null && draft.reportSequence <= latest.sequence)
        throw new Error('Worker Report sequence must increase')
      if (run.status === 'cancelled')
        throw new Error('Stopped Run cannot accept Worker Reports')
      if (
        (draft.status === 'started' || draft.status === 'progress') &&
        run.status !== 'running'
      )
        throw new Error(`${draft.status} Worker Report requires a running Run`)
      if (
        draft.status !== 'started' &&
        draft.status !== 'progress' &&
        run.status !== 'running' &&
        run.status !== 'waiting'
      )
        throw new Error('Final Worker Report requires a running or waiting Run')
      if (draft.status !== 'started' && draft.status !== 'progress') {
        const unresolvedAction = this.#database
          .prepare(
            `SELECT status FROM actions
             WHERE resume_run_id = ? AND protocol_version = 1
               AND status = 'authorized'
             LIMIT 1`,
          )
          .get(runId) as { status: 'authorized' } | undefined
        if (unresolvedAction) {
          throw new Error(
            'Authorized Action outcome must be recorded before a final Worker Report',
          )
        }
      }
      const goal = this.currentGoalContract(task.id, task.userId)
      if (goal?.revision !== draft.goalRevision)
        throw new Error('Worker Report must target the current Goal revision')
      if (run.goalRevision !== draft.goalRevision)
        throw new Error('Worker Report must target the Run Goal revision')
      const evidenceRows =
        draft.evidenceRefIds.length === 0
          ? []
          : (this.#database
              .prepare(
                `SELECT * FROM evidence_refs WHERE id IN (${draft.evidenceRefIds
                  .map(() => '?')
                  .join(',')})`,
              )
              .all(...draft.evidenceRefIds) as unknown as EvidenceRefRow[])
      const evidenceById = new Map(
        evidenceRows.map(row => [row.id, toEvidenceRef(row)]),
      )
      const reportedEvidence = draft.evidenceRefIds.map(id => {
        const item = evidenceById.get(id)
        if (!item) throw new Error(`Evidence ${id} does not exist`)
        if (
          item.taskId !== task.id ||
          item.runId !== runId ||
          item.goalRevision !== goal.revision
        )
          throw new Error('Worker Report references unrelated evidence')
        return item
      })
      const evidence =
        draft.status === 'ready'
          ? (
              this.#database
                .prepare(
                  `SELECT * FROM evidence_refs
                   WHERE task_id = ? AND run_id = ? AND goal_revision = ?
                   ORDER BY rowid ASC`,
                )
                .all(
                  task.id,
                  runId,
                  goal.revision,
                ) as unknown as EvidenceRefRow[]
            ).map(toEvidenceRef)
          : reportedEvidence
      const effectiveEvidenceRefIds = evidence.map(item => item.id)
      const reportId = randomUUID()
      const now = this.#clock.now().toISOString()
      this.#database
        .prepare(
          `INSERT INTO worker_reports
            (id, task_id, run_id, worker_id, claim_token_hash,
             goal_revision, report_sequence, status,
             evidence_ref_ids_json, summary, limitations_json,
             remaining_risks_json, rollback_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reportId,
          task.id,
          runId,
          workerId,
          claim.claimTokenHash,
          goal.revision,
          draft.reportSequence,
          draft.status,
          JSON.stringify(effectiveEvidenceRefIds),
          draft.summary,
          JSON.stringify(draft.limitations),
          JSON.stringify(draft.remainingRisks),
          draft.rollback ? JSON.stringify(draft.rollback) : null,
          now,
        )

      let reviewPack: ReviewPack | undefined
      let completed = false
      if (draft.status === 'ready' || draft.status === 'failed') {
        const criteria = reviewCriteria(goal, evidence)
        const sideEffects = (
          this.#database
            .prepare(
              `SELECT * FROM actions WHERE task_id = ?
               AND protocol_version = 1 ORDER BY created_at ASC, id ASC`,
            )
            .all(task.id) as unknown as ActionRow[]
        ).map(row => {
          const action = toDurableAction(row)
          const reconciliation =
            action.status === 'reconciled'
              ? (this.#database
                  .prepare(
                    'SELECT resolution, note, previous_status FROM action_reconciliations WHERE action_id = ?',
                  )
                  .get(action.id) as
                  | {
                      resolution: 'succeeded' | 'failed'
                      note: string
                      previous_status: 'failed' | 'unknown'
                    }
                  | undefined)
              : undefined
          return {
            actionId: action.id,
            kind: action.kind,
            status: action.status,
            ...(action.result ? { result: action.result } : {}),
            ...(reconciliation
              ? {
                  reconciliation: {
                    resolution: reconciliation.resolution,
                    note: reconciliation.note,
                    previousStatus: reconciliation.previous_status,
                  },
                }
              : {}),
          }
        })
        const sideEffectsSatisfied = sideEffects.every(action => {
          if (action.status === 'succeeded' || action.status === 'rejected')
            return true
          const reconciliation = (
            action as {
              reconciliation?: { resolution: 'succeeded' | 'failed' }
            }
          ).reconciliation
          return (
            action.status === 'reconciled' &&
            reconciliation?.resolution === 'succeeded'
          )
        })
        completed =
          draft.status === 'ready' &&
          sideEffectsSatisfied &&
          goal.successCriteria.every(criterion => {
            if (!criterion.required) return true
            return (
              criteria.find(item => item.criterionId === criterion.criterionId)
                ?.completionStatus === 'satisfied'
            )
          })
        const finalOutcome =
          draft.status === 'failed'
            ? ('failed' as const)
            : completed
              ? ('completed' as const)
              : ('partial' as const)
        const basisEventIds = [task.originEventId, ...goal.basedOnEventIds]
        const basisEventSetHash = createHash('sha256')
          .update(
            JSON.stringify({
              runId,
              goalRevision: goal.revision,
              reportSequence: draft.reportSequence,
              evidenceRefIds: [...effectiveEvidenceRefIds].sort(),
            }),
          )
          .digest('hex')
        const revisionRow = this.#database
          .prepare(
            'SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM review_packs WHERE task_id = ?',
          )
          .get(task.id) as { revision: number }
        const reviewPackId = randomUUID()
        this.#database
          .prepare(
            `INSERT INTO review_packs
              (id, revision, task_id, run_id, goal_revision,
               basis_event_ids_json, basis_event_set_hash, projection_as_of,
               final_outcome, criteria_json, side_effects_json,
               remaining_risks_json, rollback_json, audit_link, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            reviewPackId,
            revisionRow.revision,
            task.id,
            runId,
            goal.revision,
            JSON.stringify([...new Set(basisEventIds)]),
            basisEventSetHash,
            now,
            finalOutcome,
            JSON.stringify(criteria),
            JSON.stringify(sideEffects),
            JSON.stringify(draft.remainingRisks),
            draft.rollback ? JSON.stringify(draft.rollback) : null,
            `/?channel=${encodeURIComponent(task.id)}&run=${encodeURIComponent(runId)}`,
            now,
          )
        this.#database
          .prepare('UPDATE worker_reports SET review_pack_id = ? WHERE id = ?')
          .run(reviewPackId, reportId)
        reviewPack = this.#reviewPackById(reviewPackId)
      }

      if (completed && reviewPack) {
        this.#database
          .prepare(
            `UPDATE runs SET status = 'cancelled', claimed_by = NULL,
             lease_until = NULL, last_error = ?, updated_at = ?
             WHERE task_id = ? AND id <> ?
               AND status IN ('queued','running','waiting')`,
          )
          .run(`superseded_by:${runId}`, now, task.id, runId)
        this.#database
          .prepare(
            `UPDATE runs SET status = 'completed', claimed_by = NULL,
             lease_until = NULL, last_error = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(now, runId)
        this.#database
          .prepare(
            `UPDATE tasks SET status = 'completed', status_reason = NULL,
             ended_json = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            JSON.stringify({ at: now, by: 'executor', outcome: 'completed' }),
            now,
            task.id,
          )
        this.enqueueOutbox({
          userId: task.userId,
          taskId: task.id,
          channel: 'conversation',
          dedupeKey: `review-ready:${reviewPack.id}`,
          payload: {
            type: 'review.ready',
            taskId: task.id,
            runId,
            reviewPackId: reviewPack.id,
            text: draft.summary,
          },
        })
        this.#settleInboundCollaborations(
          task.id,
          'completed',
          draft.summary,
          runId,
          now,
        )
        this.#failUndeliveredContextNotes(
          task.id,
          'failed',
          'Target Task completed before the context note was delivered.',
          now,
        )
      } else if (draft.status === 'failed') {
        this.#database
          .prepare(
            `UPDATE runs SET status = 'failed', claimed_by = NULL,
             lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?`,
          )
          .run(draft.summary, now, runId)
        this.#database
          .prepare(
            `UPDATE tasks SET status = 'started', status_reason = 'last_run_failed',
             updated_at = ? WHERE id = ?`,
          )
          .run(now, task.id)
        this.enqueueOutbox({
          userId: task.userId,
          taskId: task.id,
          channel: 'conversation',
          dedupeKey: `goal-report-failed:${reportId}`,
          payload: {
            type: 'run.failed',
            taskId: task.id,
            runId,
            error: draft.summary,
            ...(reviewPack ? { reviewPackId: reviewPack.id } : {}),
          },
        })
      } else if (
        draft.status === 'ready' ||
        draft.status === 'waiting' ||
        draft.status === 'blocked'
      ) {
        const blockingAction = this.#database
          .prepare(
            `SELECT status FROM actions WHERE resume_run_id = ?
             AND protocol_version = 1
             AND status IN ('awaiting_approval','authorized','failed','unknown')
             LIMIT 1`,
          )
          .get(runId) as { status: DurableAction['status'] } | undefined
        const reason =
          blockingAction?.status === 'unknown'
            ? 'action_outcome_unknown'
            : blockingAction?.status === 'failed'
              ? 'action_failed'
              : draft.status === 'ready'
                ? 'awaiting_evidence'
                : draft.status === 'blocked'
                  ? 'blocked'
                  : 'awaiting_user_input'
        this.#database
          .prepare(
            `UPDATE runs SET status = 'waiting', lease_until = NULL,
             updated_at = ? WHERE id = ?`,
          )
          .run(now, runId)
        this.#database
          .prepare(
            `UPDATE tasks SET status = 'started', status_reason = ?,
             ended_json = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(reason, now, task.id)
        this.enqueueOutbox({
          userId: task.userId,
          taskId: task.id,
          channel: 'conversation',
          dedupeKey: `goal-attention:${reportId}`,
          payload: {
            type:
              draft.status === 'ready'
                ? 'goal.evidence_required'
                : draft.status === 'blocked'
                  ? 'run.blocked'
                  : 'run.waiting',
            taskId: task.id,
            runId,
            text: draft.summary,
            ...(reviewPack ? { reviewPackId: reviewPack.id } : {}),
          },
        })
      } else {
        this.#database
          .prepare(
            `UPDATE tasks SET status = 'started', status_reason = NULL,
             updated_at = ? WHERE id = ?`,
          )
          .run(now, task.id)
      }

      const report = this.#workerReportById(reportId)
      this.#database.exec('COMMIT')
      return {
        report,
        ...(reviewPack ? { reviewPack } : {}),
        completed,
      }
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  listReviewPacks(taskId: string, userId: string): ReviewPack[] {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const rows = this.#database
      .prepare(
        'SELECT * FROM review_packs WHERE task_id = ? ORDER BY revision ASC',
      )
      .all(taskId)
    return rows.map(row => toReviewPack(row as unknown as ReviewPackRow))
  }

  currentReviewPack(
    taskId: string,
    userId: string,
    goalRevision: number,
  ): ReviewPack | undefined {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const row = this.#database
      .prepare(
        `SELECT * FROM review_packs
         WHERE task_id = ? AND goal_revision = ?
           AND run_id = (
             SELECT id FROM runs WHERE task_id = ?
             ORDER BY created_at DESC, rowid DESC LIMIT 1
           )
         ORDER BY revision DESC LIMIT 1`,
      )
      .get(taskId, goalRevision, taskId) as unknown as ReviewPackRow | undefined
    return row ? toReviewPack(row) : undefined
  }

  pageReviewPacks(
    taskId: string,
    userId: string,
    limit: number,
    cursor?: string,
  ): CursorPage<ReviewPack> {
    const task = this.#taskById(taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const cursorRowId = this.#cursorRowId('review_packs', taskId, cursor)
    const rows = this.#database
      .prepare(
        `SELECT * FROM review_packs
         WHERE task_id = ? AND (? IS NULL OR rowid < ?)
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(
        taskId,
        cursorRowId,
        cursorRowId,
        limit + 1,
      ) as unknown as ReviewPackRow[]
    return cursorPage(rows, limit, toReviewPack)
  }

  listWorkerReports(runId: string, userId: string): WorkerReport[] {
    const run = this.#runById(runId)
    const task = this.#taskById(run.taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const rows = this.#database
      .prepare(
        `SELECT * FROM worker_reports
         WHERE run_id = ? ORDER BY report_sequence ASC`,
      )
      .all(runId)
    return rows.map(row => toWorkerReport(row as unknown as WorkerReportRow))
  }

  pageWorkerReports(
    runId: string,
    userId: string,
    limit: number,
    cursor?: string,
  ): CursorPage<WorkerReport> {
    const run = this.#runById(runId)
    const task = this.#taskById(run.taskId)
    if (task.userId !== userId) throw new Error('Task belongs to another user')
    const cursorRowId = this.#cursorRowId('worker_reports', runId, cursor)
    const rows = this.#database
      .prepare(
        `SELECT * FROM worker_reports
         WHERE run_id = ? AND (? IS NULL OR rowid < ?)
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(
        runId,
        cursorRowId,
        cursorRowId,
        limit + 1,
      ) as unknown as WorkerReportRow[]
    return cursorPage(rows, limit, toWorkerReport)
  }

  requestApproval(
    runId: string,
    claimToken: string,
    draft: ActionRequestDraft,
  ): { action: DurableAction; approval: Approval } {
    const fingerprint = createHash('sha256')
      .update(stableJson(draft))
      .digest('hex')
    const suppliedClaimHash = hashClaimToken(claimToken)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#database
        .prepare(
          `SELECT * FROM actions
           WHERE idempotency_key = ? AND protocol_version = 1`,
        )
        .get(draft.idempotencyKey) as unknown as ActionRow | undefined
      if (existing) {
        if (
          !existing.request_claim_hash ||
          !safeDigestEqual(suppliedClaimHash, existing.request_claim_hash)
        ) {
          throw new RunClaimError('Run claim capability is invalid')
        }
        if (
          existing.run_id !== runId ||
          existing.request_fingerprint !== fingerprint
        ) {
          throw new Error('Action idempotency key is already used')
        }
        const approval = this.#database
          .prepare('SELECT * FROM approvals WHERE action_id = ?')
          .get(existing.id) as unknown as ApprovalRow | undefined
        if (!approval) throw new Error('Approval record is missing')
        this.#database.exec('COMMIT')
        return initialApprovalResponse(existing, approval)
      }

      const claim = this.#claimForCapability(runId, claimToken)
      const run = this.#runById(runId)
      if (run.status !== 'running') throw new Error('Run is not executing')
      const task = this.#taskById(run.taskId)
      if (task.status === 'completed' || task.status === 'cancelled') {
        throw new Error('Task is closed')
      }
      const unresolvedPriorAction = this.#database
        .prepare(
          `SELECT status FROM actions
           WHERE resume_run_id = ? AND protocol_version = 1
             AND status IN ('authorized','failed','unknown')
           ORDER BY updated_at DESC, id DESC LIMIT 1`,
        )
        .get(runId) as
        { status: 'authorized' | 'failed' | 'unknown' } | undefined
      if (unresolvedPriorAction?.status === 'authorized') {
        throw new Error(
          'Authorized Action outcome must be recorded before requesting another Approval',
        )
      }
      if (unresolvedPriorAction) {
        throw new Error(
          `Action outcome must be reconciled before requesting another Approval (${unresolvedPriorAction.status})`,
        )
      }
      const confirmedFailedAction = this.#database
        .prepare(
          `SELECT 1 FROM action_reconciliations
           INNER JOIN actions ON actions.id = action_reconciliations.action_id
           WHERE actions.task_id = ?
             AND action_reconciliations.resolution = 'failed'
           LIMIT 1`,
        )
        .get(task.id)
      if (confirmedFailedAction) {
        throw new Error(
          'A human-confirmed failed Action blocks new Approvals on this Task',
        )
      }
      const now = this.#clock.now().toISOString()
      const actionId = randomUUID()
      const approvalId = randomUUID()
      this.#database
        .prepare(
          `INSERT INTO actions
            (id, task_id, run_id, kind, risk, idempotency_key, status,
             request_json, recovery_point_json, request_claim_hash,
             request_fingerprint, protocol_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          actionId,
          task.id,
          run.id,
          draft.kind,
          draft.risk,
          draft.idempotencyKey,
          JSON.stringify(draft.request),
          JSON.stringify(draft.recoveryPoint),
          claim.claimTokenHash,
          fingerprint,
          now,
          now,
        )
      this.#database
        .prepare(
          `INSERT INTO approvals
            (id, user_id, task_id, action_id, status, prompt_json,
             protocol_version, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?, 1, ?)`,
        )
        .run(
          approvalId,
          task.userId,
          task.id,
          actionId,
          JSON.stringify(draft.approval),
          now,
        )
      this.#database
        .prepare(
          `UPDATE runs SET status = 'waiting', claimed_by = NULL,
           lease_until = NULL, claim_token_hash = NULL, updated_at = ?
           WHERE id = ? AND status = 'running' AND claimed_by = ?`,
        )
        .run(now, run.id, claim.workerId)
      this.#database
        .prepare(
          `UPDATE tasks SET status = 'started', status_reason = 'awaiting_approval',
           ended_json = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(now, task.id)
      this.enqueueOutbox({
        userId: task.userId,
        taskId: task.id,
        channel: 'conversation',
        dedupeKey: `approval-required:${approvalId}`,
        payload: {
          type: 'approval.required',
          taskId: task.id,
          runId: run.id,
          approvalId,
          actionId,
          risk: draft.risk,
          summary: draft.approval.summary,
          impact: draft.approval.impact,
          prompt: draft.approval,
        },
      })
      const action = this.#actionById(actionId)
      const approval = this.#approvalById(approvalId)
      this.#database.exec('COMMIT')
      return { action, approval }
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  assertApprovalRequestCapability(runId: string, claimToken: string): void {
    const suppliedHash = hashClaimToken(claimToken)
    const replayRows = this.#database
      .prepare(
        `SELECT request_claim_hash FROM actions
         WHERE run_id = ? AND protocol_version = 1
           AND request_claim_hash IS NOT NULL`,
      )
      .all(runId) as { request_claim_hash: string }[]
    if (
      replayRows.some(row =>
        safeDigestEqual(suppliedHash, row.request_claim_hash),
      )
    )
      return
    this.#claimForCapability(runId, claimToken)
  }

  assertCollaborationCapability(runId: string, claimToken: string): void {
    const suppliedHash = hashClaimToken(claimToken)
    const replayRows = this.#database
      .prepare(
        `SELECT request_claim_hash FROM channel_relations
         WHERE source_run_id = ?`,
      )
      .all(runId) as { request_claim_hash: string }[]
    if (
      replayRows.some(row =>
        safeDigestEqual(suppliedHash, row.request_claim_hash),
      )
    )
      return
    this.#claimForCapability(runId, claimToken)
  }

  assertActionOutcomeCapability(actionId: string, claimToken: string): void {
    const suppliedHash = hashClaimToken(claimToken)
    const replayRows = this.#database
      .prepare(
        `SELECT claim_token_hash FROM action_outcomes
         WHERE action_id = ?`,
      )
      .all(actionId) as { claim_token_hash: string }[]
    if (
      replayRows.some(row =>
        safeDigestEqual(suppliedHash, row.claim_token_hash),
      )
    )
      return
    const action = this.#database
      .prepare(
        `SELECT resume_run_id FROM actions
         WHERE id = ? AND protocol_version = 1`,
      )
      .get(actionId) as { resume_run_id: string | null } | undefined
    if (!action?.resume_run_id) {
      throw new RunClaimError('Run claim capability is invalid')
    }
    this.#claimForCapability(action.resume_run_id, claimToken)
  }

  getApproval(approvalId: string, userId: string): Approval | undefined {
    const row = this.#database
      .prepare(
        `SELECT approvals.* FROM approvals
         INNER JOIN tasks ON tasks.id = approvals.task_id
         INNER JOIN actions ON actions.id = approvals.action_id
         WHERE approvals.id = ? AND tasks.user_id = ?
           AND approvals.protocol_version = 1
           AND actions.protocol_version = 1`,
      )
      .get(approvalId, userId) as unknown as ApprovalRow | undefined
    return row ? this.#approvalFromRow(row) : undefined
  }

  getAction(actionId: string, userId: string): DurableAction | undefined {
    const row = this.#database
      .prepare(
        `SELECT actions.* FROM actions
         INNER JOIN tasks ON tasks.id = actions.task_id
         WHERE actions.id = ? AND tasks.user_id = ?
           AND actions.protocol_version = 1`,
      )
      .get(actionId, userId) as unknown as ActionRow | undefined
    return row ? this.#actionWithReconciliation(row) : undefined
  }

  reconcileAction(
    actionId: string,
    userId: string,
    draft: ActionReconciliationDraft,
  ): DurableAction {
    const fingerprint = createHash('sha256')
      .update(stableJson(draft))
      .digest('hex')
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const replay = this.#database
        .prepare(
          `SELECT action_id, request_fingerprint FROM action_reconciliations
           WHERE command_id = ?`,
        )
        .get(draft.commandId) as
        { action_id: string; request_fingerprint: string } | undefined
      if (replay) {
        if (replay.request_fingerprint !== fingerprint)
          throw new ActionReconciliationConflictError(
            'Reconciliation command ID is already used with a different payload',
          )
        const replayed = this.getAction(replay.action_id, userId)
        if (replayed?.id !== actionId)
          throw new ActionNotFoundError('Action not found')
        this.#database.exec('COMMIT')
        return replayed
      }
      const row = this.#database
        .prepare(
          `SELECT actions.* FROM actions
           INNER JOIN tasks ON tasks.id = actions.task_id
           WHERE actions.id = ? AND tasks.user_id = ?
             AND actions.protocol_version = 1`,
        )
        .get(actionId, userId) as unknown as ActionRow | undefined
      if (!row) throw new ActionNotFoundError('Action not found')
      const existingForAction = this.#database
        .prepare('SELECT 1 FROM action_reconciliations WHERE action_id = ?')
        .get(actionId)
      if (existingForAction)
        throw new ActionReconciliationConflictError(
          'Action already has a reconciliation record',
        )
      if (row.status !== 'failed' && row.status !== 'unknown')
        throw new Error('Only a failed or unknown Action can be reconciled')
      const now = this.#clock.now().toISOString()
      this.#database
        .prepare(
          `INSERT INTO action_reconciliations
            (id, action_id, command_id, resolution, note, previous_status,
             previous_result_json, request_fingerprint, reconciled_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          actionId,
          draft.commandId,
          draft.resolution,
          draft.note,
          row.status,
          row.result_json,
          fingerprint,
          userId,
          now,
        )
      // The original outcome stays auditable in the reconciliation record;
      // the Action itself now carries the human-confirmed external fact.
      this.#database
        .prepare(
          `UPDATE actions SET status = 'reconciled', result_json = ?,
           updated_at = ? WHERE id = ?`,
        )
        .run(
          JSON.stringify({
            resolution: draft.resolution,
            note: draft.note,
            previousStatus: row.status,
            ...(row.result_json
              ? {
                  previousResult: JSON.parse(row.result_json) as unknown,
                }
              : {}),
          }),
          now,
          actionId,
        )
      if (draft.resolution === 'succeeded') {
        this.#wakeBlockedTaskEvents(row.task_id, now)
      }
      const task = this.#taskById(row.task_id)
      if (task.status !== 'completed' && task.status !== 'cancelled') {
        const stillBlocked = this.#database
          .prepare(
            `SELECT 1 FROM actions
             WHERE task_id = ? AND protocol_version = 1
               AND status IN ('awaiting_approval','authorized','failed','unknown')
             LIMIT 1`,
          )
          .get(task.id)
        if (!stillBlocked) {
          this.#database
            .prepare(
              `UPDATE tasks SET status_reason = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              draft.resolution === 'succeeded'
                ? 'action_reconciled'
                : 'action_failed',
              now,
              task.id,
            )
        }
      }
      this.enqueueOutbox({
        userId,
        taskId: row.task_id,
        channel: 'conversation',
        dedupeKey: `action-reconciled:${actionId}`,
        payload: {
          type: 'action.reconciled',
          taskId: row.task_id,
          actionId,
          resolution: draft.resolution,
          text:
            draft.resolution === 'succeeded'
              ? '已人工核对：动作确认成功，事情可以继续。'
              : '已人工核对：动作确认失败，外部状态已记录。',
        },
      })
      const reconciled = this.getAction(actionId, userId)
      if (!reconciled) throw new ActionNotFoundError('Action not found')
      this.#database.exec('COMMIT')
      return reconciled
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #actionWithReconciliation(row: ActionRow): DurableAction {
    const action = toDurableAction(row)
    const reconciliation = this.#database
      .prepare('SELECT * FROM action_reconciliations WHERE action_id = ?')
      .get(row.id) as unknown as ActionReconciliationRow | undefined
    return reconciliation
      ? { ...action, reconciliation: toActionReconciliation(reconciliation) }
      : action
  }

  pageApprovals(
    userId: string,
    limit: number,
    cursor?: string,
    status?: Approval['status'],
  ): CursorPage<Approval> {
    let cursorCreatedAt: string | null = null
    let cursorId: string | null = null
    if (cursor) {
      const cursorRow = this.#database
        .prepare(
          `SELECT approvals.created_at, approvals.id FROM approvals
           INNER JOIN actions ON actions.id = approvals.action_id
           WHERE approvals.id = ? AND approvals.user_id = ?
             AND approvals.protocol_version = 1
             AND actions.protocol_version = 1
             AND (? IS NULL OR approvals.status = ?)`,
        )
        .get(cursor, userId, status ?? null, status ?? null) as
        { created_at: string; id: string } | undefined
      if (!cursorRow) throw new Error('Pagination cursor is invalid')
      cursorCreatedAt = cursorRow.created_at
      cursorId = cursorRow.id
    }
    const projection = `SELECT approvals.*, actions.run_id AS request_run_id,
      approval_decisions.id AS decision_id,
      approval_decisions.event_id AS decision_event_id,
      approval_decisions.command_id AS decision_command_id,
      approval_decisions.user_id AS decision_user_id,
      approval_decisions.option_id AS decision_option_id,
      approval_decisions.kind AS decision_kind,
      approval_decisions.rationale AS decision_rationale,
      approval_decisions.decided_at AS decision_decided_at,
      approval_decisions.applied_at AS decision_applied_at
      FROM approvals
      INNER JOIN actions ON actions.id = approvals.action_id
      LEFT JOIN approval_decisions ON approval_decisions.approval_id = approvals.id`
    const cursorPredicate = `AND (? IS NULL OR approvals.created_at < ?
      OR (approvals.created_at = ? AND approvals.id < ?))`
    const rows = (status
      ? this.#database
          .prepare(
            `${projection}
             WHERE approvals.user_id = ? AND approvals.status = ?
               AND approvals.protocol_version = 1
               AND actions.protocol_version = 1 ${cursorPredicate}
             ORDER BY approvals.created_at DESC, approvals.id DESC LIMIT ?`,
          )
          .all(
            userId,
            status,
            cursorCreatedAt,
            cursorCreatedAt,
            cursorCreatedAt,
            cursorId,
            limit + 1,
          )
      : this.#database
          .prepare(
            `${projection}
             WHERE approvals.user_id = ? AND approvals.protocol_version = 1
               AND actions.protocol_version = 1
               ${cursorPredicate}
             ORDER BY approvals.created_at DESC, approvals.id DESC LIMIT ?`,
          )
          .all(
            userId,
            cursorCreatedAt,
            cursorCreatedAt,
            cursorCreatedAt,
            cursorId,
            limit + 1,
          )) as unknown as ApprovalProjectionRow[]
    return cursorPage(rows, limit, toApprovalProjection)
  }

  decideApproval(
    approvalId: string,
    userId: string,
    draft: ApprovalDecisionDraft,
  ): { approval: Approval; decision: ApprovalDecision; event: InboxEvent } {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const byCommand = this.#database
        .prepare('SELECT * FROM approval_decisions WHERE command_id = ?')
        .get(draft.commandId) as unknown as ApprovalDecisionRow | undefined
      if (byCommand) {
        if (
          byCommand.approval_id !== approvalId ||
          byCommand.user_id !== userId ||
          byCommand.option_id !== draft.optionId ||
          (byCommand.rationale ?? undefined) !== draft.rationale
        ) {
          throw new Error('Decision command ID is already used')
        }
        const approval = this.#approvalById(approvalId)
        const event = this.#eventById(byCommand.event_id)
        this.#database.exec('COMMIT')
        return { approval, decision: toApprovalDecision(byCommand), event }
      }

      const approval = this.#approvalById(approvalId)
      const task = this.#taskById(approval.taskId)
      if (task.userId !== userId)
        throw new Error('Task belongs to another user')
      const existingDecision = this.#database
        .prepare('SELECT * FROM approval_decisions WHERE approval_id = ?')
        .get(approvalId) as unknown as ApprovalDecisionRow | undefined
      if (existingDecision) {
        if (
          existingDecision.user_id !== userId ||
          existingDecision.option_id !== draft.optionId ||
          (existingDecision.rationale ?? undefined) !== draft.rationale
        ) {
          throw new Error('Approval has already been decided')
        }
        const event = this.#eventById(existingDecision.event_id)
        this.#database.exec('COMMIT')
        return {
          approval,
          decision: toApprovalDecision(existingDecision),
          event,
        }
      }
      if (task.status === 'completed' || task.status === 'cancelled') {
        throw new Error('Task is closed')
      }
      if (approval.status !== 'pending') {
        throw new Error('Approval has already been decided')
      }
      const option = approval.prompt.options.find(
        option => option.id === draft.optionId,
      )
      if (!option) throw new Error('Approval option does not exist')

      const now = this.#clock.now().toISOString()
      const decisionId = randomUUID()
      const event = this.enqueueEvent({
        userId,
        type: 'approval.decided',
        source: 'approval',
        dedupeKey: `approval-decision:${approvalId}`,
        payload: { approvalId, decisionId },
      }).event
      this.#database
        .prepare(
          `INSERT INTO approval_decisions
            (id, approval_id, event_id, command_id, user_id, option_id, kind,
             rationale, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decisionId,
          approvalId,
          event.id,
          draft.commandId,
          userId,
          option.id,
          option.kind,
          draft.rationale ?? null,
          now,
        )
      this.#database
        .prepare(
          `UPDATE approvals SET status = 'decision_recorded'
           WHERE id = ? AND status = 'pending'`,
        )
        .run(approvalId)
      this.#applyApprovalDecisionInTransaction(event)
      const decision = this.#decisionByApprovalId(approvalId)
      const updated = this.#approvalById(approvalId)
      this.#database.exec('COMMIT')
      return { approval: updated, decision, event }
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  applyApprovalDecision(event: InboxEvent): Run | undefined {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const successor = this.#applyApprovalDecisionInTransaction(event)
      this.#database.exec('COMMIT')
      return successor
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #applyApprovalDecisionInTransaction(event: InboxEvent): Run | undefined {
    const row = this.#database
      .prepare('SELECT * FROM approval_decisions WHERE event_id = ?')
      .get(event.id) as unknown as ApprovalDecisionRow | undefined
    if (
      !row ||
      event.type !== 'approval.decided' ||
      event.source !== 'approval'
    ) {
      throw new Error('Approval decision event is not trusted')
    }
    if (row.user_id !== event.userId) {
      throw new Error('Approval decision event belongs to another user')
    }
    const approval = this.#approvalById(row.approval_id)
    const action = this.#actionById(approval.actionId)
    const task = this.#taskById(approval.taskId)
    if (task.userId !== event.userId) {
      throw new Error('Task belongs to another user')
    }
    if (row.applied_at) {
      const resumed = action.resumeRunId
        ? this.#runById(action.resumeRunId)
        : undefined
      return resumed
    }
    const now = this.#clock.now().toISOString()
    if (task.status === 'cancelled') {
      this.#database
        .prepare(
          `UPDATE approvals SET status = 'cancelled', resolved_at = ? WHERE id = ?`,
        )
        .run(now, approval.id)
      this.#database
        .prepare('UPDATE approval_decisions SET applied_at = ? WHERE id = ?')
        .run(now, row.id)
      return undefined
    }
    const original = this.#runById(action.requestRunId)
    if (original.status !== 'waiting' && original.status !== 'cancelled') {
      throw new Error('Approval source Run is not waiting')
    }
    let successor: Run | undefined
    if (action.resumeRunId) {
      successor = this.#runById(action.resumeRunId)
    } else {
      const successorId = randomUUID()
      const decisionContext = {
        type: 'approval.decision',
        approvalId: approval.id,
        actionId: action.id,
        optionId: row.option_id,
        decision: row.kind,
        ...(row.rationale ? { rationale: row.rationale } : {}),
        action: {
          kind: action.kind,
          risk: action.risk,
          request: action.request,
          recoveryPoint: action.recoveryPoint,
        },
      }
      this.#database
        .prepare(
          `INSERT INTO runs
              (id, task_id, retry_of_run_id, executor, resume_from_ref,
               goal_revision, status, input_json, execution_context_json,
               execution_contract_version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        )
        .run(
          successorId,
          task.id,
          original.id,
          original.executor,
          original.executorRef ?? original.resumeFromRef ?? null,
          original.goalRevision ?? null,
          JSON.stringify(JSON.stringify(decisionContext)),
          JSON.stringify(original.executionContext),
          original.executionContractVersion,
          now,
          now,
        )
      this.#database
        .prepare(
          `UPDATE actions SET resume_run_id = ?, status = ?, updated_at = ?
             WHERE id = ?`,
        )
        .run(
          successorId,
          row.kind === 'approve' ? 'authorized' : 'rejected',
          now,
          action.id,
        )
      successor = this.#runById(successorId)
    }
    this.#database
      .prepare(
        `UPDATE runs SET status = 'cancelled', claimed_by = NULL,
           lease_until = NULL, claim_token_hash = NULL,
           last_error = 'superseded_by_approval_decision', updated_at = ?
           WHERE id = ? AND status = 'waiting'`,
      )
      .run(now, original.id)
    this.#database
      .prepare(`UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?`)
      .run(
        row.kind === 'approve'
          ? 'approved'
          : row.kind === 'reject'
            ? 'rejected'
            : 'revision_requested',
        now,
        approval.id,
      )
    this.#database
      .prepare('UPDATE approval_decisions SET applied_at = ? WHERE id = ?')
      .run(now, row.id)
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO task_events
            (event_id, task_id, relation, created_at)
           VALUES (?, ?, 'approval_decision', ?)`,
      )
      .run(event.id, task.id, now)
    this.#database
      .prepare(
        `UPDATE tasks SET status = 'started', status_reason = 'approval_resolved',
           ended_json = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(now, task.id)
    this.enqueueOutbox({
      userId: task.userId,
      taskId: task.id,
      channel: 'conversation',
      dedupeKey: `approval-resolved:${approval.id}`,
      payload: {
        type: 'approval.resolved',
        taskId: task.id,
        approvalId: approval.id,
        actionId: action.id,
        decision: row.kind,
        runId: successor.id,
      },
    })
    if (row.kind !== 'approve') this.#wakeBlockedTaskEvents(task.id, now)
    return successor
  }

  recordActionOutcome(
    actionId: string,
    claimToken: string,
    draft: ActionOutcomeDraft,
  ): DurableAction {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#database
        .prepare('SELECT * FROM action_outcomes WHERE command_id = ?')
        .get(draft.commandId) as
        | {
            action_id: string
            status: string
            result_json: string
            claim_token_hash: string
          }
        | undefined
      if (existing) {
        const suppliedHash = hashClaimToken(claimToken)
        if (!safeDigestEqual(suppliedHash, existing.claim_token_hash)) {
          throw new RunClaimError('Run claim capability is invalid')
        }
        if (
          existing.action_id !== actionId ||
          existing.status !== draft.status ||
          stableJson(JSON.parse(existing.result_json)) !==
            stableJson(draft.result)
        ) {
          throw new Error('Action outcome command ID is already used')
        }
        const action = this.#actionById(actionId)
        this.#database.exec('COMMIT')
        return action
      }
      const actionRow = this.#database
        .prepare('SELECT * FROM actions WHERE id = ? AND protocol_version = 1')
        .get(actionId) as unknown as ActionRow | undefined
      if (!actionRow?.resume_run_id) {
        throw new RunClaimError('Run claim capability is invalid')
      }
      const claim = this.#claimForCapability(
        actionRow.resume_run_id,
        claimToken,
      )
      const action = toDurableAction(actionRow)
      if (action.status !== 'authorized') {
        throw new Error('Only an authorized Action can record an outcome')
      }
      const existingForAction = this.#database
        .prepare('SELECT 1 FROM action_outcomes WHERE action_id = ?')
        .get(actionId)
      if (existingForAction) throw new Error('Action outcome already exists')
      const now = this.#clock.now().toISOString()
      this.#database
        .prepare(
          `INSERT INTO action_outcomes
            (id, action_id, run_id, command_id, status, result_json,
             claim_token_hash, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          actionId,
          actionRow.resume_run_id,
          draft.commandId,
          draft.status,
          JSON.stringify(draft.result),
          claim.claimTokenHash,
          now,
        )
      this.#database
        .prepare(
          `UPDATE actions SET status = ?, result_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(draft.status, JSON.stringify(draft.result), now, actionId)
      if (draft.status === 'succeeded') {
        this.#wakeBlockedTaskEvents(action.taskId, now)
      }
      const updated = this.#actionById(actionId)
      this.#database.exec('COMMIT')
      return updated
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  claimNextRun(workerId: string, leaseMs = 30_000): ClaimedRun | undefined {
    const now = this.#clock.now()
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString()
    const claimToken = randomUUID()
    const claimTokenHash = hashClaimToken(claimToken)
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      let row = this.#database
        .prepare(
          `SELECT * FROM runs
           WHERE task_id IN (SELECT id FROM tasks WHERE status NOT IN ('completed','cancelled'))
           AND execution_contract_version <= 2
           AND ((status = 'queued' AND NOT EXISTS (
             SELECT 1 FROM runs AS active WHERE active.task_id = runs.task_id AND active.status = 'running'
           ) AND NOT EXISTS (
             SELECT 1 FROM actions
             WHERE actions.task_id = runs.task_id
               AND actions.protocol_version = 1
               AND actions.status IN ('awaiting_approval','authorized','failed','unknown')
               AND (actions.resume_run_id IS NULL OR actions.resume_run_id <> runs.id)
           )) OR (status = 'running' AND lease_until <= ?)
             OR (status = 'waiting' AND lease_until <= ? AND task_id IN (
               SELECT id FROM tasks WHERE status_reason = 'awaiting_evidence'
             )))
           ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        )
        .get(now.toISOString(), now.toISOString()) as unknown as
        RunRow | undefined
      if (!row) {
        this.#database.exec('COMMIT')
        return undefined
      }

      let phase: ClaimedRun['phase'] =
        row.status === 'waiting' ? 'report' : 'execute'
      if (row.status === 'queued') {
        const revokedApproval = this.#database
          .prepare(
            `SELECT actions.id FROM actions
             INNER JOIN approvals ON approvals.action_id = actions.id
             WHERE actions.resume_run_id = ?
               AND actions.protocol_version = 1
               AND approvals.protocol_version = 1
               AND approvals.status = 'approved'
               AND actions.status <> 'authorized'`,
          )
          .get(row.id) as { id: string } | undefined
        if (revokedApproval) {
          this.#database
            .prepare(
              `UPDATE runs SET status = 'cancelled', last_error = 'approval_authorization_revoked',
               claimed_by = NULL, lease_until = NULL, claim_token_hash = NULL,
               updated_at = ? WHERE id = ?`,
            )
            .run(now.toISOString(), row.id)
          this.#database.exec('COMMIT')
          return undefined
        }
      }
      if (row.status === 'running') {
        const interruptedAction = this.#database
          .prepare(
            `SELECT * FROM actions WHERE resume_run_id = ?
             AND protocol_version = 1
             AND status IN ('authorized','succeeded','failed','unknown')`,
          )
          .get(row.id) as unknown as ActionRow | undefined
        if (interruptedAction) {
          const hadOutcome = interruptedAction.status !== 'authorized'
          const reason = {
            reason: hadOutcome
              ? 'run_lease_expired_after_outcome'
              : 'run_lease_expired_before_outcome',
            runId: row.id,
          }
          this.#database
            .prepare(
              `UPDATE actions SET status = 'unknown', result_json = ?, updated_at = ?
               WHERE id = ? AND status = 'authorized'`,
            )
            .run(
              JSON.stringify(reason),
              now.toISOString(),
              interruptedAction.id,
            )
          this.#database
            .prepare(
              `UPDATE runs SET status = 'failed', last_error = ?, claimed_by = NULL,
               lease_until = NULL, claim_token_hash = NULL, updated_at = ? WHERE id = ?`,
            )
            .run(
              hadOutcome
                ? 'action_resume_interrupted_after_outcome'
                : 'action_outcome_unknown_after_lease_expiry',
              now.toISOString(),
              row.id,
            )
          const task = this.#taskById(row.task_id)
          this.#database
            .prepare(
              `UPDATE tasks SET status = 'started', status_reason = ?,
               updated_at = ? WHERE id = ?`,
            )
            .run(
              hadOutcome
                ? 'action_resume_interrupted'
                : 'action_outcome_unknown',
              now.toISOString(),
              task.id,
            )
          this.enqueueOutbox({
            userId: task.userId,
            taskId: task.id,
            channel: 'conversation',
            dedupeKey: `action-reconciliation-required:${interruptedAction.id}`,
            payload: {
              type: 'action.reconciliation_required',
              taskId: task.id,
              runId: row.id,
              actionId: interruptedAction.id,
              text: hadOutcome
                ? '高风险动作已记录结果，但恢复流程中断，需要核对后再继续。'
                : '高风险动作在执行期间中断，结果未知，需要核对后再继续。',
            },
          })
          this.#database.exec('COMMIT')
          return undefined
        }
        this.#database
          .prepare(
            `UPDATE runs SET status = 'failed', last_error = 'lease_expired', claimed_by = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(now.toISOString(), row.id)
        const replacement = this.#createRetry(row, now.toISOString())
        row = this.#database
          .prepare('SELECT * FROM runs WHERE id = ?')
          .get(replacement.id) as unknown as RunRow
        phase = 'execute'
      }

      if (phase === 'report') {
        this.#database
          .prepare(
            `UPDATE runs SET claimed_by = NULL, lease_until = NULL,
             claim_token_hash = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(now.toISOString(), row.id)
        this.#database
          .prepare(
            `UPDATE runs SET claimed_by = ?, lease_until = ?,
             claim_token_hash = ?, claimed_contract_version = 2,
             updated_at = ? WHERE id = ?`,
          )
          .run(workerId, leaseUntil, claimTokenHash, now.toISOString(), row.id)
      } else {
        this.#database
          .prepare(
            `UPDATE runs
             SET status = 'running', claimed_by = ?, lease_until = ?,
                 claim_token_hash = ?, claimed_contract_version = 2,
                 attempts = attempts + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(workerId, leaseUntil, claimTokenHash, now.toISOString(), row.id)
      }
      if (phase === 'execute') {
        this.#database
          .prepare(
            `UPDATE tasks SET status = 'started', status_reason = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(now.toISOString(), row.task_id)
      }
      const run = this.#runById(row.id)
      const task = this.#taskById(row.task_id)
      this.#database.exec('COMMIT')
      return { run, task, claimToken, phase }
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

  renewRunLeaseAndCheckSteering(
    runId: string,
    workerId: string,
    leaseMs = 30_000,
  ): boolean {
    const now = this.#clock.now()
    this.#database.exec('BEGIN IMMEDIATE')
    let row: { steering_json: string | null } | undefined
    try {
      row = this.#database
        .prepare(
          `UPDATE runs SET lease_until = ?, updated_at = ?
           WHERE id = ? AND status = 'running' AND claimed_by = ?
           RETURNING steering_json`,
        )
        .get(
          new Date(now.getTime() + leaseMs).toISOString(),
          now.toISOString(),
          runId,
          workerId,
        ) as { steering_json: string | null } | undefined
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    if (!row) throw new Error(`Worker ${workerId} does not own run ${runId}`)
    return row.steering_json !== null
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

  completeRun(runId: string, workerId: string, result: ExecutorResult): void {
    const nowDate = this.#clock.now()
    const now = nowDate.toISOString()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const run = this.#runById(runId)
      if (run.claimedBy !== workerId || run.status !== 'running') {
        throw new Error(`Worker ${workerId} does not own run ${runId}`)
      }
      const pendingSteering = this.#database
        .prepare('SELECT steering_json FROM runs WHERE id = ?')
        .get(runId) as { steering_json: string | null }
      if (pendingSteering.steering_json) {
        // A user correction arrived while the Executor was finishing. Do not
        // complete the Task on stale instructions; the Worker parks this
        // attempt and a successor resumes the session with the correction.
        throw new Error('Run has pending steering directives')
      }
      const task = this.#taskById(run.taskId)
      const resumedAction = this.#database
        .prepare(
          `SELECT * FROM actions WHERE resume_run_id = ?
           AND protocol_version = 1`,
        )
        .get(runId) as unknown as ActionRow | undefined
      if (resumedAction?.status === 'authorized') {
        this.#database
          .prepare(
            `UPDATE actions SET status = 'unknown', result_json = ?, updated_at = ?
             WHERE id = ? AND status = 'authorized'`,
          )
          .run(
            JSON.stringify({ reason: 'executor_completed_without_outcome' }),
            now,
            resumedAction.id,
          )
      }
      const blockingActionRow = this.#database
        .prepare(
          `SELECT * FROM actions
           WHERE task_id = ? AND protocol_version = 1
             AND status IN ('awaiting_approval','authorized','failed','unknown')
           ORDER BY CASE status
             WHEN 'unknown' THEN 0
             WHEN 'failed' THEN 1
             WHEN 'authorized' THEN 2
             ELSE 3
           END, updated_at DESC, id DESC
           LIMIT 1`,
        )
        .get(task.id) as unknown as ActionRow | undefined
      const blockingAction = blockingActionRow
        ? toDurableAction(blockingActionRow)
        : undefined
      const actionStatus = blockingAction?.status
      const actionBlocksCompletion =
        actionStatus === 'awaiting_approval' ||
        actionStatus === 'authorized' ||
        actionStatus === 'failed' ||
        actionStatus === 'unknown'
      const hasPendingWork = Boolean(
        this.#database
          .prepare(
            `SELECT 1 FROM runs
             WHERE task_id = ? AND id <> ? AND status IN ('queued','running','waiting')
             LIMIT 1`,
          )
          .get(task.id, runId),
      )
      const requiresEvidence = Boolean(
        this.currentGoalContract(task.id, task.userId),
      )
      const awaitingClarification =
        task.statusReason === 'awaiting_goal_clarification'
      const runStatus =
        actionStatus === 'failed'
          ? 'failed'
          : awaitingClarification
            ? 'cancelled'
            : actionBlocksCompletion || requiresEvidence
              ? 'waiting'
              : 'completed'
      this.#database
        .prepare(
          `UPDATE runs
           SET status = ?, executor_ref = ?, output_json = ?,
               claimed_by = ?, lease_until = ?,
               last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          runStatus,
          result.executorRef,
          JSON.stringify(result.output),
          requiresEvidence && !actionBlocksCompletion && !awaitingClarification
            ? workerId
            : null,
          requiresEvidence && !actionBlocksCompletion && !awaitingClarification
            ? new Date(nowDate.getTime() + 30_000).toISOString()
            : null,
          awaitingClarification ? 'awaiting_goal_clarification' : null,
          now,
          runId,
        )
      const usage = result.usage
      this.#database
        .prepare(
          `INSERT INTO model_usage_records
            (run_id, task_id, user_id, executor, model_ref, completeness,
             token_source, input_tokens, output_tokens, total_tokens,
             cache_read_tokens, cache_write_tokens, reasoning_tokens,
             reported_steps, unreported_steps, duration_ms, latency_source,
             cost_usd, cost_source, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          task.id,
          task.userId,
          run.executor,
          run.executionContext.model ?? null,
          usage
            ? usage.unreportedSteps > 0
              ? 'partial'
              : 'complete'
            : 'unavailable',
          usage?.source ?? null,
          usage?.tokens.inputTokens ?? null,
          usage?.tokens.outputTokens ?? null,
          usage?.tokens.totalTokens ?? null,
          usage?.tokens.cacheReadTokens ?? null,
          usage?.tokens.cacheWriteTokens ?? null,
          usage?.tokens.reasoningTokens ?? null,
          usage?.reportedSteps ?? 0,
          usage?.unreportedSteps ?? 0,
          result.durationMs ?? null,
          result.durationMs === undefined ? null : 'pegas_observed',
          usage?.costUsd ?? null,
          usage?.costSource ?? null,
          now,
        )
      this.#database
        .prepare(
          `UPDATE tasks
           SET status = ?, status_reason = ?,
               ended_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          actionBlocksCompletion || requiresEvidence || hasPendingWork
            ? 'started'
            : 'completed',
          awaitingClarification
            ? 'awaiting_goal_clarification'
            : actionStatus === 'unknown'
              ? 'action_outcome_unknown'
              : actionStatus === 'failed'
                ? 'action_failed'
                : actionStatus === 'authorized'
                  ? 'action_outcome_pending'
                  : actionStatus === 'awaiting_approval'
                    ? 'awaiting_approval'
                    : requiresEvidence
                      ? 'awaiting_evidence'
                      : null,
          actionBlocksCompletion || requiresEvidence || hasPendingWork
            ? null
            : JSON.stringify({
                at: now,
                by: 'executor',
                outcome: 'completed',
              }),
          now,
          task.id,
        )
      this.enqueueOutbox({
        userId: task.userId,
        taskId: task.id,
        channel: 'conversation',
        dedupeKey: awaitingClarification
          ? `goal-clarification-run-ended:${runId}`
          : actionStatus === 'unknown'
            ? `action-outcome-unknown:${blockingAction?.id ?? runId}`
            : actionStatus === 'failed'
              ? `action-failed:${blockingAction?.id ?? runId}`
              : actionStatus === 'authorized'
                ? `action-outcome-pending:${blockingAction?.id ?? runId}`
                : actionStatus === 'awaiting_approval'
                  ? `approval-pending:${blockingAction?.id ?? runId}`
                  : requiresEvidence
                    ? `goal-report-required:${runId}`
                    : `run-completed:${runId}`,
        payload: {
          type: awaitingClarification
            ? 'goal.clarification_wait'
            : actionStatus === 'unknown'
              ? 'action.outcome_unknown'
              : actionStatus === 'failed'
                ? 'action.failed'
                : actionStatus === 'authorized'
                  ? 'action.outcome_pending'
                  : actionStatus === 'awaiting_approval'
                    ? 'approval.pending'
                    : requiresEvidence
                      ? 'goal.report_required'
                      : 'run.completed',
          taskId: task.id,
          runId,
          ...(blockingAction ? { actionId: blockingAction.id } : {}),
          text: result.output,
        },
      })
      if (!actionBlocksCompletion && !requiresEvidence && !hasPendingWork) {
        this.#settleInboundCollaborations(
          task.id,
          'completed',
          result.output,
          runId,
          now,
        )
        this.#failUndeliveredContextNotes(
          task.id,
          'failed',
          'Target Task completed before the context note was delivered.',
          now,
        )
      }
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  listModelUsage(userId: string, taskId?: string): ModelUsageReport {
    const rows = this.#database
      .prepare(
        `SELECT
           runs.id AS run_id,
           runs.task_id,
           tasks.user_id,
           tasks.worker_icon_id,
           runs.executor,
           model_usage_records.model_ref,
           model_usage_records.completeness,
           model_usage_records.token_source,
           model_usage_records.input_tokens,
           model_usage_records.output_tokens,
           model_usage_records.total_tokens,
           model_usage_records.cache_read_tokens,
           model_usage_records.cache_write_tokens,
           model_usage_records.reasoning_tokens,
           model_usage_records.reported_steps,
           model_usage_records.unreported_steps,
           model_usage_records.duration_ms,
           model_usage_records.latency_source,
           model_usage_records.cost_usd,
           model_usage_records.cost_source,
           model_usage_records.observed_at,
           runs.updated_at AS run_updated_at
         FROM runs
         JOIN tasks ON tasks.id = runs.task_id
         LEFT JOIN model_usage_records ON model_usage_records.run_id = runs.id
         WHERE tasks.user_id = ? AND runs.status = 'completed'
           AND (? IS NULL OR runs.task_id = ?)
         ORDER BY runs.updated_at DESC, runs.id DESC`,
      )
      .all(userId, taskId ?? null, taskId ?? null) as unknown as ModelUsageRow[]
    const records = rows.map(toModelUsageRecord)
    return { summary: summarizeModelUsage(records), records }
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
      const resumedActionRow = this.#database
        .prepare(
          `SELECT * FROM actions WHERE resume_run_id = ?
           AND protocol_version = 1`,
        )
        .get(runId) as unknown as ActionRow | undefined
      let actionStatus = resumedActionRow?.status
      if (resumedActionRow?.status === 'authorized') {
        actionStatus = 'unknown'
        this.#database
          .prepare(
            `UPDATE actions SET status = 'unknown', result_json = ?, updated_at = ?
             WHERE id = ? AND status = 'authorized'`,
          )
          .run(
            JSON.stringify({ reason: 'run_failed_before_outcome', error }),
            now,
            resumedActionRow.id,
          )
      }
      this.#database
        .prepare(
          `UPDATE runs
           SET status = 'failed', claimed_by = NULL, lease_until = NULL,
               last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(error, now, runId)
      this.#database
        .prepare(
          `UPDATE tasks SET status = 'started', status_reason = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          actionStatus === 'unknown'
            ? 'action_outcome_unknown'
            : actionStatus === 'failed'
              ? 'action_failed'
              : actionStatus === 'succeeded'
                ? 'action_resume_interrupted'
                : 'last_run_failed',
          now,
          task.id,
        )
      const actionId = resumedActionRow?.id
      this.enqueueOutbox({
        userId: task.userId,
        taskId: task.id,
        channel: 'conversation',
        dedupeKey:
          actionStatus === 'unknown'
            ? `action-outcome-unknown:${actionId ?? runId}`
            : actionStatus === 'failed'
              ? `action-failed:${actionId ?? runId}`
              : actionStatus === 'succeeded'
                ? `action-reconciliation-required:${actionId ?? runId}`
                : `run-failed:${runId}`,
        payload:
          actionStatus === 'unknown'
            ? {
                type: 'action.outcome_unknown',
                taskId: task.id,
                runId,
                actionId,
                text: '高风险动作执行失败且尚未记录结果，需要核对后再继续。',
                error,
              }
            : actionStatus === 'failed'
              ? {
                  type: 'action.failed',
                  taskId: task.id,
                  runId,
                  actionId,
                  text: '高风险动作已记录失败，恢复流程已停止。',
                  error,
                }
              : actionStatus === 'succeeded'
                ? {
                    type: 'action.reconciliation_required',
                    taskId: task.id,
                    runId,
                    actionId,
                    text: '高风险动作已成功，但后续恢复流程失败，需要核对后再继续。',
                    error,
                  }
                : { type: 'run.failed', taskId: task.id, runId, error },
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
      if (
        this.#database
          .prepare(
            `SELECT 1 FROM actions
             WHERE protocol_version = 1 AND (
               (resume_run_id = ? AND status IN ('authorized','succeeded','failed','unknown'))
               OR (task_id = ? AND status IN ('awaiting_approval','authorized','failed','unknown'))
             )`,
          )
          .get(runId, task.id)
      ) {
        throw new Error('Action outcome must be reconciled before retrying')
      }
      const unreconciledResolution = this.#database
        .prepare(
          `SELECT 1 FROM action_reconciliations
           INNER JOIN actions ON actions.id = action_reconciliations.action_id
           WHERE actions.task_id = ?
             AND action_reconciliations.resolution = 'failed'
           LIMIT 1`,
        )
        .get(task.id)
      if (unreconciledResolution) {
        throw new Error(
          'A human-confirmed failed Action blocks retrying this Task',
        )
      }
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

  stopTask(
    taskId: string,
    userId: string,
    commandId: string,
    reason?: string,
  ): Task {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const task = this.#taskById(taskId)
      if (task.userId !== userId)
        throw new Error('Task belongs to another user')
      const existing = this.#database
        .prepare('SELECT task_id, kind FROM task_commands WHERE command_id = ?')
        .get(commandId) as { task_id: string; kind: string } | undefined
      if (existing) {
        if (existing.task_id !== taskId || existing.kind !== 'stop')
          throw new Error('Command ID is already used')
        this.#database.exec('COMMIT')
        return task
      }
      if (task.status === 'cancelled') {
        this.#database
          .prepare(
            `INSERT INTO task_commands (command_id, task_id, kind, created_at)
             VALUES (?, ?, 'stop', ?)`,
          )
          .run(commandId, taskId, this.#clock.now().toISOString())
        this.#database.exec('COMMIT')
        return task
      }
      if (task.status === 'completed') throw new Error('Task already ended')
      const trimmedReason = reason?.trim() ? reason.trim() : undefined
      const stopped = this.#stopTaskInTransaction(
        task,
        trimmedReason ?? 'stopped_by_user',
        trimmedReason,
      )
      this.#database
        .prepare(
          `INSERT INTO task_commands (command_id, task_id, kind, created_at)
           VALUES (?, ?, 'stop', ?)`,
        )
        .run(commandId, taskId, this.#clock.now().toISOString())
      this.#database.exec('COMMIT')
      return stopped
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #stopTaskInTransaction(
    task: Task,
    statusReason: string,
    endedReason: string | undefined,
  ): Task {
    const taskId = task.id
    {
      const now = this.#clock.now().toISOString()
      const cancelledApprovals = this.#database
        .prepare(
          `SELECT id, action_id FROM approvals
           WHERE task_id = ? AND protocol_version = 1
             AND status IN ('pending','decision_recorded')`,
        )
        .all(taskId) as { id: string; action_id: string }[]
      const interruptedActions = this.#database
        .prepare(
          `SELECT id, resume_run_id FROM actions
           WHERE task_id = ? AND protocol_version = 1
             AND status IN ('authorized','unknown')`,
        )
        .all(taskId) as { id: string; resume_run_id: string | null }[]
      const ended = {
        at: now,
        by: 'human' as const,
        outcome: 'stopped' as const,
        ...(endedReason ? { reason: endedReason } : {}),
      }
      this.#database
        .prepare(
          `UPDATE tasks SET status = 'cancelled', status_reason = ?, ended_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(statusReason, JSON.stringify(ended), now, taskId)
      this.#database
        .prepare(
          `UPDATE runs SET status = 'cancelled', claimed_by = NULL, lease_until = NULL,
           last_error = 'stopped_by_user', updated_at = ?
           WHERE task_id = ? AND status IN ('queued','running','waiting')`,
        )
        .run(now, taskId)
      this.#database
        .prepare(
          `UPDATE approvals SET status = 'cancelled', resolved_at = ?
           WHERE task_id = ? AND protocol_version = 1
             AND status IN ('pending','decision_recorded')`,
        )
        .run(now, taskId)
      this.#database
        .prepare(
          `UPDATE actions SET status = 'rejected', updated_at = ?
           WHERE task_id = ? AND protocol_version = 1
             AND status = 'awaiting_approval'`,
        )
        .run(now, taskId)
      this.#database
        .prepare(
          `UPDATE actions SET status = 'unknown', result_json = ?, updated_at = ?
           WHERE task_id = ? AND protocol_version = 1
             AND status = 'authorized'`,
        )
        .run(
          JSON.stringify({ reason: 'task_stopped_before_outcome' }),
          now,
          taskId,
        )
      for (const approval of cancelledApprovals) {
        this.enqueueOutbox({
          userId: task.userId,
          taskId: task.id,
          channel: 'conversation',
          dedupeKey: `approval-resolved:${approval.id}`,
          payload: {
            type: 'approval.resolved',
            taskId: task.id,
            approvalId: approval.id,
            actionId: approval.action_id,
            decision: 'cancelled',
          },
        })
      }
      for (const action of interruptedActions) {
        this.enqueueOutbox({
          userId: task.userId,
          taskId: task.id,
          channel: 'conversation',
          dedupeKey: `action-reconciliation-required:${action.id}`,
          payload: {
            type: 'action.reconciliation_required',
            taskId: task.id,
            actionId: action.id,
            ...(action.resume_run_id ? { runId: action.resume_run_id } : {}),
            reason: endedReason ?? 'stopped_by_user',
            text: '任务已停止，但高风险动作的最终结果未知，需要人工核对。',
          },
        })
      }
      this.#database
        .prepare(
          `UPDATE inbox_events SET status = 'failed', lease_until = NULL,
             last_error = 'blocked_task_stopped'
           WHERE id IN (
             SELECT event_id FROM task_events
             WHERE task_id = ? AND relation = 'blocked_action'
           ) AND status = 'processing' AND last_error LIKE 'blocked_by_action:%'`,
        )
        .run(taskId)
      this.#settleInboundCollaborations(
        taskId,
        'cancelled',
        endedReason ?? 'Target Task was stopped by the user.',
        undefined,
        now,
      )
      this.#failUndeliveredContextNotes(
        taskId,
        'cancelled',
        endedReason ?? 'Target Task was stopped before delivery.',
        now,
      )
      const stopped = this.#taskById(taskId)
      return stopped
    }
  }

  ownsRun(runId: string, workerId: string): boolean {
    return Boolean(
      this.#database
        .prepare(
          `SELECT 1 FROM runs WHERE id = ? AND status = 'running' AND claimed_by = ?`,
        )
        .get(runId, workerId),
    )
  }

  #claimForCapability(
    runId: string,
    claimToken: string,
  ): { workerId: string; claimTokenHash: string } {
    const row = this.#database
      .prepare(
        `SELECT claimed_by, claim_token_hash, lease_until
         FROM runs WHERE id = ?`,
      )
      .get(runId) as
      | {
          claimed_by: string | null
          claim_token_hash: string | null
          lease_until: string | null
        }
      | undefined
    const suppliedHash = hashClaimToken(claimToken)
    if (
      !row?.claimed_by ||
      !row.claim_token_hash ||
      !safeDigestEqual(suppliedHash, row.claim_token_hash) ||
      !row.lease_until ||
      row.lease_until <= this.#clock.now().toISOString()
    )
      throw new RunClaimError('Run claim capability is invalid or expired')
    return { workerId: row.claimed_by, claimTokenHash: suppliedHash }
  }

  #claimForInternalWorker(
    runId: string,
    workerId: string,
  ): { workerId: string; claimTokenHash: string | null } {
    const row = this.#database
      .prepare('SELECT claimed_by, claim_token_hash FROM runs WHERE id = ?')
      .get(runId) as
      { claimed_by: string | null; claim_token_hash: string | null } | undefined
    if (row?.claimed_by !== workerId)
      throw new Error(`Worker ${workerId} does not own run ${runId}`)
    return { workerId, claimTokenHash: row.claim_token_hash }
  }

  #wakeEvidenceReporting(runId: string, now: string): void {
    this.#database
      .prepare(
        `UPDATE runs SET lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'waiting' AND EXISTS (
           SELECT 1 FROM worker_reports WHERE worker_reports.run_id = runs.id
         )`,
      )
      .run(now, now, runId)
  }

  #wakeBlockedTaskEvents(taskId: string, now: string): void {
    this.#database
      .prepare(
        `UPDATE inbox_events
         SET status = 'pending', claimed_by = NULL, lease_until = NULL,
             last_error = NULL
         WHERE id IN (
           SELECT event_id FROM task_events
           WHERE task_id = ? AND relation = 'blocked_action'
         )
           AND status = 'processing'
           AND last_error LIKE 'blocked_by_action:%'
           AND NOT EXISTS (
             SELECT 1 FROM actions
             WHERE actions.task_id = ? AND actions.protocol_version = 1
               AND actions.status IN ('awaiting_approval','authorized','failed','unknown')
           )`,
      )
      .run(taskId, taskId)
    this.#database
      .prepare(
        `UPDATE task_events SET created_at = ?
         WHERE task_id = ? AND relation = 'blocked_action'
           AND event_id IN (
             SELECT id FROM inbox_events WHERE status = 'pending'
           )`,
      )
      .run(now, taskId)
  }

  #createRetry(row: RunRow, now: string): Run {
    const id = randomUUID()
    const goalRevision = (
      this.#database
        .prepare(
          'SELECT MAX(revision) AS revision FROM goal_contracts WHERE task_id = ?',
        )
        .get(row.task_id) as { revision: number | null }
    ).revision
    this.#database
      .prepare(
        `INSERT INTO runs
      (id, task_id, executor, resume_from_ref, retry_of_run_id, goal_revision, status, input_json,
       execution_context_json, execution_contract_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.task_id,
        row.executor,
        row.executor_ref ?? row.resume_from_ref,
        row.id,
        goalRevision,
        row.input_json,
        row.execution_context_json ??
          JSON.stringify({ executor: row.executor }),
        row.execution_contract_version,
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

  listOutbox(userId: string, taskId?: string): OutboxMessage[] {
    const rows = taskId
      ? this.#database
          .prepare(
            `SELECT * FROM outbox_messages
             WHERE user_id = ? AND task_id = ?
             ORDER BY created_at ASC, rowid ASC`,
          )
          .all(userId, taskId)
      : this.#database
          .prepare(
            `SELECT * FROM outbox_messages
             WHERE user_id = ? ORDER BY created_at ASC, rowid ASC`,
          )
          .all(userId)
    return rows.map(row => toOutboxMessage(row as unknown as OutboxRow))
  }

  markOutboxRead(messageId: string, userId: string): OutboxMessage {
    const now = this.#clock.now().toISOString()
    const result = this.#database
      .prepare(
        `UPDATE outbox_messages
         SET read_at = COALESCE(read_at, ?), updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(now, now, messageId, userId)
    if (result.changes !== 1)
      throw new Error(`Outbox message ${messageId} does not exist for user`)
    return this.#outboxById(messageId)
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

  #cursorRowId(
    table:
      | 'goal_contracts'
      | 'task_artifacts'
      | 'evidence_refs'
      | 'review_packs'
      | 'worker_reports',
    ownerId: string,
    cursor?: string,
  ): number | null {
    if (!cursor) return null
    const row =
      table === 'goal_contracts'
        ? this.#database
            .prepare(
              'SELECT rowid FROM goal_contracts WHERE id = ? AND task_id = ?',
            )
            .get(cursor, ownerId)
        : table === 'task_artifacts'
          ? this.#database
              .prepare(
                'SELECT rowid FROM task_artifacts WHERE id = ? AND task_id = ?',
              )
              .get(cursor, ownerId)
          : table === 'evidence_refs'
            ? this.#database
                .prepare(
                  'SELECT rowid FROM evidence_refs WHERE id = ? AND task_id = ?',
                )
                .get(cursor, ownerId)
            : table === 'review_packs'
              ? this.#database
                  .prepare(
                    'SELECT rowid FROM review_packs WHERE id = ? AND task_id = ?',
                  )
                  .get(cursor, ownerId)
              : this.#database
                  .prepare(
                    'SELECT rowid FROM worker_reports WHERE id = ? AND run_id = ?',
                  )
                  .get(cursor, ownerId)
    if (!row) throw new Error('Pagination cursor is invalid')
    return (row as { rowid: number }).rowid
  }

  #collaborationPageBranch(
    column: 'source_task_id' | 'target_task_id',
    userId: string,
    taskId: string,
    limit: number,
    boundary?: { created_at: string; id: string },
  ): ChannelRelationRow[] {
    const query = boundary
      ? `SELECT * FROM channel_relations
         WHERE user_id = ? AND ${column} = ?
           AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`
      : `SELECT * FROM channel_relations
         WHERE user_id = ? AND ${column} = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`
    const values = boundary
      ? [
          userId,
          taskId,
          boundary.created_at,
          boundary.created_at,
          boundary.id,
          limit,
        ]
      : [userId, taskId, limit]
    return this.#database
      .prepare(query)
      .all(...values) as unknown as ChannelRelationRow[]
  }

  #goalContractById(contractId: string): GoalContract {
    const row = this.#database
      .prepare('SELECT * FROM goal_contracts WHERE id = ?')
      .get(contractId)
    if (!row) throw new Error(`Goal Contract ${contractId} does not exist`)
    return toGoalContract(row as unknown as GoalContractRow)
  }

  #artifactById(artifactId: string): TaskArtifact {
    const row = this.#database
      .prepare('SELECT * FROM task_artifacts WHERE id = ?')
      .get(artifactId)
    if (!row) throw new Error(`Artifact ${artifactId} does not exist`)
    return toTaskArtifact(row as unknown as TaskArtifactRow)
  }

  #evidenceById(evidenceId: string): EvidenceRef {
    const row = this.#database
      .prepare('SELECT * FROM evidence_refs WHERE id = ?')
      .get(evidenceId)
    if (!row) throw new Error(`Evidence ${evidenceId} does not exist`)
    return toEvidenceRef(row as unknown as EvidenceRefRow)
  }

  #reviewPackById(reviewPackId: string): ReviewPack {
    const row = this.#database
      .prepare('SELECT * FROM review_packs WHERE id = ?')
      .get(reviewPackId)
    if (!row) throw new Error(`Review Pack ${reviewPackId} does not exist`)
    return toReviewPack(row as unknown as ReviewPackRow)
  }

  #workerReportById(reportId: string): WorkerReport {
    const row = this.#database
      .prepare('SELECT * FROM worker_reports WHERE id = ?')
      .get(reportId)
    if (!row) throw new Error(`Worker Report ${reportId} does not exist`)
    return toWorkerReport(row as unknown as WorkerReportRow)
  }

  #actionById(actionId: string): DurableAction {
    const row = this.#database
      .prepare('SELECT * FROM actions WHERE id = ?')
      .get(actionId)
    if (!row) throw new Error(`Action ${actionId} does not exist`)
    return this.#actionWithReconciliation(row as unknown as ActionRow)
  }

  #approvalById(approvalId: string): Approval {
    const row = this.#database
      .prepare(
        `SELECT approvals.* FROM approvals
         INNER JOIN actions ON actions.id = approvals.action_id
         WHERE approvals.id = ? AND approvals.protocol_version = 1
           AND actions.protocol_version = 1`,
      )
      .get(approvalId)
    if (!row) throw new Error(`Approval ${approvalId} does not exist`)
    return this.#approvalFromRow(row as unknown as ApprovalRow)
  }

  #approvalFromRow(row: ApprovalRow): Approval {
    const action = this.#actionById(row.action_id)
    const decision = this.#database
      .prepare('SELECT * FROM approval_decisions WHERE approval_id = ?')
      .get(row.id) as unknown as ApprovalDecisionRow | undefined
    return toApproval(row, action.requestRunId, decision)
  }

  #decisionByApprovalId(approvalId: string): ApprovalDecision {
    const row = this.#database
      .prepare('SELECT * FROM approval_decisions WHERE approval_id = ?')
      .get(approvalId)
    if (!row) throw new Error(`Approval ${approvalId} has no decision`)
    return toApprovalDecision(row as unknown as ApprovalDecisionRow)
  }

  #eventById(eventId: string): InboxEvent {
    const row = this.#database
      .prepare('SELECT * FROM inbox_events WHERE id = ?')
      .get(eventId)
    if (!row) throw new Error(`Event ${eventId} does not exist`)
    return toInboxEvent(row as unknown as InboxRow)
  }

  #taskById(taskId: string): Task {
    const row = this.#database
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(taskId)
    if (!row) throw new Error(`Task ${taskId} does not exist`)
    return toTask(row as unknown as TaskRow)
  }

  #ensureWorkerProfile(taskId: string, timestamp: string): void {
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO worker_profiles
          (id, task_id, revision, model_mode, created_at, updated_at)
         VALUES (?, ?, 1, 'inherit', ?, ?)`,
      )
      .run(`worker-profile:${taskId}`, taskId, timestamp, timestamp)
  }

  #workerProfileCommandReplay(
    commandId: string,
  ):
    | { task_id: string; fingerprint: string; response_json: string }
    | undefined {
    return this.#database
      .prepare(
        `SELECT task_id, fingerprint, response_json
         FROM worker_profile_commands WHERE command_id = ?`,
      )
      .get(commandId) as
      | { task_id: string; fingerprint: string; response_json: string }
      | undefined
  }

  #workerProfileByTaskId(taskId: string): WorkerProfile {
    const row = this.#database
      .prepare('SELECT * FROM worker_profiles WHERE task_id = ?')
      .get(taskId) as unknown as WorkerProfileRow | undefined
    if (!row) throw new Error(`Task ${taskId} has no Worker Profile`)
    return toWorkerProfile(row)
  }

  #settleInboundCollaborations(
    targetTaskId: string,
    outcome: CollaborationResult['outcome'],
    summary: string,
    targetRunId: string | undefined,
    now: string,
  ): void {
    const rows = this.#database
      .prepare(
        `SELECT * FROM channel_relations
         WHERE target_task_id = ? AND kind IN ('delegate','handoff')
           AND status IN ('pending','active')
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(targetTaskId) as unknown as ChannelRelationRow[]
    for (const row of rows) {
      const source = this.#taskById(row.source_task_id)
      if (row.target_event_id) {
        this.#database
          .prepare(
            `UPDATE inbox_events SET status = 'processed', processed_at = ?,
               claimed_by = NULL, lease_until = NULL,
               last_error = 'collaboration_target_ended_before_dispatch'
             WHERE id = ? AND status IN ('pending','processing')`,
          )
          .run(now, row.target_event_id)
      }
      const successful = outcome === 'completed'
      const status: CollaborationStatus = successful
        ? row.kind === 'delegate'
          ? 'returned'
          : 'completed'
        : 'failed'
      const result: CollaborationResult = {
        outcome,
        summary,
        ...(targetRunId ? { targetRunId } : {}),
      }
      const shouldResume =
        (row.kind === 'delegate' || (row.kind === 'handoff' && !successful)) &&
        source.status !== 'completed' &&
        source.status !== 'cancelled'
      const eventType =
        row.kind === 'delegate'
          ? successful
            ? 'collaboration.returned'
            : 'collaboration.failed'
          : successful
            ? 'collaboration.completed'
            : 'collaboration.failed'
      const returned = this.enqueueEvent({
        userId: row.user_id,
        source: 'collaboration',
        type: eventType,
        dedupeKey: `collaboration-result:${row.id}`,
        payload: {
          relationId: row.id,
          sourceTaskId: source.id,
          targetTaskId,
          outcome,
          text: summary,
          ...(targetRunId ? { targetRunId } : {}),
        },
      }).event
      this.#database
        .prepare(
          `INSERT INTO task_events (event_id, task_id, relation, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(event_id) DO UPDATE SET
             task_id = excluded.task_id,
             relation = excluded.relation,
             created_at = excluded.created_at`,
        )
        .run(
          returned.id,
          source.id,
          successful ? 'collaboration_returned' : 'collaboration_failed',
          now,
        )
      if (shouldResume) {
        this.#database
          .prepare(
            `UPDATE runs SET status = 'cancelled', claimed_by = NULL,
               lease_until = NULL, claim_token_hash = NULL,
               last_error = ?, updated_at = ?
             WHERE id = ? AND status = 'waiting'`,
          )
          .run(`continued_by:${returned.id}`, now, row.source_run_id)
        this.#database
          .prepare(
            `UPDATE tasks SET status = 'started', status_reason = ?,
               updated_at = ? WHERE id = ?`,
          )
          .run(
            successful ? 'collaboration_returned' : 'collaboration_failed',
            now,
            source.id,
          )
      } else {
        this.#database
          .prepare(
            `UPDATE inbox_events SET status = 'processed', processed_at = ?,
               claimed_by = NULL, lease_until = NULL, last_error = NULL
             WHERE id = ? AND status IN ('pending','processing')`,
          )
          .run(now, returned.id)
      }
      this.#database
        .prepare(
          `UPDATE channel_relations
           SET status = ?, return_event_id = ?, result_json = ?,
               updated_at = ?, settled_at = ?
           WHERE id = ? AND status IN ('pending','active')`,
        )
        .run(status, returned.id, JSON.stringify(result), now, now, row.id)
      if (
        row.kind === 'handoff' &&
        successful &&
        source.status !== 'completed' &&
        source.status !== 'cancelled'
      ) {
        this.#database
          .prepare(
            `UPDATE tasks SET status = 'completed', status_reason = 'handed_off',
               ended_json = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            JSON.stringify({
              at: now,
              by: 'executor',
              outcome: 'completed',
              reason: summary,
            }),
            now,
            source.id,
          )
        this.#settleInboundCollaborations(
          source.id,
          outcome,
          summary,
          targetRunId,
          now,
        )
        this.#failUndeliveredContextNotes(
          source.id,
          'failed',
          'Target Task completed after handing off its responsibility.',
          now,
        )
      }
      this.enqueueOutbox({
        userId: row.user_id,
        taskId: source.id,
        channel: 'conversation',
        dedupeKey: `collaboration-result:${row.id}`,
        payload: {
          type: eventType,
          relationId: row.id,
          sourceTaskId: source.id,
          targetTaskId,
          outcome,
          text: summary,
          ...(targetRunId ? { targetRunId } : {}),
        },
      })
    }
  }

  #failUndeliveredContextNotes(
    targetTaskId: string,
    outcome: 'failed' | 'cancelled',
    summary: string,
    now: string,
  ): void {
    const rows = this.#database
      .prepare(
        `SELECT * FROM channel_relations
         WHERE target_task_id = ? AND kind = 'context_note' AND status = 'pending'
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(targetTaskId) as unknown as ChannelRelationRow[]
    for (const row of rows) {
      if (row.target_event_id) {
        this.#database
          .prepare(
            `UPDATE inbox_events SET status = 'processed', processed_at = ?,
               claimed_by = NULL, lease_until = NULL,
               last_error = 'context_note_target_closed'
             WHERE id = ? AND status IN ('pending','processing')`,
          )
          .run(now, row.target_event_id)
      }
      const source = this.#taskById(row.source_task_id)
      const returned = this.enqueueEvent({
        userId: row.user_id,
        source: 'collaboration',
        type: 'collaboration.failed',
        dedupeKey: `collaboration-result:${row.id}`,
        payload: {
          relationId: row.id,
          sourceTaskId: source.id,
          targetTaskId,
          outcome,
          text: summary,
        },
      }).event
      this.#database
        .prepare(
          `UPDATE inbox_events SET status = 'processed', processed_at = ?,
             claimed_by = NULL, lease_until = NULL, last_error = NULL
           WHERE id = ? AND status = 'pending'`,
        )
        .run(now, returned.id)
      this.#database
        .prepare(
          `INSERT INTO task_events (event_id, task_id, relation, created_at)
           VALUES (?, ?, 'collaboration_failed', ?)
           ON CONFLICT(event_id) DO UPDATE SET
             task_id = excluded.task_id,
             relation = excluded.relation,
             created_at = excluded.created_at`,
        )
        .run(returned.id, source.id, now)
      const result: CollaborationResult = { outcome, summary }
      this.#database
        .prepare(
          `UPDATE channel_relations SET status = 'failed', return_event_id = ?,
             result_json = ?, updated_at = ?, settled_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(returned.id, JSON.stringify(result), now, now, row.id)
      this.enqueueOutbox({
        userId: row.user_id,
        taskId: source.id,
        channel: 'conversation',
        dedupeKey: `collaboration-result:${row.id}`,
        payload: {
          type: 'collaboration.failed',
          relationId: row.id,
          sourceTaskId: source.id,
          targetTaskId,
          outcome,
          text: summary,
        },
      })
    }
  }

  #failTerminalCollaborationEvent(eventId: string, error: string): void {
    const now = this.#clock.now().toISOString()
    const targetRelation = this.#database
      .prepare(
        `SELECT * FROM channel_relations
         WHERE target_event_id = ? AND status IN ('pending','active')`,
      )
      .get(eventId) as unknown as ChannelRelationRow | undefined
    if (targetRelation) {
      if (
        (targetRelation.kind === 'delegate' ||
          targetRelation.kind === 'handoff') &&
        targetRelation.target_task_id
      ) {
        this.#database
          .prepare(
            `UPDATE tasks SET status = 'completed',
               status_reason = 'collaboration_dispatch_failed',
               ended_json = ?, updated_at = ?
             WHERE id = ? AND status NOT IN ('completed','cancelled')`,
          )
          .run(
            JSON.stringify({
              at: now,
              by: 'executor',
              outcome: 'dropped',
              reason: error,
            }),
            now,
            targetRelation.target_task_id,
          )
        this.#settleInboundCollaborations(
          targetRelation.target_task_id,
          'failed',
          `Collaboration dispatch failed: ${error}`,
          undefined,
          now,
        )
        this.#failUndeliveredContextNotes(
          targetRelation.target_task_id,
          'failed',
          'Target Task could not be started.',
          now,
        )
      } else {
        this.#failNonResponsibilityRelation(
          targetRelation,
          `Collaboration delivery failed: ${error}`,
          now,
        )
      }
    }

    const returnRelation = this.#database
      .prepare(
        `SELECT * FROM channel_relations
         WHERE return_event_id = ? AND status IN ('returned','completed','failed')`,
      )
      .get(eventId) as unknown as ChannelRelationRow | undefined
    if (!returnRelation) return
    const summary = `Collaboration result delivery failed: ${error}`
    const previous = returnRelation.result_json
      ? (JSON.parse(returnRelation.result_json) as CollaborationResult)
      : undefined
    this.#database
      .prepare(
        `UPDATE channel_relations SET status = 'failed', result_json = ?,
           updated_at = ?, settled_at = COALESCE(settled_at, ?)
         WHERE id = ?`,
      )
      .run(
        JSON.stringify({
          outcome: 'failed',
          summary,
          ...(previous?.targetRunId
            ? { targetRunId: previous.targetRunId }
            : {}),
        } satisfies CollaborationResult),
        now,
        now,
        returnRelation.id,
      )
    this.#database
      .prepare(
        `UPDATE runs SET status = 'cancelled', claimed_by = NULL,
           lease_until = NULL, claim_token_hash = NULL,
           last_error = 'collaboration_delivery_failed', updated_at = ?
         WHERE id = ? AND status = 'waiting'`,
      )
      .run(now, returnRelation.source_run_id)
    this.#database
      .prepare(
        `UPDATE tasks SET status = 'started',
           status_reason = 'collaboration_delivery_failed', updated_at = ?
         WHERE id = ? AND status NOT IN ('completed','cancelled')`,
      )
      .run(now, returnRelation.source_task_id)
    this.enqueueOutbox({
      userId: returnRelation.user_id,
      taskId: returnRelation.source_task_id,
      channel: 'conversation',
      dedupeKey: `collaboration-delivery-failed:${returnRelation.id}`,
      payload: {
        type: 'collaboration.delivery_failed',
        relationId: returnRelation.id,
        sourceTaskId: returnRelation.source_task_id,
        text: summary,
      },
    })
  }

  #failNonResponsibilityRelation(
    row: ChannelRelationRow,
    summary: string,
    now: string,
  ): void {
    const returned = this.enqueueEvent({
      userId: row.user_id,
      source: 'collaboration',
      type: 'collaboration.failed',
      dedupeKey: `collaboration-result:${row.id}`,
      payload: {
        relationId: row.id,
        sourceTaskId: row.source_task_id,
        ...(row.target_task_id ? { targetTaskId: row.target_task_id } : {}),
        outcome: 'failed',
        text: summary,
      },
    }).event
    this.#database
      .prepare(
        `INSERT INTO task_events (event_id, task_id, relation, created_at)
         VALUES (?, ?, 'collaboration_failed', ?)
         ON CONFLICT(event_id) DO UPDATE SET
           task_id = excluded.task_id,
           relation = excluded.relation,
           created_at = excluded.created_at`,
      )
      .run(returned.id, row.source_task_id, now)
    this.#database
      .prepare(
        `UPDATE inbox_events SET status = 'processed', processed_at = ?,
           claimed_by = NULL, lease_until = NULL, last_error = NULL
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now, returned.id)
    this.#database
      .prepare(
        `UPDATE channel_relations SET status = 'failed', return_event_id = ?,
           result_json = ?, updated_at = ?, settled_at = ?
         WHERE id = ? AND status IN ('pending','active')`,
      )
      .run(
        returned.id,
        JSON.stringify({
          outcome: 'failed',
          summary,
        } satisfies CollaborationResult),
        now,
        now,
        row.id,
      )
    if (row.kind === 'handback') {
      this.#database
        .prepare(
          `UPDATE tasks SET status_reason = 'handback_failed', updated_at = ?
           WHERE id = ? AND status NOT IN ('completed','cancelled')`,
        )
        .run(now, row.source_task_id)
    }
    this.enqueueOutbox({
      userId: row.user_id,
      taskId: row.source_task_id,
      channel: 'conversation',
      dedupeKey: `collaboration-result:${row.id}`,
      payload: {
        type: 'collaboration.failed',
        relationId: row.id,
        sourceTaskId: row.source_task_id,
        ...(row.target_task_id ? { targetTaskId: row.target_task_id } : {}),
        outcome: 'failed',
        text: summary,
      },
    })
  }

  #assertTaskReferences(taskId: string, references: string[]): void {
    if (references.length === 0) return
    const values = references.map(() => '(?)').join(',')
    const rows = this.#database
      .prepare(
        `WITH requested(id) AS (VALUES ${values})
         SELECT requested.id FROM requested
         WHERE EXISTS (
           SELECT 1 FROM task_events
           WHERE task_id = ? AND event_id = requested.id
         ) OR EXISTS (
           SELECT 1 FROM runs
           WHERE task_id = ? AND id = requested.id
         ) OR EXISTS (
           SELECT 1 FROM task_artifacts
           WHERE task_id = ? AND id = requested.id
         ) OR EXISTS (
           SELECT 1 FROM evidence_refs
           WHERE task_id = ? AND id = requested.id
         )`,
      )
      .all(...references, taskId, taskId, taskId, taskId) as { id: string }[]
    const found = new Set(rows.map(row => row.id))
    const missing = references.find(reference => !found.has(reference))
    if (missing) {
      throw new Error(
        `Collaboration reference ${missing} does not belong to source Task`,
      )
    }
  }

  #relationById(relationId: string): ChannelRelation {
    const row = this.#database
      .prepare('SELECT * FROM channel_relations WHERE id = ?')
      .get(relationId)
    if (!row) throw new Error(`Collaboration ${relationId} does not exist`)
    return toChannelRelation(row as unknown as ChannelRelationRow)
  }

  #collaborationForDispatch(
    relationId: string,
    event: InboxEvent,
  ): ChannelRelationRow {
    const row = this.#database
      .prepare('SELECT * FROM channel_relations WHERE id = ?')
      .get(relationId) as unknown as ChannelRelationRow | undefined
    if (
      !row ||
      event.source !== 'collaboration' ||
      row.user_id !== event.userId ||
      (row.target_event_id !== event.id && row.return_event_id !== event.id)
    ) {
      throw new Error('Collaboration dispatch does not match relation')
    }
    if (
      event.type === 'collaboration.failed' &&
      row.kind !== 'delegate' &&
      row.kind !== 'handoff'
    ) {
      throw new Error(
        'Non-responsibility collaboration failure cannot resume a Task',
      )
    }
    return row
  }

  #markCollaborationDispatchedInTransaction(
    row: ChannelRelationRow,
    eventId: string,
    targetTaskId: string,
  ): void {
    if (row.target_event_id !== eventId) {
      throw new Error('Collaboration dispatch does not match relation')
    }
    const target = this.#taskById(targetTaskId)
    if (target.userId !== row.user_id) {
      throw new Error('Collaboration target belongs to another user')
    }
    if (row.target_task_id && row.target_task_id !== targetTaskId) {
      throw new Error('Collaboration target is already assigned')
    }
    if (
      row.status === 'returned' ||
      row.status === 'failed' ||
      row.status === 'cancelled' ||
      (row.status === 'completed' &&
        row.kind !== 'context_note' &&
        row.kind !== 'handback')
    ) {
      return
    }
    const status =
      row.kind === 'context_note' || row.kind === 'handback'
        ? 'completed'
        : 'active'
    const now = this.#clock.now().toISOString()
    this.#database
      .prepare(
        `UPDATE channel_relations
         SET target_task_id = ?, status = ?, updated_at = ?,
             settled_at = CASE WHEN ? = 'completed'
               THEN COALESCE(settled_at, ?) ELSE settled_at END
         WHERE id = ? AND status IN ('pending','active','completed')`,
      )
      .run(targetTaskId, status, now, status, now, row.id)

    if (row.kind === 'handback' && row.status !== 'completed') {
      const request = JSON.parse(row.request_json) as WorkerCollaborationRequest
      if (request.kind !== 'handback') {
        throw new Error('Handback relation contains an incompatible request')
      }
      const input = this.#database
        .prepare(
          `SELECT relation FROM task_events
           WHERE task_id = ? AND event_id = ?`,
        )
        .get(row.source_task_id, request.inputEventId) as
        { relation: string } | undefined
      if (input?.relation === 'origin' || input?.relation === 'resumed') {
        this.#database
          .prepare(
            `UPDATE tasks SET status = 'completed',
               status_reason = 'handed_back', ended_json = ?, updated_at = ?
             WHERE id = ? AND status = 'started'
               AND status_reason = 'handed_back'`,
          )
          .run(
            JSON.stringify({
              at: now,
              by: 'executor',
              outcome: 'completed',
              reason: request.reason,
            }),
            now,
            row.source_task_id,
          )
      }
    }
  }

  #collaborationExecutionContext(
    relation: ChannelRelationRow,
    targetContext: ExecutionContext,
    executor: string,
    targetTaskId: string,
  ): ExecutionContext {
    const sourceRun = this.#database
      .prepare('SELECT * FROM runs WHERE id = ?')
      .get(relation.source_run_id) as unknown as RunRow | undefined
    if (!sourceRun) throw new Error('Collaboration source Run is unavailable')
    const sourceContext = parseExecutionContext(
      sourceRun.execution_context_json ??
        JSON.stringify({ executor: sourceRun.executor }),
    )
    if (
      sourceRun.executor !== executor ||
      sourceContext.executor !== executor ||
      targetContext.executor !== executor ||
      sourceContext.protocol !== targetContext.protocol
    ) {
      throw new Error('Collaboration execution context is incompatible')
    }
    if (relation.kind === 'context_note') {
      return intersectContextNoteAuthority(
        sourceContext,
        targetContext,
        sourceRun.id,
      )
    }
    const targetHasIndependentProfile = targetTaskId !== relation.source_task_id
    return {
      ...sourceContext,
      ...(targetHasIndependentProfile && targetContext.workerProfile
        ? { workerProfile: targetContext.workerProfile }
        : {}),
      ...(targetHasIndependentProfile && targetContext.workerProfileRevision
        ? { workerProfileRevision: targetContext.workerProfileRevision }
        : {}),
      ...(targetHasIndependentProfile && targetContext.workerProfileSource
        ? { workerProfileSource: targetContext.workerProfileSource }
        : {}),
      authoritySourceRunId: sourceRun.id,
    }
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

function toAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    userId: row.user_id,
    revision: row.revision,
    title: row.title,
    prompt: row.prompt,
    schedule: JSON.parse(row.schedule_json) as AutomationSchedule,
    target: JSON.parse(row.target_json) as AutomationTarget,
    status: row.status,
    ...(row.next_fire_at ? { nextFireAt: row.next_fire_at } : {}),
    ...(row.last_fired_at ? { lastFiredAt: row.last_fired_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toAutomationInvocation(
  row: AutomationInvocationRow,
): AutomationInvocation {
  return {
    id: row.id,
    automationId: row.automation_id,
    userId: row.user_id,
    scheduledFor: row.scheduled_for,
    eventId: row.event_id,
    status: row.status,
    attempts: row.attempts,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toMemoryRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    userId: row.user_id,
    scope: row.scope,
    ...(row.scope_task_id ? { taskId: row.scope_task_id } : {}),
    category: row.category,
    content: row.content,
    source:
      row.source_kind === 'user_confirmation'
        ? { kind: 'user_confirmation' }
        : {
            kind: row.source_kind,
            id: row.source_id ?? '',
          },
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
  }
}

function toInboxEvent(row: InboxRow): InboxEvent {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    source: row.source,
    ...(row.authenticated_actor
      ? { authenticatedActor: row.authenticated_actor }
      : {}),
    ...(row.device_id ? { deviceId: row.device_id } : {}),
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

function toEventAttachment(row: EventAttachmentRow): EventAttachment {
  return {
    id: row.id,
    userId: row.user_id,
    eventId: row.event_id,
    fileName: row.file_name,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    createdAt: row.created_at,
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

function toWorkerProfile(row: WorkerProfileRow): WorkerProfile {
  return {
    id: row.id,
    taskId: row.task_id,
    revision: row.revision,
    modelMode: row.model_mode,
    ...(row.model_provider ? { modelProvider: row.model_provider } : {}),
    ...(row.model_name ? { modelName: row.model_name } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toChannelRelation(row: ChannelRelationRow): ChannelRelation {
  return {
    id: row.id,
    commandId: row.command_id,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    sourceTaskId: row.source_task_id,
    sourceRunId: row.source_run_id,
    ...(row.parent_relation_id
      ? { parentRelationId: row.parent_relation_id }
      : {}),
    rootRelationId: row.root_relation_id,
    depth: row.depth,
    ...(row.target_task_id ? { targetTaskId: row.target_task_id } : {}),
    ...(row.target_event_id ? { targetEventId: row.target_event_id } : {}),
    ...(row.return_event_id ? { returnEventId: row.return_event_id } : {}),
    request: JSON.parse(row.request_json) as WorkerCollaborationRequest,
    ...(row.result_json
      ? { result: JSON.parse(row.result_json) as CollaborationResult }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.settled_at ? { settledAt: row.settled_at } : {}),
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
  const workerIconId = row.worker_icon_id ?? assignWorkerIconId(row.id)
  if (!isWorkerIconId(workerIconId))
    throw new Error(`Invalid stored worker icon ID: ${workerIconId}`)
  return {
    id: row.id,
    userId: row.user_id,
    originEventId: row.origin_event_id,
    title: row.title,
    goal: row.goal || row.title,
    status: row.status,
    workerIconId,
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
    ...(row.target_resource === 'pegas_repository'
      ? { targetResource: 'pegas_repository' as const }
      : {}),
    mandate: JSON.parse(row.mandate_json ?? '{}') as Task['mandate'],
    ...(row.ended_json
      ? { ended: JSON.parse(row.ended_json) as NonNullable<Task['ended']> }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function taskSearchSortExpression(
  sort: NonNullable<ChannelSearchOptions['sort']>,
): string {
  if (sort === 'created') return 'tasks.created_at'
  if (sort === 'ended')
    return "COALESCE(json_extract(tasks.ended_json, '$.at'), tasks.updated_at)"
  return 'tasks.updated_at'
}

function taskSearchSortValue(
  row: TaskRow,
  sort: NonNullable<ChannelSearchOptions['sort']>,
): string {
  if (sort === 'created') return row.created_at
  if (sort === 'ended' && row.ended_json) {
    const ended = JSON.parse(row.ended_json) as { at?: unknown }
    if (typeof ended.at === 'string') return ended.at
  }
  return row.updated_at
}

function ftsTrigramQuery(query: string): string {
  return `"${query.replaceAll('"', '""')}"`
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    taskId: row.task_id,
    ...(row.origin_event_id ? { originEventId: row.origin_event_id } : {}),
    ...(row.retry_of_run_id ? { retryOfRunId: row.retry_of_run_id } : {}),
    ...(row.steering_of_run_id
      ? { steeringOfRunId: row.steering_of_run_id }
      : {}),
    executor: row.executor,
    ...(row.executor_ref ? { executorRef: row.executor_ref } : {}),
    ...(row.resume_from_ref ? { resumeFromRef: row.resume_from_ref } : {}),
    ...(row.goal_revision === null ? {} : { goalRevision: row.goal_revision }),
    executionContext: parseExecutionContext(
      row.execution_context_json ?? JSON.stringify({ executor: row.executor }),
    ),
    executionContractVersion: row.execution_contract_version,
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

function toDurableAction(row: ActionRow): DurableAction {
  return {
    id: row.id,
    taskId: row.task_id,
    requestRunId: row.run_id,
    ...(row.resume_run_id ? { resumeRunId: row.resume_run_id } : {}),
    kind: row.kind,
    risk: row.risk,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    request: JSON.parse(row.request_json) as Record<string, unknown>,
    recoveryPoint: JSON.parse(row.recovery_point_json) as Record<
      string,
      unknown
    >,
    ...(row.result_json
      ? {
          result: JSON.parse(row.result_json) as Record<string, unknown>,
        }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toActionReconciliation(
  row: ActionReconciliationRow,
): ActionReconciliation {
  return {
    id: row.id,
    actionId: row.action_id,
    commandId: row.command_id,
    resolution: row.resolution,
    note: row.note,
    previousStatus: row.previous_status,
    ...(row.previous_result_json
      ? {
          previousResult: JSON.parse(row.previous_result_json) as Record<
            string,
            unknown
          >,
        }
      : {}),
    reconciledBy: row.reconciled_by,
    createdAt: row.created_at,
  }
}

function initialApprovalResponse(
  action: ActionRow,
  approval: ApprovalRow,
): { action: DurableAction; approval: Approval } {
  return {
    action: {
      id: action.id,
      taskId: action.task_id,
      requestRunId: action.run_id,
      kind: action.kind,
      risk: action.risk,
      idempotencyKey: action.idempotency_key,
      status: 'awaiting_approval',
      request: JSON.parse(action.request_json) as Record<string, unknown>,
      recoveryPoint: JSON.parse(action.recovery_point_json) as Record<
        string,
        unknown
      >,
      createdAt: action.created_at,
      updatedAt: action.created_at,
    },
    approval: {
      id: approval.id,
      taskId: approval.task_id,
      actionId: approval.action_id,
      requestRunId: action.run_id,
      status: 'pending',
      prompt: JSON.parse(approval.prompt_json) as ApprovalPrompt,
      createdAt: approval.created_at,
    },
  }
}

function toApproval(
  row: ApprovalRow,
  requestRunId: string,
  decision?: ApprovalDecisionRow,
): Approval {
  return {
    id: row.id,
    taskId: row.task_id,
    actionId: row.action_id,
    requestRunId,
    status: row.status,
    prompt: JSON.parse(row.prompt_json) as ApprovalPrompt,
    ...(decision ? { decision: toApprovalDecision(decision) } : {}),
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  }
}

function toApprovalProjection(row: ApprovalProjectionRow): Approval {
  const decision =
    row.decision_id &&
    row.decision_event_id &&
    row.decision_command_id &&
    row.decision_user_id &&
    row.decision_option_id &&
    row.decision_kind &&
    row.decision_decided_at
      ? {
          id: row.decision_id,
          approval_id: row.id,
          event_id: row.decision_event_id,
          command_id: row.decision_command_id,
          user_id: row.decision_user_id,
          option_id: row.decision_option_id,
          kind: row.decision_kind,
          rationale: row.decision_rationale,
          decided_at: row.decision_decided_at,
          applied_at: row.decision_applied_at,
        }
      : undefined
  return toApproval(row, row.request_run_id, decision)
}

function toApprovalDecision(row: ApprovalDecisionRow): ApprovalDecision {
  return {
    id: row.id,
    approvalId: row.approval_id,
    eventId: row.event_id,
    commandId: row.command_id,
    userId: row.user_id,
    optionId: row.option_id,
    kind: row.kind,
    ...(row.rationale ? { rationale: row.rationale } : {}),
    decidedAt: row.decided_at,
    ...(row.applied_at ? { appliedAt: row.applied_at } : {}),
  }
}

function cursorPage<Row extends { id: string }, Value>(
  rows: Row[],
  limit: number,
  convert: (row: Row) => Value,
): CursorPage<Value> {
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore ? pageRows.at(-1)?.id : undefined
  return {
    items: pageRows.map(convert),
    ...(nextCursor ? { nextCursor } : {}),
  }
}

function toGoalContract(row: GoalContractRow): GoalContract {
  const draft = JSON.parse(row.contract_json) as GoalContractDraft
  return {
    id: row.id,
    taskId: row.task_id,
    revision: row.revision,
    commandId: row.command_id,
    ...draft,
    createdAt: row.created_at,
  }
}

function toTaskArtifact(row: TaskArtifactRow): TaskArtifact {
  return {
    id: row.id,
    taskId: row.task_id,
    commandId: row.command_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    name: row.name,
    kind: row.kind,
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    ...(row.uri ? { uri: row.uri } : {}),
    revision: row.revision,
    contentHash: row.content_hash,
    ...(row.size_bytes === null ? {} : { sizeBytes: row.size_bytes }),
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    sensitivity: row.sensitivity,
    createdAt: row.created_at,
  }
}

function toEvidenceRef(row: EvidenceRefRow): EvidenceRef {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    commandId: row.command_id,
    goalRevision: row.goal_revision,
    criterionId: row.criterion_id,
    kind: row.kind,
    ...(row.artifact_id ? { artifactId: row.artifact_id } : {}),
    ...(row.external_ref ? { externalRef: row.external_ref } : {}),
    producerIdentity: row.producer_identity,
    captureMechanism: row.capture_mechanism,
    trustClass: row.trust_class,
    contentHash: row.content_hash,
    ...(row.artifact_revision
      ? { artifactRevision: row.artifact_revision }
      : {}),
    ...(row.observation_snapshot_json
      ? {
          observationSnapshot: JSON.parse(
            row.observation_snapshot_json,
          ) as NonNullable<EvidenceRef['observationSnapshot']>,
        }
      : {}),
    verification: JSON.parse(
      row.verification_json,
    ) as EvidenceRef['verification'],
    capturedAt: row.captured_at,
    environment: JSON.parse(row.environment_json) as Record<string, unknown>,
    presentation: JSON.parse(row.presentation_json) as Record<string, unknown>,
    sensitivity: row.sensitivity,
    limitations: JSON.parse(row.limitations_json) as string[],
  }
}

function toReviewPack(row: ReviewPackRow): ReviewPack {
  return {
    id: row.id,
    revision: row.revision,
    taskId: row.task_id,
    runId: row.run_id,
    goalRevision: row.goal_revision,
    basisEventIds: JSON.parse(row.basis_event_ids_json) as string[],
    projectionAsOf: row.projection_as_of,
    finalOutcome: row.final_outcome,
    criteria: JSON.parse(row.criteria_json) as ReviewCriterion[],
    sideEffects: JSON.parse(row.side_effects_json) as Record<string, unknown>[],
    remainingRisks: JSON.parse(row.remaining_risks_json) as string[],
    ...(row.rollback_json
      ? {
          rollback: JSON.parse(row.rollback_json) as Record<string, unknown>,
        }
      : {}),
    auditLink: row.audit_link,
    createdAt: row.created_at,
  }
}

function toWorkerReport(row: WorkerReportRow): WorkerReport {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    reporterIdentity: row.worker_id,
    goalRevision: row.goal_revision,
    reportSequence: row.report_sequence,
    status: row.status,
    evidenceRefIds: JSON.parse(row.evidence_ref_ids_json) as string[],
    summary: row.summary,
    limitations: JSON.parse(row.limitations_json) as string[],
    remainingRisks: JSON.parse(row.remaining_risks_json) as string[],
    ...(row.rollback_json
      ? {
          rollback: JSON.parse(row.rollback_json) as Record<string, unknown>,
        }
      : {}),
    ...(row.review_pack_id ? { reviewPackId: row.review_pack_id } : {}),
    createdAt: row.created_at,
  }
}

function reviewCriteria(
  goal: GoalContract,
  evidence: EvidenceRef[],
): ReviewCriterion[] {
  return goal.successCriteria.map(criterion => {
    const plan = goal.evidencePlan.find(
      item => item.id === criterion.evidencePlanRef,
    )
    if (!plan)
      throw new Error('Goal Contract references a missing evidence plan')
    const matching = evidence.filter(
      item => item.criterionId === criterion.criterionId,
    )
    const passed = matching.filter(
      item => item.verification.result === 'passed',
    )
    const completionStatus: ReviewCriterion['completionStatus'] =
      passed.length >= plan.minimumCount
        ? 'satisfied'
        : passed.length > 0
          ? 'partial'
          : matching.some(item => item.verification.result === 'failed')
            ? 'failed'
            : 'unverified'
    return {
      criterionId: criterion.criterionId,
      completionStatus,
      currentValidity:
        completionStatus === 'satisfied'
          ? 'valid'
          : completionStatus === 'partial'
            ? 'warning'
            : completionStatus === 'failed'
              ? 'invalid'
              : 'unknown',
      evidenceRefs: matching.map(item => item.id),
      explanation:
        completionStatus === 'satisfied'
          ? `${String(passed.length)} verified evidence item(s) satisfy the criterion.`
          : `${String(passed.length)} of ${String(plan.minimumCount)} required verified evidence item(s) are available.`,
      limitations: [...new Set(matching.flatMap(item => item.limitations))],
    }
  })
}

function validateVisualEvidence(
  draft: EvidenceRefDraft,
  artifact: TaskArtifact | undefined,
): void {
  if (draft.kind === 'screenshot' || draft.kind === 'keyframe') {
    if (artifact?.kind !== 'image' || !artifact.mimeType?.startsWith('image/'))
      throw new Error(
        `${draft.kind} evidence requires an image Artifact with an image MIME type`,
      )
  }
  if (draft.kind === 'render') {
    const compatibleKind =
      artifact?.kind === 'image' ||
      artifact?.kind === 'webpage' ||
      artifact?.kind === 'document'
    const compatibleMime =
      artifact?.mimeType?.startsWith('image/') === true ||
      artifact?.mimeType === 'text/html' ||
      artifact?.mimeType === 'application/pdf'
    if (!compatibleKind || !compatibleMime)
      throw new Error('Render evidence requires a render-compatible Artifact')
  }
  if (draft.kind === 'screenshot' || draft.kind === 'render') {
    const viewport = draft.environment.viewport
    if (!viewport || typeof viewport !== 'object' || Array.isArray(viewport))
      throw new Error('Visual evidence requires a capture viewport')
    const { width, height } = viewport as Record<string, unknown>
    if (
      typeof width !== 'number' ||
      !Number.isFinite(width) ||
      width <= 0 ||
      typeof height !== 'number' ||
      !Number.isFinite(height) ||
      height <= 0
    )
      throw new Error('Visual evidence viewport dimensions must be positive')
  }
  if (draft.kind === 'keyframe') {
    const timecode = draft.presentation.timecode
    if (
      typeof timecode !== 'number' ||
      !Number.isFinite(timecode) ||
      timecode < 0
    )
      throw new Error('Keyframe evidence requires a non-negative timecode')
  }
}

function sameEvidenceAttestation(
  existing: EvidenceRef,
  draft: EvidenceRefDraft,
  artifact: TaskArtifact | undefined,
  contentHash: string,
): boolean {
  return (
    existing.artifactId === draft.artifactId &&
    existing.externalRef === draft.externalRef &&
    existing.producerIdentity === draft.producerIdentity &&
    existing.captureMechanism === draft.captureMechanism &&
    existing.trustClass === draft.trustClass &&
    existing.contentHash === contentHash &&
    existing.artifactRevision === artifact?.revision &&
    stableJson(existing.observationSnapshot) ===
      stableJson(draft.observationSnapshot) &&
    stableJson(existing.environment) === stableJson(draft.environment) &&
    stableJson(existing.presentation) === stableJson(draft.presentation) &&
    existing.sensitivity === draft.sensitivity &&
    stableJson(existing.limitations) === stableJson(draft.limitations)
  )
}

function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(item => stableJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  if (value === undefined) return 'undefined'
  return JSON.stringify(value)
}

function hashClaimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex')
  const rightBuffer = Buffer.from(right, 'hex')
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  )
}

function toModelUsageRecord(row: ModelUsageRow): ModelUsageRecord {
  const workerIconId = row.worker_icon_id ?? assignWorkerIconId(row.task_id)
  if (!isWorkerIconId(workerIconId))
    throw new Error(`Invalid stored worker icon ID: ${workerIconId}`)
  const completeness = row.completeness ?? 'unavailable'
  return {
    runId: row.run_id,
    taskId: row.task_id,
    userId: row.user_id,
    workerIconId,
    executor: row.executor,
    ...(row.model_ref ? { modelRef: row.model_ref } : {}),
    completeness,
    ...(row.token_source ? { tokenSource: row.token_source } : {}),
    ...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
    ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
    ...(row.total_tokens === null ? {} : { totalTokens: row.total_tokens }),
    ...(row.cache_read_tokens === null
      ? {}
      : { cacheReadTokens: row.cache_read_tokens }),
    ...(row.cache_write_tokens === null
      ? {}
      : { cacheWriteTokens: row.cache_write_tokens }),
    ...(row.reasoning_tokens === null
      ? {}
      : { reasoningTokens: row.reasoning_tokens }),
    reportedSteps: row.reported_steps ?? 0,
    unreportedSteps: row.unreported_steps ?? 0,
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(row.latency_source ? { latencySource: row.latency_source } : {}),
    ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
    ...(row.cost_source ? { costSource: row.cost_source } : {}),
    observedAt: row.observed_at ?? row.run_updated_at,
  }
}

function summarizeModelUsage(
  records: ModelUsageRecord[],
): ModelUsageReport['summary'] {
  const summary: ModelUsageReport['summary'] = {
    records: records.length,
    completeRecords: records.filter(
      record => record.completeness === 'complete',
    ).length,
    partialRecords: records.filter(record => record.completeness === 'partial')
      .length,
    unavailableRecords: records.filter(
      record => record.completeness === 'unavailable',
    ).length,
    inputTokens: records.reduce(
      (total, record) => total + (record.inputTokens ?? 0),
      0,
    ),
    outputTokens: records.reduce(
      (total, record) => total + (record.outputTokens ?? 0),
      0,
    ),
    durationMs: records.reduce(
      (total, record) => total + (record.durationMs ?? 0),
      0,
    ),
  }
  addKnownUsageTotal(summary, records, 'cacheReadTokens')
  addKnownUsageTotal(summary, records, 'cacheWriteTokens')
  addKnownUsageTotal(summary, records, 'reasoningTokens')
  addKnownUsageTotal(summary, records, 'costUsd')
  return summary
}

function addKnownUsageTotal(
  summary: ModelUsageReport['summary'],
  records: ModelUsageRecord[],
  key: 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens' | 'costUsd',
): void {
  const known = records.flatMap(record => {
    const value = record[key]
    return value === undefined ? [] : [value]
  })
  if (known.length > 0)
    summary[key] = known.reduce((total, value) => total + value, 0)
}

function parseExecutionContext(value: string): ExecutionContext {
  const parsed: unknown = JSON.parse(value)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('executor' in parsed) ||
    typeof parsed.executor !== 'string'
  )
    throw new Error('Invalid persisted execution context')
  return parsed as ExecutionContext
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
    ...(row.read_at ? { readAt: row.read_at } : {}),
  }
}
