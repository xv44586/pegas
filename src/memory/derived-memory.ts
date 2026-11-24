import { createHmac } from 'node:crypto'
import { resolve } from 'node:path'

import type { MemoryCategory, MemoryContextEntry } from './memory.js'

export type DerivedMemoryType = 'world' | 'experience' | 'observation'

export interface DerivedMemory {
  id: string
  text: string
  type: DerivedMemoryType
  score?: number
  tags: string[]
  metadata: Record<string, unknown>
  state?: 'valid' | 'invalidated'
}

export interface DerivedMemoryRetainInput {
  operationId: string
  documentId: string
  content: string
  context: string
  tags: string[]
  metadata: Record<string, unknown>
}

export interface DerivedMemoryRecallInput {
  query: string
  maxTokens: number
  tags: string[]
}

export interface DerivedMemoryProvider {
  retain(bankId: string, input: DerivedMemoryRetainInput): Promise<string>
  operationStatus(
    bankId: string,
    operationId: string,
  ): Promise<{
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
    error?: string
  }>
  recall(
    bankId: string,
    input: DerivedMemoryRecallInput,
  ): Promise<DerivedMemory[]>
  list(bankId: string): Promise<DerivedMemory[]>
  get(bankId: string, memoryId: string): Promise<DerivedMemory>
  invalidate(bankId: string, memoryId: string, reason: string): Promise<void>
}

export interface DerivedMemoryRecallRequest {
  userId: string
  taskId: string
  runId: string
  query: string
  workingDirectory: string
}

export interface DerivedMemoryRecallAudit {
  memoryId: string
  stage: 'retrieved' | 'filtered'
  reason?:
    | 'invalidated'
    | 'context_mismatch'
    | 'result_limit'
    | 'budget'
    | 'empty'
    | 'local_tombstone'
  score?: number
}

export interface DerivedMemoryRecallService {
  recall(request: DerivedMemoryRecallRequest): Promise<{
    entries: MemoryContextEntry[]
    memories: DerivedMemory[]
    audit?: DerivedMemoryRecallAudit[]
  }>
}

export interface DerivedMemoryJob {
  id: string
  userId: string
  taskId: string
  runId: string
  kind: 'run_success' | 'run_failure'
  documentId: string
  content: string
  workingDirectory: string
  providerOperationId?: string
  attempts: number
}

export interface DerivedMemoryRetainService {
  submit(job: DerivedMemoryJob): Promise<string>
  operationStatus(job: DerivedMemoryJob): Promise<{
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
    error?: string
  }>
}

export interface DerivedMemoryCurationJob {
  id: string
  userId: string
  memoryId: string
  memoryType?: DerivedMemoryType
  reason: string
  attempts: number
}

export interface DerivedMemoryCurationService {
  invalidate(job: DerivedMemoryCurationJob): Promise<void>
}

export interface DerivedMemoryCorrectionJob {
  id: string
  commandId: string
  userId: string
  memoryId: string
  memoryType: DerivedMemoryType
  replacementText: string
  tags: string[]
  metadata: Record<string, unknown>
  providerOperationId?: string
  attempts: number
}

export interface DerivedMemoryCorrectionService {
  submitCorrection(job: DerivedMemoryCorrectionJob): Promise<string>
  correctionStatus(job: DerivedMemoryCorrectionJob): Promise<{
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
    error?: string
  }>
}

export interface DerivedMemoryBrowseService {
  list(userId: string): Promise<DerivedMemory[]>
}

