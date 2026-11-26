import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import { loadConfig } from '../src/core/config.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { DshCliExecutor } from '../src/executor/dsh-cli-executor.js'
import type { ToolApprovalGrant } from '../src/executor/executor.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

interface BridgeContext {
  handlers: Map<string, (...args: unknown[]) => unknown>
}

type BridgeListener = (
  first: Record<string, unknown>,
  second: unknown,
  third?: unknown,
) => Promise<unknown>

interface BridgeModule {
  apply: (ctx: unknown, config?: Record<string, unknown>) => void
}

async function loadBridge(): Promise<{
  apply: (ctx: unknown, config?: Record<string, unknown>) => void
}> {
  const module: unknown =
    await import('../src/executor/dsh-approval-bridge.mjs')
  return module as BridgeModule
}

function bridgeContext(): BridgeContext & {
  on: (event: string, listener: BridgeListener) => void
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers,
    on: (event, listener) => {
      handlers.set(event, listener as (...args: unknown[]) => unknown)
    },
  }
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  const text: unknown = JSON.stringify(value)
  return typeof text === 'string' ? text : 'null'
}

function outboxPayloadTypes(store: PegasStore): string[] {
  return store.listOutbox('owner').map(entry => {
    const payload = entry.payload as { type?: unknown }
    return typeof payload.type === 'string' ? payload.type : ''
  })
}

