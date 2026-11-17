import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

import type { ExecutorInput, ExecutorResult, RunExecutor } from './executor.js'

export interface DshCliExecutorOptions {
  command?: string
  profile?: string
  permissionMode?: string
  approvalPolicy?: 'ask' | 'never'
  additionalDirectories?: string[]
  timeoutMs?: number
  terminationGraceMs?: number
  maximumEventBytes?: number
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
  readonly #profile: string
  readonly #permissionMode: string
  readonly #approvalPolicy: 'ask' | 'never'
  readonly #additionalDirectories: string[]
  readonly #timeoutMs: number
  readonly #terminationGraceMs: number
  readonly #maximumEventBytes: number
  readonly #maximumStderrBytes: number

  constructor(options: DshCliExecutorOptions = {}) {
    this.#command = options.command ?? 'dsh'
    this.#profile = options.profile ?? 'headless'
    this.#permissionMode = options.permissionMode ?? 'workspace-write'
    this.#approvalPolicy = options.approvalPolicy ?? 'never'
    this.#additionalDirectories = options.additionalDirectories ?? []
    this.#timeoutMs = options.timeoutMs ?? 60 * 60 * 1000
    this.#terminationGraceMs = options.terminationGraceMs ?? 5000
    this.#maximumEventBytes = options.maximumEventBytes ?? 8 * 1024 * 1024
    this.#maximumStderrBytes = options.maximumStderrBytes ?? 64 * 1024
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const arguments_ = [
      '--profile',
      this.#profile,
      '--json',
      '--permission-mode',
      this.#permissionMode,
      '--approval-policy',
      this.#approvalPolicy,
      ...this.#additionalDirectories.flatMap(directory => [
        '--add-dir',
        directory,
      ]),
      ...(input.resumeSessionId ? ['--session-id', input.resumeSessionId] : []),
      '-',
    ]
    const child = spawn(this.#command, arguments_, {
      cwd: input.workingDirectory,
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let terminationError: string | undefined
    let killTimer: NodeJS.Timeout | undefined
    const terminate = (message: string): void => {
      terminationError ??= message
      child.kill('SIGTERM')
      killTimer ??= setTimeout(
        () => child.kill('SIGKILL'),
        this.#terminationGraceMs,
      )
      killTimer.unref()
    }
    const abort = (): void => terminate('DSH execution was aborted')
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) abort()
    const timeout = setTimeout(
      () =>
        terminate(`DSH execution timed out after ${String(this.#timeoutMs)}ms`),
      this.#timeoutMs,
    )
    timeout.unref()

    let sessionId = input.resumeSessionId
    let finalEvent: DshFinalEvent | undefined
    let streamError: string | undefined
    const stderrChunks: Buffer[] = []
    let stderrBytes = 0

    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = this.#maximumStderrBytes - stderrBytes
      if (remaining <= 0) return
      const bounded = chunk.subarray(0, remaining)
      stderrChunks.push(bounded)
      stderrBytes += bounded.length
    })

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', line => {
      if (!line.trim()) return
      try {
        if (Buffer.byteLength(line) > this.#maximumEventBytes) {
          throw new Error(
            'DSH emitted an event larger than the configured limit',
          )
        }
        const event = parseDshEvent(line)
        if (event.type === 'session') {
          sessionId = event.sessionId
          input.onExecutorRef?.(event.sessionId)
        }
        if (event.type === 'final') {
          finalEvent = event
          sessionId = event.sessionId
          input.onExecutorRef?.(event.sessionId)
        }
        if (event.type === 'error')
          streamError = event.message ?? 'Unknown DSH error'
      } catch (error) {
        streamError =
          error instanceof Error ? error.message : 'Invalid DSH event stream'
        terminate(streamError)
      }
    })

    child.stdin.end(input.prompt)
    let exit: { code: number | null; signal: NodeJS.Signals | null }
    try {
      exit = await waitForExit(child)
    } finally {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      input.signal?.removeEventListener('abort', abort)
      lines.close()
    }
    const { code, signal } = exit
    const stderr = Buffer.concat(stderrChunks).toString('utf8')

    if (
      terminationError !== undefined ||
      code !== 0 ||
      streamError !== undefined ||
      !finalEvent ||
      !isCompletedReason(finalEvent.reason)
    ) {
      const detail =
        terminationError ??
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
