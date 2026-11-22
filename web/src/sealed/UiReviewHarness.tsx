import type { Run, RunActivityEntry, ToolSemantic, WorkChannel } from '../types'
import { DetailDrawer } from './DetailDrawer'
import type { DrawerView } from './types'

export type ReviewFixture =
  | 'task-completed'
  | 'task-running'
  | 'task-waiting'
  | 'task-failed'
  | 'task-activity'
  | 'task-activity-open'
  | 'task-activity-running'
  | 'preview-file'
  | 'preview-image'
  | 'preview-video'
  | 'preview-web'

const channel: WorkChannel = {
  id: 'review-task',
  taskId: 'review-task',
  userId: 'review',
  originEventId: 'review-event',
  title: '封板状态视觉校验',
  goal: '验证详情抽屉在每一种结构化状态下的视觉与响应式布局',
  status: 'started',
  workerIconId: 'computer',
  canResume: false,
  canStop: true,
  latestActivityAt: '2026-11-20T00:00:00.000Z',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:04:00.000Z',
}

function taskView(status: Run['status']): DrawerView {
  const run: Run = {
    id: `review-${status}`,
    taskId: channel.id,
    executor: 'review-fixture',
    status,
    input: channel.goal,
    output: status === 'completed' ? '结构化结果已由服务端返回。' : undefined,
    attempts: 1,
    lastError:
      status === 'failed' ? '服务端返回：候选运行未通过就绪检查。' : undefined,
    executionContext: {
      executor: 'review-fixture',
      model: 'deepseek-v4.1-flash',
      workerProfile: 'pegas',
      workerProfileRevision: 2,
      workerProfileSource: 'task',
      workspace: '/review/isolated-workspace',
    },
    createdAt: '2026-11-20T00:01:00.000Z',
    updatedAt: '2026-11-20T00:04:00.000Z',
  }
  return {
    kind: 'task',
    channel: {
      ...channel,
      status: status === 'completed' ? 'completed' : 'started',
    },
    run,
    usage:
      status === 'completed'
        ? { totalTokens: 12_480, durationMs: 96_000, costUsd: 0.0184 }
        : undefined,
  }
}

function activityEntry(
  seq: number,
  partial: Pick<RunActivityEntry, 'tool' | 'label' | 'detail'> & {
    status?: RunActivityEntry['status']
    semantic?: ToolSemantic
    kind?: RunActivityEntry['kind']
  },
): RunActivityEntry {
  return {
    seq,
    kind: partial.kind ?? 'tool_call',
    status: partial.status ?? 'completed',
    ...(partial.tool
      ? { tool: partial.tool, callId: `call-${String(seq)}` }
      : {}),
    label: partial.label,
    ...(partial.detail !== undefined ? { detail: partial.detail } : {}),
    ...(partial.semantic ? { semantic: partial.semantic } : {}),
    createdAt: '2026-11-20T00:02:00.000Z',
    updatedAt: '2026-11-20T00:02:30.000Z',
  }
}

function fixtureShell(
  seq: number,
  command: string,
  output: string,
  status: RunActivityEntry['status'] = 'completed',
): RunActivityEntry {
  return activityEntry(seq, {
    tool: 'bash',
    label: 'bash',
    status,
    detail: JSON.stringify({ command }),
    semantic: { kind: 'shell', command, ...(output ? { output } : {}) },
  })
}

