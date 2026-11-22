import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import {
  ModelThinkingSummarizer,
  needsChineseSummary,
  normalizeThinkingSummary,
} from '../src/activity/thinking-summary.js'
import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../src/executor/executor.js'
import { MeteredJsonModelProvider } from '../src/model/metered-provider.js'
import type {
  JsonModelProvider,
  JsonModelRequest,
} from '../src/model/provider.js'
import { DeterministicPrivacyMasker } from '../src/privacy/masker.js'
import { PrivacyMaskingProvider } from '../src/privacy/provider.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  backfillThinkingSummaries,
  executeClaimedRun,
} from '../src/worker/processor.js'

function seedClaimedRun(store: PegasStore) {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: 'Summarize the pricing page' },
  }).event
  const created = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: 'Summarize the pricing page',
      goal: 'Summarize the pricing page',
      input: 'Summarize the pricing page',
      reason: 't',
    },
    'thinking-test',
  )
  const claimed = store.claimNextRun('thinking-worker')
  if (claimed?.run.id !== created.run.id)
    throw new Error('Expected a claimed Run')
  return claimed
}

class ThinkingExecutor implements RunExecutor {
  readonly name = 'thinking-test'

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    input.onProgress?.({
      type: 'thinking',
      text: 'I should inspect api.ts first and grep for conflict markers before merging.',
    })
    input.onProgress?.({ type: 'thinking', text: '先核对价格口径。' })
    input.onProgress?.({ type: 'thinking', text: 'ok' })
    return Promise.resolve({
      executorRef: 'session-thinking',
      output: 'Pricing confirmed.',
    })
  }
}

describe('EXEC-006 thinking Chinese headline eligibility', () => {
  it('flags English thinking without a summary and skips Chinese or tiny rows', () => {
    expect(
      needsChineseSummary({
        label: 'I should inspect api.ts first',
        detail: 'grep for conflict markers',
      }),
    ).toBe(true)
    expect(
      needsChineseSummary({ label: '先核对价格口径', detail: '年付与月付' }),
    ).toBe(false)
    expect(
      needsChineseSummary({
        label: 'mixed 中文 label',
        detail: 'fully english detail here',
      }),
    ).toBe(false)
    expect(needsChineseSummary({ label: 'ok', detail: 'done' })).toBe(false)
    expect(
      needsChineseSummary({
        label: 'english thinking text',
        summary: '已有摘要',
      }),
    ).toBe(false)
  })

  it('normalizes model output and rejects empty, English or oversized summaries', () => {
    expect(normalizeThinkingSummary(' 先检查 api.ts\n再合并 ')).toBe(
      '先检查 api.ts 再合并',
    )
    expect(() => normalizeThinkingSummary('   ')).toThrow('无效结果')
    expect(() => normalizeThinkingSummary('still english')).toThrow('无效结果')
    expect(() => normalizeThinkingSummary(42)).toThrow('无效结果')
    expect(() => normalizeThinkingSummary('长'.repeat(65))).toThrow('无效结果')
  })

  it('sends a bounded excerpt through the provider and validates the JSON shape', async () => {
    const requests: JsonModelRequest[] = []
    const provider: JsonModelProvider = {
      name: 'summary-test',
      generateJson: request => {
        requests.push(request)
        return Promise.resolve({ summary: '先检查 api.ts 冲突标记' })
      },
    }
    const summarizer = new ModelThinkingSummarizer(provider)
    await expect(summarizer.summarize('x'.repeat(9_000))).resolves.toBe(
      '先检查 api.ts 冲突标记',
    )
    expect(requests[0]?.input).toHaveLength(4_000)
    expect(requests[0]?.schema).toMatchObject({ required: ['summary'] })
    const invalid: JsonModelProvider = {
      name: 'invalid',
      generateJson: () => Promise.resolve({ text: 'wrong key' }),
    }
    await expect(
      new ModelThinkingSummarizer(invalid).summarize('plan the merge'),
    ).rejects.toThrow('无效结果')
  })

  it('masks thinking before it reaches the model and restores the summary', async () => {
    const masker = new DeterministicPrivacyMasker({
      hmacKey: 'thinking-summary-test-key',
    })
    let seen = ''
    const inner: JsonModelProvider = {
      name: 'masked-inner',
      generateJson: request => {
        seen = request.input
        const maskedEmail = masker.mask('ming.liu@pegasmail.cn').text
        return Promise.resolve({ summary: `核对 ${maskedEmail} 的配额` })
      },
    }
    const summarizer = new ModelThinkingSummarizer(
      new PrivacyMaskingProvider(inner, masker),
    )
    const summary = await summarizer.summarize(
      'Check the quota for ming.liu@pegasmail.cn before proceeding.',
    )
    expect(seen).not.toContain('ming.liu@pegasmail.cn')
    expect(summary).toContain('ming.liu@pegasmail.cn')
  })
})

