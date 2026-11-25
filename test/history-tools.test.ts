import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import type { ClaimedRun } from '../src/core/domain.js'
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
      'search_history',
      'read_history',
    ])
    for (const tool of tools) {
      expect(tool.isConcurrencySafe()).toBe(true)
    }
  })
})
