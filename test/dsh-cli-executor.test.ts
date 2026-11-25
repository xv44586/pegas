import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DshCliExecutor,
  DshExecutionError,
  executorEnvironment,
  executorPrompt,
} from '../src/executor/dsh-cli-executor.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('DshCliExecutor', () => {
  it('does not expose Pegas control-plane credentials to the Executor process', () => {
    expect(
      executorEnvironment({
        PATH: '/usr/bin',
        DSH_API_KEY: 'executor-owned',
        PEGAS_API_TOKEN: 'control-plane',
        PEGAS_RECOVERY_TOKEN: 'recovery',
        PEGAS_PUSH_WEBHOOK_TOKEN: 'webhook',
        PEGAS_PRIVACY_HMAC_KEY: 'privacy',
        PEGAS_MODEL_API_KEY: 'model',
        PEGAS_SPEECH_API_KEY: 'speech',
        PEGAS_RUN_CLAIM_TOKEN: 'stale-run-claim',
        PEGAS_RUN_CAPABILITY_FILE: '/tmp/stale-capability.json',
        PEGAS_RUN_ID: 'stale-run',
        PEGAS_TASK_ID: 'stale-task',
        PEGAS_INPUT_EVENT_ID: 'stale-input-event',
        PEGAS_CONTROL_PLANE_URL: 'http://stale.example',
        DSH_HOME: '/Users/someone/.dsh-stale',
        PEGAS_DSH_MODEL_KEY_MAGPIE: 'stale-model-key',
      }),
    ).toEqual({ PATH: '/usr/bin', DSH_API_KEY: 'executor-owned' })
  })

  it('runs DSH inside the isolated home with the managed model configuration', async () => {
    const command = fakeDsh(`
const fs = require('node:fs')
const patchIndex = process.argv.indexOf('--patch')
const patchPath = patchIndex >= 0 ? process.argv[patchIndex + 1] : undefined
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-isolated',
  text: JSON.stringify({
    home: process.env.DSH_HOME,
    modelKey: process.env.PEGAS_DSH_MODEL_KEY_MAGPIE,
    patch: patchPath ? JSON.parse(fs.readFileSync(patchPath, 'utf8')) : undefined
  }),
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({
      command,
      home: '/tmp/pegas-isolated-dsh-home',
      modelConfiguration: {
        patchPath: managedPatchPath([
          {
            id: 'agent-default-model',
            config: { provider: 'magpie', model: 'gateway/model-a' },
          },
        ]),
        environment: { PEGAS_DSH_MODEL_KEY_MAGPIE: 'managed-key' },
        remove: () => undefined,
      },
    })

    const result = await executor.execute({
      runId: 'run-isolated',
      taskId: 'task-isolated',
      prompt: 'answer directly',
      workingDirectory: process.cwd(),
    })

    expect(JSON.parse(result.output)).toMatchObject({
      home: '/tmp/pegas-isolated-dsh-home',
      modelKey: 'managed-key',
      patch: [
        {
          id: 'agent-default-model',
          config: { provider: 'magpie', model: 'gateway/model-a' },
        },
      ],
    })
  })

  it('keeps the managed model patch when resuming an existing session', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-existing',
  text: JSON.stringify({
    hasPatch: process.argv.includes('--patch'),
    home: process.env.DSH_HOME
  }),
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({
      command,
      home: '/tmp/pegas-isolated-dsh-home',
      agentModel: { provider: 'magpie', model: 'gateway/model-a' },
      modelConfiguration: {
        patchPath: managedPatchPath([
          {
            id: 'agent-default-model',
            config: { provider: 'magpie', model: 'gateway/model-a' },
          },
        ]),
        environment: {},
        remove: () => undefined,
      },
    })

    const result = await executor.execute({
      runId: 'run-resume',
      taskId: 'task-resume',
      prompt: 'continue',
      workingDirectory: process.cwd(),
      resumeSessionId: 'session-existing',
    })

    expect(JSON.parse(result.output)).toEqual({
      hasPatch: true,
      home: '/tmp/pegas-isolated-dsh-home',
    })
  })

  it('exposes only the active Run capability to the Executor process', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-capability',
  text: JSON.stringify({
    baseUrl: process.env.PEGAS_CONTROL_PLANE_URL,
    runId: process.env.PEGAS_RUN_ID,
    taskId: process.env.PEGAS_TASK_ID,
    inputEventId: process.env.PEGAS_INPUT_EVENT_ID,
    claimToken: process.env.PEGAS_RUN_CLAIM_TOKEN,
    capabilityFile: process.env.PEGAS_RUN_CAPABILITY_FILE,
    capability: process.env.PEGAS_RUN_CAPABILITY_FILE
      ? JSON.parse(require('node:fs').readFileSync(process.env.PEGAS_RUN_CAPABILITY_FILE, 'utf8'))
      : undefined,
    apiToken: process.env.PEGAS_API_TOKEN
  }),
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command })

    const result = await executor.execute({
      runId: 'run-current',
      taskId: 'task-current',
      inputEventId: 'event-current',
      prompt: 'perform a protected action',
      workingDirectory: process.cwd(),
      actionCapability: {
        baseUrl: 'http://127.0.0.1:4317',
        claimToken: 'current-run-claim',
      },
    })

    const capabilityOutput = JSON.parse(result.output) as {
      baseUrl: string
      runId: string
      taskId: string
      inputEventId: string
      claimToken: string
      capabilityFile: string
      capability: { baseUrl: string; runId: string; claimToken: string }
      apiToken?: string
    }
    expect(capabilityOutput.baseUrl).toBe('http://127.0.0.1:4317')
    expect(capabilityOutput.runId).toBe('run-current')
    expect(capabilityOutput.taskId).toBe('task-current')
    expect(capabilityOutput.inputEventId).toBe('event-current')
    expect(capabilityOutput.claimToken).toBe('current-run-claim')
    expect(capabilityOutput.apiToken).toBeUndefined()
    expect(capabilityOutput.capabilityFile).toContain('pegas-dsh-capability-')
    expect(capabilityOutput.capability).toEqual({
      baseUrl: 'http://127.0.0.1:4317',
      runId: 'run-current',
      claimToken: 'current-run-claim',
    })
  })

  it('removes the capability file after the child exits', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-capability-cleanup',
  text: process.env.PEGAS_RUN_CAPABILITY_FILE,
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command })
    const result = await executor.execute({
      runId: 'run-cleanup',
      taskId: 'task-cleanup',
      prompt: 'check cleanup',
      workingDirectory: process.cwd(),
      actionCapability: {
        baseUrl: 'http://127.0.0.1:4317',
        claimToken: 'cleanup-claim',
      },
    })
    expect(result.output).toContain('pegas-dsh-capability-')
    expect(existsSync(result.output)).toBe(false)
  })

  it('keeps the claim credential readable from a scrubbed model shell', async () => {
    const command = fakeDsh(`
const { spawnSync } = require('node:child_process')
const pattern = /KEY|PASSWORD|SECRET|TOKEN/i
const scrubbed = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !pattern.test(key) && !key.toUpperCase().startsWith('DSH_'),
  ),
)
const child = spawnSync(
  process.execPath,
  [
    '-e',
    'const fs = require("node:fs");' +
      'const capability = JSON.parse(fs.readFileSync(process.env.PEGAS_RUN_CAPABILITY_FILE, "utf8"));' +
      'process.stdout.write(JSON.stringify({ envToken: process.env.PEGAS_RUN_CLAIM_TOKEN ?? null, fileToken: capability.claimToken, runId: capability.runId }))',
  ],
  { env: scrubbed, encoding: 'utf8' },
)
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-scrubbed-shell',
  text: child.stdout,
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command })
    const result = await executor.execute({
      runId: 'run-scrubbed',
      taskId: 'task-scrubbed',
      prompt: 'call the control plane from a model shell',
      workingDirectory: process.cwd(),
      actionCapability: {
        baseUrl: 'http://127.0.0.1:4317',
        claimToken: 'scrubbed-shell-claim',
      },
    })
    expect(JSON.parse(result.output)).toEqual({
      envToken: null,
      fileToken: 'scrubbed-shell-claim',
      runId: 'run-scrubbed',
    })
  })

  it('describes the bounded collaboration API without granting target authority', () => {
    const prompt = executorPrompt('delegate independent research', {
      strength: 'explicit',
      policyVersion: 'pegas-mandate-v1',
      basis: {
        source: 'web',
        scope: { conversation: 'owner' },
        via: 'router',
      },
      actor: { source: 'web', id: 'owner' },
      scope: 'Research provider compatibility only',
    })
    expect(prompt).toContain('POST /v1/runs/:runId/collaborations')
    expect(prompt).toContain('"kind":"delegate"')
    expect(prompt).toContain('"kind":"handoff"')
    expect(prompt).toContain('"kind":"context_note"')
    expect(prompt).toContain('"kind":"handback"')
    expect(prompt).toContain(
      '不能指定目标 Executor、Session、模型、工作区、工具或权限',
    )
    expect(prompt).toContain('Research provider compatibility only')
  })

  it('describes the goal-proposal API with blocking clarification semantics', () => {
    const prompt = executorPrompt('帮我把方案想清楚')
    expect(prompt).toContain('POST /v1/runs/:runId/goal-proposals')
    expect(prompt).toContain('unknowns[].blocking=true')
    expect(prompt).toContain('提交后应立即结束当前 turn 等待用户回答')
    expect(prompt).toContain('不要为简单明确的低风险请求强行发起访谈')
    expect(prompt).toContain('新 revision 而不是覆盖原始输入')
    expect(prompt).toContain('PEGAS_INPUT_EVENT_ID')
  })

  it('describes the follow-up API as a one-shot continuation of the current Task', () => {
    const prompt = executorPrompt('明天下午再问我是否发布')
    expect(prompt).toContain('POST /v1/runs/:runId/follow-ups')
    expect(prompt).toContain('Follow-up 只针对当前事情继续一次')
    expect(prompt).toContain('事情已停止或完成时不会唤醒')
    expect(prompt).toContain('ISO-8601 未来时间')
    expect(prompt).toContain('必须带时区偏移或 Z')
    expect(prompt).toContain('禁止把本地墙钟时间直接标成 Z')
  })

  it('describes the recurring automation API and forbids sleep-loop simulation', () => {
    const prompt = executorPrompt('每分钟报一个数，从 1 数到 10')
    expect(prompt).toContain('POST /v1/runs/:runId/automations')
    expect(prompt).toContain('everySeconds')
    expect(prompt).toContain('禁止用 sleep/循环在当前 Run 里模拟周期任务')
    expect(prompt).toContain('固定续接当前事情')
    expect(prompt).toContain(
      'POST /v1/runs/:runId/automations/:automationId/pause',
    )
    expect(prompt).toContain('expectedRevision')
    expect(prompt).toContain('周期责任也不会复活已关闭的事情')
    expect(prompt).toContain('PEGAS_RUN_CAPABILITY_FILE')
    expect(prompt).toContain('Run 结束时它会被自动删除')
  })

  it('describes the say API for user-visible progress inside a Run', () => {
    const prompt = executorPrompt('每分钟报一个数，从 1 数到 10')
    expect(prompt).toContain('POST /v1/runs/:runId/messages')
    expect(prompt).toContain(
      '{"commandId":"stable-key","text":"要让用户看到的话"}',
    )
    expect(prompt).toContain('立即出现在对话正文')
    expect(prompt).toContain('周期触发的 Run 必须')
    expect(prompt).toContain('不会把 Run 或 Task 结算为完成')
  })

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

    expect(result).toMatchObject({
      executorRef: 'session-test',
      output: 'finished',
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
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
      onProgress: event => {
        if (event.type === 'acknowledgement') acknowledgements.push(event.text)
      },
    })

    expect(acknowledgements).toEqual([
      'I will inspect the project and verify the fix.',
    ])
  })

  it('projects auto review verdicts as activity progress', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({ type: 'session', sessionId: 'session-test' }))