describe('EXEC-006 thinking summary store write-back', () => {
  it('persists the summary in the envelope, keeps raw detail, and never overwrites', () => {
    const store = new PegasStore(':memory:')
    const claimed = seedClaimedRun(store)
    const text = 'I should inspect api.ts before merging.'
    store.appendRunActivity(claimed.run.id, 'thinking-worker', {
      kind: 'thinking',
      label: text.slice(0, 120),
      detail: text,
    })
    store.setRunThinkingSummary(claimed.run.id, 1, '先检查 api.ts 再合并')
    const entry = store.listRunActivity(claimed.run.id, 'owner')?.entries[0]
    expect(entry?.summary).toBe('先检查 api.ts 再合并')
    expect(entry?.detail).toBe(text)
    expect(entry?.label).toBe(text)
    expect(store.listRunThinking(claimed.run.id)[0]).toMatchObject({
      seq: 1,
      summary: '先检查 api.ts 再合并',
    })
    store.setRunThinkingSummary(claimed.run.id, 1, '第二次摘要')
    expect(store.listRunThinking(claimed.run.id)[0]?.summary).toBe(
      '先检查 api.ts 再合并',
    )
    store.setRunThinkingSummary(claimed.run.id, 1, '   ')
    store.setRunThinkingSummary(claimed.run.id, 99, '不存在的行')
    expect(store.listRunThinking(claimed.run.id)).toHaveLength(1)
    store.close()
  })

  it('keeps legacy bare-string thinking rows readable and summarizable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-thinking-'))
    const path = join(directory, 'pegas.sqlite')
    try {
      const store = new PegasStore(path)
      const claimed = seedClaimedRun(store)
      store.appendRunActivity(claimed.run.id, 'thinking-worker', {
        kind: 'thinking',
        label: 'legacy english reasoning',
        detail: 'legacy english reasoning about the merge order',
      })
      store.close()
      const database = new DatabaseSync(path)
      database
        .prepare(
          `UPDATE run_activity_entries SET detail_json = ?
           WHERE run_id = ? AND kind = 'thinking'`,
        )
        .run(
          JSON.stringify('legacy english reasoning about the merge order'),
          claimed.run.id,
        )
      database.close()
      const reopened = new PegasStore(path)
      const rows = reopened.listRunThinking(claimed.run.id)
      expect(rows[0]?.summary).toBeUndefined()
      expect(rows[0]?.detail).toBe(
        'legacy english reasoning about the merge order',
      )
      reopened.setRunThinkingSummary(
        claimed.run.id,
        1,
        '旧英文行的合并顺序推理',
      )
      const entry = reopened.listRunActivity(claimed.run.id, 'owner')
        ?.entries[0]
      expect(entry?.summary).toBe('旧英文行的合并顺序推理')
      expect(entry?.detail).toBe(
        'legacy english reasoning about the merge order',
      )
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('meters summary calls in the additive ledger without touching router rows', () => {
    const store = new PegasStore(':memory:')
    const provider: JsonModelProvider = {
      name: 'meter-summary',
      generateJson: () => Promise.resolve({ summary: '中文摘要' }),
    }
    const context = {
      userId: 'owner',
      eventId: 'thinking:run-1:1',
      modelRef: 'openai/summary-model',
    }
    const metered = new MeteredJsonModelProvider(
      provider,
      store,
      'summary',
      () => context,
    )
    const routerMetered = new MeteredJsonModelProvider(
      provider,
      store,
      'router',
      () => ({ ...context, eventId: 'event-router' }),
    )
    return Promise.all([
      metered.generateJson({ system: 's', input: 'thinking' }),
      metered.generateJson({ system: 's', input: 'thinking' }),
      routerMetered.generateJson({ system: 'r', input: 'route' }),
    ]).then(() => {
      const report = store.listRouterUsage('owner')
      expect(report.summary.calls).toBe(2)
      const summaryRecord = report.records.find(
        record => record.component === 'summary',
      )
      expect(summaryRecord).toMatchObject({
        component: 'summary',
        eventId: 'thinking:run-1:1',
        outcome: 'ok',
      })
      expect(
        report.records.filter(record => record.component === 'router'),
      ).toHaveLength(1)
      store.close()
    })
  })
})

