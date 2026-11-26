import type {
  ExecutionContext,
  Mandate,
  ModelUsageSample,
} from '../core/domain.js'
import type { MemoryContextEntry } from '../memory/memory.js'
import type { WorkRuleContext } from '../rules/rules.js'

export interface ExecutorInput {
  explainOnly?: boolean
  runId: string
  taskId: string
  inputEventId?: string
  prompt: string
  workingDirectory: string
  executionContext?: ExecutionContext
  executionContractVersion?: number
  mandate?: Mandate
  memories?: readonly MemoryContextEntry[]
  workRules?: WorkRuleContext
  actionCapability?: {
    baseUrl: string
    claimToken: string
  }
  conversationStateCapability?: {
    baseUrl: string
    runId: string
    claimToken: string
    privacyMode: 'mask' | 'disabled'
  }
  toolApprovalGrant?: ToolApprovalGrant
  resumeSessionId?: string
  onExecutorRef?(executorRef: string): void
  onProgress?(event: ExecutorProgressEvent): void
  signal?: AbortSignal
}

export type ExecutorProgressEvent =
  | { type: 'acknowledgement'; text: string }
  | { type: 'activity'; label: string }
  | { type: 'message'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool_call'
      callId: string
      tool: string
      input?: string
    }
  | {
      type: 'tool_result'
      callId: string
      status: 'completed' | 'error'
      result?: string
    }
  | { type: 'step'; phase: 'start' | 'end'; step?: number }
  | {
      type: 'policy_decision'
      callId: string
      tool: string
      category: string
      risk: string
      decision: string
      reason: string
      tier?: string
      generation?: string
      mismatch?: boolean
      ruleId?: string
      reviewDecision?: 'allow' | 'deny' | 'failed'
      actionId?: string
      targets?: readonly string[]
    }

export interface ToolApprovalGrant {
  actionId: string
  tool: string
  argumentsHash: string
  commandSelector?: import('./command-policy.mjs').CommandSelector
  ruleId?: string
  ruleRequired?: boolean
}

export interface ExecutorResult {
  executorRef: string
  output: string
  usage?: ModelUsageSample
  durationMs?: number
  approvalPending?: {
    actionId: string
    approvalId: string
    callId: string
    tool: string
  }
}

export interface RunExecutor {
  readonly name: string
  execute(input: ExecutorInput): Promise<ExecutorResult>
}
