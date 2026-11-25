import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** @typedef {{deleteData?: boolean}} StopOptions */
/**
 * @typedef {{
 *   environment?: NodeJS.ProcessEnv,
 *   ignoreFailure?: boolean,
 *   quiet?: boolean,
 *   onOutput?: (chunk: string) => void
 * }} DockerOptions
 */

export const HINDSIGHT_ARM64_IMAGE =
  'ghcr.io/vectorize-io/hindsight@sha256:4b903ed2cbf029d6d305030b0005002d61d6a3b1d9b85867fb459351dcaa671c'
export const HINDSIGHT_INDEX_DIGEST =
  'sha256:601cfdd1bd3f6053864c6458ee15259f065a01a3f83090b56a8ae57db67f8f38'
export const HINDSIGHT_PREVIOUS_ARM64_IMAGE =
  'ghcr.io/vectorize-io/hindsight@sha256:b4147f9635fda928041f8ee726b832c3e6b524b20f9cd8ad6e8e311a7ca554d8'
export const PGVECTOR_ARM64_IMAGE =
  'pgvector/pgvector@sha256:38681dc6eaf55308e2a4c6de392d131652dcfac70e1263e35cd9b5ea3fe39782'

/** @param {NodeJS.ProcessEnv} environment */
export function hindsightRuntimePlan(environment = process.env) {
  const identity = hindsightRuntimeIdentity(environment)
  const {
    prefix,
    backupDirectory,
    databaseContainer,
    hindsightContainer,
    network,
    volume,
  } = identity
  const databasePassword = required(
    environment.PEGAS_HINDSIGHT_DB_PASSWORD,
    'PEGAS_HINDSIGHT_DB_PASSWORD',
  )
  const tenantApiKey = required(
    environment.PEGAS_HINDSIGHT_API_KEY,
    'PEGAS_HINDSIGHT_API_KEY',
  )
  const databaseName = environment.PEGAS_HINDSIGHT_DB_NAME ?? 'hindsight'
  const databaseUser = environment.PEGAS_HINDSIGHT_DB_USER ?? 'hindsight'
  const apiPort = positiveInteger(
    environment.PEGAS_HINDSIGHT_PORT,
    8888,
    'PEGAS_HINDSIGHT_PORT',
  )
  const startupTimeoutMs = positiveInteger(
    environment.PEGAS_HINDSIGHT_STARTUP_TIMEOUT_MS,
    600_000,
    'PEGAS_HINDSIGHT_STARTUP_TIMEOUT_MS',
  )
  const databaseImage =
    environment.PEGAS_HINDSIGHT_POSTGRES_IMAGE ?? PGVECTOR_ARM64_IMAGE
  const hindsightImage =
    environment.PEGAS_HINDSIGHT_IMAGE ?? HINDSIGHT_ARM64_IMAGE
  const databaseUrl = `postgresql://${encodeURIComponent(databaseUser)}:${encodeURIComponent(databasePassword)}@${databaseContainer}:5432/${encodeURIComponent(databaseName)}`
  const databaseEnvironment = {
    POSTGRES_USER: databaseUser,
    POSTGRES_PASSWORD: databasePassword,
    POSTGRES_DB: databaseName,
  }
  const hindsightEnvironment = {
    HINDSIGHT_API_DATABASE_URL: databaseUrl,
    HINDSIGHT_API_TENANT_EXTENSION:
      'hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension',
    HINDSIGHT_API_TENANT_API_KEY: tenantApiKey,
    HINDSIGHT_API_LLM_PROVIDER:
      environment.PEGAS_HINDSIGHT_LLM_PROVIDER ?? 'openai',
    HINDSIGHT_API_LLM_BASE_URL: required(
      environment.PEGAS_HINDSIGHT_LLM_BASE_URL,
      'PEGAS_HINDSIGHT_LLM_BASE_URL',
    ),
    HINDSIGHT_API_LLM_API_KEY:
      environment.PEGAS_HINDSIGHT_LLM_API_KEY ?? 'not-needed',
    HINDSIGHT_API_LLM_MODEL: required(
      environment.PEGAS_HINDSIGHT_LLM_MODEL,
      'PEGAS_HINDSIGHT_LLM_MODEL',
    ),
    HINDSIGHT_WAIT_FOR_DEPS: 'true',
    HINDSIGHT_ENABLE_CP: 'false',
    HINDSIGHT_API_WORKER_ID: `${prefix}-worker`,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
  }
  const databaseArgs = [
    'run',
    '--detach',
    '--name',
    databaseContainer,
    '--network',
    network,
    '--restart',
    'unless-stopped',
    '--env',
    'POSTGRES_USER',
    '--env',
    'POSTGRES_PASSWORD',
    '--env',
    'POSTGRES_DB',
    '--mount',
    `type=volume,source=${volume},target=/var/lib/postgresql/18/docker`,
    '--health-cmd',
    `pg_isready -U ${databaseUser} -d ${databaseName}`,
    '--health-interval',
    '2s',
    '--health-timeout',
    '2s',
    '--health-retries',
    '30',
    databaseImage,
  ]
  const hindsightArgs = [
    'run',
    '--detach',
    '--name',
    hindsightContainer,
    '--network',
    network,
    '--restart',
    'unless-stopped',
    '--add-host',
    'host.docker.internal:host-gateway',
    '--publish',
    `127.0.0.1:${String(apiPort)}:8888`,
    ...Object.keys(hindsightEnvironment).flatMap(key => ['--env', key]),
    '--mount',
    `type=bind,source=${backupDirectory},target=/backups`,
    hindsightImage,
  ]
  return {
    prefix,
    network,
    volume,
    databaseContainer,
    hindsightContainer,
    databaseImage,
    hindsightImage,
    backupDirectory,
    apiUrl: `http://127.0.0.1:${String(apiPort)}`,
    startupTimeoutMs,
    databaseEnvironment,
    hindsightEnvironment,
    databaseArgs,
    hindsightArgs,
  }
}