describe('EXEC-006 post-run thinking summary pass', () => {
  it('summarizes English rows once, skips Chinese, and meters per entry', async () => {
    const store = new PegasStore(':memory:')
    const claimed = seedClaimedRun(store)
    const summarized: string[] = []
    const contexts: { userId: string; runId: string; seq: number }[] = []
    await executeClaimedRun(
      store,
      new ThinkingExecutor(),
      claimed,
      'thinking-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
      undefined,
      undefined,
      context => {
        contexts.push(context)
        return {
          summarize: text => {
            summarized.push(text)
            return Promise.resolve('先检查 api.ts 冲突标记再合并')
          },
        }
      },
    )
    expect(summarized).toEqual([
      'I should inspect api.ts first and grep for conflict markers before merging.',
    ])
    expect(contexts).toEqual([
      { userId: 'owner', runId: claimed.run.id, seq: 1 },
    ])
    const rows = store.listRunThinking(claimed.run.id)
    expect(rows[0]?.summary).toBe('先检查 api.ts 冲突标记再合并')
    expect(rows[1]?.summary).toBeUndefined()
    expect(rows[2]?.summary).toBeUndefined()
    expect(store.listRuns(claimed.task.id)[0]?.status).toBe('completed')
    store.close()
  })

  it('keeps the completed Run and English text when the model fails', async () => {
    const store = new PegasStore(':memory:')
    const claimed = seedClaimedRun(store)
    await executeClaimedRun(
      store,
      new ThinkingExecutor(),
      claimed,
      'thinking-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
      undefined,
      undefined,
      () => ({
        summarize: () => Promise.reject(new Error('provider down')),
      }),
    )
    expect(store.listRuns(claimed.task.id)[0]?.status).toBe('completed')
    const rows = store.listRunThinking(claimed.run.id)
    expect(rows[0]?.summary).toBeUndefined()
    expect(rows[0]?.detail).toContain('inspect api.ts')
    store.close()
  })

  it('never re-summarizes rows that already carry a summary', async () => {
    const store = new PegasStore(':memory:')
    const claimed = seedClaimedRun(store)
    let calls = 0
    const factory = () => ({
      summarize: () => {
        calls += 1
        return Promise.resolve('先检查 api.ts')
      },
    })
    await executeClaimedRun(
      store,
      new ThinkingExecutor(),
      claimed,
      'thinking-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
      undefined,
      undefined,
      factory,
    )
    expect(calls).toBe(1)
    const rows = store.listRunThinking(claimed.run.id)
    for (const row of rows) {
      if (row.summary) continue
      expect(needsChineseSummary(row)).toBe(false)
    }
    store.close()
  })
})

describe('EXEC-006 historical thinking backfill', () => {
  function seedSettledRun(
    store: PegasStore,
    thinking: { label: string; detail: string }[],
  ): string {
    const claimed = seedClaimedRun(store)
    for (const entry of thinking) {
      store.appendRunActivity(claimed.run.id, 'thinking-worker', {
        kind: 'thinking',
        ...entry,
      })
    }
    store.completeRun(claimed.run.id, 'thinking-worker', {
      executorRef: 'session-backfill',
      output: 'done',
    })
    return claimed.run.id
  }

  it('summarizes settled historical English rows and skips Chinese ones', async () => {
    const store = new PegasStore(':memory:')
    const runId = seedSettledRun(store, [
      {
        label: 'Plan the merge order carefully',
        detail: 'Plan the merge order carefully before touching api.ts.',
      },
      { label: '先确认工作区', detail: '先确认工作区状态。' },
    ])
    expect(store.listRunsMissingThinkingSummary(10)).toEqual([
      { runId, userId: 'owner' },
    ])
    await backfillThinkingSummaries(store, () => ({
      summarize: () => Promise.resolve('先规划合并顺序再动 api.ts'),
    }))
    const rows = store.listRunThinking(runId)
    expect(rows[0]?.summary).toBe('先规划合并顺序再动 api.ts')
    expect(rows[1]?.summary).toBeUndefined()
    expect(store.listRunsMissingThinkingSummary(10)).toEqual([])
    store.close()
  })

  it('leaves running Runs and failed model calls untouched', async () => {
    const store = new PegasStore(':memory:')
    const running = seedClaimedRun(store)
    store.appendRunActivity(running.run.id, 'thinking-worker', {
      kind: 'thinking',
      label: 'Still streaming this reasoning',
      detail: 'Still streaming this reasoning right now.',
    })
    expect(store.listRunsMissingThinkingSummary(10)).toEqual([])
    store.completeRun(running.run.id, 'thinking-worker', {
      executorRef: 'session-backfill-fail',
      output: 'done',
    })
    await backfillThinkingSummaries(store, () => ({
      summarize: () => Promise.reject(new Error('provider down')),
    }))
    expect(store.listRunThinking(running.run.id)[0]?.summary).toBeUndefined()
    expect(store.listRunsMissingThinkingSummary(10)).toEqual([
      { runId: running.run.id, userId: 'owner' },
    ])
    store.close()
  })
})
