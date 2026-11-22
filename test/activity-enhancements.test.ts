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
  it('archives the faithful output, pages it, and stays owner-scoped', () => {
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
    const first = store.readRunActivityOutput(
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
    expect(first?.content).toHaveLength(12_000)
    const second = store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-long',
      { offset: 12_000, limit: 32_768 },
    )
    expect(second?.content).toHaveLength(28_000)
    expect(second?.offset).toBe(12_000)
    const beyond = store.readRunActivityOutput(
      claimed.run.id,
      'owner',
      'call-long',
      { offset: 40_000 },
    )
    expect(beyond?.content).toBe('')
    expect(
      store.readRunActivityOutput(claimed.run.id, 'intruder', 'call-long'),
    ).toBeUndefined()
    expect(
      store.readRunActivityOutput(claimed.run.id, 'owner', 'call-none'),
    ).toBeUndefined()
    store.close()
  })

  it('caps the archive honestly at 256KB', () => {
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
    const page = store.readRunActivityOutput(
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
    const ok = await fetch(
      `${base}/v1/runs/${claimed.run.id}/activity/call-http/output?userId=owner&offset=12000`,
    )
    expect(ok.status).toBe(200)
    const page = (await ok.json()) as { content: string; offset: number }
    expect(page.offset).toBe(12_000)
    expect(page.content).toHaveLength(8_000)
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
})
