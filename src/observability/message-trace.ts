export interface TraceText {
  text?: string
  characters: number
  truncated: boolean
}

export interface RouterTraceCall {
  at: string
  component: 'router' | 'rewrite'
  model: string
  durationMs: number
  outcome: 'ok' | 'provider_error' | 'invalid_response'
  input: TraceText
  candidates?: string[]
  output?: TraceText
}

export interface MessageTrace {
  rootEventId: string
  events: {
    id: string
    at: string
    processedAt?: string
    status: string
    input?: TraceText
    error?: TraceText
    submitMs?: number
  }[]
  decision?: {
    kind: string
    taskId?: string
    reason?: TraceText
    source?: string
    ruleId?: string
    at: string
  }
  calls: RouterTraceCall[]
  runs: {
    id: string
    taskId: string
    status: string
    executor: string
    model?: string
    at: string
    updatedAt: string
    attempts: number
    starts: { attempt: number; phase: string; at: string }[]
    retryOf?: string
    resumedFrom?: string
    input: TraceText
    output?: TraceText
    error?: TraceText
  }[]
  actions: {
    id: string
    runId: string
    tool: string
    status: string
    at: string
    updatedAt: string
    approval?: { id: string; status: string; resolvedAt?: string }
    reconciliation?: { at: string; status: string; note?: TraceText }
  }[]
  policy: {
    runId: string
    callId: string
    tool: string
    decision: string
    category: string
    at: string
    reason?: TraceText
  }[]
  results: {
    id: string
    runId?: string
    type?: string
    lane: string
    at: string
    updatedAt: string
    output?: TraceText
    fetchedAt?: string
    renderedAt?: string
    settledAt?: string
    visibleAt?: string
  }[]
  truncated: boolean
}

export type BrowserTraceReceipt =
  | { phase: 'accepted'; eventId: string; durationMs: number }
  | { phase: 'fetched' | 'rendered' | 'settled' | 'visible'; messageId: string }
