export type PolicyRisk = 'low' | 'high' | 'critical'

export type PolicyCategory =
  | 'read'
  | 'workspace-write'
  | 'out-of-workspace-write'
  | 'network-egress'
  | 'destructive-command'
  | 'control-plane-mutation'
  | 'unknown'

export interface PolicyRoots {
  workspaceRoot?: string
  protectedRoots?: readonly string[]
}

export interface ToolCallClassification {
  category: PolicyCategory
  risk: PolicyRisk
  action: 'allow' | 'ask' | 'deny'
  reason: string
  targets: string[]
}

export type PolicyTier = 'strict' | 'standard' | 'full'

export declare function classifyToolCall(
  execution: { name: string; arguments?: unknown },
  roots: PolicyRoots,
  tier?: PolicyTier,
): ToolCallClassification
