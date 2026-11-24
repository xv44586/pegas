import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

import {
  backupHindsight,
  HINDSIGHT_ARM64_IMAGE,
  HINDSIGHT_PREVIOUS_ARM64_IMAGE,
  PGVECTOR_ARM64_IMAGE,
  restoreHindsight,
  startHindsight,
  stopHindsight,
} from './hindsight-ops.mjs'
import { PegasDerivedMemoryService } from '../dist/memory/derived-memory.js'
import { HindsightProvider } from '../dist/memory/hindsight-provider.js'

const suffix = `${String(process.pid)}-${randomUUID().slice(0, 8)}`
const temporaryRoot = mkdtempSync(resolve('.tmp-pegas-memory-canary-'))
const port = await availablePort()
const baseEnvironment = {
  ...process.env,
  PEGAS_HINDSIGHT_RUNTIME_PREFIX: `pegas-memory-canary-${suffix}`,
  PEGAS_HINDSIGHT_DB_VOLUME: `pegas-memory-canary-pg-${suffix}`,
  PEGAS_HINDSIGHT_DB_PASSWORD: randomUUID(),
  PEGAS_HINDSIGHT_BACKUP_DIR: join(temporaryRoot, 'backups'),
  PEGAS_HINDSIGHT_PORT: String(port),
  PEGAS_HINDSIGHT_IMAGE:
    process.env.PEGAS_MEMORY_CANARY_HINDSIGHT_IMAGE ?? HINDSIGHT_ARM64_IMAGE,
  PEGAS_HINDSIGHT_POSTGRES_IMAGE:
    process.env.PEGAS_MEMORY_CANARY_POSTGRES_IMAGE ?? PGVECTOR_ARM64_IMAGE,
  PEGAS_HINDSIGHT_LLM_PROVIDER: 'openai',
  PEGAS_HINDSIGHT_LLM_BASE_URL:
    process.env.PEGAS_MEMORY_CANARY_LLM_BASE_URL ??
    'http://host.docker.internal:3425/v1',
  PEGAS_HINDSIGHT_LLM_API_KEY:
    process.env.PEGAS_MEMORY_CANARY_LLM_API_KEY ?? 'not-needed',
  PEGAS_HINDSIGHT_LLM_MODEL:
    process.env.PEGAS_MEMORY_CANARY_LLM_MODEL ??
    'discovery-api/deepseek-v4.1-flash-1017',
}
const marker = `PegasMemoryCanary${randomUUID().replaceAll('-', '')}`
const owner = 'memory-canary-owner'
const otherOwner = 'memory-canary-other-owner'
const hmacKey = randomUUID()

