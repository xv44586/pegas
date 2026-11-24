import type {
  ExecutorInput,
  ExecutorProgressEvent,
  ExecutorResult,
  RunExecutor,
} from '../executor/executor.js'
import type { TextPrivacyMasker } from './masker.js'

/** Masks the prompt handed to an external Executor and restores visible text. */
export class PrivacyMaskingExecutor implements RunExecutor {
  readonly name: string
  readonly #executor: RunExecutor
  readonly #masker: TextPrivacyMasker

  constructor(executor: RunExecutor, masker: TextPrivacyMasker) {
    this.name = executor.name
    this.#executor = executor
    this.#masker = masker
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const prompt = this.#masker.mask(input.prompt).text
    const onProgress = input.onProgress
      ? (event: ExecutorProgressEvent) =>
          input.onProgress?.(this.#restoreProgress(event))
      : undefined
    const result = await this.#executor.execute({
      ...input,
      prompt,
      ...(onProgress ? { onProgress } : {}),
    })
    return {
      ...result,
      output: this.#masker.restore(result.output),
    }
  }

  #restoreProgress(event: ExecutorProgressEvent): ExecutorProgressEvent {
    const restore = (text: string) => this.#masker.restore(text)
    switch (event.type) {
      case 'acknowledgement':
      case 'message':
      case 'thinking':
        return { ...event, text: restore(event.text) }
      case 'activity':
        return { ...event, label: restore(event.label) }
      case 'tool_call':
        return {
          ...event,
          tool: restore(event.tool),
          ...(event.input !== undefined ? { input: restore(event.input) } : {}),
        }
      case 'tool_result':
        return {
          ...event,
          ...(event.result !== undefined
            ? { result: restore(event.result) }
            : {}),
        }
      case 'step':
        return event
      case 'policy_decision':
        return {
          ...event,
          reason: restore(event.reason),
          targets: event.targets?.map(target => restore(target)),
        }
    }
  }
}
