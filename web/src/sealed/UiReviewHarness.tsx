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
  | 'task-web-agent'
  | 'task-todo-search'
  | 'task-run-artifacts'
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
    meta?: RunActivityEntry['meta']
    step?: RunActivityEntry['step']
  },
): RunActivityEntry {
  return {
    seq,
    kind: partial.kind ?? 'tool_call',
    status: partial.status ?? 'completed',
    ...(partial.tool
      ? { tool: partial.tool, callId: `call-${String(seq)}` }
      : {}),
    ...(partial.step !== undefined ? { step: partial.step } : {}),
    label: partial.label,
    ...(partial.detail !== undefined ? { detail: partial.detail } : {}),
    ...(partial.semantic ? { semantic: partial.semantic } : {}),
    ...(partial.meta ? { meta: partial.meta } : {}),
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
    activityEntry(12, {
      kind: 'step',
      status: 'started',
      step: 1,
      label: '第 1 步开始',
    }),
    activityEntry(13, {
      kind: 'thinking',
      label: '先确认工作区状态，再决定合并顺序。',
      detail:
        '先确认工作区状态，再决定合并顺序。冲突大概率出现在 api.ts，需要先 grep 冲突标记。',
    }),
    activityEntry(15, {
      kind: 'thinking',
      label: '合并顺序确认：CONV-005 先行。',
      detail:
        '合并顺序确认：CONV-005 先行，DESKTOP-001 的 smoke 修复随后，最后清理旧 worktree。',
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
    activityEntry(14, {
      kind: 'step',
      status: 'completed',
      step: 1,
      label: '第 1 步完成',
    }),
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
    ...(running
      ? [
          activityEntry(16, {
            kind: 'thinking',
            status: 'started',
            label: '正在核对 smoke 场景覆盖。',
            detail: '正在核对 smoke 场景覆盖，等待 worker 心跳后确认 18/18。',
          }),
        ]
      : []),
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

function webAgentEntries(): RunActivityEntry[] {
  return [
    activityEntry(1, {
      kind: 'text',
      label: '先查成都社保补缴规则，再让子 agent 复核。',
      detail: '先查**成都社保补缴规则**，再让子 agent 复核缴费口径。',
    }),
    activityEntry(2, {
      tool: 'web_search',
      label: 'web_search',
      detail: JSON.stringify({
        queries: ['成都 社保 补缴 规则 2026', '养老保险 缴费 金额'],
      }),
      semantic: {
        kind: 'web',
        query: '成都 社保 补缴 规则 2026',
        queries: ['成都 社保 补缴 规则 2026', '养老保险 缴费 金额'],
        sources: [
          {
            url: 'http://sc.people.com.cn/n2/2026/0109/c345167-41467721.html',
            title: '2026年成都市城乡居民基本养老保险缴费金额公布',
            snippet: '缴费金额公布 (2026-01-09)',
          },
          {
            url: 'https://cdhrss.chengdu.gov.cn/cdrsj/c152160/faq.shtml',
            title: '成都人社局 · 补缴常见问题',
            snippet: '断缴后可按年度补缴，滞纳金按日计收。',
          },
          {
            url: 'https://sichuan.scol.com.cn/ggxw/202601/82777.html',
            title: '四川在线 · 社保补缴答疑',
          },
        ],
        sourcesTruncated: true,
        preview:
          'Sources:\n- [人民网](http://sc.people.com.cn/n2/2026/0109/c345167-41467721.html) — 缴费金额公布 (2026-01-09)',
      },
    }),
    activityEntry(3, {
      tool: 'web_fetch',
      label: 'web_fetch',
      detail: JSON.stringify({
        url: 'http://sc.people.com.cn/n2/2026/0109/c345167-41467721.html',
      }),
      semantic: {
        kind: 'web',
        url: 'http://sc.people.com.cn/n2/2026/0109/c345167-41467721.html',
        statusCode: 200,
        preview:
          '2026年成都市城乡居民基本养老保险缴费金额公布\n\n缴费档次共 13 档，最高档每年 6000 元…',
      },
    }),
    activityEntry(4, {
      tool: 'wait_agent',
      label: 'wait_agent',
      detail: '{"timeout_ms":60000}',
      semantic: {
        kind: 'agent_control',
        action: 'wait',
        timeoutMs: 60_000,
        timedOut: false,
      },
    }),
    activityEntry(5, {
      tool: 'send_message',
      label: 'send_message',
      detail: JSON.stringify({
        agent: 'count-tests',
        message: '结果 78 已收到并确认，请直接以「78」作为最终答复结束任务。',
      }),
      semantic: {
        kind: 'agent_control',
        action: 'message',
        agent: 'count-tests',
        message: '结果 78 已收到并确认，请直接以「78」作为最终答复结束任务。',
      },
    }),
    activityEntry(6, {
      tool: 'list_agents',
      label: 'list_agents',
      detail: '{}',
      semantic: {
        kind: 'agent_control',
        action: 'list',
        agents: [
          { name: 'lead', status: 'running', description: 'root agent' },
          {
            name: 'pkg-version',
            status: 'inactive',
            description: '查看 package 版本',
          },
          {
            name: 'count-tests',
            status: 'running',
            description: '统计仓库测试文件',
          },
        ],
      },
    }),
    activityEntry(7, {
      tool: 'wait_agent',
      label: 'wait_agent',
      status: 'started',
      detail: '{"timeout_ms":120000}',
      semantic: {
        kind: 'agent_control',
        action: 'wait',
        timeoutMs: 120_000,
      },
    }),
  ]
}

function webAgentView(): DrawerView {
  const base = taskView('completed')
  if (base.kind !== 'task' || !base.run) return base
  const entries = webAgentEntries()
  return {
    ...base,
    activityByRun: {
      [base.run.id]: {
        runId: base.run.id,
        taskId: channel.id,
        entries,
        totalEntries: entries.length,
        truncated: false,
      },
    },
  }
}

function todoSearchEntries(): RunActivityEntry[] {
  return [
    activityEntry(1, {
      kind: 'text',
      label: '先列计划，再定位实现，最后补测试。',
      detail: '先列**任务清单**，再定位 `runActivity` 的实现，最后补测试。',
    }),
    activityEntry(2, {
      tool: 'todo_write',
      label: 'todo_write',
      detail: JSON.stringify({
        todos: [
          { content: '读取 activity API 现有实现', status: 'completed' },
          { content: '定位 runActivity 调用点', status: 'in_progress' },
          { content: '补齐语义投影回归测试', status: 'pending' },
          { content: '跑完整门禁并截图对比', status: 'pending' },
        ],
      }),
      semantic: {
        kind: 'todo',
        items: [
          { content: '读取 activity API 现有实现', status: 'completed' },
          { content: '定位 runActivity 调用点', status: 'in_progress' },
          { content: '补齐语义投影回归测试', status: 'pending' },
          { content: '跑完整门禁并截图对比', status: 'pending' },
        ],
      },
    }),
    activityEntry(3, {
      tool: 'grep',
      label: 'grep',
      detail: JSON.stringify({
        pattern: 'runActivity',
        path: 'web/src',
        include: '*.ts',
      }),
      semantic: {
        kind: 'search',
        query: 'runActivity',
        path: 'web/src',
        include: '*.ts',
        shape: 'matches',
        total: 4,
        files: [
          {
            path: 'web/src/api.ts',
            matches: [
              {
                line: 93,
                text: 'async runActivity(runId: string): Promise<RunActivityReport> {',
              },
              {
                line: 97,
                text: 'return this.get(`/v1/runs/${runId}/activity`)',
              },
            ],
          },
          {
            path: 'web/src/types.ts',
            matches: [
              { line: 208, text: 'export interface RunActivityReport {' },
            ],
          },
          {
            path: 'web/src/sealed/DetailDrawer.tsx',
            matches: [
              {
                line: 412,
                text: 'const report = await api.runActivity(runId)',
              },
            ],
          },
        ],
      },
    }),
    activityEntry(4, {
      tool: 'glob',
      label: 'glob',
      detail: '{"pattern":"test/**/*.test.ts"}',
      semantic: {
        kind: 'search',
        query: 'test/**/*.test.ts',
        shape: 'paths',
        total: 98,
        resultTruncated: true,
        paths: [
          'test/tool-semantics.test.ts',
          'test/live-execution-feedback.test.ts',
          'test/chat-experience-server.test.ts',
          'test/execution-pools.test.ts',
          'test/delivery-reconciliation.test.ts',
          'test/dsh-home.test.ts',
        ],
      },
    }),
    activityEntry(5, {
      tool: 'todo_write',
      label: 'todo_write',
      detail: JSON.stringify({
        todos: [
          { content: '读取 activity API 现有实现', status: 'completed' },
          { content: '定位 runActivity 调用点', status: 'completed' },
          { content: '补齐语义投影回归测试', status: 'in_progress' },
          { content: '跑完整门禁并截图对比', status: 'pending' },
        ],
      }),
      semantic: {
        kind: 'todo',
        items: [
          { content: '读取 activity API 现有实现', status: 'completed' },
          { content: '定位 runActivity 调用点', status: 'completed' },
          { content: '补齐语义投影回归测试', status: 'in_progress' },
          { content: '跑完整门禁并截图对比', status: 'pending' },
        ],
      },
    }),
    activityEntry(6, {
      tool: 'todo_write',
      label: 'todo_write',
      detail: JSON.stringify({
        todos: [
          { content: '读取 activity API 现有实现', status: 'completed' },
          { content: '定位 runActivity 调用点', status: 'completed' },
          { content: '补齐语义投影回归测试', status: 'completed' },
          { content: '跑完整门禁并截图对比', status: 'in_progress' },
        ],
      }),
      semantic: {
        kind: 'todo',
        items: [
          { content: '读取 activity API 现有实现', status: 'completed' },
          { content: '定位 runActivity 调用点', status: 'completed' },
          { content: '补齐语义投影回归测试', status: 'completed' },
          { content: '跑完整门禁并截图对比', status: 'in_progress' },
        ],
      },
    }),
    activityEntry(7, {
      tool: 'ask_user_question',
      label: 'ask_user_question',
      detail: JSON.stringify({
        questions: [
          {
            id: 'gate',
            question: '门禁全绿后直接合入 main 吗？',
            header: '合并方式',
            options: [
              {
                label: '走 PR + CI (Recommended)',
                description: '留下可审查记录',
              },
              { label: '直接本地合并', description: '更快但少一道审查' },
            ],
          },
        ],
      }),
      semantic: {
        kind: 'ask_user',
        questions: [
          {
            id: 'gate',
            question: '门禁全绿后直接合入 main 吗？',
            header: '合并方式',
            options: [
              {
                label: '走 PR + CI (Recommended)',
                description: '留下可审查记录',
              },
              { label: '直接本地合并', description: '更快但少一道审查' },
            ],
          },
        ],
        answers: [{ id: 'gate', selected: ['走 PR + CI (Recommended)'] }],
      },
    }),
    activityEntry(8, {
      tool: 'ask_user_question',
      label: 'ask_user_question',
      detail:
        '{"questions":[{"id":"deploy","question":"要顺带切换运行版本吗？"}]}',
      semantic: {
        kind: 'ask_user',
        questions: [{ id: 'deploy', question: '要顺带切换运行版本吗？' }],
        pending: true,
      },
    }),
  ]
}

function todoSearchView(): DrawerView {
  const base = taskView('completed')
  if (base.kind !== 'task' || !base.run) return base
  const entries = todoSearchEntries()
  return {
    ...base,
    activityByRun: {
      [base.run.id]: {
        runId: base.run.id,
        taskId: channel.id,
        entries,
        totalEntries: entries.length,
        truncated: false,
      },
    },
  }
}

function runArtifactsEntries(): RunActivityEntry[] {
  const edit = (
    seq: number,
    path: string,
    oldText: string,
    newText: string,
  ): RunActivityEntry =>
    activityEntry(seq, {
      tool: 'edit',
      label: 'edit',
      detail: JSON.stringify({
        file_path: path,
        old_string: oldText,
        new_string: newText,
      }),
      semantic: {
        kind: 'file_edit',
        path,
        mode: 'edit',
        additions: newText.split('\n').length,
        deletions: oldText.split('\n').length,
        hunks: [
          {
            oldStart: 90 + seq,
            newStart: 90 + seq,
            lines: [
              ...oldText
                .split('\n')
                .map(text => ({ type: 'del' as const, text })),
              ...newText
                .split('\n')
                .map(text => ({ type: 'add' as const, text })),
            ],
          },
        ],
      },
    })
  return [
    activityEntry(1, {
      kind: 'text',
      label: '修改 API 与类型，然后核对截图并交付。',
      detail: '修改 **API 与类型**，然后核对截图并交付。',
    }),
    edit(
      2,
      'web/src/api.ts',
      'async runActivity(runId: string) {',
      'async runActivity(runId: string): Promise<RunActivityReport> {\n    return this.get(`/v1/runs/${runId}/activity`)',
    ),
    edit(
      3,
      'web/src/types.ts',
      'interface RunActivityReport {',
      'interface RunActivityReport {\n  totalEntries: number\n  truncated: boolean',
    ),
    activityEntry(4, {
      tool: 'read_image',
      label: 'read_image',
      detail: '{"file_path":"/repo/output/desktop-task-web-agent.png"}',
      semantic: {
        kind: 'image',
        path: '/repo/output/desktop-task-web-agent.png',
        mediaType: 'image/png',
        width: 1440,
        height: 900,
        bytes: 92_038,
      },
    }),
    activityEntry(5, {
      kind: 'step',
      label: '上下文已压缩',
      meta: { kind: 'compaction', note: '自动触发' },
    }),
    edit(
      6,
      'web/src/api.ts',
      'return this.get(`/v1/runs/${runId}/activity`)',
      'return this.get(`/v1/runs/${runId}/activity?limit=400`)',
    ),
    activityEntry(7, {
      tool: 'present',
      label: 'present',
      detail: JSON.stringify({
        files: [
          { path: 'output/report.md', description: '执行记录语义化调研结论' },
          { path: 'output/comparison/after.png', description: '改造后截图' },
        ],
      }),
      semantic: {
        kind: 'delivery',
        files: [
          { path: 'output/report.md', description: '执行记录语义化调研结论' },
          { path: 'output/comparison/after.png', description: '改造后截图' },
        ],
      },
    }),
    activityEntry(8, {
      kind: 'step',
      label: '用户插话，本次运行由后继接管',
      meta: { kind: 'steered', note: '顺带把移动端截图也补上' },
    }),
  ]
}

function runArtifactsView(): DrawerView {
  const base = taskView('completed')
  if (base.kind !== 'task' || !base.run) return base
  const entries = runArtifactsEntries()
  return {
    ...base,
    activityByRun: {
      [base.run.id]: {
        runId: base.run.id,
        taskId: channel.id,
        entries,
        totalEntries: entries.length,
        truncated: false,
      },
    },
  }
}

function fixtureView(fixture: ReviewFixture): DrawerView {
  if (fixture === 'task-web-agent') return webAgentView()
  if (fixture === 'task-todo-search') return todoSearchView()
  if (fixture === 'task-run-artifacts') return runArtifactsView()
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
