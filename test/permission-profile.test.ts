import { describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'

import { createControlPlane } from '../src/control-plane/server.js'
import {
  combinePermissionTiers,
  permissionTierRank,
  tierSandbox,
  type PermissionTier,
} from '../src/approval/permission-profile.js'
import {
  effectiveWorkerProfile,
  parseWorkerProfileUpdate,
  workerProfileFingerprint,
  type WorkerProfile,
} from '../src/worker/worker-profile.js'
import { loadConfig } from '../src/core/config.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  assertRollbackCompatible,
  RollbackCompatibilityError,
} from '../src/supervisor/rollback-compatibility.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const settings = runtimeSettingsDefaults(loadConfig({}))

function baseProfile(overrides: Partial<WorkerProfile> = {}): WorkerProfile {
  return {
    id: 'worker-profile:task-1',
    taskId: 'task-1',
    revision: 1,
    modelMode: 'inherit',
    createdAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
    ...overrides,
  }
}

function createTask(store: PegasStore, userId = 'owner') {
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'test',
    payload: { text: '整理资料' },
  }).event
  const claimed = store.claimNextEvent('setup-permission')
  if (!claimed) throw new Error('Expected event claim')
  store.applyRoutingDecision(
    claimed,
    {
      kind: 'create_task',
      title: '整理资料',
      goal: '整理资料',
      input: '整理资料',
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
  store.completeEvent(event.id, 'setup-permission')
  return store.listTasks(userId)[0]
}

function createRoutedRun(
  store: PegasStore,
  userId = 'owner',
  decision:
    { kind: 'create_task' } | { kind: 'continue_task'; taskId: string } = {
    kind: 'create_task',
  },
) {
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'test',
    payload: { text: '再整理一次' },
  }).event
  const claimed = store.claimNextEvent('setup-permission-run')
  if (!claimed) throw new Error('Expected event claim')
  store.applyRoutingDecision(
    claimed,
    decision.kind === 'create_task'
      ? {
          kind: 'create_task',
          title: '再整理一次',
          goal: '再整理一次',
          input: '再整理一次',
          reason: 'test',
        }
      : {
          kind: 'continue_task',
          taskId: decision.taskId,
          input: '再整理一次',
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
  store.completeEvent(event.id, 'setup-permission-run')
}

describe('permission tier algebra', () => {
  it('orders strict below standard below full', () => {
    expect(permissionTierRank('strict')).toBeLessThan(
      permissionTierRank('standard'),
    )
    expect(permissionTierRank('standard')).toBeLessThan(
      permissionTierRank('full'),
    )
  })

  it('maps tiers onto sandbox modes with ask policy', () => {
    expect(tierSandbox('strict')).toEqual({
      mode: 'read-only',
      approvalPolicy: 'ask',
    })
    expect(tierSandbox('standard')).toEqual({
      mode: 'workspace-write',
      approvalPolicy: 'ask',
    })
    expect(tierSandbox('full')).toEqual({
      mode: 'danger-full-access',
      approvalPolicy: 'ask',
    })
  })

  it('combines a live tier with the run snapshot lower bound', () => {
    expect(
      combinePermissionTiers({
        snapshotTier: 'standard',
        liveTier: 'strict',
      }),
    ).toMatchObject({ tier: 'strict', clamped: false, mismatch: false })
    expect(
      combinePermissionTiers({
        snapshotTier: 'standard',
        liveTier: 'full',
      }),
    ).toMatchObject({ tier: 'standard', clamped: true, mismatch: false })
    expect(
      combinePermissionTiers({
        snapshotTier: 'full',
        liveTier: 'strict',
      }),
    ).toMatchObject({ tier: 'strict', clamped: false })
  })

  it('fails closed to strict on generation mismatch or missing facts', () => {
    expect(
      combinePermissionTiers({
        snapshotTier: 'full',
        liveTier: 'full',
        mismatch: true,
      }),
    ).toMatchObject({ tier: 'strict', mismatch: true })
    expect(combinePermissionTiers({})).toMatchObject({
      tier: 'strict',
      mismatch: true,
    })
    expect(
      combinePermissionTiers({ snapshotTier: undefined, liveTier: 'full' }),
    ).toMatchObject({ tier: 'strict', mismatch: true })
  })
})

describe('worker profile permission tier field', () => {
  it('parses inherit and explicit tiers and rejects unknown values', () => {
    const inherit = parseWorkerProfileUpdate({
      commandId: 'tier-inherit',
      expectedRevision: 1,
      modelMode: 'inherit',
      permissionMode: 'inherit',
    })
    expect(inherit.permissionMode).toBe('inherit')
    for (const tier of ['strict', 'standard', 'full'] as const) {
      const update = parseWorkerProfileUpdate({
        commandId: `tier-${tier}`,
        expectedRevision: 1,
        modelMode: 'inherit',
        permissionMode: tier,
      })
      expect(update.permissionMode).toBe(tier)
    }
    expect(() =>
      parseWorkerProfileUpdate({
        commandId: 'tier-bad',
        expectedRevision: 1,
        modelMode: 'inherit',
        permissionMode: 'yolo',
      }),
    ).toThrow()
    const absent = parseWorkerProfileUpdate({
      commandId: 'tier-absent',
      expectedRevision: 1,
      modelMode: 'inherit',
    })
    expect(absent.permissionMode).toBeUndefined()
  })

  it('keeps command fingerprints distinct across permission tiers', () => {
    const base = {
      expectedRevision: 1,
      modelMode: 'inherit' as const,
    }
    const first = workerProfileFingerprint({
      ...base,
      permissionMode: 'strict',
    })
    const second = workerProfileFingerprint({
      ...base,
      permissionMode: 'full',
    })
    expect(first).not.toBe(second)
  })

  it('resolves the effective tier from task override or global default', () => {
    const inherited = effectiveWorkerProfile(baseProfile(), {
      ...settings,
      permissionTier: 'strict',
    })
    expect(inherited.permissionTier).toBe('strict')
    expect(inherited.permissionSource).toBe('global')
    const overridden = effectiveWorkerProfile(
      baseProfile({ permissionMode: 'full' }),
      { ...settings, permissionTier: 'strict' },
    )
    expect(overridden.permissionTier).toBe('full')
    expect(overridden.permissionSource).toBe('task')
    const defaulted = effectiveWorkerProfile(baseProfile(), settings)
    expect(defaulted.permissionTier).toBe('standard')
    expect(defaulted.permissionSource).toBe('global')
  })
})

describe('permission tier persistence', () => {
  it('defaults global tier to standard and updates it with settings', () => {
    const store = new PegasStore(':memory:')
    try {
      const initialized = store.initializeRuntimeSettings(settings)
      expect(initialized.permissionTier).toBe('standard')
      const updated = store.updateRuntimeSettings(initialized.revision, {
        ...settings,
        permissionTier: 'strict',
      })
      expect(updated.permissionTier).toBe('strict')
      expect(store.getRuntimeSettings().permissionTier).toBe('strict')
    } finally {
      store.close()
    }
  })

  it('persists a task tier override with revision bump and command replay', () => {
    const store = new PegasStore(':memory:')
    try {
      store.initializeRuntimeSettings(settings)
      const task = createTask(store)
      if (!task) throw new Error('Expected task')
      const before = store.getWorkerProfile(task.id, 'owner')
      expect(before.permissionMode).toBeUndefined()
      const update = {
        commandId: 'tier-command-1',
        expectedRevision: before.revision,
        modelMode: 'inherit' as const,
        permissionMode: 'strict' as const,
      }
      const updated = store.updateWorkerProfile(task.id, 'owner', update)
      expect(updated.permissionMode).toBe('strict')
      expect(updated.revision).toBe(before.revision + 1)
      const replay = store.updateWorkerProfile(task.id, 'owner', update)
      expect(replay).toEqual(updated)
      expect(() =>
        store.updateWorkerProfile(task.id, 'owner', {
          ...update,
          permissionMode: 'full',
        }),
      ).toThrow()
      expect(() =>
        store.updateWorkerProfile(task.id, 'intruder', update),
      ).toThrow()
      const audit = store.listWorkerProfileChanges(task.id, 'owner')
      expect(audit.length).toBeGreaterThan(0)
      expect(audit[0]).toMatchObject({
        permissionMode: 'strict',
        commandId: 'tier-command-1',
      })
      const timelineFacts = store
        .listOutbox('owner', task.id)
        .filter(message => {
          const payload = message.payload as { type?: string }
          return payload.type === 'task.permission_changed'
        })
      expect(timelineFacts).toHaveLength(1)
      expect(timelineFacts[0]?.payload).toMatchObject({
        permissionMode: 'strict',
        previousPermissionMode: 'inherit',
      })
    } finally {
      store.close()
    }
  })

  it('freezes the effective tier into the run execution snapshot', () => {
    const store = new PegasStore(':memory:')
    try {
      store.initializeRuntimeSettings({
        ...settings,
        permissionTier: 'strict',
      })
      const task = createTask(store)
      if (!task) throw new Error('Expected task')
      const context = store.resolveWorkerExecutionContext(task.id, 'owner', {
        executor: 'dsh-headless',
        protocol: 'dsh-headless-v1',
        workspace: '/tmp/ws',
        permissions: JSON.stringify({
          mode: 'read-only',
          approvalPolicy: 'ask',
          additionalDirectories: [],
          privacyMode: 'disabled',
        }),
      })
      expect(context.permissionTier).toBe('strict')
    } finally {
      store.close()
    }
  })
})

describe('run permission projection (claim read API)', () => {
  it('returns the live tier with generation and clamps widening to the snapshot bound', () => {
    const store = new PegasStore(':memory:')
    try {
      store.initializeRuntimeSettings(settings)
      const task = createTask(store)
      if (!task) throw new Error('Expected task')
      const profile = store.getWorkerProfile(task.id, 'owner')
      store.updateWorkerProfile(task.id, 'owner', {
        commandId: 'projection-full',
        expectedRevision: profile.revision,
        modelMode: 'inherit',
        permissionMode: 'full',
      })
      const firstClaim = store.claimNextRun('worker-projection-setup')
      if (!firstClaim) throw new Error('Expected first claimed run')
      store.completeRun(firstClaim.run.id, 'worker-projection-setup', {
        executorRef: 'session-setup',
        output: 'done',
      })
      createRoutedRun(store, 'owner', {
        kind: 'continue_task',
        taskId: task.id,
      })
      const claimed = store.claimNextRun('worker-projection')
      if (!claimed) throw new Error('Expected claimed run')
      expect(claimed.run.executionContext.permissionTier).toBe('full')
      const projection = store.runPermissionProjection(
        claimed.run.id,
        claimed.claimToken,
      )
      expect(projection).toMatchObject({
        snapshotTier: 'full',
        liveTier: 'full',
        effectiveTier: 'full',
        mismatch: false,
      })
      expect(typeof projection.generation).toBe('string')

      const current = store.getWorkerProfile(task.id, 'owner')
      store.updateWorkerProfile(task.id, 'owner', {
        commandId: 'projection-strict',
        expectedRevision: current.revision,
        modelMode: 'inherit',
        permissionMode: 'strict',
      })
      const tightened = store.runPermissionProjection(
        claimed.run.id,
        claimed.claimToken,
      )
      expect(tightened).toMatchObject({
        snapshotTier: 'full',
        liveTier: 'strict',
        effectiveTier: 'strict',
        mismatch: false,
      })
      expect(tightened.generation).not.toBe(projection.generation)
    } finally {
      store.close()
    }
  })

  it('clamps a widened live tier to the snapshot lower bound', () => {
    const store = new PegasStore(':memory:')
    try {
      store.initializeRuntimeSettings(settings)
      const task = createTask(store)
      if (!task) throw new Error('Expected task')
      createRoutedRun(store)
      const claimed = store.claimNextRun('worker-clamp')
      if (!claimed) throw new Error('Expected claimed run')
      expect(claimed.run.executionContext.permissionTier).toBe('standard')
      const profile = store.getWorkerProfile(task.id, 'owner')
      store.updateWorkerProfile(task.id, 'owner', {
        commandId: 'clamp-full',
        expectedRevision: profile.revision,
        modelMode: 'inherit',
        permissionMode: 'full',
      })
      const projection = store.runPermissionProjection(
        claimed.run.id,
        claimed.claimToken,
      )
      expect(projection).toMatchObject({
        snapshotTier: 'standard',
        liveTier: 'full',
        effectiveTier: 'standard',
        clamped: true,
        mismatch: false,
      })
    } finally {
      store.close()
    }
  })

  it('rejects invalid claims and reports mismatch for legacy snapshots', () => {
    const store = new PegasStore(':memory:')
    try {
      store.initializeRuntimeSettings(settings)
      createTask(store)
      const claimed = store.claimNextRun('worker-legacy')
      if (!claimed) throw new Error('Expected claimed run')
      expect(() =>
        store.runPermissionProjection(claimed.run.id, 'wrong-token'),
      ).toThrow()
      store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'test',
        payload: { text: '另一件事' },
      })
      const second = store.claimNextEvent('setup-legacy-2')
      if (!second) throw new Error('Expected second claim')
      store.applyRoutingDecision(
        second,
        {
          kind: 'create_task',
          title: '旧快照',
          goal: '旧快照',
          input: '旧快照',
          reason: 'test',
        },
        'dsh-headless',
        { executor: 'dsh-headless', protocol: 'dsh-headless-v1' },
      )
      store.completeEvent(second.id, 'setup-legacy-2')
      const legacy = store.claimNextRun('worker-legacy-2')
      if (!legacy) throw new Error('Expected legacy claimed run')
      expect(legacy.run.executionContext.permissionTier).toBeUndefined()
      const projection = store.runPermissionProjection(
        legacy.run.id,
        legacy.claimToken,
      )
      expect(projection.mismatch).toBe(true)
      expect(projection.effectiveTier).toBe('strict')
    } finally {
      store.close()
    }
  })
})

