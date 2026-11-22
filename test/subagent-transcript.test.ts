import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import {
  dshProjectKey,
  readDshSubagentTranscripts,
} from '../src/executor/dsh-subagent-transcript.js'
import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../src/executor/executor.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

const temporaryDirectories: string[] = []
const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function openStore(): PegasStore {
  const store = new PegasStore(':memory:')
  cleanups.push(() => store.close())
  return store
}

function writeSessionLog(
  sessionsRoot: string,
  workspace: string,
  sessionId: string,
  records: readonly object[],
  options: { compress?: boolean } = {},
): void {
  const directory = join(sessionsRoot, dshProjectKey(workspace), sessionId)
  mkdirSync(directory, { recursive: true })
  const text = records.map(record => JSON.stringify(record)).join('\n')
  if (options.compress === false) {
    writeFileSync(join(directory, 'session.v4.jsonl'), text)
  } else {
    writeFileSync(
      join(directory, 'session.v4.jsonl.zstd'),
      zstdCompressSync(Buffer.from(text)),
    )
  }
}

function childHeader(
  id: string,
  parentSession: string,
  workspace: string,
  createdAt: number,
  delegationDepth = 1,
): object {
  return {
    type: 'session',
    version: 4,
    id,
    createdAt,
    cwd: workspace,
    parentSession,
    origin: 'subagent',
    isSeeded: false,
    delegationDepth,
  }
}

