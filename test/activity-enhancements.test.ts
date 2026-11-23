import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import {
  dshProjectKey,
  readDshRootToolOutcomes,
} from '../src/executor/dsh-subagent-transcript.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import { backfillThinkingSummaries } from '../src/worker/processor.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function seedClaimedRun(store: PegasStore) {
  const event = store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: '增强执行记录' },
  }).event
  const created = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: '增强执行记录',
      goal: '增强执行记录',
      input: '增强执行记录',
      reason: 't',
    },
    'enhance-test',
  )
  const claimed = store.claimNextRun('enhance-worker')
  if (claimed?.run.id !== created.run.id)
    throw new Error('Expected a claimed Run')
  return claimed
}

function writeSessionLog(
  sessionsRoot: string,
  workspace: string,
  sessionId: string,
  records: object[],
): void {
  const directory = join(sessionsRoot, dshProjectKey(workspace), sessionId)
  mkdirSync(directory, { recursive: true })
  const header = {
    type: 'session',
    id: sessionId,
    cwd: workspace,
    version: 4,
    createdAt: 1_795_300_000_000,
  }
  const text = [header, ...records]
    .map(record => JSON.stringify(record))
    .join('\n')
  writeFileSync(
    join(directory, 'session.v4.jsonl.zstd'),
    zstdCompressSync(Buffer.from(text, 'utf8')),
  )
}

describe('EXEC-006 P1a root durable-log reader', () => {
  it('reads faithful results and structured meta for the root session only', () => {
    const root = tempDirectory('pegas-root-log-')
    const sessionsRoot = join(root, 'sessions')
    const workspace = '/repo/project'
    writeSessionLog(sessionsRoot, workspace, 'session-root', [
      {
        type: 'tool/result',
        surfaceOp: 'append',
        data: {
          message: {
            toolCallId: 'call-fetch',
            content: [{ type: 'text', text: 'Fetched body' }],
            isError: false,
          },
          meta: { url: 'https://example.dev/api', statusCode: 200 },
        },
      },
      {
        type: 'tool/result',
        surfaceOp: 'replace',
        data: {
          message: {
            toolCallId: 'call-replaced',
            content: [{ type: 'text', text: 'partial' }],
          },
        },
      },
      {
        type: 'tool/result',
        data: {
          message: {
            toolCallId: 'call-error',
            content: [{ type: 'text', text: 'Error: fetch failed' }],
            isError: true,
          },
        },
      },
    ])
    writeSessionLog(sessionsRoot, workspace, 'session-other', [
      {
        type: 'tool/result',
        data: {
          message: {
            toolCallId: 'call-other',
            content: [{ type: 'text', text: 'other session' }],
          },
        },
      },
    ])
    const outcomes = readDshRootToolOutcomes('session-root', workspace, {
      sessionsRoot,
    })
    expect(outcomes).toEqual([
      {
        callId: 'call-fetch',
        status: 'completed',
        result: 'Fetched body',
        meta: { url: 'https://example.dev/api', statusCode: 200 },
      },
      {
        callId: 'call-error',
        status: 'error',
        result: 'Error: fetch failed',
      },
    ])
    expect(
      readDshRootToolOutcomes('session-missing', workspace, { sessionsRoot }),
    ).toEqual([])
  })

  it('restores privacy placeholders in results and meta before return', () => {
    const root = tempDirectory('pegas-root-mask-')
    const sessionsRoot = join(root, 'sessions')
    const workspace = '/repo/project'
    writeSessionLog(sessionsRoot, workspace, 'session-root', [
      {
        type: 'tool/result',
        data: {
          message: {
            toolCallId: 'call-1',
            content: [{ type: 'text', text: 'hello __MASKED__' }],
          },
          meta: { path: '/tmp/__MASKED__' },
        },
      },
    ])
    const outcomes = readDshRootToolOutcomes('session-root', workspace, {
      sessionsRoot,
      restore: text => text.replaceAll('__MASKED__', 'owner-secret'),
    })
    expect(outcomes[0]?.result).toBe('hello owner-secret')
    expect(outcomes[0]?.meta).toEqual({ path: '/tmp/owner-secret' })
  })
})

