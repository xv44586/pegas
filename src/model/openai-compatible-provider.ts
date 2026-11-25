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

export interface OpenAiCompatibleProviderOptions {
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs?: number
  retry?: ModelRetryOptions
}

export class OpenAiCompatibleProvider implements JsonModelProvider {
  readonly name = 'openai-compatible'
  readonly #endpoint: URL
  readonly #model: string
  readonly #apiKey?: string
  readonly #timeoutMs: number
  readonly #retry: ModelRetryOptions

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.#endpoint = new URL(
      'chat/completions',
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
            ...(this.#apiKey
              ? { authorization: `Bearer ${this.#apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: this.#model,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.input },
            ],
            response_format: { type: 'json_object' },
            temperature: 0,
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
        const content = extractContent(body)
        try {
          return {
            value: JSON.parse(content) as unknown,
            ...(extractUsage(body) ? { usage: extractUsage(body) } : {}),
          }
        } catch {
          throw new Error('Model provider did not return valid JSON')
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
  const prompt = nonNegative(usage.prompt_tokens)
  const completion = nonNegative(usage.completion_tokens)
  if (prompt === undefined && completion === undefined) return undefined
  const details = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : undefined
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : undefined
  const cacheRead = nonNegative(details?.cached_tokens)
  const reasoning = nonNegative(completionDetails?.reasoning_tokens)
  return {
    ...(prompt === undefined ? {} : { inputTokens: prompt }),
    ...(completion === undefined ? {} : { outputTokens: completion }),
    ...(prompt !== undefined && completion !== undefined
      ? { totalTokens: prompt + completion }
      : {}),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined
}

function extractContent(value: unknown): string {
  if (!isRecord(value)) {
    throw new Error('Model provider returned an invalid response')
  }
  const choices: unknown = value.choices
  if (!Array.isArray(choices)) {
    throw new Error('Model provider returned an invalid response')
  }
  const first: unknown = choices[0]
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new Error('Model provider returned no message')
  }
  const content = first.message.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Model provider returned empty content')
  }
  return content
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