describe('EXEC-006 subagent transcript reader', () => {
  it('projects child sessions into typed entries correlated by parentSession', () => {
    const sessionsRoot = temporaryDirectory('pegas-subagent-root-')
    const workspace = '/tmp/pegas-subagent-workspace'
    writeSessionLog(sessionsRoot, workspace, 'session-root', [
      {
        type: 'session',
        version: 4,
        id: 'session-root',
        createdAt: 1_000,
        cwd: workspace,
        isSeeded: false,
        delegationDepth: 0,
      },
    ])
    writeSessionLog(sessionsRoot, workspace, 'session-child', [
      childHeader('session-child', 'session-root', workspace, 2_000),
      {
        type: 'subagent/descriptor',
        seq: 0,
        time: 2_000,
        data: {
          version: 3,
          mode: 'continuable',
          provider: 'spawn',
          label: '统计 docs 文件',
        },
      },
      {
        type: 'user/message',
        seq: 1,
        time: 2_050,
        data: {
          content: [{ type: 'text', text: '数一下 docs 目录的文件数' }],
        },
      },
      {
        type: 'assistant/message',
        seq: 1,
        time: 2_100,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: '先列出目录。' },
              { type: 'text', text: '我来统计文件。' },
            ],
          },
        },
      },
      {
        type: 'tool/call',
        seq: 2,
        time: 2_200,
        data: {
          turn: 1,
          step: 1,
          callId: 'call-a',
          name: 'bash',
          arguments: '{"command":"ls docs | wc -l"}',
        },
      },
      {
        type: 'tool/result',
        seq: 3,
        time: 2_300,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'tool',
            toolCallId: 'call-a',
            content: [{ type: 'text', text: '29' }],
          },
        },
      },
      { type: 'step/end', seq: 4, time: 2_400, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message',
        seq: 5,
        time: 2_500,
        data: {
          turn: 1,
          step: 2,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'docs 目录共 29 个文件。' }],
          },
        },
      },
    ])
    const transcripts = readDshSubagentTranscripts('session-root', workspace, {
      sessionsRoot,
    })
    expect(transcripts).toHaveLength(1)
    const child = transcripts[0]
    expect(child).toMatchObject({
      sessionId: 'session-child',
      parentSessionId: 'session-root',
      delegationDepth: 1,
      label: '统计 docs 文件',
      prompt: '数一下 docs 目录的文件数',
      truncated: false,
    })
    expect(child?.entries.map(entry => entry.kind)).toEqual([
      'thinking',
      'text',
      'tool_call',
      'step',
      'text',
    ])
    const tool = child?.entries.find(entry => entry.kind === 'tool_call')
    expect(tool).toMatchObject({
      callId: 'call-a',
      tool: 'bash',
      status: 'completed',
    })
    expect(tool?.detail).toContain('ls docs | wc -l')
    expect(tool?.detail).toContain('[结果]')
    expect(tool?.detail).toContain('29')
    expect(child?.entries.at(-1)?.detail).toBe('docs 目录共 29 个文件。')
  })

  it('reads structured result meta and projects compaction markers', () => {
    const sessionsRoot = temporaryDirectory('pegas-subagent-meta-')
    const workspace = '/tmp/pegas-subagent-meta'
    writeSessionLog(sessionsRoot, workspace, 'session-child', [
      childHeader('session-child', 'session-root', workspace, 2_000),
      {
        type: 'tool/call',
        seq: 1,
        time: 2_100,
        data: {
          turn: 1,
          step: 1,
          callId: 'call-grep',
          name: 'grep',
          arguments: '{"pattern":"runActivity"}',
        },
      },
      {
        type: 'tool/result',
        seq: 2,
        time: 2_200,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'tool',
            toolCallId: 'call-grep',
            content: [{ type: 'text', text: 'Found 1 of 5 matches' }],
          },
          meta: {
            shape: 'matches',
            total: 5,
            truncated: true,
            files: [
              {
                path: 'web/src/api.ts',
                matches: [{ lineNumber: 93, line: 'async runActivity(' }],
              },
            ],
          },
        },
      },
      {
        type: 'compaction/end',
        seq: 3,
        time: 2_300,
        data: { compactionId: 'c-1', turn: 1 },
      },
      {
        type: 'compaction/end',
        seq: 4,
        time: 2_400,
        data: {
          compactionId: 'c-2',
          turn: 1,
          sourceCommandId: 'cmd-1',
          error: [{ name: 'Error', message: 'summary failed' }],
        },
      },
    ])
    const transcripts = readDshSubagentTranscripts('session-root', workspace, {
      sessionsRoot,
    })
    const child = transcripts[0]
    const tool = child?.entries.find(entry => entry.callId === 'call-grep')
    expect(tool?.semantic).toMatchObject({
      kind: 'search',
      shape: 'matches',
      total: 5,
      resultTruncated: true,
      files: [
        {
          path: 'web/src/api.ts',
          matches: [{ line: 93, text: 'async runActivity(' }],
        },
      ],
    })
    const markers = child?.entries.filter(
      entry => entry.meta?.kind === 'compaction',
    )
    expect(markers).toHaveLength(2)
    expect(markers?.[0]).toMatchObject({
      kind: 'step',
      status: 'completed',
      label: '上下文已压缩',
      meta: { kind: 'compaction', note: '自动触发' },
    })
    expect(markers?.[1]).toMatchObject({
      status: 'error',
      label: '上下文压缩失败',
      meta: { kind: 'compaction', note: '手动触发' },
    })
  })

  it('includes nested delegations and ignores unrelated or unknown-format logs', () => {
    const sessionsRoot = temporaryDirectory('pegas-subagent-nested-')
    const workspace = '/tmp/pegas-subagent-nested'
    writeSessionLog(sessionsRoot, workspace, 'session-child', [
      childHeader('session-child', 'session-root', workspace, 2_000),
    ])
    writeSessionLog(sessionsRoot, workspace, 'session-grandchild', [
      childHeader('session-grandchild', 'session-child', workspace, 3_000, 2),
    ])
    writeSessionLog(sessionsRoot, workspace, 'session-unrelated', [
      childHeader('session-unrelated', 'session-other', workspace, 2_500),
    ])
    writeSessionLog(sessionsRoot, workspace, 'session-unknown-format', [
      {
        type: 'session',
        version: 99,
        id: 'session-unknown-format',
        parentSession: 'session-root',
        createdAt: 2_600,
      },
    ])
    const transcripts = readDshSubagentTranscripts('session-root', workspace, {
      sessionsRoot,
    })
    expect(transcripts.map(item => item.sessionId)).toEqual([
      'session-child',
      'session-grandchild',
    ])
    expect(transcripts[1]?.delegationDepth).toBe(2)
  })

  it('survives torn final lines and restores privacy placeholders', () => {
    const sessionsRoot = temporaryDirectory('pegas-subagent-torn-')
    const workspace = '/tmp/pegas-subagent-torn'
    const directory = join(
      sessionsRoot,
      dshProjectKey(workspace),
      'session-child',
    )
    mkdirSync(directory, { recursive: true })
    const complete = [
      childHeader('session-child', 'session-root', workspace, 2_000),
      {
        type: 'assistant/message',
        seq: 1,
        time: 2_100,
        data: {
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: '密钥是 {{SECRET_ab12cd34ef56}}。' },
            ],
          },
        },
      },
    ]
    const text = `${complete.map(record => JSON.stringify(record)).join('\n')}\n{"type":"tool/c`
    writeFileSync(
      join(directory, 'session.v4.jsonl.zstd'),
      zstdCompressSync(Buffer.from(text)),
    )
    const transcripts = readDshSubagentTranscripts('session-root', workspace, {
      sessionsRoot,
      restore: value => value.replaceAll('{{SECRET_ab12cd34ef56}}', 'sk-real'),
    })
    expect(transcripts).toHaveLength(1)
    expect(transcripts[0]?.entries).toHaveLength(1)
    expect(transcripts[0]?.entries[0]?.detail).toBe('密钥是 sk-real。')
  })

  it('returns empty when the project directory does not exist', () => {
    const sessionsRoot = temporaryDirectory('pegas-subagent-missing-')
    expect(
      readDshSubagentTranscripts('session-root', '/tmp/never-ran-here', {
        sessionsRoot,
      }),
    ).toEqual([])
  })
})

