import { resolve } from 'node:path'

export interface SupervisorRuntimePaths {
  dataDir: string
  databasePath: string
}

/**
 * Resolves the shared data directory once in the Supervisor process. Candidate
 * releases run with a different cwd, so forwarding a relative PEGAS_DATA_DIR
 * would otherwise make the compatibility guard inspect a different database.
 */
export function resolveSupervisorRuntimePaths(
  configuredDataDir: string | undefined,
  supervisorCwd = process.cwd(),
): SupervisorRuntimePaths {
  const dataDir = resolve(supervisorCwd, configuredDataDir ?? './data')
  return {
    dataDir,
    databasePath: resolve(dataDir, 'pegas.sqlite'),
  }
}