describe('DSH approval bridge plugin', () => {
  it('parks an escalated tool call as a durable Approval and reports the pending event', async () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-bridge')
    const server = createControlPlane({ store, apiToken: 'bridge-test' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const previous = { ...process.env }
    process.env.PEGAS_APPROVAL_BRIDGE = '1'
    process.env.PEGAS_CONTROL_PLANE_URL = baseUrl
    process.env.PEGAS_RUN_ID = claimed.run.id
    process.env.PEGAS_RUN_CLAIM_TOKEN = claimed.claimToken
    try {
      const bridge = await loadBridge()
      const ctx = bridgeContext()
      const events: Record<string, unknown>[] = []
      bridge.apply(ctx, {
        emit: (event: unknown) => events.push(event as Record<string, unknown>),
      })

      const preExecute = ctx.handlers.get('tools/pre-execute')
      const approvalRequest = ctx.handlers.get('approval/request')
      if (!preExecute || !approvalRequest) {
        throw new Error('bridge did not register its hooks')
      }
      const exec = {
        callId: 'call-42',
        name: 'bash',
        arguments: { command: 'chmod 777 /outside' },
      }
      await preExecute(exec, () => Promise.resolve({ kind: 'allow' }))
      const outcome = await approvalRequest(
        {
          agent: {},
          toolName: 'bash',
          callId: 'call-42',
          reason: 'escalate sandbox to danger-full-access: write outside',
        },
        () => Promise.resolve('unavailable'),
      )
      expect(outcome).toBe('rejected')
      const pendingEvents = events.filter(
        event => event.type === 'approval_pending',
      )
      expect(pendingEvents).toHaveLength(1)
      expect(pendingEvents[0]).toMatchObject({
        type: 'approval_pending',
        callId: 'call-42',
        tool: 'bash',
      })
      const approval = store.pageApprovals('owner', 10).items[0]
      if (!approval) throw new Error('Expected a durable Approval')
      const action = store.getAction(approval.actionId, 'owner')
      expect(action).toMatchObject({
        kind: 'dsh.tool.bash',
        risk: 'high',
        status: 'awaiting_approval',
        request: {
          tool: 'bash',
          callId: 'call-42',
          argumentsHash: stableHash({ command: 'chmod 777 /outside' }),
        },
      })
      expect(store.listRuns(claimed.task.id).at(-1)).toMatchObject({
        status: 'waiting',
      })
      expect(outboxPayloadTypes(store)).toContain('approval.required')
    } finally {
      restoreEnvironment(previous)
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })

  it('grants exactly the approved call once and records the real outcome', async () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-grant')
    const server = createControlPlane({ store, apiToken: 'bridge-test' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      {
        kind: 'dsh.tool.bash',
        risk: 'high',
        idempotencyKey: 'dsh-tool:grant-1',
        request: {
          tool: 'bash',
          callId: 'call-7',
          reason: 'escalate sandbox',
          argumentsHash: stableHash({ command: 'echo done' }),
        },
        recoveryPoint: { step: 'before_tool_call' },
        approval: {
          summary: '批准 bash',
          impact: '一次越权命令',
          recommendedOptionId: 'approve',
          options: [
            { id: 'approve', label: '批准', kind: 'approve' },
            { id: 'reject', label: '拒绝', kind: 'reject' },
          ],
        },
      },
    )
    store.decideApproval(requested.approval.id, 'owner', {
      commandId: 'grant-decision',
      optionId: 'approve',
    })
    const resumed = store.claimNextRun('worker-grant-resumed')
    if (!resumed) throw new Error('Expected approved successor Run')
    const grant: ToolApprovalGrant = {
      actionId: requested.action.id,
      tool: 'bash',
      argumentsHash: stableHash({ command: 'echo done' }),
    }
    const previous = { ...process.env }
    process.env.PEGAS_APPROVAL_BRIDGE = '1'
    process.env.PEGAS_CONTROL_PLANE_URL = baseUrl
    process.env.PEGAS_RUN_ID = resumed.run.id
    process.env.PEGAS_RUN_CLAIM_TOKEN = resumed.claimToken
    try {
      const bridge = await loadBridge()
      const ctx = bridgeContext()
      const events: Record<string, unknown>[] = []
      bridge.apply(ctx, {
        grant,
        emit: (event: unknown) => events.push(event as Record<string, unknown>),
      })
      const preExecute = ctx.handlers.get('tools/pre-execute')
      const approvalRequest = ctx.handlers.get('approval/request')
      const postExecute = ctx.handlers.get('tools/post-execute')
      if (!preExecute || !approvalRequest || !postExecute) {
        throw new Error('bridge did not register its hooks')
      }
      const exec = {
        agent: {},
        callId: 'call-new',
        name: 'bash',
        arguments: { command: 'echo done' },
      }
      await preExecute(exec, () => Promise.resolve({ kind: 'allow' }))
      const outcome = await approvalRequest(
        { agent: {}, toolName: 'bash', callId: 'call-new' },
        () => Promise.resolve('unavailable'),
      )
      expect(outcome).toBe('allowed-once')
      await postExecute(exec, { isError: false }, () =>
        Promise.resolve({ kind: 'accept' }),
      )
      expect(store.getAction(requested.action.id, 'owner')).toMatchObject({
        status: 'succeeded',
        result: { tool: 'bash', callId: 'call-new' },
      })
      expect(events.filter(event => event.type === 'approval_pending')).toEqual(
        [],
      )
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: 'policy_decision',
        callId: 'call-new',
        decision: 'allow',
        actionId: requested.action.id,
      })

      const differentExec = {
        agent: {},
        callId: 'call-other',
        name: 'bash',
        arguments: { command: 'rm -rf /' },
      }
      await preExecute(differentExec, () => Promise.resolve({ kind: 'allow' }))
      const secondOutcome = await approvalRequest(
        { agent: {}, toolName: 'bash', callId: 'call-other' },
        () => Promise.resolve('unavailable'),
      )
      expect(secondOutcome).toBe('rejected')
      const pendingEvents = events.filter(
        event => event.type === 'approval_pending',
      )
      expect(pendingEvents).toHaveLength(1)
      expect(pendingEvents[0]).toMatchObject({ type: 'approval_pending' })
    } finally {
      restoreEnvironment(previous)
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })

  it('settles an unconsumed one-time grant as failed when the resumed run never replays the call', async () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-drift')
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      {
        kind: 'dsh.tool.search_history',
        risk: 'high',
        idempotencyKey: 'dsh-tool:drift-1',
        request: {
          tool: 'search_history',
          callId: 'call-original',
          reason: '无法静态判定工具 search_history 的实际效果，需要你确认。',
          argumentsHash: stableHash({ query: 'pegas 语音输入', limit: 10 }),
        },
        recoveryPoint: { step: 'before_tool_call' },
        approval: {
          summary: '批准工具 search_history 越权执行一次',
          impact: '一次越权调用',
          recommendedOptionId: 'approve',
          options: [
            { id: 'approve', label: '批准', kind: 'approve' },
            { id: 'reject', label: '拒绝', kind: 'reject' },
          ],
        },
      },
    )
    store.decideApproval(requested.approval.id, 'owner', {
      commandId: 'drift-approve',
      optionId: 'approve',
    })
    const route = () =>
      Promise.resolve({
        kind: 'continue_task' as const,
        taskId: claimed.task.id,
        input: '再调研一下tts/stt，我想要集成到pegas',
        reason: 'test parked continuation',
      })
    const handler = new RoutingEventHandler({ route }, 'echo')
    expect(await processNextEvent(store, handler, 'event-drift-decided')).toBe(
      true,
    )
    const continuation = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'test',
      payload: { text: '再调研一下tts/stt，我想要集成到pegas' },
    }).event
    expect(await processNextEvent(store, handler, 'event-drift')).toBe(true)
    expect(
      store.listEvents('owner').find(event => event.id === continuation.id),
    ).toMatchObject({
      status: 'processing',
      lastError: 'blocked_by_action:authorized',
    })

    const resumed = store.claimNextRun('worker-drift-resumed')
    if (!resumed) throw new Error('Expected approved successor Run')
    const command = fakeDsh(`
console.log(JSON.stringify({ type: 'session', sessionId: 'session-drift' }))
console.log(JSON.stringify({
  type: 'tool_call', callId: 'call-replayed', tool: 'search_history'
}))
console.log(JSON.stringify({
  type: 'tool_result', callId: 'call-replayed', status: 'error'
}))
console.log(JSON.stringify({
  type: 'final', sessionId: 'session-drift',
  text: '批准的调用没有按原参数重放，我改用其他方式继续。',
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command, approvalPolicy: 'ask' })
    const server = createControlPlane({ store, apiToken: 'loop-test' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    try {
      const previous = { ...process.env }
      process.env.PEGAS_APPROVAL_BRIDGE = '1'
      process.env.PEGAS_CONTROL_PLANE_URL = baseUrl
      process.env.PEGAS_RUN_ID = resumed.run.id
      process.env.PEGAS_RUN_CLAIM_TOKEN = resumed.claimToken
      const bridge = await loadBridge()
      const ctx = bridgeContext()
      bridge.apply(ctx, {
        grant: {
          actionId: requested.action.id,
          tool: 'search_history',
          argumentsHash: stableHash({ query: 'pegas 语音输入', limit: 10 }),
        },
        emit: () => undefined,
      })
      const preExecute = ctx.handlers.get('tools/pre-execute')
      const approvalRequest = ctx.handlers.get('approval/request')
      const agentStatus = ctx.handlers.get('agent/status')
      if (!preExecute || !approvalRequest || !agentStatus) {
        throw new Error('bridge did not register its hooks')
      }
      const replayed = {
        callId: 'call-replayed',
        name: 'search_history',
        arguments: { query: 'pegas 架构 客户端', limit: 10 },
      }
      await preExecute(replayed, () => Promise.resolve({ kind: 'allow' }))
      const decision = await approvalRequest(
        { toolName: 'search_history', callId: 'call-replayed' },
        () => Promise.resolve('unavailable'),
      )
      expect(decision).toBe('rejected')
      await executeClaimedRun(
        store,
        executor,
        resumed,
        'worker-drift-resumed',
        process.cwd(),
        new AbortController().signal,
        baseUrl,
      )
      await agentStatus({ status: 'idle' })
      restoreEnvironment(previous)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    const action = store.getAction(requested.action.id, 'owner')
    expect(action).toMatchObject({ status: 'failed' })
    expect(
      store.listEvents('owner').find(event => event.id === continuation.id),
    ).toMatchObject({ status: 'pending' })
    expect(await processNextEvent(store, handler, 'event-drift')).toBe(true)
    expect(
      store.listEvents('owner').find(event => event.id === continuation.id),
    ).toMatchObject({ status: 'processing' })
    const replacement = store
      .listOutbox('owner')
      .map(message => message.payload as { type?: string; approvalId?: string })
      .findLast(payload => payload.type === 'approval.required')
    expect(replacement).toBeDefined()
    expect(
      store.getApproval(String(replacement?.approvalId), 'owner')?.status,
    ).toBe('pending')
    store.close()
  })

  it('keeps the run alive when the approval API durably rejects a new request', async () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-reject-api')
    const first = store.requestApproval(claimed.run.id, claimed.claimToken, {
      kind: 'dsh.tool.bash',
      risk: 'high',
      idempotencyKey: 'dsh-tool:reject-api-1',
      request: {
        tool: 'bash',
        callId: 'call-first',
        reason: 'escalate sandbox',
        argumentsHash: stableHash({ command: 'echo one' }),
      },
      recoveryPoint: { step: 'before_tool_call' },
      approval: {
        summary: '批准 bash',
        impact: '一次越权命令',
        recommendedOptionId: 'approve',
        options: [
          { id: 'approve', label: '批准', kind: 'approve' },
          { id: 'reject', label: '拒绝', kind: 'reject' },
        ],
      },
    })
    store.decideApproval(first.approval.id, 'owner', {
      commandId: 'reject-api-approve',
      optionId: 'approve',
    })
    const resumed = store.claimNextRun('worker-reject-api-resumed')
    if (!resumed) throw new Error('Expected approved successor Run')
    const server = createControlPlane({ store, apiToken: 'loop-test' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const previous = { ...process.env }
    process.env.PEGAS_APPROVAL_BRIDGE = '1'
    process.env.PEGAS_CONTROL_PLANE_URL = baseUrl
    process.env.PEGAS_RUN_ID = resumed.run.id
    process.env.PEGAS_RUN_CLAIM_TOKEN = resumed.claimToken
    try {
      const bridge = await loadBridge()
      const ctx = bridgeContext()
      const events: Record<string, unknown>[] = []
      bridge.apply(ctx, {
        emit: (event: unknown) => events.push(event as Record<string, unknown>),
      })
      const preExecute = ctx.handlers.get('tools/pre-execute')
      const approvalRequest = ctx.handlers.get('approval/request')
      if (!preExecute || !approvalRequest) {
        throw new Error('bridge did not register its hooks')
      }
      const exec = {
        callId: 'call-second',
        name: 'bash',
        arguments: { command: 'chmod 777 /outside' },
      }
      await preExecute(exec, () => Promise.resolve({ kind: 'allow' }))
      const outcome = await approvalRequest(
        { toolName: 'bash', callId: 'call-second' },
        () => Promise.resolve('unavailable'),
      )
      expect(outcome).toBe('rejected')
      expect(
        events.filter(event => event.type === 'approval_bridge_error'),
      ).toEqual([])
      const rejected = events.filter(
        event => event.type === 'approval_request_rejected',
      )
      expect(rejected).toHaveLength(1)
      expect(rejected[0]).toMatchObject({
        callId: 'call-second',
        message: 'Pegas API returned 400',
      })
      expect(store.pageApprovals('owner', 10).items).toHaveLength(1)
      expect(store.getAction(first.action.id, 'owner')).toMatchObject({
        status: 'authorized',
      })
    } finally {
      restoreEnvironment(previous)
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })

  it('records a failed outcome when the granted tool call fails', async () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'owner', 'worker-failed')
    const server = createControlPlane({ store, apiToken: 'bridge-test' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const requested = store.requestApproval(
      claimed.run.id,
      claimed.claimToken,
      {
        kind: 'dsh.tool.bash',
        risk: 'high',
        idempotencyKey: 'dsh-tool:failed-1',
        request: {
          tool: 'bash',
          callId: 'call-9',
          reason: 'escalate sandbox',
          argumentsHash: stableHash({ command: 'false' }),
        },
        recoveryPoint: { step: 'before_tool_call' },
        approval: {
          summary: '批准 bash',
          impact: '一次越权命令',
          recommendedOptionId: 'approve',
          options: [
            { id: 'approve', label: '批准', kind: 'approve' },
            { id: 'reject', label: '拒绝', kind: 'reject' },
          ],
        },
      },
    )
    store.decideApproval(requested.approval.id, 'owner', {
      commandId: 'failed-decision',
      optionId: 'approve',
    })
    const resumed = store.claimNextRun('worker-failed-resumed')
    if (!resumed) throw new Error('Expected approved successor Run')
    const previous = { ...process.env }
    process.env.PEGAS_APPROVAL_BRIDGE = '1'
    process.env.PEGAS_CONTROL_PLANE_URL = baseUrl
    process.env.PEGAS_RUN_ID = resumed.run.id
    process.env.PEGAS_RUN_CLAIM_TOKEN = resumed.claimToken
    try {
      const bridge = await loadBridge()
      const ctx = bridgeContext()
      bridge.apply(ctx, {
        grant: {
          actionId: requested.action.id,
          tool: 'bash',
          argumentsHash: stableHash({ command: 'false' }),
        },
        emit: () => undefined,
      })
      const preExecute = ctx.handlers.get('tools/pre-execute')
      const approvalRequest = ctx.handlers.get('approval/request')
      const postExecute = ctx.handlers.get('tools/post-execute')
      if (!preExecute || !approvalRequest || !postExecute) {
        throw new Error('bridge did not register its hooks')
      }
      const exec = {
        callId: 'call-fail',
        name: 'bash',
        arguments: { command: 'false' },
      }
      await preExecute(exec, () => Promise.resolve({ kind: 'allow' }))
      await approvalRequest(
        { agent: {}, toolName: 'bash', callId: 'call-fail' },
        () => Promise.resolve('unavailable'),
      )
      await postExecute(exec, { isError: true }, () =>
        Promise.resolve({ kind: 'accept' }),
      )
      expect(store.getAction(requested.action.id, 'owner')).toMatchObject({
        status: 'failed',
      })
    } finally {
      restoreEnvironment(previous)
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })

  it('fails closed without the capability environment', async () => {
    const bridge = await loadBridge()
    const ctx = bridgeContext()
    const previous = { ...process.env }
    delete process.env.PEGAS_APPROVAL_BRIDGE
    delete process.env.PEGAS_CONTROL_PLANE_URL
    delete process.env.PEGAS_RUN_ID
    delete process.env.PEGAS_RUN_CLAIM_TOKEN
    try {
      bridge.apply(ctx)
      const approvalRequest = ctx.handlers.get('approval/request')
      if (!approvalRequest) throw new Error('bridge did not register')
      const outcome = await approvalRequest(
        { agent: {}, toolName: 'bash', callId: 'call-x' },
        () => Promise.resolve('unavailable'),
      )
      expect(outcome).toBe('unavailable')
    } finally {
      restoreEnvironment(previous)
    }
  })
})

describe('DshCliExecutor approval parking', () => {
  it('returns approvalPending instead of failing when the bridge parks the run', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({ type: 'session', sessionId: 'session-park' }))
console.log(JSON.stringify({
  type: 'approval_pending',
  callId: 'call-1',
  tool: 'bash',
  actionId: 'action-1',
  approvalId: 'approval-1'
}))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-park',
  text: 'The tool was denied.',
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command, approvalPolicy: 'ask' })
    const result = await executor.execute({
      runId: 'run-park',
      taskId: 'task-park',
      prompt: 'write outside the workspace',
      workingDirectory: process.cwd(),
      actionCapability: {
        baseUrl: 'http://127.0.0.1:4317',
        claimToken: 'claim',
      },
    })
    expect(result.approvalPending).toEqual({
      actionId: 'action-1',
      approvalId: 'approval-1',
      callId: 'call-1',
      tool: 'bash',
    })
    expect(result.executorRef).toBe('session-park')
    expect(result.output).toContain('等待你的决定')
  })

  it('fails the run when the bridge cannot reach the approval API', async () => {
    const command = fakeDsh(`
console.log(JSON.stringify({ type: 'session', sessionId: 'session-err' }))
console.log(JSON.stringify({
  type: 'approval_bridge_error',
  stage: 'request',
  callId: 'call-1',
  message: 'Pegas API returned 403'
}))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-err',
  text: 'done',
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({ command, approvalPolicy: 'ask' })
    await expect(
      executor.execute({
        runId: 'run-err',
        taskId: 'task-err',
        prompt: 'write outside',
        workingDirectory: process.cwd(),
        actionCapability: {
          baseUrl: 'http://127.0.0.1:4317',
          claimToken: 'claim',
        },
      }),
    ).rejects.toThrow(/Approval bridge failed to request/)
  })

  it('passes the bridge patch and grant only for ask runs with capability', async () => {
    const command = fakeDsh(`
const fs = require('node:fs')
const args = process.argv.slice(2)
const patchPaths = args
  .map((value, index) => (value === '--patch' ? args[index + 1] : undefined))
  .filter(Boolean)
const patches = patchPaths.map(path => JSON.parse(fs.readFileSync(path, 'utf8')))
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-patch',
  text: JSON.stringify({
    bridgeEnabled: process.env.PEGAS_APPROVAL_BRIDGE ?? null,
    patches
  }),
  reason: { kind: 'completed' }
}))
`)
    const executor = new DshCliExecutor({
      command,
      approvalPolicy: 'ask',
      approvalBridgePath: '/opt/pegas/dsh-approval-bridge.mjs',
    })
    const result = await executor.execute({
      runId: 'run-patch',
      taskId: 'task-patch',
      prompt: 'do work',
      workingDirectory: process.cwd(),
      actionCapability: {
        baseUrl: 'http://127.0.0.1:4317',
        claimToken: 'claim',
      },
      toolApprovalGrant: {
        actionId: 'action-9',
        tool: 'bash',
        argumentsHash: 'hash-9',
      },
    })
    const captured = JSON.parse(result.output) as {
      bridgeEnabled: string | null
      patches: { insert?: { id: string; name: string; config?: unknown }[] }[][]
    }
    expect(captured.bridgeEnabled).toBe('1')
    const bridge = captured.patches
      .flat()
      .flatMap(patch => patch.insert ?? [])
      .find(entry => entry.id === 'pegas-approval-bridge')
    expect(bridge).toMatchObject({
      name: '/opt/pegas/dsh-approval-bridge.mjs',
      config: {
        grant: { actionId: 'action-9', tool: 'bash', argumentsHash: 'hash-9' },
      },
    })

    const neverExecutor = new DshCliExecutor({ command })
    const neverResult = await neverExecutor.execute({
      runId: 'run-never',
      taskId: 'task-never',
      prompt: 'do work',
      workingDirectory: process.cwd(),
      actionCapability: {
        baseUrl: 'http://127.0.0.1:4317',
        claimToken: 'claim',
      },
    })
    const neverCaptured = JSON.parse(neverResult.output) as {
      bridgeEnabled: string | null
      patches: { insert?: { id: string }[] }[][]
    }
    expect(neverCaptured.bridgeEnabled).toBeNull()
    // M5: a work Run with an action capability now also mounts the
    // read-only history tools; the approval bridge itself stays absent.
    expect(
      neverCaptured.patches
        .flat()
        .flatMap(patch => patch.insert ?? [])
        .filter(entry => entry.id === 'pegas-approval-bridge'),
    ).toEqual([])
  })
})

