import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import { loadConfig } from '../src/core/config.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

interface GateHarness {
  handlers: Map<string, (...args: unknown[]) => unknown>
  events: Record<string, unknown>[]
  ctx: {
    on: (event: string, listener: (...args: unknown[]) => unknown) => void
    tools: {
      guard: (
        guard: (execution: unknown) => { reason: string } | undefined,
      ) => void
    }
  }
}

function gateHarness(): GateHarness {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const events: Record<string, unknown>[] = []
  return {
    handlers,
    events,
    ctx: {
      on: (event, listener) => {
        handlers.set(event, listener)
      },
      tools: {
        guard: () => undefined,
      },
    },
  }
}

async function loadBridge(): Promise<{
  apply: (ctx: unknown, config?: Record<string, unknown>) => void
}> {
  const module: unknown =
    await import('../src/executor/dsh-approval-bridge.mjs')
  return module as {
    apply: (ctx: unknown, config?: Record<string, unknown>) => void
  }
}

function gateRoots() {
  const base = mkdtempSync(join(tmpdir(), 'pegas-rule-bridge-'))
  temporaryDirectories.push(base)
  const roots = {
    workspace: join(base, 'workspace'),
    dataDir: join(base, 'data'),
    shared: join(base, 'shared'),
  }
  for (const directory of Object.values(roots)) {
    mkdirSync(directory, { recursive: true })
  }
  return roots
}

