import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import { DshCliExecutor } from '../src/executor/dsh-cli-executor.js'
import type { GoalContractDraft } from '../src/goal/goal-delivery.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('GOAL-001 executor goal formation', () => {
  it('attaches a proposed Goal to a queued latest Run without a successor', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const seeded = seedTask(store, '把知识库整理好')
    const claimed = store.claimNextRun('worker-proposal')
    if (claimed?.run.id !== seeded.runId)
      throw new Error('Expected the first Run to be claimed')
    const second = continueTask(store, seeded.taskId, '顺便加上检索')

    const result = store.proposeGoalFromRun(
      claimed.run.id,
      claimed.claimToken,
      'proposal-queued-rebind',
      goalDraft([seeded.eventId, second.eventId], '整理并支持检索的知识库'),
    )

    expect(result.waitingOnClarification).toBe(false)
    expect(result.contract.revision).toBe(1)
    const runs = store.listRuns(seeded.taskId)
    expect(runs).toHaveLength(2)
    // The executing Run predates any Goal and keeps working; only the queued
    // latest Run is rebound to the new revision.
    expect(runs[0]).toMatchObject({
      id: seeded.runId,
      status: 'running',
    })
    expect(runs[0]?.goalRevision).toBeUndefined()
    expect(runs[1]).toMatchObject({
      id: second.runId,
      status: 'queued',
      goalRevision: 1,
    })
    expect(
      store.listOutbox('owner').map(message => message.dedupeKey),
    ).not.toContain(`goal-clarification:${result.contract.id}`)
  })

  it('supersedes a bound running Run with a queued successor revision', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const seeded = seedTask(store, '交付第一版')
    store.createGoalContract(
      seeded.taskId,
      'owner',
      'initial-goal',
      goalDraft([seeded.eventId], '第一版结果'),
    )
    const claimed = store.claimNextRun('worker-bound-proposal')
    if (!claimed) throw new Error('Expected a claimed Run')

    const result = store.proposeGoalFromRun(
      claimed.run.id,
      claimed.claimToken,
      'proposal-bound-roll',
      goalDraft([seeded.eventId], '修订后的可验收结果'),
    )

    expect(result.contract.revision).toBe(2)
    const runs = store.listRuns(seeded.taskId)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({
      id: seeded.runId,
      status: 'cancelled',
      lastError: 'superseded_by_goal_revision:2',
    })
    expect(runs[1]).toMatchObject({
      status: 'queued',
      goalRevision: 2,
      retryOfRunId: seeded.runId,
      input: '修订后的可验收结果',
    })
  })

  it('parks the Task on blocking unknowns and resumes only after user input', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const seeded = seedTask(store, '帮我处理那个方案')
    const claimed = store.claimNextRun('worker-clarification')
    if (!claimed) throw new Error('Expected a claimed Run')
    const draft = goalDraft([seeded.eventId], '明确后的方案结果')
    draft.unknowns = [
      { question: '方案要发布到哪个环境？', blocking: true },
      { question: '是否需要抄送团队？', blocking: false },
    ]

    const result = store.proposeGoalFromRun(
      claimed.run.id,
      claimed.claimToken,
      'proposal-blocking',
      draft,
    )

    expect(result.waitingOnClarification).toBe(true)
    const runs = store.listRuns(seeded.taskId)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      id: seeded.runId,
      status: 'running',
      goalRevision: 1,
    })
    expect(store.findTask(seeded.taskId, 'owner')).toMatchObject({
      status: 'started',
      statusReason: 'awaiting_goal_clarification',
    })
    const clarification = store
      .listOutbox('owner')
      .find(
        message =>
          message.dedupeKey === `goal-clarification:${result.contract.id}`,
      )
    expect(clarification?.payload).toMatchObject({
      type: 'goal.clarification_required',
      taskId: seeded.taskId,
      goalRevision: 1,
      questions: ['方案要发布到哪个环境？'],
    })
    expect(store.claimNextRun('worker-should-wait')).toBeUndefined()

    // The Executor ends its turn after submitting; the Run parks instead of
    // entering the evidence-reporting phase.
    store.completeRun(claimed.run.id, 'worker-clarification', {
      executorRef: 'session-clarification',
      output: '已提交目标，等待用户澄清。',
    })
    expect(store.listRuns(seeded.taskId)[0]).toMatchObject({
      status: 'cancelled',
      lastError: 'awaiting_goal_clarification',
    })
    expect(store.findTask(seeded.taskId, 'owner')).toMatchObject({
      status: 'started',
      statusReason: 'awaiting_goal_clarification',
    })
    expect(store.claimNextRun('worker-still-wait')).toBeUndefined()

    // The frozen proposal response replays even though the Run is cancelled.
    expect(
      store.proposeGoalFromRun(
        claimed.run.id,
        claimed.claimToken,
        'proposal-blocking',
        draft,
      ),
    ).toEqual(result)

    const answer = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '发布到 staging，不用抄送', taskId: seeded.taskId },
    }).event
    const routed = store.applyRoutingDecision(
      answer,
      {
        kind: 'continue_task',
        taskId: seeded.taskId,
        input: '发布到 staging，不用抄送',
        reason: 'User answered the blocking clarification.',
      },
      'echo',
    )
    expect(routed.run).toMatchObject({ status: 'queued', goalRevision: 1 })
    const resumed = store.claimNextRun('worker-answer')
    expect(resumed?.run.id).toBe(routed.run.id)
    expect(store.findTask(seeded.taskId, 'owner')?.statusReason).toBeUndefined()
  })

  it('replays the frozen response and rejects a conflicting payload', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const seeded = seedTask(store, '重放测试')
    const claimed = store.claimNextRun('worker-replay')
    if (!claimed) throw new Error('Expected a claimed Run')
    const draft = goalDraft([seeded.eventId], '重放结果')
    const first = store.proposeGoalFromRun(
      claimed.run.id,
      claimed.claimToken,
      'proposal-replay',
      draft,
    )
    expect(
      store.proposeGoalFromRun(
        claimed.run.id,
        claimed.claimToken,
        'proposal-replay',
        draft,
      ),
    ).toEqual(first)
    expect(store.listRuns(seeded.taskId)).toHaveLength(1)
    expect(() =>
      store.proposeGoalFromRun(
        claimed.run.id,
        claimed.claimToken,
        'proposal-replay',
        goalDraft([seeded.eventId], '不同的结果'),
      ),
    ).toThrow(/already used with a different Goal/)
  })

  it('rejects proposals without a live claim, on non-running Runs and closed Tasks', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const seeded = seedTask(store, '边界测试')
    const draft = goalDraft([seeded.eventId], '边界结果')
    expect(() =>
      store.proposeGoalFromRun(seeded.runId, 'forged-claim', 'forged', draft),
    ).toThrow(/claim capability/)
    const claimed = store.claimNextRun('worker-boundary')
    if (!claimed) throw new Error('Expected a claimed Run')
    expect(() =>
      store.proposeGoalFromRun(seeded.runId, 'wrong-claim', 'wrong', draft),
    ).toThrow(/claim capability/)

    store.stopTask(seeded.taskId, 'owner', 'stop-boundary')
    expect(() =>
      store.proposeGoalFromRun(
        claimed.run.id,
        claimed.claimToken,
        'after-stop',
        draft,
      ),
    ).toThrow(/claim capability/)
  })

  it('rejects unknown source events from another Task', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const seeded = seedTask(store, '来源测试')
    const other = seedTask(store, '另一件事情')
    const claimed = store.claimNextRun('worker-source')
    if (!claimed) throw new Error('Expected a claimed Run')
    expect(() =>
      store.proposeGoalFromRun(
        claimed.run.id,
        claimed.claimToken,
        'foreign-source',
        goalDraft([other.eventId], '不应接受'),
      ),
    ).toThrow(/not a source for this Task/)
    expect(store.listRuns(seeded.taskId)).toHaveLength(1)
  })

  it('serves capability-authenticated proposals over HTTP with replay after claim rotation', async () => {
    const store = new PegasStore(':memory:')
    const seeded = seedTask(store, 'HTTP 提案')
    const claimed = store.claimNextRun('worker-http-proposal')
    if (!claimed) throw new Error('Expected a claimed Run')
    const server = createControlPlane({ store, apiToken: 'owner-token' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => store.close(),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const url = `${base}/v1/runs/${seeded.runId}/goal-proposals`
    const draft = goalDraft([seeded.eventId], 'HTTP 提案结果')
    const body = JSON.stringify({ commandId: 'http-proposal', goal: draft })

    // No claim header: rejected before the body is even required.
    const missing = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(missing.status).toBe(403)
    expect(await missing.json()).toMatchObject({ error: 'run_claim_required' })

    const wrong = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pegas-run-claim-token': 'not-the-claim',
      },
      body,
    })
    expect(wrong.status).toBe(403)
    expect(await wrong.json()).toMatchObject({ error: 'run_claim_invalid' })

    const created = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pegas-run-claim-token': claimed.claimToken,
      },
      body,
    })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as {
      contract: { id: string; revision: number }
      waitingOnClarification: boolean
    }
    expect(createdBody).toMatchObject({ waitingOnClarification: false })
    expect(createdBody.contract.revision).toBe(1)

    // Expire the lease so the live claim is no longer valid; the original
    // capability can still replay its own frozen command response.
    store.renewRunLease(seeded.runId, 'worker-http-proposal', -1)
    expect(() =>
      store.assertGoalProposalCapability(seeded.runId, 'not-the-claim'),
    ).toThrow(/claim capability/)
    store.assertGoalProposalCapability(seeded.runId, claimed.claimToken)
    const replay = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pegas-run-claim-token': claimed.claimToken,
      },
      body,
    })
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(createdBody)

    const conflict = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pegas-run-claim-token': claimed.claimToken,
      },
      body: JSON.stringify({
        commandId: 'http-proposal',
        goal: goalDraft([seeded.eventId], '冲突的结果'),
      }),
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      error: 'goal_proposal_command_conflict',
    })
  })

  it('runs the DSH goal-proposal contract end to end with blocking clarification', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-goal-dsh-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const command = join(directory, 'dsh')
    writeFileSync(command, fakeGoalProposalDshSource(), { mode: 0o700 })
    chmodSync(command, 0o700)
    const store = new PegasStore(':memory:')
    const handler = new RoutingEventHandler(new RuleBasedTaskRouter(), 'dsh')
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '帮我做一个模糊的方案' },
    })
    await processNextEvent(store, handler, 'worker-goal-dsh')
    const task = store.listTasks('owner')[0]
    if (!task) throw new Error('Expected a Task')
    const claimed = store.claimNextRun('worker-goal-dsh')
    if (!claimed) throw new Error('Expected a claimed Run')
    const server = createControlPlane({ store, apiToken: 'owner-token' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => store.close(),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

    await executeClaimedRun(
      store,
      new DshCliExecutor({ command }),
      claimed,
      'worker-goal-dsh',
      process.cwd(),
      new AbortController().signal,
      base,
    )

    const goal = store.currentGoalContract(task.id, 'owner')
    expect(goal?.revision).toBe(1)
    expect(goal?.unknowns).toEqual([
      { question: '结果要交付到哪里？', blocking: true },
    ])
    expect(store.findTask(task.id, 'owner')).toMatchObject({
      status: 'started',
      statusReason: 'awaiting_goal_clarification',
    })
    expect(store.listRuns(task.id).at(-1)).toMatchObject({
      status: 'cancelled',
      lastError: 'awaiting_goal_clarification',
    })
    expect(store.claimNextRun('worker-goal-wait')).toBeUndefined()
    const outbox = store
      .listOutbox('owner')
      .find(
        message =>
          (message.payload as { type?: string }).type ===
          'goal.clarification_required',
      )
    expect(outbox?.payload).toMatchObject({
      type: 'goal.clarification_required',
      questions: ['结果要交付到哪里？'],
    })

    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '交付到本地目录就行', taskId: task.id },
    })
    await processNextEvent(store, handler, 'worker-goal-answer')
    const resumed = store.claimNextRun('worker-goal-answer')
    expect(resumed?.run.goalRevision).toBe(1)
    expect(resumed?.run.input).toBe('交付到本地目录就行')
  })
})

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
  const created = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: text,
      goal: text,
      input: text,
      reason: 'GOAL-001 proposal test',
    },
    'echo',
  )
  return { eventId: event.id, taskId: created.task.id, runId: created.run.id }
}