describe('worker tool approval loop', () => {
  it('settles a parked run as waiting and grants the approved successor exactly once', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store, apiToken: 'loop-test' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const command = fakeDsh(loopDshSource())
    const executor = new DshCliExecutor({ command, approvalPolicy: 'ask' })
    try {
      store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'test',
        payload: { text: '在沙箱外写入文件' },
      })
      await processNextEvent(
        store,
        new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
        'worker-loop',
      )
      const claimed = store.claimNextRun('worker-loop')
      if (!claimed) throw new Error('Expected claimed Run')
      await executeClaimedRun(
        store,
        executor,
        claimed,
        'worker-loop',
        process.cwd(),
        new AbortController().signal,
        baseUrl,
      )
      const approval = store.pageApprovals('owner', 10).items[0]
      if (!approval) throw new Error('Expected parked Approval')
      expect(store.listRuns(claimed.task.id).at(-1)).toMatchObject({
        status: 'waiting',
      })
      expect(store.findTask(claimed.task.id, 'owner')).toMatchObject({
        statusReason: 'awaiting_approval',
      })
      expect(store.claimNextRun('other-worker')).toBeUndefined()

      store.decideApproval(approval.id, 'owner', {
        commandId: 'loop-approve',
        optionId: 'approve',
      })
      const successor = store.claimNextRun('worker-loop-resumed')
      if (!successor) throw new Error('Expected successor Run')
      await executeClaimedRun(
        store,
        executor,
        successor,
        'worker-loop-resumed',
        process.cwd(),
        new AbortController().signal,
        baseUrl,
      )
      expect(store.getAction(approval.actionId, 'owner')).toMatchObject({
        status: 'succeeded',
      })
      expect(store.listRuns(claimed.task.id).at(-1)).toMatchObject({
        status: 'completed',
      })
      const outboxTypes = outboxPayloadTypes(store)
      expect(outboxTypes.filter(type => type === 'run.completed')).toHaveLength(
        1,
      )
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })

  it('does not grant a rejected or foreign approval decision', async () => {
    const store = new PegasStore(':memory:')
    const server = createControlPlane({ store, apiToken: 'loop-test' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const command = fakeDsh(loopDshSource())
    const executor = new DshCliExecutor({ command, approvalPolicy: 'ask' })
    try {
      store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'test',
        payload: { text: '在沙箱外写入文件' },
      })
      await processNextEvent(
        store,
        new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
        'worker-reject',
      )
      const claimed = store.claimNextRun('worker-reject')
      if (!claimed) throw new Error('Expected claimed Run')
      await executeClaimedRun(
        store,
        executor,
        claimed,
        'worker-reject',
        process.cwd(),
        new AbortController().signal,
        baseUrl,
      )
      const approval = store.pageApprovals('owner', 10).items[0]
      if (!approval) throw new Error('Expected parked Approval')
      store.decideApproval(approval.id, 'owner', {
        commandId: 'loop-reject',
        optionId: 'reject',
      })
      const successor = store.claimNextRun('worker-reject-resumed')
      if (!successor) throw new Error('Expected rejection successor Run')
      await executeClaimedRun(
        store,
        executor,
        successor,
        'worker-reject-resumed',
        process.cwd(),
        new AbortController().signal,
        baseUrl,
      )
      expect(store.getAction(approval.actionId, 'owner')).toMatchObject({
        status: 'rejected',
      })
      expect(store.listRuns(claimed.task.id).at(-1)).toMatchObject({
        status: 'completed',
        output: '未获批准，已停止该操作。',
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })
})

function loopDshSource(): string {
  return `
async function main() {
let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
const prompt = input.split('\\n\\n<pegas_execution_contract>')[0]
const baseUrl = process.env.PEGAS_CONTROL_PLANE_URL
const runId = process.env.PEGAS_RUN_ID
const claimToken = process.env.PEGAS_RUN_CLAIM_TOKEN
const headers = {
  'content-type': 'application/json',
  'x-pegas-run-claim-token': claimToken
}
const sessionId = 'session-loop'
console.log(JSON.stringify({ type: 'session', sessionId }))
if (prompt.startsWith('{"type":"approval.decision"')) {
  const context = JSON.parse(prompt)
  if (context.decision !== 'approve') {
    console.log(JSON.stringify({
      type: 'final', sessionId,
      text: '未获批准，已停止该操作。',
      reason: { kind: 'completed' }
    }))
    return
  }
  console.log(JSON.stringify({
    type: 'tool_call', callId: 'call-granted', tool: 'bash'
  }))
  console.log(JSON.stringify({
    type: 'tool_result', callId: 'call-granted', status: 'completed'
  }))
  const response = await fetch(baseUrl + '/v1/actions/' + context.actionId + '/outcomes', {
    method: 'POST', headers,
    body: JSON.stringify({
      commandId: 'loop-outcome:' + context.actionId,
      status: 'succeeded',
      result: { tool: 'bash', callId: 'call-granted' }
    })
  })
  if (!response.ok) throw new Error('outcome failed: ' + response.status)
  console.log(JSON.stringify({
    type: 'final', sessionId,
    text: '已按批准执行一次。',
    reason: { kind: 'completed' }
  }))
  return
}
const response = await fetch(baseUrl + '/v1/runs/' + runId + '/approvals', {
  method: 'POST', headers,
  body: JSON.stringify({ action: {
    kind: 'dsh.tool.bash',
    risk: 'high',
    idempotencyKey: 'loop:' + runId + ':call-1',
    request: {
      tool: 'bash', callId: 'call-1', reason: 'escalate sandbox',
      argumentsHash: 'loop-hash'
    },
    recoveryPoint: { step: 'before_tool_call', callId: 'call-1' },
    approval: {
      summary: '批准 bash 越权执行一次',
      impact: '写入沙箱外',
      recommendedOptionId: 'approve',
      options: [
        { id: 'approve', label: '批准执行一次', kind: 'approve' },
        { id: 'reject', label: '不执行', kind: 'reject' }
      ]
    }
  }})
})
if (!response.ok) throw new Error('approval failed: ' + response.status)
const body = await response.json()
console.log(JSON.stringify({
  type: 'approval_pending',
  callId: 'call-1', tool: 'bash',
  actionId: body.action.id, approvalId: body.approval.id
}))
console.log(JSON.stringify({
  type: 'final', sessionId,
  text: 'The escalated tool call was denied.',
  reason: { kind: 'completed' }
}))
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
`
}

function createClaimedRun(store: PegasStore, userId: string, workerId: string) {
  if (!store.hasRuntimeSettings()) {
    store.initializeRuntimeSettings(runtimeSettingsDefaults(loadConfig({})))
  }
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'test',
    payload: { text: '在沙箱外写入文件' },
  }).event
  const claimedEvent = store.claimNextEvent(`setup-${workerId}`)
  if (claimedEvent?.id !== event.id)
    throw new Error('Expected setup Event claim')
  store.applyRoutingDecision(
    claimedEvent,
    {
      kind: 'create_task',
      title: '沙箱外写入',
      goal: '沙箱外写入',
      input: '在沙箱外写入文件',
      reason: 'test',
    },
    'dsh-headless',
    task =>
      store.resolveWorkerExecutionContext(task.id, userId, {
        executor: 'dsh-headless',
        protocol: 'dsh-headless-v1',
        workspace: process.cwd(),
        permissions: JSON.stringify({
          mode: 'workspace-write',
          approvalPolicy: 'ask',
          additionalDirectories: [],
          privacyMode: 'disabled',
        }),
      }),
  )
  store.completeEvent(event.id, `setup-${workerId}`)
  const claimed = store.claimNextRun(workerId)
  if (!claimed) throw new Error('Expected claimed Run')
  return claimed
}

function restoreEnvironment(previous: NodeJS.ProcessEnv): void {
  const keys = [
    'PEGAS_APPROVAL_BRIDGE',
    'PEGAS_CONTROL_PLANE_URL',
    'PEGAS_RUN_ID',
    'PEGAS_RUN_CLAIM_TOKEN',
    'PEGAS_TOOL_APPROVAL_GRANT',
  ] as const
  for (const key of keys) {
    const value = previous[key]
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
}

function fakeDsh(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-approval-bridge-'))
  temporaryDirectories.push(directory)
  const command = join(directory, 'dsh')
  writeFileSync(command, `#!/usr/bin/env node\n${body}`, { mode: 0o700 })
  chmodSync(command, 0o700)
  return command
}
