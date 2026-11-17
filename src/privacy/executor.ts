import type {
  ExecutorInput,
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
      ? (event: { type: 'acknowledgement'; text: string }) =>
          input.onProgress?.({
            ...event,
            text: this.#masker.restore(event.text),
          })
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
}
