/**
 * MODEL-001: bounded retry for control-plane model HTTP calls.
 *
 * Rate limits (429) and transient server failures (5xx) are retried with
 * exponential backoff, honoring Retry-After when the provider sends it.
 * Other 4xx responses, aborts and timeouts fail immediately. When the retry
 * budget is exhausted the last HTTP error is thrown unchanged so callers
 * keep their existing failure semantics.
 */

export interface ModelRetryOptions {
  /** Total attempts including the first one. Defaults to 3. */
  maxAttempts?: number
  /** First backoff delay in ms. Defaults to 500. */
  baseDelayMs?: number
  /** Upper bound for a single backoff delay in ms. Defaults to 8000. */
  maxDelayMs?: number
  /** Injectable for tests; defaults to setTimeout-based sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number
}

export class ModelHttpError extends Error {
  readonly status: number
  readonly retryAfterMs: number | undefined

  constructor(status: number, detail: string, retryAfterMs?: number) {
    super(
      `Model provider returned ${String(status)}${detail ? `: ${detail}` : ''}`,
    )
    this.name = 'ModelHttpError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/** Parse Retry-After as delta-seconds or an HTTP date. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined
  }
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('Aborted'),
      )
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(
        signal?.reason instanceof Error ? signal.reason : new Error('Aborted'),
      )
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Run one model HTTP attempt, retrying only retryable HTTP failures.
 * `attempt` must throw ModelHttpError for non-ok responses and return the
 * parsed result otherwise. Network errors, aborts and timeouts propagate
 * without retry.
 */
export async function withModelRetry<T>(
  attempt: () => Promise<T>,
  signal: AbortSignal | undefined,
  options: ModelRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 500
  const maxDelayMs = options.maxDelayMs ?? 8000
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random

  let lastError: ModelHttpError | undefined
  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Aborted')
    }
    try {
      return await attempt()
    } catch (error) {
      if (
        !(error instanceof ModelHttpError) ||
        !isRetryableStatus(error.status)
      ) {
        throw error
      }
      lastError = error
      const isLastAttempt = attemptIndex === maxAttempts - 1
      if (isLastAttempt) break
      const exponential = baseDelayMs * 2 ** attemptIndex
      const jittered = exponential * (0.5 + random() * 0.5)
      const delay = Math.min(
        maxDelayMs,
        Math.max(jittered, error.retryAfterMs ?? 0),
      )
      await sleep(delay, signal)
    }
  }
  throw lastError ?? new Error('Model retry exhausted without an error')
}