export class PegasDerivedMemoryService
  implements
    DerivedMemoryRecallService,
    DerivedMemoryRetainService,
    DerivedMemoryCurationService,
    DerivedMemoryCorrectionService,
    DerivedMemoryBrowseService
{
  readonly #provider: DerivedMemoryProvider
  readonly #hmacKey: string
  readonly #maximumResults: number
  readonly #maximumTokens: number

  constructor(
    provider: DerivedMemoryProvider,
    options: {
      hmacKey: string
      maximumResults?: number
      maximumTokens?: number
    },
  ) {
    if (!options.hmacKey.trim()) throw new Error('Memory HMAC key is required')
    this.#provider = provider
    this.#hmacKey = options.hmacKey
    this.#maximumResults = options.maximumResults ?? 10
    this.#maximumTokens = options.maximumTokens ?? 1_600
    if (!Number.isSafeInteger(this.#maximumResults) || this.#maximumResults < 1)
      throw new Error('Memory result limit must be a positive integer')
    if (!Number.isSafeInteger(this.#maximumTokens) || this.#maximumTokens < 1)
      throw new Error('Memory token budget must be a positive integer')
  }

  bankId(userId: string): string {
    return opaqueKey('owner', userId, this.#hmacKey)
  }

  contextKey(workingDirectory: string): string {
    return opaqueKey('workspace', resolve(workingDirectory), this.#hmacKey)
  }

  async recall(request: DerivedMemoryRecallRequest): Promise<{
    entries: MemoryContextEntry[]
    memories: DerivedMemory[]
    audit: DerivedMemoryRecallAudit[]
  }> {
    const contextKey = this.contextKey(request.workingDirectory)
    const allowedTags = ['pegas:global', `pegas:context:${contextKey}`]
    const memories = await this.#provider.recall(this.bankId(request.userId), {
      query: request.query.slice(0, 8_000),
      maxTokens: this.#maximumTokens,
      tags: allowedTags,
    })
    const audit: DerivedMemoryRecallAudit[] = memories.map(memory => ({
      memoryId: memory.id,
      stage: 'retrieved',
      ...(memory.score === undefined ? {} : { score: memory.score }),
    }))
    const candidates: DerivedMemory[] = []
    for (const memory of memories) {
      let reason: DerivedMemoryRecallAudit['reason']
      if (memory.state === 'invalidated') reason = 'invalidated'
      else if (!memory.tags.some(tag => allowedTags.includes(tag)))
        reason = 'context_mismatch'
      else if (candidates.length >= this.#maximumResults)
        reason = 'result_limit'
      if (reason) {
        audit.push({
          memoryId: memory.id,
          stage: 'filtered',
          reason,
          ...(memory.score === undefined ? {} : { score: memory.score }),
        })
      } else candidates.push(memory)
    }
    const selected: DerivedMemory[] = []
    const maximumCharacters = this.#maximumTokens * 4
    let usedCharacters = 0
    for (const memory of candidates) {
      const remaining = maximumCharacters - usedCharacters - 200
      if (remaining <= 0) {
        audit.push(filteredAudit(memory, 'budget'))
        continue
      }
      const text = memory.text.slice(0, Math.min(4_000, remaining))
      if (!text) {
        audit.push(filteredAudit(memory, 'empty'))
        continue
      }
      selected.push({ ...memory, text })
      usedCharacters += text.length + 200
    }
    return {
      audit,
      memories: selected,
      entries: selected.map(memory => ({
        id: memory.id,
        scope: 'worker' as const,
        taskId: request.taskId,
        category: categoryFor(memory.type),
        content: memory.text.slice(0, 4_000),
        source: sourceFor(memory),
        origin: 'derived' as const,
        provider: 'hindsight' as const,
        ...(memory.score === undefined ? {} : { relevance: memory.score }),
      })),
    }
  }

  submit(job: DerivedMemoryJob): Promise<string> {
    const contextKey = this.contextKey(job.workingDirectory)
    return this.#provider.retain(this.bankId(job.userId), {
      operationId: job.id,
      documentId: job.documentId,
      content: job.content,
      context: `Pegas ${job.kind === 'run_success' ? 'successful' : 'failed'} work Run`,
      tags: [`pegas:context:${contextKey}`],
      metadata: {
        source: 'pegas',
        source_kind: job.kind,
        task_id: job.taskId,
        run_id: job.runId,
        context_key: contextKey,
      },
    })
  }

  operationStatus(job: DerivedMemoryJob) {
    if (!job.providerOperationId)
      throw new Error('Derived memory job has no provider operation ID')
    return this.#provider.operationStatus(
      this.bankId(job.userId),
      job.providerOperationId,
    )
  }

  invalidate(job: DerivedMemoryCurationJob): Promise<void> {
    if (job.memoryType === 'observation') return Promise.resolve()
    return this.#provider.invalidate(
      this.bankId(job.userId),
      job.memoryId,
      job.reason,
    )
  }

  list(userId: string): Promise<DerivedMemory[]> {
    return this.#provider.list(this.bankId(userId))
  }

  async submitCorrection(job: DerivedMemoryCorrectionJob): Promise<string> {
    return this.#provider.retain(this.bankId(job.userId), {
      operationId: job.id,
      documentId: `pegas:correction:${job.id}`,
      content: `User correction:\n${job.replacementText}`,
      context: 'Pegas user-confirmed correction',
      tags: job.tags.length > 0 ? job.tags : ['pegas:global'],
      metadata: {
        ...job.metadata,
        source: 'pegas',
        source_kind: 'user_correction',
        correction_of: job.memoryId,
      },
    })
  }

  correctionStatus(job: DerivedMemoryCorrectionJob) {
    if (!job.providerOperationId)
      throw new Error('Derived memory correction has no provider operation ID')
    return this.#provider.operationStatus(
      this.bankId(job.userId),
      job.providerOperationId,
    )
  }
}

function filteredAudit(
  memory: DerivedMemory,
  reason: NonNullable<DerivedMemoryRecallAudit['reason']>,
): DerivedMemoryRecallAudit {
  return {
    memoryId: memory.id,
    stage: 'filtered',
    reason,
    ...(memory.score === undefined ? {} : { score: memory.score }),
  }
}

export function opaqueKey(
  namespace: 'owner' | 'workspace',
  value: string,
  key: string,
): string {
  if (!value.trim()) throw new Error(`${namespace} value is required`)
  if (!key.trim()) throw new Error('Memory HMAC key is required')
  return `pegas-${namespace}-${createHmac('sha256', key)
    .update(value)
    .digest('hex')}`
}

function categoryFor(type: DerivedMemoryType): MemoryCategory {
  return type === 'experience' ? 'experience' : 'fact'
}

function sourceFor(memory: DerivedMemory): MemoryContextEntry['source'] {
  const runId = nonemptyMetadata(memory.metadata.run_id)
  if (runId) return { kind: 'run', id: runId }
  const taskId = nonemptyMetadata(memory.metadata.task_id)
  if (taskId) return { kind: 'task', id: taskId }
  return { kind: 'artifact', id: `hindsight:${memory.id}` }
}

function nonemptyMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
