export declare const name: string
export declare const inject: string[]

import type { PolicyRoots } from './policy-gate.js'

export interface ApprovalBridgeConfig {
  emit?: (event: Record<string, unknown>) => void
  grant?: unknown
  policy?: PolicyRoots
}

export interface ApprovalBridgeTools {
  guard: (
    guard: (execution: {
      callId?: string | number
      name: string
      arguments?: unknown
    }) => { reason: string } | undefined,
  ) => unknown
}

export interface ApprovalBridgeContext {
  on: (event: string, listener: (...args: never[]) => unknown) => void
  tools?: ApprovalBridgeTools
}

export declare function apply(
  ctx: ApprovalBridgeContext,
  config?: ApprovalBridgeConfig,
): void
