import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseVisualDiff, type VisualDiff } from '../src/visual-diff/model.js'
import { renderVisualDiff } from '../src/visual-diff/render.js'
import { verifyVisualDiff } from '../src/visual-diff/git.js'
import {
  prepareVisualDiffReport,
  visibleVisualDiffText,
} from '../src/visual-diff/protocol.js'
import { executorPrompt } from '../src/executor/dsh-cli-executor.js'
import type { AddressInfo } from 'node:net'
import { loadConfig } from '../src/core/config.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  runtimeSettingsDefaults,
  parseRuntimeSettingsUpdate,
  settingsCapabilities,
} from '../src/settings/runtime-settings.js'
import { RuleBasedTaskRouter } from '../src/router/router.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'
import { createControlPlane } from '../src/control-plane/server.js'

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture')
  return value
}

let directory: string, fixture: VisualDiff
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'pegas-visual-diff-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Visual Diff Test')
  git('config', 'user.email', 'test@example.invalid')
  writeFileSync(
    join(directory, 'flow.ts'),
    'export function run() {\n  return false\n}\n',
  )
  symlinkSync('flow.ts', join(directory, 'link.ts'))
  git('add', '.')
  git('commit', '-qm', 'before')
  const base = git('rev-parse', 'HEAD')
  writeFileSync(
    join(directory, 'flow.ts'),
    'export function run() {\n  return true\n}\n',
  )
  writeFileSync(join(directory, 'added.ts'), 'export const ready = true\n')
  git('add', '.')
  git('commit', '-qm', 'after')
  const sources = (line: number) =>
    (['base', 'head'] as const).map(side => ({ side, path: 'flow.ts', line }))
  fixture = {
    version: 1,
    title: '返回就绪状态',
    summary: '现在返回 true；此图不是测试证据。',
    base,
    head: git('rev-parse', 'HEAD'),
    nodes: [
      {
        id: 'entry',
        label: '函数入口',
        before: '调用 run',
        after: '调用 run',
        change: 'unchanged',
        sources: sources(1),
      },
      {
        id: 'result',
        label: '返回值',
        before: '返回 false',
        after: '返回 true',
        change: 'modified',
        sources: sources(2),
      },
    ],
    beforeEdges: [{ from: 'entry', to: 'result', label: '' }],
    afterEdges: [{ from: 'entry', to: 'result', label: '' }],
    ignored: [],
  }
})

async function seed(enabled: boolean, database = ':memory:') {
  const store = new PegasStore(database)
  store.initializeRuntimeSettings({
    ...runtimeSettingsDefaults(loadConfig({})),
    visualDiffEnabled: enabled,
  })
  store.enqueueEvent({
    userId: 'owner',
    type: 'user.message',
    source: 'web',
    authenticatedActor: 'human',
    payload: { text: '实现就绪状态' },
  })
  await processNextEvent(
    store,
    new RoutingEventHandler(new RuleBasedTaskRouter(), 'visual-test'),
    'worker',
  )
  const claimed = store.claimNextRun('worker')
  if (!claimed) throw new Error('Missing test Run')
  return { store, claimed }
}

