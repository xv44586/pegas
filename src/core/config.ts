import { resolve } from 'node:path'

export interface PegasConfig {
  apiHost: string
  apiPort: number
  apiToken?: string
  dataDir: string
  databasePath: string
  eventPollMs: number
  executorMode: 'dsh' | 'echo'
  dshCommand: string
  workspaceRoot: string
  workerConcurrency: number
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PegasConfig {
  const dataDir = resolve(environment.PEGAS_DATA_DIR ?? './data')
  const apiHost = environment.PEGAS_API_HOST ?? '127.0.0.1'
  const apiToken = environment.PEGAS_API_TOKEN

  if (!isLoopback(apiHost) && !apiToken) {
    throw new Error(
      'PEGAS_API_TOKEN is required when the API listens outside the loopback interface',
    )
  }

  return {
    apiHost,
    apiPort: parsePositiveInteger(
      environment.PEGAS_API_PORT,
      4317,
      'PEGAS_API_PORT',
    ),
    ...(apiToken ? { apiToken } : {}),
    dataDir,
    databasePath: resolve(dataDir, 'pegas.sqlite'),
    eventPollMs: parsePositiveInteger(
      environment.PEGAS_EVENT_POLL_MS,
      250,
      'PEGAS_EVENT_POLL_MS',
    ),
    executorMode: environment.PEGAS_EXECUTOR === 'echo' ? 'echo' : 'dsh',
    dshCommand: environment.PEGAS_DSH_COMMAND ?? 'dsh',
    workspaceRoot: resolve(environment.PEGAS_WORKSPACE_ROOT ?? '.'),
    workerConcurrency: parsePositiveInteger(
      environment.PEGAS_WORKER_CONCURRENCY,
      2,
      'PEGAS_WORKER_CONCURRENCY',
    ),
  }
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`)
  return parsed
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}
