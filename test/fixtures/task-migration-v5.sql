-- Historical task-only v5 migration.

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
