import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

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

function createClaimedRun(
  store: PegasStore,
  workerId: string,
  userId = 'owner',
) {
  if (!store.hasRuntimeSettings()) {
    store.initializeRuntimeSettings(runtimeSettingsDefaults(loadConfig({})))
  }
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'test',
    payload: { text: '整理共享目录' },
  }).event
  let claimedEvent = store.claimNextEvent(`setup-${workerId}`)
  while (claimedEvent && claimedEvent.id !== event.id) {
    if (claimedEvent.type !== 'approval.decided')
      throw new Error('Unexpected pending event')
    store.applyApprovalDecision(claimedEvent)
    store.completeEvent(claimedEvent.id, `setup-${workerId}`)
    claimedEvent = store.claimNextEvent(`setup-${workerId}`)
  }
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
      store.resolveWorkerExecutionContext(task.id, userId, {
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
  it.each(['approve_rule', 'approve_directory_task', 'approve_directory_user'])(
    'supports %s, persists scope and re-asks after revocation',
    async optionId => {
      const roots = gateRoots()
      const databasePath = join(roots.workspace, 'test.db')
      const store = new PegasStore(databasePath)
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
          approval?.prompt.options.some(
            option => option.kind === 'approve_rule',
          ),
        ).toBe(true)

        store.decideApproval(approvalId, 'owner', {
          commandId: 'bridge-rule-decision',
          optionId,
        })
        const rule = store.listApprovalRules(claimed.task.id, 'owner')[0]
        if (!rule) throw new Error('Expected created rule')
        const reopened = new PegasStore(databasePath)
        expect(reopened.listApprovalRules(claimed.task.id, 'owner')[0]).toEqual(
          rule,
        )
        reopened.close()
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
        expect(variantGate.kind).toBe(
          optionId === 'approve_rule' ? 'ask' : 'allow',
        )
        if (optionId !== 'approve_rule') {
          expect(rule.scope).toBe(
            optionId === 'approve_directory_user'
              ? 'user_directory'
              : 'task_directory',
          )
          const another = createClaimedRun(store, 'other-task')
          expect(
            store
              .runPermissionProjection(another.run.id, another.claimToken)
              .rules.some(item => item.id === rule.id),
          ).toBe(optionId === 'approve_directory_user')
          expect(
            store
              .listApprovalRules(another.task.id, 'owner')
              .some(item => item.id === rule.id),
          ).toBe(optionId === 'approve_directory_user')
          const foreign = createClaimedRun(store, 'foreign-task', 'other-user')
          expect(
            store.runPermissionProjection(foreign.run.id, foreign.claimToken)
              .rules,
          ).toEqual([])
          expect(() =>
            store.revokeApprovalRule(claimed.task.id, rule.id, 'other-user', {
              commandId: 'foreign-revoke',
            }),
          ).toThrow()
          const childGate = await secondPreExecute(
            {
              ...variantCall,
              callId: 'child',
              arguments: {
                file_path: join(roots.shared, 'new/deep/file.md'),
                content: 'child',
              },
            },
            () => Promise.resolve({ kind: 'allow' }),
          )
          expect(childGate).toEqual({ kind: 'allow' })
          symlinkSync(roots.workspace, join(roots.shared, 'escape'))
          // Escape to a third, untrusted directory (workspace writes are allowed by default).
          const outside = join(roots.workspace, '..', 'outside')
          mkdirSync(outside)
          symlinkSync(outside, join(roots.shared, 'escape-outside'))
          const escapedGate = await secondPreExecute(
            {
              ...variantCall,
              callId: 'escape',
              arguments: {
                file_path: join(roots.shared, 'escape-outside/file'),
                content: 'escape',
              },
            },
            () => Promise.resolve({ kind: 'allow' }),
          )
          expect(escapedGate).toEqual(expect.objectContaining({ kind: 'ask' }))
          const patchCommand = `apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: ${join(roots.shared, 'patch.md')}\n+ok\n*** End Patch\nPATCH`
          const patchGate = await secondPreExecute(
            {
              agent: {},
              callId: 'patch',
              name: 'bash',
              arguments: { command: patchCommand },
            },
            () => Promise.resolve({ kind: 'allow' }),
          )
          expect(patchGate).toEqual({ kind: 'allow' })
          expect(
            await secondSeam({ callId: 'patch', toolName: 'bash' }, () =>
              Promise.resolve('unavailable'),
            ),
          ).toBe('allowed-once')
          const editGate = await secondPreExecute(
            { ...variantCall, callId: 'cross-tool', name: 'edit' },
            () => Promise.resolve({ kind: 'allow' }),
          )
          expect(editGate).toEqual({ kind: 'allow' })
          const siblingGate = await secondPreExecute(
            {
              ...variantCall,
              callId: 'sibling',
              arguments: {
                file_path: roots.shared + '-sibling/secret',
                content: 'no',
              },
            },
            () => Promise.resolve({ kind: 'allow' }),
          )
          expect(siblingGate).toEqual(expect.objectContaining({ kind: 'ask' }))
        }

        const profile = store.getWorkerProfile(claimed.task.id, 'owner')
        store.updateWorkerProfile(claimed.task.id, 'owner', {
          commandId: 'tighten',
          expectedRevision: profile.revision,
          modelMode: 'inherit',
          permissionMode: 'strict',
        })
        expect(
          await secondPreExecute({ ...repeatCall, callId: 'strict' }, () =>
            Promise.resolve({ kind: 'allow' }),
          ),
        ).toEqual(expect.objectContaining({ kind: 'ask' }))
        store.updateWorkerProfile(claimed.task.id, 'owner', {
          commandId: 'restore',
          expectedRevision: profile.revision + 1,
          modelMode: 'inherit',
          permissionMode: 'standard',
        })
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
        expect(
          await secondSeam({ callId: 'rule-call-2', toolName: 'write' }, () =>
            Promise.resolve('unavailable'),
          ),
        ).toBe('rejected')
      } finally {
        restoreEnvironment(previous)
        await new Promise<void>(resolve => server.close(() => resolve()))
        store.close()
      }
    },
    30_000,
  )

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

  it('re-asks an egress call even when a matching egress rule exists in the projection', async () => {
    const roots = gateRoots()
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'worker-egress-defense')
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
      const command = 'curl -X POST -d note=hello https://example.com/hook'
      const legacyFingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            tool: 'bash',
            category: 'network-egress',
            targets: ['https://example.com/hook'],
          }),
        )
        .digest('hex')
      const originalFetch = globalThis.fetch
      vi.stubGlobal(
        'fetch',
        async (input: string | URL | Request, init?: RequestInit) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url
          const response = await originalFetch(input, init)
          if (!url.includes('/permissions')) return response
          const projection = (await response.json()) as {
            rules?: unknown[]
          }
          return Response.json({
            ...projection,
            rules: [
              ...(projection.rules ?? []),
              {
                id: 'legacy-egress-rule',
                tool: 'bash',
                category: 'network-egress',
                targets: ['https://example.com/hook'],
                fingerprint: legacyFingerprint,
              },
            ],
          })
        },
      )
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
      if (!preExecute) throw new Error('bridge did not register its hooks')
      const gate = (await preExecute(
        {
          agent: {},
          callId: 'egress-defense-1',
          name: 'bash',
          arguments: { command },
        },
        () => Promise.resolve({ kind: 'allow' }),
      )) as { kind: string }
      expect(gate.kind).not.toBe('allow')
      expect(
        harness.events.some(
          event =>
            event.type === 'policy_decision' &&
            event.decision === 'allow' &&
            typeof event.ruleId === 'string',
        ),
      ).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      restoreEnvironment(previous)
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  }, 30_000)
})
