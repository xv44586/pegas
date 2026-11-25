import { randomUUID } from 'node:crypto'

import type { PegasStore } from '../storage/sqlite-store.js'
import { opaqueKey } from './derived-memory.js'
import type {
  DerivedMemory,
  DerivedMemoryProvider,
  DerivedMemoryRecallInput,
  DerivedMemoryRetainInput,
} from './derived-memory.js'

/** One distilled fact produced by the local memory writer. */
export interface LocalMemoryCandidate {
  text: string
  type: 'world' | 'experience' | 'observation'
  /** pegas:global for durable cross-project facts, otherwise a context tag. */
  scope: 'global' | 'context'
}

/**
 * Bounded model boundary for the local provider. The worker injects the
 * configured control-plane model (metered as `memory`); tests inject a fake.
 * Returning an empty array means "nothing worth remembering" and completes
 * the job without writing.
 */
export type LocalMemoryDistiller = (input: {
  evidence: string
  context: string
}) => Promise<LocalMemoryCandidate[]>

export interface LocalDerivedMemoryProviderOptions {
  distill: LocalMemoryDistiller
  /** Same key the PegasDerivedMemoryService uses for owner banks. */
  hmacKey: string
  /** Maximum evidence characters sent to the model in one call. */
  maxEvidenceCharacters?: number
}

const MINIMUM_EVIDENCE_CHARACTERS = 80

/**
 * MEMORY-001 M2: in-process DerivedMemoryProvider backed by the Pegas SQLite
 * database. Retain distills bounded Run evidence with one model call per
 * coalescing window and stores the resulting facts in `local_derived_memories`;
 * recall is keyword FTS over the same table. No external service, no new
 * runtime dependency. Tombstones stay authoritative in the shared M1 tables:
 * every read re-checks suppression so deleted or corrected facts never
 * reappear, and writes skip suppressed content.
 */
export class LocalDerivedMemoryProvider implements DerivedMemoryProvider {
  readonly #store: PegasStore
  readonly #distill: LocalMemoryDistiller
  readonly #hmacKey: string
  readonly #maxEvidenceCharacters: number

  constructor(store: PegasStore, options: LocalDerivedMemoryProviderOptions) {
    this.#store = store
    this.#distill = options.distill
    this.#hmacKey = options.hmacKey
    this.#maxEvidenceCharacters = options.maxEvidenceCharacters ?? 12_000
  }

  /**
   * Banks are opaque HMACs of owner IDs. The local provider resolves them by
   * recomputing the mapping for known owners; an unknown bank sees nothing.
   */
  #ownerForBank(bankId: string): string | undefined {
    return this.#store
      .listDerivedMemoryUsers()
      .find(userId => opaqueKey('owner', userId, this.#hmacKey) === bankId)
  }

  retain(bankId: string, input: DerivedMemoryRetainInput): Promise<string> {
    const userId = this.#ownerForBank(bankId)
    if (!userId) {
      return Promise.reject(new Error('Unknown derived memory bank'))
    }
    return this.#retain(userId, input)
  }

  async #retain(
    userId: string,
    input: DerivedMemoryRetainInput,
  ): Promise<string> {
    const existing = this.#store.localMemoryOperation(userId, input.operationId)
    if (existing) return existing

    const evidence = input.content.slice(0, this.#maxEvidenceCharacters)
    if (evidence.trim().length < MINIMUM_EVIDENCE_CHARACTERS) {
      this.#store.completeLocalMemoryOperation(userId, input.operationId, 0)
      return input.operationId
    }
    if (
      this.#store.isDerivedMemorySuppressed(userId, {
        id: input.documentId,
        text: evidence,
        type: 'experience',
        tags: input.tags,
        metadata: input.metadata,
      })
    ) {
      this.#store.completeLocalMemoryOperation(userId, input.operationId, 0)
      return input.operationId
    }

    const candidates = await this.#distill({
      evidence,
      context: input.context,
    })
    let written = 0
    for (const candidate of candidates.slice(0, 8)) {
      const text = candidate.text.trim().slice(0, 2_000)
      if (!text) continue
      // M3: a fact distilled inside a project never enters the global bank
      // (project facts must not pollute cross-project recall). Global scope
      // is only available to project-less work; it keeps the M1 contract of
      // carrying source context tags for the cross-workspace audit.
      const projectKey = input.projectKey
      const scope = projectKey ? 'context' : candidate.scope
      const tags =
        scope === 'global'
          ? [...new Set(['pegas:global', ...input.tags])]
          : input.tags.filter(tag => tag !== 'pegas:global')
      const memory: DerivedMemory = {
        id: randomUUID(),
        text,
        type: candidate.type,
        tags,
        metadata: input.metadata,
        state: 'valid',
        ...(projectKey ? { projectKey } : {}),
      }
      if (this.#store.isDerivedMemorySuppressed(userId, memory)) continue
      this.#store.insertLocalDerivedMemory(userId, memory, projectKey)
      written += 1
    }
    this.#store.completeLocalMemoryOperation(userId, input.operationId, written)
    return input.operationId
  }

  operationStatus(
    bankId: string,
    operationId: string,
  ): Promise<{
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
    error?: string
  }> {
    const userId = this.#ownerForBank(bankId)
    const completed =
      userId !== undefined &&
      this.#store.localMemoryOperation(userId, operationId) !== undefined
    return Promise.resolve({
      status: completed ? ('completed' as const) : ('pending' as const),
    })
  }

  recall(
    bankId: string,
    input: DerivedMemoryRecallInput,
  ): Promise<DerivedMemory[]> {
    const userId = this.#ownerForBank(bankId)
    if (!userId) return Promise.resolve([])
    // Tag filtering stays in PegasDerivedMemoryService so cross-context
    // candidates surface in the recall audit as context_mismatch.
    const memories = this.#store.searchLocalDerivedMemories(userId, {
      query: input.query,
      limit: 24,
      ...(input.projectKey ? { projectKey: input.projectKey } : {}),
    })
    const visible = memories.filter(
      memory => !this.#store.isDerivedMemorySuppressed(userId, memory),
    )
    return Promise.resolve(visible)
  }

  list(bankId: string): Promise<DerivedMemory[]> {
    const userId = this.#ownerForBank(bankId)
    if (!userId) return Promise.resolve([])
    const memories = this.#store
      .listLocalDerivedMemories(userId)
      .filter(memory => !this.#store.isDerivedMemorySuppressed(userId, memory))
    return Promise.resolve(memories)
  }

  get(bankId: string, memoryId: string): Promise<DerivedMemory> {
    const userId = this.#ownerForBank(bankId)
    const memory = userId
      ? this.#store.localDerivedMemoryById(userId, memoryId)
      : undefined
    if (
      !userId ||
      !memory ||
      this.#store.isDerivedMemorySuppressed(userId, memory)
    ) {
      return Promise.reject(new Error('Derived memory not found'))
    }
    return Promise.resolve(memory)
  }

  invalidate(bankId: string, memoryId: string, reason: string): Promise<void> {
    const userId = this.#ownerForBank(bankId)
    if (userId) {
      this.#store.invalidateLocalDerivedMemory(userId, memoryId, reason)
    }
    return Promise.resolve()
  }
}
