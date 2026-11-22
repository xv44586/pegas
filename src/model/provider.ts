export interface JsonModelRequest {
  system: string
  input: string
  schema?: Record<string, unknown>
  signal?: AbortSignal
}

export interface ModelCallUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface JsonModelResult {
  value: unknown
  usage?: ModelCallUsage
}

/** A small control-plane model boundary. Task execution remains owned by DSH. */
export interface JsonModelProvider {
  readonly name: string
  generateJson(request: JsonModelRequest): Promise<unknown>
  generateJsonWithUsage?(request: JsonModelRequest): Promise<JsonModelResult>
}
