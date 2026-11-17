import type { JsonModelProvider, JsonModelRequest } from '../model/provider.js'
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
    const system = this.#masker.mask(request.system).text
    const input = this.#masker.mask(request.input).text
    const response = await this.#provider.generateJson({
      ...request,
      system,
      input,
    })
    return restoreValue(response, this.#masker)
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
