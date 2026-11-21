import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createDatabaseBackup } from '../storage/backup.js'
import { initializeSchema } from '../storage/sqlite-store.js'
import { pendingDestructiveMigrations } from '../storage/migration-policy.js'
import { MigrationApprovalRequiredError } from './recovery-server.js'

export interface MigrationApprovalGrant {
  actionId: string
  approvalId: string
}

/**
 * Verifies a dedicated destructive-migration approval against the durable
 * Approval facts before a candidate may be staged or started. The grant is
 * bound to one candidate release and one exact migration set, and only an
 * approved `self_change.migration` Action qualifies; a regular publish
 * approval can never substitute for it.
 */
export function assertMigrationApproval(input: {
  databasePath: string
  releaseId: string
  targetMaximumSchema: number
  declaredMigrations?: number[]
  grant?: MigrationApprovalGrant
}): number[] {
  const currentVersion = liveSchemaVersion(input.databasePath)
  const pending = pendingDestructiveMigrations(
    currentVersion,
    input.targetMaximumSchema,
  )
  const declared = input.declaredMigrations ?? []
  if (declared.some(version => !pending.includes(version))) {
    throw new Error(
      'Candidate declares destructive migrations outside the pending range',
    )
  }
  if (pending.length === 0) return []
  if (!input.grant) throw new MigrationApprovalRequiredError(pending)
  const database = new DatabaseSync(input.databasePath, { readOnly: true })
  try {
    const action = database
      .prepare('SELECT * FROM actions WHERE id = ? AND protocol_version = 1')
      .get(input.grant.actionId) as
      | {
          kind: string
          status: string
          request_json: string
          resume_run_id: string | null
        }
      | undefined
    if (action?.kind !== 'self_change.migration') {
      throw new MigrationApprovalRequiredError(pending)
    }
    if (action.status !== 'authorized' && action.status !== 'succeeded') {
      throw new MigrationApprovalRequiredError(pending)
    }
    const approval = database
      .prepare('SELECT status FROM approvals WHERE id = ? AND action_id = ?')
      .get(input.grant.approvalId, input.grant.actionId) as
      { status: string } | undefined
    if (approval?.status !== 'approved') {
      throw new MigrationApprovalRequiredError(pending)
    }
    const request = JSON.parse(action.request_json) as {
      releaseId?: unknown
      destructiveMigrations?: unknown
    }
    const requestedVersions = Array.isArray(request.destructiveMigrations)
      ? request.destructiveMigrations.filter(
          (version): version is number => typeof version === 'number',
        )
      : []
    if (
      request.releaseId !== input.releaseId ||
      requestedVersions.length !== pending.length ||
      pending.some(version => !requestedVersions.includes(version))
    ) {
      throw new Error(
        'Migration approval does not match this candidate release and migration set',
      )
    }
    return pending
  } finally {
    database.close()
  }
}

/**
 * Applies pending migrations to a verified copy of the live database so the
 * real migration code is proven before the active release is switched. The
 * live database file is never opened for writing here.
 */
export async function rehearseMigrations(input: {
  databasePath: string
  backupDirectory: string
}): Promise<void> {
  if (!existsSync(input.databasePath)) return
  const verified = await createDatabaseBackup(
    input.databasePath,
    input.backupDirectory,
  )
  const rehearsalPath = join(
    input.backupDirectory,
    `migration-rehearsal-${String(process.pid)}.sqlite`,
  )
  rmSync(rehearsalPath, { force: true })
  copyFileSync(verified.path, rehearsalPath)
  const rehearsal = new DatabaseSync(rehearsalPath)
  try {
    rehearsal.exec('PRAGMA busy_timeout = 5000;')
    initializeSchema(rehearsal)
    const integrity = rehearsal.prepare('PRAGMA integrity_check').get() as {
      integrity_check: string
    }
    if (integrity.integrity_check !== 'ok') {
      throw new Error('Migration rehearsal failed the integrity check')
    }
  } finally {
    rehearsal.close()
    rmSync(rehearsalPath, { force: true })
  }
}

export function liveSchemaVersion(databasePath: string): number {
  if (!existsSync(databasePath)) return 0
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const table = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get()
    if (!table) return 0
    const row = database
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null }
    return row.version ?? 0
  } finally {
    database.close()
  }
}
