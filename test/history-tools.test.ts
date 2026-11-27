import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type { ClaimedRun } from '../src/core/domain.js'
import { loadConfig } from '../src/core/config.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import type { HistoryToolDefinition } from '../src/executor/dsh-history-tools.d.ts'
import {
  historyTools,
  normalizeCapability,
} from '../src/executor/dsh-history-tools.mjs'
import { PegasStore, RunClaimError } from '../src/storage/sqlite-store.js'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function seedWorkRun(
  store: PegasStore,
  userId: string,
  title: string,
  output?: string,
): ClaimedRun {
  const event = store.enqueueEvent({
    userId,
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: title },
  }).event
  const claimedEvent = store.claimNextEvent('setup')
  if (!claimedEvent) throw new Error('Expected event claim')
  store.applyRoutingDecision(
    claimedEvent,
    { kind: 'create_task', title, goal: title, input: title, reason: 'test' },
    'dsh-headless',
  )
  store.completeEvent(event.id, 'setup')
  const claimed = store.claimNextRun('worker')
  if (!claimed) throw new Error('Expected Run claim')
  if (output !== undefined) {
    store.completeRun(claimed.run.id, 'worker', {
      executorRef: 'session',
      output,
    })
    // completeRun releases the claim; re-claim a follow-up Run on the same
    // task so the capability stays live for the read.
    const followUp = store.enqueueEvent({
      userId,
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '继续', taskId: claimed.task.id },
    }).event
    const followUpClaim = store.claimNextEvent('setup')
    if (!followUpClaim) throw new Error('Expected follow-up event claim')
    store.applyRoutingDecision(
      followUpClaim,
      {
        kind: 'continue_task',
        taskId: claimed.task.id,
        input: '继续',
        reason: 'test',
      },
      'dsh-headless',
    )
    store.completeEvent(followUp.id, 'setup')
    const next = store.claimNextRun('worker')
    if (!next) throw new Error('Expected follow-up Run claim')
    return next
  }
  return claimed
}