/** @param {NodeJS.ProcessEnv} environment */
function hindsightRuntimeIdentity(environment) {
  const prefix = environment.PEGAS_HINDSIGHT_RUNTIME_PREFIX ?? 'pegas-hindsight'
  return {
    prefix,
    network: prefix,
    volume: environment.PEGAS_HINDSIGHT_DB_VOLUME ?? `${prefix}-pg`,
    databaseContainer: `${prefix}-db`,
    hindsightContainer: prefix,
    backupDirectory: resolve(
      environment.PEGAS_HINDSIGHT_BACKUP_DIR ?? './data/hindsight-backups',
    ),
  }
}

/** @param {NodeJS.ProcessEnv} environment */
export async function startHindsight(environment = process.env) {
  const plan = hindsightRuntimePlan(environment)
  mkdirSync(plan.backupDirectory, { recursive: true, mode: 0o700 })
  await ensureNetwork(plan.network)
  await ensureVolume(plan.volume)
  await removeContainer(plan.hindsightContainer)
  await removeContainer(plan.databaseContainer)
  await runDocker(plan.databaseArgs, {
    environment: { ...process.env, ...plan.databaseEnvironment },
  })
  await waitForContainerHealth(plan.databaseContainer, 60_000)
  await runDocker(plan.hindsightArgs, {
    environment: { ...process.env, ...plan.hindsightEnvironment },
  })
  await waitForHttp(`${plan.apiUrl}/health`, plan.startupTimeoutMs)
  return plan
}

/**
 * @param {NodeJS.ProcessEnv} environment
 * @param {StopOptions} options
 */
export async function stopHindsight(environment = process.env, options = {}) {
  const plan = hindsightRuntimeIdentity(environment)
  await removeContainer(plan.hindsightContainer)
  await removeContainer(plan.databaseContainer)
  if (options.deleteData === true) {
    await runDocker(['volume', 'rm', plan.volume], { ignoreFailure: true })
    await runDocker(['network', 'rm', plan.network], { ignoreFailure: true })
  }
}

/** @param {NodeJS.ProcessEnv} environment */
export async function backupHindsight(environment = process.env) {
  const plan = hindsightRuntimeIdentity(environment)
  mkdirSync(plan.backupDirectory, { recursive: true, mode: 0o700 })
  const fileName = `hindsight-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}.zip`
  await runDocker([
    'exec',
    plan.hindsightContainer,
    'hindsight-admin',
    'backup',
    `/backups/${fileName}`,
  ])
  return resolve(plan.backupDirectory, fileName)
}

/**
 * @param {string} fileName
 * @param {NodeJS.ProcessEnv} environment
 */
