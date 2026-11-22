import { describe, expect, it } from 'vitest'

import type { InboxEvent } from '../src/core/domain.js'
import type { ActionRequestDraft } from '../src/approval/approval.js'
import type { GoalContractDraft } from '../src/goal/goal-delivery.js'
import type { JsonModelProvider } from '../src/model/provider.js'
import { ModelTaskRouter } from '../src/router/router.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

describe('ROUTE-003 routing candidates', () => {
  it('excludes completed and cancelled tasks from main-conversation candidates', () => {
    const store = new PegasStore(':memory:')
    const completed = seedTask(store, '已完成的历史调研')
    completeSeedTask(store, completed)
    const stopped = seedTask(store, '用户停止的任务')
    store.stopTask(stopped.taskId, 'owner', 'stop-1', '不做了')
    const open = seedTask(store, '整理知识库')

    const candidates = store.listRoutingCandidates('owner')

    expect(candidates.map(candidate => candidate.task.id)).toEqual([
      open.taskId,
    ])
    store.close()
  })

  it('keeps every active task visible behind hundreds of completed tasks', () => {
    const store = new PegasStore(':memory:')
    for (let index = 0; index < 300; index += 1) {
      const seeded = seedTask(store, `历史任务 ${String(index)}`)
      completeSeedTask(store, seeded)
    }
    const activeIds: string[] = []
    for (let index = 0; index < 3; index += 1) {
      activeIds.push(seedTask(store, `活跃任务 ${String(index)}`).taskId)
    }

    const candidates = store.listRoutingCandidates('owner')

    expect(candidates).toHaveLength(3)
    expect(candidates.map(candidate => candidate.task.id).sort()).toEqual(
      [...activeIds].sort(),
    )
    store.close()
  })

  it('orders waiting-on-user tasks before recently updated plain tasks', () => {
    const store = new PegasStore(':memory:')
    const waiting = seedTask(store, '高风险发布')
    const claimed = store.claimNextRun('worker-1')
    if (!claimed) throw new Error('Expected the Run claim')
    store.requestApproval(
      waiting.runId,
      claimed.claimToken,
      approvalDraft('publish-1'),
    )
    const plain = seedTask(store, '刚更新的普通任务')

    const candidates = store.listRoutingCandidates('owner')

    expect(candidates.map(candidate => candidate.task.id)).toEqual([
      waiting.taskId,
      plain.taskId,
    ])
    expect(candidates[0]?.awaiting).toContain('Publish release v1')
    store.close()
  })

  it('derives awaiting, lastDelivery and recentInput from authoritative facts', () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, '设计首页')
    continueTask(store, seeded.taskId, '标题用无衬线还是衬线？')
    const claimed = store.claimNextRun('worker-1')
    if (!claimed) throw new Error('Expected the Run claim')
    store.completeRun(seeded.runId, 'worker-1', {
      executorRef: 'session-1',
      output: '第一版首页已完成\n剩余细节待确认',
    })
    continueTask(store, seeded.taskId, '补充：面向移动端')
    const nextClaimed = store.claimNextRun('worker-1')
    if (!nextClaimed) throw new Error('Expected the second Run claim')
    store.proposeGoalFromRun(
      nextClaimed.run.id,
      nextClaimed.claimToken,
      'proposal-clarify',
      goalDraft([seeded.eventId], '交付首页设计', [
        { question: '标题用衬线还是无衬线？', blocking: true },
      ]),
    )

    const candidate = store
      .listRoutingCandidates('owner')
      .find(entry => entry.task.id === seeded.taskId)

    expect(candidate?.awaiting).toContain('标题用衬线还是无衬线？')
    expect(candidate?.lastDelivery).toBe('第一版首页已完成')
    expect(candidate?.recentInput).toBe('补充：面向移动端')
    store.close()
  })

  it('routes the main conversation only against open candidates', async () => {
    const store = new PegasStore(':memory:')
    const completed = seedTask(store, '已完成的历史调研')
    completeSeedTask(store, completed)
    seedTask(store, '整理知识库')
    const provider = new CapturingProvider({
      kind: 'create_task',
      taskId: '',
      title: '新的独立想法',
      goal: '新的独立想法',
      reason: '与历史任务无关',
    })
    const handler = new RoutingEventHandler(
      new ModelTaskRouter({ provider }),
      'echo-test',
    )
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '帮我研究一个新的独立想法' },
    })

    await processNextEvent(store, handler, 'router-1')

    expect(provider.input).not.toContain(completed.taskId)
    expect(provider.input).not.toContain('已完成的历史调研')
    store.close()
  })

  it('F1 regression: a misrouted completed target never rejects the user input', async () => {
    const store = new PegasStore(':memory:')
    const completed = seedTask(store, '已完成的历史调研')
    completeSeedTask(store, completed)
    seedTask(store, '整理知识库')
    const provider = new StubProvider({
      kind: 'continue_task',
      taskId: completed.taskId,
      reason: '误把新想法当成旧任务续接',
    })
    const handler = new RoutingEventHandler(
      new ModelTaskRouter({ provider }),
      'echo-test',
    )
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '帮我研究一个新的独立想法' },
    }).event

    await processNextEvent(store, handler, 'router-1')

    const processed = store
      .listEvents('owner')
      .find(candidate => candidate.id === event.id)
    expect(processed?.status).toBe('processed')
    expect(processed?.lastError).toBeUndefined()
    const tasks = store.listTasks('owner')
    expect(
      tasks.some(
        task =>
          task.id !== completed.taskId &&
          task.title === '帮我研究一个新的独立想法',
      ),
    ).toBe(true)
    expect(store.findTask(completed.taskId, 'owner')?.status).toBe('completed')
    expect(store.listRuns(completed.taskId)).toHaveLength(1)
    store.close()
  })

  it('keeps the explicit completed-task resume path on mandate revalidation', () => {
    const store = new PegasStore(':memory:')
    const completed = seedTask(store, '完成后继续')
    completeSeedTask(store, completed)
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '在刚才结果上再补一段', taskId: completed.taskId },
    })
    const claimed = store.claimNextEvent('router-2')
    if (!claimed) throw new Error('Expected the follow-up claim')

    const applied = store.applyRoutingDecision(
      claimed,
      {
        kind: 'continue_task',
        taskId: completed.taskId,
        input: '在刚才结果上再补一段',
        reason: '显式引用',
      },
      'echo-test',
    )

    expect(applied.run.status).toBe('queued')
    expect(store.findTask(completed.taskId, 'owner')?.status).not.toBe(
      'completed',
    )
    store.close()
  })

  it('shares the open-candidate semantics with handback routing', async () => {
    const store = new PegasStore(':memory:')
    const completed = seedTask(store, '已完成的历史调研')
    completeSeedTask(store, completed)
    const source = seedTask(store, '来源任务')
    seedTask(store, '另一个开放任务')
    const provider = new CapturingProvider({
      kind: 'create_task',
      taskId: '',
      title: '退回的新想法',
      goal: '退回的新想法',
      reason: '不属于来源目标',
    })
    const candidates = store.listRoutingCandidates('owner', {
      excludeTaskId: source.taskId,
    })

    expect(candidates.map(candidate => candidate.task.id)).not.toContain(
      completed.taskId,
    )
    expect(candidates.map(candidate => candidate.task.id)).not.toContain(
      source.taskId,
    )
    await new ModelTaskRouter({ provider }).route(
      {
        ...message('退回的新想法'),
        userId: 'owner',
      },
      candidates.map(candidate => candidate.task),
    )
    expect(provider.input).not.toContain(completed.taskId)
    store.close()
  })
})

