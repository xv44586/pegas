import type { JsonModelProvider, JsonModelRequest } from './provider.js'

export interface OpenAiCompatibleProviderOptions {
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs?: number
}

export class OpenAiCompatibleProvider implements JsonModelProvider {
  readonly name = 'openai-compatible'
  readonly #endpoint: URL
  readonly #model: string
  readonly #apiKey?: string
  readonly #timeoutMs: number

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.#endpoint = new URL(
      'chat/completions',
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
        ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
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
      throw new Error(
        `Model provider returned ${String(response.status)}${detail ? `: ${detail}` : ''}`,
      )
    }

    const body: unknown = await response.json()
    const content = extractContent(body)
    try {
      return JSON.parse(content) as unknown
    } catch {
      throw new Error('Model provider did not return valid JSON')
    }
  }
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