export async function restoreHindsight(fileName, environment = process.env) {
  const plan = hindsightRuntimePlan(environment)
  const absolute = resolve(fileName)
  if (!absolute.startsWith(`${plan.backupDirectory}/`))
    throw new Error('Restore archive must be inside PEGAS_HINDSIGHT_BACKUP_DIR')
  const restoreContainer = `${plan.prefix}-restore`
  await removeContainer(plan.hindsightContainer)
  await removeContainer(restoreContainer)
  await runDocker(
    [
      'run',
      '--rm',
      '--name',
      restoreContainer,
      '--network',
      plan.network,
      '--add-host',
      'host.docker.internal:host-gateway',
      ...Object.keys(plan.hindsightEnvironment).flatMap(key => ['--env', key]),
      '--mount',
      `type=bind,source=${plan.backupDirectory},target=/backups`,
      plan.hindsightImage,
      'hindsight-admin',
      'restore',
      `/backups/${absolute.slice(plan.backupDirectory.length + 1)}`,
      '--yes',
    ],
    { environment: { ...process.env, ...plan.hindsightEnvironment } },
  )
  await startHindsight(environment)
}

/** @param {string} name */
async function ensureNetwork(name) {
  const exists = await runDocker(['network', 'inspect', name], {
    ignoreFailure: true,
    quiet: true,
  })
  if (!exists) await runDocker(['network', 'create', name])
}

/** @param {string} name */
async function ensureVolume(name) {
  const exists = await runDocker(['volume', 'inspect', name], {
    ignoreFailure: true,
    quiet: true,
  })
  if (!exists) await runDocker(['volume', 'create', name])
}

/** @param {string} name */
async function removeContainer(name) {
  await runDocker(['rm', '--force', name], { ignoreFailure: true, quiet: true })
}

/**
 * @param {string} name
 * @param {number} timeoutMs
 */
async function waitForContainerHealth(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await dockerOutput([
      'inspect',
      '--format',
      '{{.State.Health.Status}}',
      name,
    ])
    if (status.trim() === 'healthy') return
    await wait(500)
  }
  throw new Error(`Container ${name} did not become healthy`)
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 */
async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch {
      // The supervised service is still starting.
    }
    await wait(1_000)
  }
  throw new Error(`Hindsight did not become healthy at ${url}`)
}

/** @param {string[]} args */
async function dockerOutput(args) {
  let output = ''
  await runDocker(args, {
    quiet: true,
    onOutput: chunk => {
      output += chunk
    },
  })
  return output
}

/**
 * @param {string[]} args
 * @param {DockerOptions} options
 */
function runDocker(args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('docker', args, {
      env: options.environment ?? process.env,
      stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    if (options.quiet) {
      child.stdout?.on('data', chunk => options.onOutput?.(String(chunk)))
      child.stderr?.on('data', chunk => options.onOutput?.(String(chunk)))
    }
    child.once('error', rejectRun)
    child.once('exit', code => {
      if (code === 0) resolveRun(true)
      else if (options.ignoreFailure) resolveRun(false)
      else
        rejectRun(new Error(`docker ${args[0] ?? ''} exited ${String(code)}`))
    })
  })
}

/**
 * @param {string | undefined} value
 * @param {string} name
 */
function required(value, name) {
  if (!value?.trim()) throw new Error(`${name} is required`)
  return value
}

/**
 * @param {string | undefined} value
 * @param {number} fallback
 * @param {string} name
 */
function positiveInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`)
  return parsed
}

/** @param {number} milliseconds */
function wait(milliseconds) {
  return new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
}

async function main() {
  const command = process.argv[2]
  if (command === 'up') {
    const plan = await startHindsight()
    console.log(`Hindsight ready at ${plan.apiUrl}`)
    return
  }
  if (command === 'down') {
    await stopHindsight(process.env, {
      deleteData: process.argv.includes('--delete-data'),
    })
    console.log('Hindsight stopped')
    return
  }
  if (command === 'backup') {
    console.log(`Hindsight backup created: ${await backupHindsight()}`)
    return
  }
  if (command === 'restore') {
    const archive = process.argv[3]
    if (!archive || !process.argv.includes('--confirm-restore'))
      throw new Error(
        'Usage: hindsight-ops restore <archive> --confirm-restore',
      )
    await restoreHindsight(archive)
    console.log('Hindsight backup restored')
    return
  }
  throw new Error(
    'Usage: hindsight-ops <up|down|backup|restore <archive> --confirm-restore>',
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
