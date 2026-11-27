import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../executor/executor.js'
import type { PegasStore } from '../storage/sqlite-store.js'

/**
 * Dispatches Runs of self-change Tasks (targetResource=pegas_repository) to
 * the isolated self-change executor; every other Run keeps the configured
 * executor. The Task record, not the prompt text, is the authority.
 */
export class SelfChangeRoutingExecutor implements RunExecutor {
  readonly name: string
  readonly #store: PegasStore
  readonly #default: RunExecutor
  readonly #selfChange: RunExecutor

  constructor(
    store: PegasStore,
    defaultExecutor: RunExecutor,
    selfChange: RunExecutor,
  ) {
    this.#store = store
    this.#default = defaultExecutor
    this.#selfChange = selfChange
    this.name = defaultExecutor.name
  }

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    if (this.#isSelfChange(input.taskId)) {
      return this.#selfChange.execute(input)
    }
    return this.#default.execute(input)
  }

  #isSelfChange(taskId: string): boolean {
    for (const task of this.#store.listTasks()) {
      if (task.id === taskId)
        return (
          !task.workingDirectory && task.targetResource === 'pegas_repository'
        )
    }
    throw new Error('Task is missing for self-change dispatch')
  }
}