describe('MEMORY-001 M5 history retrieval', () => {
  it('caps pending approval summaries and excludes conversation targets', () => {
    const store = new PegasStore(':memory:', {
      clock: { now: () => new Date('2026-11-27T00:00:00Z') },
    })
    cleanups.push(() => store.close())
    store.initializeRuntimeSettings({
      ...runtimeSettingsDefaults(loadConfig({})),
      autoReviewEnabled: true,
      chatLaneEnabled: true,
    })
    const active = seedWorkRun(store, 'owner', 'diagnose approvals')
    const ids: string[] = []
    // Review requests do not park the Run; projection still counts pending facts.
    for (let i = 0; i < 11; i++) {
      const pending = store.requestApproval(active.run.id, active.claimToken, {
        kind: 'dsh.tool.write',
        risk: 'high',
        idempotencyKey: `pending-${String(i)}`,
        request: {
          tool: 'write',
          category: 'out-of-workspace-write',
          targets: ['/tmp/fixture'],
          autoReview: true,
        },
        recoveryPoint: { step: 'before_tool_call' },
        approval: {
          summary: `summary-${String(i)}`,
          impact: 'fixture',
          recommendedOptionId: 'approve',
          options: [
            { id: 'approve', kind: 'approve', label: 'once' },
            { id: 'reject', kind: 'reject', label: 'no' },
          ],
        },
      })
      ids.push(pending.approval.id)
    }
    const projection = store.readTaskStateForRun(
      active.run.id,
      active.claimToken,
      active.task.id,
    )
    expect(projection.approvals.map(approval => approval.id)).toEqual(
      ids.slice(-10).reverse(),
    )
    expect(projection.approvalsTruncated).toBe(true)
    const event = store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: 'hello' },
    }).event
    const conversation = store.applyRoutingDecision(
      event,
      { kind: 'reply', input: 'hello', reason: 'test' },
      'dsh-headless',
    )
    expect(() =>
      store.readTaskStateForRun(
        active.run.id,
        active.claimToken,
        conversation.task.id,
      ),
    ).toThrow()
  })

  it('orders latest task runs by insertion when timestamps tie and caps the projection', () => {
    const store = new PegasStore(':memory:', {
      clock: { now: () => new Date('2026-11-27T00:00:00Z') },
    })
    cleanups.push(() => store.close())
    let active = seedWorkRun(store, 'owner', 'same-clock')
    const ids = [active.run.id]
    for (let i = 0; i < 6; i++) {
      store.completeRun(active.run.id, 'worker', {
        executorRef: 'fixture',
        output: `result-${String(i)}`,
      })
      const event = store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: { text: 'continue', taskId: active.task.id },
      }).event
      const claimed = store.claimNextEvent('setup')
      if (!claimed) throw new Error('Expected event')
      store.applyRoutingDecision(
        claimed,
        {
          kind: 'continue_task',
          taskId: active.task.id,
          input: 'continue',
          reason: 'test',
        },
        'dsh-headless',
      )
      store.completeEvent(event.id, 'setup')
      const next = store.claimNextRun('worker')
      if (!next) throw new Error('Expected Run')
      active = next
      ids.push(next.run.id)
    }
    const projection = store.readTaskStateForRun(
      active.run.id,
      active.claimToken,
      active.task.id,
    )
    expect(projection.runs.map(run => run.id)).toEqual(ids.slice(-5).reverse())
    expect(projection.runsTruncated).toBe(true)
    expect(projection.approvals).toEqual([])
    expect(projection.approvalsTruncated).toBe(false)
  })

  it('reads bounded task failure state with a live owner claim, without bearer or shell', async () => {
    const store = new PegasStore(':memory:')
    const failed = seedWorkRun(store, 'owner', 'failed download')
    store.failRun(
      failed.run.id,
      'worker',
      'download failed: ' + 'x'.repeat(8000),
      { terminalProvider: true },
    )
    const other = seedWorkRun(store, 'other', 'private task')
    const active = seedWorkRun(store, 'owner', 'diagnose')
    const server = createControlPlane({ store, apiToken: 'fixture-api-token' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => store.close(),
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const tool = historyTools({
      baseUrl,
      runId: active.run.id,
      claimToken: active.claimToken,
      privacyMode: 'disabled',
    }).find(t => t.name === 'read_task_state') as
      HistoryToolDefinition | undefined
    if (!tool) throw new Error('Expected task state tool')
    const output = await tool.execute(
      { taskId: failed.task.id },
      { signal: new AbortController().signal },
    )
    const state = JSON.parse(output.json) as {
      task: { id: string }
      runs: { status: string; lastError: string; truncated: boolean }[]
    }
    expect(state.task.id).toBe(failed.task.id)
    expect(state.runs[0]).toMatchObject({ status: 'failed', truncated: true })
    expect(state.runs[0]?.lastError).toContain('download failed:')
    expect(output.json.length).toBeLessThan(10000)
    for (const id of [other.task.id, 'missing']) {
      await expect(
        tool.execute({ taskId: id }, { signal: new AbortController().signal }),
      ).rejects.toThrow('404')
    }
    store.failRun(active.run.id, 'worker', 'stopped', {
      terminalProvider: true,
    })
    await expect(
      tool.execute(
        { taskId: failed.task.id },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('403')
  })

  it('searches closed tasks across the owner history with bounded snippets', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    seedWorkRun(
      store,
      'owner',
      '整理季度报表',
      '报表已生成，存放在 /Users/ming/reports/q3-summary.xlsx，包含收入与成本两个 sheet。',
    )
    const active = seedWorkRun(store, 'owner', '新的任务')
    const found = store.searchHistoryForRun(
      active.run.id,
      active.claimToken,
      'q3-summary',
    )
    expect(found.results.length).toBeGreaterThan(0)
    expect(found.results[0]).toMatchObject({ taskTitle: '整理季度报表' })
    expect(found.results[0]?.snippet.length).toBeLessThan(400)

    const read = store.readHistoryForRun(
      active.run.id,
      active.claimToken,
      found.results[0]?.sourceKind ?? '',
      found.results[0]?.sourceId ?? '',
    )
    expect(read.text).toContain('q3-summary.xlsx')
    expect(read.truncated).toBe(false)
  })

  it('enforces owner isolation, live claims and bounded reads', () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    seedWorkRun(store, 'owner', '机密任务', '私密产出 secret-path.xlsx')
    const other = seedWorkRun(store, 'intruder', '入侵者任务')
    expect(
      store.searchHistoryForRun(other.run.id, other.claimToken, 'secret-path')
        .results,
    ).toHaveLength(0)
    expect(() =>
      store.readHistoryForRun(other.run.id, other.claimToken, 'run', 'x'),
    ).toThrow()
    const active = seedWorkRun(store, 'owner', '活跃任务')
    expect(() =>
      store.searchHistoryForRun(active.run.id, 'forged', 'anything'),
    ).toThrow(RunClaimError)
    expect(() =>
      store.searchHistoryForRun(active.run.id, active.claimToken, ''),
    ).toThrow('1-200')
    expect(() =>
      store.searchHistoryForRun(active.run.id, active.claimToken, 'x', 50),
    ).toThrow('1 and 20')
  })

  it('serves search and read over HTTP with the claim header only', async () => {
    const store = new PegasStore(':memory:')
    seedWorkRun(store, 'owner', '报表任务', '产物在 /tmp/report.xlsx')
    const active = seedWorkRun(store, 'owner', '当前任务')
    const server = createControlPlane({
      store,
      apiToken: '{{SECRET_8kx2mv0q}}',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
      () => store.close(),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const searchPath = `/v1/runs/${active.run.id}/history/search?q=report.xlsx`
    const authorized = await fetch(`${base}${searchPath}`, {
      headers: { 'x-pegas-run-claim-token': active.claimToken },
    })
    expect(authorized.status).toBe(200)
    const projection = (await authorized.json()) as {
      results: { sourceKind: string; sourceId: string }[]
    }
    expect(projection.results.length).toBeGreaterThan(0)

    const readPath = `/v1/runs/${active.run.id}/history/read?kind=${projection.results[0]?.sourceKind ?? ''}&id=${projection.results[0]?.sourceId ?? ''}`
    const read = await fetch(`${base}${readPath}`, {
      headers: { 'x-pegas-run-claim-token': active.claimToken },
    })
    expect(read.status).toBe(200)
    expect(JSON.stringify(await read.json())).toContain('report.xlsx')

    expect((await fetch(`${base}${searchPath}`)).status).toBe(403)
    expect(
      (
        await fetch(`${base}${searchPath}`, {
          headers: { 'x-pegas-run-claim-token': 'forged' },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(
          `${base}/v1/runs/${active.run.id}/history/read?kind=run&id=missing`,
          { headers: { 'x-pegas-run-claim-token': active.claimToken } },
        )
      ).status,
    ).toBe(404)
  })

  it('plugin capability validation and masking mirror the conversation surface', () => {
    expect(normalizeCapability(undefined)).toBeUndefined()
    expect(normalizeCapability({ baseUrl: 'ftp://x' })).toBeUndefined()
    const capability = normalizeCapability({
      baseUrl: 'http://127.0.0.1:1',
      runId: 'run',
      claimToken: 'token',
      privacyMode: 'mask',
    })
    expect(capability).toBeDefined()
    const tools = historyTools(
      capability ?? {
        baseUrl: '',
        runId: '',
        claimToken: '',
        privacyMode: 'disabled',
      },
      {
        masker: { mask: text => ({ text: `[masked:${String(text.length)}]` }) },
      },
    )
    expect(tools.map(tool => tool.name)).toEqual([
      'read_task_state',
      'search_history',
      'read_history',
    ])
    for (const tool of tools) {
      expect(tool.isConcurrencySafe()).toBe(true)
    }
  })
})
