import type {
  SpeechAudioInput,
  SpeechRecognitionProvider,
  SpeechTranscript,
} from './provider.js'

export interface OpenAiTranscriptionProviderOptions {
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs?: number
}

/** OpenAI-compatible audio transcription provider. */
export class OpenAiTranscriptionProvider implements SpeechRecognitionProvider {
  readonly name = 'openai-compatible'
  readonly model: string
  readonly #endpoint: URL
  readonly #apiKey?: string
  readonly #timeoutMs: number

  constructor(options: OpenAiTranscriptionProviderOptions) {
    this.#endpoint = new URL(
      'audio/transcriptions',
      `${options.baseUrl.replace(/\/+$/, '')}/`,
    )
    this.model = options.model
    this.#apiKey = options.apiKey
    this.#timeoutMs = options.timeoutMs ?? 120_000
  }

  async transcribe(input: SpeechAudioInput): Promise<SpeechTranscript> {
    const form = new FormData()
    form.append('model', this.model)
    form.append(
      'file',
      new Blob([input.audio], { type: input.contentType }),
      input.filename,
    )
    if (input.language) form.append('language', input.language)

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs)
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeoutSignal])
      : timeoutSignal
    const response = await fetch(this.#endpoint, {
      method: 'POST',
      headers: {
        ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
      },
      body: form,
      signal,
    })

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2048)
      throw new Error(
        `Speech provider returned ${String(response.status)}${detail ? `: ${detail}` : ''}`,
      )
    }

    const body: unknown = await response.json()
    if (!isRecord(body) || typeof body.text !== 'string' || !body.text.trim()) {
      throw new Error('Speech provider returned an empty transcript')
    }

    return {
      text: body.text.trim(),
      ...(typeof body.language === 'string' && body.language.trim()
        ? { language: body.language.trim() }
        : {}),
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
