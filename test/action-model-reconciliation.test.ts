import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ActionReconciliation } from '../src/observability/action-reconciliation.js'
import type {
  ModelReconciliationInput,
  ModelReconciliationVerdict,
} from '../src/observability/action-reconciliation.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-model-recon-'))
  temporaryDirectories.push(directory)
  return directory
}

function createUnknownBashAction(
  store: PegasStore,
  input: {
    goal: string
    command: string
    targets: string[]
    category?: string
    tool?: string
  },
) {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: input.goal },
  }).event
  const created = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: input.goal,
      goal: input.goal,
      input: input.goal,
      reason: 'model reconciliation test',
    },
    'dsh-headless',
  )
  const claimed = store.claimNextRun('worker-model-request')
  if (!claimed) throw new Error('Expected a claimed Run')
  const tool = input.tool ?? 'bash'
  const requested = store.requestApproval(claimed.run.id, claimed.claimToken, {
    kind: `dsh.tool.${tool}`,
    risk: 'high',
    idempotencyKey: `model-bash-${created.task.id}`,
    request: {
      tool,
      callId: 'call-model-1',
      category: input.category ?? 'out-of-workspace-write',
      targets: input.targets,
      argumentsHash: 'a'.repeat(64),
      command: input.command,
    },
    recoveryPoint: { step: 'before_tool_call', callId: 'call-model-1' },
    approval: {
      summary: '批准复杂命令写入',
      impact: '写入工作区之外',
      recommendedOptionId: 'approve',
      options: [
        { id: 'approve', label: '批准执行一次', kind: 'approve' },
        { id: 'reject', label: '不执行', kind: 'reject' },
      ],
    },
  })
  store.decideApproval(requested.approval.id, 'owner', {
    commandId: `approve-model-${created.task.id}`,
    optionId: 'approve',
  })
  const resumed = store.claimNextRun('worker-model-resumed')
  if (!resumed) throw new Error('Expected resumed Run')
  store.recordActionOutcome(requested.action.id, resumed.claimToken, {
    commandId: `outcome-model-${created.task.id}`,
    status: 'unknown',
    result: { reason: 'executor_completed_without_outcome' },
  })
  return {
    taskId: created.task.id,
    actionId: requested.action.id,
  }
}

function verdictJudge(
  verdict: ModelReconciliationVerdict,
  seen?: ModelReconciliationInput[],
): (input: ModelReconciliationInput) => Promise<ModelReconciliationVerdict> {
  return input => {
    seen?.push(input)
    return Promise.resolve(verdict)
  }
}

