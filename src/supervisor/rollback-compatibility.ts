import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const collaborationSchemaVersion = 19

export class RollbackCompatibilityError extends Error {}

export class RollbackUnavailableError extends Error {}

export function assertRollbackCompatible(
  databasePath: string,
  targetMaximumSchema: number,
): void {
  if (!existsSync(databasePath)) return
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const current = database
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null }
    if (
      (current.version ?? 0) < collaborationSchemaVersion ||
      targetMaximumSchema >= collaborationSchemaVersion
    ) {
      return
    }
    const liveEvents = database
      .prepare(
        `SELECT 1 FROM inbox_events
         WHERE source = 'collaboration' AND status IN ('pending','processing')
         LIMIT 1`,
      )
      .get()
    const liveRelations = database
      .prepare(
        `SELECT 1 FROM channel_relations
         WHERE status IN ('pending','active') LIMIT 1`,
      )
      .get()
    if (liveEvents || liveRelations) {
      throw new RollbackCompatibilityError(
        'Rollback is unsafe while collaboration events or relations are active',
      )
    }
  } finally {
    database.close()
  }
}