function createClaimedRun(store: PegasStore, workerId: string) {
  if (!store.hasRuntimeSettings()) {
    store.initializeRuntimeSettings(runtimeSettingsDefaults(loadConfig({})))
  }
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'test',
    payload: { text: '整理共享目录' },
  }).event
  const claimedEvent = store.claimNextEvent(`setup-${workerId}`)
  if (!claimedEvent) throw new Error('Expected setup claim')
  store.applyRoutingDecision(
    claimedEvent,
    {
      kind: 'create_task',
      title: '整理共享目录',
      goal: '整理共享目录',
      input: '整理共享目录',
      reason: 'test',
    },
    'dsh-headless',
    task =>
      store.resolveWorkerExecutionContext(task.id, 'owner', {
        executor: 'dsh-headless',
        protocol: 'dsh-headless-v1',
        workspace: '/tmp/ws',
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
  ] as const
  for (const key of keys) {
    const value = previous[key]
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
}

describe('DSH bridge approval rules', () => {
  it('parks with a rule option, allows fingerprint matches after approval, and re-asks after revocation', async () => {
    const roots = gateRoots()
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'worker-rule-bridge')
    const server = createControlPlane({
      store,
      apiToken: 'bridge-test',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const previous = { ...process.env }
    process.env.PEGAS_APPROVAL_BRIDGE = '1'
    process.env.PEGAS_CONTROL_PLANE_URL = baseUrl
    process.env.PEGAS_RUN_ID = claimed.run.id
    process.env.PEGAS_RUN_CLAIM_TOKEN = claimed.claimToken
    try {
      const bridge = await loadBridge()
      const harness = gateHarness()
      bridge.apply(harness.ctx, {
        emit: (event: unknown) =>
          harness.events.push(event as Record<string, unknown>),
        policy: {
          workspaceRoot: roots.workspace,
          protectedRoots: [roots.dataDir],
        },
      })
      const preExecute = harness.handlers.get('tools/pre-execute')
      const approvalRequest = harness.handlers.get('approval/request')
      if (!preExecute || !approvalRequest)
        throw new Error('bridge did not register its hooks')
      const target = join(roots.shared, 'plan.md')
      const writeCall = {
        agent: {},
        callId: 'rule-call-1',
        name: 'write',
        arguments: { file_path: target, content: 'first' },
      }
      const gate = (await preExecute(writeCall, () =>
        Promise.resolve({ kind: 'allow' }),
      )) as { kind: string }
      expect(gate.kind).toBe('ask')
      const seamDecision = await approvalRequest(
        { callId: 'rule-call-1', toolName: 'write' },
        () => Promise.resolve('unavailable'),
      )
      expect(seamDecision).toBe('rejected')
      const pendingEvent = harness.events.find(
        event => event.type === 'approval_pending',
      )
      if (!pendingEvent) throw new Error('Expected approval_pending event')
      const approvalId = pendingEvent.approvalId
      if (typeof approvalId !== 'string')
        throw new Error('Expected approval id')
      const approval = store.getApproval(approvalId, 'owner')
      expect(
        approval?.prompt.options.some(option => option.kind === 'approve_rule'),
      ).toBe(true)

      store.decideApproval(approvalId, 'owner', {
        commandId: 'bridge-rule-decision',
        optionId: 'approve_rule',
      })
      const rule = store.listApprovalRules(claimed.task.id, 'owner')[0]
      if (!rule) throw new Error('Expected created rule')
      const successor = store.claimNextRun('worker-rule-bridge-successor')
      if (!successor) throw new Error('Expected successor claim')
      process.env.PEGAS_RUN_ID = successor.run.id
      process.env.PEGAS_RUN_CLAIM_TOKEN = successor.claimToken

      const secondBridge = await loadBridge()
      const secondHarness = gateHarness()
      secondBridge.apply(secondHarness.ctx, {
        emit: (event: unknown) =>
          secondHarness.events.push(event as Record<string, unknown>),
        policy: {
          workspaceRoot: roots.workspace,
          protectedRoots: [roots.dataDir],
        },
      })
      const secondPreExecute = secondHarness.handlers.get('tools/pre-execute')
      const secondSeam = secondHarness.handlers.get('approval/request')
      if (!secondPreExecute || !secondSeam)
        throw new Error('bridge did not register its hooks')
      const repeatCall = {
        agent: {},
        callId: 'rule-call-2',
        name: 'write',
        arguments: { file_path: target, content: 'rewritten content' },
      }
      const ruleGate = (await secondPreExecute(repeatCall, () =>
        Promise.resolve({ kind: 'allow' }),
      )) as { kind: string }
      expect(ruleGate.kind).toBe('allow')
      expect(secondHarness.events).toContainEqual(
        expect.objectContaining({
          type: 'policy_decision',
          callId: 'rule-call-2',
          decision: 'allow',
          ruleId: rule.id,
        }),
      )
      expect(
        await secondSeam({ callId: 'rule-call-2', toolName: 'write' }, () =>
          Promise.resolve('unavailable'),
        ),
      ).toBe('allowed-once')

      const variantCall = {
        agent: {},
        callId: 'rule-call-3',
        name: 'write',
        arguments: {
          file_path: join(roots.shared, 'other.md'),
          content: 'variant',
        },
      }
      const variantGate = (await secondPreExecute(variantCall, () =>
        Promise.resolve({ kind: 'allow' }),
      )) as { kind: string }
      expect(variantGate.kind).toBe('ask')

      store.revokeApprovalRule(claimed.task.id, rule.id, 'owner', {
        commandId: 'bridge-rule-revoke',
      })
      const afterRevokeCall = {
        agent: {},
        callId: 'rule-call-4',
        name: 'write',
        arguments: { file_path: target, content: 'again' },
      }
      const revokedGate = (await secondPreExecute(afterRevokeCall, () =>
        Promise.resolve({ kind: 'allow' }),
      )) as { kind: string }
      expect(revokedGate.kind).toBe('ask')
    } finally {
      restoreEnvironment(previous)
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  }, 30_000)

  it('never offers or honors rules for control-plane mutations', async () => {
    const roots = gateRoots()
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'worker-rule-control')
    const server = createControlPlane({
      store,
      apiToken: 'bridge-test',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const previous = { ...process.env }
    process.env.PEGAS_APPROVAL_BRIDGE = '1'
    process.env.PEGAS_CONTROL_PLANE_URL = baseUrl
    process.env.PEGAS_RUN_ID = claimed.run.id
    process.env.PEGAS_RUN_CLAIM_TOKEN = claimed.claimToken
    try {
      const bridge = await loadBridge()
      const harness = gateHarness()
      bridge.apply(harness.ctx, {
        emit: (event: unknown) =>
          harness.events.push(event as Record<string, unknown>),
        policy: {
          workspaceRoot: roots.workspace,
          protectedRoots: [roots.dataDir],
        },
      })
      const preExecute = harness.handlers.get('tools/pre-execute')
      const approvalRequest = harness.handlers.get('approval/request')
      if (!preExecute || !approvalRequest)
        throw new Error('bridge did not register its hooks')
      const controlCall = {
        agent: {},
        callId: 'control-call-1',
        name: 'write',
        arguments: {
          file_path: join(roots.dataDir, 'settings.json'),
          content: 'takeover',
        },
      }
      const gate = (await preExecute(controlCall, () =>
        Promise.resolve({ kind: 'allow' }),
      )) as { kind: string }
      expect(gate.kind).toBe('deny')
      expect(
        await approvalRequest(
          { callId: 'control-call-1', toolName: 'write' },
          () => Promise.resolve('unavailable'),
        ),
      ).toBe('rejected')
      const pendingEvent = harness.events.find(
        event => event.type === 'approval_pending',
      )
      const approvalId = pendingEvent?.approvalId
      if (typeof approvalId !== 'string')
        throw new Error('Expected approval id')
      const approval = store.getApproval(approvalId, 'owner')
      expect(
        approval?.prompt.options.some(option => option.kind === 'approve_rule'),
      ).toBe(false)
      expect(() =>
        store.decideApproval(approvalId, 'owner', {
          commandId: 'control-rule-decision',
          optionId: 'approve_rule',
        }),
      ).toThrow()
      expect(store.listApprovalRules(claimed.task.id, 'owner')).toHaveLength(0)
    } finally {
      restoreEnvironment(previous)
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  }, 30_000)
})