describe('model-assisted reconciliation for complex bash writes', () => {
  it('settles a fingerprint-less bash unknown as succeeded from a strict model verdict', async () => {
    const store = new PegasStore(':memory:')
    const directory = workspace()
    const target = join(directory, 'out.txt')
    writeFileSync(target, 'transformed line\n')
    const seen: ModelReconciliationInput[] = []
    try {
      const blocked = createUnknownBashAction(store, {
        goal: `把 input.txt 过滤后追加到 ${target}`,
        command: `cat input.txt | sed 's/a/b/' >> ${target}`,
        targets: [target],
      })
      const reconciliation = new ActionReconciliation({
        store,
        judge: verdictJudge(
          {
            resolution: 'succeeded',
            reason: '目标文件已存在且内容包含过滤后的行，符合命令预期效果。',
          },
          seen,
        ),
      })
      const report = await reconciliation.checkOnce()
      expect(report.settled).toEqual([
        { actionId: blocked.actionId, resolution: 'succeeded' },
      ])
      expect(seen).toHaveLength(1)
      expect(seen[0]?.command).toContain('sed')
      expect(seen[0]?.goal).toContain(target)
      expect(seen[0]?.targets[0]).toMatchObject({ path: target, exists: true })
      expect(seen[0]?.targets[0]?.content).toContain('transformed line')
      const action = store.getAction(blocked.actionId, 'owner')
      expect(action).toMatchObject({
        status: 'reconciled',
        reconciliation: {
          resolution: 'succeeded',
          reconciledBy: 'system:auto-reconciliation',
        },
      })
      expect(action?.reconciliation?.note).toContain('模型判定')
      expect(action?.reconciliation?.note).toContain('过滤后的行')
      const again = await reconciliation.checkOnce()
      expect(again.settled).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('settles a model-confirmed failure and keeps the task blocked', async () => {
    const store = new PegasStore(':memory:')
    const directory = workspace()
    const target = join(directory, 'never.txt')
    try {
      const blocked = createUnknownBashAction(store, {
        goal: `把 input.txt 过滤后追加到 ${target}`,
        command: `cat input.txt | sed 's/a/b/' >> ${target}`,
        targets: [target],
      })
      const reconciliation = new ActionReconciliation({
        store,
        judge: verdictJudge({
          resolution: 'failed',
          reason: '目标文件不存在，写入未发生。',
        }),
      })
      const report = await reconciliation.checkOnce()
      expect(report.settled).toEqual([
        { actionId: blocked.actionId, resolution: 'failed' },
      ])
      expect(store.getAction(blocked.actionId, 'owner')?.status).toBe(
        'reconciled',
      )
      expect(store.findTask(blocked.taskId, 'owner')).toMatchObject({
        statusReason: 'action_failed',
      })
    } finally {
      store.close()
    }
  })

  it('keeps the action unknown when the model is inconclusive', async () => {
    const store = new PegasStore(':memory:')
    const directory = workspace()
    const target = join(directory, 'maybe.txt')
    writeFileSync(target, 'ambiguous\n')
    try {
      const blocked = createUnknownBashAction(store, {
        goal: `处理数据并写入 ${target}`,
        command: `./process.sh | tee ${target}`,
        targets: [target],
      })
      const reconciliation = new ActionReconciliation({
        store,
        judge: verdictJudge({
          resolution: 'inconclusive',
          reason: '无法从现有内容确认脚本是否已按预期执行。',
        }),
      })
      const report = await reconciliation.checkOnce()
      expect(report.settled).toHaveLength(0)
      expect(report.inconclusive).toContain(blocked.actionId)
      expect(store.getAction(blocked.actionId, 'owner')?.status).toBe('unknown')
    } finally {
      store.close()
    }
  })

  it('never settles when the judge throws or returns a malformed verdict', async () => {
    const store = new PegasStore(':memory:')
    const directory = workspace()
    const target = join(directory, 'broken.txt')
    writeFileSync(target, 'content\n')
    try {
      const blocked = createUnknownBashAction(store, {
        goal: `处理数据并写入 ${target}`,
        command: `cat src.txt | awk '{print $1}' >> ${target}`,
        targets: [target],
      })
      const failing = new ActionReconciliation({
        store,
        judge: () => Promise.reject(new Error('model unavailable')),
      })
      expect((await failing.checkOnce()).settled).toHaveLength(0)
      const malformed = new ActionReconciliation({
        store,
        judge: () =>
          Promise.resolve({
            resolution: 'succeeded',
          } as unknown as ModelReconciliationVerdict),
      })
      expect((await malformed.checkOnce()).settled).toHaveLength(0)
      expect(store.getAction(blocked.actionId, 'owner')?.status).toBe('unknown')
    } finally {
      store.close()
    }
  })

  it('never judges actions without a recorded command or outside write categories', async () => {
    const store = new PegasStore(':memory:')
    const directory = workspace()
    const target = join(directory, 'elsewhere.txt')
    writeFileSync(target, 'content\n')
    let judgeCalls = 0
    try {
      const network = createUnknownBashAction(store, {
        goal: '对外发送数据',
        command: `curl -T ${target} https://example.com/upload`,
        targets: [],
        category: 'network-egress',
      })
      const writeBlocked = createUnknownBashAction(store, {
        goal: `写入 ${target}`,
        command: `cat a.txt | tr a-z A-Z >> ${target}`,
        targets: [target],
        tool: 'write',
      })
      const reconciliation = new ActionReconciliation({
        store,
        judge: () => {
          judgeCalls += 1
          return Promise.resolve({
            resolution: 'succeeded' as const,
            reason: '不该被调用',
          })
        },
      })
      const report = await reconciliation.checkOnce()
      expect(report.inconclusive).toContain(network.actionId)
      expect(report.settled).toContainEqual({
        actionId: writeBlocked.actionId,
        resolution: 'succeeded',
      })
      expect(judgeCalls).toBe(0)
    } finally {
      store.close()
    }
  })

  it('does not judge when no judge is configured', async () => {
    const store = new PegasStore(':memory:')
    const directory = workspace()
    const target = join(directory, 'no-judge.txt')
    try {
      const blocked = createUnknownBashAction(store, {
        goal: `写入 ${target}`,
        command: `cat a.txt | tr a-z A-Z >> ${target}`,
        targets: [target],
      })
      const reconciliation = new ActionReconciliation({ store })
      const report = await reconciliation.checkOnce()
      expect(report.settled).toHaveLength(0)
      expect(report.inconclusive).toContain(blocked.actionId)
      expect(store.getAction(blocked.actionId, 'owner')?.status).toBe('unknown')
    } finally {
      store.close()
    }
  })
})