describe('EXEC-006 P1a store semantic upgrade', () => {
  it('upgrades web rows with durable meta and keeps unknown rows untouched', () => {
    const store = new PegasStore(':memory:')
    const claimed = seedClaimedRun(store)
    store.appendRunActivity(claimed.run.id, 'enhance-worker', {
      kind: 'tool_call',
      status: 'started',
      callId: 'call-web',
      tool: 'web_fetch',
      label: 'web_fetch',
      detail: JSON.stringify({ url: 'https://example.dev/api' }),
    })
    store.completeRunActivityToolCall(
      claimed.run.id,
      'enhance-worker',
      'call-web',
      { status: 'completed', result: 'raw json body' },
    )
    const before = store.listRunActivity(claimed.run.id, 'owner')?.entries[0]
    expect(before?.semantic).toMatchObject({ kind: 'web' })
    const upgraded = store.upgradeRunToolSemantics(claimed.run.id, [
      {
        callId: 'call-web',
        status: 'completed',
        result: 'raw json body',
        meta: { url: 'https://example.dev/api', statusCode: 200 },
      },
      { callId: 'call-missing', status: 'completed', meta: {} },
    ])
    expect(upgraded).toBe(1)
    const after = store.listRunActivity(claimed.run.id, 'owner')?.entries[0]
    expect(after?.semantic).toMatchObject({ kind: 'web', statusCode: 200 })
    expect(
      store.upgradeRunToolSemantics(claimed.run.id, [
        {
          callId: 'call-web',
          status: 'completed',
          result: 'raw json body',
          meta: { url: 'https://example.dev/api', statusCode: 200 },
        },
      ]),
    ).toBe(0)
    store.close()
  })
})

describe('EXEC-006 P1b full-output archive and paging', () => {
  it('archives the faithful output, pages it, and stays owner-scoped', async () => {
    const store = new PegasStore(':memory:')
    const claimed = seedClaimedRun(store)
    const longOutput = 'x'.repeat(40_000)
    store.appendRunActivity(claimed.run.id, 'enhance-worker', {
      kind: 'tool_call',
      status: 'started',
      callId: 'call-long',
      tool: 'bash',
      label: 'bash',
      detail: JSON.stringify({ command: 'cat big.log' }),
    })
    store.completeRunActivityToolCall(
      claimed.run.id,
      'enhance-worker',
      'call-long',
      { status: 'completed', result: longOutput },
    )
    const first = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-long',
    )
    expect(first).toMatchObject({
      offset: 0,
      totalCharacters: 40_000,
      archivedCharacters: 40_000,
      truncatedArchive: false,
    })
    const gapStart = first?.gapStart ?? -1
    const gapEnd = first?.gapEnd ?? -1
    expect(gapEnd).toBeGreaterThan(gapStart)
    expect(first?.content).toHaveLength(Math.min(12_000, gapStart))
    const second = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-long',
      { offset: 12_000, until: gapEnd, limit: 32_768 },
    )
    expect(second?.content).toHaveLength(gapStart - 12_000)
    expect(second?.offset).toBe(12_000)
    const beyond = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-long',
      { offset: gapEnd, until: gapEnd },
    )
    expect(beyond?.content).toBe('')
    expect(
      await store.readRunActivityOutput(
        claimed.run.id,
        'intruder',
        'call-long',
      ),
    ).toBeUndefined()
    expect(
      await store.readRunActivityOutput(claimed.run.id, 'owner', 'call-none'),
    ).toBeUndefined()
    store.close()
  })

  it('heals an 8KB stream-clipped archive from the durable full result without meta', async () => {
    const store = new PegasStore(':memory:')
    const claimed = seedClaimedRun(store)
    const fullOutput = Array.from({ length: 4_000 }, (_, index) =>
      String(index + 1),
    ).join('\n')
    const streamClip = fullOutput.slice(0, 8_192)
    store.appendRunActivity(claimed.run.id, 'enhance-worker', {
      kind: 'tool_call',
      status: 'started',
      callId: 'call-seq',
      tool: 'bash',
      label: 'bash',
      detail: JSON.stringify({ command: 'seq 1 4000' }),
    })
    store.completeRunActivityToolCall(
      claimed.run.id,
      'enhance-worker',
      'call-seq',
      { status: 'completed', result: streamClip },
    )
    expect(
      await store.readRunActivityOutput(claimed.run.id, 'owner', 'call-seq'),
    ).toMatchObject({ totalCharacters: 8_192 })
    const upgraded = store.upgradeRunToolSemantics(claimed.run.id, [
      { callId: 'call-seq', status: 'completed', result: fullOutput },
    ])
    expect(upgraded).toBe(0)
    const healed = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-seq',
      { offset: 8_192 },
    )
    expect(healed?.totalCharacters).toBe(fullOutput.length)
    expect(healed?.content.endsWith('4000')).toBe(true)
    store.upgradeRunToolSemantics(claimed.run.id, [
      { callId: 'call-seq', status: 'completed', result: streamClip },
    ])
    expect(
      await store.readRunActivityOutput(claimed.run.id, 'owner', 'call-seq'),
    ).toMatchObject({ totalCharacters: fullOutput.length })
    store.close()
  })

  it('caps the archive honestly at 256KB', async () => {
    const store = new PegasStore(':memory:')
    const claimed = seedClaimedRun(store)
    store.appendRunActivity(claimed.run.id, 'enhance-worker', {
      kind: 'tool_call',
      status: 'started',
      callId: 'call-huge',
      tool: 'bash',
      label: 'bash',
      detail: JSON.stringify({ command: 'yes' }),
    })
    store.completeRunActivityToolCall(
      claimed.run.id,
      'enhance-worker',
      'call-huge',
      { status: 'completed', result: 'y'.repeat(300_000) },
    )
    const page = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-huge',
    )
    expect(page).toMatchObject({
      totalCharacters: 300_000,
      archivedCharacters: 262_144,
      truncatedArchive: true,
    })
    store.close()
  })
})

