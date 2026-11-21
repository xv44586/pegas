/**
 * Destructive migrations rebuild or drop durable structures instead of only
 * adding tables/columns. Switching to a release that applies one for the
 * first time requires a dedicated human approval; the Supervisor enforces
 * the grant before it stages the candidate or starts the release.
 */
export const destructiveMigrationVersions: readonly number[] = [30]

export function pendingDestructiveMigrations(
  currentSchemaVersion: number,
  targetMaximumSchema: number,
): number[] {
  return destructiveMigrationVersions.filter(
    version => version > currentSchemaVersion && version <= targetMaximumSchema,
  )
}
