import {
  DeliveryOutcomeUnknownError,
  type NotificationChannel,
} from './channel.js'
import type { PegasStore } from '../storage/sqlite-store.js'

export interface OutboxDispatcherOptions {
  store: PegasStore
  channel: NotificationChannel
  dispatcherId: string
  maxAttempts?: number
  leaseMs?: number
  retryBaseMs?: number
}

export class OutboxDispatcher {
  readonly #store: PegasStore
  readonly #channel: NotificationChannel
  readonly #dispatcherId: string
  readonly #maxAttempts: number
  readonly #leaseMs: number
  readonly #retryBaseMs: number

  constructor(options: OutboxDispatcherOptions) {
    this.#store = options.store
    this.#channel = options.channel
    this.#dispatcherId = options.dispatcherId
    this.#maxAttempts = options.maxAttempts ?? 8
    this.#leaseMs = options.leaseMs ?? 30_000
    this.#retryBaseMs = options.retryBaseMs ?? 1000
  }

  async dispatchNext(signal?: AbortSignal): Promise<boolean> {
    const message = this.#store.claimNextOutbox(
      this.#dispatcherId,
      this.#leaseMs,
    )
    if (!message) return false

    try {
      await this.#channel.deliver(message, signal)
      this.#store.markOutboxSent(message.id, this.#dispatcherId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (error instanceof DeliveryOutcomeUnknownError) {
        // The receiver may already have the message; never auto-retry an
        // unknown outcome. It waits for an explicit human resolution.
        this.#store.markOutboxUnknown(message.id, this.#dispatcherId, detail)
        return true
      }
      const retryMs = Math.min(
        5 * 60 * 1000,
        this.#retryBaseMs * 2 ** Math.max(0, message.attempts - 1),
      )
      this.#store.failOutbox(
        message.id,
        this.#dispatcherId,
        detail,
        new Date(Date.now() + retryMs),
        this.#maxAttempts,
      )
    }
    return true
  }
}
