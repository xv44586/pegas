import type { JsonModelProvider, JsonModelRequest } from './provider.js'

export interface AnthropicProviderOptions {
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs?: number
}

export class AnthropicProvider implements JsonModelProvider {
  readonly name = 'anthropic-messages'
  readonly #endpoint: URL
  readonly #model: string
  readonly #apiKey?: string
  readonly #timeoutMs: number

  constructor(options: AnthropicProviderOptions) {
    this.#endpoint = new URL(
      'v1/messages',
      `${options.baseUrl.replace(/\/+$/, '')}/`,
    )
    this.#model = options.model
    this.#apiKey = options.apiKey
    this.#timeoutMs = options.timeoutMs ?? 15_000
  }

  async generateJson(request: JsonModelRequest): Promise<unknown> {
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
      throw new Error(
        `Model provider returned ${String(response.status)}${detail ? `: ${detail}` : ''}`,
      )
    }
    return extractToolInput(await response.json())
  }
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