try {
  console.log(
    'memory canary: starting Hindsight v1.2.2 with persistent PostgreSQL',
  )
  await startHindsight({
    ...baseEnvironment,
    PEGAS_HINDSIGHT_IMAGE:
      process.env.PEGAS_MEMORY_CANARY_PREVIOUS_HINDSIGHT_IMAGE ??
      HINDSIGHT_PREVIOUS_ARM64_IMAGE,
  })
  let service = createService(port, hmacKey)
  const initialOperation = await service.submit({
    id: randomUUID(),
    userId: owner,
    taskId: 'canary-task',
    runId: 'canary-run',
    kind: 'run_success',
    documentId: `pegas:canary:${marker}`,
    content: `Verified outcome: ${marker} uses pnpm for package management.`,
    workingDirectory: '/workspace/memory-canary',
    attempts: 1,
  })
  await waitForOperation(service, owner, initialOperation)
  await assertRecall(service, owner, marker, true)

  console.log('memory canary: upgrading the same database to Hindsight v1.2.3')
  await stopHindsight(baseEnvironment)
  await startHindsight(baseEnvironment)
  service = createService(port, hmacKey)
  await assertRecall(service, owner, marker, true)

  console.log('memory canary: checking owner isolation and correction')
  const otherOperation = await service.submit({
    id: randomUUID(),
    userId: otherOwner,
    taskId: 'other-task',
    runId: 'other-run',
    kind: 'run_success',
    documentId: `pegas:canary:other:${marker}`,
    content: 'Verified outcome: the unrelated owner uses cargo.',
    workingDirectory: '/workspace/memory-canary',
    attempts: 1,
  })
  await waitForOperation(service, otherOwner, otherOperation)
  await assertRecall(service, otherOwner, marker, false)
  const listed = await service.list(owner)
  const raw = listed.find(
    memory =>
      memory.type !== 'observation' &&
      (memory.text.includes(marker) ||
        memory.text.toLowerCase().includes('pnpm')),
  )
  if (!raw) throw new Error('Hindsight list omitted the retained raw fact')
  const correctionJob = {
    id: randomUUID(),
    commandId: randomUUID(),
    userId: owner,
    memoryId: raw.id,
    memoryType: raw.type,
    replacementText: `${marker} uses pnpm version 11.`,
    tags: raw.tags,
    metadata: raw.metadata,
    attempts: 1,
  }
  const correctionOperation = await service.submitCorrection(correctionJob)
  await waitForCorrection(service, {
    ...correctionJob,
    providerOperationId: correctionOperation,
  })
  await service.invalidate({
    id: randomUUID(),
    userId: owner,
    memoryId: raw.id,
    memoryType: raw.type,
    reason: 'Superseded by a canary correction',
    attempts: 1,
  })
  const corrected = await service.list(owner)
  if (
    corrected.some(
      memory => memory.id === raw.id && memory.state !== 'invalidated',
    )
  )
    throw new Error('Superseded raw fact remained valid')

  console.log('memory canary: backing up, mutating and restoring Hindsight')
  const archive = await backupHindsight(baseEnvironment)
  if (!existsSync(archive) || statSync(archive).size === 0)
    throw new Error('Hindsight backup archive is missing or empty')
  const afterBackupMarker = `${marker}AfterBackup`
  const afterBackupOperation = await service.submit({
    id: randomUUID(),
    userId: owner,
    taskId: 'canary-task',
    runId: 'canary-run-after-backup',
    kind: 'run_success',
    documentId: `pegas:canary:${afterBackupMarker}`,
    content: `Verified outcome: ${afterBackupMarker} is temporary.`,
    workingDirectory: '/workspace/memory-canary',
    attempts: 1,
  })
  await waitForOperation(service, owner, afterBackupOperation)
  await restoreHindsight(archive, baseEnvironment)
  service = createService(port, hmacKey)
  await assertRecall(service, owner, marker, true)
  await assertRecall(service, owner, afterBackupMarker, false)

  console.log(
    JSON.stringify({
      status: 'passed',
      provider: 'hindsight',
      upgradedFrom: '1.2.2',
      upgradedTo: '1.2.3',
      persistentPostgres: true,
      backupRestore: true,
      ownerIsolation: true,
      correction: true,
    }),
  )
} finally {
  await stopHindsight(baseEnvironment, { deleteData: true }).catch(error => {
    console.warn(`memory canary cleanup failed: ${String(error)}`)
  })
  const safePrefix = resolve('.tmp-pegas-memory-canary-')
  if (temporaryRoot.startsWith(safePrefix))
    rmSync(temporaryRoot, { recursive: true, force: true })
}

function createService(port, hmacKey) {
  return new PegasDerivedMemoryService(
    new HindsightProvider({
      baseUrl: `http://127.0.0.1:${String(port)}`,
      timeoutMs: 60_000,
    }),
    { hmacKey },
  )
}

async function waitForOperation(service, userId, operationId) {
  const job = {
    id: operationId,
    userId,
    taskId: 'canary-task',
    runId: 'canary-run',
    kind: 'run_success',
    documentId: 'canary',
    content: '',
    workingDirectory: '/workspace/memory-canary',
    providerOperationId: operationId,
    attempts: 1,
  }
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    const status = await service.operationStatus(job)
    if (status.status === 'completed') return
    if (status.status === 'failed' || status.status === 'cancelled')
      throw new Error(
        `Hindsight operation ${status.status}: ${status.error ?? ''}`,
      )
    await wait(1_000)
  }
  throw new Error('Hindsight retain operation timed out')
}

async function waitForCorrection(service, job) {
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    const status = await service.correctionStatus(job)
    if (status.status === 'completed') return
    if (status.status === 'failed' || status.status === 'cancelled')
      throw new Error(
        `Hindsight correction ${status.status}: ${status.error ?? ''}`,
      )
    await wait(1_000)
  }
  throw new Error('Hindsight correction operation timed out')
}

async function assertRecall(service, userId, query, expected) {
  try {
    const result = await service.recall({
      userId,
      taskId: 'canary-task',
      runId: randomUUID(),
      query,
      workingDirectory: '/workspace/memory-canary',
    })
    const found = result.memories.some(memory =>
      memory.text.toLowerCase().includes(query.toLowerCase()),
    )
    if (found !== expected)
      throw new Error(
        `Recall expectation failed for ${query}: ${String(found)}`,
      )
  } catch (error) {
    if (!expected && error instanceof Error && /HTTP 404/.test(error.message))
      return
    throw error
  }
}

function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        rejectPort(new Error('Could not allocate a canary port'))
        return
      }
      const port = address.port
      server.close(error => (error ? rejectPort(error) : resolvePort(port)))
    })
  })
}

function wait(milliseconds) {
  return new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
}
