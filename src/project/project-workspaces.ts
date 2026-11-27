import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ExecutionContext, InboxEvent } from '../core/domain.js'

import type { Project, ProjectBinding } from './types.js'

export const projectWorkspaceMigration = `
CREATE TABLE execution_projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES execution_nodes(id),
  directory TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, node_id, directory)
);
ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES execution_projects(id);
ALTER TABLE tasks ADD COLUMN working_directory TEXT;
ALTER TABLE tasks ADD COLUMN workspace_node_id TEXT REFERENCES execution_nodes(id);
ALTER TABLE tasks ADD COLUMN workspace_revision INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER project_binding_owner BEFORE UPDATE OF project_id ON tasks
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM execution_projects WHERE id = NEW.project_id AND user_id = NEW.user_id
)
BEGIN SELECT RAISE(ABORT, 'Project belongs to another user'); END;
CREATE TRIGGER project_run_contract BEFORE INSERT ON runs
WHEN (SELECT working_directory FROM tasks WHERE id = NEW.task_id) IS NOT NULL
  AND (NEW.execution_contract_version < 3 OR json_extract(NEW.execution_context_json, '$.workspaceBinding.revision') IS NULL)
BEGIN SELECT RAISE(ABORT, 'Project execution contract is required'); END;
`

/** Project membership never implies a Git workflow or an external account grant. */
export class ProjectWorkspaces {
  private readonly db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
  }

  list(userId: string): Project[] {
    return this.db
      .prepare(
        `SELECT id, user_id AS userId, name, node_id AS nodeId,
      directory, created_at AS createdAt FROM execution_projects WHERE user_id = ? ORDER BY created_at, id`,
      )
      .all(userId) as unknown as Project[]
  }

  get(id: string, userId: string): Project {
    const project = this.list(userId).find(item => item.id === id)
    if (!project) throw new Error('Project does not exist for user')
    return project
  }

  create(value: unknown, now: string): { project: Project; created: boolean } {
    const input = object(value)
    const id = string(input.id, 'id', 240)
    const userId = string(input.userId, 'userId', 240)
    const name = string(input.name, 'name', 120)
    const nodeId = string(input.nodeId, 'nodeId', 240)
    const directory = directoryPath(input.directory)
    const previous = this.db
      .prepare('SELECT user_id FROM execution_projects WHERE id = ?')
      .get(id)
    if (previous) {
      const project = this.get(id, userId)
      if (
        project.name !== name ||
        project.nodeId !== nodeId ||
        project.directory !== directory
      )
        throw new Error('Project ID is already used with different settings')
      return { project, created: false }
    }
    if (
      !this.db
        .prepare('SELECT id FROM execution_nodes WHERE id = ?')
        .get(nodeId)
    )
      throw new Error('Execution node does not exist')
    if (
      this.list(userId).some(
        p => p.nodeId === nodeId && p.directory === directory,
      )
    )
      throw new Error('This project directory is already registered')
    this.db
      .prepare(
        `INSERT INTO execution_projects (id,user_id,name,node_id,directory,created_at)
      VALUES (?,?,?,?,?,?)`,
      )
      .run(id, userId, name, nodeId, directory, now)
    return { project: this.get(id, userId), created: true }
  }

  binding(taskId: string, userId: string): ProjectBinding {
    const row = this.db
      .prepare(
        `SELECT project_id AS projectId, working_directory AS workingDirectory,
      workspace_node_id AS nodeId, workspace_revision AS revision FROM tasks WHERE id = ? AND user_id = ?`,
      )
      .get(taskId, userId)
    if (!row) throw new Error('Task does not exist for user')
    return row as unknown as ProjectBinding
  }

  bind(
    taskId: string,
    userId: string,
    value: unknown,
    actionBlocked: boolean,
  ): ProjectBinding {
    const input = object(value)
    const expected = input.expectedRevision
    if (!Number.isSafeInteger(expected) || (expected as number) < 0)
      throw new Error('expectedRevision must be a nonnegative integer')
    const projectId =
      input.projectId === null
        ? null
        : string(input.projectId, 'projectId', 240)
    const project = projectId ? this.get(projectId, userId) : undefined
    const workingDirectory =
      input.workingDirectory == null
        ? (project?.directory ?? null)
        : directoryPath(input.workingDirectory)
    const nodeId =
      project?.nodeId ??
      (workingDirectory ? string(input.nodeId, 'nodeId', 240) : null)
    if (project && input.nodeId != null && input.nodeId !== nodeId)
      throw new Error('Node must match the selected project')
    if (
      nodeId &&
      !this.db
        .prepare('SELECT id FROM execution_nodes WHERE id = ?')
        .get(nodeId)
    )
      throw new Error('Execution node does not exist')
    const current = this.binding(taskId, userId)
    if (
      current.revision === (expected as number) + 1 &&
      current.projectId === projectId &&
      current.workingDirectory === workingDirectory &&
      current.nodeId === nodeId
    )
      return current
    if (current.revision !== expected)
      throw new Error('Project binding revision changed')
    const task = this.db
      .prepare('SELECT status,kind FROM tasks WHERE id = ?')
      .get(taskId)
    if (task?.status === 'cancelled' || task?.kind !== 'work')
      throw new Error(
        'Only an open or completed work task can change project binding',
      )
    if (
      this.db
        .prepare(
          `SELECT id FROM runs WHERE task_id = ? AND status IN ('queued','running','waiting') LIMIT 1`,
        )
        .get(taskId) ||
      actionBlocked
    )
      throw new Error(
        'Wait for the current execution and approvals before changing directory',
      )
    this.db
      .prepare(
        'UPDATE tasks SET project_id = ?, working_directory = ?, workspace_node_id = ?, workspace_revision = workspace_revision + 1 WHERE id = ?',
      )
      .run(projectId, workingDirectory, nodeId, taskId)
    return this.binding(taskId, userId)
  }

  forTask(
    taskId: string,
    userId: string,
    base: ExecutionContext,
  ): ExecutionContext {
    const binding = this.binding(taskId, userId)
    if (!binding.workingDirectory || !binding.nodeId) return base
    const project = binding.projectId
      ? this.get(binding.projectId, userId)
      : undefined
    return {
      ...base,
      nodeId: binding.nodeId,
      workspace: binding.workingDirectory,
      workspaceBinding: { revision: binding.revision },
      ...(project
        ? {
            project: {
              id: project.id,
              name: project.name,
              directory: project.directory,
              revision: binding.revision,
            },
          }
        : {}),
    }
  }
}

