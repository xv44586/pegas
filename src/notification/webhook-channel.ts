import type { OutboxMessage } from '../core/domain.js'
import type { NotificationChannel } from './channel.js'

export interface WebhookNotificationChannelOptions {
  url: string
  token?: string
  timeoutMs?: number
}

export class WebhookNotificationChannel implements NotificationChannel {
  readonly name = 'webhook'
  readonly #url: URL
  readonly #token?: string
  readonly #timeoutMs: number

  constructor(options: WebhookNotificationChannelOptions) {
    this.#url = new URL(options.url)
    this.#token = options.token
    this.#timeoutMs = options.timeoutMs ?? 10_000
  }

  async deliver(message: OutboxMessage, signal?: AbortSignal): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs)
    const deliverySignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal
    const response = await fetch(this.#url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': message.dedupeKey,
        'x-pegas-delivery-id': message.id,
        ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      },
      body: JSON.stringify({
        id: message.id,
        userId: message.userId,
        taskId: message.taskId ?? null,
        channel: message.channel,
        dedupeKey: message.dedupeKey,
        createdAt: message.createdAt,
        payload: message.payload,
      }),
      signal: deliverySignal,
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2048)
      throw new Error(
        `Webhook returned ${String(response.status)}${detail ? `: ${detail}` : ''}`,
      )
    }
  }
}