class StubProvider implements JsonModelProvider {
  readonly name = 'stub'
  readonly #answer: unknown

  constructor(answer: unknown) {
    this.#answer = answer
  }

  generateJson(): Promise<unknown> {
    return Promise.resolve(this.#answer)
  }
}

class CapturingProvider implements JsonModelProvider {
  readonly name = 'capturing-stub'
  input = ''
  readonly #answer: unknown

  constructor(answer: unknown) {
    this.#answer = answer
  }

  generateJson(request: { input: string }): Promise<unknown> {
    this.input = request.input
    return Promise.resolve(this.#answer)
  }
}

function message(text: string): InboxEvent {
  return {
    id: 'event-routing-candidates',
    userId: 'user-1',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
    status: 'pending',
    attempts: 0,
    createdAt: '2026-11-21T00:00:00.000Z',
  }
}

function seedTask(
  store: PegasStore,
  text: string,
): { eventId: string; taskId: string; runId: string } {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text },
  }).event
  const claimedEvent = store.claimNextEvent('setup-worker')
  if (claimedEvent?.id !== event.id)
    throw new Error('Expected the setup event claim')
  const created = store.applyRoutingDecision(
    claimedEvent,
    { kind: 'create_task', title: text, goal: text, input: text, reason: 't' },
    'echo-test',
  )
  store.completeEvent(event.id, 'setup-worker')
  return { eventId: event.id, taskId: created.task.id, runId: created.run.id }
}

