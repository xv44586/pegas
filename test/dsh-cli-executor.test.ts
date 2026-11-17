import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DshCliExecutor,
  DshExecutionError,
} from '../src/executor/dsh-cli-executor.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('DshCliExecutor', () => {
  it('accepts only a completed final event and captures the session id', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({ type: 'session', sessionId: 'session-test' }))
console.log(JSON.stringify({ type: 'text', text: 'working' }))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-test',
  text: 'finished',
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command })
    let observedSession: string | undefined

    const result = await executor.execute({
      runId: 'run-1',
      taskId: 'task-1',
      prompt: 'do the work',
      workingDirectory: process.cwd(),
      onExecutorRef: sessionId => {
        observedSession = sessionId
      },
    })

    expect(result).toEqual({ executorRef: 'session-test', output: 'finished' })
    expect(observedSession).toBe('session-test')
  })

  it('preserves a session id when DSH exits unsuccessfully', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({ type: 'session', sessionId: 'session-failed' }))
console.log(JSON.stringify({ type: 'error', message: 'model unavailable' }))
process.exitCode = 1
`)
    const executor = new DshCliExecutor({ command })

    const execution = executor.execute({
      runId: 'run-1',
      taskId: 'task-1',
      prompt: 'do the work',
      workingDirectory: process.cwd(),
    })

    await expect(execution).rejects.toMatchObject({
      name: DshExecutionError.name,
      message: 'model unavailable',
      sessionId: 'session-failed',
    })
  })

  it('passes resume and additional workspace grants to headless DSH', async () => {
    const command = fakeDsh(`
const sessionId = process.argv[process.argv.indexOf('--session-id') + 1]
console.log(JSON.stringify({
  type: 'final',
  sessionId,
  text: JSON.stringify(process.argv.slice(2)),
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({
      command,
      additionalDirectories: ['/tmp/git-metadata'],
    })
    let observedSession: string | undefined

    const result = await executor.execute({
      runId: 'run-1',
      taskId: 'task-1',
      prompt: 'continue the work',
      workingDirectory: process.cwd(),
      resumeSessionId: 'session-existing',
      onExecutorRef: value => {
        observedSession = value
      },
    })

    expect(JSON.parse(result.output)).toEqual(
      expect.arrayContaining([
        '--profile',
        'headless',
        '--add-dir',
        '/tmp/git-metadata',
        '--session-id',
        'session-existing',
      ]),
    )
    expect(observedSession).toBe('session-existing')
  })
})

function fakeDsh(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-fake-dsh-'))
  temporaryDirectories.push(directory)
  const command = join(directory, 'dsh')
  writeFileSync(command, `#!/usr/bin/env node\n${body}`, { mode: 0o700 })
  chmodSync(command, 0o700)
  return command
}
