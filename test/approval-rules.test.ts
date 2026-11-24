import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { parseApprovalDecisionDraft } from '../src/approval/approval.js'
import { parseApprovalRuleRevocation } from '../src/approval/approval-rule.js'
import {
  approvalRuleFingerprint,
  approvalRuleRevocationFingerprint,
} from '../src/approval/approval-rule-fingerprint.js'
import { createControlPlane } from '../src/control-plane/server.js'
import { loadConfig } from '../src/core/config.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import { assertRollbackCompatible } from '../src/supervisor/rollback-compatibility.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function workspaceRoot(): string {
  const base = mkdtempSync(join(tmpdir(), 'pegas-approval-rules-'))
  temporaryDirectories.push(base)
  const workspace = join(base, 'workspace')
  mkdirSync(workspace, { recursive: true })
  return workspace
}

function createClaimedRun(store: PegasStore, workerId: string) {
  if (!store.hasRuntimeSettings()) {
    store.initializeRuntimeSettings(runtimeSettingsDefaults(loadConfig({})))
  }
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'test',
    payload: { text: '整理工作区文件' },
  }).event
  const claimedEvent = store.claimNextEvent(`setup-${workerId}`)
  if (!claimedEvent) throw new Error('Expected setup claim')
  store.applyRoutingDecision(
    claimedEvent,
    {
      kind: 'create_task',
      title: '整理工作区文件',
      goal: '整理工作区文件',
      input: '整理工作区文件',
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

interface ParkedApproval {
  actionId: string
  approvalId: string
  taskId: string
  runId: string
  claimToken: string
}

function parkOutsideWrite(
  store: PegasStore,
  workerId: string,
  target: string,
  callId: string,
): ParkedApproval {
  const claimed = createClaimedRun(store, workerId)
  const argumentsHash = createHash('sha256')
    .update(JSON.stringify({ file_path: target, content: 'hello' }))
    .digest('hex')
  const result = store.requestApproval(claimed.run.id, claimed.claimToken, {
    kind: 'dsh.tool.write',
    risk: 'high',
    idempotencyKey: `dsh-tool:${claimed.run.id}:${callId}`,
    request: {
      tool: 'write',
      callId,
      reason: `工具 write 将写入工作区之外（${target}）。`,
      category: 'out-of-workspace-write',
      targets: [target],
      argumentsHash,
      tier: 'standard',
    },
    recoveryPoint: { step: 'before_tool_call', callId },
    approval: {
      summary: '批准工具 write 写入工作区之外',
      impact: `工具 write 将写入工作区之外（${target}）。`,
      recommendedOptionId: 'approve',
      options: [
        { id: 'approve', label: '批准执行一次', kind: 'approve' },
        {
          id: 'approve_rule',
          label: '本事情内同类不再询问',
          kind: 'approve_rule',
        },
        { id: 'reject', label: '不执行', kind: 'reject' },
      ],
    },
  })
  return {
    actionId: result.action.id,
    approvalId: result.approval.id,
    taskId: claimed.task.id,
    runId: claimed.run.id,
    claimToken: claimed.claimToken,
  }
}

function claimSuccessor(store: PegasStore, actionId: string) {
  const action = store.getAction(actionId, 'owner')
  const resumeRunId = action?.resumeRunId
  if (!resumeRunId) throw new Error('Expected successor run')
  const claimed = store.claimNextRun('worker-rule-successor')
  if (!claimed) throw new Error('Expected successor claim')
  if (claimed.run.id !== resumeRunId)
    throw new Error('Expected successor claim')
  return claimed
}

describe('approval rule contract', () => {
  it('accepts approve_rule decisions and rejects drafts without an option', () => {
    expect(
      parseApprovalDecisionDraft({
        commandId: 'decision-rule',
        optionId: 'approve_rule',
      }),
    ).toMatchObject({ commandId: 'decision-rule', optionId: 'approve_rule' })
    expect(() =>
      parseApprovalDecisionDraft({ commandId: 'decision-rule' }),
    ).toThrow()
  })

  it('derives a stable fingerprint from tool and canonical targets only', () => {
    const first = approvalRuleFingerprint({
      tool: 'write',
      category: 'out-of-workspace-write',
      targets: ['/data/b.md', '/data/a.md'],
    })
    const second = approvalRuleFingerprint({
      tool: 'write',
      category: 'out-of-workspace-write',
      targets: ['/data/a.md', '/data/b.md'],
    })
    const variant = approvalRuleFingerprint({
      tool: 'write',
      category: 'out-of-workspace-write',
      targets: ['/data/c.md'],
    })
    expect(first).toBe(second)
    expect(first).not.toBe(variant)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(() =>
      approvalRuleFingerprint({
        tool: 'write',
        category: 'out-of-workspace-write',
        targets: [],
      }),
    ).toThrow()
    expect(() =>
      approvalRuleFingerprint({
        tool: 'bash',
        category: 'unknown',
        targets: ['/data/a.md'],
      }),
    ).toThrow()
    expect(() =>
      approvalRuleFingerprint({
        tool: 'write',
        category: 'control-plane-mutation',
        targets: ['/data/a.md'],
      }),
    ).toThrow()
  })

  it('parses revocation commands with bounded ids', () => {
    expect(parseApprovalRuleRevocation({ commandId: 'revoke-1' })).toEqual({
      commandId: 'revoke-1',
    })
    expect(() => parseApprovalRuleRevocation({})).toThrow()
    expect(approvalRuleRevocationFingerprint('revoke-1')).toMatch(
      /^[0-9a-f]{64}$/,
    )
  })

  it('never accepts persistent rules for outbound network egress', () => {
    expect(() =>
      approvalRuleFingerprint({
        tool: 'bash',
        category: 'network-egress',
        targets: ['https://example.com/hook'],
      }),
    ).toThrow(/persistent rules/)
    expect(() =>
      approvalRuleFingerprint({
        tool: 'web_fetch',
        category: 'network-egress',
        targets: ['https://example.com'],
      }),
    ).toThrow(/persistent rules/)
  })
})

describe('approval rule persistence', () => {
  it('creates a task-scoped rule from an approve_rule decision with timeline audit', () => {
    const store = new PegasStore(':memory:')
    const workspace = workspaceRoot()
    const target = join(workspace, '..', 'shared', 'a.md')
    const parked = parkOutsideWrite(store, 'worker-rule-create', target, 'c1')
    const decided = store.decideApproval(parked.approvalId, 'owner', {
      commandId: 'decide-rule-create',
      optionId: 'approve_rule',
    })
    expect(decided.approval.status).toBe('approved')
    expect(decided.decision.kind).toBe('approve_rule')
    const rules = store.listApprovalRules(parked.taskId, 'owner')
    expect(rules).toHaveLength(1)
    const rule = rules[0]
    if (!rule) throw new Error('Expected created rule')
    expect(rule).toMatchObject({
      taskId: parked.taskId,
      tool: 'write',
      category: 'out-of-workspace-write',
      targets: [target],
      status: 'active',
      createdFromApprovalId: parked.approvalId,
      createdFromDecisionId: decided.decision.id,
    })
    expect(rule.fingerprint).toBe(
      approvalRuleFingerprint({
        tool: 'write',
        category: 'out-of-workspace-write',
        targets: [target],
      }),
    )
    const replay = store.decideApproval(parked.approvalId, 'owner', {
      commandId: 'decide-rule-create',
      optionId: 'approve_rule',
    })
    expect(replay.decision.id).toBe(decided.decision.id)
    expect(store.listApprovalRules(parked.taskId, 'owner')).toHaveLength(1)
    const timeline = store
      .listOutbox('owner')
      .filter(
        message =>
          (message.payload as { type?: string }).type ===
          'task.approval_rule_changed',
      )
    expect(timeline.length).toBeGreaterThan(0)
    store.close()
  })

  it('rejects approve_rule for critical actions without creating a rule', () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'worker-rule-critical')
    const result = store.requestApproval(claimed.run.id, claimed.claimToken, {
      kind: 'dsh.tool.bash',
      risk: 'critical',
      idempotencyKey: `dsh-tool:${claimed.run.id}:critical-1`,
      request: {
        tool: 'bash',
        callId: 'critical-1',
        reason: '不可逆命令',
        category: 'destructive-command',
        targets: ['/'],
        argumentsHash: 'hash',
      },
      recoveryPoint: { step: 'before_tool_call', callId: 'critical-1' },
      approval: {
        summary: '确认不可逆命令',
        impact: '不可逆命令',
        recommendedOptionId: 'approve',
        options: [
          { id: 'approve', label: '批准执行一次', kind: 'approve' },
          {
            id: 'approve_rule',
            label: '本事情内同类不再询问',
            kind: 'approve_rule',
          },
          { id: 'reject', label: '不执行', kind: 'reject' },
        ],
      },
    })
    expect(() =>
      store.decideApproval(result.approval.id, 'owner', {
        commandId: 'decide-critical-rule',
        optionId: 'approve_rule',
      }),
    ).toThrow(/rule/i)
    expect(store.listApprovalRules(claimed.task.id, 'owner')).toHaveLength(0)
    const approval = store.getApproval(result.approval.id, 'owner')
    expect(approval?.status).toBe('pending')
    store.close()
  })

  it('rejects approve_rule for network egress even when the prompt offers it', () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'worker-rule-egress')
    const result = store.requestApproval(claimed.run.id, claimed.claimToken, {
      kind: 'dsh.tool.bash',
      risk: 'high',
      idempotencyKey: `dsh-tool:${claimed.run.id}:egress-rule-1`,
      request: {
        tool: 'bash',
        callId: 'egress-rule-1',
        reason: '命令会向外部发送数据',
        category: 'network-egress',
        targets: ['https://example.com/hook'],
        argumentsHash: 'hash',
        command: 'curl -X POST -d @payload.json https://example.com/hook',
      },
      recoveryPoint: { step: 'before_tool_call', callId: 'egress-rule-1' },
      approval: {
        summary: '批准工具 bash 向外部发送数据一次',
        impact: '命令会向外部发送数据',
        recommendedOptionId: 'approve',
        options: [
          { id: 'approve', label: '批准执行一次', kind: 'approve' },
          {
            id: 'approve_rule',
            label: '本事情内同类不再询问',
            kind: 'approve_rule',
          },
          { id: 'reject', label: '不执行', kind: 'reject' },
        ],
      },
    })
    expect(() =>
      store.decideApproval(result.approval.id, 'owner', {
        commandId: 'decide-egress-rule',
        optionId: 'approve_rule',
      }),
    ).toThrow(/egress|外发|对外/)
    expect(store.listApprovalRules(claimed.task.id, 'owner')).toHaveLength(0)
    const approval = store.getApproval(result.approval.id, 'owner')
    expect(approval?.status).toBe('pending')
    store.close()
  })

  it('refuses approve_rule when the approval prompt does not offer it', () => {
    const store = new PegasStore(':memory:')
    const claimed = createClaimedRun(store, 'worker-rule-no-option')
    const result = store.requestApproval(claimed.run.id, claimed.claimToken, {
      kind: 'dsh.tool.write',
      risk: 'high',
      idempotencyKey: `dsh-tool:${claimed.run.id}:plain-1`,
      request: {
        tool: 'write',
        callId: 'plain-1',
        reason: '越界写',
        category: 'out-of-workspace-write',
        targets: ['/tmp/outside.md'],
        argumentsHash: 'hash',
      },
      recoveryPoint: { step: 'before_tool_call', callId: 'plain-1' },
      approval: {
        summary: '批准越界写',
        impact: '越界写',
        recommendedOptionId: 'approve',
        options: [
          { id: 'approve', label: '批准执行一次', kind: 'approve' },
          { id: 'reject', label: '不执行', kind: 'reject' },
        ],
      },
    })
    expect(() =>
      store.decideApproval(result.approval.id, 'owner', {
        commandId: 'decide-missing-rule-option',
        optionId: 'approve_rule',
      }),
    ).toThrow()
    store.close()
  })

  it('revokes rules idempotently, owner-scoped, and keeps history', () => {
    const store = new PegasStore(':memory:')
    const workspace = workspaceRoot()
    const target = join(workspace, '..', 'shared', 'b.md')
    const parked = parkOutsideWrite(store, 'worker-rule-revoke', target, 'c2')
    store.decideApproval(parked.approvalId, 'owner', {
      commandId: 'decide-rule-revoke',
      optionId: 'approve_rule',
    })
    const rule = store.listApprovalRules(parked.taskId, 'owner')[0]
    if (!rule) throw new Error('Expected created rule')
    expect(() => store.listApprovalRules(parked.taskId, 'intruder')).toThrow(
      /another user/,
    )
    expect(() =>
      store.revokeApprovalRule(parked.taskId, rule.id, 'intruder', {
        commandId: 'revoke-intruder',
      }),
    ).toThrow(/another user/)
    const revoked = store.revokeApprovalRule(parked.taskId, rule.id, 'owner', {
      commandId: 'revoke-once',
    })
    expect(revoked.status).toBe('revoked')
    expect(revoked.revokedBy).toBe('owner')
    const replay = store.revokeApprovalRule(parked.taskId, rule.id, 'owner', {
      commandId: 'revoke-once',
    })
    expect(replay.id).toBe(revoked.id)
    expect(store.listApprovalRules(parked.taskId, 'owner')).toHaveLength(1)
    expect(store.listApprovalRules(parked.taskId, 'owner')[0]?.status).toBe(
      'revoked',
    )
    const successor = claimSuccessor(store, parked.actionId)
    const projection = store.runPermissionProjection(
      successor.run.id,
      successor.claimToken,
    ) as { rules: unknown[] }
    expect(projection.rules).toHaveLength(0)
    store.close()
  })

  it('exposes only active task rules on the claim projection and bumps generation', () => {
    const store = new PegasStore(':memory:')
    const workspace = workspaceRoot()
    const target = join(workspace, '..', 'shared', 'c.md')
    const parked = parkOutsideWrite(
      store,
      'worker-rule-projection',
      target,
      'c3',
    )
    const other = createClaimedRun(store, 'worker-rule-projection-other')
    const otherBefore = store.runPermissionProjection(
      other.run.id,
      other.claimToken,
    ) as { generation: string; rules: unknown[] }
    expect(otherBefore.rules).toHaveLength(0)
    store.decideApproval(parked.approvalId, 'owner', {
      commandId: 'decide-rule-projection',
      optionId: 'approve_rule',
    })
    const successor = claimSuccessor(store, parked.actionId)
    const rule = store.listApprovalRules(parked.taskId, 'owner')[0]
    if (!rule) throw new Error('Expected created rule')
    const after = store.runPermissionProjection(
      successor.run.id,
      successor.claimToken,
    ) as {
      generation: string
      rules?: { id: string; tool: string; fingerprint: string }[]
    }
    expect(after.rules).toHaveLength(1)
    expect(after.rules?.[0]).toMatchObject({ tool: 'write' })
    const otherProjection = store.runPermissionProjection(
      other.run.id,
      other.claimToken,
    ) as { generation: string; rules: unknown[] }
    expect(otherProjection.rules).toHaveLength(0)
    expect(otherProjection.generation).toBe(otherBefore.generation)
    store.revokeApprovalRule(parked.taskId, rule.id, 'owner', {
      commandId: 'revoke-projection-rule',
    })
    const afterRevoke = store.runPermissionProjection(
      successor.run.id,
      successor.claimToken,
    ) as { generation: string; rules?: unknown[] }
    expect(afterRevoke.rules).toHaveLength(0)
    expect(afterRevoke.generation).not.toBe(after.generation)
    store.close()
  })

  it('blocks rollback below the rule schema while active rules exist', () => {
    const base = mkdtempSync(join(tmpdir(), 'pegas-rules-rollback-'))
    temporaryDirectories.push(base)
    const path = join(base, 'pegas.db')
    const store = new PegasStore(path)
    const workspace = workspaceRoot()
    const target = join(workspace, '..', 'shared', 'd.md')
    const parked = parkOutsideWrite(store, 'worker-rule-rollback', target, 'c4')
    store.decideApproval(parked.approvalId, 'owner', {
      commandId: 'decide-rule-rollback',
      optionId: 'approve_rule',
    })
    store.close()
    expect(() => assertRollbackCompatible(path, 40)).toThrow(/rule/i)
    const reopened = new PegasStore(path)
    const rule = reopened.listApprovalRules(parked.taskId, 'owner')[0]
    if (!rule) throw new Error('Expected created rule')
    reopened.revokeApprovalRule(parked.taskId, rule.id, 'owner', {
      commandId: 'revoke-for-rollback',
    })
    reopened.close()
    expect(() => assertRollbackCompatible(path, 40)).not.toThrow()
    const db = new DatabaseSync(path)
    try {
      const versions = db
        .prepare('SELECT MAX(version) AS version FROM schema_migrations')
        .get() as { version: number }
      expect(versions.version).toBe(49)
      const decisionKinds = db
        .prepare('SELECT kind FROM approval_decisions')
        .all() as { kind: string }[]
      expect(decisionKinds.map(row => row.kind)).toContain('approve_rule')
    } finally {
      db.close()
    }
  })
})

