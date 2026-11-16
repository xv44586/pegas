import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

import type { ExecutorInput, ExecutorResult, RunExecutor } from './executor.js'

export interface DshCliExecutorOptions {
  command?: string
  permissionMode?: string
  approvalPolicy?: 'ask' | 'never'
  maximumStderrBytes?: number
}

interface DshSessionEvent {
  type: 'session'
  sessionId: string
}

interface DshFinalEvent {
  type: 'final'
  sessionId: string
  text: string
  reason: unknown
}

interface DshErrorEvent {
  type: 'error'
  message?: string
}

interface DshOtherEvent {
  type: 'other'
}

export class DshCliExecutor implements RunExecutor {
  readonly name = 'dsh-headless'
  readonly #command: string
  readonly #permissionMode: string
  readonly #approvalPolicy: 'ask' | 'never'
  readonly #maximumStderrBytes: number

  constructor(options: DshCliExecutorOptions = {}) {
    this.#command = options.command ?? 'dsh'
    this.#permissionMode = options.permissionMode ?? 'workspace-write'
    this.#approvalPolicy = options.approvalPolicy ?? 'never'
    this.#maximumStderrBytes = options.maximumStderrBytes ?? 64 * 1024
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const arguments_ = [
      '--profile',
      'headless',
      '--json',
      '--permission-mode',
      this.#permissionMode,
      '--approval-policy',
      this.#approvalPolicy,
      ...(input.resumeSessionId ? ['--session-id', input.resumeSessionId] : []),
      '-',
    ]
    const child = spawn(this.#command, arguments_, {
      cwd: input.workingDirectory,
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const abort = (): void => {
      child.kill('SIGTERM')
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) abort()

    let sessionId = input.resumeSessionId
    let finalEvent: DshFinalEvent | undefined
    let streamError: string | undefined
    let stderr = ''

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (Buffer.byteLength(stderr) < this.#maximumStderrBytes) stderr += chunk
    })

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', line => {
      if (!line.trim()) return
      try {
        const event = parseDshEvent(line)
        if (event.type === 'session') {
          sessionId = event.sessionId
          input.onExecutorRef?.(event.sessionId)
        }
        if (event.type === 'final') finalEvent = event
        if (event.type === 'error')
          streamError = event.message ?? 'Unknown DSH error'
      } catch (error) {
        streamError =
          error instanceof Error ? error.message : 'Invalid DSH event stream'
      }
    })

    child.stdin.end(input.prompt)
    const { code, signal } = await waitForExit(child)
    input.signal?.removeEventListener('abort', abort)

    if (
      code !== 0 ||
      streamError !== undefined ||
      !finalEvent ||
      !isCompletedReason(finalEvent.reason)
    ) {
      const detail =
        streamError ??
        (stderr.trim() ||
          `DSH exited with code ${String(code)} signal ${signal ?? 'none'}`)
      throw new DshExecutionError(detail, sessionId)
    }

    return {
      executorRef: finalEvent.sessionId,
      output: finalEvent.text,
    }
  }
}

export class DshExecutionError extends Error {
  readonly sessionId?: string

  constructor(message: string, sessionId?: string) {
    super(message)
    this.name = 'DshExecutionError'
    this.sessionId = sessionId
  }
}

function parseDshEvent(
  line: string,
): DshSessionEvent | DshFinalEvent | DshErrorEvent | DshOtherEvent {
  const parsed = JSON.parse(line) as unknown
  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    throw new Error('DSH emitted an invalid JSON event')
  }
  if (parsed.type === 'session' && typeof parsed.sessionId === 'string') {
    return { type: 'session', sessionId: parsed.sessionId }
  }
  if (
    parsed.type === 'final' &&
    typeof parsed.sessionId === 'string' &&
    typeof parsed.text === 'string'
  ) {
    return {
      type: 'final',
      sessionId: parsed.sessionId,
      text: parsed.text,
      reason: parsed.reason,
    }
  }
  if (parsed.type === 'error') {
    return {
      type: 'error',
      ...(typeof parsed.message === 'string'
        ? { message: parsed.message }
        : {}),
    }
  }
  return { type: 'other' }
}

function isCompletedReason(value: unknown): boolean {
  return isRecord(value) && value.kind === 'completed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}
