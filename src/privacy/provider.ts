import type {
  JsonModelProvider,
  JsonModelRequest,
  JsonModelResult,
} from '../model/provider.js'
import type { TextPrivacyMasker } from './masker.js'

/** Applies fail-closed masking at Pegas's model provider boundary. */
export class PrivacyMaskingProvider implements JsonModelProvider {
  readonly name: string
  readonly #provider: JsonModelProvider
  readonly #masker: TextPrivacyMasker

  constructor(provider: JsonModelProvider, masker: TextPrivacyMasker) {
    this.name = provider.name
    this.#provider = provider
    this.#masker = masker
  }

  async generateJson(request: JsonModelRequest): Promise<unknown> {
    return (await this.generateJsonWithUsage(request)).value
  }

  async generateJsonWithUsage(
    request: JsonModelRequest,
  ): Promise<JsonModelResult> {
    const system = this.#masker.mask(request.system).text
    const input = this.#masker.mask(request.input).text
    const masked: JsonModelRequest = {
      ...request,
      system,
      input,
    }
    const result = this.#provider.generateJsonWithUsage
      ? await this.#provider.generateJsonWithUsage(masked)
      : { value: await this.#provider.generateJson(masked) }
    return {
      value: restoreValue(result.value, this.#masker),
      ...(result.usage ? { usage: result.usage } : {}),
    }
  }
}

function restoreValue(value: unknown, masker: TextPrivacyMasker): unknown {
  if (typeof value === 'string') return masker.restore(value)
  if (Array.isArray(value)) return value.map(item => restoreValue(item, masker))
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      restoreValue(item, masker),
    ]),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