describe('permission tier rollback guard', () => {
  it('blocks rollback below the tier schema while non-default tiers exist', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-tier-rollback-'))
    const path = join(directory, 'pegas.sqlite')
    const store = new PegasStore(path)
    try {
      store.initializeRuntimeSettings(settings)
      expect(() => assertRollbackCompatible(path, 39)).not.toThrow()
      const current = store.getRuntimeSettings()
      store.updateRuntimeSettings(current.revision, {
        ...settings,
        permissionTier: 'full',
      })
      expect(() => assertRollbackCompatible(path, 39)).toThrow(
        RollbackCompatibilityError,
      )
      const latest = store.getRuntimeSettings()
      store.updateRuntimeSettings(latest.revision, {
        ...settings,
        permissionTier: 'standard',
      })
      const task = createTask(store)
      if (!task) throw new Error('Expected task')
      const profile = store.getWorkerProfile(task.id, 'owner')
      store.updateWorkerProfile(task.id, 'owner', {
        commandId: 'rollback-tier',
        expectedRevision: profile.revision,
        modelMode: 'inherit',
        permissionMode: 'strict',
      })
      expect(() => assertRollbackCompatible(path, 39)).toThrow(
        RollbackCompatibilityError,
      )
      const after = store.getWorkerProfile(task.id, 'owner')
      store.updateWorkerProfile(task.id, 'owner', {
        commandId: 'rollback-tier-reset',
        expectedRevision: after.revision,
        modelMode: 'inherit',
        permissionMode: 'inherit',
      })
      expect(() => assertRollbackCompatible(path, 39)).not.toThrow()
      expect(() => assertRollbackCompatible(path, 40)).not.toThrow()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('tier sandbox wiring', () => {
  it('derives executor sandbox options from the snapshot tier', async () => {
    const { dshExecutorOptionsFromSnapshot } =
      await import('../src/worker/run-execution-snapshot.js')
    const snapshot = {
      executorProfile: 'headless',
      workspace: '/tmp/ws',
      permissionMode: 'workspace-write',
      approvalPolicy: 'ask' as const,
      additionalDirectories: [],
      privacyMode: 'disabled' as const,
      permissionTier: 'strict' as PermissionTier,
    }
    const options = dshExecutorOptionsFromSnapshot(snapshot, {})
    expect(options.permissionMode).toBe('read-only')
    expect(options.approvalPolicy).toBe('ask')
    const full = dshExecutorOptionsFromSnapshot(
      { ...snapshot, permissionTier: 'full' },
      {},
    )
    expect(full.permissionMode).toBe('danger-full-access')
    const legacy = dshExecutorOptionsFromSnapshot(
      { ...snapshot, permissionTier: undefined },
      {},
    )
    expect(legacy.permissionMode).toBe('workspace-write')
  })
})

describe('permission tier HTTP surface', () => {
  it('serves the claim-authenticated permission projection and tier switching', async () => {
    const store = new PegasStore(':memory:')
    store.initializeRuntimeSettings(settings)
    const task = createTask(store)
    if (!task) throw new Error('Expected task')
    const claimed = store.claimNextRun('worker-http')
    if (!claimed) throw new Error('Expected claimed run')
    const server = createControlPlane({
      store,
      apiToken: 'bridge-test',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    try {
      const projectionUrl = `${base}/v1/runs/${encodeURIComponent(claimed.run.id)}/permissions`
      const unauthenticated = await fetch(projectionUrl)
      expect(unauthenticated.status).toBe(403)
      const wrongClaim = await fetch(projectionUrl, {
        headers: { 'x-pegas-run-claim-token': 'wrong' },
      })
      expect(wrongClaim.status).toBe(403)
      const projection = await fetch(projectionUrl, {
        headers: { 'x-pegas-run-claim-token': claimed.claimToken },
      })
      expect(projection.status).toBe(200)
      expect(await projection.json()).toMatchObject({
        snapshotTier: 'standard',
        liveTier: 'standard',
        effectiveTier: 'standard',
        mismatch: false,
      })

      const profileUrl = `${base}/v1/tasks/${encodeURIComponent(task.id)}/worker-profile`
      const switchResponse = await fetch(profileUrl, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer bridge-test',
        },
        body: JSON.stringify({
          userId: 'owner',
          commandId: 'http-tier-strict',
          expectedRevision: 1,
          modelMode: 'inherit',
          permissionMode: 'strict',
        }),
      })
      expect(switchResponse.status).toBe(200)
      expect(await switchResponse.json()).toMatchObject({
        profile: { permissionMode: 'strict', revision: 2 },
        effective: { permissionTier: 'strict', permissionSource: 'task' },
      })
      const tightened = await fetch(projectionUrl, {
        headers: { 'x-pegas-run-claim-token': claimed.claimToken },
      })
      expect(await tightened.json()).toMatchObject({
        snapshotTier: 'standard',
        liveTier: 'strict',
        effectiveTier: 'strict',
      })
      const invalid = await fetch(profileUrl, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer bridge-test',
        },
        body: JSON.stringify({
          userId: 'owner',
          commandId: 'http-tier-bad',
          expectedRevision: 2,
          modelMode: 'inherit',
          permissionMode: 'yolo',
        }),
      })
      expect(invalid.status).toBe(400)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })
})
