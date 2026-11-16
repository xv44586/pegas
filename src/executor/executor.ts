export interface ExecutorInput {
  runId: string
  taskId: string
  prompt: string
  workingDirectory: string
  resumeSessionId?: string
  onExecutorRef?(executorRef: string): void
  signal?: AbortSignal
}

export interface ExecutorResult {
  executorRef: string
  output: string
}

export interface RunExecutor {
  readonly name: string
  execute(input: ExecutorInput): Promise<ExecutorResult>
}
