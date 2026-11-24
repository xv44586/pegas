import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ActionReconciliation,
  probeWriteAction,
} from '../src/observability/action-reconciliation.js'
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

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-auto-recon-'))
  temporaryDirectories.push(directory)
  return directory
}

function createUnknownWriteAction(
  store: PegasStore,
  target: string,
  contentHash?: string,
) {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: '写一份报告到工作区外' },
  }).event
  const created = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: '写一份报告到工作区外',
      goal: '写一份报告到工作区外',
      input: '写一份报告到工作区外',
      reason: 'auto reconciliation test',
    },
    'dsh-headless',
  )
  const claimed = store.claimNextRun('worker-auto-request')
  if (!claimed) throw new Error('Expected a claimed Run')
  const requested = store.requestApproval(claimed.run.id, claimed.claimToken, {
    kind: 'dsh.tool.write',
    risk: 'high',
    idempotencyKey: `auto-write-${created.task.id}`,
    request: {
      tool: 'write',
      callId: 'call-auto-1',
      category: 'out-of-workspace-write',
      targets: [target],
      argumentsHash: 'a'.repeat(64),
      ...(contentHash ? { effect: { contentHash } } : {}),
    },
    recoveryPoint: { step: 'before_tool_call', callId: 'call-auto-1' },
    approval: {
      summary: '批准工作区外写入',
      impact: '写入工作区之外',
      recommendedOptionId: 'approve',
      options: [
        { id: 'approve', label: '批准执行一次', kind: 'approve' },
        { id: 'reject', label: '不执行', kind: 'reject' },
      ],
    },
  })
  store.decideApproval(requested.approval.id, 'owner', {
    commandId: `approve-auto-${created.task.id}`,
    optionId: 'approve',
  })
  const resumed = store.claimNextRun('worker-auto-resumed')
  if (!resumed) throw new Error('Expected resumed Run')
  store.recordActionOutcome(requested.action.id, resumed.claimToken, {
    commandId: `outcome-auto-${created.task.id}`,
    status: 'unknown',
    result: { reason: 'executor_completed_without_outcome' },
  })
  return {
    taskId: created.task.id,
    actionId: requested.action.id,
    action: store.getAction(requested.action.id, 'owner'),
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('write action external probe', () => {
  it('confirms success only when every target exists with the expected content hash', () => {
    const directory = workspace()
    const target = join(directory, 'report.md')
    writeFileSync(target, 'authorized content')
    expect(
      probeWriteAction({
        targets: [target],
        contentHash: sha256('authorized content'),
      }),
    ).toEqual({ resolution: 'succeeded', matched: [target], missing: [] })
    expect(
      probeWriteAction({
        targets: [target],
        contentHash: sha256('different content'),
      }),
    ).toEqual({ resolution: 'failed', matched: [], missing: [target] })
  })

  it('verifies per-target hashes for delta writes', () => {
    const directory = workspace()
    const target = join(directory, 'patched.md')
    writeFileSync(target, 'final bytes\n')
    expect(
      probeWriteAction({
        targets: [target],
        targetHashes: { [target]: sha256('final bytes\n') },
      }),
    ).toEqual({ resolution: 'succeeded', matched: [target], missing: [] })
    expect(
      probeWriteAction({
        targets: [target],
        targetHashes: { [target]: sha256('other bytes\n') },
      }),
    ).toEqual({ resolution: 'failed', matched: [], missing: [target] })
  })

  it('treats a missing target as confirmed failure and no declared target as inconclusive', () => {
    const directory = workspace()
    const missing = join(directory, 'absent.md')
    expect(probeWriteAction({ targets: [missing] })).toEqual({
      resolution: 'failed',
      matched: [],
      missing: [missing],
    })
    expect(probeWriteAction({ targets: [] })).toEqual({
      resolution: 'inconclusive',
      matched: [],
      missing: [],
    })
  })
})

describe('automatic action reconciliation', () => {
  it('settles an unknown write from external facts and unblocks the task', () => {
    const store = new PegasStore(':memory:')
    const directory = workspace()
    const target = join(directory, 'settled.md')
    writeFileSync(target, 'landed')
    try {
      const blocked = createUnknownWriteAction(store, target, sha256('landed'))
      const reconciliation = new ActionReconciliation({ store })
      const report = reconciliation.checkOnce()
      expect(report.settled).toHaveLength(1)
      expect(report.settled[0]).toMatchObject({
        actionId: blocked.actionId,
        resolution: 'succeeded',
      })
      const action = store.getAction(blocked.actionId, 'owner')
      expect(action).toMatchObject({
        status: 'reconciled',
        reconciliation: {
          resolution: 'succeeded',
          reconciledBy: 'system:auto-reconciliation',
        },
      })
      expect(action?.reconciliation?.note).toContain(target)
      const reconciledMessages = store.listOutbox('owner').filter(message => {
        const payload = message.payload as { type?: string }
        return payload.type === 'action.reconciled'
      })
      expect(reconciledMessages).toHaveLength(1)
      expect(reconciledMessages[0]?.payload).toMatchObject({
        actionId: blocked.actionId,
        resolution: 'succeeded',
      })
      const again = reconciliation.checkOnce()
      expect(again.settled).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('settles a missing target as failed and keeps the task blocked', () => {
    const store = new PegasStore(':memory:')
    const directory = workspace()
    const target = join(directory, 'never-written.md')
    try {
      const blocked = createUnknownWriteAction(store, target)
      const reconciliation = new ActionReconciliation({ store })
      const report = reconciliation.checkOnce()
      expect(report.settled).toHaveLength(1)
      expect(report.settled[0]).toMatchObject({
        actionId: blocked.actionId,
        resolution: 'failed',
      })
      const action = store.getAction(blocked.actionId, 'owner')
      expect(action).toMatchObject({ status: 'reconciled' })
      expect(action?.reconciliation?.resolution).toBe('failed')
      expect(store.findTask(blocked.taskId, 'owner')).toMatchObject({
        statusReason: 'action_failed',
      })
    } finally {
      store.close()
    }
  })

  it('never probes non-write kinds or content-hash mismatches into success', () => {
    const store = new PegasStore(':memory:')
    const directory = workspace()
    const target = join(directory, 'mismatch.md')
    writeFileSync(target, 'other content')
    try {
      const blocked = createUnknownWriteAction(
        store,
        target,
        sha256('expected content'),
      )
      const reconciliation = new ActionReconciliation({ store })
      const report = reconciliation.checkOnce()
      expect(report.settled[0]).toMatchObject({ resolution: 'failed' })
      expect(store.getAction(blocked.actionId, 'owner')?.status).toBe(
        'reconciled',
      )
    } finally {
      store.close()
    }
  })

  it('leaves unknown non-file actions to human reconciliation', () => {
    const store = new PegasStore(':memory:')
    try {
      const event = store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: { text: '对外发布' },
      }).event
      store.applyRoutingDecision(
        event,
        {
          kind: 'create_task',
          title: '对外发布',
          goal: '对外发布',
          input: '对外发布',
          reason: 'test',
        },
        'echo',
      )
      const claimed = store.claimNextRun('worker-publish')
      if (!claimed) throw new Error('Expected claim')
      const requested = store.requestApproval(
        claimed.run.id,
        claimed.claimToken,
        {
          kind: 'publish.release',
          risk: 'high',
          idempotencyKey: 'publish-auto-1',
          request: { release: 'v1' },
          recoveryPoint: { step: 'before_publish' },
          approval: {
            summary: '发布',
            impact: '对外可见',
            recommendedOptionId: 'approve',
            options: [{ id: 'approve', label: '发布', kind: 'approve' }],
          },
        },
      )
      store.decideApproval(requested.approval.id, 'owner', {
        commandId: 'approve-publish-auto',
        optionId: 'approve',
      })
      const resumed = store.claimNextRun('worker-publish-resumed')
      if (!resumed) throw new Error('Expected resume')
      store.recordActionOutcome(requested.action.id, resumed.claimToken, {
        commandId: 'outcome-publish-auto',
        status: 'unknown',
        result: { providerRequestId: 'request-1' },
      })
      const reconciliation = new ActionReconciliation({ store })
      const report = reconciliation.checkOnce()
      expect(report.settled).toHaveLength(0)
      expect(report.inconclusive).toContain(requested.action.id)
      expect(store.getAction(requested.action.id, 'owner')?.status).toBe(
        'unknown',
      )
    } finally {
      store.close()
    }
  })
})

describe('auto reconciliation rollback guard', () => {
  it('refuses rollback below the auto-settlement schema while system reconciliations exist', () => {
    const directory = workspace()
    const path = join(directory, 'pegas.sqlite')
    const target = join(directory, 'guarded.md')
    writeFileSync(target, 'landed')
    const store = new PegasStore(path)
    const blocked = createUnknownWriteAction(store, target)
    store.close()
    expect(() => assertRollbackCompatible(path, 43)).not.toThrow()
    const reopened = new PegasStore(path)
    reopened.reconcileAction(blocked.actionId, 'owner', {
      commandId: 'manual-before-auto',
      resolution: 'succeeded',
      note: '人工核对在先',
    })
    reopened.close()
    expect(() => assertRollbackCompatible(path, 43)).not.toThrow()
    const second = new PegasStore(path)
    const anotherTarget = join(directory, 'guarded-2.md')
    writeFileSync(anotherTarget, 'landed')
    const other = createUnknownWriteAction(second, anotherTarget)
    second.reconcileAction(other.actionId, 'system:auto-reconciliation', {
      commandId: `auto-reconcile:${other.actionId}`,
      resolution: 'succeeded',
      note: '自动探测确认目标已存在。',
    })
    second.close()
    expect(() => assertRollbackCompatible(path, 43)).toThrow(
      RollbackCompatibilityError,
    )
  })
})
