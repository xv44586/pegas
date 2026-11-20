import type { ModelUsageSample } from '../core/domain.js'

export interface ExecutorInput {
  runId: string
  taskId: string
  prompt: string
  workingDirectory: string
  actionCapability?: {
    baseUrl: string
    claimToken: string
  }
  resumeSessionId?: string
  onExecutorRef?(executorRef: string): void
  onProgress?(event: ExecutorProgressEvent): void
  signal?: AbortSignal
}

interface ExecutorProgressEvent {
  type: 'acknowledgement'
  text: string
}

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