function activityEntries(running: boolean): RunActivityEntry[] {
  const workspace = '/Users/ming/Project/pegas-worktrees/conv-005-link-preview'
  const entries: RunActivityEntry[] = [
    activityEntry(1, {
      kind: 'text',
      label: '按顺序来：先合 CONV-005，再合 DESKTOP-001 smoke 修复。',
      detail:
        '按顺序来：先合 **CONV-005**，再合 **DESKTOP-001** smoke 修复，最后清理旧 worktree（脏改动先存档再删）。',
    }),
    fixtureShell(
      2,
      `cd ${workspace} && git status --short | grep -v node_modules | head -3`,
      ' M web/src/api.ts\n M web/src/sealed-ui.css',
    ),
    fixtureShell(
      3,
      `cd ${workspace} && git merge origin/main --no-edit`,
      'Auto-merging web/src/api.ts\nCONFLICT (content): Merge conflict in web/src/api.ts\nAutomatic merge failed; fix conflicts and then commit the result.',
      'error',
    ),
    activityEntry(4, {
      tool: 'grep',
      label: 'grep',
      detail: JSON.stringify({
        pattern: '^<<<<<<<',
        path: 'docs/feature-map.md',
      }),
      semantic: {
        kind: 'search',
        query: '^<<<<<<<',
        path: 'docs/feature-map.md',
        preview: '没有匹配到冲突标记。',
      },
    }),
    activityEntry(5, {
      tool: 'read',
      label: 'read',
      detail: JSON.stringify({ file_path: 'web/src/api.ts' }),
      semantic: {
        kind: 'file_read',
        path: 'web/src/api.ts',
        lineCount: 96,
        preview:
          "73: export class PegasApi {\n74:   async linkPreview(url: string): Promise<LinkPreview> {\n75:     const raw = await this.request('/v1/link-preview', …)\n76:     return projectLinkPreview(raw)\n77:   }",
      },
    }),
    activityEntry(6, {
      tool: 'read',
      label: 'read',
      detail: JSON.stringify({ file_path: 'web/src/types.ts' }),
      semantic: {
        kind: 'file_read',
        path: 'web/src/types.ts',
        lineCount: 688,
        preview:
          "174: export interface RunActivityEntry {\n175:   seq: number\n176:   kind: 'text' | 'thinking' | 'tool_call' | 'step'",
      },
    }),
    activityEntry(7, {
      tool: 'edit',
      label: 'edit',
      detail: JSON.stringify({ file_path: 'web/src/api.ts' }),
      semantic: {
        kind: 'file_edit',
        path: 'web/src/api.ts',
        mode: 'edit',
        additions: 2,
        deletions: 3,
        hunks: [
          {
            lines: [
              { type: 'context', text: 'export class PegasApi {' },
              { type: 'del', text: '<<<<<<< HEAD' },
              {
                type: 'context',
                text: '  async linkPreview(url: string): Promise<LinkPreview> {',
              },
              {
                type: 'context',
                text: '    return projectLinkPreview(raw)',
              },
              { type: 'del', text: '=======' },
              { type: 'add', text: '  }' },
              { type: 'add', text: '' },
              {
                type: 'context',
                text: '  async runActivity(runId: string): Promise<RunActivityReport> {',
              },
              { type: 'del', text: '>>>>>>> origin/main' },
              { type: 'context', text: '  }' },
            ],
          },
        ],
      },
    }),
    fixtureShell(8, `cd ${workspace} && npx tsc -p tsconfig.build.json`, ''),
    fixtureShell(
      9,
      `cd ${workspace} && pnpm exec vitest run test/tool-semantics.test.ts`,
      ' ✓ test/tool-semantics.test.ts (12 tests) 41ms\n\n Test Files  1 passed (1)\n      Tests  12 passed (12)',
    ),
    fixtureShell(
      10,
      `cd ${workspace} && ls node_modules/.bin/vitest`,
      'node_modules/.bin/vitest',
    ),
    fixtureShell(
      11,
      `cd ${workspace} && pnpm smoke`,
      running ? 'smoke: 等待 worker 心跳…' : 'smoke: 18/18 场景通过',
      running ? 'started' : 'completed',
    ),
  ]
  return entries
}

function activityView(
  fixture: 'task-activity' | 'task-activity-open' | 'task-activity-running',
): DrawerView {
  const running = fixture === 'task-activity-running'
  const base = taskView(running ? 'running' : 'completed')
  if (base.kind !== 'task' || !base.run) return base
  const entries = activityEntries(running)
  const now = Date.now()
  const recent = (secondsAgo: number) =>
    new Date(now - secondsAgo * 1000).toISOString()
  const run: Run = running
    ? { ...base.run, createdAt: recent(1164), updatedAt: recent(5) }
    : base.run
  return {
    ...base,
    run,
    channel: {
      ...base.channel,
      createdAt: recent(1200),
      updatedAt: recent(5),
      latestActivityAt: recent(5),
    },
    activityByRun: {
      [run.id]: {
        runId: run.id,
        taskId: channel.id,
        entries: entries.map(entry => ({
          ...entry,
          createdAt: recent(1100 - entry.seq * 60),
          updatedAt: recent(1100 - entry.seq * 60 - 30),
        })),
        totalEntries: entries.length,
        truncated: false,
      },
    },
  }
}

function fixtureView(fixture: ReviewFixture): DrawerView {
  if (
    fixture === 'task-activity' ||
    fixture === 'task-activity-open' ||
    fixture === 'task-activity-running'
  )
    return activityView(fixture)
  if (fixture.startsWith('task-'))
    return taskView(fixture.slice(5) as Run['status'])
  const preview = fixture.slice(8) as 'file' | 'image' | 'video' | 'web'
  return {
    kind: 'preview',
    preview,
    title: {
      file: '执行方案.md',
      image: '流程预览.png',
      video: '发布流程演示.mp4',
      web: '安全发布与自动回滚',
    }[preview],
    description:
      '这是只读 UI review fixture，用于验证服务端产物元数据的封板布局。',
    mimeType: {
      file: 'text/markdown',
      image: 'image/png',
      video: 'video/mp4',
      web: 'text/html',
    }[preview],
    source: 'UI review harness',
  }
}

export function UiReviewHarness({ fixture }: { fixture: ReviewFixture }) {
  return (
    <main className="review-harness">
      <DetailDrawer
        onChange={() => undefined}
        onClose={() => undefined}
        onRetry={() => Promise.resolve()}
        view={fixtureView(fixture)}
      />
    </main>
  )
}
