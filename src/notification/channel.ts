import type { OutboxMessage } from '../core/domain.js'

export interface NotificationChannel {
  readonly name: string
  deliver(message: OutboxMessage, signal?: AbortSignal): Promise<void>
}
