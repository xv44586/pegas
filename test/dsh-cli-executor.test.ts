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

  it('emits committed assistant text as acknowledgement only when work starts', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({ type: 'session', sessionId: 'session-test' }))
console.log(JSON.stringify({ type: 'text', text: 'I will inspect the project ' }))
console.log(JSON.stringify({ type: 'text', text: 'and verify the fix.' }))
console.log(JSON.stringify({ type: 'tool_call', callId: 'call-1', tool: 'read' }))
console.log(JSON.stringify({ type: 'text', text: 'intermediate update' }))
console.log(JSON.stringify({ type: 'tool_call', callId: 'call-2', tool: 'test' }))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-test',
  text: 'finished',
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command })
    const acknowledgements: string[] = []

    await executor.execute({
      runId: 'run-1',
      taskId: 'task-1',
      prompt: 'do the work',
      workingDirectory: process.cwd(),
      onProgress: event => acknowledgements.push(event.text),
    })

    expect(acknowledgements).toEqual([
      'I will inspect the project and verify the fix.',
    ])
  })

  it('does not mistake a direct answer for an acknowledgement', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({ type: 'session', sessionId: 'session-test' }))
console.log(JSON.stringify({ type: 'text', text: 'The direct answer.' }))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-test',
  text: 'The direct answer.',
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command })
    const acknowledgements: string[] = []

    await executor.execute({
      runId: 'run-1',
      taskId: 'task-1',
      prompt: 'answer directly',
      workingDirectory: process.cwd(),
      onProgress: event => acknowledgements.push(event.text),
    })

    expect(acknowledgements).toEqual([])
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

  it('patches the selected agent model only for a new session', async () => {
    const command = fakeDsh(`
const fs = require('node:fs')
const patchIndex = process.argv.indexOf('--patch')
const patch = patchIndex === -1 ? undefined : fs.readFileSync(process.argv[patchIndex + 1], 'utf8')
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-new',
  text: JSON.stringify({ args: process.argv.slice(2), patch }),
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({
      command,
      agentModel: { provider: 'magpie', model: 'model-a' },
    })

    const fresh = await executor.execute({
      runId: 'run-new',
      taskId: 'task-1',
      prompt: 'start',
      workingDirectory: process.cwd(),
    })
    const freshOutput = JSON.parse(fresh.output) as {
      args: string[]
      patch: string
    }
    expect(freshOutput.args).toContain('--patch')
    expect(JSON.parse(freshOutput.patch)).toEqual([
      {
        id: 'agent-default-model',
        config: { provider: 'magpie', model: 'model-a' },
      },
    ])

    const resumed = await executor.execute({
      runId: 'run-resume',
      taskId: 'task-1',
      prompt: 'continue',
      workingDirectory: process.cwd(),
      resumeSessionId: 'session-existing',
    })
    const resumedOutput = JSON.parse(resumed.output) as {
      args: string[]
      patch?: string
    }
    expect(resumedOutput.args).not.toContain('--patch')
    expect(resumedOutput.patch).toBeUndefined()
  })

  it('preserves the session and terminates a malformed event stream', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({ type: 'session', sessionId: 'session-malformed' }))
console.log('{not-json')
setInterval(() => {}, 1000)
`)
    const executor = new DshCliExecutor({ command, terminationGraceMs: 20 })

    await expect(
      executor.execute({
        runId: 'run-malformed',
        taskId: 'task-1',
        prompt: 'do the work',
        workingDirectory: process.cwd(),
      }),
    ).rejects.toMatchObject({
      name: DshExecutionError.name,
      sessionId: 'session-malformed',
    })
  })

  it('rejects oversized events and retains the last durable session id', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({ type: 'session', sessionId: 'session-oversized' }))
console.log(JSON.stringify({ type: 'text', text: 'x'.repeat(256) }))
setInterval(() => {}, 1000)
`)
    const executor = new DshCliExecutor({
      command,
      maximumEventBytes: 64,
      terminationGraceMs: 20,
    })

    await expect(
      executor.execute({
        runId: 'run-oversized',
        taskId: 'task-1',
        prompt: 'do the work',
        workingDirectory: process.cwd(),
      }),
    ).rejects.toMatchObject({
      message: 'DSH emitted an event larger than the configured limit',
      sessionId: 'session-oversized',
    })
  })

  it('escalates a timed out child from SIGTERM to SIGKILL without leaving it alive', async () => {
    const command = fakeDsh(`
process.on('SIGTERM', () => {})
console.log(JSON.stringify({ type: 'session', sessionId: String(process.pid) }))
setInterval(() => {}, 1000)
`)
    const executor = new DshCliExecutor({
      command,
      timeoutMs: 500,
      terminationGraceMs: 30,
    })
    let childPid: number | undefined

    await expect(
      executor.execute({
        runId: 'run-timeout',
        taskId: 'task-1',
        prompt: 'do the work',
        workingDirectory: process.cwd(),
        onExecutorRef: value => {
          childPid = Number(value)
        },
      }),
    ).rejects.toMatchObject({
      message: 'DSH execution timed out after 500ms',
    })

    expect(childPid).toBeTypeOf('number')
    expect(() => process.kill(childPid ?? 0, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' }),
    )
  })

  it('aborts after capturing the session and cleans up the child', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({ type: 'session', sessionId: 'session-aborted' }))
setInterval(() => {}, 1000)
`)
    const executor = new DshCliExecutor({ command, terminationGraceMs: 20 })
    const abort = new AbortController()

    const execution = executor.execute({
      runId: 'run-aborted',
      taskId: 'task-1',
      prompt: 'do the work',
      workingDirectory: process.cwd(),
      signal: abort.signal,
      onExecutorRef: () => abort.abort(),
    })

    await expect(execution).rejects.toMatchObject({
      message: 'DSH execution was aborted',
      sessionId: 'session-aborted',
    })
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