describe('EXEC-006 round-18 executor spill-file channel', () => {
  function seedSpilledCall(store: PegasStore, spillPath: string) {
    const claimed = seedClaimedRun(store)
    const tailText = 'tail error summary line'
    const fullText = `head of output\n${'z'.repeat(30_000)}\n${tailText}`
    const streamResult = `${tailText}\n[output truncated; full output: ${spillPath}]`
    store.appendRunActivity(claimed.run.id, 'enhance-worker', {
      kind: 'tool_call',
      status: 'started',
      callId: 'call-spill',
      tool: 'bash',
      label: 'bash',
      detail: JSON.stringify({ command: 'cat huge.log' }),
    })
    store.completeRunActivityToolCall(
      claimed.run.id,
      'enhance-worker',
      'call-spill',
      { status: 'completed', result: streamResult },
    )
    return { claimed, fullText, streamResult }
  }

  it('resolves the spill path only from the persisted semantic, owner-scoped', () => {
    const store = new PegasStore(':memory:')
    const { claimed } = seedSpilledCall(store, '/tmp/spill/full.txt')
    expect(
      store.resolveRunOutputSpillPath(claimed.run.id, 'owner', 'call-spill'),
    ).toEqual(['/tmp/spill/full.txt'])
    expect(
      store.resolveRunOutputSpillPath(claimed.run.id, 'intruder', 'call-spill'),
    ).toEqual([])
    expect(
      store.resolveRunOutputSpillPath(claimed.run.id, 'owner', 'call-none'),
    ).toEqual([])
    store.close()
  })

  it('pages beyond a short archive from the spill file when it covers the original', async () => {
    const store = new PegasStore(':memory:')
    const { claimed, fullText, streamResult } = seedSpilledCall(
      store,
      '/tmp/spill/full.txt',
    )
    store.upgradeRunToolSemantics(claimed.run.id, [
      {
        callId: 'call-spill',
        status: 'completed',
        result: streamResult,
        meta: { truncated: true },
      },
    ])
    const requested: string[] = []
    const page = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-spill',
      {
        offset: 0,
        spillReader: path => {
          requested.push(path)
          return Promise.resolve(fullText)
        },
      },
    )
    expect(requested).toEqual(['/tmp/spill/full.txt'])
    expect(page?.content).toBe(fullText.slice(0, 12_000))
    expect(page?.archivedCharacters).toBe(fullText.length)
    expect(page?.totalCharacters).toBe(fullText.length)
    const tail = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-spill',
      {
        offset: fullText.length - 23,
        spillReader: () => Promise.resolve(fullText),
      },
    )
    expect(tail?.content).toBe('tail error summary line')
    store.close()
  })

  it('degrades honestly when the spill file is missing or shorter than the original', async () => {
    const store = new PegasStore(':memory:')
    const { claimed, fullText, streamResult } = seedSpilledCall(
      store,
      '/tmp/spill/full.txt',
    )
    store.upgradeRunToolSemantics(claimed.run.id, [
      {
        callId: 'call-spill',
        status: 'completed',
        result: streamResult,
        meta: { truncated: true },
      },
    ])
    const missing = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-spill',
      { offset: 0, spillReader: () => Promise.resolve(undefined) },
    )
    expect(missing?.content).toContain('[output truncated; full output:')
    expect(missing?.archivedCharacters).toBeLessThan(200)
    const mismatched = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-spill',
      { offset: 0, spillReader: () => Promise.resolve(fullText.slice(0, 10)) },
    )
    expect(mismatched?.content).toContain('[output truncated; full output:')
    store.close()
  })

  it('falls back from a formatted copy to the raw stream locator for paging', async () => {
    const store = new PegasStore(':memory:')
    const claimed = seedClaimedRun(store)
    const fullText = `1\n${'q'.repeat(40_000)}\n60000`
    const chained =
      `59999\n60000\n[output truncated; full output: /tmp/raw/stdout.log]\n\n` +
      '(Omitted 9000 bytes. Full formatted result stored at: /tmp/spill/formatted.txt. Use read with offset/limit, or grep this path to search within it.)'
    store.appendRunActivity(claimed.run.id, 'enhance-worker', {
      kind: 'tool_call',
      status: 'started',
      callId: 'call-chain',
      tool: 'bash',
      label: 'bash',
      detail: JSON.stringify({ command: 'seq 1 60000' }),
    })
    store.completeRunActivityToolCall(
      claimed.run.id,
      'enhance-worker',
      'call-chain',
      {
        status: 'completed',
        result: chained,
      },
    )
    store.upgradeRunToolSemantics(claimed.run.id, [
      {
        callId: 'call-chain',
        status: 'completed',
        result: chained,
        meta: { truncated: true },
      },
    ])
    expect(
      store.resolveRunOutputSpillPath(claimed.run.id, 'owner', 'call-chain'),
    ).toEqual(['/tmp/spill/formatted.txt', '/tmp/raw/stdout.log'])
    const requested: string[] = []
    const page = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-chain',
      {
        offset: 0,
        spillReader: path => {
          requested.push(path)
          return Promise.resolve(
            path === '/tmp/raw/stdout.log' ? fullText : 'short copy',
          )
        },
      },
    )
    expect(requested).toEqual([
      '/tmp/spill/formatted.txt',
      '/tmp/raw/stdout.log',
    ])
    expect(page?.content).toBe(fullText.slice(0, 12_000))
    expect(page?.totalCharacters).toBe(fullText.length)
    store.close()
  })

  it('bounds pages at the omission gap so the inline tail never repeats', async () => {
    const store = new PegasStore(':memory:')
    const claimed = seedClaimedRun(store)
    const fullText = Array.from({ length: 8_000 }, (_, index) =>
      String(index + 1),
    ).join('\n')
    store.appendRunActivity(claimed.run.id, 'enhance-worker', {
      kind: 'tool_call',
      status: 'started',
      callId: 'call-headtail',
      tool: 'bash',
      label: 'bash',
      detail: JSON.stringify({ command: 'seq 1 8000' }),
    })
    store.completeRunActivityToolCall(
      claimed.run.id,
      'enhance-worker',
      'call-headtail',
      { status: 'completed', result: fullText },
    )
    const first = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-headtail',
      { limit: 32_768 },
    )
    expect(first?.gapStart).toBeDefined()
    expect(first?.gapEnd).toBeDefined()
    const gapStart = first?.gapStart ?? -1
    const gapEnd = first?.gapEnd ?? -1
    expect(gapEnd).toBeGreaterThan(gapStart)
    expect(first?.content).toBe(fullText.slice(0, gapStart))
    const middle = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-headtail',
      { offset: gapStart, until: gapEnd, limit: 32_768 },
    )
    expect(middle?.offset).toBe(gapStart)
    expect(middle?.content).toBe(fullText.slice(gapStart, gapEnd))
    const lastMiddle = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-headtail',
      { offset: gapEnd - 100, until: gapEnd },
    )
    expect(lastMiddle?.content).toBe(fullText.slice(gapEnd - 100, gapEnd))
    expect(lastMiddle?.content.endsWith('\n')).toBe(false)
    const atTail = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-headtail',
      { offset: gapEnd, until: gapEnd },
    )
    expect(atTail?.content).toBe('')
    const beyond = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-headtail',
      { offset: gapEnd },
    )
    expect(beyond?.content).toBe(fullText.slice(gapEnd))
    expect(beyond?.content.endsWith('8000')).toBe(true)
    store.close()
  })

  it('peels the bash notice from a formatted spill copy to bound the gap', async () => {
    const store = new PegasStore(':memory:')
    const claimed = seedClaimedRun(store)
    const head = 'H'.repeat(8_000)
    const middle = 'M'.repeat(20_000)
    const tail = 'TAIL-SUMMARY\n80000'
    const body = `${head}\n${middle}\n${tail}`
    const formatted = `${body}\n\n[output truncated; full output: /tmp/raw/stdout.log]`
    const streamResult = `${formatted}\n(Omitted 9000 bytes. Full formatted result stored at: /tmp/spill/formatted.txt. Use read with offset/limit, or grep this path to search within it.)`
    store.appendRunActivity(claimed.run.id, 'enhance-worker', {
      kind: 'tool_call',
      status: 'started',
      callId: 'call-formatted',
      tool: 'bash',
      label: 'bash',
      detail: JSON.stringify({ command: 'seq 1 480' }),
    })
    store.completeRunActivityToolCall(
      claimed.run.id,
      'enhance-worker',
      'call-formatted',
      { status: 'completed', result: streamResult },
    )
    store.upgradeRunToolSemantics(claimed.run.id, [
      {
        callId: 'call-formatted',
        status: 'completed',
        result: streamResult,
        meta: { truncated: true },
      },
    ])
    const page = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-formatted',
      {
        offset: 0,
        spillReader: path =>
          Promise.resolve(
            path === '/tmp/spill/formatted.txt' ? formatted : undefined,
          ),
      },
    )
    const gapStart = 6_000
    const gapEnd = body.length - 6_000
    expect(page?.gapStart).toBe(gapStart)
    expect(page?.gapEnd).toBe(gapEnd)
    expect(page?.content).toBe(body.slice(0, gapStart))
    expect(page?.totalCharacters).toBe(body.length)
    const middlePage = await store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-formatted',
      {
        offset: gapStart,
        until: gapEnd,
        limit: 32_768,
        spillReader: path =>
          Promise.resolve(
            path === '/tmp/spill/formatted.txt' ? formatted : undefined,
          ),
      },
    )
    expect(middlePage?.content).toBe(body.slice(gapStart, gapEnd))
    store.close()
  })
})

