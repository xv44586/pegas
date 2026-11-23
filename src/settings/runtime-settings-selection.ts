import type { ModelProviderId } from '../model/provider-catalog.js'
import type { ExecutionPools } from '../worker/execution-pools.js'
import type { PermissionTier } from '../approval/permission-profile.js'

type RouterMode = 'model' | 'rules'
type PrivacyMode = 'disabled' | 'mask'
type RewriteMode = 'disabled' | 'light'
type AgentModelMode = 'profile' | 'override'

export interface RuntimeSettingsSelection {
  routerMode: RouterMode
  modelProvider: ModelProviderId
  modelName: string
  agentModelMode: AgentModelMode
  agentModelProvider: string
  agentModelName: string
  privacyMode: PrivacyMode
  rewriteMode: RewriteMode
  /** Defaults to false when omitted (rollback switch, PLAN-001 P1). */
  chatLaneEnabled?: boolean
  /** Optional fast/balanced/deep pool mapping (PLAN-001 P3). */
  executionPools?: ExecutionPools
  /** Global default permission tier (APPROVAL-001 P2); defaults to standard. */
  permissionTier?: PermissionTier
}
