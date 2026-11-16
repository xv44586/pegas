import type { ExecutorInput, ExecutorResult, RunExecutor } from './executor.js'

/** Deterministic executor used only by automated smoke tests. */
export class EchoExecutor implements RunExecutor {
  readonly name = 'echo-test'

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    if (input.signal?.aborted) throw new Error('Execution aborted')
    const executorRef = input.resumeSessionId ?? `echo-${input.runId}`
    input.onExecutorRef?.(executorRef)
    return Promise.resolve({ executorRef, output: input.prompt })
  }
}