describe('EXEC-006 child thinking summary write-back', () => {
  it('writes summaries into the child transcript without touching raw text', () => {
    const store = new PegasStore(':memory:')
    const claimed = seedClaimedRun(store)
    store.recordRunSubagents(claimed.run.id, 'enhance-worker', [
      {
        sessionId: 'child-1',
        parentSessionId: 'session-root',
        delegationDepth: 1,
        createdAt: '2026-11-23T00:00:00.000Z',
        entries: [
          {
            seq: 1,
            kind: 'thinking',
            label: 'Count the files under src carefully.',
            detail: 'Count the files under src carefully.',
            createdAt: '2026-11-23T00:00:01.000Z',
            updatedAt: '2026-11-23T00:00:01.000Z',
          },
          {
            seq: 2,
            kind: 'thinking',
            label: '先核对目录结构。',
            detail: '先核对目录结构。',
            createdAt: '2026-11-23T00:00:02.000Z',
            updatedAt: '2026-11-23T00:00:02.000Z',
          },
        ],
        totalEntries: 2,
        truncated: false,
      },
    ])
    const pending = store.listSubagentThinkingMissingSummary(claimed.run.id)
    expect(pending).toEqual([
      {
        sessionId: 'child-1',
        seq: 1,
        label: 'Count the files under src carefully.',
        detail: 'Count the files under src carefully.',
      },
    ])
    store.setSubagentThinkingSummary(
      claimed.run.id,
      'child-1',
      1,
      '仔细统计 src 下的文件数',
    )
    store.setSubagentThinkingSummary(
      claimed.run.id,
      'child-1',
      1,
      '第二次不覆盖',
    )
    const report = store.listRunSubagents(claimed.run.id, 'owner')
    const entry = report?.subagents[0]?.entries[0]
    expect(entry?.summary).toBe('仔细统计 src 下的文件数')
    expect(entry?.detail).toBe('Count the files under src carefully.')
    expect(store.listSubagentThinkingMissingSummary(claimed.run.id)).toEqual([])
    store.close()
  })

  it('backfills child summaries even when every root row is already summarized', async () => {
    const store = new PegasStore(':memory:')
    const claimed = seedClaimedRun(store)
    store.appendRunActivity(claimed.run.id, 'enhance-worker', {
      kind: 'thinking',
      label: 'Delegate the counting work.',
      detail: 'Delegate the counting work to a subagent.',
    })
    store.recordRunSubagents(claimed.run.id, 'enhance-worker', [
      {
        sessionId: 'child-1',
        parentSessionId: 'session-root',
        delegationDepth: 1,
        createdAt: '2026-11-23T00:00:00.000Z',
        entries: [
          {
            seq: 1,
            kind: 'thinking',
            label: 'Count the files under src carefully.',
            detail: 'Count the files under src carefully.',
            createdAt: '2026-11-23T00:00:01.000Z',
            updatedAt: '2026-11-23T00:00:01.000Z',
          },
        ],
        totalEntries: 1,
        truncated: false,
      },
    ])
    store.completeRun(claimed.run.id, 'enhance-worker', {
      executorRef: 'session-root',
      output: 'done',
    })
    store.setRunThinkingSummary(claimed.run.id, 1, '把统计工作委派给子 agent')
    expect(store.listRunsMissingThinkingSummary(10)).toEqual([])
    expect(store.listRunsMissingChildThinkingSummary(10)).toEqual([
      { runId: claimed.run.id, userId: 'owner' },
    ])
    const calls: { sessionId?: string }[] = []
    await backfillThinkingSummaries(store, context => {
      calls.push(context)
      return { summarize: () => Promise.resolve('仔细统计 src 下的文件数') }
    })
    expect(calls).toEqual([
      {
        userId: 'owner',
        runId: claimed.run.id,
        seq: 1,
        sessionId: 'child-1',
      },
    ])
    const report = store.listRunSubagents(claimed.run.id, 'owner')
    expect(report?.subagents[0]?.entries[0]?.summary).toBe(
      '仔细统计 src 下的文件数',
    )
    expect(store.listRunsMissingChildThinkingSummary(10)).toEqual([])
    store.close()
  })
})

