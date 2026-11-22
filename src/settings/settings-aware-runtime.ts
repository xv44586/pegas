import type {
  InboxEvent,
  RoutingCandidate,
  RoutingDecision,
  Task,
} from '../core/domain.js'
import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../executor/executor.js'
import type { ExplicitTaskResolver, TaskRouter } from '../router/router.js'
import type { MeteredProviderContext } from '../model/metered-provider.js'
import type { PegasStore } from '../storage/sqlite-store.js'
import type { RuntimeSettings } from './runtime-settings.js'

export class SettingsAwareTaskRouter implements TaskRouter {
  readonly #store: PegasStore
  readonly #resolve: (settings: RuntimeSettings) => TaskRouter
  #meteringContext: MeteredProviderContext | undefined

  constructor(
    store: PegasStore,
    resolve: (settings: RuntimeSettings) => TaskRouter,
  ) {
    this.#store = store
    this.#resolve = resolve
  }

  meteringContext(): MeteredProviderContext | undefined {
    return this.#meteringContext
  }

  route(
    event: InboxEvent,
    tasks: RoutingCandidate[] | Task[],
    context: { resolveExplicitTask?: ExplicitTaskResolver } = {},
  ): Promise<RoutingDecision | undefined> {
    const settings = this.#store.getRuntimeSettings()
    this.#meteringContext = {
      userId: event.userId,
      eventId: event.id,
      modelRef: `${settings.modelProvider}/${settings.modelName}`,
    }
    return this.#resolve(settings).route(event, tasks, context)
  }
}

export class SettingsAwareExecutor implements RunExecutor {
  readonly name: string
  readonly #store: PegasStore
  readonly #resolve: (
    settings: RuntimeSettings,
    input: ExecutorInput,
  ) => RunExecutor

  constructor(
    store: PegasStore,
    name: string,
    resolve: (settings: RuntimeSettings, input: ExecutorInput) => RunExecutor,
  ) {
    this.#store = store
    this.name = name
    this.#resolve = resolve
  }

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    const settings = this.#store.getRuntimeSettings()
    return this.#resolve(settings, input).execute(input)
  }
}
