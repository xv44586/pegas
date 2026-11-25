import type {
  DerivedMemory,
  DerivedMemoryProvider,
  DerivedMemoryRecallInput,
  DerivedMemoryRetainInput,
  DerivedMemoryType,
} from './derived-memory.js'

type Fetch = typeof fetch

export class HindsightProvider implements DerivedMemoryProvider {
  readonly #baseUrl: string
  readonly #apiKey: string | undefined
  readonly #timeoutMs: number
  readonly #fetch: Fetch
  readonly #minimumScore: number
  readonly #shutdownSignal: AbortSignal | undefined

  constructor(options: {
    baseUrl: string
    apiKey?: string
    timeoutMs?: number
    minimumScore?: number
    fetch?: Fetch
    shutdownSignal?: AbortSignal
  }) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(baseUrl))
      throw new Error('Hindsight base URL must use http or https')
    this.#baseUrl = baseUrl
    this.#apiKey = options.apiKey
    this.#timeoutMs = options.timeoutMs ?? 5_000
    this.#fetch = options.fetch ?? fetch
    this.#minimumScore = options.minimumScore ?? 0.2
    this.#shutdownSignal = options.shutdownSignal
  }

  async retain(
    bankId: string,
    input: DerivedMemoryRetainInput,
  ): Promise<string> {
    const result = await this.#json(
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
      {
        method: 'POST',
        body: JSON.stringify({
          async: true,
          operation_id: input.operationId,
          items: [
            {
              content: input.content,
              context: input.context,
              document_id: input.documentId,
              metadata: input.metadata,
              tags: input.tags,
              update_mode: 'replace',
            },
          ],
        }),
      },
    )
    const operationId = stringField(result, 'operation_id')
    if (!operationId) throw new Error('Hindsight retain omitted operation_id')
    return operationId
  }

  async operationStatus(
    bankId: string,
    operationId: string,
  ): Promise<{
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
    error?: string
  }> {
    const result = await this.#json(
      `/v1/default/banks/${encodeURIComponent(bankId)}/operations/${encodeURIComponent(operationId)}`,
    )
    const status = stringField(result, 'status')
    if (
      status !== 'pending' &&
      status !== 'processing' &&
      status !== 'completed' &&
      status !== 'failed' &&
      status !== 'cancelled'
    )
      throw new Error('Hindsight operation returned an invalid status')
    const error =
      stringField(result, 'error_message') ?? stringField(result, 'error')
    return { status, ...(error ? { error } : {}) }
  }

  async recall(
    bankId: string,
    input: DerivedMemoryRecallInput,
  ): Promise<DerivedMemory[]> {
    const result = await this.#json(
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
      {
        method: 'POST',
        body: JSON.stringify({
          query: input.query,
          max_tokens: input.maxTokens,
          budget: 'mid',
          types: ['world', 'experience', 'observation'],
          tags: input.tags,
          tags_match: 'any',
        }),
      },
    )
    const results = arrayField(result, 'results')
    return results
      .map(parseMemory)
      .filter((memory): memory is DerivedMemory => memory !== undefined)
      .filter(memory =>
        memory.score === undefined ? true : memory.score >= this.#minimumScore,
      )
  }

  async list(bankId: string): Promise<DerivedMemory[]> {
    const memories: DerivedMemory[] = []
    for (let offset = 0; offset < 10_000; offset += 100) {
      const result = await this.#json(
        `/v1/default/banks/${encodeURIComponent(bankId)}/memories/list?limit=100&offset=${String(offset)}&state=valid`,
      )
      const page = arrayField(result, 'items')
        .map(parseMemory)
        .filter((memory): memory is DerivedMemory => memory !== undefined)
      memories.push(...page)
      const total = numberField(result, 'total')
      if (
        page.length < 100 ||
        (total !== undefined && memories.length >= total)
      )
        return memories
    }
    throw new Error('Hindsight memory listing exceeded 10,000 records')
  }

  async get(bankId: string, memoryId: string): Promise<DerivedMemory> {
    const result = await this.#json(
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories/${encodeURIComponent(memoryId)}`,
    )
    const memory = parseMemory(result)
    if (!memory) throw new Error('Hindsight returned a malformed memory')
    return memory
  }

  async invalidate(
    bankId: string,
    memoryId: string,
    reason: string,
  ): Promise<void> {
    await this.#json(
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories/${encodeURIComponent(memoryId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          state: 'invalidated',
          reason: reason.slice(0, 500),
        }),
      },
    )
  }

  async #json(path: string, init: RequestInit = {}): Promise<unknown> {
    if (this.#shutdownSignal?.aborted)
      throw new Error('Hindsight request cancelled during shutdown')
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(new Error('Hindsight request timed out')),
      this.#timeoutMs,
    )
    timeout.unref()
    const abortForShutdown = () =>
      controller.abort(new Error('Hindsight request cancelled during shutdown'))
    if (this.#shutdownSignal?.aborted) abortForShutdown()
    else
      this.#shutdownSignal?.addEventListener('abort', abortForShutdown, {
        once: true,
      })
    try {
      const headers = new Headers(init.headers)
      headers.set('accept', 'application/json')
      if (init.body) headers.set('content-type', 'application/json')
      if (this.#apiKey) headers.set('authorization', `Bearer ${this.#apiKey}`)
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      })
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1_000)
        throw new Error(
          `Hindsight HTTP ${String(response.status)}${detail ? `: ${detail}` : ''}`,
        )
      }
      return await response.json()
    } finally {
      clearTimeout(timeout)
      this.#shutdownSignal?.removeEventListener('abort', abortForShutdown)
    }
  }
}

function parseMemory(value: unknown): DerivedMemory | undefined {
  if (!isRecord(value)) return undefined
  const id = stringField(value, 'id') ?? stringField(value, 'memory_id')
  const text = stringField(value, 'text') ?? stringField(value, 'content')
  const rawType =
    stringField(value, 'type') ?? stringField(value, 'fact_type') ?? 'world'
  if (!id || !text || !isMemoryType(rawType)) return undefined
  const rawScore =
    numberField(value, 'reranker_score') ??
    numberField(value, 'final_score') ??
    numberField(value, 'score')
  const rawTags = value.tags
  const metadata = isRecord(value.metadata) ? value.metadata : {}
  const state = stringField(value, 'state')
  return {
    id,
    text,
    type: rawType,
    ...(rawScore === undefined ? {} : { score: rawScore }),
    tags: Array.isArray(rawTags)
      ? rawTags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    metadata,
    ...(state === 'valid' || state === 'invalidated' ? { state } : {}),
  }
}

function isMemoryType(value: string): value is DerivedMemoryType {
  return value === 'world' || value === 'experience' || value === 'observation'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const candidate = value[key]
  return typeof candidate === 'string' && candidate.trim()
    ? candidate
    : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined
  const candidate = value[key]
  return typeof candidate === 'number' && Number.isFinite(candidate)
    ? candidate
    : undefined
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return []
  return value[key]
}