describe('NOTIFY-007 report integration', () => {
  it('persists the setting, preserves omitted fields, and rejects malformed booleans', () => {
    const database = join(directory, 'setting.sqlite')
    let store = new PegasStore(database)
    const defaults = runtimeSettingsDefaults(loadConfig({}))
    expect(store.initializeRuntimeSettings(defaults).visualDiffEnabled).toBe(
      false,
    )
    store.updateRuntimeSettings(1, { ...defaults, visualDiffEnabled: true })
    const { visualDiffEnabled: omitted, ...legacy } = defaults
    expect(omitted).toBe(false)
    expect(store.updateRuntimeSettings(2, legacy).visualDiffEnabled).toBe(true)
    store.close()
    store = new PegasStore(database)
    expect(store.getRuntimeSettings().visualDiffEnabled).toBe(true)
    const payload = {
      ...defaults,
      expectedRevision: 3,
      visualDiffEnabled: 'true',
    }
    expect(() =>
      parseRuntimeSettingsUpdate(payload, settingsCapabilities(loadConfig({}))),
    ).toThrow('visualDiffEnabled')
    store.updateRuntimeSettings(3, { ...defaults, visualDiffEnabled: false })
    expect(store.getRuntimeSettings().visualDiffEnabled).toBe(false)
    store.close()
  })

  it.each([false, true])(
    'completes a real Worker report with opt-in=%s',
    async enabled => {
      const { store, claimed } = await seed(enabled)
      try {
        await executeClaimedRun(
          store,
          {
            name: 'visual-test',
            execute: input => {
              expect(input.visualDiffEnabled).toBe(enabled)
              return Promise.resolve({
                executorRef: 'session',
                output: `完成了就绪状态修改。\n<pegas_visual_diff>${JSON.stringify(fixture)}</pegas_visual_diff>`,
              })
            },
          },
          claimed,
          'worker',
          directory,
          new AbortController().signal,
          'http://127.0.0.1:4317',
        )
        const run = required(store.listRuns(claimed.task.id)[0])
        expect(run.status).toBe('completed')
        expect(run.output).not.toContain('pegas_visual_diff>')
        expect(Boolean(store.runVisualDiff(run.id, 'owner'))).toBe(enabled)
        expect(store.runVisualDiff(run.id, 'other')).toBeUndefined()
        if (enabled) {
          expect(run.output).toContain(
            `/v1/runs/${run.id}/visual-diff?userId=owner`,
          )
          expect(JSON.stringify(store.listOutbox('owner'))).toContain(
            'visual-diff?userId=owner',
          )
        } else expect(run.output).not.toContain('/visual-diff')
      } finally {
        store.close()
      }
    },
  )

  it('keeps the report successful on invalid generation and on opt-out during execution', async () => {
    for (const disable of [false, true]) {
      const { store, claimed } = await seed(true)
      try {
        await executeClaimedRun(
          store,
          {
            name: 'visual-test',
            execute: () => {
              if (disable) {
                const settings = store.getRuntimeSettings()
                store.updateRuntimeSettings(settings.revision, {
                  ...settings,
                  visualDiffEnabled: false,
                })
              }
              return Promise.resolve({
                executorRef: 'session',
                output: '文字交付<pegas_visual_diff>{}</pegas_visual_diff>',
              })
            },
          },
          claimed,
          'worker',
          directory,
          new AbortController().signal,
          'http://127.0.0.1:4317',
        )
        const run = required(store.listRuns(claimed.task.id)[0])
        expect(run.status).toBe('completed')
        expect(run.output).toContain('文字交付')
        expect(store.runVisualDiff(run.id, 'owner')).toBeUndefined()
        expect(run.output?.includes('流程图未生成')).toBe(!disable)
      } finally {
        store.close()
      }
    }
  })

  it('saves SVG atomically with completion, rejects stale ownership and survives reopen', async () => {
    const database = join(directory, 'run.sqlite')
    const seeded = await seed(true, database)
    let store = seeded.store
    const claimed = seeded.claimed
    const prepared = await prepareVisualDiffReport(
      `正文<pegas_visual_diff>${JSON.stringify(fixture)}</pegas_visual_diff>`,
      true,
      directory,
    )
    const result = { executorRef: 'session', ...prepared }
    expect(() =>
      store.completeRun(claimed.run.id, 'wrong-worker', result),
    ).toThrow()
    expect(store.runVisualDiff(claimed.run.id, 'owner')).toBeUndefined()
    store.completeRun(claimed.run.id, 'worker', result)
    expect(() => store.completeRun(claimed.run.id, 'worker', result)).toThrow()
    const bytes = store.runVisualDiff(claimed.run.id, 'owner')
    store.close()
    store = new PegasStore(database)
    expect(store.runVisualDiff(claimed.run.id, 'owner')).toEqual(bytes)
    expect(
      store
        .listOutbox('owner')
        .filter(item => JSON.stringify(item).includes('/visual-diff')),
    ).toHaveLength(1)
    store.close()
  })

  it('serves only authenticated owner SVG bytes with a restrictive content policy', async () => {
    const { store, claimed } = await seed(true)
    const prepared = await prepareVisualDiffReport(
      `正文<pegas_visual_diff>${JSON.stringify(fixture)}</pegas_visual_diff>`,
      true,
      directory,
    )
    store.completeRun(claimed.run.id, 'worker', {
      executorRef: 'session',
      ...prepared,
    })
    const server = createControlPlane({ store, apiToken: 'visual-test-token' })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const url = `http://127.0.0.1:${String(port)}/v1/runs/${claimed.run.id}/visual-diff`
      expect((await fetch(`${url}?userId=owner`)).status).toBe(401)
      const headers = { authorization: 'Bearer visual-test-token' }
      expect((await fetch(`${url}?userId=other`, { headers })).status).toBe(404)
      const response = await fetch(`${url}?userId=owner`, { headers })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/svg+xml')
      expect(response.headers.get('content-security-policy')).toContain(
        "default-src 'none'",
      )
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(await response.text()).toBe(prepared.visualDiff?.svg)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      )
      store.close()
    }
  })
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('NOTIFY-007 portable visual diff', () => {
  it('checks both commits and exact changed lines against a real Git repository', async () => {
    expect(await verifyVisualDiff(fixture, directory)).toEqual(fixture)
    const result = await prepareVisualDiffReport(
      `已完成。\n<pegas_visual_diff>${JSON.stringify(fixture)}</pegas_visual_diff>`,
      true,
      directory,
    )
    expect(result.output).toBe('已完成。')
    expect(result.visualDiff?.svg).toContain('返回 true')
    expect(result.visualDiff?.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each(['line', 'hunk', 'revision', 'symlink', 'ignored'])(
    'fails closed on invalid %s evidence',
    async kind => {
      const spec = structuredClone(fixture)
      if (kind === 'line')
        required(required(spec.nodes[1]).sources[0]).line = 900
      if (kind === 'hunk')
        required(spec.nodes[1]).sources.forEach(source => {
          source.line = 1
        })
      if (kind === 'revision') spec.head = 'a'.repeat(40)
      if (kind === 'symlink')
        required(required(spec.nodes[0]).sources[0]).path = 'link.ts'
      if (kind === 'ignored')
        spec.ignored = [{ path: 'not-changed.ts', reason: '格式' }]
      await expect(verifyVisualDiff(spec, directory)).rejects.toThrow()
      const report = await prepareVisualDiffReport(
        `正文\n<pegas_visual_diff>${JSON.stringify(spec)}</pegas_visual_diff>`,
        true,
        directory,
      )
      expect(report.output).toContain('文字汇报已保留')
      expect(report.output).not.toContain(directory)
      expect(report.visualDiff).toBeUndefined()
    },
  )

  it.each([
    '../secret',
    '/etc/passwd',
    '.git/config',
    '-flag',
    'file:secret',
    'a\\b',
  ])('rejects unsafe source path %s', path => {
    const spec = structuredClone(fixture)
    required(required(spec.nodes[0]).sources[0]).path = path
    expect(() => parseVisualDiff(spec)).toThrow()
  })

  it('validates classification, graph endpoints and bounded input', () => {
    const bad: unknown[] = [
      null,
      {},
      { ...fixture, version: 2 },
      { ...fixture, base: 'HEAD~1' },
      { ...fixture, head: fixture.base },
      { ...fixture, nodes: [] },
      { ...fixture, title: 'x'.repeat(81) },
      { ...fixture, afterEdges: [{ from: 'missing', to: 'entry' }] },
      { ...fixture, beforeEdges: [{ from: 'entry', to: 'entry' }] },
    ]
    const spec = structuredClone(fixture)
    required(spec.nodes[1]).change = 'unchanged'
    bad.push(spec)
    bad.push({ ...fixture, nodes: [fixture.nodes[0], fixture.nodes[0]] })
    bad.push({
      ...fixture,
      afterEdges: [...fixture.afterEdges, ...fixture.afterEdges],
    })
    for (const value of bad) expect(() => parseVisualDiff(value)).toThrow()
  })

  it('renders added/removed nodes and branching edges without inventing missing connections', () => {
    const spec = structuredClone(fixture)
    spec.nodes.push({
      id: 'newStep',
      label: '新增',
      before: null,
      after: '新路径',
      change: 'added',
      sources: [{ side: 'head', path: 'added.ts', line: 1 }],
    })
    spec.nodes.push({
      id: 'oldStep',
      label: '删除',
      before: '旧路径',
      after: null,
      change: 'removed',
      sources: [{ side: 'base', path: 'flow.ts', line: 2 }],
    })
    spec.afterEdges.push({ from: 'entry', to: 'newStep', label: '条件' })
    spec.beforeEdges.push({ from: 'result', to: 'oldStep', label: '旧条件' })
    const svg = renderVisualDiff(parseVisualDiff(spec))
    expect(svg).toContain('+ 新增')
    expect(svg).toContain('− 删除')
    expect(svg).toContain('条件')
    expect(svg).toContain('absent')
    spec.beforeEdges.push({ from: 'entry', to: 'newStep', label: '' })
    expect(() => parseVisualDiff(spec)).toThrow()
  })

  it('runs the standalone CLI against real Git and refuses invalid input or overwrites', () => {
    const input = join(directory, 'spec.json')
    const output = join(directory, 'standalone.svg')
    writeFileSync(input, JSON.stringify(fixture))
    const run = (target: string) =>
      spawnSync(
        process.execPath,
        ['--import', 'tsx', 'src/visual-diff/cli.ts', input, target, directory],
        { encoding: 'utf8' },
      )
    expect(run(output).status).toBe(0)
    const svg = readFileSync(output, 'utf8')
    expect(svg).toContain('返回 true')
    expect(run(output).status).toBe(1)
    expect(readFileSync(output, 'utf8')).toBe(svg)
    writeFileSync(input, '{}')
    const invalid = join(directory, 'invalid.svg')
    expect(run(invalid).status).toBe(1)
    expect(existsSync(invalid)).toBe(false)
  })

  it('escapes model text and produces deterministic finite, reduced-motion-aware SVG', () => {
    const spec = structuredClone(fixture)
    spec.title = '<script>alert("x")</script> & test'
    spec.ignored = [{ path: 'flow.ts', reason: '仅示例，不作为自动噪声判定' }]
    const svg = renderVisualDiff(parseVisualDiff(spec))
    expect(svg).not.toContain('<script>')
    expect(svg).not.toContain('foreignObject')
    expect(svg).not.toContain('repeatCount="indefinite"')
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).toContain('prefers-reduced-motion:reduce')
    expect(svg).toContain('Agent 分类')
    expect(renderVisualDiff(parseVisualDiff(spec))).toBe(svg)
  })

  it('keeps opt-in out of the default prompt and strips complete/partial machine data', async () => {
    expect(executorPrompt('任务')).not.toContain(
      'pegas_visual_diff_instructions',
    )
    expect(
      executorPrompt('任务', undefined, undefined, undefined, true),
    ).toContain('pegas_visual_diff_instructions')
    const start = '<pegas_visual_diff>'
    for (let length = 1; length <= start.length; length++) {
      expect(visibleVisualDiffText(`正文${start.slice(0, length)}`)).toBe(
        '正文',
      )
    }
    const disabled = await prepareVisualDiffReport(
      '正文<pegas_visual_diff>invalid</pegas_visual_diff>',
      false,
      '/does-not-exist',
    )
    expect(disabled).toEqual({ output: '正文' })
    expect(await prepareVisualDiffReport('正文', true, directory)).toEqual({
      output: '正文',
    })
    for (const body of ['{', '{}', 'x'.repeat(40_000)]) {
      const failed = await prepareVisualDiffReport(
        `正文<pegas_visual_diff>${body}`,
        true,
        directory,
      )
      expect(failed.output).toContain('未生成')
      expect(failed.visualDiff).toBeUndefined()
    }
  })
})