export function eventProjectId(
  event: Pick<InboxEvent, 'type' | 'payload'>,
): string | undefined {
  if (
    event.type !== 'user.message' ||
    !event.payload ||
    typeof event.payload !== 'object' ||
    !('projectId' in event.payload)
  )
    return undefined
  return string(event.payload.projectId, 'projectId', 240)
}

export function eventDirectory(
  event: Pick<InboxEvent, 'type' | 'payload'>,
): { directory: string; nodeId: string } | undefined {
  if (
    event.type !== 'user.message' ||
    !event.payload ||
    typeof event.payload !== 'object' ||
    !('workspace' in event.payload)
  )
    return undefined
  if (eventProjectId(event))
    throw new Error('Select either a project or a standalone directory')
  const input = object(event.payload.workspace)
  return {
    directory: directoryPath(input.directory),
    nodeId: string(input.nodeId, 'nodeId', 240),
  }
}

/** Runs on the execution node, never against the control computer's filesystem. */
export function validateProjectWorkspace(context: ExecutionContext): void {
  if (!context.workspaceBinding) return
  if (
    !context.nodeId ||
    !context.workspace ||
    !Number.isSafeInteger(context.workspaceBinding.revision) ||
    context.workspaceBinding.revision < 1
  )
    throw new Error('Project execution snapshot is invalid')
  for (const directory of new Set([
    ...(context.project ? [context.project.directory] : []),
    context.workspace,
  ])) {
    directoryPath(directory)
    if (!statSync(directory).isDirectory())
      throw new Error('Project workspace is not a directory')
    if (realpathSync(directory) !== directory)
      throw new Error(
        'Project workspace must use its canonical path; select the resolved directory explicitly',
      )
  }
}

function directoryPath(value: unknown): string {
  const directory = string(value, 'directory', 4096)
  if (
    !isAbsolute(directory) ||
    normalize(directory) !== directory ||
    directory.includes('\0')
  )
    throw new Error(
      'directory must be a normalized absolute path on the execution node',
    )
  return directory
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Request must be an object')
  return value as Record<string, unknown>
}

function string(value: unknown, name: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new Error(
      `${name} is required and must be at most ${String(limit)} characters`,
    )
  return value.trim()
}
