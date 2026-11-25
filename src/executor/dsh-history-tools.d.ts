export declare const name: string
export declare const inject: string[]

export interface HistoryCapability {
  baseUrl: string
  runId: string
  claimToken: string
  privacyMode: 'mask' | 'disabled'
}

export declare function normalizeCapability(
  value: unknown,
): HistoryCapability | undefined

export declare function maskProjectionStrings(
  value: unknown,
  mask: (text: string) => string,
): unknown

export interface HistoryToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: Record<string, unknown>
  isConcurrencySafe: () => boolean
  execute: (
    arguments_: Record<string, unknown>,
    exec: { signal: AbortSignal },
  ) => Promise<{ json: string }>
}

export declare function historyTools(
  capability: HistoryCapability,
  privacy?: { masker?: { mask: (text: string) => { text: string } } },
): HistoryToolDefinition[]

export declare function apply(
  ctx: {
    inject: (deps: string[], callback: (ctx: unknown) => void) => unknown
    tools: { register: (definition: unknown) => unknown }
  },
  config?: {
    capability?: unknown
    masker?: { mask: (text: string) => { text: string } }
  },
): void
