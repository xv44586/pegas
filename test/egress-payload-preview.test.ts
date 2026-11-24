import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  const base = mkdtempSync(join(tmpdir(), 'pegas-egress-preview-'))
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
    authenticatedActor: 'human',
    payload: { text: '把结果发送到示例接口' },
  }).event
  const claimedEvent = store.claimNextEvent(`setup-${workerId}`)
  if (!claimedEvent) throw new Error('Expected setup claim')
  store.applyRoutingDecision(
    claimedEvent,
    {
      kind: 'create_task',
      title: '把结果发送到示例接口',
      goal: '把结果发送到示例接口',
      input: '把结果发送到示例接口',
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

interface EgressRun {
  harness: GateHarness
  store: PegasStore
  roots: ReturnType<typeof gateRoots>
  close: () => Promise<void>
}

async function startEgressRun(workerId: string): Promise<EgressRun> {
  const roots = gateRoots()
  const store = new PegasStore(':memory:')
  const claimed = createClaimedRun(store, workerId)
  const server = createControlPlane({ store, apiToken: 'bridge-test' })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  process.env.PEGAS_APPROVAL_BRIDGE = '1'
  process.env.PEGAS_CONTROL_PLANE_URL = baseUrl
  process.env.PEGAS_RUN_ID = claimed.run.id
  process.env.PEGAS_RUN_CLAIM_TOKEN = claimed.claimToken
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
  return {
    harness,
    store,
    roots,
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    },
  }
}

async function parkEgressCall(
  run: EgressRun,
  callId: string,
  command: string,
): Promise<Record<string, unknown>> {
  const preExecute = run.harness.handlers.get('tools/pre-execute')
  const seam = run.harness.handlers.get('approval/request')
  if (!preExecute || !seam) throw new Error('bridge hooks missing')
  await preExecute(
    {
      agent: {},
      callId,
      name: 'bash',
      arguments: { command },
    },
    () => Promise.resolve({ kind: 'allow' }),
  )
  await seam({ callId, toolName: 'bash' }, () => Promise.resolve('unavailable'))
  const pendingEvent = run.harness.events.find(
    event => event.type === 'approval_pending' && event.callId === callId,
  )
  const actionId = pendingEvent?.actionId
  if (typeof actionId !== 'string') {
    throw new Error('Expected parked egress action')
  }
  const action = run.store.getAction(actionId, 'owner')
  if (!action) throw new Error('Expected action')
  return action.request
}

interface PayloadPreview {
  items: {
    path: string
    content?: string
    truncated?: boolean
    error?: string
  }[]
  omitted?: boolean
}

function previewOf(request: Record<string, unknown>): PayloadPreview {
  const preview = request.egressPayload
  if (typeof preview !== 'object' || preview === null) {
    throw new Error('Expected egressPayload preview on the action request')
  }
  return preview as unknown as PayloadPreview
}

describe('outbound egress payload preview', () => {
  it('previews the referenced file bytes for curl --data @file', async () => {
    const previous = { ...process.env }
    const run = await startEgressRun('worker-egress-file')
    try {
      const payloadPath = join(run.roots.workspace, 'payload.json')
      writeFileSync(payloadPath, '{"secret":"actual-file-content"}')
      const request = await parkEgressCall(
        run,
        'egress-file-1',
        `curl -X POST --data @${payloadPath} https://example.com/hook`,
      )
      const preview = previewOf(request)
      expect(preview.items).toHaveLength(1)
      expect(preview.items[0]?.path).toBe(payloadPath)
      expect(preview.items[0]?.content).toBe('{"secret":"actual-file-content"}')
      expect(preview.items[0]?.error).toBeUndefined()
    } finally {
      restoreEnvironment(previous)
      await run.close()
    }
  }, 30_000)

  it('previews inline curl data without touching the filesystem', async () => {
    const previous = { ...process.env }
    const run = await startEgressRun('worker-egress-inline')
    try {
      const request = await parkEgressCall(
        run,
        'egress-inline-1',
        'curl -X POST -d note=hello https://example.com/hook',
      )
      const preview = previewOf(request)
      expect(preview.items).toHaveLength(1)
      expect(preview.items[0]?.content).toBe('note=hello')
      expect(preview.items[0]?.path).toBe('')
    } finally {
      restoreEnvironment(previous)
      await run.close()
    }
  }, 30_000)

  it('reports unreadable payload files honestly instead of guessing', async () => {
    const previous = { ...process.env }
    const run = await startEgressRun('worker-egress-missing')
    try {
      const missing = join(run.roots.workspace, 'missing.json')
      const request = await parkEgressCall(
        run,
        'egress-missing-1',
        `curl -X POST --data @${missing} https://example.com/hook`,
      )
      const preview = previewOf(request)
      expect(preview.items).toHaveLength(1)
      expect(preview.items[0]?.path).toBe(missing)
      expect(preview.items[0]?.content).toBeUndefined()
      expect(preview.items[0]?.error).toBeTruthy()
    } finally {
      restoreEnvironment(previous)
      await run.close()
    }
  }, 30_000)

  it('bounds oversized payload previews and marks truncation', async () => {
    const previous = { ...process.env }
    const run = await startEgressRun('worker-egress-large')
    try {
      const payloadPath = join(run.roots.workspace, 'large.txt')
      writeFileSync(payloadPath, 'x'.repeat(20_000))
      const request = await parkEgressCall(
        run,
        'egress-large-1',
        `curl -X POST --data-binary @${payloadPath} https://example.com/hook`,
      )
      const preview = previewOf(request)
      expect(preview.items).toHaveLength(1)
      expect(preview.items[0]?.truncated).toBe(true)
      expect(preview.items[0]?.content?.length).toBeLessThanOrEqual(4096)
    } finally {
      restoreEnvironment(previous)
      await run.close()
    }
  }, 30_000)

  it('never reads control-plane payload files and says so', async () => {
    const previous = { ...process.env }
    const run = await startEgressRun('worker-egress-protected')
    try {
      const protectedPath = join(run.roots.dataDir, 'secret.txt')
      writeFileSync(protectedPath, 'control-plane-secret')
      const request = await parkEgressCall(
        run,
        'egress-protected-1',
        `curl -X POST --data @${protectedPath} https://example.com/hook`,
      )
      const preview = previewOf(request)
      expect(preview.items).toHaveLength(1)
      expect(preview.items[0]?.content).toBeUndefined()
      expect(preview.items[0]?.error).toBeTruthy()
      expect(JSON.stringify(preview)).not.toContain('control-plane-secret')
    } finally {
      restoreEnvironment(previous)
      await run.close()
    }
  }, 30_000)
})
