import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import { loadConfig } from '../src/core/config.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import { assertRollbackCompatible } from '../src/supervisor/rollback-compatibility.js'

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected fixture value')
  return value
}

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
  it.each(["rg 'git fetch' docs", 'git log --grep=fetch -1'])(
    'keeps query %s out of command approvals',
    async command => {
      const bridge = await loadBridge(),
        harness = gateHarness(),
        roots = gateRoots()
      bridge.apply(harness.ctx, {
        policy: { workspaceRoot: roots.workspace },
        emit: (event: unknown) =>
          harness.events.push(event as Record<string, unknown>),
      })
      const result = await required(harness.handlers.get('tools/pre-execute'))(
        { callId: 'read', name: 'bash', arguments: { command } },
        () => Promise.resolve({ kind: 'allow' }),
      )
      expect(result).toEqual({ kind: 'allow' })
    },
  )
  it.each([
    'git -C. fetch origin main',
    'git --no-pager fetch origin main',
    'git -cfoo=bar fetch origin main',
    "git -C '/tmp/repo  name' fetch origin main",
    'git f"etch" origin main',
    'git fetch origin "$BRANCH"',
  ])(
    'requires confirmation for unsupported valid fetch syntax: %s',
    async command => {
      const bridge = await loadBridge(),
        harness = gateHarness(),
        roots = gateRoots()
      bridge.apply(harness.ctx, {
        policy: { workspaceRoot: roots.workspace },
        emit: (event: unknown) =>
          harness.events.push(event as Record<string, unknown>),
      })
      const result = await required(harness.handlers.get('tools/pre-execute'))(
        { callId: 'unsupported', name: 'bash', arguments: { command } },
        () => Promise.resolve({ kind: 'allow' }),
      )
      expect(result).toMatchObject({ kind: 'ask' })
    },
  )
  it.each([
    'family_task',
    'family_user',
    'exact_task',
    'exact_user',
    'family_user:before',
    'family_user:seam',
  ])(
    'persists and revokes real HTTP command authorization %s at both hooks',
    async scenario => {
      const [rawSuffix, revocationTiming] = scenario.split(':')
      const suffix = required(rawSuffix)
      const roots = gateRoots()
      const repository = realpathSync(roots.shared)
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' })
      git('init', '-q')
      git('config', 'user.name', 'Fixture')
      git('config', 'user.email', 'fixture@example.invalid')
      writeFileSync(join(repository, 'a'), 'a')
      git('add', 'a')
      git('commit', '-qm', 'initial')
      git('remote', 'add', 'origin', 'https://example.invalid/repo.git')
      const database = join(roots.workspace, 'commands.db')
      const store = new PegasStore(database)
      const claimed = createClaimedRun(store, 'command-request')
      const server = createControlPlane({ store, apiToken: 'command-fixture' })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const previous = { ...process.env }
      Object.assign(process.env, {
        PEGAS_APPROVAL_BRIDGE: '1',
        PEGAS_CONTROL_PLANE_URL: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
        PEGAS_RUN_ID: claimed.run.id,
        PEGAS_RUN_CLAIM_TOKEN: claimed.claimToken,
      })
      const command =
        'env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git fetch origin main'
      const bridge = await loadBridge()
      const make = (grant?: Record<string, unknown>) => {
        const harness = gateHarness()
        bridge.apply(harness.ctx, {
          ...(grant ? { grant } : {}),
          emit: (event: unknown) =>
            harness.events.push(event as Record<string, unknown>),
          policy: {
            workspaceRoot: roots.workspace,
            protectedRoots: [roots.dataDir],
          },
        })
        return harness
      }
      const call = (callId: string) => ({
        agent: {},
        callId,
        name: 'bash',
        arguments: { command, workdir: repository },
      })
      try {
        const first = make()
        await required(first.handlers.get('tools/pre-execute'))(
          call('first'),
          () => Promise.resolve({ kind: 'allow' }),
        )
        await required(first.handlers.get('approval/request'))(
          { callId: 'first', toolName: 'bash' },
          () => Promise.resolve('unavailable'),
        )
        const pending = first.events.find(e => e.type === 'approval_pending')
        expect(pending, JSON.stringify(first.events)).toBeDefined()
        const approval = required(
          store.getApproval(String(required(pending).approvalId), 'owner'),
        )
        expect(approval.prompt.options.map(o => o.id)).toContain(
          'approve_command_' + suffix,
        )
        expect(() => assertRollbackCompatible(database, 59, 1)).toThrow(
          /command authorization/,
        )
        const originalAction = required(
          store.getAction(approval.actionId, 'owner'),
        )
        const duplicateClaim =
          suffix.endsWith('user') && !revocationTiming
            ? createClaimedRun(store, 'duplicate-command')
            : undefined
        const duplicate = duplicateClaim
          ? store.requestApproval(
              duplicateClaim.run.id,
              duplicateClaim.claimToken,
              {
                kind: originalAction.kind,
                risk: originalAction.risk,
                idempotencyKey: 'duplicate-command',
                request: originalAction.request,
                recoveryPoint: originalAction.recoveryPoint,
                approval: {
                  ...approval.prompt,
                  options: approval.prompt.options.filter(
                    option => option.kind !== 'approve',
                  ),
                  recommendedOptionId: 'approve_command_' + suffix,
                },
              },
            )
          : undefined
        if (duplicate)
          expect(duplicate.approval.prompt.recommendedOptionId).toBe('reject')
        store.decideApproval(approval.id, 'owner', {
          commandId: 'command-decision',
          optionId: 'approve_command_' + suffix,
        })
        const rule = required(
          store.listApprovalRules(claimed.task.id, 'owner')[0],
        )
        if (duplicate) {
          store.decideApproval(duplicate.approval.id, 'owner', {
            commandId: 'duplicate-grant',
            optionId: 'approve_command_' + suffix,
          })
          expect(
            store.approvalRuleIdForAction(duplicate.action.id, 'owner'),
          ).toBe(rule.id)
          expect(
            store
              .listUserApprovalRules('owner')
              .filter(r => r.kind === 'command'),
          ).toHaveLength(1)
        }
        expect(rule).toMatchObject({
          kind: 'command',
          lifetime: suffix.endsWith('user') ? 'user' : 'task',
          command: {
            precision: suffix.startsWith('family') ? 'family' : 'exact',
          },
        })
        const reopened = new PegasStore(database)
        expect(reopened.listApprovalRules(claimed.task.id, 'owner')[0]).toEqual(
          rule,
        )
        reopened.close()
        const resumed = required(store.claimNextRun('command-resumed'))
        if (revocationTiming) {
          process.env.PEGAS_RUN_ID = resumed.run.id
          process.env.PEGAS_RUN_CLAIM_TOKEN = resumed.claimToken
          const restoring = make({
            actionId: approval.actionId,
            tool: 'bash',
            argumentsHash: originalAction.request.argumentsHash,
            commandSelector: originalAction.request.commandSelector,
            ruleId: rule.id,
          })
          if (revocationTiming === 'before')
            store.revokeApprovalRule(rule.taskId, rule.id, 'owner', {
              commandId: 'revoke-before-first',
            })
          const preResult = await required(
            restoring.handlers.get('tools/pre-execute'),
          )(call('restoring'), () => Promise.resolve({ kind: 'allow' }))
          expect(preResult).toMatchObject({
            kind: revocationTiming === 'before' ? 'ask' : 'allow',
          })
          if (revocationTiming === 'seam')
            store.revokeApprovalRule(rule.taskId, rule.id, 'owner', {
              commandId: 'revoke-at-seam',
            })
          expect(
            await required(restoring.handlers.get('approval/request'))(
              { callId: 'restoring', toolName: 'bash' },
              () => Promise.resolve('unavailable'),
            ),
          ).toBe('rejected')
          expect(store.getAction(approval.actionId, 'owner')).toMatchObject({
            status: 'failed',
            result: { notExecuted: true },
          })
          const newPending = required(
            restoring.events.find(e => e.type === 'approval_pending'),
          )
          const newApproval = required(
            store.getApproval(String(newPending.approvalId), 'owner'),
          )
          store.decideApproval(newApproval.id, 'owner', {
            commandId: 'approve-rechecked',
            optionId: 'approve',
          })
          const retried = required(store.claimNextRun('rechecked'))
          process.env.PEGAS_RUN_ID = retried.run.id
          process.env.PEGAS_RUN_CLAIM_TOKEN = retried.claimToken
          const action = required(
            store.getAction(newApproval.actionId, 'owner'),
          )
          const retryBridge = make({
            actionId: action.id,
            tool: 'bash',
            argumentsHash: action.request.argumentsHash,
            commandSelector: action.request.commandSelector,
          })
          await required(retryBridge.handlers.get('tools/pre-execute'))(
            call('retry'),
            () => Promise.resolve({ kind: 'allow' }),
          )
          expect(
            await required(retryBridge.handlers.get('approval/request'))(
              { callId: 'retry', toolName: 'bash' },
              () => Promise.resolve('unavailable'),
            ),
          ).toBe('allowed-once')
          await required(retryBridge.handlers.get('tools/post-execute'))(
            call('retry'),
            { isError: false },
            () => Promise.resolve({ kind: 'allow' }),
          )
          expect(store.getAction(action.id, 'owner')?.status).toBe('succeeded')
          return
        }
        store.recordActionOutcome(approval.actionId, resumed.claimToken, {
          commandId: 'fixture-first-result',
          status: 'succeeded',
          result: { fixture: true },
        })
        if (duplicateClaim)
          store.stopTask(duplicateClaim.task.id, 'owner', 'close-duplicate')
        process.env.PEGAS_RUN_ID = resumed.run.id
        process.env.PEGAS_RUN_CLAIM_TOKEN = resumed.claimToken
        const second = make(),
          pre = required(second.handlers.get('tools/pre-execute')),
          seam = required(second.handlers.get('approval/request'))
        expect(
          await pre(call('repeat'), () => Promise.resolve({ kind: 'allow' })),
        ).toEqual({ kind: 'allow' })
        expect(
          await seam({ callId: 'repeat', toolName: 'bash' }, () =>
            Promise.resolve('unavailable'),
          ),
        ).toBe('allowed-once')
        expect(second.events).toContainEqual(
          expect.objectContaining({ ruleId: rule.id, decision: 'allow' }),
        )
        if (suffix.startsWith('exact')) {
          const changed = call('parameters')
          changed.arguments.command = command.replace(
            'origin main',
            'origin other',
          )
          const changedResult = (await pre(changed, () =>
            Promise.resolve({ kind: 'allow' }),
          )) as { kind: string; reason: string }
          expect(changedResult.kind).toBe('ask')
          expect(changedResult.reason).toContain('参数')
        }
        git(
          'remote',
          'set-url',
          'origin',
          'https://example.invalid/changed.git',
        )
        const remoteResult = (await pre(call('changed-remote'), () =>
          Promise.resolve({ kind: 'allow' }),
        )) as { kind: string; reason: string }
        expect(remoteResult.kind).toBe('ask')
        expect(remoteResult.reason).toContain('远端')
        git('remote', 'set-url', 'origin', 'https://example.invalid/repo.git')
        const profile = store.getWorkerProfile(claimed.task.id, 'owner')
        store.updateWorkerProfile(claimed.task.id, 'owner', {
          commandId: 'strict-command',
          expectedRevision: profile.revision,
          modelMode: 'inherit',
          permissionMode: 'strict',
        })
        const strictResult = (await pre(call('strict-command'), () =>
          Promise.resolve({ kind: 'allow' }),
        )) as { kind: string; reason: string }
        expect(strictResult.kind).toBe('ask')
        expect(strictResult.reason).toMatch(/严格|收紧/)
        store.updateWorkerProfile(claimed.task.id, 'owner', {
          commandId: 'restore-command',
          expectedRevision: profile.revision + 1,
          modelMode: 'inherit',
          permissionMode: 'inherit',
        })
        const another = createClaimedRun(store, 'command-other')
        expect(
          store
            .runPermissionProjection(another.run.id, another.claimToken)
            .rules.some(r => r.id === rule.id),
        ).toBe(suffix.endsWith('user'))
        const foreign = createClaimedRun(
          store,
          'command-foreign',
          'other-owner',
        )
        expect(
          store
            .runPermissionProjection(foreign.run.id, foreign.claimToken)
            .rules.some(r => r.id === rule.id),
        ).toBe(false)
        const listing = await fetch(
          required(process.env.PEGAS_CONTROL_PLANE_URL) +
            '/v1/approval-rules?userId=owner',
          { headers: { authorization: 'Bearer command-fixture' } },
        )
        expect(
          ((await listing.json()) as { rules: unknown[] }).rules,
        ).toContainEqual(expect.objectContaining({ id: rule.id }))
        expect(
          (
            await fetch(
              required(process.env.PEGAS_CONTROL_PLANE_URL) +
                '/v1/approval-rules?userId=owner',
            )
          ).status,
        ).toBe(401)
        const foreignListing = await fetch(
          required(process.env.PEGAS_CONTROL_PLANE_URL) +
            '/v1/approval-rules?userId=other-owner',
          { headers: { authorization: 'Bearer command-fixture' } },
        )
        expect(
          ((await foreignListing.json()) as { rules: unknown[] }).rules,
        ).toEqual([])
        // Revoke between pre-execute and the sandbox seam: stale first-hook approval cannot win.
        expect(
          await pre(call('revoke-race'), () =>
            Promise.resolve({ kind: 'allow' }),
          ),
        ).toEqual({ kind: 'allow' })
        store.revokeApprovalRule(rule.taskId, rule.id, 'owner', {
          commandId: 'command-revoke',
        })
        expect(
          await seam({ callId: 'revoke-race', toolName: 'bash' }, () =>
            Promise.resolve('unavailable'),
          ),
        ).toBe('rejected')
        expect(
          store
            .listApprovalRules(rule.taskId, 'owner')
            .find(r => r.id === rule.id)?.status,
        ).toBe('revoked')
        const reapprovalId = second.events.findLast(
          e => e.type === 'approval_pending',
        )?.approvalId
        expect(reapprovalId).toBeTruthy()
        expect(
          store.getApproval(String(reapprovalId), 'owner')?.prompt.impact,
        ).toContain('已撤销')
        store.decideApproval(String(reapprovalId), 'owner', {
          commandId: 'command-regrant',
          optionId: 'approve_command_' + suffix,
        })
        const active = required(
          store
            .listApprovalRules(rule.taskId, 'owner')
            .find(r => r.status === 'active'),
        )
        expect(active).toBeDefined()
        store.stopTask(rule.taskId, 'owner', 'command-end')
        expect(
          store
            .listApprovalRules(rule.taskId, 'owner')
            .find(r => r.id === active.id)?.status,
        ).toBe(suffix.endsWith('user') ? 'active' : 'revoked')
      } finally {
        restoreEnvironment(previous)
        await new Promise<void>((resolve, reject) =>
          server.close(e => (e ? reject(e) : resolve())),
        )
        store.close()
      }
    },
    20_000,
  )

  it('rechecks the actual session directory and bash workdir at both approval hooks', async () => {
    const roots = gateRoots()
    const previous = { ...process.env }
    Object.assign(process.env, {
      PEGAS_APPROVAL_BRIDGE: '1',
      PEGAS_CONTROL_PLANE_URL: 'http://127.0.0.1:1',
      PEGAS_RUN_ID: 'cwd-run',
      PEGAS_RUN_CLAIM_TOKEN: 'cwd-test-token',
    })
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            effectiveTier: 'standard',
            rules: [
              {
                id: 'trusted',
                tool: '*',
                scope: 'user_directory',
                category: 'out-of-workspace-write',
                targets: [realpathSync(roots.shared)],
                fingerprint: 'test',
              },
            ],
          }),
      }),
    )
    try {
      const bridge = await loadBridge()
      const harness = gateHarness()
      let cwd = roots.shared
      bridge.apply(
        {
          ...harness.ctx,
          workingDirectory: {
            get: () => cwd,
            ensure: () => Promise.resolve(cwd),
          },
        },
        {
          emit: (event: unknown) =>
            harness.events.push(event as Record<string, unknown>),
          policy: {
            workspaceRoot: roots.workspace,
            protectedRoots: [roots.dataDir],
          },
        },
      )
      const pre = harness.handlers.get('tools/pre-execute')
      const seam = harness.handlers.get('approval/request')
      if (!pre || !seam) throw new Error('Expected approval hooks')
      const command =
        "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: file.md\n+test\n*** End Patch\nPATCH"
      const execution = {
        agent: { session: {} },
        callId: 'relative',
        name: 'bash',
        arguments: { command },
      }
      expect(
        await pre(execution, () => Promise.resolve({ kind: 'allow' })),
      ).toEqual({
        kind: 'allow',
      })
      expect(
        await seam({ callId: 'relative', toolName: 'bash' }, () =>
          Promise.resolve('unavailable'),
        ),
      ).toBe('allowed-once')
      // Explicit workdir takes precedence over the session cwd.
      expect(
        await pre(
          {
            ...execution,
            callId: 'workdir',
            arguments: { command, workdir: roots.dataDir },
          },
          () => Promise.resolve({ kind: 'allow' }),
        ),
      ).not.toEqual({ kind: 'allow' })
      // A cwd change between hooks cannot reuse a decision for the trusted directory.
      cwd = roots.dataDir
      expect(
        await seam({ callId: 'relative', toolName: 'bash' }, () =>
          Promise.resolve('unavailable'),
        ),
      ).toBe('rejected')
      expect(harness.events).toContainEqual(
        expect.objectContaining({
          callId: 'workdir',
          category: 'control-plane-mutation',
          targets: [join(realpathSync(roots.dataDir), 'file.md')],
        }),
      )
    } finally {
      vi.unstubAllGlobals()
      restoreEnvironment(previous)
    }
  })
  it.each([
    'approve_rule',
    'approve_directory_task',
    'approve_directory_user',
    'approve_directory_user:before',
    'approve_directory_user:seam',
  ])(
    'supports %s, persists scope and re-asks after revocation',
    async scopeScenario => {
      const [rawOption, revocationTiming] = scopeScenario.split(':')
      const optionId = required(rawOption)
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

        if (revocationTiming) {
          const original = required(
            store.getAction(required(approval).actionId, 'owner'),
          )
          const restoring = gateHarness()
          expect(store.approvalRuleIdForAction(original.id, 'owner')).toBe(
            rule.id,
          )
          bridge.apply(restoring.ctx, {
            emit: (event: unknown) =>
              restoring.events.push(event as Record<string, unknown>),
            grant: {
              actionId: original.id,
              tool: 'write',
              argumentsHash: original.request.argumentsHash,
              ruleId: rule.id,
              ruleRequired: true,
            },
            policy: {
              workspaceRoot: roots.workspace,
              protectedRoots: [roots.dataDir],
            },
          })
          if (revocationTiming === 'before')
            store.revokeApprovalRule(rule.taskId, rule.id, 'owner', {
              commandId: 'revoke-first-write',
            })
          expect(
            await required(restoring.handlers.get('tools/pre-execute'))(
              writeCall,
              () => Promise.resolve({ kind: 'allow' }),
            ),
          ).toMatchObject({
            kind: revocationTiming === 'before' ? 'ask' : 'allow',
          })
          if (revocationTiming === 'seam')
            store.revokeApprovalRule(rule.taskId, rule.id, 'owner', {
              commandId: 'revoke-first-write',
            })
          expect(
            await required(restoring.handlers.get('approval/request'))(
              { callId: writeCall.callId, toolName: 'write' },
              () => Promise.resolve('unavailable'),
            ),
          ).toBe('rejected')
          expect(store.getAction(original.id, 'owner')).toMatchObject({
            status: 'failed',
            result: { notExecuted: true },
          })
          expect(
            restoring.events.some(event => event.type === 'approval_pending'),
          ).toBe(true)
          return
        }

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
