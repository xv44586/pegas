import type { ModelProviderId } from '../model/provider-catalog.js'

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
}
