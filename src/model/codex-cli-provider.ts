import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { JsonModelProvider, JsonModelRequest } from './provider.js'

export interface CodexCliProviderOptions {
  command?: string
  model?: string
  timeoutMs?: number
  maximumStderrBytes?: number
}

/** Uses the local Codex login without exposing its credentials to Pegas. */
export class CodexCliProvider implements JsonModelProvider {
  readonly name = 'codex-cli'
  readonly #command: string
  readonly #model: string
  readonly #timeoutMs: number
  readonly #maximumStderrBytes: number

  constructor(options: CodexCliProviderOptions = {}) {
    this.#command = options.command ?? 'codex'
    this.#model = options.model ?? 'gpt-5.6-luna'
    this.#timeoutMs = options.timeoutMs ?? 90_000
    this.#maximumStderrBytes = options.maximumStderrBytes ?? 64 * 1024
  }

  async generateJson(request: JsonModelRequest): Promise<unknown> {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-codex-router-'))
    const schemaPath = join(directory, 'output.schema.json')
    const outputPath = join(directory, 'output.json')
    writeFileSync(
      schemaPath,
      JSON.stringify(request.schema ?? defaultObjectSchema),
      { mode: 0o600 },
    )

    const child = spawn(
      this.#command,
      [
        'exec',
        '--model',
        this.#model,
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--disable',
        'apps',
        '--disable',
        'plugins',
        '--disable',
        'hooks',
        '--disable',
        'remote_plugin',
        '--disable',
        'plugin_sharing',
        '--disable',
        'api_key_model_discovery',
        '--disable',
        'daemon_auto_start',
        '--enable',
        'skip_host_skill_discovery',
        '--config',
        'suppress_unstable_features_warning=true',
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputPath,
        '-',
      ],
      {
        cwd: directory,
        env: process.env,
        shell: false,
        stdio: ['pipe', 'ignore', 'pipe'],
      },
    )
    const stderr: Buffer[] = []
    let stderrBytes = 0
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = this.#maximumStderrBytes - stderrBytes
      if (remaining <= 0) return
      const bounded = chunk.subarray(0, remaining)
      stderr.push(bounded)
      stderrBytes += bounded.length
    })

    let terminationReason: string | undefined
    const terminate = (reason: string): void => {
      terminationReason ??= reason
      child.kill('SIGTERM')
    }
    const abort = (): void => terminate('Codex model request was aborted')
    request.signal?.addEventListener('abort', abort, { once: true })
    if (request.signal?.aborted) abort()
    const timeout = setTimeout(
      () =>
        terminate(
          `Codex model request timed out after ${String(this.#timeoutMs)}ms`,
        ),
      this.#timeoutMs,
    )
    timeout.unref()

    try {
      child.stdin.end(
        `${request.system}\n\nEvaluate this input and return only the required JSON object:\n${request.input}`,
      )
      const exit = await waitForExit(child)
      if (terminationReason || exit.code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        throw new Error(
          terminationReason ??
            (detail || `Codex CLI exited with code ${String(exit.code)}`),
        )
      }
      const output = readFileSync(outputPath, 'utf8')
      return JSON.parse(output) as unknown
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', abort)
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

const defaultObjectSchema = {
  type: 'object',
  additionalProperties: true,
}

function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}
