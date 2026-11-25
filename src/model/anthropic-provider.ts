import type {
  JsonModelProvider,
  JsonModelRequest,
  JsonModelResult,
  ModelCallUsage,
} from './provider.js'
import {
  ModelHttpError,
  retryAfterMs,
  withModelRetry,
  type ModelRetryOptions,
} from './retry.js'

export interface AnthropicProviderOptions {
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs?: number
  retry?: ModelRetryOptions
}

export class AnthropicProvider implements JsonModelProvider {
  readonly name = 'anthropic-messages'
  readonly #endpoint: URL
  readonly #model: string
  readonly #apiKey?: string
  readonly #timeoutMs: number
  readonly #retry: ModelRetryOptions

  constructor(options: AnthropicProviderOptions) {
    this.#endpoint = new URL(
      'v1/messages',
      `${options.baseUrl.replace(/\/+$/, '')}/`,
    )
    this.#model = options.model
    this.#apiKey = options.apiKey
    this.#timeoutMs = options.timeoutMs ?? 15_000
    this.#retry = options.retry ?? {}
  }

  async generateJson(request: JsonModelRequest): Promise<unknown> {
    return (await this.generateJsonWithUsage(request)).value
  }

  async generateJsonWithUsage(
    request: JsonModelRequest,
  ): Promise<JsonModelResult> {
    return withModelRetry(
      async () => {
        const timeoutSignal = AbortSignal.timeout(this.#timeoutMs)
        const signal = request.signal
          ? AbortSignal.any([request.signal, timeoutSignal])
          : timeoutSignal
        const response = await fetch(this.#endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.#apiKey ? { 'x-api-key': this.#apiKey } : {}),
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: this.#model,
            max_tokens: 2048,
            temperature: 0,
            system: request.system,
            messages: [{ role: 'user', content: request.input }],
            tools: [
              {
                name: 'return_json',
                description: 'Return the structured JSON result.',
                input_schema: request.schema ?? defaultObjectSchema,
              },
            ],
            tool_choice: { type: 'tool', name: 'return_json' },
          }),
          signal,
        })
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 2048)
          throw new ModelHttpError(
            response.status,
            detail,
            retryAfterMs(response.headers.get('retry-after')),
          )
        }
        const body: unknown = await response.json()
        const usage = extractUsage(body)
        return {
          value: extractToolInput(body),
          ...(usage ? { usage } : {}),
        }
      },
      request.signal,
      this.#retry,
    )
  }
}

function extractUsage(value: unknown): ModelCallUsage | undefined {
  if (!isRecord(value) || !isRecord(value.usage)) return undefined
  const usage = value.usage
  const input = nonNegative(usage.input_tokens)
  const output = nonNegative(usage.output_tokens)
  if (input === undefined && output === undefined) return undefined
  const cacheRead = nonNegative(usage.cache_read_input_tokens)
  const cacheWrite = nonNegative(usage.cache_creation_input_tokens)
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(input !== undefined && output !== undefined
      ? { totalTokens: input + output }
      : {}),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  }
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined
}

const defaultObjectSchema = { type: 'object', additionalProperties: true }

function extractToolInput(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    throw new Error('Model provider returned an invalid response')
  }
  const content: unknown[] = value.content
  const block = content.find(
    candidate =>
      isRecord(candidate) &&
      candidate.type === 'tool_use' &&
      candidate.name === 'return_json',
  )
  if (!isRecord(block) || !('input' in block)) {
    throw new Error('Model provider returned no structured result')
  }
  return block.input
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
