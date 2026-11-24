/**
 * DESKTOP-001 native attention: the desktop shell surfaces unread Outbox
 * facts as macOS notifications and a Dock badge. The server stays the only
 * authority — this module never writes read state, delivery state, or any
 * product fact, and never fabricates an unread count while disconnected.
 */

export interface DesktopAttentionMessage {
  id: string
  createdAt: string
  unread: boolean
  status: string
  payload: unknown
}

interface DesktopNotification {
  title: string
  body?: string
  deepLink: string
}

export interface DesktopAttentionOptions {
  fetchSnapshot: () => Promise<unknown>
  notificationsSupported: () => boolean
  /** Shows one system notification; returns its click handler wiring. */
  notify: (notice: DesktopNotification) => void
  setBadge: (value: string) => void
}

export function attentionDeepLink(messageId: string): string {
  return `/?view=outbox&outbox=${encodeURIComponent(messageId)}`
}

export function parseOutboxSnapshot(
  snapshot: unknown,
): DesktopAttentionMessage[] | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined
  const messages = (snapshot as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return undefined
  const parsed: DesktopAttentionMessage[] = []
  for (const item of messages) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (
      typeof record.id !== 'string' ||
      typeof record.createdAt !== 'string' ||
      typeof record.status !== 'string'
    )
      continue
    parsed.push({
      id: record.id,
      createdAt: record.createdAt,
      unread: typeof record.readAt !== 'string' || record.readAt.length === 0,
      status: record.status,
      payload: record.payload,
    })
  }
  return parsed
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/**
 * Notification text comes only from the owner-visible message projection
 * (explicit title/summary or plain body text). Tool arguments, prompts and
 * evidence bytes never enter a system notification.
 */
export function attentionNotificationText(message: DesktopAttentionMessage): {
  title: string
  body?: string
} {
  const record = payloadRecord(message.payload)
  const explicit =
    typeof record.title === 'string'
      ? record.title
      : typeof record.summary === 'string'
        ? record.summary
        : undefined
  if (explicit?.trim()) return { title: truncate(explicit.trim(), 80) }
  for (const key of ['text', 'message', 'content', 'output', 'error']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      const plain = value.trim()
      const sentence = /[。！？!?]/u.exec(plain)
      if (sentence && sentence.index < 120) {
        const title = plain.slice(0, sentence.index + 1)
        const rest = plain.slice(sentence.index + 1).trim()
        return {
          title: truncate(title, 80),
          ...(rest ? { body: truncate(rest, 160) } : {}),
        }
      }
      return { title: truncate(plain, 80) }
    }
  }
  return { title: 'Pegas 有一项更新' }
}

export interface DesktopAttentionMonitor {
  poll: () => Promise<void>
  readonly consecutiveFailures: number
}

export function createDesktopAttentionMonitor(
  options: DesktopAttentionOptions,
): DesktopAttentionMonitor {
  const seen = new Set<string>()
  let baselineCreatedAt: string | undefined
  let primed = false
  let failures = 0

  async function poll(): Promise<void> {
    let snapshot: unknown
    try {
      snapshot = await options.fetchSnapshot()
    } catch {
      failures += 1
      options.setBadge('')
      return
    }
    const messages = parseOutboxSnapshot(snapshot)
    if (!messages) {
      failures += 1
      options.setBadge('')
      return
    }
    failures = 0

    const active = messages.filter(item => item.status !== 'merged')
    const unreadCount = active.filter(item => item.unread).length
    options.setBadge(unreadCount > 0 ? String(unreadCount) : '')

    if (!primed) {
      // First successful poll establishes the baseline: historical unread
      // messages badge silently, they never replay as notifications.
      primed = true
      for (const item of active) {
        seen.add(item.id)
        if (
          baselineCreatedAt === undefined ||
          item.createdAt > baselineCreatedAt
        )
          baselineCreatedAt = item.createdAt
      }
      return
    }

    for (const item of active) {
      if (baselineCreatedAt === undefined || item.createdAt > baselineCreatedAt)
        baselineCreatedAt = item.createdAt
      if (seen.has(item.id)) continue
      seen.add(item.id)
      if (!item.unread) continue
      if (!options.notificationsSupported()) continue
      const text = attentionNotificationText(item)
      options.notify({
        ...text,
        deepLink: attentionDeepLink(item.id),
      })
    }
  }

  return {
    poll,
    get consecutiveFailures() {
      return failures
    },
  }
}