function continueTask(
  store: PegasStore,
  taskId: string,
  text: string,
): { eventId: string; runId: string } {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'automation',
    authenticatedActor: 'human',
    payload: { text, taskId },
  }).event
  const continued = store.applyRoutingDecision(
    event,
    {
      kind: 'continue_task',
      taskId,
      input: text,
      reason: 'GOAL-001 proposal continuation',
    },
    'echo',
  )
  return { eventId: event.id, runId: continued.run.id }
}

function goalDraft(
  eventIds: string[],
  desiredOutcome: string,
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
    unknowns: [],
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
    failureAndRecovery: 'Keep the Task open and request valid evidence.',
    feedbackSignals: ['user_acceptance'],
  }
}

function fakeGoalProposalDshSource(): string {
  return `#!/usr/bin/env node
async function main() {
let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
const baseUrl = process.env.PEGAS_CONTROL_PLANE_URL
const runId = process.env.PEGAS_RUN_ID
const claimToken = process.env.PEGAS_RUN_CLAIM_TOKEN
const eventId = process.env.PEGAS_INPUT_EVENT_ID
if (!baseUrl || !runId || !claimToken || !eventId)
  throw new Error('missing capability')
const goal = {
  basedOnEventIds: [eventId],
  desiredOutcome: '交付明确的方案结果',
  beneficiaries: ['owner'],
  successCriteria: [{
    criterionId: 'result',
    observableStatement: '方案结果在目标位置可见',
    required: true,
    evidencePlanRef: 'plan-result'
  }],
  nonGoals: [],
  constraints: [],
  contextSources: [{
    sourceRef: eventId,
    freshness: 'current',
    authority: 'user',
    conflictPriority: 0
  }],
  assumptions: [],
  unknowns: [{ question: '结果要交付到哪里？', blocking: true }],
  prerequisites: [],
  permissionBoundary: { externalWrites: false },
  reviewCheckpoints: ['final'],
  evidencePlan: [{
    id: 'plan-result',
    criterionId: 'result',
    acceptedKinds: ['observation'],
    acceptedTrustClasses: ['control-plane', 'user'],
    minimumCount: 1,
    presentation: 'inline'
  }],
  failureAndRecovery: '等待用户澄清后继续',
  feedbackSignals: ['user_acceptance']
}
const body = JSON.stringify({ commandId: 'fake-dsh-goal', goal })
for (let attempt = 0; attempt < 2; attempt += 1) {
  const response = await fetch(baseUrl + '/v1/runs/' + runId + '/goal-proposals', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-pegas-run-claim-token': claimToken
    },
    body
  })
  if (!response.ok) throw new Error('goal proposal failed: ' + response.status)
  const result = await response.json()
  if (result.waitingOnClarification !== true)
    throw new Error('expected blocking clarification')
}
console.log(JSON.stringify({
  type: 'final',
  sessionId: 'session-goal-proposal',
  text: '已提交目标并等待用户澄清',
  reason: { kind: 'completed' }
}))
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
`
}
