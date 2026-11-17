import type { InboxEvent, RoutingDecision, Task } from '../core/domain.js'
import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../executor/executor.js'
import type { TaskRouter } from '../router/router.js'
import type { PegasStore } from '../storage/sqlite-store.js'
import type { RuntimeSettings } from './runtime-settings.js'

export class SettingsAwareTaskRouter implements TaskRouter {
  readonly #store: PegasStore
  readonly #resolve: (settings: RuntimeSettings) => TaskRouter

  constructor(
    store: PegasStore,
    resolve: (settings: RuntimeSettings) => TaskRouter,
  ) {
    this.#store = store
    this.#resolve = resolve
  }

  route(
    event: InboxEvent,
    tasks: Task[],
  ): Promise<RoutingDecision | undefined> {
    const settings = this.#store.getRuntimeSettings()
    return this.#resolve(settings).route(event, tasks)
  }
}

export class SettingsAwareExecutor implements RunExecutor {
  readonly name: string
  readonly #store: PegasStore
  readonly #resolve: (settings: RuntimeSettings) => RunExecutor

  constructor(
    store: PegasStore,
    name: string,
    resolve: (settings: RuntimeSettings) => RunExecutor,
  ) {
    this.#store = store
    this.name = name
    this.#resolve = resolve
  }

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    const settings = this.#store.getRuntimeSettings()
    return this.#resolve(settings).execute(input)
  }
}