describe('approval rule HTTP surface', () => {
  it('lists and revokes rules with owner bearer auth and claim projection rules', async () => {
    const store = new PegasStore(':memory:')
    const workspace = workspaceRoot()
    const target = join(workspace, '..', 'shared', 'e.md')
    const parked = parkOutsideWrite(store, 'worker-rule-http', target, 'c5')
    store.decideApproval(parked.approvalId, 'owner', {
      commandId: 'decide-rule-http',
      optionId: 'approve_rule',
    })
    const successor = claimSuccessor(store, parked.actionId)
    const rule = store.listApprovalRules(parked.taskId, 'owner')[0]
    if (!rule) throw new Error('Expected created rule')
    const server = createControlPlane({
      store,
      apiToken: 'bridge-test',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    try {
      const rulesUrl = `${base}/v1/tasks/${encodeURIComponent(parked.taskId)}/approval-rules?userId=owner`
      const unauthenticated = await fetch(rulesUrl)
      expect(unauthenticated.status).toBe(401)
      const listed = await fetch(rulesUrl, {
        headers: { authorization: 'Bearer bridge-test' },
      })
      expect(listed.status).toBe(200)
      expect(await listed.json()).toMatchObject({
        rules: [{ id: rule.id, status: 'active' }],
      })
      const intruder = await fetch(
        `${base}/v1/tasks/${encodeURIComponent(parked.taskId)}/approval-rules?userId=intruder`,
        { headers: { authorization: 'Bearer bridge-test' } },
      )
      expect(intruder.status).toBe(404)
      const projection = await fetch(
        `${base}/v1/runs/${encodeURIComponent(successor.run.id)}/permissions`,
        { headers: { 'x-pegas-run-claim-token': successor.claimToken } },
      )
      expect(projection.status).toBe(200)
      expect(await projection.json()).toMatchObject({
        rules: [{ id: rule.id, tool: 'write' }],
      })
      const revokeUrl = `${base}/v1/tasks/${encodeURIComponent(parked.taskId)}/approval-rules/${encodeURIComponent(rule.id)}/revoke`
      const revoked = await fetch(revokeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer bridge-test',
        },
        body: JSON.stringify({ userId: 'owner', commandId: 'revoke-http' }),
      })
      expect(revoked.status).toBe(200)
      expect(await revoked.json()).toMatchObject({
        rule: { id: rule.id, status: 'revoked' },
      })
      const replay = await fetch(revokeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer bridge-test',
        },
        body: JSON.stringify({ userId: 'owner', commandId: 'revoke-http' }),
      })
      expect(replay.status).toBe(200)
      const afterRevoke = await fetch(
        `${base}/v1/runs/${encodeURIComponent(successor.run.id)}/permissions`,
        { headers: { 'x-pegas-run-claim-token': successor.claimToken } },
      )
      expect(await afterRevoke.json()).toMatchObject({ rules: [] })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })
})
