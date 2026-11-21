import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const collaborationSchemaVersion = 19
const automationSchemaVersion = 20
const memorySchemaVersion = 21

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
    const currentVersion = current.version ?? 0
    if (
      currentVersion >= collaborationSchemaVersion &&
      targetMaximumSchema < collaborationSchemaVersion
    ) {
      const liveEvents = database
        .prepare(
          `SELECT 1 FROM inbox_events
           WHERE source = 'collaboration'
             AND status IN ('pending','processing')
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
    }
    if (
      currentVersion >= automationSchemaVersion &&
      targetMaximumSchema < automationSchemaVersion
    ) {
      const activeAutomation = database
        .prepare(
          `SELECT 1 FROM automations
           WHERE status = 'active' AND next_fire_at IS NOT NULL LIMIT 1`,
        )
        .get()
      const liveAutomationEvent = database
        .prepare(
          `SELECT 1 FROM inbox_events
           WHERE source = 'automation'
             AND status IN ('pending','processing')
           LIMIT 1`,
        )
        .get()
      if (activeAutomation || liveAutomationEvent) {
        throw new RollbackCompatibilityError(
          'Rollback is unsafe while Automation schedules or events are active',
        )
      }
    }
    if (
      currentVersion >= memorySchemaVersion &&
      targetMaximumSchema < memorySchemaVersion
    ) {
      const liveMemory = database
        .prepare('SELECT 1 FROM memories LIMIT 1')
        .get()
      if (liveMemory) {
        throw new RollbackCompatibilityError(
          'Rollback is unsafe while user Memory records exist',
        )
      }
    }
  } finally {
    database.close()
  }
}
