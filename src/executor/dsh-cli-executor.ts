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

interface DshTextEvent {
  type: 'text'
  text: string
}

interface DshToolCallEvent {
  type: 'tool_call'
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
    let pendingAssistantText: string[] = []
    let acknowledgementEmitted = false
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
        if (event.type === 'text' && !acknowledgementEmitted) {
          pendingAssistantText.push(event.text)
        }
        if (
          event.type === 'tool_call' &&
          !acknowledgementEmitted &&
          pendingAssistantText.length > 0
        ) {
          const text = pendingAssistantText.join('').trim()
          pendingAssistantText = []
          if (text) {
            input.onProgress?.({ type: 'acknowledgement', text })
            acknowledgementEmitted = true
          }
        }
        if (event.type === 'error')
          streamError = event.message ?? 'Unknown DSH error'
      } catch (error) {
        streamError =
          error instanceof Error ? error.message : 'Invalid DSH event stream'
        terminate(streamError)
      }
    })

    child.stdin.end(executorPrompt(input.prompt))
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
):
  | DshSessionEvent
  | DshFinalEvent
  | DshErrorEvent
  | DshTextEvent
  | DshToolCallEvent
  | DshOtherEvent {
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
  if (parsed.type === 'text' && typeof parsed.text === 'string') {
    return { type: 'text', text: parsed.text }
  }
  if (parsed.type === 'tool_call') return { type: 'tool_call' }
  return { type: 'other' }
}

function isCompletedReason(value: unknown): boolean {
  return isRecord(value) && value.kind === 'completed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function executorPrompt(userInput: string): string {
  return `${userInput}

<pegas_execution_contract>
你是直接负责完成这项工作的执行 Agent。你能看到当前真实可用的工具、权限和工作区，能力判断必须以实际检查结果为准，不能由上游路由器代替判断。

如果任务需要调用工具，在第一次实质工具调用前，先用一句简短自然的中文确认你将处理的具体对象和预期结果。这句话会原样展示给用户；说完立即继续执行，不要等待用户再次确认。先检查已有工具和权限，不要仅凭猜测声称缺少工具或要求安装工具。

如果任务无需工具即可直接回答，就直接给出最终答案，不要额外发送形式化回执。后续普通执行进度不需要反复汇报；只在需要用户决策、遇到无法自行解决的阻塞或取得最终结果时面向用户输出。
</pegas_execution_contract>`
}

function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}
