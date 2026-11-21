import type { OutboxMessage } from '../core/domain.js'

export interface NotificationChannel {
  readonly name: string
  /**
   * Channels that leave the Pegas trust boundary (webhook, push, messaging
   * platforms) receive a redacted delivery projection instead of the full
   * in-app payload. In-app trusted surfaces keep the full projection.
   */
  readonly external?: boolean
  deliver(message: OutboxMessage, signal?: AbortSignal): Promise<void>
}

/**
 * Thrown when the request may already have reached the receiver but the
 * outcome cannot be observed (network failure, timeout, aborted stream).
 * The dispatcher parks the message as `unknown` instead of retrying, so a
 * human can reconcile the real delivery outcome without duplicating it.
 */
export class DeliveryOutcomeUnknownError extends Error {}
