import type { JsonModelProvider } from '../model/provider.js'
import type { RouterTraceCall } from '../observability/message-trace.js'
import { tracePreview } from '../observability/trace-preview.js'

export interface InputRewriter {
  rewrite(text: string): Promise<string>
}

export class ModelInputRewriter implements InputRewriter {
  readonly #provider: JsonModelProvider

  readonly #observeCall:
    ((call: Omit<RouterTraceCall, 'at'>) => void) | undefined

  constructor(
    provider: JsonModelProvider,
    observeCall?: (call: Omit<RouterTraceCall, 'at'>) => void,
  ) {
    this.#provider = provider
    this.#observeCall = observeCall
  }

  async rewrite(text: string): Promise<string> {
    try {
      return await this.testRewrite(text)
    } catch {
      return text
    }
  }

  async testRewrite(text: string): Promise<string> {
    const started = performance.now()
    let outcome: RouterTraceCall['outcome'] = 'provider_error'
    let rewritten: string | undefined
    try {
      const value = await this.#provider.generateJson({
        system: rewriteSystemPrompt,
        input: text,
        schema: rewriteSchema,
      })
      outcome = 'invalid_response'
      if (!isRecord(value) || typeof value.text !== 'string')
        throw new Error('改写模型返回无效结果')
      rewritten = value.text.trim()
      if (!rewritten || rewritten.length > 20_000)
        throw new Error('改写模型返回无效结果')
      outcome = 'ok'
      return rewritten
    } finally {
      if (this.#observeCall) {
        try {
          this.#observeCall({
            component: 'rewrite',
            model: this.#provider.name,
            durationMs: Math.round(performance.now() - started),
            outcome,
            input: tracePreview(text),
            ...(outcome === 'ok' && rewritten
              ? { output: tracePreview(rewritten) }
              : {}),
          })
        } catch {
          // The optional trace sink must not change the rewrite outcome.
        }
      }
    }
  }
}

const rewriteSystemPrompt = `Rewrite one user message for a personal agent.
Correct obvious speech-recognition errors, punctuation, filler words, and broken sentence boundaries.
Preserve the user's language, intent, constraints, names, numbers, URLs, paths, code, and uncertainty.
Do not answer, summarize, add facts, remove requirements, or turn uncertainty into certainty.
Return one JSON object only: {"text":"rewritten message"}.`

const rewriteSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
