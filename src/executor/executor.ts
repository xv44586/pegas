import type {
  ExecutionContext,
  Mandate,
  ModelUsageSample,
} from '../core/domain.js'
import type { MemoryContextEntry } from '../memory/memory.js'
import type { WorkRuleContext } from '../rules/rules.js'

export interface ExecutorInput {
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
  resumeSessionId?: string
  onExecutorRef?(executorRef: string): void
  onProgress?(event: ExecutorProgressEvent): void
  signal?: AbortSignal
}

export type ExecutorProgressEvent =
  | { type: 'acknowledgement'; text: string }
  | { type: 'activity'; label: string }

export interface ExecutorResult {
  executorRef: string
  output: string
  usage?: ModelUsageSample
  durationMs?: number
}

export interface RunExecutor {
  readonly name: string
  execute(input: ExecutorInput): Promise<ExecutorResult>
}
