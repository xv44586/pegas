import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import { loadConfig } from '../src/core/config.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  assertRollbackCompatible,
  RollbackCompatibilityError,
} from '../src/supervisor/rollback-compatibility.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createStore(): PegasStore {
  const store = new PegasStore(':memory:')
  store.initializeRuntimeSettings(runtimeSettingsDefaults(loadConfig({})))
  return store
}

function createTaskWithRun(store: PegasStore, userId = 'owner') {
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'test',
    payload: { text: '整理资料并写入报告' },
  }).event
  const claimedEvent = store.claimNextEvent('setup-audit')
  if (!claimedEvent) throw new Error('Expected event claim')
  store.applyRoutingDecision(
    claimedEvent,
    {
      kind: 'create_task',
      title: '整理资料并写入报告',
      goal: '整理资料并写入报告',
      input: '整理资料并写入报告',
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
  store.completeEvent(event.id, 'setup-audit')
  const task = store.listTasks(userId)[0]
  if (!task) throw new Error('Expected task')
  const claimed = store.claimNextRun('worker-audit')
  if (!claimed) throw new Error('Expected claimed run')
  return { task, claimed }
}

function auditEntry(callId: string, overrides: Record<string, unknown> = {}) {
  return {
    callId,
    tool: 'bash',
    category: 'workspace-write',
    risk: 'low',
    decision: 'allow' as const,
    reason: '工作区内写入。',
    tier: 'standard',
    generation: 'gen-1',
    mismatch: false,
    targets: ['/tmp/ws/report.md'],
    ...overrides,
  }
}

describe('policy call audit table', () => {
  it('records one append-only row per gate decision with rule and review provenance', () => {
    const store = createStore()
    const { task, claimed } = createTaskWithRun(store)
    try {
      store.appendPolicyCallAudit(claimed.run.id, 'worker-audit', {
        ...auditEntry('call-1'),
        ruleId: 'rule-1',
      })
      store.appendPolicyCallAudit(claimed.run.id, 'worker-audit', {
        ...auditEntry('call-2', {
          decision: 'allow',
          reviewDecision: 'allow',
          actionId: 'action-2',
          category: 'out-of-workspace-write',
          risk: 'high',
        }),
      })
      store.appendPolicyCallAudit(claimed.run.id, 'worker-audit', {
        ...auditEntry('call-3', {
          decision: 'ask',
          category: 'network-egress',
          risk: 'high',
        }),
      })
      const page = store.listPolicyCallAudit('owner', { taskId: task.id })
      expect(page.items).toHaveLength(3)
      const byCall = new Map(page.items.map(item => [item.callId, item]))
      expect(byCall.get('call-1')).toMatchObject({
        runId: claimed.run.id,
        taskId: task.id,
        tool: 'bash',
        decision: 'allow',
        ruleId: 'rule-1',
        tier: 'standard',
        generation: 'gen-1',
        mismatch: false,
        targets: ['/tmp/ws/report.md'],
      })
      expect(byCall.get('call-2')).toMatchObject({
        reviewDecision: 'allow',
        actionId: 'action-2',
      })
      expect(byCall.get('call-3')).toMatchObject({ decision: 'ask' })
      expect(() =>
        store.appendPolicyCallAudit(claimed.run.id, 'other-worker', {
          ...auditEntry('call-foreign'),
        }),
      ).not.toThrow()
      expect(
        store
          .listPolicyCallAudit('owner', { taskId: task.id })
          .items.map(item => item.callId),
      ).not.toContain('call-foreign')
    } finally {
      store.close()
    }
  })

  it('dedupes a replayed decision for the same run and call', () => {
    const store = createStore()
    const { task, claimed } = createTaskWithRun(store)
    try {
      store.appendPolicyCallAudit(
        claimed.run.id,
        'worker-audit',
        auditEntry('call-replay'),
      )
      store.appendPolicyCallAudit(
        claimed.run.id,
        'worker-audit',
        auditEntry('call-replay'),
      )
      expect(
        store.listPolicyCallAudit('owner', { taskId: task.id }).items,
      ).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('filters by decision, rule and category and isolates owners', () => {
    const store = createStore()
    const { task, claimed } = createTaskWithRun(store)
    try {
      store.appendPolicyCallAudit(claimed.run.id, 'worker-audit', {
        ...auditEntry('call-rule'),
        ruleId: 'rule-9',
      })
      store.appendPolicyCallAudit(claimed.run.id, 'worker-audit', {
        ...auditEntry('call-read', {
          tool: 'read',
          category: 'read',
          targets: [],
        }),
      })
      store.appendPolicyCallAudit(claimed.run.id, 'worker-audit', {
        ...auditEntry('call-ask', {
          decision: 'ask',
          category: 'network-egress',
          risk: 'high',
        }),
      })
      expect(
        store
          .listPolicyCallAudit('owner', { taskId: task.id, ruleId: 'rule-9' })
          .items.map(item => item.callId),
      ).toEqual(['call-rule'])
      expect(
        store
          .listPolicyCallAudit('owner', { taskId: task.id, decision: 'ask' })
          .items.map(item => item.callId),
      ).toEqual(['call-ask'])
      expect(
        store
          .listPolicyCallAudit('owner', {
            taskId: task.id,
            category: 'read',
          })
          .items.map(item => item.callId),
      ).toEqual(['call-read'])
      expect(
        store.listPolicyCallAudit('intruder', { taskId: task.id }).items,
      ).toHaveLength(0)
      expect(() =>
        store.listPolicyCallAudit('owner', { runId: claimed.run.id }),
      ).not.toThrow()
    } finally {
      store.close()
    }
  })

  it('keeps audit rows immutable at the database layer', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-audit-immutable-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'pegas.sqlite')
    const store = new PegasStore(path)
    store.initializeRuntimeSettings(runtimeSettingsDefaults(loadConfig({})))
    const { claimed } = createTaskWithRun(store)
    store.appendPolicyCallAudit(
      claimed.run.id,
      'worker-audit',
      auditEntry('call-immutable'),
    )
    store.close()
    const database = new DatabaseSync(path)
    try {
      expect(() =>
        database
          .prepare(`UPDATE policy_call_audit SET decision = 'deny'`)
          .run(),
      ).toThrow(/append-only/u)
      expect(() =>
        database.prepare(`DELETE FROM policy_call_audit`).run(),
      ).toThrow(/cannot be deleted/u)
    } finally {
      database.close()
    }
  })
})

describe('policy call audit HTTP surface', () => {
  it('serves owner-scoped filters with bearer protection', async () => {
    const store = createStore()
    const { task, claimed } = createTaskWithRun(store)
    const server = createControlPlane({
      store,
      apiToken: 'bridge-test',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    try {
      store.appendPolicyCallAudit(claimed.run.id, 'worker-audit', {
        ...auditEntry('call-http'),
        ruleId: 'rule-http',
      })
      const url = `${base}/v1/policy-audit?userId=owner&taskId=${encodeURIComponent(task.id)}`
      const unauthenticated = await fetch(url)
      expect(unauthenticated.status).toBe(401)
      const response = await fetch(url, {
        headers: { authorization: 'Bearer bridge-test' },
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        entries: { callId: string; ruleId?: string }[]
      }
      expect(body.entries).toHaveLength(1)
      expect(body.entries[0]).toMatchObject({
        callId: 'call-http',
        ruleId: 'rule-http',
      })
      const filtered = await fetch(`${url}&ruleId=rule-none`, {
        headers: { authorization: 'Bearer bridge-test' },
      })
      expect(
        ((await filtered.json()) as { entries: unknown[] }).entries,
      ).toHaveLength(0)
      const foreign = await fetch(
        `${base}/v1/policy-audit?userId=intruder&taskId=${encodeURIComponent(task.id)}`,
        { headers: { authorization: 'Bearer bridge-test' } },
      )
      expect(
        ((await foreign.json()) as { entries: unknown[] }).entries,
      ).toHaveLength(0)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  })
})

describe('policy call audit rollback guard', () => {
  it('refuses rollback below the audit schema while rule or review provenance exists', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-audit-guard-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'pegas.sqlite')
    const store = new PegasStore(path)
    store.initializeRuntimeSettings(runtimeSettingsDefaults(loadConfig({})))
    const { claimed } = createTaskWithRun(store)
    store.appendPolicyCallAudit(
      claimed.run.id,
      'worker-audit',
      auditEntry('call-guard'),
    )
    store.close()
    expect(() => assertRollbackCompatible(path, 42)).not.toThrow()
    const withProvenance = new PegasStore(path)
    const run = withProvenance.listRuns().at(-1)
    if (!run) throw new Error('Expected run')
    withProvenance.appendPolicyCallAudit(run.id, 'worker-audit', {
      ...auditEntry('call-guard-rule'),
      ruleId: 'rule-guard',
    })
    withProvenance.close()
    expect(() => assertRollbackCompatible(path, 42)).toThrow(
      RollbackCompatibilityError,
    )
  })
})