function completeSeedTask(
  store: PegasStore,
  seeded: { taskId: string; runId: string },
): void {
  for (;;) {
    const claimed = store.claimNextRun('worker-seed')
    if (!claimed) throw new Error('Expected the seeded Run claim')
    if (claimed.run.taskId !== seeded.taskId) {
      throw new Error('Claimed a Run from another Task')
    }
    store.completeRun(claimed.run.id, 'worker-seed', {
      executorRef: 'session-seed',
      output: 'done',
    })
    if (claimed.run.id === seeded.runId) return
  }
}

function continueTask(
  store: PegasStore,
  taskId: string,
  text: string,
): { eventId: string; runId: string } {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text, taskId },
  }).event
  const claimedEvent = store.claimNextEvent('setup-worker')
  if (claimedEvent?.id !== event.id)
    throw new Error('Expected the setup event claim')
  const continued = store.applyRoutingDecision(
    claimedEvent,
    { kind: 'continue_task', taskId, input: text, reason: 't' },
    'echo-test',
  )
  store.completeEvent(event.id, 'setup-worker')
  return { eventId: event.id, runId: continued.run.id }
}

function approvalDraft(key: string): ActionRequestDraft {
  return {
    kind: 'publish.release',
    risk: 'high',
    idempotencyKey: key,
    request: { release: 'v1' },
    recoveryPoint: { step: 'before_publish' },
    approval: {
      summary: 'Publish release v1',
      impact: '对外发布不可逆',
      options: [
        { id: 'approve', label: '批准', kind: 'approve' },
        { id: 'reject', label: '拒绝', kind: 'reject' },
      ],
      recommendedOptionId: 'reject',
    },
  }
}

function goalDraft(
  eventIds: string[],
  desiredOutcome: string,
  unknowns: { question: string; blocking: boolean }[] = [],
): GoalContractDraft {
  return {
    basedOnEventIds: eventIds,
    desiredOutcome,
    beneficiaries: ['owner'],
    successCriteria: [
      {
        criterionId: 'criterion-1',
        observableStatement: 'The final result is available and verified.',
        required: true,
        evidencePlanRef: 'plan-1',
      },
    ],
    nonGoals: [],
    constraints: [],
    contextSources: eventIds.map(sourceRef => ({
      sourceRef,
      freshness: 'current',
      authority: 'user',
      conflictPriority: 0,
    })),
    assumptions: [],
    unknowns,
    prerequisites: [],
    permissionBoundary: { externalWrites: false },
    reviewCheckpoints: ['final'],
    evidencePlan: [
      {
        id: 'plan-1',
        criterionId: 'criterion-1',
        acceptedKinds: ['observation'],
        acceptedTrustClasses: ['control-plane', 'independent', 'user'],
        minimumCount: 1,
        presentation: 'inline',
      },
    ],
    failureAndRecovery: '失败后保留现场并等待用户决定',
    feedbackSignals: [],
  }
}