class DelegatingExecutor implements RunExecutor {
  readonly name = 'delegating-test'

  execute(input: ExecutorInput): Promise<ExecutorResult> {
    input.onProgress?.({
      type: 'tool_call',
      callId: 'call-delegate',
      tool: 'subagent',
      input:
        '{"description":"统计 docs 文件","prompt":"数一下 docs 目录的文件数"}',
    })
    input.onProgress?.({
      type: 'tool_result',
      callId: 'call-delegate',
      status: 'completed',
      result: 'started subagent agent-1',
    })
    return Promise.resolve({
      executorRef: 'session-root',
      output: 'docs 共 29 个文件。',
    })
  }
}

describe('EXEC-006 subagent transcripts through the worker and API', () => {
  it('persists collected child transcripts owner-scoped and serves them via the API', async () => {
    const store = openStore()
    const sessionsRoot = temporaryDirectory('pegas-subagent-e2e-')
    const workspace = process.cwd()
    writeSessionLog(sessionsRoot, workspace, 'session-child', [
      childHeader('session-child', 'session-root', workspace, Date.now()),
      {
        type: 'tool/call',
        seq: 1,
        time: Date.now(),
        data: {
          callId: 'call-child',
          name: 'bash',
          arguments: '{"command":"ls docs | wc -l"}',
        },
      },
      {
        type: 'tool/result',
        seq: 2,
        time: Date.now(),
        surfaceOp: 'append',
        data: {
          message: {
            role: 'tool',
            toolCallId: 'call-child',
            content: [{ type: 'text', text: '29' }],
          },
        },
      },
    ])
    const executor = new DelegatingExecutor()
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '委派子任务统计 docs 文件数' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
      'subagent-router',
      undefined,
      { collectWindowMs: 0 },
    )
    const claimed = store.claimNextRun('subagent-worker')
    if (!claimed) throw new Error('Expected run claim')
    await executeClaimedRun(
      store,
      executor,
      claimed,
      'subagent-worker',
      workspace,
      new AbortController().signal,
      'http://127.0.0.1:4317',
      undefined,
      input =>
        readDshSubagentTranscripts(input.rootSessionId, input.workspace, {
          sessionsRoot,
        }),
    )
    const report = store.listRunSubagents(claimed.run.id, 'owner')
    expect(report?.subagents).toHaveLength(1)
    const child = report?.subagents[0]
    expect(child?.sessionId).toBe('session-child')
    const tool = child?.entries.find(entry => entry.kind === 'tool_call')
    expect(tool?.detail).toContain('ls docs | wc -l')
    expect(tool?.detail).toContain('29')
    expect(store.listRunSubagents(claimed.run.id, 'intruder')).toBeUndefined()
    const activity = store.listRunActivity(claimed.run.id, 'owner')
    const delegation = activity?.entries.find(
      entry => entry.kind === 'tool_call' && entry.tool === 'subagent',
    )
    expect(delegation?.detail).toContain('统计 docs 文件')
    expect(delegation?.detail).toContain('started subagent agent-1')

    const server = createControlPlane({ store })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const response = await fetch(
      `${base}/v1/runs/${claimed.run.id}/subagents?userId=owner`,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      subagents: { sessionId: string }[]
    }
    expect(body.subagents[0]?.sessionId).toBe('session-child')
    const foreign = await fetch(
      `${base}/v1/runs/${claimed.run.id}/subagents?userId=intruder`,
    )
    expect(foreign.status).toBeGreaterThanOrEqual(400)
  })

  it('never fails the run when the collector throws', async () => {
    const store = openStore()
    const executor = new DelegatingExecutor()
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '委派但日志损坏' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
      'subagent-router',
      undefined,
      { collectWindowMs: 0 },
    )
    const claimed = store.claimNextRun('subagent-worker')
    if (!claimed) throw new Error('Expected run claim')
    await executeClaimedRun(
      store,
      executor,
      claimed,
      'subagent-worker',
      process.cwd(),
      new AbortController().signal,
      'http://127.0.0.1:4317',
      undefined,
      () => {
        throw new Error('torn log')
      },
    )
    const runs = store.listRuns(claimed.task.id)
    expect(runs[0]?.status).toBe('completed')
    expect(store.listRunSubagents(claimed.run.id, 'owner')?.subagents).toEqual(
      [],
    )
  })

  it('sweeps child transcripts while the run is still executing', async () => {
    const store = openStore()
    const sessionsRoot = temporaryDirectory('pegas-subagent-live-')
    const workspace = process.cwd()
    writeSessionLog(sessionsRoot, workspace, 'session-child', [
      childHeader('session-child', 'session-root', workspace, Date.now()),
      {
        type: 'subagent/descriptor',
        seq: 0,
        time: Date.now(),
        data: { label: '统计 docs 文件' },
      },
      {
        type: 'tool/call',
        seq: 1,
        time: Date.now(),
        data: {
          callId: 'call-live',
          name: 'glob',
          arguments: '{"pattern":"docs/*.md"}',
        },
      },
    ])
    const observedDuringRun: number[] = []
    const executor: RunExecutor = {
      name: 'live-delegating-test',
      execute: input => {
        input.onExecutorRef?.('session-root')
        input.onProgress?.({
          type: 'tool_call',
          callId: 'call-delegate',
          tool: 'subagent',
          input: '{"description":"统计 docs 文件","prompt":"数一下"}',
        })
        // The sweep is throttled; the first progress event triggers it.
        observedDuringRun.push(
          store.listRunSubagents(claimedRunId, 'owner')?.subagents.length ?? 0,
        )
        input.onProgress?.({
          type: 'tool_result',
          callId: 'call-delegate',
          status: 'completed',
          result: 'started subagent agent-1',
        })
        return Promise.resolve({
          executorRef: 'session-root',
          output: 'done',
        })
      },
    }
    store.enqueueEvent({
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      authenticatedActor: 'human',
      payload: { text: '运行中就要看到子任务' },
    })
    await processNextEvent(
      store,
      new RoutingEventHandler(new RuleBasedTaskRouter(), executor.name),
      'subagent-router',
      undefined,
      { collectWindowMs: 0 },
    )
    const claimed = store.claimNextRun('subagent-worker')
    if (!claimed) throw new Error('Expected run claim')
    const claimedRunId = claimed.run.id
    await executeClaimedRun(
      store,
      executor,
      claimed,
      'subagent-worker',
      workspace,
      new AbortController().signal,
      'http://127.0.0.1:4317',
      undefined,
      input =>
        readDshSubagentTranscripts(input.rootSessionId, input.workspace, {
          sessionsRoot,
        }),
    )
    expect(observedDuringRun).toEqual([1])
    const report = store.listRunSubagents(claimedRunId, 'owner')
    expect(report?.subagents[0]?.label).toBe('统计 docs 文件')
    expect(store.listRuns(claimed.task.id)[0]?.status).toBe('completed')
  })
})
