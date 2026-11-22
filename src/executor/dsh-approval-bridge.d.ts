export declare const name: string
export declare const inject: string[]

export interface ApprovalBridgeConfig {
  emit?: (event: Record<string, unknown>) => void
  grant?: unknown
}

export interface ApprovalBridgeContext {
  on: (event: string, listener: (...args: never[]) => unknown) => void
}

export declare function apply(
  ctx: ApprovalBridgeContext,
  config?: ApprovalBridgeConfig,
): void
