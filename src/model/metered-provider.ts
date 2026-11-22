import type { RouterUsageRecord } from '../core/domain.js'
import type { PegasStore } from '../storage/sqlite-store.js'
import type {
  JsonModelProvider,
  JsonModelRequest,
  ModelCallUsage,
} from './provider.js'

export interface MeteredProviderContext {
  userId: string
  eventId?: string
  modelRef: string
}

/**
 * USAGE-001 (PLAN-001 P2): every router/rewrite model call lands one ledger
 * row keyed by the durable event ID, so a retried routing pass never
 * double-counts. Provider-reported tokens only; latency is Pegas-observed.
 * Metering failures never block routing.
 */
export class MeteredJsonModelProvider implements JsonModelProvider {
  readonly name: string
  readonly #inner: JsonModelProvider
  readonly #store: PegasStore
  readonly #component: RouterUsageRecord['component']
  readonly #context: () => MeteredProviderContext | undefined

  constructor(
    inner: JsonModelProvider,
    store: PegasStore,
    component: RouterUsageRecord['component'],
    context: () => MeteredProviderContext | undefined,
  ) {
    this.#inner = inner
    this.#store = store
    this.#component = component
    this.#context = context
    this.name = inner.name
  }

  async generateJson(request: JsonModelRequest): Promise<unknown> {
    const context = this.#context()
    if (!context) return this.#inner.generateJson(request)
    const startedAt = performance.now()
    try {
      const result = this.#inner.generateJsonWithUsage
        ? await this.#inner.generateJsonWithUsage(request)
        : { value: await this.#inner.generateJson(request) }
      this.#record(context, startedAt, 'ok', result.usage)
      return result.value
    } catch (error) {
      this.#record(context, startedAt, 'error', undefined)
      throw error
    }
  }

  #record(
    context: MeteredProviderContext,
    startedAt: number,
    outcome: 'ok' | 'error',
    usage: ModelCallUsage | undefined,
  ): void {
    try {
      this.#store.recordRouterUsage({
        callId: `${this.#component}:${context.eventId ?? 'anonymous'}:${context.modelRef}`,
        userId: context.userId,
        component: this.#component,
        ...(context.eventId ? { eventId: context.eventId } : {}),
        modelRef: context.modelRef,
        ...(usage ? { usage } : {}),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome,
      })
    } catch {
      return
    }
  }
}
