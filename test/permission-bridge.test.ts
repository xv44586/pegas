import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

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
  guards: ((execution: unknown) => { reason: string } | undefined)[]
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
  const guards: ((execution: unknown) => { reason: string } | undefined)[] = []
  const events: Record<string, unknown>[] = []
  return {
    handlers,
    guards,
    events,
    ctx: {
      on: (event, listener) => {
        handlers.set(event, listener)
      },
      tools: {
        guard: guard => {
          guards.push(guard)
        },
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
  const base = mkdtempSync(join(tmpdir(), 'pegas-permission-bridge-'))
  temporaryDirectories.push(base)
  const roots = {
    workspace: join(base, 'workspace'),
    dataDir: join(base, 'data'),
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
    payload: { text: '整理工作区' },
  }).event
  const claimedEvent = store.claimNextEvent(`setup-${workerId}`)
  if (!claimedEvent) throw new Error('Expected setup claim')
  store.applyRoutingDecision(
    claimedEvent,
    {
      kind: 'create_task',
      title: '整理工作区',
      goal: '整理工作区',
      input: '整理工作区',
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

describe('DSH bridge live permission tier', () => {
  it('tightens to strict on the next call and fails closed when the tier read fails', async () => {
    const roots = gateRoots()
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'worker-live-tier')
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
      const insideWrite = {
        agent: {},
        callId: 'call-inside',
        name: 'write',
        arguments: {
          file_path: join(roots.workspace, 'notes.md'),
          content: 'hello',
        },
      }
      const standardGate = await preExecute(insideWrite, () =>
        Promise.resolve({ kind: 'allow' }),
      )
      expect(standardGate).toMatchObject({ kind: 'allow' })
      expect(harness.events).toContainEqual(
        expect.objectContaining({
          type: 'policy_decision',
          callId: 'call-inside',
          decision: 'allow',
          tier: 'standard',
        }),
      )

      const profile = store.getWorkerProfile(claimed.task.id, 'owner')
      store.updateWorkerProfile(claimed.task.id, 'owner', {
        commandId: 'live-tier-strict',
        expectedRevision: profile.revision,
        modelMode: 'inherit',
        permissionMode: 'strict',
      })
      const nextWrite = {
        agent: {},
        callId: 'call-after-tighten',
        name: 'write',
        arguments: {
          file_path: join(roots.workspace, 'later.md'),
          content: 'hello',
        },
      }
      const strictGate = (await preExecute(nextWrite, () =>
        Promise.resolve({ kind: 'allow' }),
      )) as { kind: string; reason?: string }
      expect(strictGate.kind).toBe('ask')
      expect(strictGate.reason).toContain('严格')
      expect(harness.events).toContainEqual(
        expect.objectContaining({
          type: 'policy_decision',
          callId: 'call-after-tighten',
          decision: 'ask',
          tier: 'strict',
        }),
      )

      await new Promise<void>(resolve => server.close(() => resolve()))
      const unreachableWrite = {
        agent: {},
        callId: 'call-unreachable',
        name: 'write',
        arguments: {
          file_path: join(roots.workspace, 'offline.md'),
          content: 'hello',
        },
      }
      const failClosedGate = (await preExecute(unreachableWrite, () =>
        Promise.resolve({ kind: 'allow' }),
      )) as { kind: string }
      expect(failClosedGate.kind).toBe('ask')
      expect(harness.events).toContainEqual(
        expect.objectContaining({
          type: 'policy_decision',
          callId: 'call-unreachable',
          decision: 'ask',
          tier: 'strict',
          mismatch: true,
        }),
      )
    } finally {
      restoreEnvironment(previous)
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  }, 30_000)

  it('asks for network fetch under strict and keeps control-plane deny in every tier', async () => {
    const roots = gateRoots()
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'worker-strict-web')
    const profile = store.getWorkerProfile(claimed.task.id, 'owner')
    store.updateWorkerProfile(claimed.task.id, 'owner', {
      commandId: 'strict-web-tier',
      expectedRevision: profile.revision,
      modelMode: 'inherit',
      permissionMode: 'strict',
    })
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
      const fetchGate = (await preExecute(
        {
          agent: {},
          callId: 'call-fetch',
          name: 'web_fetch',
          arguments: { url: 'https://example.com' },
        },
        () => Promise.resolve({ kind: 'allow' }),
      )) as { kind: string }
      expect(fetchGate.kind).toBe('ask')
      const controlGate = (await preExecute(
        {
          agent: {},
          callId: 'call-control',
          name: 'write',
          arguments: {
            file_path: join(roots.dataDir, 'settings.json'),
            content: 'x',
          },
        },
        () => Promise.resolve({ kind: 'allow' }),
      )) as { kind: string }
      expect(controlGate.kind).toBe('deny')
    } finally {
      restoreEnvironment(previous)
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })
})