console.log(JSON.stringify({
  type: 'auto_review',
  callId: 'call-review',
  tool: 'write',
  decision: 'deny',
  risk: 'medium',
  reason: '目标超出授权'
}))
console.log(JSON.stringify({
  type: 'auto_review',
  callId: 'call-review-2',
  tool: 'write',
  decision: 'allow',
  risk: 'medium'
}))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-test',
  text: 'finished',
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command })
    const activities: string[] = []
    await executor.execute({
      runId: 'run-1',
      taskId: 'task-1',
      prompt: 'do the work',
      workingDirectory: process.cwd(),
      onProgress: event => {
        if (event.type === 'activity') activities.push(event.label)
      },
    })
    expect(activities).toContain('自动审阅未放行 write：目标超出授权')
    expect(activities).toContain('自动审阅已按你的原话授权放行 write')
  })

  it('forwards gate decisions with audit provenance as structured progress', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({ type: 'session', sessionId: 'session-test' }))
console.log(JSON.stringify({
  type: 'policy_decision',
  callId: 'call-audit',
  tool: 'write',
  category: 'out-of-workspace-write',
  risk: 'high',
  decision: 'allow',
  reason: '命中本事情已批准规则。',
  ruleId: 'rule-7',
  reviewDecision: 'allow',
  actionId: 'action-7',
  tier: 'standard',
  generation: 'gen-7',
  mismatch: false,
  targets: ['/tmp/outside/report.md']
}))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-test',
  text: 'finished',
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command })
    const decisions: Record<string, unknown>[] = []
    await executor.execute({
      runId: 'run-1',
      taskId: 'task-1',
      prompt: 'do the work',
      workingDirectory: process.cwd(),
      onProgress: event => {
        if (event.type === 'policy_decision') decisions.push({ ...event })
      },
    })
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({
      callId: 'call-audit',
      tool: 'write',
      decision: 'allow',
      ruleId: 'rule-7',
      reviewDecision: 'allow',
      actionId: 'action-7',
      tier: 'standard',
      generation: 'gen-7',
      mismatch: false,
      targets: ['/tmp/outside/report.md'],
    })
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
      onProgress: event => {
        if (event.type === 'acknowledgement') acknowledgements.push(event.text)
      },
    })

    expect(acknowledgements).toEqual([])
  })

  it('sums only provider-reported DSH step usage and preserves incomplete steps', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({ type: 'session', sessionId: 'session-usage' }))
