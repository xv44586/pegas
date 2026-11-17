export interface JsonModelRequest {
  system: string
  input: string
  schema?: Record<string, unknown>
  signal?: AbortSignal
}

/** A small control-plane model boundary. Task execution remains owned by DSH. */
export interface JsonModelProvider {
  readonly name: string
  generateJson(request: JsonModelRequest): Promise<unknown>
}