describe('EXEC-006 activity output/image HTTP surface', () => {
  async function openServer(store: PegasStore) {
    const server = createControlPlane({ store })
    await new Promise<void>(resolve =>
      server.listen(0, '127.0.0.1', () => resolve()),
    )
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${String(port)}`
  }

  it('serves output pages with owner checks and 404 for strangers', async () => {
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const claimed = seedClaimedRun(store)
    store.appendRunActivity(claimed.run.id, 'enhance-worker', {
      kind: 'tool_call',
      status: 'started',
      callId: 'call-http',
      tool: 'bash',
      label: 'bash',
      detail: JSON.stringify({ command: 'cat log' }),
    })
    store.completeRunActivityToolCall(
      claimed.run.id,
      'enhance-worker',
      'call-http',
      { status: 'completed', result: 'a'.repeat(20_000) },
    )
    const base = await openServer(store)
    const head = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-http/output?userId=owner&offset=0`,
    )
    const headPage = (await head.json()) as {
      content: string
      gapStart?: number
      gapEnd?: number
    }
    expect(headPage.gapStart).toBeDefined()
    expect(headPage.gapEnd).toBeDefined()
    expect(headPage.content).toHaveLength(headPage.gapStart ?? -1)
    const ok = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-http/output?userId=owner&offset=${String(headPage.gapEnd ?? 0)}`,
    )
    expect(ok.status).toBe(200)
    const page = (await ok.json()) as { content: string; offset: number }
    expect(page.offset).toBe(headPage.gapEnd)
    expect(page.content).toHaveLength(20_000 - (headPage.gapEnd ?? 0))
    const denied = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-http/output?userId=intruder`,
    )
    expect(denied.status).toBe(404)
    const missing = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-none/output?userId=owner`,
    )
    expect(missing.status).toBe(404)
  })

  it('serves recorded image bytes and refuses unrecorded or foreign paths', async () => {
    const root = tempDirectory('pegas-image-api-')
    const imagePath = join(root, 'shot.png')
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    writeFileSync(imagePath, pngBytes)
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const claimed = seedClaimedRun(store)
    store.appendRunActivity(claimed.run.id, 'enhance-worker', {
      kind: 'tool_call',
      status: 'started',
      callId: 'call-img',
      tool: 'read_image',
      label: 'read_image',
      detail: JSON.stringify({ file_path: imagePath }),
    })
    store.completeRunActivityToolCall(
      claimed.run.id,
      'enhance-worker',
      'call-img',
      {
        status: 'completed',
        result: `<path>${imagePath}</path><type>image</type><content>image/png image, 1x1 px, ${String(pngBytes.byteLength)} bytes</content>`,
      },
    )
    store.appendRunActivity(claimed.run.id, 'enhance-worker', {
      kind: 'tool_call',
      status: 'started',
      callId: 'call-txt',
      tool: 'read',
      label: 'read',
      detail: JSON.stringify({ file_path: join(root, 'secret.txt') }),
    })
    const base = await openServer(store)
    const ok = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-img/image?userId=owner`,
    )
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(pngBytes)
    const denied = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-img/image?userId=intruder`,
    )
    expect(denied.status).toBe(404)
    const notImage = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-txt/image?userId=owner`,
    )
    expect(notImage.status).toBe(404)
    rmSync(imagePath)
    const gone = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-img/image?userId=owner`,
    )
    expect(gone.status).toBe(404)
  })

  it('serves the recorded spill file as text and pages beyond the archive', async () => {
    const root = tempDirectory('pegas-spill-api-')
    const spillPath = join(root, 'full-output.txt')
    const fullText = `first line\n${'w'.repeat(30_000)}\nfinal error summary`
    writeFileSync(spillPath, fullText)
    const store = new PegasStore(':memory:')
    cleanups.push(() => store.close())
    const claimed = seedClaimedRun(store)
    store.appendRunActivity(claimed.run.id, 'enhance-worker', {
      kind: 'tool_call',
      status: 'started',
      callId: 'call-spill-http',
      tool: 'bash',
      label: 'bash',
      detail: JSON.stringify({ command: 'cat huge.log' }),
    })
    const streamResult = `final error summary\n[output truncated; full output: ${spillPath}]`
    store.completeRunActivityToolCall(
      claimed.run.id,
      'enhance-worker',
      'call-spill-http',
      { status: 'completed', result: streamResult },
    )
    store.upgradeRunToolSemantics(claimed.run.id, [
      {
        callId: 'call-spill-http',
        status: 'completed',
        result: streamResult,
        meta: { truncated: true },
      },
    ])
    const base = await openServer(store)
    const file = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-spill-http/output-file?userId=owner`,
    )
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(file.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await file.text()).toBe(fullText)
    const denied = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-spill-http/output-file?userId=intruder`,
    )
    expect(denied.status).toBe(404)
    const missing = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-none/output-file?userId=owner`,
    )
    expect(missing.status).toBe(404)
    const page = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-spill-http/output?userId=owner&offset=${String(fullText.length - 19)}`,
    )
    expect(page.status).toBe(200)
    const body = (await page.json()) as {
      content: string
      archivedCharacters: number
    }
    expect(body.content).toBe('final error summary')
    expect(body.archivedCharacters).toBe(fullText.length)
    const bounded = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-spill-http/output?userId=owner&offset=0&until=5`,
    )
    expect(bounded.status).toBe(200)
    expect(((await bounded.json()) as { content: string }).content).toBe(
      fullText.slice(0, 5),
    )
    const invalidUntil = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-spill-http/output?userId=owner&offset=0&until=abc`,
    )
    expect(invalidUntil.status).toBeGreaterThanOrEqual(400)
    rmSync(spillPath)
    const gone = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-spill-http/output-file?userId=owner`,
    )
    expect(gone.status).toBe(404)
  })
})