console.log(JSON.stringify({
  type: 'status',
  phase: 'step_end',
  usage: {
    inputTokens: 120,
    outputTokens: 30,
    totalTokens: 200,
    cacheReadTokens: 40,
    cacheWriteTokens: 10,
    reasoningTokens: 8
  }
}))
console.log(JSON.stringify({
  type: 'status',
  phase: 'step_end',
  usage: {
    inputTokens: 80,
    outputTokens: 20,
    totalTokens: 110,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    reasoningTokens: 4
  }
}))
console.log(JSON.stringify({ type: 'status', phase: 'step_end' }))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-usage',
  text: 'finished',
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command })

    const result = await executor.execute({
      runId: 'run-usage',
      taskId: 'task-1',
      prompt: 'measure the work',
      workingDirectory: process.cwd(),
    })

    expect(result.usage).toEqual({
      source: 'provider_reported',
      reportedSteps: 2,
      unreportedSteps: 1,
      tokens: {
        inputTokens: 200,
        outputTokens: 50,
        totalTokens: 310,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        reasoningTokens: 12,
      },
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('omits optional token buckets when any reported step omits them', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({
  type: 'status',
  phase: 'step_end',
  usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 }
}))
console.log(JSON.stringify({
  type: 'status',
  phase: 'step_end',
  usage: { inputTokens: 20, outputTokens: 3 }
}))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-usage-optional',
  text: 'finished',
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command })

    const result = await executor.execute({
      runId: 'run-usage-optional',
      taskId: 'task-1',
      prompt: 'measure the work',
      workingDirectory: process.cwd(),
    })

    expect(result.usage?.tokens).toEqual({
      inputTokens: 30,
      outputTokens: 5,
    })
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

  it('starts a fresh session when DSH rejects a session from another workspace', async () => {
    const command = fakeDsh(`
if (process.argv.includes('--session-id')) {
  console.error('session "session-old" was recorded in "/old/worktree", not "/current/worktree"')
  process.exit(1)
}
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-fresh',
  text: 'continued in the current workspace',
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command })
    const observedSessions: string[] = []

    const result = await executor.execute({
      runId: 'run-migrated-workspace',
      taskId: 'task-1',
      prompt: 'continue the work',
      workingDirectory: process.cwd(),
      resumeSessionId: 'session-old',
      onExecutorRef: value => observedSessions.push(value),
    })

    expect(result).toMatchObject({
      executorRef: 'session-fresh',
      output: 'continued in the current workspace',
    })
    expect(observedSessions).toEqual(['session-fresh'])
  })

  it('starts a fresh session when the resumed session no longer exists in the isolated home', async () => {
    const command = fakeDsh(`
if (process.argv.includes('--session-id')) {
  console.error('dsh: all_proxy names a SOCKS proxy, which is not supported; connecting directly for that scheme — set an http:// or https:// proxy URL instead')
  console.error('dsh: session "session-legacy" does not exist; omit --session-id to start a new Session')
  process.exit(1)
}
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-reopened',
  text: 'reopened after the isolated home switch',
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command })
    const observedSessions: string[] = []

    const result = await executor.execute({
      runId: 'run-legacy-home',
      taskId: 'task-legacy',
      prompt: 'continue the work',
      workingDirectory: process.cwd(),
      resumeSessionId: 'session-legacy',
      onExecutorRef: value => observedSessions.push(value),
    })

    expect(result).toMatchObject({
      executorRef: 'session-reopened',
      output: 'reopened after the isolated home switch',
    })
    expect(observedSessions).toEqual(['session-reopened'])
  })

  it('still fails when the missing-session error names a different session', async () => {
    const command = fakeDsh(`
console.error('dsh: session "session-other" does not exist; omit --session-id to start a new Session')
process.exit(1)
`)
    const executor = new DshCliExecutor({ command })

    await expect(
      executor.execute({
        runId: 'run-unrelated-missing',
        taskId: 'task-legacy',
        prompt: 'continue the work',
        workingDirectory: process.cwd(),
        resumeSessionId: 'session-legacy',
      }),
    ).rejects.toThrow('does not exist')
  })

  it('retries a resume while the previous DSH process still holds the session write lock', async () => {
    const lockDirectory = mkdtempSync(join(tmpdir(), 'pegas-session-busy-'))
    temporaryDirectories.push(lockDirectory)
    const lockPath = join(lockDirectory, 'held')
    writeFileSync(lockPath, 'held')
    const command = fakeDsh(`
const fs = require('node:fs')
const lockPath = ${JSON.stringify(lockPath)}
if (fs.existsSync(lockPath)) {
  fs.unlinkSync(lockPath)
  console.error('session "session-busy" is already owned by an active write handle')
  process.exit(1)
}
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-busy',
  text: 'resumed after the lock drained',
  reason: { kind: 'completed' }
}))
`)
    const previousRetry = process.env.PEGAS_DSH_SESSION_BUSY_RETRY_MS
    process.env.PEGAS_DSH_SESSION_BUSY_RETRY_MS = '20'
    try {
      const executor = new DshCliExecutor({ command })
      const result = await executor.execute({
        runId: 'run-busy-resume',
        taskId: 'task-busy',
        prompt: 'continue after approval',
        workingDirectory: process.cwd(),
        resumeSessionId: 'session-busy',
      })
      expect(result.output).toBe('resumed after the lock drained')
    } finally {
      if (previousRetry === undefined) {
        delete process.env.PEGAS_DSH_SESSION_BUSY_RETRY_MS
      } else {
        process.env.PEGAS_DSH_SESSION_BUSY_RETRY_MS = previousRetry
      }
    }
  })

  it('fails a resume when the session write lock stays held past the bounded wait', async () => {
    const command = fakeDsh(`
console.error('session "session-held" is already owned by an active write handle')
process.exit(1)
`)
    const previousWait = process.env.PEGAS_DSH_SESSION_BUSY_WAIT_MS
    const previousRetry = process.env.PEGAS_DSH_SESSION_BUSY_RETRY_MS
    process.env.PEGAS_DSH_SESSION_BUSY_WAIT_MS = '60'
    process.env.PEGAS_DSH_SESSION_BUSY_RETRY_MS = '20'
    try {
      const executor = new DshCliExecutor({ command })
      await expect(
        executor.execute({
          runId: 'run-held-resume',
          taskId: 'task-held',
          prompt: 'continue after approval',
          workingDirectory: process.cwd(),
          resumeSessionId: 'session-held',
        }),
      ).rejects.toThrow('already owned by an active write handle')
    } finally {
      if (previousWait === undefined) {
        delete process.env.PEGAS_DSH_SESSION_BUSY_WAIT_MS
      } else {
        process.env.PEGAS_DSH_SESSION_BUSY_WAIT_MS = previousWait
      }
      if (previousRetry === undefined) {
        delete process.env.PEGAS_DSH_SESSION_BUSY_RETRY_MS
      } else {
        process.env.PEGAS_DSH_SESSION_BUSY_RETRY_MS = previousRetry
      }
    }
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
    const executionTimeoutMs = 2_000
    const command = fakeDsh(`
process.on('SIGTERM', () => {})
console.log(JSON.stringify({ type: 'session', sessionId: String(process.pid) }))
setInterval(() => {}, 1000)
`)
    const executor = new DshCliExecutor({
      command,
      // The timeout exercises termination behavior, not process startup speed.
      // Leave enough time for a real Node child to boot on loaded CI runners.
      timeoutMs: executionTimeoutMs,
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
      message: `DSH execution timed out after ${String(executionTimeoutMs)}ms`,
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

  it('mounts the read-only tool surface patch only under read-only permission mode', async () => {
    const command = fakeDsh(`
const fs = require('node:fs')
const patchPaths = process.argv
  .map((value, index) => (value === '--patch' ? process.argv[index + 1] : undefined))
  .filter(value => value !== undefined)
const patches = patchPaths.map(path => JSON.parse(fs.readFileSync(path, 'utf8')))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-surface',
  text: JSON.stringify({ patchPaths, patches }),
  reason: { kind: 'completed' }
}))
`)
    const readonly = new DshCliExecutor({
      command,
      permissionMode: 'read-only',
    })
    const readonlyResult = await readonly.execute({
      runId: 'run-readonly',
      taskId: 'task-1',
      prompt: '随便聊聊',
      workingDirectory: process.cwd(),
    })
    const readonlyOutput = JSON.parse(readonlyResult.output) as {
      patchPaths: string[]
      patches: { insert?: { id: string; name: string }[] }[][]
    }
    const surfacePatches = readonlyOutput.patches
      .flat()
      .filter(patch =>
        patch.insert?.some(entry => entry.id === 'pegas-readonly-surface'),
      )
    expect(surfacePatches).toHaveLength(1)
    expect(surfacePatches[0]?.insert?.[0]?.name).toContain(
      'dsh-readonly-surface.mjs',
    )
    for (const path of readonlyOutput.patchPaths) {
      expect(existsSync(path)).toBe(false)
    }

    const writable = new DshCliExecutor({
      command,
      permissionMode: 'workspace-write',
    })
    const writableResult = await writable.execute({
      runId: 'run-writable',
      taskId: 'task-1',
      prompt: '干活',
      workingDirectory: process.cwd(),
    })
    const writableOutput = JSON.parse(writableResult.output) as {
      patches: { insert?: { id: string }[] }[][]
    }
    expect(
      writableOutput.patches
        .flat()
        .some(patch =>
          patch.insert?.some(entry => entry.id === 'pegas-readonly-surface'),
        ),
    ).toBe(false)
  })

  it('embeds the conversation state capability in the surface patch config', async () => {
    const command = fakeDsh(`
const fs = require('node:fs')
const patchPaths = process.argv
  .map((value, index) => (value === '--patch' ? process.argv[index + 1] : undefined))
  .filter(value => value !== undefined)
const patches = patchPaths.map(path => JSON.parse(fs.readFileSync(path, 'utf8')))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-state-tools',
  text: JSON.stringify(patches),
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({
      command,
      permissionMode: 'read-only',
    })
    const capability = {
      baseUrl: 'http://127.0.0.1:4317',
      runId: 'run-chat',
      claimToken: 'claim-token',
      privacyMode: 'disabled',
    } as const
    const result = await executor.execute({
      runId: 'run-chat',
      taskId: 'task-chat',
      prompt: '我有哪些任务',
      workingDirectory: process.cwd(),
      conversationStateCapability: capability,
    })
    const patches = JSON.parse(result.output) as {
      insert?: {
        id: string
        config?: { capability?: unknown; masker?: unknown }
      }[]
    }[][]
    const entry = patches
      .flat()
      .flatMap(patch => patch.insert ?? [])
      .find(candidate => candidate.id === 'pegas-readonly-surface')
    expect(entry?.config?.capability).toEqual(capability)
    expect(entry?.config?.masker).toBeUndefined()
  })

  it('mounts history tools for work Runs with an action capability and cleans up the patch', async () => {
    const command = fakeDsh(`
const fs = require('node:fs')
const patchPaths = process.argv
  .map((value, index) => (value === '--patch' ? process.argv[index + 1] : undefined))
  .filter(value => value !== undefined)
const patches = patchPaths.map(path => JSON.parse(fs.readFileSync(path, 'utf8')))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-history-tools',
  text: JSON.stringify({ patchPaths, patches }),
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({
      command,
      permissionMode: 'workspace-write',
    })
    const result = await executor.execute({
      runId: 'run-work',
      taskId: 'task-work',
      prompt: '上次那个表放哪了',
      workingDirectory: process.cwd(),
      actionCapability: {
        baseUrl: 'http://127.0.0.1:4317',
        claimToken: 'claim-token',
      },
    })
    const output = JSON.parse(result.output) as {
      patchPaths: string[]
      patches: {
        insert?: {
          id: string
          name: string
          config?: { capability?: unknown }
        }[]
      }[][]
    }
    const entry = output.patches
      .flat()
      .flatMap(patch => patch.insert ?? [])
      .find(candidate => candidate.id === 'pegas-history-tools')
    expect(entry?.name).toContain('dsh-history-tools.mjs')
    expect(entry?.config?.capability).toEqual({
      baseUrl: 'http://127.0.0.1:4317',
      runId: 'run-work',
      claimToken: 'claim-token',
      privacyMode: 'disabled',
    })
    for (const path of output.patchPaths) {
      expect(existsSync(path)).toBe(false)
    }

    // Without an action capability the work lane gets no history patch.
    const bare = await executor.execute({
      runId: 'run-bare',
      taskId: 'task-work',
      prompt: '干活',
      workingDirectory: process.cwd(),
    })
    const bareOutput = JSON.parse(bare.output) as {
      patches: { insert?: { id: string }[] }[][]
    }
    expect(
      bareOutput.patches
        .flat()
        .some(patch =>
          patch.insert?.some(
            candidate => candidate.id === 'pegas-history-tools',
          ),
        ),
    ).toBe(false)
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

function managedPatchPath(entries: unknown[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-managed-patch-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'model-configuration.json')
  writeFileSync(path, JSON.stringify(entries), { mode: 0o600 })
  return path
}
