export interface RollbackTransitionOptions<T> {
  stopChildren(): Promise<void>
  assertRollbackAllowed(): void
  rollback(): T
  requestRestart(): void
}

/**
 * Quiesces every process capable of mutating the database before making the
 * final compatibility decision. A rejected rollback restarts the unchanged
 * active release instead of leaving Pegas offline.
 */
export async function performRollbackTransition<T>(
  options: RollbackTransitionOptions<T>,
): Promise<T> {
  options.requestRestart()
  await options.stopChildren()
  options.assertRollbackAllowed()
  return options.rollback()
}
