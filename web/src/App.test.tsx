// @vitest-environment jsdom

import './test-env'

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App, formatRelativeTime } from './App'
import { DetailDrawer } from './sealed/DetailDrawer'
import { Onboarding } from './sealed/Onboarding'
import { unresolvedAttentionMessages } from './sealed/types'
import type {
  Approval,
  DurableAction,
  GoalContract,
  ReviewPack,
  ReviewProjection,
  Run,
  RunActivityEntry,
  SettingsResponse,
  Snapshot,
  TaskArtifact,
  TaskDelivery,
  WorkChannel,
} from './types'

const channel: WorkChannel = {
  id: 'task-1',
  taskId: 'task-1',
  userId: 'owner',
  originEventId: 'event-1',
  title: '安全自更新流程',
  goal: '构建候选版本并在失败时自动回滚',
  status: 'started',
  workerIconId: 'computer',
  canResume: false,
  canStop: true,
  latestActivityAt: '2026-11-19T08:00:00.000Z',
  createdAt: '2026-11-19T07:00:00.000Z',
  updatedAt: '2026-11-19T08:00:00.000Z',
}

const run: Run = {
  id: 'run-1',
  taskId: channel.id,
  executor: 'dsh',
  status: 'running',
  input: channel.goal,
  attempts: 1,
  executionContext: {
    executor: 'dsh',
    model: 'deepseek-v4.1-flash',
    workerProfile: 'worker-profile:task-1',
    workerProfileRevision: 2,
    workerProfileSource: 'task',
  },
  createdAt: '2026-11-19T08:00:00.000Z',
  updatedAt: '2026-11-19T08:02:00.000Z',
}

const snapshot: Snapshot = {
  channels: [channel],
  runs: [run],
  events: [
    {
      id: 'event-1',
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: '帮我设计一个安全的自更新流程。' },
      status: 'processed',
      createdAt: '2026-11-19T07:59:00.000Z',
    },
  ],
  messages: [
    {
      id: 'message-1',
      userId: 'owner',
      taskId: channel.id,
      payload: { text: '我已经整理好方案，正在验证候选版本。' },
      status: 'sent',
      createdAt: '2026-11-19T08:01:00.000Z',
    },
  ],
}

const settingsResponse: SettingsResponse = {
  settings: {
    revision: 1,
    routerMode: 'model',
    modelProvider: 'magpie',
    modelName: 'deepseek-v4.1-flash',
    agentModelMode: 'override',
    agentModelProvider: 'Magpie',
    agentModelName: 'deepseek-v4.1-flash',
    privacyMode: 'mask',
    rewriteMode: 'light',
    updatedAt: '2026-11-19T08:00:00.000Z',
  },
  capabilities: {
    privacyAvailable: true,
    providers: [
      {
        id: 'magpie',
        name: 'Magpie',
        category: 'gateway',
        protocol: 'openai-chat',
        baseUrl: 'https://api-magpie.example/v1',
        defaultModel: 'deepseek-v4.1-flash',
        description: 'Magpie gateway',
        requiresApiKey: true,
        hasApiKey: true,
        available: true,
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        category: 'vendor',
        protocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        defaultModel: 'claude-sonnet-4-5',
        description: 'Anthropic',
        requiresApiKey: true,
        hasApiKey: false,
        available: false,
        reason: '需要 API key',
      },
    ],
  },
  speech: {
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:18081/v1',
    model: 'Qwen/Qwen3-ASR-0.6B',
    hasApiKey: true,
  },
  rewrite: {
    mode: 'router',
    protocol: 'openai-chat',
    baseUrl: '',
    model: '',
    hasApiKey: false,
  },
}

function approvalFixture(id: string): Approval {
  return {
    id,
    taskId: channel.id,
    actionId: `action-${id}`,
    requestRunId: run.id,
    status: 'pending',
    prompt: {
      summary: '发布候选版本',
      impact: '这会把候选版本公开给所有用户。',
      recommendedOptionId: 'reject',
      options: [
        { id: 'approve', label: '发布', kind: 'approve' },
        { id: 'reject', label: '暂不发布', kind: 'reject' },
      ],
    },
    createdAt: '2026-11-20T00:00:00.000Z',
  }
}

function actionFixture(approval: Approval): DurableAction {
  return {
    id: approval.actionId,
    taskId: approval.taskId,
    requestRunId: approval.requestRunId,
    kind: 'publish.release',
    risk: 'high',
    idempotencyKey: `action-${approval.id}`,
    status: approval.status === 'pending' ? 'awaiting_approval' : 'authorized',
    request: { release: 'v1' },
    recoveryPoint: { step: 'before_publish' },
    createdAt: approval.createdAt,
    updatedAt: approval.resolvedAt ?? approval.createdAt,
  }
}

const goalFixture: GoalContract = {
  id: 'goal-1',
  taskId: channel.id,
  revision: 2,
  commandId: 'cmd-goal-1',
  createdAt: '2026-11-20T00:00:00.000Z',
  basedOnEventIds: ['event-1'],
  desiredOutcome: '发布经过验证的候选版本，失败时自动回滚',
  beneficiaries: ['owner'],
  successCriteria: [
    {
      criterionId: 'criterion-verify',
      observableStatement: '候选版本通过健康检查并留存截图',
      required: true,
      evidencePlanRef: 'plan-verify',
    },
    {
      criterionId: 'criterion-rollback',
      observableStatement: '失败时自动回滚到稳定版本',
      required: true,
      evidencePlanRef: 'plan-rollback',
    },
  ],
  nonGoals: ['不修改生产数据库结构'],
  constraints: [],
  contextSources: [],
  assumptions: [],
  unknowns: [],
  prerequisites: [],
  permissionBoundary: {},
  reviewCheckpoints: [],
  evidencePlan: [],
  failureAndRecovery: '失败时回滚到上一个稳定版本。',
  feedbackSignals: [],
}

const artifactFixture: TaskArtifact = {
  id: 'artifact-1',
  taskId: channel.id,
  commandId: 'cmd-artifact-1',
  createdAt: '2026-11-20T00:02:00.000Z',
  runId: run.id,
  name: '候选版本健康检查截图',
  kind: 'image',
  mimeType: 'image/png',
  revision: 'r1',
  contentHash: 'hash-artifact-1',
  metadata: {},
  sensitivity: 'internal',
}

const reviewPackFixture: ReviewPack = {
  id: 'review-pack-1',
  revision: 1,
  taskId: channel.id,
  runId: run.id,
  goalRevision: 2,
  basisEventIds: ['event-1'],
  projectionAsOf: '2026-11-20T00:05:00.000Z',
  finalOutcome: 'partial',
  criteria: [
    {
      criterionId: 'criterion-verify',
      completionStatus: 'satisfied',
      currentValidity: 'valid',
      evidenceRefs: ['evidence-1'],
      explanation: '健康检查通过，截图已存证。',
      limitations: [],
    },
    {
      criterionId: 'criterion-rollback',
      completionStatus: 'unverified',
      currentValidity: 'unknown',
      evidenceRefs: [],
      explanation: '还没有触发过一次真实回滚。',
      limitations: ['缺少回滚演练证据'],
    },
  ],
  sideEffects: [],
  remainingRisks: ['回滚路径未经过真实演练'],
  rollback: { step: 'restore-previous-release' },
  auditLink: `/v1/channels/${channel.id}/timeline`,
  createdAt: '2026-11-20T00:05:00.000Z',
}

const deliveryFixture: TaskDelivery = {
  goal: goalFixture,
  artifacts: [artifactFixture],
  evidence: [
    {
      id: 'evidence-1',
      criterionId: 'criterion-verify',
      kind: 'screenshot',
      artifactId: artifactFixture.id,
      verification: { result: 'passed' },
      sensitivity: 'internal',
      capturedAt: '2026-11-20T00:03:00.000Z',
      presentation: {},
      limitations: [],
    },
  ],
  reviewPack: reviewPackFixture,
}

const reviewProjectionFixture: ReviewProjection = {
  finalOutcome: 'partial',
  goalRevision: 2,
  criteria: [
    {
      criterionId: 'criterion-verify',
      completionStatus: 'satisfied',
      explanation: '健康检查通过，截图已存证。',
      limitations: [],
      evidenceCount: 1,
    },
    {
      criterionId: 'criterion-rollback',
      completionStatus: 'unverified',
      explanation: '还没有触发过一次真实回滚。',
      limitations: ['缺少回滚演练证据'],
      evidenceCount: 0,
    },
  ],
  evidence: [
    {
      evidenceId: 'evidence-1',
      criterionId: 'criterion-verify',
      kind: 'screenshot',
      verification: 'passed',
      sensitivity: 'internal',
      capturedAt: '2026-11-20T00:03:00.000Z',
      contentHash: 'hash-evidence-1',
      viewport: { width: 1280, height: 800 },
      hasContent: true,
      artifact: {
        id: artifactFixture.id,
        name: artifactFixture.name,
        kind: 'image',
        revision: 'r1',
        mimeType: 'image/png',
      },
      presentation: {},
      limitations: [],
    },
  ],
  remainingRisks: ['回滚路径未经过真实演练'],
  rollback: { step: 'restore-previous-release' },
  auditLink: `/v1/channels/${channel.id}/timeline`,
}

function installFetch(
  custom?: (
    path: string,
    init?: RequestInit,
  ) => Response | Promise<Response> | undefined,
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      input instanceof URL
        ? input.href
        : input instanceof Request
          ? input.url
          : input
    const overridden = custom?.(path, init)
    if (overridden) return Promise.resolve(overridden)
    if (path.startsWith('/v1/events?'))
      return Promise.resolve(Response.json({ events: snapshot.events }))
    if (path.startsWith('/v1/channels/search?')) {
      const query =
        new URL(path, 'http://localhost').searchParams.get('q') ?? ''
      const matched = snapshot.channels.filter(item =>
        `${item.title} ${item.goal}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
      return Promise.resolve(
        Response.json({
          channels: matched,
          matches: matched.map(item => ({
            channelId: item.id,
            sourceKind: 'title',
            sourceId: item.id,
            snippet: `服务端命中：${item.title}`,
          })),
        }),
      )
    }
    if (path.startsWith('/v1/channels?'))
      return Promise.resolve(Response.json({ channels: snapshot.channels }))
    if (path.startsWith('/v1/channels/task-1/timeline?'))
      return Promise.resolve(
        Response.json({
          channel,
          events: snapshot.events,
          messages: snapshot.messages,
          runs: snapshot.runs,
        }),
      )
    if (path.startsWith('/v1/runs?'))
      return Promise.resolve(Response.json({ runs: snapshot.runs }))
    if (path.startsWith('/v1/outbox?'))
      return Promise.resolve(Response.json({ messages: snapshot.messages }))
    if (/^\/v1\/tasks\/[^/]+\/delivery\?/.test(path))
      return Promise.resolve(
        Response.json({ artifacts: [], evidence: [], continuation: {} }),
      )
    if (/^\/v1\/tasks\/[^/]+\/worker-profile\?/.test(path))
      return Promise.resolve(
        Response.json({
          profile: {
            id: 'worker-profile-1',
            taskId: 'task-1',
            revision: 1,
            modelMode: 'inherit',
            createdAt: '2026-11-19T08:00:00.000Z',
            updatedAt: '2026-11-19T08:00:00.000Z',
          },
          effective: {
            profile: {
              id: 'worker-profile-1',
              taskId: 'task-1',
              revision: 1,
              modelMode: 'inherit',
              createdAt: '2026-11-19T08:00:00.000Z',
              updatedAt: '2026-11-19T08:00:00.000Z',
            },
            source: 'global',
            modelMode: 'profile',
            modelRef: 'profile',
          },
        }),
      )
    if (/^\/v1\/channels\/[^/]+\/collaborations\?/.test(path))
      return Promise.resolve(Response.json({ relations: [] }))
    if (path === '/v1/nodes')
      return Promise.resolve(Response.json({ nodes: [] }))
    if (path.startsWith('/v1/settings/notifications?'))
      return Promise.resolve(
        Response.json({
          preferences: {
            userId: 'owner',
            utcOffsetMinutes: 480,
            revision: 1,
            updatedAt: '2026-11-19T08:00:00.000Z',
          },
        }),
      )
    if (path === '/v1/settings')
      return Promise.resolve(Response.json(settingsResponse))
    if (path.startsWith('/v1/usage?'))
      return Promise.resolve(
        Response.json({
          summary: {
            records: 1,
            completeRecords: 1,
            partialRecords: 0,
            unavailableRecords: 0,
            inputTokens: 1200,
            outputTokens: 300,
            cacheReadTokens: 200,
            durationMs: 12_000,
          },
          records: [
            {
              runId: run.id,
              taskId: channel.id,
              userId: 'owner',
              workerIconId: 'computer',
              executor: 'dsh',
              modelRef: 'deepseek-v4.1-flash',
              completeness: 'complete',
              inputTokens: 1200,
              outputTokens: 300,
              cacheReadTokens: 200,
              reportedSteps: 1,
              unreportedSteps: 0,
              durationMs: 12_000,
              observedAt: run.updatedAt,
            },
          ],
        }),
      )
    if (path === '/v1/settings/agent-models')
      return Promise.resolve(
        Response.json({
          defaultProvider: 'Magpie',
          defaultModel: 'deepseek-v4.1-flash',
          models: [
            {
              provider: 'Magpie',
              id: 'deepseek-v4.1-flash',
              name: 'deepseek-v4.1-flash',
            },
            {
              provider: 'Magpie',
              id: 'gpt-6.1-sol',
              name: 'GPT-6.1 Sol',
            },
            {
              provider: 'Other',
              id: 'other-model',
              name: 'Other model',
            },
          ],
        }),
      )
    if (path === '/v1/events' && init?.method === 'POST')
      return Promise.resolve(
        Response.json({
          event: {
            id: 'event-new',
            userId: 'owner',
            type: 'user.message',
            source: 'web',
            payload: { text: '' },
            status: 'pending',
            createdAt: '2026-11-19T09:00:00.000Z',
          },
          inserted: true,
        }),
      )
    if (path === '/v1/settings' && init?.method === 'PUT')
      return Promise.resolve().then(() => {
        const update = JSON.parse(
          typeof init.body === 'string' ? init.body : '{}',
        ) as {
          agentModelMode?: 'profile' | 'override'
          agentModelProvider?: string
          agentModelName?: string
        }
        return Response.json({
          ...settingsResponse,
          settings: {
            ...settingsResponse.settings,
            revision: 2,
            ...(update.agentModelMode
              ? { agentModelMode: update.agentModelMode }
              : {}),
            ...(update.agentModelProvider
              ? { agentModelProvider: update.agentModelProvider }
              : {}),
            ...(update.agentModelName
              ? { agentModelName: update.agentModelName }
              : {}),
          },
        })
      })
    if (
      path.includes('/read') ||
      path.includes('/retry') ||
      path.includes('/stop')
    )
      return Promise.resolve(
        Response.json(
          path.includes('/read')
            ? {
                message: {
                  ...snapshot.messages[0],
                  readAt: '2026-11-19T09:00:00.000Z',
                },
              }
            : { ok: true },
        ),
      )
    return Promise.resolve(
      Response.json({ message: `Unhandled ${path}` }, { status: 404 }),
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function installSnapshotFetch(
  nextSnapshot: Snapshot,
  custom?: (
    path: string,
    init?: RequestInit,
  ) => Response | Promise<Response> | undefined,
) {
  return installFetch((path, init) => {
    const overridden = custom?.(path, init)
    if (overridden) return overridden
    if (path.startsWith('/v1/events?'))
      return Response.json({ events: nextSnapshot.events })
    if (path.startsWith('/v1/channels?'))
      return Response.json({ channels: nextSnapshot.channels })
    if (path.startsWith('/v1/channels/') && path.includes('/timeline?')) {
      const scopedChannel = nextSnapshot.channels[0]
      if (!scopedChannel)
        return Response.json({ message: 'Channel missing' }, { status: 404 })
      return Response.json({
        channel: scopedChannel,
        events: nextSnapshot.events,
        messages: nextSnapshot.messages,
        runs: nextSnapshot.runs,
      })
    }
    if (path.startsWith('/v1/runs?'))
      return Response.json({ runs: nextSnapshot.runs })
    if (path.startsWith('/v1/outbox?'))
      return Response.json({ messages: nextSnapshot.messages })
    return undefined
  })
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('pegas-setup-complete', 'true')
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('sealed Pegas UI', () => {
  it('opens onboarding until first-run setup is completed', async () => {
    localStorage.removeItem('pegas-setup-complete')
    installFetch()
    render(<App />)
    expect(await screen.findByText('欢迎使用 Pegas')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(screen.queryByRole('dialog', { name: '全局搜索' })).toBeNull()
  })

  it('renders the white-first conversation shell and current work', async () => {
    installFetch()
    render(<App />)
    expect(await screen.findByText('你的私人智能工作伙伴')).toBeTruthy()
    expect(screen.getByText('帮我设计一个安全的自更新流程。')).toBeTruthy()
    expect(screen.getAllByText('安全自更新流程').length).toBeGreaterThan(0)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('navigates to all work and opens the running detail drawer', async () => {
    installFetch()
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    expect(screen.getByRole('heading', { name: '所有事情' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    expect(screen.getByRole('heading', { name: '安全自更新流程' })).toBeTruthy()
    expect(screen.getByText('Pegas 正在推进这件事')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByLabelText('工作详情')).toBeNull()
  })

  it('opens command search with the keyboard and selects a result', async () => {
    installFetch(path =>
      path.startsWith('/v1/channels/task-1/timeline?')
        ? Response.json({
            channel,
            events: [
              {
                ...snapshot.events[0],
                id: 'search-scoped-event',
                payload: { text: '搜索入口的 Channel 时间线' },
              },
            ],
            messages: [],
            runs: snapshot.runs,
          })
        : undefined,
    )
    render(<App />)
    await screen.findByText('你的私人智能工作伙伴')
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const dialog = screen.getByRole('dialog', { name: '全局搜索' })
    expect(within(dialog).getByPlaceholderText('搜索事情')).toBeTruthy()
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: '搜索事情' }),
      { target: { value: '不存在' } },
    )
    expect(await within(dialog).findByText('没有匹配的事情')).toBeTruthy()
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: '搜索事情' }),
      { target: { value: '安全' } },
    )
    fireEvent.click(
      await within(dialog).findByRole('button', { name: /安全自更新流程/ }),
    )
    expect(screen.getByLabelText('工作详情')).toBeTruthy()
    expect(await screen.findByText('搜索入口的 Channel 时间线')).toBeTruthy()
  })

  it('restores focus after closing global search', async () => {
    installFetch()
    render(<App />)
    const trigger = await screen.findByRole('button', { name: '全局搜索' })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: '关闭搜索' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('traps focus in global search and restores the original trigger after opening a result', async () => {
    installFetch()
    render(<App />)
    const trigger = await screen.findByRole('button', { name: '全局搜索' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '全局搜索' })
    const input = within(dialog).getByRole('textbox', { name: '搜索事情' })
    const close = within(dialog).getByRole('button', { name: '关闭搜索' })
    close.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(input)
    fireEvent.click(
      within(dialog).getByRole('button', { name: /安全自更新流程/ }),
    )
    fireEvent.click(await screen.findByRole('button', { name: '关闭详情' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('toggles light and dark from the header without opening a menu', async () => {
    installFetch()
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: '切换到深色外观' }),
    )
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('pegas-theme')).toBe('dark')
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '切换到明亮外观' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('pegas-theme')).toBe('light')
  })

  it('offers the complete appearance choices in settings', async () => {
    installFetch()
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /外观/ }))
    expect(screen.getByRole('heading', { name: '外观' })).toBeTruthy()
    expect(screen.getAllByRole('radio')).toHaveLength(4)
    fireEvent.click(screen.getByRole('radio', { name: /暖纸/ }))
    expect(document.documentElement.dataset.theme).toBe('warm')
    expect(localStorage.getItem('pegas-theme')).toBe('warm')
    expect(screen.queryByRole('button', { name: '保存更改' })).toBeNull()
  })

  it('keeps model services, classification and Pegas settings separate', async () => {
    installFetch()
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    expect(
      await screen.findByText('设置你的个人执行伙伴如何工作和与你沟通。'),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /模型服务/ }))
    expect(
      screen.getByText(
        '管理连接、凭证与模型目录；不决定哪些角色使用哪个模型。',
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /事情归类/ }))
    expect(
      screen.getByText('决定一条新消息是继续已有事情，还是开始一件新事情。'),
    ).toBeTruthy()
    expect(screen.getByDisplayValue('deepseek-v4.1-flash')).toBeTruthy()
  })

  it('loads, searches and paginates the real model catalog', async () => {
    const models = Array.from({ length: 30 }, (_, index) => ({
      id: `model-${String(index + 1).padStart(2, '0')}`,
      name: `Model ${String(index + 1).padStart(2, '0')}`,
    }))
    const fetchMock = installFetch((path, init) => {
      if (path === '/v1/settings/models/discover' && init?.method === 'POST')
        return Response.json({ models })
      if (path === '/v1/settings/models/test' && init?.method === 'POST')
        return Response.json({ ok: true, latencyMs: 42 })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /模型服务/ }))
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    expect(await screen.findByText('连接正常 · 42 ms')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '获取模型目录' }))
    expect(await screen.findByText('Model 25')).toBeTruthy()
    expect(screen.queryByText('Model 26')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getByText('Model 30')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('按名称或模型 ID 搜索'), {
      target: { value: 'Model 03' },
    })
    expect(screen.getByText('Model 03')).toBeTruthy()
    expect(screen.queryByText('Model 30')).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/settings/models/discover',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('does not probe a non-current custom provider without a model', async () => {
    const customSettings: SettingsResponse = {
      ...settingsResponse,
      capabilities: {
        ...settingsResponse.capabilities,
        providers: [
          ...settingsResponse.capabilities.providers,
          {
            id: 'custom',
            name: '自定义',
            category: 'custom',
            protocol: 'openai-chat',
            baseUrl: 'https://models.example/v1',
            defaultModel: '',
            description: '自定义服务',
            requiresApiKey: false,
            hasApiKey: false,
            available: true,
          },
        ],
      },
    }
    installFetch(path =>
      path === '/v1/settings' ? Response.json(customSettings) : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /模型服务/ }))
    fireEvent.click(screen.getByRole('button', { name: /自定义/ }))
    expect(screen.getByRole('button', { name: '测试连接' })).toHaveProperty(
      'disabled',
      true,
    )
    expect(screen.getByRole('button', { name: '获取模型目录' })).toHaveProperty(
      'disabled',
      true,
    )
    expect(screen.getByText(/请先在“事情归类”中选用并填写模型/)).toBeTruthy()
  })

  it('keeps preset provider URLs read-only and saves credential changes', async () => {
    const fetchMock = installFetch()
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /模型服务/ }))
    expect(screen.getByLabelText('服务地址').hasAttribute('readonly')).toBe(
      true,
    )
    fireEvent.change(screen.getByLabelText('API Key'), {
      target: { value: 'new-secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) =>
            path === '/v1/settings' &&
            init?.method === 'PUT' &&
            typeof init.body === 'string' &&
            init.body.includes('new-secret'),
        ),
      ).toBe(true),
    )
  })

  it('edits speech settings and runs a real rewrite test', async () => {
    const fetchMock = installFetch((path, init) => {
      if (path === '/v1/settings/rewrite/test' && init?.method === 'POST')
        return Response.json({
          original: '呃，提醒我',
          rewritten: '提醒我。',
          changed: true,
          latencyMs: 36,
        })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /语音与输入/ }))
    fireEvent.change(screen.getByLabelText('语音服务'), {
      target: { value: 'openai-compatible' },
    })
    const speechAddress = screen.getAllByLabelText('服务地址')[0]
    expect(speechAddress).toBeTruthy()
    if (!speechAddress) return
    fireEvent.change(speechAddress, {
      target: { value: 'http://127.0.0.1:18082/v1' },
    })
    fireEvent.click(screen.getByRole('button', { name: '测试改写' }))
    expect(await screen.findByText(/提醒我。 · 36 ms/)).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/settings/rewrite/test',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('discards a rewrite test result after its sample changes', async () => {
    let resolveRewrite: ((response: Response) => void) | undefined
    installFetch((path, init) => {
      if (path === '/v1/settings/rewrite/test' && init?.method === 'POST')
        return new Promise<Response>(resolve => {
          resolveRewrite = resolve
        })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /语音与输入/ }))
    fireEvent.click(screen.getByRole('button', { name: '测试改写' }))
    const sample = screen
      .getByText('测试文本')
      .closest('label')
      ?.querySelector('textarea')
    if (!sample) throw new Error('Expected rewrite sample input')
    fireEvent.change(sample, { target: { value: '新的测试文本' } })
    resolveRewrite?.(
      Response.json({
        original: '旧文本',
        rewritten: '过期结果',
        changed: true,
        latencyMs: 50,
      }),
    )
    await act(async () => Promise.resolve())
    expect(screen.queryByText(/过期结果/)).toBeNull()
    expect(screen.getByRole('button', { name: '测试改写' })).toHaveProperty(
      'disabled',
      false,
    )
  })

  it('keeps settings actions outside the scroll region and uses native styled selects', async () => {
    installFetch()
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )

    const save = await screen.findByRole('button', { name: '保存更改' })
    const footer = save.closest('footer')
    expect(footer?.classList.contains('settings-footer')).toBe(true)
    const scrollRegion = footer?.previousElementSibling
    expect(scrollRegion?.classList.contains('settings-scroll-region')).toBe(
      true,
    )
    expect(scrollRegion?.contains(footer ?? null)).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /事情归类/ }))
    const routerProvider = screen.getByLabelText('归类模型服务')
    expect(routerProvider.tagName).toBe('SELECT')
    fireEvent.click(screen.getByRole('button', { name: /语音与输入/ }))
    expect(screen.getByLabelText('语音服务').tagName).toBe('SELECT')
  })

  it('disables settings fields while a save is in flight', async () => {
    let resolveSave: ((response: Response) => void) | undefined
    installFetch((path, init) => {
      if (path === '/v1/settings' && init?.method === 'PUT')
        return new Promise<Response>(resolve => {
          resolveSave = resolve
        })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    const model = await screen.findByLabelText('模型')
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    expect(model.matches(':disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '保存中…' })).toHaveProperty(
      'disabled',
      true,
    )
    resolveSave?.(Response.json(settingsResponse))
    await screen.findByText('更改已保存')
  })

  it('keeps model-service Router shortcuts in sync with the URL', async () => {
    installFetch()
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /模型服务/ }))
    const [routerShortcut] = await screen.findAllByRole('button', {
      name: '打开设置',
    })
    if (!routerShortcut) throw new Error('Expected a Router settings shortcut')
    fireEvent.click(routerShortcut)
    expect(screen.getByRole('heading', { name: '事情归类' })).toBeTruthy()
    expect(window.location.search).toContain('section=router')
  })

  it('announces revision-conflict save responses as errors', async () => {
    installFetch((path, init) =>
      path === '/v1/settings' && init?.method === 'PUT'
        ? Response.json(
            { message: '设置已在其他设备更新，请刷新后重试' },
            { status: 409 },
          )
        : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: '保存更改' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('设置已在其他设备更新，请刷新后重试')
    expect(alert.className).toContain('is-error')
  })

  it('opens the isolated pegas runtime from Pegas settings', async () => {
    installFetch()
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: '查看运行时' }))
    expect(screen.getByRole('heading', { name: '执行环境详情' })).toBeTruthy()
    expect(screen.getAllByText('dsh')).toHaveLength(2)
    expect(screen.getByText('这件事情 · 版本 2')).toBeTruthy()
    expect(screen.queryByText('worker-profile:task-1')).toBeNull()
    expect(screen.getByText(/未返回的字段不会推断/)).toBeTruthy()
  })

  it('keeps provider identity when two providers expose the same model id', async () => {
    const fetchMock = installFetch(path => {
      if (path === '/v1/settings/agent-models')
        return Response.json({
          defaultProvider: 'Magpie',
          defaultModel: 'shared-model',
          models: [
            { provider: 'Magpie', id: 'shared-model', name: '共享模型' },
            { provider: 'Other', id: 'shared-model', name: '共享模型' },
          ],
        })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    const modelSelect = await screen.findByLabelText('模型')
    expect(
      within(modelSelect).getByRole('option', { name: '共享模型 · Magpie' }),
    ).toBeTruthy()
    expect(
      within(modelSelect).getByRole('option', { name: '共享模型 · Other' }),
    ).toBeTruthy()
    fireEvent.change(modelSelect, { target: { value: 'Other::shared-model' } })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path, init]) => {
          if (path !== '/v1/settings' || init?.method !== 'PUT') return false
          const body = JSON.parse(
            typeof init.body === 'string' ? init.body : '{}',
          ) as { agentModelProvider?: string; agentModelName?: string }
          return (
            body.agentModelProvider === 'Other' &&
            body.agentModelName === 'shared-model'
          )
        }),
      ).toBe(true),
    )
  })

  it('restores the saved provider and credential draft when settings are cancelled', async () => {
    installFetch()
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /事情归类/ }))
    fireEvent.change(screen.getByLabelText('归类模型服务'), {
      target: { value: 'anthropic' },
    })
    expect(screen.getByLabelText('归类模型服务')).toHaveProperty(
      'value',
      'anthropic',
    )
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByLabelText('归类模型服务')).toHaveProperty(
      'value',
      'magpie',
    )
    fireEvent.click(screen.getByRole('button', { name: /模型服务/ }))
    expect(screen.getByLabelText('服务地址')).toHaveProperty(
      'value',
      'https://api-magpie.example/v1',
    )
  })

  it('sends a message and preserves the live API behavior', async () => {
    const fetchMock = installFetch()
    render(<App />)
    const composer = await screen.findByLabelText('给 Pegas 发消息')
    const usageCallsBefore = fetchMock.mock.calls.filter(
      ([path]) => typeof path === 'string' && path.startsWith('/v1/usage?'),
    ).length
    fireEvent.change(composer, { target: { value: '继续执行并报告结果' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/v1/events',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([path]) => typeof path === 'string' && path.startsWith('/v1/usage?'),
        ).length,
      ).toBeGreaterThan(usageCallsBefore),
    )
  })

  it('preserves an unsent composer draft across main-page navigation', async () => {
    installFetch()
    render(<App />)
    const composer = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(composer, { target: { value: '不要丢失这段草稿' } })
    fireEvent.click(
      within(screen.getByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    fireEvent.click(
      within(screen.getByLabelText('主导航')).getByRole('button', {
        name: /^对话$/,
      }),
    )
    expect(screen.getByLabelText('给 Pegas 发消息')).toHaveProperty(
      'value',
      '不要丢失这段草稿',
    )
  })

  it('ignores an older snapshot response after a newer refresh completes', async () => {
    let resolveFirst: ((response: Response) => void) | undefined
    let eventRequests = 0
    installFetch(path => {
      if (!path.startsWith('/v1/events?')) return undefined
      eventRequests += 1
      if (eventRequests === 1)
        return new Promise<Response>(resolve => {
          resolveFirst = resolve
        })
      return Response.json({
        events: [
          {
            ...snapshot.events[0],
            id: 'event-newer',
            payload: { text: '较新的快照' },
          },
        ],
      })
    })
    render(<App />)
    const composer = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(composer, { target: { value: '触发刷新' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('较新的快照')).toBeTruthy()
    resolveFirst?.(
      Response.json({
        events: [
          {
            ...snapshot.events[0],
            id: 'event-older',
            payload: { text: '过期快照' },
          },
        ],
      }),
    )
    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(screen.queryByText('过期快照')).toBeNull()
    expect(screen.getByText('较新的快照')).toBeTruthy()
  })

  it('continues a completed task with the newest run and scopes the next message', async () => {
    const completedChannel: WorkChannel = {
      ...channel,
      status: 'completed',
      canResume: true,
      canStop: false,
      endedAt: '2026-11-19T08:10:00.000Z',
      endedKind: 'completed',
    }
    const oldRun: Run = {
      ...run,
      id: 'run-old',
      status: 'failed',
      updatedAt: '2026-11-19T08:01:00.000Z',
    }
    const latestRun: Run = {
      ...run,
      id: 'run-newest',
      status: 'completed',
      updatedAt: '2026-11-19T08:10:00.000Z',
    }
    const fetchMock = installSnapshotFetch({
      ...snapshot,
      channels: [completedChannel],
      runs: [latestRun, oldRun],
    })
    render(<App />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: /已完成 · 安全自更新流程/,
      }),
    )
    expect(screen.getByText(/Run 1 · run-newe/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续追问' }))
    expect(screen.getByText(/继续事情：/)).toBeTruthy()
    expect(new URLSearchParams(window.location.search).has('channel')).toBe(
      false,
    )

    const composer = screen.getByLabelText('给 Pegas 发消息')
    fireEvent.change(composer, { target: { value: '继续补充验收证据' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path, init]) => {
          if (path !== '/v1/events' || init?.method !== 'POST') return false
          const body = JSON.parse(
            typeof init.body === 'string' ? init.body : '{}',
          ) as { payload?: { taskId?: string } }
          return body.payload?.taskId === channel.id
        }),
      ).toBe(true),
    )
  })

  it('shows usage for the displayed run instead of summing task retries', async () => {
    const oldRun = { ...run, id: 'run-old', status: 'failed' as const }
    const latestRun = {
      ...run,
      id: 'run-latest',
      updatedAt: '2026-11-19T08:10:00.000Z',
    }
    installSnapshotFetch({ ...snapshot, runs: [oldRun, latestRun] }, path => {
      if (!path.startsWith('/v1/usage?')) return undefined
      return Response.json({
        summary: {
          records: 2,
          completeRecords: 2,
          partialRecords: 0,
          unavailableRecords: 0,
        },
        records: [
          {
            runId: oldRun.id,
            taskId: channel.id,
            userId: 'owner',
            workerIconId: 'computer',
            executor: 'dsh',
            completeness: 'complete',
            totalTokens: 900,
            reportedSteps: 1,
            unreportedSteps: 0,
            observedAt: oldRun.updatedAt,
          },
          {
            runId: latestRun.id,
            taskId: channel.id,
            userId: 'owner',
            workerIconId: 'computer',
            executor: 'dsh',
            completeness: 'complete',
            totalTokens: 50,
            reportedSteps: 1,
            unreportedSteps: 0,
            observedAt: latestRun.updatedAt,
          },
        ],
      })
    })
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: /进行中 · 安全自更新流程/ }),
    )
    const drawer = screen.getByLabelText('工作详情')
    expect(within(drawer).getByText('50')).toBeTruthy()
    expect(within(drawer).queryByText('950')).toBeNull()
  })

  it('renders the full conversation history instead of truncating older messages', async () => {
    const sourceEvent = snapshot.events[0]
    if (!sourceEvent) throw new Error('Expected a conversation fixture event')
    const events = Array.from({ length: 8 }, (_, index) => ({
      ...sourceEvent,
      id: `event-${String(index)}`,
      payload: { text: `历史消息 ${String(index + 1)}` },
      createdAt: `2026-11-19T07:0${String(index)}:00.000Z`,
    }))
    installSnapshotFetch({ ...snapshot, events })
    render(<App />)
    expect(await screen.findByText('历史消息 1')).toBeTruthy()
    expect(screen.getByText('历史消息 8')).toBeTruthy()
  })

  it('shows waiting work only in the waiting filter', async () => {
    installSnapshotFetch({
      ...snapshot,
      runs: [{ ...run, status: 'waiting' }],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    const list = screen.getByLabelText('事情列表')
    expect(within(list).getByText(channel.title)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '进行中' }))
    expect(within(list).queryByText(channel.title)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '等待中' }))
    expect(within(list).getByText(channel.title)).toBeTruthy()
  })

  it('keeps queued work visible in the active filter', async () => {
    installSnapshotFetch({
      ...snapshot,
      runs: [{ ...run, status: 'queued' }],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    const list = screen.getByLabelText('事情列表')
    expect(within(list).getByText(channel.title)).toBeTruthy()
    expect(within(list).getByText('进行中')).toBeTruthy()
  })

  it('keeps failed work visible in the active work list', async () => {
    installSnapshotFetch({
      ...snapshot,
      runs: [{ ...run, status: 'failed', lastError: '执行失败' }],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    const list = screen.getByLabelText('事情列表')
    expect(within(list).getByText(channel.title)).toBeTruthy()
    expect(within(list).getByText('失败')).toBeTruthy()
  })

  it('does not imply that work has an artifact without an artifact fact', async () => {
    installFetch()
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    const list = screen.getByLabelText('事情列表')
    expect(list.querySelector('.work-artifacts')).toBeNull()
  })

  it('classifies attention items from structured payload facts only', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox fixture message')
    installSnapshotFetch({
      ...snapshot,
      messages: [
        {
          ...sourceMessage,
          status: 'failed',
          payload: { type: 'agent.message', text: '传输失败但不是执行失败' },
        },
        {
          ...sourceMessage,
          id: 'message-2',
          payload: { type: 'run.failed', text: '执行确实失败' },
        },
      ],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    expect(screen.getByRole('button', { name: /^查看原因：/ })).toBeTruthy()
    expect(screen.queryByText('传输失败但不是执行失败')).toBeNull()
    expect(screen.queryByRole('button', { name: '稍后处理' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '失败 1' }))
    expect(screen.getByRole('button', { name: '执行确实失败' })).toBeTruthy()
  })

  it('renders attention rows as compact summaries with semantic status and quiet actions', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const longReply =
      '这是测试相关事情的入口。我目前可以处理你在这条对话里提出的测试类需求，例如：\n\n- **测试规划**：要测什么、验收条件、非目标、风险边界\n- **测试编写**：为某个 Feature 写自动化测试\n- **测试执行与门禁**：跑 `pnpm check`、`pnpm smoke`'
    installSnapshotFetch({
      ...snapshot,
      messages: [
        {
          ...sourceMessage,
          id: 'attention-long-result',
          payload: { type: 'run.completed', text: longReply },
        },
        {
          ...sourceMessage,
          id: 'attention-approval',
          payload: {
            type: 'approval.required',
            approvalId: 'approval-compact',
            summary: '发布前需要确认影响范围',
          },
        },
        {
          ...sourceMessage,
          id: 'attention-input',
          payload: {
            type: 'goal.clarification_required',
            questions: ['发布窗口是哪个时间段？'],
            text: '发布窗口是哪个时间段？',
          },
        },
        {
          ...sourceMessage,
          id: 'attention-failed',
          payload: { type: 'run.failed', error: '上游模型超时' },
        },
      ],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    const list = screen.getByLabelText('待处理列表')
    expect(within(list).getByRole('list')).toBeTruthy()
    expect(within(list).getAllByRole('listitem')).toHaveLength(4)
    const rows = within(list).getAllByRole('article')
    expect(rows).toHaveLength(4)
    expect(
      within(list).getByRole('heading', {
        level: 2,
        name: '这是测试相关事情的入口。',
      }),
    ).toBeTruthy()
    expect(within(list).queryByText(longReply)).toBeNull()
    for (const status of ['重要结果', '需要确认', '需要补充', '执行失败'])
      expect(within(list).getByText(status)).toBeTruthy()
    for (const title of [
      '发布前需要确认影响范围',
      '发布窗口是哪个时间段？',
      '上游模型超时',
    ])
      expect(
        within(list).getByRole('heading', { level: 2, name: title }),
      ).toBeTruthy()
    expect(
      within(list).getAllByRole('button', { name: /^打开事情：/ }),
    ).toHaveLength(1)
    expect(
      within(list).getByRole('button', {
        name: '查看内容：发布前需要确认影响范围',
      }),
    ).toBeTruthy()
    expect(
      within(list).getByRole('button', {
        name: '去回答：发布窗口是哪个时间段？',
      }),
    ).toBeTruthy()
    expect(
      within(list).getByRole('button', { name: '查看原因：上游模型超时' }),
    ).toBeTruthy()
    const actionNames = within(list)
      .getAllByRole('button')
      .filter(button => !button.classList.contains('attention-title'))
      .map(button => button.getAttribute('aria-label'))
    expect(new Set(actionNames).size).toBe(actionNames.length)
    expect(list.querySelector('.attention-action.is-primary')).toBeNull()
    expect(list.querySelector('.attention-title')?.textContent).toBe(
      '这是测试相关事情的入口。',
    )
  })

  it('summarizes unread attention separately from the full pending count', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    installSnapshotFetch({
      ...snapshot,
      messages: [
        {
          ...sourceMessage,
          id: 'attention-read',
          readAt: '2026-11-22T00:01:00.000Z',
          payload: { type: 'run.completed', text: '已读但尚未解决的结果' },
        },
        {
          ...sourceMessage,
          id: 'attention-unread',
          readAt: undefined,
          payload: { type: 'run.failed', error: '尚未阅读的执行失败' },
        },
      ],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    expect(screen.getByText('2 项待处理 · 1 项未读')).toBeTruthy()
    const list = screen.getByLabelText('待处理列表')
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).getByText('已读')).toBeTruthy()
    expect(within(list).getByText('未读')).toBeTruthy()
  })

  it('shows live attention filter counts and distinguishes filtered empty from true empty', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    installSnapshotFetch({
      ...snapshot,
      messages: [
        {
          ...sourceMessage,
          id: 'attention-count-result',
          payload: { type: 'run.completed', text: '验收结果已生成' },
        },
        {
          ...sourceMessage,
          id: 'attention-count-failed',
          payload: { type: 'run.failed', error: '执行失败原因' },
        },
      ],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    expect(screen.getByRole('button', { name: '全部 2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '需要确认 0' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '需要补充 0' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '失败 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重要结果 1' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '需要确认 0' }))
    expect(screen.getByText('当前筛选下没有待处理项')).toBeTruthy()
    expect(screen.queryByText('现在没有待处理项')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '全部 2' }))
    expect(
      screen.getByRole('heading', { level: 2, name: '验收结果已生成' }),
    ).toBeTruthy()
  })

  it('searches loaded attention content and source without claiming server search', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    installSnapshotFetch({
      ...snapshot,
      messages: [
        {
          ...sourceMessage,
          id: 'attention-search-result',
          payload: { type: 'run.completed', text: '候选版本已交付' },
        },
        {
          ...sourceMessage,
          id: 'attention-search-failed',
          taskId: undefined,
          payload: { type: 'run.failed', error: '上游模型超时' },
        },
      ],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    const search = screen.getByLabelText('搜索待处理内容')
    fireEvent.change(search, { target: { value: '候选版本' } })
    expect(
      screen.getByRole('heading', { level: 2, name: '候选版本已交付' }),
    ).toBeTruthy()
    expect(screen.queryByText('上游模型超时')).toBeNull()
    fireEvent.change(search, { target: { value: 'Pegas' } })
    expect(
      screen.getByRole('heading', { level: 2, name: '上游模型超时' }),
    ).toBeTruthy()
    fireEvent.change(search, { target: { value: '不存在的关键词' } })
    expect(screen.getByText('当前筛选下没有待处理项')).toBeTruthy()
    expect(screen.queryByText('现在没有待处理项')).toBeNull()
  })

  it('opens an attention row from its title while keeping the contextual action independent', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const attentionMessage = {
      ...sourceMessage,
      payload: { type: 'run.failed', error: '需要人工处理' },
    }
    installSnapshotFetch({ ...snapshot, messages: [attentionMessage] }, path =>
      path.endsWith('/read')
        ? Response.json({
            message: {
              ...attentionMessage,
              readAt: '2026-11-22T00:01:00.000Z',
            },
          })
        : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    const title = screen.getByRole('button', { name: '需要人工处理' })
    title.focus()
    fireEvent.click(title)
    expect(await screen.findByLabelText('工作详情')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }))
    await waitFor(() => expect(document.activeElement).toBe(title))
    expect(
      screen.getByRole('heading', { level: 2, name: '需要人工处理' }),
    ).toBeTruthy()
  })

  it('opens a structured Approval from the attention inbox', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const approval = approvalFixture('approval-attention')
    const approvalMessage = {
      ...sourceMessage,
      payload: { type: 'approval.required', approvalId: approval.id },
    }
    installSnapshotFetch({ ...snapshot, messages: [approvalMessage] }, path => {
      if (path.startsWith(`/v1/approvals/${approval.id}?`))
        return Response.json({ approval })
      if (path.startsWith(`/v1/actions/${approval.actionId}?`))
        return Response.json({ action: actionFixture(approval) })
      if (path.endsWith('/read'))
        return Response.json({
          message: {
            ...approvalMessage,
            readAt: '2026-11-20T00:01:00.000Z',
          },
        })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^查看内容：/ }))
    expect(await screen.findByText(approval.prompt.impact)).toBeTruthy()
    expect(screen.getByRole('button', { name: '提交决定' })).toBeTruthy()
  })

  it('keeps a saved Approval decision when the Action refresh fails', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const pending = approvalFixture('approval-refresh-failure')
    const resolved: Approval = {
      ...pending,
      status: 'approved',
      resolvedAt: '2026-11-20T00:02:00.000Z',
    }
    const approvalMessage = {
      ...sourceMessage,
      payload: { type: 'approval.required', approvalId: pending.id },
    }
    let approvalReads = 0
    let actionReads = 0
    const intervalCallbacks: (() => void)[] = []
    vi.spyOn(window, 'setInterval').mockImplementation(handler => {
      if (typeof handler === 'function')
        intervalCallbacks.push(handler as () => void)
      return intervalCallbacks.length
    })
    installSnapshotFetch(
      { ...snapshot, messages: [approvalMessage] },
      (path, init) => {
        if (path.startsWith(`/v1/approvals/${pending.id}?`)) {
          approvalReads += 1
          return Response.json({
            approval: approvalReads === 1 ? pending : resolved,
          })
        }
        if (path.startsWith(`/v1/actions/${pending.actionId}?`)) {
          actionReads += 1
          if (actionReads === 1)
            return Response.json({ action: actionFixture(pending) })
          if (actionReads === 2)
            return Response.json(
              { message: 'Action service unavailable' },
              { status: 503 },
            )
          return Response.json({
            action: { ...actionFixture(resolved), status: 'succeeded' },
          })
        }
        if (
          path === `/v1/approvals/${pending.id}/decisions` &&
          init?.method === 'POST'
        )
          return Response.json({ approval: resolved })
        if (path.endsWith('/read'))
          return Response.json({
            message: { ...approvalMessage, readAt: resolved.resolvedAt },
          })
        return undefined
      },
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^查看内容：/ }))
    fireEvent.click(await screen.findByRole('radio', { name: /^发布$/ }))
    fireEvent.click(screen.getByRole('button', { name: '提交决定' }))

    expect(
      await screen.findByText('决定已保存，Pegas 会从持久恢复点继续。'),
    ).toBeTruthy()
    expect(
      await screen.findByText(/决定已保存，但 Action 状态刷新失败/),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: '提交决定' })).toBeNull()

    await act(async () => {
      for (const callback of intervalCallbacks) callback()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(await screen.findByText('执行成功')).toBeTruthy()
    expect(screen.queryByText(/决定已保存，但 Action 状态刷新失败/)).toBeNull()
  })

  it('replaces a local choice with the decision already saved elsewhere', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const pending = approvalFixture('approval-cross-device')
    const remote: Approval = {
      ...pending,
      status: 'rejected',
      resolvedAt: '2026-11-20T00:03:00.000Z',
      decision: {
        id: 'remote-decision',
        approvalId: pending.id,
        eventId: 'remote-event',
        commandId: 'remote-command',
        userId: 'owner',
        optionId: 'reject',
        kind: 'reject',
        rationale: '另一台设备决定暂不发布',
        decidedAt: '2026-11-20T00:03:00.000Z',
        appliedAt: '2026-11-20T00:03:00.000Z',
      },
    }
    const approvalMessage = {
      ...sourceMessage,
      payload: { type: 'approval.required', approvalId: pending.id },
    }
    let approvalReads = 0
    let actionReads = 0
    installSnapshotFetch(
      { ...snapshot, messages: [approvalMessage] },
      (path, init) => {
        if (path.startsWith(`/v1/approvals/${pending.id}?`)) {
          approvalReads += 1
          return Response.json({
            approval: approvalReads === 1 ? pending : remote,
          })
        }
        if (path.startsWith(`/v1/actions/${pending.actionId}?`)) {
          actionReads += 1
          return Response.json({
            action:
              actionReads === 1
                ? actionFixture(pending)
                : { ...actionFixture(remote), status: 'rejected' },
          })
        }
        if (
          path === `/v1/approvals/${pending.id}/decisions` &&
          init?.method === 'POST'
        )
          return Response.json(
            { message: 'Approval has already been decided' },
            { status: 409 },
          )
        if (path.endsWith('/read'))
          return Response.json({
            message: { ...approvalMessage, readAt: remote.resolvedAt },
          })
        return undefined
      },
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^查看内容：/ }))
    fireEvent.click(await screen.findByRole('radio', { name: /^发布$/ }))
    fireEvent.change(screen.getByPlaceholderText('告诉 Pegas 需要注意什么'), {
      target: { value: '本机尝试发布' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提交决定' }))

    await waitFor(() =>
      expect(
        screen.getByRole<HTMLInputElement>('radio', { name: /暂不发布/ })
          .checked,
      ).toBe(true),
    )
    expect(
      screen.getByPlaceholderText<HTMLTextAreaElement>(
        '告诉 Pegas 需要注意什么',
      ).value,
    ).toBe('另一台设备决定暂不发布')
    expect(screen.getByText('已拒绝执行此动作。')).toBeTruthy()
    expect(screen.queryByText(/提交决定失败/)).toBeNull()
  })

  it('refreshes an open Approval when another device resolves it', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const pending = approvalFixture('approval-open-poll')
    const remote: Approval = {
      ...pending,
      status: 'approved',
      resolvedAt: '2026-11-20T00:04:00.000Z',
      decision: {
        id: 'polled-decision',
        approvalId: pending.id,
        eventId: 'polled-event',
        commandId: 'polled-command',
        userId: 'owner',
        optionId: 'approve',
        kind: 'approve',
        decidedAt: '2026-11-20T00:04:00.000Z',
        appliedAt: '2026-11-20T00:04:00.000Z',
      },
    }
    const approvalMessage = {
      ...sourceMessage,
      payload: { type: 'approval.required', approvalId: pending.id },
    }
    let approvalReads = 0
    let actionReads = 0
    const intervalCallbacks: (() => void)[] = []
    vi.spyOn(window, 'setInterval').mockImplementation(handler => {
      if (typeof handler === 'function')
        intervalCallbacks.push(handler as () => void)
      return intervalCallbacks.length
    })
    installSnapshotFetch({ ...snapshot, messages: [approvalMessage] }, path => {
      if (path.startsWith(`/v1/approvals/${pending.id}?`)) {
        approvalReads += 1
        return Response.json({
          approval: approvalReads === 1 ? pending : remote,
        })
      }
      if (path.startsWith(`/v1/actions/${pending.actionId}?`)) {
        actionReads += 1
        return Response.json({
          action:
            actionReads === 1
              ? actionFixture(pending)
              : { ...actionFixture(remote), status: 'succeeded' },
        })
      }
      if (path.endsWith('/read'))
        return Response.json({
          message: { ...approvalMessage, readAt: remote.resolvedAt },
        })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^查看内容：/ }))
    expect(await screen.findByRole('button', { name: '提交决定' })).toBeTruthy()

    await act(async () => {
      for (const callback of intervalCallbacks) callback()
      await Promise.resolve()
    })

    expect(
      await screen.findByText('决定已保存，Pegas 会从持久恢复点继续。'),
    ).toBeTruthy()
    expect(screen.getByText('执行成功')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '提交决定' })).toBeNull()
  })

  it('does not let a slower pending poll overwrite a resolved Approval', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const pending = approvalFixture('approval-poll-race')
    const remote: Approval = {
      ...pending,
      status: 'approved',
      resolvedAt: '2026-11-20T00:05:00.000Z',
      decision: {
        id: 'race-decision',
        approvalId: pending.id,
        eventId: 'race-event',
        commandId: 'race-command',
        userId: 'owner',
        optionId: 'approve',
        kind: 'approve',
        decidedAt: '2026-11-20T00:05:00.000Z',
        appliedAt: '2026-11-20T00:05:00.000Z',
      },
    }
    const approvalMessage = {
      ...sourceMessage,
      payload: { type: 'approval.required', approvalId: pending.id },
    }
    let resolveStale: ((response: Response) => void) | undefined
    const staleResponse = new Promise<Response>(resolve => {
      resolveStale = resolve
    })
    let approvalReads = 0
    let actionReads = 0
    const intervalCallbacks: (() => void)[] = []
    vi.spyOn(window, 'setInterval').mockImplementation(handler => {
      if (typeof handler === 'function')
        intervalCallbacks.push(handler as () => void)
      return intervalCallbacks.length
    })
    installSnapshotFetch({ ...snapshot, messages: [approvalMessage] }, path => {
      if (path.startsWith(`/v1/approvals/${pending.id}?`)) {
        approvalReads += 1
        if (approvalReads === 1) return Response.json({ approval: pending })
        if (approvalReads === 2) return staleResponse
        return Response.json({ approval: remote })
      }
      if (path.startsWith(`/v1/actions/${pending.actionId}?`)) {
        actionReads += 1
        return Response.json({
          action:
            actionReads === 1
              ? actionFixture(pending)
              : { ...actionFixture(remote), status: 'succeeded' },
        })
      }
      if (path.endsWith('/read'))
        return Response.json({
          message: { ...approvalMessage, readAt: remote.resolvedAt },
        })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^查看内容：/ }))
    expect(await screen.findByRole('button', { name: '提交决定' })).toBeTruthy()
    const refreshApproval = intervalCallbacks.at(-1)
    if (!refreshApproval) throw new Error('Expected Approval poll interval')

    act(() => refreshApproval())
    act(() => refreshApproval())

    expect(
      await screen.findByText('决定已保存，Pegas 会从持久恢复点继续。'),
    ).toBeTruthy()
    expect(screen.getByText('执行成功')).toBeTruthy()
    resolveStale?.(Response.json({ approval: pending }))
    await act(async () => Promise.resolve())
    expect(screen.getByText('执行成功')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '提交决定' })).toBeNull()
  })

  it('does not let a stale post-decision Action refresh overwrite a poll', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const pending = approvalFixture('approval-decision-action-race')
    const approved: Approval = {
      ...pending,
      status: 'approved',
      resolvedAt: '2026-11-20T00:06:00.000Z',
      decision: {
        id: 'decision-action-race',
        approvalId: pending.id,
        eventId: 'decision-action-race-event',
        commandId: 'decision-action-race-command',
        userId: 'owner',
        optionId: 'approve',
        kind: 'approve',
        decidedAt: '2026-11-20T00:06:00.000Z',
        appliedAt: '2026-11-20T00:06:00.000Z',
      },
    }
    const approvalMessage = {
      ...sourceMessage,
      payload: { type: 'approval.required', approvalId: pending.id },
    }
    let resolveStaleAction: ((response: Response) => void) | undefined
    const staleActionResponse = new Promise<Response>(resolve => {
      resolveStaleAction = resolve
    })
    let approvalReads = 0
    let actionReads = 0
    const intervalCallbacks: (() => void)[] = []
    vi.spyOn(window, 'setInterval').mockImplementation(handler => {
      if (typeof handler === 'function')
        intervalCallbacks.push(handler as () => void)
      return intervalCallbacks.length
    })
    installSnapshotFetch(
      { ...snapshot, messages: [approvalMessage] },
      (path, init) => {
        if (path.startsWith(`/v1/approvals/${pending.id}?`)) {
          approvalReads += 1
          return Response.json({
            approval: approvalReads === 1 ? pending : approved,
          })
        }
        if (
          path === `/v1/approvals/${pending.id}/decisions` &&
          init?.method === 'POST'
        )
          return Response.json({ approval: approved })
        if (path.startsWith(`/v1/actions/${pending.actionId}?`)) {
          actionReads += 1
          if (actionReads === 1)
            return Response.json({ action: actionFixture(pending) })
          if (actionReads === 2) return staleActionResponse
          return Response.json({
            action: { ...actionFixture(approved), status: 'succeeded' },
          })
        }
        if (path.endsWith('/read'))
          return Response.json({
            message: { ...approvalMessage, readAt: approved.resolvedAt },
          })
        return undefined
      },
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^查看内容：/ }))
    fireEvent.click(await screen.findByRole('radio', { name: /^发布$/ }))
    fireEvent.click(screen.getByRole('button', { name: '提交决定' }))
    expect(
      await screen.findByText('决定已保存，Pegas 会从持久恢复点继续。'),
    ).toBeTruthy()
    await waitFor(() => expect(actionReads).toBe(2))
    await act(async () => {
      for (const callback of intervalCallbacks) callback()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(approvalReads).toBe(2))
    await waitFor(() => expect(actionReads).toBe(3))
    expect(await screen.findByText('执行成功')).toBeTruthy()
    resolveStaleAction?.(
      Response.json({
        action: { ...actionFixture(approved), status: 'authorized' },
      }),
    )
    await act(async () => Promise.resolve())
    expect(screen.getByText('执行成功')).toBeTruthy()
  })

  it('ignores a stale Approval response after another item opens', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const first = approvalFixture('approval-slow')
    const second: Approval = {
      ...approvalFixture('approval-fast'),
      prompt: {
        ...approvalFixture('approval-fast').prompt,
        summary: '快速审批',
      },
    }
    let resolveFirst: ((response: Response) => void) | undefined
    const firstResponse = new Promise<Response>(resolve => {
      resolveFirst = resolve
    })
    const firstMessage = {
      ...sourceMessage,
      id: 'message-slow',
      payload: {
        type: 'approval.required',
        approvalId: first.id,
        summary: '慢速审批',
      },
    }
    const secondMessage = {
      ...sourceMessage,
      id: 'message-fast',
      payload: {
        type: 'approval.required',
        approvalId: second.id,
        summary: '快速审批',
      },
    }
    installSnapshotFetch(
      { ...snapshot, messages: [firstMessage, secondMessage] },
      path => {
        if (path.startsWith(`/v1/approvals/${first.id}?`)) return firstResponse
        if (path.startsWith(`/v1/approvals/${second.id}?`))
          return Response.json({ approval: second })
        if (path.startsWith(`/v1/actions/${second.actionId}?`))
          return Response.json({ action: actionFixture(second) })
        if (path.endsWith('/read'))
          return Response.json({
            message: { ...secondMessage, readAt: run.updatedAt },
          })
        return undefined
      },
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    const slowArticle = screen.getByText('慢速审批').closest('article')
    const fastArticle = screen.getByText('快速审批').closest('article')
    if (!slowArticle || !fastArticle) throw new Error('Expected attention rows')
    fireEvent.click(
      within(slowArticle).getByRole('button', { name: /^查看内容：/ }),
    )
    fireEvent.click(
      within(fastArticle).getByRole('button', { name: /^查看内容：/ }),
    )
    const drawer = await screen.findByRole('dialog')
    expect(
      within(drawer).getByRole('heading', { name: '快速审批' }),
    ).toBeTruthy()
    resolveFirst?.(Response.json({ approval: first }))
    await act(async () => Promise.resolve())
    expect(
      within(drawer).getByRole('heading', { name: '快速审批' }),
    ).toBeTruthy()
    expect(
      within(drawer).queryByRole('heading', { name: first.prompt.summary }),
    ).toBeNull()
  })

  it.each([
    [401, 'Unauthorized', '连接到 Pegas'],
    [503, '审批服务暂时不可用', '审批服务暂时不可用'],
  ] as const)(
    'surfaces Approval detail HTTP %s failures',
    async (status, message, expected) => {
      const sourceMessage = snapshot.messages[0]
      if (!sourceMessage) throw new Error('Expected an outbox message fixture')
      const approvalMessage = {
        ...sourceMessage,
        payload: {
          type: 'approval.required',
          approvalId: `approval-error-${String(status)}`,
        },
      }
      const fetchMock = installSnapshotFetch(
        { ...snapshot, messages: [approvalMessage] },
        path => {
          if (path.startsWith('/v1/approvals/'))
            return Response.json({ message }, { status })
          if (path.endsWith('/read'))
            return Response.json({
              message: {
                ...approvalMessage,
                readAt: '2026-11-20T00:01:00.000Z',
              },
            })
          return undefined
        },
      )
      render(<App />)
      fireEvent.click(
        within(await screen.findByLabelText('主导航')).getByRole('button', {
          name: /待你处理/,
        }),
      )
      fireEvent.click(screen.getByRole('button', { name: /^查看内容：/ }))
      expect(await screen.findByText(expected)).toBeTruthy()
      expect(
        fetchMock.mock.calls.some(
          ([path]) => typeof path === 'string' && path.endsWith('/read'),
        ),
      ).toBe(false)
    },
  )

  it('restores a URL-backed attention detail and preserves its address', async () => {
    window.history.replaceState({}, '', '/?view=outbox&outbox=message-1')
    installFetch()
    render(<App />)
    expect(
      await screen.findByRole('heading', { name: '待你处理' }),
    ).toBeTruthy()
    expect(await screen.findByLabelText('工作详情')).toBeTruthy()
    expect(window.location.search).toContain('outbox=message-1')
  })

  it('restores taskless Outbox messages from their direct URL', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox fixture message')
    window.history.replaceState({}, '', '/?view=outbox&outbox=message-1')
    const tasklessMessage = {
      ...sourceMessage,
      taskId: undefined,
      payload: { type: 'run.failed', error: '后台检查需要你的处理' },
    }
    installSnapshotFetch(
      {
        ...snapshot,
        messages: [tasklessMessage],
      },
      path =>
        path.endsWith('/read')
          ? Response.json({
              message: {
                ...tasklessMessage,
                readAt: '2026-11-19T09:00:00.000Z',
              },
            })
          : undefined,
    )
    render(<App />)
    expect(await screen.findByLabelText('消息详情')).toBeTruthy()
    expect(screen.getAllByText('后台检查需要你的处理').length).toBeGreaterThan(
      0,
    )
  })

  it('keeps legacy task-list URLs mapped to all work', async () => {
    window.history.replaceState({}, '', '/?view=tasks')
    installFetch()
    render(<App />)
    expect(
      await screen.findByRole('heading', { name: '所有事情' }),
    ).toBeTruthy()
  })

  it('restores the voice settings section from its direct URL', async () => {
    window.history.replaceState({}, '', '/?view=settings&section=voice')
    installFetch()
    render(<App />)
    expect(
      await screen.findByRole('heading', { name: '语音与输入' }),
    ).toBeTruthy()
    expect(window.location.search).toContain('section=voice')
  })

  it('restores a URL-backed Channel drawer and preserves its scoped timeline', async () => {
    window.history.replaceState({}, '', '/?channel=task-1')
    installFetch(path =>
      path.startsWith('/v1/channels/task-1/timeline?')
        ? Response.json({
            channel,
            events: [
              {
                ...snapshot.events[0],
                id: 'deep-linked-event',
                payload: { text: '深链接 Channel 时间线' },
              },
            ],
            messages: [],
            runs: snapshot.runs,
          })
        : undefined,
    )
    render(<App />)
    expect(await screen.findByLabelText('工作详情')).toBeTruthy()
    expect(await screen.findByText('深链接 Channel 时间线')).toBeTruthy()
    expect(window.location.search).toContain('channel=task-1')
  })

  it('restores a URL-backed detail after the initial snapshot load fails', async () => {
    window.history.replaceState({}, '', '/?view=outbox&outbox=message-1')
    let eventRequests = 0
    installFetch(path => {
      if (!path.startsWith('/v1/events?')) return undefined
      eventRequests += 1
      return eventRequests === 1
        ? Response.json({ message: 'offline' }, { status: 503 })
        : Response.json({ events: snapshot.events })
    })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '重新连接' }))
    expect(await screen.findByLabelText('工作详情')).toBeTruthy()
  })

  it('uses a semantic composer and does not submit during IME composition', async () => {
    const fetchMock = installFetch()
    render(<App />)
    const composer = await screen.findByLabelText('给 Pegas 发消息')
    const form = composer.closest('form')
    expect(form?.getAttribute('aria-label')).toBe('发送消息')
    fireEvent.change(composer, { target: { value: '先填草稿再看发送按钮' } })
    expect(
      screen.getByRole('button', { name: '发送' }).getAttribute('type'),
    ).toBe('submit')
    fireEvent.change(composer, { target: { value: '' } })
    const modelButton = await screen.findByRole('button', {
      name: /选择执行模型/,
    })
    await waitFor(() =>
      expect(modelButton.textContent).toContain('deepseek-v4.1-flash'),
    )
    fireEvent.click(modelButton)
    expect(await screen.findByRole('dialog', { name: '选择模型' })).toBeTruthy()
    expect(screen.getByRole('option', { name: /GPT-6.1 Sol/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Other model/ })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: /GPT-6.1 Sol/ }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path, init]) => {
          if (path !== '/v1/settings' || init?.method !== 'PUT') return false
          const body = JSON.parse(
            typeof init.body === 'string' ? init.body : '{}',
          ) as {
            agentModelProvider?: string
            agentModelName?: string
          }
          return (
            body.agentModelProvider === 'Magpie' &&
            body.agentModelName === 'gpt-6.1-sol'
          )
        }),
      ).toBe(true),
    )
    expect(screen.queryByRole('dialog', { name: '选择模型' })).toBeNull()
    await waitFor(() =>
      expect(modelButton.textContent).toContain('GPT-6.1 Sol'),
    )
    fireEvent.change(composer, { target: { value: '中文输入尚未完成' } })
    fireEvent.keyDown(composer, {
      isComposing: true,
      key: 'Enter',
    })
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) => path === '/v1/events' && init?.method === 'POST',
      ),
    ).toBe(false)
    fireEvent.keyDown(composer, { key: 'Enter', keyCode: 229 })
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) => path === '/v1/events' && init?.method === 'POST',
      ),
    ).toBe(false)
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) => path === '/v1/events' && init?.method === 'POST',
        ),
      ).toBe(true),
    )
  })

  it('opens voice settings without requesting microphone access when speech is disabled', async () => {
    const getUserMedia = vi.fn()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })
    installFetch(path =>
      path === '/v1/settings'
        ? Response.json({
            ...settingsResponse,
            speech: {
              provider: 'disabled',
              baseUrl: '',
              model: '',
              hasApiKey: false,
            },
          })
        : undefined,
    )
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '语音输入' }))
    expect(
      await screen.findByRole('heading', { name: '语音与输入' }),
    ).toBeTruthy()
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('blocks message submission while dictation is recording', async () => {
    class FakeMediaRecorder {
      static isTypeSupported() {
        return false
      }
      state: RecordingState = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((event: BlobEvent) => void) | null = null
      onerror: (() => void) | null = null
      onstop: (() => void) | null = null
      start() {
        this.state = 'recording'
      }
      stop() {
        this.state = 'inactive'
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }),
      },
    })
    const fetchMock = installFetch()
    render(<App />)
    const composer = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(composer, { target: { value: '先不要发送' } })
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '停止录音' })).toBeTruthy(),
    )
    expect(screen.getByRole('button', { name: '发送' })).toHaveProperty(
      'disabled',
      true,
    )
    const recordingForm = composer.closest('form')
    if (!recordingForm) throw new Error('Expected the composer form')
    fireEvent.submit(recordingForm)
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) => path === '/v1/events' && init?.method === 'POST',
      ),
    ).toBe(false)
  })

  it('pushes page history and restores the prior page on browser back', async () => {
    installFetch()
    render(<App />)
    await screen.findByText('你的私人智能工作伙伴')
    fireEvent.click(
      within(screen.getByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    expect(screen.getByRole('heading', { name: '所有事情' })).toBeTruthy()
    window.history.back()
    await waitFor(() =>
      expect(screen.getByText('你的私人智能工作伙伴')).toBeTruthy(),
    )
  })

  it('shows the access-token recovery screen on unauthorized responses', async () => {
    installFetch(path =>
      path.startsWith('/v1/events?')
        ? Response.json({ message: 'Unauthorized' }, { status: 401 })
        : undefined,
    )
    render(<App />)
    expect(
      await screen.findByRole('heading', { name: '连接到 Pegas' }),
    ).toBeTruthy()
    fireEvent.change(screen.getByLabelText('访问令牌'), {
      target: { value: 'local-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: /继续/ }))
    expect(sessionStorage.getItem('pegas-token')).toBe('local-token')
  })

  it('walks through all four first-run setup steps', () => {
    const onComplete = vi.fn()
    render(
      <Onboarding
        onComplete={onComplete}
        onContinueSettings={vi.fn()}
        response={settingsResponse}
      />,
    )
    expect(screen.getByText('欢迎使用 Pegas')).toBeTruthy()
    expect(screen.getByText(/高风险 Action 会持久等待/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /继续/ }))
    expect(screen.getByText('连接模型服务')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /继续/ }))
    expect(screen.getByText('准备执行环境')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /继续/ }))
    expect(screen.getByText('语音与完成确认')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /进入 Pegas/ }))
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('presents onboarding as a modal and traps focus inside it', () => {
    render(
      <Onboarding
        onComplete={vi.fn()}
        onContinueSettings={vi.fn()}
        response={settingsResponse}
      />,
    )
    const dialog = screen.getByRole('dialog', { name: '欢迎使用 Pegas' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const later = screen.getByRole('button', { name: '稍后设置' })
    const next = screen.getByRole('button', { name: /^继续/ })
    expect(document.activeElement).toBe(next)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(later)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(next)
  })

  it('marks onboarding complete when continuing into settings', async () => {
    localStorage.removeItem('pegas-setup-complete')
    installFetch()
    render(<App />)
    await screen.findByText('欢迎使用 Pegas')
    for (let index = 0; index < 3; index += 1)
      fireEvent.click(screen.getByRole('button', { name: /^继续$/ }))
    fireEvent.click(screen.getByRole('button', { name: '继续设置' }))
    expect(await screen.findByRole('heading', { name: /^Pegas$/ })).toBeTruthy()
    expect(localStorage.getItem('pegas-setup-complete')).toBe('true')
  })

  it.each([
    ['completed', '工作已完成', 'is-done'],
    ['waiting', '等待下一步条件', 'is-waiting'],
    ['failed', '执行失败，记录已保留', 'is-failed'],
  ] as const)(
    'renders the %s execution state',
    (status, headline, progressClass) => {
      const stateRun: Run = {
        ...run,
        status,
        ...(status === 'failed' ? { lastError: '健康检查失败' } : {}),
      }
      const stateChannel: WorkChannel = {
        ...channel,
        status: status === 'completed' ? 'completed' : channel.status,
      }
      render(
        <DetailDrawer
          onChange={vi.fn()}
          onClose={vi.fn()}
          onRetry={vi.fn()}
          view={{ kind: 'task', channel: stateChannel, run: stateRun }}
        />,
      )
      expect(screen.getByText(headline)).toBeTruthy()
      expect(screen.getByText(/Run · run-1/).closest('li')?.className).toBe(
        progressClass,
      )
    },
  )

  it('labels the server-authoritative execution snapshot in user language', () => {
    render(
      <DetailDrawer
        onChange={vi.fn()}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        view={{ kind: 'runtime', run }}
      />,
    )
    expect(screen.getByText('事情级执行设置')).toBeTruthy()
    expect(screen.getByText('这件事情 · 版本 2')).toBeTruthy()
    expect(screen.queryByText('worker-profile:task-1')).toBeNull()
    expect(screen.queryByText('Worker Profile')).toBeNull()
  })

  it('requires explicit confirmation before permanently stopping work', async () => {
    const onStop = vi.fn(() => Promise.resolve())
    render(
      <DetailDrawer
        onChange={vi.fn()}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onStop={onStop}
        view={{ kind: 'task', channel, run }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '停止事情' }))
    expect(screen.getByText('确定停止这件事？')).toBeTruthy()
    expect(screen.getByText(/停止后无法继续当前运行/)).toBeTruthy()
    expect(onStop).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认停止' }))
    await waitFor(() => expect(onStop).toHaveBeenCalledWith(channel))
  })

  it('keeps a failed run visible and reports retry errors inline', async () => {
    render(
      <DetailDrawer
        onChange={vi.fn()}
        onClose={vi.fn()}
        onRetry={() => Promise.reject(new Error('暂时无法创建重试'))}
        view={{
          kind: 'task',
          channel,
          run: { ...run, status: 'failed', lastError: '原始失败' },
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      '暂时无法创建重试',
    )
    expect(screen.getByText('原始失败')).toBeTruthy()
  })

  it('honors an archived Channel over a previously failed Run', () => {
    render(
      <DetailDrawer
        onChange={vi.fn()}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        view={{
          kind: 'task',
          channel: { ...channel, status: 'cancelled', canStop: false },
          run: { ...run, status: 'failed', lastError: '旧失败' },
        }}
      />,
    )
    expect(screen.getByText('这件事已归档')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('preserves a selected failed Run diagnostic after its Channel completes', () => {
    render(
      <DetailDrawer
        onChange={vi.fn()}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        view={{
          kind: 'task',
          channel: { ...channel, status: 'completed', canStop: false },
          run: { ...run, status: 'failed', lastError: '旧 Run 仍需诊断' },
        }}
      />,
    )
    expect(screen.getByText('执行已停止')).toBeTruthy()
    expect(screen.getByText('旧 Run 仍需诊断')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('presents the detail drawer as a modal and traps keyboard focus', () => {
    render(
      <DetailDrawer
        onChange={vi.fn()}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onStop={() => Promise.resolve()}
        view={{ kind: 'task', channel, run }}
      />,
    )
    const dialog = screen.getByRole('dialog', { name: '工作详情' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const close = screen.getByRole('button', { name: '关闭详情' })
    const stop = screen.getByRole('button', { name: '停止事情' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(stop)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
  })

  it('does not steal drawer focus when polling refreshes its props', () => {
    const firstClose = vi.fn()
    const { rerender } = render(
      <DetailDrawer
        onChange={vi.fn()}
        onClose={firstClose}
        onContinue={vi.fn()}
        onRetry={vi.fn()}
        view={{ kind: 'task', channel, run }}
      />,
    )
    const continueButton = screen.getByRole('button', { name: '继续追问' })
    continueButton.focus()
    rerender(
      <DetailDrawer
        onChange={vi.fn()}
        onClose={vi.fn()}
        onContinue={vi.fn()}
        onRetry={vi.fn()}
        view={{ kind: 'task', channel, run: { ...run, attempts: 2 } }}
      />,
    )
    expect(document.activeElement).toBe(continueButton)
  })

  it('does not infer collaboration facts from free-form status text', () => {
    render(
      <DetailDrawer
        onChange={vi.fn()}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        view={{
          kind: 'task',
          channel: { ...channel, statusReason: '创建 subagent 并行执行' },
          run,
        }}
      />,
    )
    expect(screen.queryByText('正在并行处理')).toBeNull()
    expect(screen.queryByText('已转交给 Pegas')).toBeNull()
  })

  it('renders a structured Approval and submits one explicit decision', async () => {
    const approval = approvalFixture('approval-1')
    const onDecide = vi.fn(() => Promise.resolve())
    render(
      <DetailDrawer
        onChange={vi.fn()}
        onClose={vi.fn()}
        onDecideApproval={onDecide}
        onRetry={vi.fn()}
        view={{
          kind: 'approval',
          approval,
          action: actionFixture(approval),
          message: {
            id: 'approval-message',
            userId: 'owner',
            taskId: channel.id,
            status: 'sent',
            payload: { type: 'approval.required', approvalId: approval.id },
            createdAt: approval.createdAt,
          },
        }}
      />,
    )

    expect(screen.getByText(approval.prompt.impact)).toBeTruthy()
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: /暂不发布/ }).checked,
    ).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /^发布$/ }))
    fireEvent.change(screen.getByPlaceholderText('告诉 Pegas 需要注意什么'), {
      target: { value: '先确认回滚开关' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提交决定' }))
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith(
        approval.id,
        'approve',
        '先确认回滚开关',
      ),
    )
  })

  it('resets Approval form state when a different Approval opens', () => {
    const first = approvalFixture('approval-first')
    const second: Approval = {
      ...approvalFixture('approval-second'),
      prompt: {
        ...approvalFixture('approval-second').prompt,
        summary: '删除旧备份',
        recommendedOptionId: 'approve',
      },
    }
    const message = {
      id: 'approval-message',
      userId: 'owner',
      taskId: channel.id,
      status: 'sent' as const,
      payload: { type: 'approval.required', approvalId: first.id },
      createdAt: first.createdAt,
    }
    const { rerender } = render(
      <DetailDrawer
        onChange={vi.fn()}
        onClose={vi.fn()}
        onDecideApproval={vi.fn(() => Promise.resolve())}
        onRetry={vi.fn()}
        view={{
          kind: 'approval',
          approval: first,
          action: actionFixture(first),
          message,
        }}
      />,
    )
    fireEvent.click(screen.getByRole('radio', { name: /^发布$/ }))
    fireEvent.change(screen.getByPlaceholderText('告诉 Pegas 需要注意什么'), {
      target: { value: '不要带到下一条审批' },
    })

    rerender(
      <DetailDrawer
        onChange={vi.fn()}
        onClose={vi.fn()}
        onDecideApproval={vi.fn(() => Promise.resolve())}
        onRetry={vi.fn()}
        view={{
          kind: 'approval',
          approval: second,
          action: actionFixture(second),
          message: {
            ...message,
            id: 'approval-message-second',
            payload: { type: 'approval.required', approvalId: second.id },
          },
        }}
      />,
    )

    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: /^发布/ }).checked,
    ).toBe(true)
    expect(
      screen.getByPlaceholderText<HTMLTextAreaElement>(
        '告诉 Pegas 需要注意什么',
      ).value,
    ).toBe('')
  })

  it('reopens a resolved Approval with the saved decision and Action outcome', () => {
    const pending = approvalFixture('approval-resolved')
    const approval: Approval = {
      ...pending,
      status: 'approved',
      resolvedAt: '2026-11-20T00:05:00.000Z',
      decision: {
        id: 'decision-resolved',
        approvalId: pending.id,
        eventId: 'event-resolved',
        commandId: 'command-resolved',
        userId: 'owner',
        optionId: 'approve',
        kind: 'approve',
        rationale: '先保留旧版本',
        decidedAt: '2026-11-20T00:04:00.000Z',
        appliedAt: '2026-11-20T00:05:00.000Z',
      },
    }
    const action: DurableAction = {
      ...actionFixture(approval),
      status: 'succeeded',
      result: { release: 'published' },
    }
    render(
      <DetailDrawer
        onChange={vi.fn()}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        view={{
          kind: 'approval',
          approval,
          action,
          message: {
            id: 'approval-message-resolved',
            userId: 'owner',
            taskId: channel.id,
            status: 'sent',
            payload: { type: 'approval.required', approvalId: approval.id },
            createdAt: approval.createdAt,
          },
        }}
      />,
    )

    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: /^发布/ }).checked,
    ).toBe(true)
    expect(
      screen.getByPlaceholderText<HTMLTextAreaElement>(
        '告诉 Pegas 需要注意什么',
      ).value,
    ).toBe('先保留旧版本')
    expect(screen.getByText('执行成功')).toBeTruthy()
    expect(screen.getByText(/published/)).toBeTruthy()
  })

  it('removes resolved Approval notifications from unresolved attention', () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const required = {
      ...sourceMessage,
      id: 'approval-required',
      payload: { type: 'approval.required', approvalId: 'approval-resolved' },
    }
    const resolved = {
      ...sourceMessage,
      id: 'approval-resolved-message',
      payload: { type: 'approval.resolved', approvalId: 'approval-resolved' },
    }
    expect(unresolvedAttentionMessages([required, resolved])).toEqual([])
  })

  it.each(['file', 'image', 'video', 'web'] as const)(
    'renders a truthful %s preview shell',
    preview => {
      render(
        <DetailDrawer
          onChange={vi.fn()}
          onClose={vi.fn()}
          onRetry={vi.fn()}
          view={{
            kind: 'preview',
            preview,
            title: '服务端产物',
            mimeType: 'application/octet-stream',
          }}
        />,
      )
      expect(
        screen.getByRole('heading', { level: 2, name: '服务端产物' }),
      ).toBeTruthy()
      expect(screen.getByText('服务端没有提供可渲染的预览内容。')).toBeTruthy()
    },
  )

  it('formats relative and invalid timestamps safely', () => {
    expect(formatRelativeTime('invalid')).toBe('刚刚')
    expect(typeof formatRelativeTime('2026-11-19T08:00:00.000Z')).toBe('string')
  })

  it('keeps inbox delivery state as metadata on user messages', async () => {
    const sourceEvent = snapshot.events[0]
    if (!sourceEvent) throw new Error('Expected an inbox event fixture')
    installSnapshotFetch({
      ...snapshot,
      events: [{ ...sourceEvent, status: 'processing' }],
    })
    render(<App />)
    expect(await screen.findByText('正在分配')).toBeTruthy()
    expect(screen.getByText('帮我设计一个安全的自更新流程。')).toBeTruthy()
  })

  it('shows the server failure reason and keeps archived work out of waiting', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    installSnapshotFetch({
      ...snapshot,
      channels: [{ ...channel, status: 'cancelled', canStop: false }],
      runs: [],
      messages: [
        {
          ...sourceMessage,
          payload: { type: 'run.failed', error: '上游模型超时' },
        },
      ],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    expect(screen.getByText('上游模型超时')).toBeTruthy()
    fireEvent.click(
      within(screen.getByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '等待中' }))
    expect(screen.queryByText(channel.title)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '已归档' }))
    expect(screen.getByText(channel.title)).toBeTruthy()
  })

  it('retries a failed settings load from the reconnect action', async () => {
    let settingsRequests = 0
    installFetch(path => {
      if (path !== '/v1/settings') return undefined
      settingsRequests += 1
      return settingsRequests === 1
        ? Response.json({ message: 'settings offline' }, { status: 503 })
        : Response.json(settingsResponse)
    })
    render(<App />)
    expect(await screen.findByText(/settings offline/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
    await waitFor(() => expect(settingsRequests).toBeGreaterThan(1))
    fireEvent.click(
      within(screen.getByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    expect(
      await screen.findByText('设置你的个人执行伙伴如何工作和与你沟通。'),
    ).toBeTruthy()
  })

  it('preserves unsaved settings while reconnecting a failed model catalog', async () => {
    let catalogRequests = 0
    installFetch(path => {
      if (path !== '/v1/settings/agent-models') return undefined
      catalogRequests += 1
      return catalogRequests === 1
        ? Response.json({ message: 'catalog offline' }, { status: 503 })
        : Response.json({
            defaultProvider: 'Magpie',
            defaultModel: 'deepseek-v4.1-flash',
            models: [],
          })
    })
    render(<App />)
    expect(await screen.findByText(/catalog offline/)).toBeTruthy()
    fireEvent.click(
      within(screen.getByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /语音与输入/ }))
    const serviceUrl = await screen.findByLabelText('服务地址')
    fireEvent.change(serviceUrl, {
      target: { value: 'http://127.0.0.1:19090/v1' },
    })
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
    await waitFor(() => expect(catalogRequests).toBeGreaterThan(1))
    expect(screen.getByLabelText<HTMLInputElement>('服务地址').value).toBe(
      'http://127.0.0.1:19090/v1',
    )
  })

  it('ignores an older configuration failure after a newer reconnect succeeds', async () => {
    let catalogRequests = 0
    let rejectOlder: ((response: Response) => void) | undefined
    installFetch(path => {
      if (path !== '/v1/settings/agent-models') return undefined
      catalogRequests += 1
      if (catalogRequests === 1)
        return Response.json(
          { message: 'initial catalog error' },
          { status: 503 },
        )
      if (catalogRequests === 2)
        return new Promise<Response>(resolve => {
          rejectOlder = resolve
        })
      return Response.json({
        defaultProvider: 'Magpie',
        defaultModel: 'deepseek-v4.1-flash',
        models: [],
      })
    })
    render(<App />)
    const reconnect = await screen.findByRole('button', { name: '重新连接' })
    fireEvent.click(reconnect)
    fireEvent.click(reconnect)
    await waitFor(() => expect(catalogRequests).toBe(3))
    await waitFor(() =>
      expect(screen.queryByText(/initial catalog error/)).toBeNull(),
    )
    rejectOlder?.(
      Response.json({ message: 'stale catalog error' }, { status: 503 }),
    )
    await act(async () => Promise.resolve())
    expect(screen.queryByText(/stale catalog error/)).toBeNull()
  })

  it('surfaces usage and agent catalog failures without inventing zero usage', async () => {
    let usageRequests = 0
    installFetch(path => {
      if (path.startsWith('/v1/usage?')) {
        usageRequests += 1
        return Response.json({ message: 'usage offline' }, { status: 503 })
      }
      if (path === '/v1/settings/agent-models')
        return Response.json({ message: 'catalog offline' }, { status: 503 })
      return undefined
    })
    render(<App />)
    expect(await screen.findByText(/catalog offline/)).toBeTruthy()
    fireEvent.click(
      within(screen.getByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /模型用量/ }))
    expect(await screen.findByText('usage offline')).toBeTruthy()
    expect(screen.queryByText('总 Token')).toBeNull()
    expect(screen.getByText(/尚未取得用量数据/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    await waitFor(() => expect(usageRequests).toBeGreaterThan(1))
  })

  it('renders entirely unavailable usage as unknown instead of zero', async () => {
    installFetch(path =>
      path.startsWith('/v1/usage?')
        ? Response.json({
            summary: {
              records: 1,
              completeRecords: 0,
              partialRecords: 0,
              unavailableRecords: 1,
              inputTokens: 0,
              outputTokens: 0,
              durationMs: 0,
            },
            records: [
              {
                runId: run.id,
                taskId: channel.id,
                userId: 'owner',
                workerIconId: 'computer',
                executor: 'dsh',
                completeness: 'unavailable',
                reportedSteps: 0,
                unreportedSteps: 1,
                observedAt: run.updatedAt,
              },
            ],
          })
        : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /模型用量/ }))
    const tokenMetric = screen.getByText('总 Token').closest('article')
    const cacheMetric = screen.getByText('缓存读取').closest('article')
    const durationMetric = screen.getByText('运行时长').closest('article')
    if (!tokenMetric || !cacheMetric || !durationMetric)
      throw new Error('Expected usage metric cards')
    expect(within(tokenMetric).getByText('—')).toBeTruthy()
    expect(within(cacheMetric).getByText('—')).toBeTruthy()
    expect(within(durationMetric).getByText('—')).toBeTruthy()
    expect(screen.getAllByText('执行器未回报').length).toBeGreaterThanOrEqual(3)
  })

  it('keeps task and run attribution in the global usage table', async () => {
    installFetch()
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /模型用量/ }))
    expect(
      await screen.findByText(`事情 ${channel.id} · Run ${run.id}`),
    ).toBeTruthy()
  })

  it('switches the usage table between run and model dimensions', async () => {
    installFetch(path => {
      if (!path.startsWith('/v1/usage?')) return undefined
      return Response.json({
        summary: {
          records: 2,
          completeRecords: 2,
          partialRecords: 0,
          unavailableRecords: 0,
          inputTokens: 3000,
          outputTokens: 500,
          durationMs: 30_000,
        },
        records: [
          {
            runId: 'run-a',
            taskId: 'task-1',
            userId: 'owner',
            workerIconId: 'computer',
            executor: 'dsh',
            modelRef: 'magpie/qwen4-max',
            completeness: 'complete',
            inputTokens: 1000,
            outputTokens: 200,
            reportedSteps: 1,
            unreportedSteps: 0,
            durationMs: 10_000,
            observedAt: '2026-11-22T00:00:00.000Z',
          },
          {
            runId: 'run-b',
            taskId: 'task-2',
            userId: 'owner',
            workerIconId: 'computer',
            executor: 'dsh',
            modelRef: 'magpie/qwen4-max',
            completeness: 'complete',
            inputTokens: 2000,
            outputTokens: 300,
            reportedSteps: 2,
            unreportedSteps: 0,
            durationMs: 20_000,
            observedAt: '2026-11-22T00:01:00.000Z',
          },
        ],
      })
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /模型用量/ }))
    expect(await screen.findByText('事情 task-1 · Run run-a')).toBeTruthy()
    expect(screen.getByText('事情 task-2 · Run run-b')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '按模型' }))
    expect(screen.queryByText('事情 task-1 · Run run-a')).toBeNull()
    expect(screen.getByText('2 个 Run · 2 个事情')).toBeTruthy()
    expect(screen.getByText('3,000')).toBeTruthy()
    expect(screen.getByText('500')).toBeTruthy()
    expect(screen.getAllByText('30s').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '按 Run' }))
    expect(screen.getByText('事情 task-1 · Run run-a')).toBeTruthy()
  })

  it('expands the run workflow inline with markdown and tool details', async () => {
    installSnapshotFetch(
      {
        ...snapshot,
        channels: [{ ...channel, status: 'completed', canStop: false }],
        runs: [
          {
            ...run,
            status: 'completed',
            output: '**结论**：团队版每人每月 30 美元。',
          },
        ],
      },
      path => {
        if (!path.startsWith('/v1/runs/run-1/activity?')) return undefined
        return Response.json({
          runId: 'run-1',
          taskId: channel.id,
          totalEntries: 4,
          truncated: false,
          entries: [
            {
              seq: 1,
              kind: 'step',
              status: 'started',
              step: 1,
              label: '第 1 步开始',
              createdAt: '2026-11-19T08:00:10.000Z',
              updatedAt: '2026-11-19T08:00:10.000Z',
            },
            {
              seq: 2,
              kind: 'tool_call',
              status: 'completed',
              callId: 'call-1',
              tool: 'shell',
              label: 'shell',
              detail:
                '{"command":"curl https://example.com/pricing"}\n[结果]\nTeam $30',
              semantic: {
                kind: 'shell',
                command: 'curl https://example.com/pricing',
                output: 'Team $30',
              },
              createdAt: '2026-11-19T08:00:20.000Z',
              updatedAt: '2026-11-19T08:00:30.000Z',
            },
            {
              seq: 3,
              kind: 'thinking',
              label: '核对价格口径',
              detail: '需要区分*年付*与月付。',
              createdAt: '2026-11-19T08:00:40.000Z',
              updatedAt: '2026-11-19T08:00:40.000Z',
            },
            {
              seq: 4,
              kind: 'text',
              label: '团队版价格已确认',
              detail: '团队版价格为 **$30/人/月**。',
              createdAt: '2026-11-19T08:00:50.000Z',
              updatedAt: '2026-11-19T08:00:50.000Z',
            },
          ],
        })
      },
    )
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(channel.title) }),
    )
    const taskDrawer = await screen.findByRole('dialog', { name: '工作详情' })
    const heroStrong = taskDrawer.querySelector('.state-hero-markdown strong')
    expect(heroStrong?.textContent).toBe('结论')
    fireEvent.click(await within(taskDrawer).findByText(/工作流程记录/))
    expect(await within(taskDrawer).findByText('核对价格口径')).toBeTruthy()
    expect(within(taskDrawer).queryByText('第 1 步开始')).toBeNull()
    expect(taskDrawer.querySelector('.activity-step')).toBeNull()
    expect(screen.queryByRole('dialog', { name: '运行详情' })).toBeNull()
    expect(
      within(taskDrawer).queryByRole('button', { name: /查看完整记录/ }),
    ).toBeNull()
    const curlHeadline = within(taskDrawer).getAllByText(
      'curl https://example.com/pricing',
    )[0]
    if (!curlHeadline) throw new Error('expected shell headline')
    fireEvent.click(curlHeadline)
    expect(taskDrawer.querySelector('.shell-card')).toBeTruthy()
    expect(within(taskDrawer).getByText(/Team \$30/)).toBeTruthy()
    expect(
      within(taskDrawer).getByRole('button', { name: '复制命令与输出' }),
    ).toBeTruthy()
    fireEvent.click(within(taskDrawer).getByText('核对价格口径'))
    expect(within(taskDrawer).getByText('年付').tagName).toBe('EM')
    const messageStrong = taskDrawer.querySelectorAll(
      '.activity-message strong',
    )
    expect(
      [...messageStrong].some(node => node.textContent === '$30/人/月'),
    ).toBe(true)
    fireEvent.click(within(taskDrawer).getByText('最终结果'))
    expect(
      [...taskDrawer.querySelectorAll('.run-final-output strong')].some(
        node => node.textContent === '结论',
      ),
    ).toBe(true)
  })

  it('renders a subagent delegation card with the child execution transcript', async () => {
    installSnapshotFetch(
      {
        ...snapshot,
        channels: [{ ...channel, status: 'completed', canStop: false }],
        runs: [
          {
            ...run,
            status: 'completed',
            output: 'docs 共 29 个文件。',
          },
        ],
      },
      path => {
        if (path.startsWith('/v1/runs/run-1/activity?')) {
          return Response.json({
            runId: 'run-1',
            taskId: channel.id,
            totalEntries: 1,
            truncated: false,
            entries: [
              {
                seq: 1,
                kind: 'tool_call',
                status: 'completed',
                callId: 'call-delegate',
                tool: 'subagent',
                label: 'subagent',
                detail:
                  '{"description":"统计 docs 文件","prompt":"数一下 docs 目录的文件数","name":"agent-1"}\n[结果]\nstarted subagent agent-1\ndocs 目录共 **29** 个文件。',
                createdAt: '2026-11-19T08:00:10.000Z',
                updatedAt: '2026-11-19T08:00:40.000Z',
              },
            ],
          })
        }
        if (path.startsWith('/v1/runs/run-1/subagents?')) {
          return Response.json({
            runId: 'run-1',
            taskId: channel.id,
            subagents: [
              {
                sessionId: 'session-child',
                parentSessionId: 'session-root',
                delegationDepth: 1,
                label: '统计 docs 文件',
                prompt: '数一下 docs 目录的文件数',
                createdAt: '2026-11-19T08:00:12.000Z',
                totalEntries: 2,
                truncated: false,
                entries: [
                  {
                    seq: 1,
                    kind: 'tool_call',
                    status: 'completed',
                    callId: 'call-child',
                    tool: 'bash',
                    label: 'bash',
                    detail: '{"command":"ls docs | wc -l"}\n[结果]\n29',
                    semantic: {
                      kind: 'shell',
                      command: 'ls docs | wc -l',
                      output: '29',
                    },
                    createdAt: '2026-11-19T08:00:15.000Z',
                    updatedAt: '2026-11-19T08:00:16.000Z',
                  },
                  {
                    seq: 2,
                    kind: 'text',
                    label: 'docs 目录共 29 个文件。',
                    detail: 'docs 目录共 29 个文件。',
                    createdAt: '2026-11-19T08:00:18.000Z',
                    updatedAt: '2026-11-19T08:00:18.000Z',
                  },
                ],
              },
            ],
          })
        }
        return undefined
      },
    )
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(channel.title) }),
    )
    const taskDrawer = await screen.findByRole('dialog', { name: '工作详情' })
    fireEvent.click(await within(taskDrawer).findByText(/工作流程记录/))
    const card = await within(taskDrawer).findByText(/子任务 · 统计 docs 文件/)
    fireEvent.click(card)
    fireEvent.click(within(taskDrawer).getByText('任务书'))
    expect(
      within(taskDrawer).getByText(/数一下 docs 目录的文件数/),
    ).toBeTruthy()
    expect(
      [...taskDrawer.querySelectorAll('.transcript-subagent strong')].some(
        node => node.textContent === '29',
      ),
    ).toBe(true)
    fireEvent.click(
      await within(taskDrawer).findByText(/子 agent 执行记录 · 工具 1 次/),
    )
    const childHeadline = within(taskDrawer).getAllByText('ls docs | wc -l')[0]
    if (!childHeadline) throw new Error('expected child shell headline')
    fireEvent.click(childHeadline)
    expect(taskDrawer.querySelector('.shell-card')).toBeTruthy()
    expect(within(taskDrawer).getAllByText('29').length).toBeGreaterThan(0)
    expect(
      within(taskDrawer).getAllByText('docs 目录共 29 个文件。').length,
    ).toBeGreaterThan(0)
  })

  it('shows only the matched child under each delegation card', async () => {
    installSnapshotFetch(
      {
        ...snapshot,
        channels: [{ ...channel, status: 'completed', canStop: false }],
        runs: [{ ...run, status: 'completed', output: '两个子任务都完成了。' }],
      },
      path => {
        if (path.startsWith('/v1/runs/run-1/activity?')) {
          return Response.json({
            runId: 'run-1',
            taskId: channel.id,
            totalEntries: 2,
            truncated: false,
            entries: [
              {
                seq: 1,
                kind: 'tool_call',
                status: 'completed',
                callId: 'call-a',
                tool: 'subagent',
                label: 'subagent',
                detail:
                  '{"description":"数文件","prompt":"数一下 docs 文件数"}\n[结果]\n28 个',
                createdAt: '2026-11-19T08:00:10.000Z',
                updatedAt: '2026-11-19T08:00:40.000Z',
              },
              {
                seq: 2,
                kind: 'tool_call',
                status: 'completed',
                callId: 'call-b',
                tool: 'subagent',
                label: 'subagent',
                detail:
                  '{"description":"查定价","prompt":"查一下 Notion 定价"}\n[结果]\n$10',
                createdAt: '2026-11-19T08:00:50.000Z',
                updatedAt: '2026-11-19T08:01:20.000Z',
              },
            ],
          })
        }
        if (path.startsWith('/v1/runs/run-1/subagents?')) {
          return Response.json({
            runId: 'run-1',
            taskId: channel.id,
            subagents: [
              {
                sessionId: 'child-files',
                parentSessionId: 'session-root',
                delegationDepth: 1,
                label: '数文件',
                prompt: '数一下 docs 文件数',
                createdAt: '2026-11-19T08:00:12.000Z',
                totalEntries: 1,
                truncated: false,
                entries: [
                  {
                    seq: 1,
                    kind: 'text',
                    label: '共 28 个文件',
                    detail: '共 28 个文件',
                    createdAt: '2026-11-19T08:00:20.000Z',
                    updatedAt: '2026-11-19T08:00:20.000Z',
                  },
                ],
              },
              {
                sessionId: 'child-pricing',
                parentSessionId: 'session-root',
                delegationDepth: 1,
                label: '查定价',
                prompt: '查一下 Notion 定价',
                createdAt: '2026-11-19T08:00:52.000Z',
                totalEntries: 1,
                truncated: false,
                entries: [
                  {
                    seq: 1,
                    kind: 'text',
                    label: 'Plus 每人每月 10 美元',
                    detail: 'Plus 每人每月 10 美元',
                    createdAt: '2026-11-19T08:01:00.000Z',
                    updatedAt: '2026-11-19T08:01:00.000Z',
                  },
                ],
              },
            ],
          })
        }
        return undefined
      },
    )
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(channel.title) }),
    )
    const taskDrawer = await screen.findByRole('dialog', { name: '工作详情' })
    fireEvent.click(await within(taskDrawer).findByText(/工作流程记录/))
    const filesCard = (
      await within(taskDrawer).findByText(/子任务 · 数文件/)
    ).closest('details')
    const pricingCard = within(taskDrawer)
      .getByText(/子任务 · 查定价/)
      .closest('details')
    if (!filesCard || !pricingCard) throw new Error('expected delegation cards')
    fireEvent.click(within(taskDrawer).getByText(/子任务 · 数文件/))
    fireEvent.click(
      await within(filesCard as HTMLElement).findByText(/子 agent 执行记录/),
    )
    expect(
      within(filesCard as HTMLElement).getByText('共 28 个文件'),
    ).toBeTruthy()
    expect(
      within(filesCard as HTMLElement).queryByText('Plus 每人每月 10 美元'),
    ).toBeNull()
    fireEvent.click(within(taskDrawer).getByText(/子任务 · 查定价/))
    fireEvent.click(
      await within(pricingCard as HTMLElement).findByText(/子 agent 执行记录/),
    )
    expect(
      within(pricingCard as HTMLElement).getByText('Plus 每人每月 10 美元'),
    ).toBeTruthy()
    expect(
      within(pricingCard as HTMLElement).queryByText('共 28 个文件'),
    ).toBeNull()
  })

  it('anchors terminal result cards back to the origin message', async () => {
    const source = snapshot.messages[0]
    const originEvent = snapshot.events[0]
    if (!source || !originEvent) throw new Error('missing chat fixtures')
    installSnapshotFetch({
      ...snapshot,
      events: [
        originEvent,
        {
          ...originEvent,
          id: 'event-steer',
          payload: { text: '重点看团队版，输出成表格', taskId: channel.id },
          createdAt: '2026-11-19T08:00:30.000Z',
        },
      ],
      messages: [
        {
          ...source,
          id: 'result-cue',
          payload: {
            type: 'run.completed',
            runId: run.id,
            text: '价格表格已生成。',
          },
          createdAt: '2026-11-19T08:05:00.000Z',
          projection: {
            lane: 'work',
            weight: 'card',
            anchor: { taskId: channel.id, eventId: originEvent.id },
          },
        },
      ],
    })
    render(<App />)
    expect(await screen.findByText('价格表格已生成。')).toBeTruthy()
    const card = document.querySelector('.fact-card.is-work')
    expect(card?.textContent).toContain(channel.title)
    expect(card?.textContent).not.toContain('原始请求：')
    expect(card?.textContent).not.toContain('你最近补充：')
    fireEvent.click(screen.getByRole('button', { name: '回到发起消息' }))
    expect(
      document.querySelector(
        `[data-message-id="${originEvent.id}"].is-anchor-highlight`,
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看进展' }))
    expect(
      document.querySelector(
        '[data-message-id="result-cue"].is-anchor-highlight',
      ),
    ).toBeTruthy()
  })

  it('shows router and rewrite metering with honest unreported tokens', async () => {
    installFetch(path => {
      if (!path.startsWith('/v1/usage?')) return undefined
      return Response.json({
        summary: {
          records: 0,
          completeRecords: 0,
          partialRecords: 0,
          unavailableRecords: 0,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
        },
        records: [],
        router: {
          summary: {
            calls: 2,
            okCalls: 1,
            errorCalls: 1,
            reportedCalls: 1,
            inputTokens: 100,
            outputTokens: 20,
            durationMs: 900,
          },
          records: [
            {
              callId: 'router:event-1:openai/router-model',
              userId: 'owner',
              component: 'router',
              eventId: 'event-1',
              modelRef: 'openai/router-model',
              completeness: 'complete',
              tokenSource: 'provider_reported',
              inputTokens: 100,
              outputTokens: 20,
              durationMs: 500,
              latencySource: 'pegas_observed',
              outcome: 'ok',
              observedAt: '2026-11-22T00:00:00.000Z',
            },
            {
              callId: 'rewrite:event-2:openai/router-model',
              userId: 'owner',
              component: 'rewrite',
              eventId: 'event-2',
              modelRef: 'openai/router-model',
              completeness: 'unavailable',
              durationMs: 400,
              latencySource: 'pegas_observed',
              outcome: 'error',
              observedAt: '2026-11-22T00:00:01.000Z',
            },
          ],
        },
      })
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /模型用量/ }))
    expect(await screen.findByText('路由与改写用量')).toBeTruthy()
    expect(screen.getByText('成功 1 · 失败 1')).toBeTruthy()
    expect(screen.getByText('路由 · 事件 event-1')).toBeTruthy()
    expect(screen.getByText('改写 · 事件 event-2')).toBeTruthy()
    expect(screen.getByText('120')).toBeTruthy()
  })

  it('shows the shell as offline when the authoritative snapshot fails', async () => {
    installFetch(path =>
      path.startsWith('/v1/events?')
        ? Response.json({ message: 'control plane offline' }, { status: 503 })
        : undefined,
    )
    render(<App />)
    expect(await screen.findByText('control plane offline')).toBeTruthy()
    expect(screen.getByText('离线')).toBeTruthy()
    expect(screen.queryByText('在线')).toBeNull()
  })

  it('marks a saved execution model unavailable when it is absent from the catalog', async () => {
    installFetch(path =>
      path === '/v1/settings/agent-models'
        ? Response.json({
            defaultProvider: 'Magpie',
            defaultModel: 'different-model',
            models: [
              {
                provider: 'Magpie',
                id: 'different-model',
                name: 'different-model',
              },
            ],
          })
        : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    expect(await screen.findByText('未在模型目录中')).toBeTruthy()
    expect(screen.queryByText('可用')).toBeNull()
  })

  it('does not let a slow usage request starve the core snapshot', async () => {
    installFetch(path => {
      if (path.startsWith('/v1/usage?'))
        return new Promise<Response>(() => undefined)
      return undefined
    })
    render(<App />)
    expect(await screen.findByText('你的私人智能工作伙伴')).toBeTruthy()
    expect(await screen.findByText('安全自更新流程')).toBeTruthy()
  })

  it('restores profile-managed execution after a model override', async () => {
    const fetchMock = installFetch()
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.change(screen.getByLabelText('模型'), {
      target: { value: 'profile' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path, init]) => {
          if (path !== '/v1/settings' || init?.method !== 'PUT') return false
          const body = JSON.parse(
            typeof init.body === 'string' ? init.body : '{}',
          ) as {
            agentModelMode?: string
            agentModelProvider?: string
            agentModelName?: string
          }
          return (
            body.agentModelMode === 'profile' &&
            body.agentModelProvider === '' &&
            body.agentModelName === ''
          )
        }),
      ).toBe(true),
    )
  })

  it('restores focus to the attention action after closing its detail', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const attentionMessage = {
      ...sourceMessage,
      payload: { type: 'run.failed', error: '需要人工处理' },
    }
    installSnapshotFetch({ ...snapshot, messages: [attentionMessage] }, path =>
      path.endsWith('/read')
        ? Response.json({
            message: {
              ...attentionMessage,
              readAt: '2026-11-19T09:00:00.000Z',
            },
          })
        : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    const action = screen.getByRole('button', { name: /^查看原因：/ })
    action.focus()
    fireEvent.click(action)
    fireEvent.click(await screen.findByRole('button', { name: '关闭详情' }))
    await waitFor(() => expect(document.activeElement).toBe(action))
  })

  it('restores focus when browser history closes a task drawer', async () => {
    installFetch()
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    const trigger = screen.getByRole('button', { name: /安全自更新流程/ })
    trigger.focus()
    fireEvent.click(trigger)
    expect(await screen.findByLabelText('工作详情')).toBeTruthy()
    window.history.back()
    await waitFor(() => expect(screen.queryByLabelText('工作详情')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('opens an attention item on the Run referenced by its payload', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const failedRun: Run = {
      ...run,
      id: 'run-failed',
      status: 'failed',
      lastError: '旧 Run 的 provider timeout',
      updatedAt: '2026-11-19T08:01:00.000Z',
    }
    const successfulRetry: Run = {
      ...run,
      id: 'run-success',
      status: 'completed',
      output: '重试成功',
      updatedAt: '2026-11-19T08:10:00.000Z',
    }
    installSnapshotFetch({
      ...snapshot,
      runs: [failedRun, successfulRetry],
      messages: [
        {
          ...sourceMessage,
          payload: {
            type: 'run.failed',
            runId: failedRun.id,
            error: failedRun.lastError,
          },
        },
      ],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^查看原因：/ }))
    const drawer = await screen.findByLabelText('工作详情')
    expect(
      within(drawer).getAllByText('旧 Run 的 provider timeout').length,
    ).toBeGreaterThan(0)
    expect(within(drawer).getByText('执行已停止')).toBeTruthy()
  })

  it('refreshes an open Channel timeline during polling', async () => {
    vi.useFakeTimers()
    let timelineRequests = 0
    try {
      installFetch(path => {
        if (!path.startsWith('/v1/channels/task-1/timeline?')) return undefined
        timelineRequests += 1
        return Response.json({
          channel,
          events: snapshot.events,
          messages: snapshot.messages,
          runs: snapshot.runs,
        })
      })
      render(<App />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      fireEvent.click(
        within(screen.getByLabelText('主导航')).getByRole('button', {
          name: /所有事情/,
        }),
      )
      fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(timelineRequests).toBe(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      expect(timelineRequests).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores an older scoped timeline response after a newer poll completes', async () => {
    vi.useFakeTimers()
    let timelineRequests = 0
    let resolveOlder: ((response: Response) => void) | undefined
    try {
      installFetch(path => {
        if (!path.startsWith('/v1/channels/task-1/timeline?')) return undefined
        timelineRequests += 1
        if (timelineRequests === 1)
          return new Promise<Response>(resolve => {
            resolveOlder = resolve
          })
        return Response.json({
          channel,
          events: [
            {
              ...snapshot.events[0],
              id: 'newer-scoped-event',
              payload: { text: '较新的时间线' },
            },
          ],
          messages: snapshot.messages,
          runs: snapshot.runs,
        })
      })
      render(<App />)
      await act(async () => vi.advanceTimersByTimeAsync(0))
      fireEvent.click(
        within(screen.getByLabelText('主导航')).getByRole('button', {
          name: /所有事情/,
        }),
      )
      fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
      await act(async () => vi.advanceTimersByTimeAsync(5_000))
      expect(screen.getByText('较新的时间线')).toBeTruthy()
      resolveOlder?.(
        Response.json({
          channel,
          events: [
            {
              ...snapshot.events[0],
              id: 'older-scoped-event',
              payload: { text: '过期时间线' },
            },
          ],
          messages: snapshot.messages,
          runs: snapshot.runs,
        }),
      )
      await act(async () => vi.advanceTimersByTimeAsync(0))
      expect(screen.queryByText('过期时间线')).toBeNull()
      expect(screen.getByText('较新的时间线')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reopens an attention detail when browser history returns to its URL', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    installSnapshotFetch({
      ...snapshot,
      messages: [
        {
          ...sourceMessage,
          payload: { type: 'run.failed', error: '执行失败' },
        },
      ],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^查看原因：/ }))
    expect(await screen.findByLabelText('工作详情')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }))
    fireEvent.click(
      within(screen.getByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    window.history.back()
    expect(await screen.findByLabelText('工作详情')).toBeTruthy()
    expect(window.location.search).toContain('outbox=message-1')
  })

  it('preserves advanced provider, rewrite credential, and privacy controls', async () => {
    const customSettings: SettingsResponse = {
      ...settingsResponse,
      settings: {
        ...settingsResponse.settings,
        modelProvider: 'custom',
        privacyMode: 'disabled',
      },
      capabilities: {
        privacyAvailable: false,
        providers: [
          ...settingsResponse.capabilities.providers,
          {
            id: 'custom',
            name: '自定义',
            category: 'custom',
            protocol: 'openai-chat',
            baseUrl: 'https://models.example/v1',
            defaultModel: 'custom-model',
            description: '自定义服务',
            requiresApiKey: false,
            hasApiKey: true,
            available: true,
          },
        ],
      },
      rewrite: {
        mode: 'custom',
        protocol: 'openai-chat',
        baseUrl: 'https://rewrite.example/v1',
        model: 'rewrite-model',
        hasApiKey: true,
      },
    }
    installFetch(path =>
      path === '/v1/settings' ? Response.json(customSettings) : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /模型服务/ }))
    const providerProtocol = screen.getByLabelText('接口协议')
    expect(providerProtocol.tagName).toBe('SELECT')
    fireEvent.change(providerProtocol, {
      target: { value: 'anthropic-messages' },
    })
    expect(providerProtocol).toHaveProperty('value', 'anthropic-messages')

    fireEvent.click(screen.getByRole('button', { name: /语音与输入/ }))
    const rewriteProtocol = screen.getByLabelText('改写接口协议')
    expect(rewriteProtocol.tagName).toBe('SELECT')
    expect(screen.getByLabelText('清除改写服务 API Key')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /隐私/ }))
    const privacy = screen.getByLabelText('启用遮罩')
    expect(privacy).toHaveProperty('disabled', true)
    expect(screen.getByText(/服务端尚未配置隐私 HMAC key/)).toBeTruthy()
  })

  it('loads and renders the selected Channel timeline in the detail drawer', async () => {
    installFetch(path => {
      if (!path.startsWith('/v1/channels/task-1/timeline?')) return undefined
      return Response.json({
        channel,
        events: [
          {
            ...snapshot.events[0],
            id: 'scoped-event',
            payload: { text: '只属于当前 Channel 的输入' },
          },
        ],
        messages: [],
        runs: snapshot.runs,
      })
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    expect(await screen.findByText('只属于当前 Channel 的输入')).toBeTruthy()
  })

  it('surfaces a scoped Channel timeline failure in the detail drawer', async () => {
    installFetch(path =>
      path.startsWith('/v1/channels/task-1/timeline?')
        ? Response.json({ message: '时间线暂时不可用' }, { status: 503 })
        : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    expect(await screen.findByText('时间线暂时不可用')).toBeTruthy()
  })

  it('continues running work in the same Channel', async () => {
    const fetchMock = installFetch()
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: /进行中 · 安全自更新流程/ }),
    )
    fireEvent.click(screen.getByRole('button', { name: '继续追问' }))
    expect(await screen.findByText(/继续事情：/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('给 Pegas 发消息'), {
      target: { value: '补充当前事情' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path, init]) => {
          if (path !== '/v1/events' || init?.method !== 'POST') return false
          const body = JSON.parse(
            typeof init.body === 'string' ? init.body : '{}',
          ) as { payload?: { taskId?: string } }
          return body.payload?.taskId === channel.id
        }),
      ).toBe(true),
    )
  })

  it('keeps read but unresolved attention available and reports read failures', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    installSnapshotFetch(
      {
        ...snapshot,
        messages: [
          {
            ...sourceMessage,
            payload: { type: 'run.failed', error: '需要处理的失败' },
          },
        ],
      },
      path =>
        path.endsWith('/read')
          ? Response.json({ message: '无法标记已读' }, { status: 503 })
          : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^查看原因：/ }))
    expect(await screen.findByText('无法标记已读')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }))
    expect(
      screen.getByRole('heading', { level: 2, name: '需要处理的失败' }),
    ).toBeTruthy()
    expect(screen.getByText('未读')).toBeTruthy()
    expect(screen.getByText(/来自：/)).toBeTruthy()
  })

  it('keeps unresolved attention available after it is marked read', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const attentionMessage = {
      ...sourceMessage,
      payload: { type: 'run.failed', error: '已读但仍需处理' },
    }
    installSnapshotFetch({ ...snapshot, messages: [attentionMessage] }, path =>
      path.endsWith('/read')
        ? Response.json({
            message: {
              ...attentionMessage,
              readAt: '2026-11-19T09:00:00.000Z',
            },
          })
        : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^查看原因：/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '关闭详情' })).toBeTruthy(),
    )
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }))
    expect(screen.getByText('已读但仍需处理')).toBeTruthy()
    expect(screen.getByText('已读')).toBeTruthy()
    expect(screen.getByText(/来自：/)).toBeTruthy()
  })

  it('does not mark an already-read attention item again', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    let readRequests = 0
    installSnapshotFetch(
      {
        ...snapshot,
        messages: [
          {
            ...sourceMessage,
            readAt: '2026-11-19T09:00:00.000Z',
            payload: { type: 'run.failed', error: '仍需处理' },
          },
        ],
      },
      path => {
        if (!path.endsWith('/read')) return undefined
        readRequests += 1
        return Response.json(
          { message: 'read service offline' },
          { status: 503 },
        )
      },
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^查看原因：/ }))
    expect(await screen.findByLabelText('工作详情')).toBeTruthy()
    expect(readRequests).toBe(0)
    expect(screen.queryByText('read service offline')).toBeNull()
  })

  it('renders every Run attempt and its failure diagnostic', async () => {
    const failedRun: Run = {
      ...run,
      id: 'run-failed',
      status: 'failed',
      lastError: 'provider timeout',
      createdAt: '2026-11-19T08:00:00.000Z',
      updatedAt: '2026-11-19T08:01:00.000Z',
    }
    const retryRun: Run = {
      ...run,
      id: 'run-retry',
      status: 'queued',
      retryOfRunId: failedRun.id,
      createdAt: '2026-11-19T08:02:00.000Z',
      updatedAt: '2026-11-19T08:02:00.000Z',
    }
    installSnapshotFetch({ ...snapshot, runs: [failedRun, retryRun] })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    const drawer = await screen.findByLabelText('工作详情')
    expect(within(drawer).getByText(/Run 1/)).toBeTruthy()
    expect(within(drawer).getByText(/Run 2/)).toBeTruthy()
    expect(within(drawer).getByText('provider timeout')).toBeTruthy()
  })

  it('refreshes the open drawer with the Run created by retry', async () => {
    const failedRun: Run = {
      ...run,
      id: 'run-failed',
      status: 'failed',
      lastError: 'provider timeout',
      updatedAt: '2026-11-19T08:01:00.000Z',
    }
    const retryRun: Run = {
      ...run,
      id: 'run-retry',
      status: 'queued',
      retryOfRunId: failedRun.id,
      createdAt: '2026-11-19T08:03:00.000Z',
      updatedAt: '2026-11-19T08:03:00.000Z',
    }
    let retried = false
    installSnapshotFetch({ ...snapshot, runs: [failedRun] }, (path, init) => {
      if (
        path === `/v1/runs/${failedRun.id}/retry` &&
        init?.method === 'POST'
      ) {
        retried = true
        return Response.json({ run: retryRun })
      }
      if (path.startsWith('/v1/runs?'))
        return Response.json({
          runs: retried ? [failedRun, retryRun] : [failedRun],
        })
      if (path.startsWith('/v1/channels/task-1/timeline?'))
        return Response.json({
          channel,
          events: snapshot.events,
          messages: snapshot.messages,
          runs: retried ? [failedRun, retryRun] : [failedRun],
        })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    fireEvent.click(await screen.findByRole('button', { name: '重试' }))
    const drawer = await screen.findByLabelText('工作详情')
    expect(await within(drawer).findByText(/Run 2 · run-retr/)).toBeTruthy()
    expect(within(drawer).queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('selects the successor Run after retrying from a failed attention item', async () => {
    const failedRun: Run = {
      ...run,
      id: 'run-attention-failed',
      status: 'failed',
      lastError: 'attention provider timeout',
      updatedAt: '2026-11-19T08:01:00.000Z',
    }
    const retryRun: Run = {
      ...run,
      id: 'run-attention-retry',
      status: 'queued',
      retryOfRunId: failedRun.id,
      createdAt: '2026-11-19T08:03:00.000Z',
      updatedAt: '2026-11-19T08:03:00.000Z',
    }
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox fixture message')
    const attentionMessage = {
      ...sourceMessage,
      payload: {
        type: 'run.failed',
        runId: failedRun.id,
        error: failedRun.lastError,
      },
    }
    let retried = false
    installSnapshotFetch(
      {
        ...snapshot,
        runs: [failedRun],
        messages: [attentionMessage],
      },
      (path, init) => {
        if (
          path === `/v1/runs/${failedRun.id}/retry` &&
          init?.method === 'POST'
        ) {
          retried = true
          return Response.json({ run: retryRun })
        }
        if (path.endsWith('/read'))
          return Response.json({
            message: { ...attentionMessage, readAt: run.updatedAt },
          })
        if (path.startsWith('/v1/runs?'))
          return Response.json({
            runs: retried ? [failedRun, retryRun] : [failedRun],
          })
        if (path.startsWith('/v1/channels/task-1/timeline?'))
          return Response.json({
            channel,
            events: snapshot.events,
            messages: [attentionMessage],
            runs: retried ? [failedRun, retryRun] : [failedRun],
          })
        return undefined
      },
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^查看原因：/ }))
    fireEvent.click(await screen.findByRole('button', { name: '重试' }))
    const drawer = await screen.findByLabelText('工作详情')
    expect(await within(drawer).findByText(/Run 2 · run-atte/)).toBeTruthy()
    expect(within(drawer).getByText('Pegas 正在推进这件事')).toBeTruthy()
    expect(within(drawer).queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('uses provider-compatible models for routing and custom probes', async () => {
    const customSettings: SettingsResponse = {
      ...settingsResponse,
      settings: {
        ...settingsResponse.settings,
        modelProvider: 'custom',
        modelName: 'configured-custom-model',
      },
      capabilities: {
        ...settingsResponse.capabilities,
        providers: [
          ...settingsResponse.capabilities.providers,
          {
            id: 'custom',
            name: '自定义',
            category: 'custom',
            protocol: 'openai-chat',
            baseUrl: 'https://models.example/v1',
            defaultModel: '',
            description: '自定义服务',
            requiresApiKey: false,
            hasApiKey: false,
            available: true,
          },
        ],
      },
    }
    const fetchMock = installFetch((path, init) => {
      if (path === '/v1/settings') return Response.json(customSettings)
      if (path === '/v1/settings/models/test' && init?.method === 'POST')
        return Response.json({ ok: true, latencyMs: 12 })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /模型服务/ }))
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path, init]) => {
          if (path !== '/v1/settings/models/test') return false
          const body = JSON.parse(
            typeof init?.body === 'string' ? init.body : '{}',
          ) as { modelName?: string }
          return body.modelName === 'configured-custom-model'
        }),
      ).toBe(true),
    )
    fireEvent.click(screen.getByRole('button', { name: /事情归类/ }))
    fireEvent.change(screen.getByLabelText('归类模型服务'), {
      target: { value: 'anthropic' },
    })
    expect(screen.getByLabelText('归类模型名称')).toHaveProperty(
      'value',
      'claude-sonnet-4-5',
    )
  })

  it('does not attribute an old provider discovery result to a new selection', async () => {
    let resolveDiscovery: ((response: Response) => void) | undefined
    installFetch((path, init) => {
      if (path === '/v1/settings/models/discover' && init?.method === 'POST')
        return new Promise<Response>(resolve => {
          resolveDiscovery = resolve
        })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /模型服务/ }))
    fireEvent.click(screen.getByRole('button', { name: '获取模型目录' }))
    fireEvent.click(screen.getByRole('button', { name: /Anthropic/ }))
    resolveDiscovery?.(
      Response.json({
        models: [{ id: 'magpie-only', name: 'Magpie only' }],
      }),
    )
    await act(async () => Promise.resolve())
    expect(screen.queryByText('Magpie only')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Anthropic' })).toBeTruthy()
  })

  it('does not stack global search over an open detail drawer', async () => {
    installFetch()
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: /进行中 · 安全自更新流程/ }),
    )
    expect(await screen.findByLabelText('工作详情')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(screen.queryByRole('dialog', { name: '全局搜索' })).toBeNull()
  })

  it('reports the actual rewrite owner from model services', async () => {
    installFetch(path =>
      path === '/v1/settings'
        ? Response.json({
            ...settingsResponse,
            settings: { ...settingsResponse.settings, rewriteMode: 'disabled' },
          })
        : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /模型服务/ }))
    expect(screen.getByText('未启用')).toBeTruthy()
    const rewriteShortcut = screen.getAllByRole('button', {
      name: '打开设置',
    })[1]
    if (!rewriteShortcut) throw new Error('Expected rewrite settings shortcut')
    fireEvent.click(rewriteShortcut)
    expect(screen.getByRole('heading', { name: '语音与输入' })).toBeTruthy()
  })

  it('invalidates a speech test result when its connection changes', async () => {
    class FakeMediaRecorder {
      static isTypeSupported() {
        return false
      }
      state: RecordingState = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((event: BlobEvent) => void) | null = null
      onerror: (() => void) | null = null
      onstop: (() => void) | null = null
      start() {
        this.state = 'recording'
      }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['voice']) } as BlobEvent)
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }),
      },
    })
    installFetch((path, init) =>
      path === '/v1/settings/speech/test' && init?.method === 'POST'
        ? Response.json({
            transcript: { text: '旧连接识别结果' },
            latencyMs: 45,
          })
        : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /语音与输入/ }))
    fireEvent.click(screen.getByRole('button', { name: '录一段测试' }))
    fireEvent.click(await screen.findByRole('button', { name: '结束并识别' }))
    expect(await screen.findByText(/旧连接识别结果/)).toBeTruthy()
    const [speechBaseUrl] = screen.getAllByLabelText('服务地址')
    if (!speechBaseUrl) throw new Error('missing speech base URL field')
    fireEvent.change(speechBaseUrl, {
      target: { value: 'http://127.0.0.1:19000/v1' },
    })
    expect(screen.queryByText(/旧连接识别结果/)).toBeNull()
  })

  it('derives drawer token totals from reported input and output', async () => {
    installSnapshotFetch(snapshot, path =>
      path.startsWith('/v1/usage?')
        ? Response.json({
            summary: {
              records: 1,
              completeRecords: 1,
              partialRecords: 0,
              unavailableRecords: 0,
              inputTokens: 40,
              outputTokens: 10,
              durationMs: 100,
            },
            records: [
              {
                runId: run.id,
                taskId: channel.id,
                userId: 'owner',
                workerIconId: 'computer',
                executor: 'dsh',
                completeness: 'complete',
                inputTokens: 40,
                outputTokens: 10,
                reportedSteps: 1,
                unreportedSteps: 0,
                observedAt: run.updatedAt,
              },
            ],
          })
        : undefined,
    )
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: /进行中 · 安全自更新流程/ }),
    )
    expect(
      within(screen.getByLabelText('工作详情')).getByText('50'),
    ).toBeTruthy()
  })

  it('keeps work identity, execution context and result search truthful', async () => {
    installSnapshotFetch({
      ...snapshot,
      channels: [{ ...channel, status: 'completed' }],
      runs: [{ ...run, status: 'completed', output: '独特验收结果' }],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '已完成' }))
    const list = screen.getByLabelText('事情列表')
    expect(
      list.querySelector(
        'img.pegas-agent-glyph[src="/brand/agent-computer.webp"]',
      ),
    ).toBeTruthy()
    expect(within(list).getByText(/dsh · deepseek-v4.1-flash/)).toBeTruthy()
    const search = screen.getByPlaceholderText('搜索事情或结果')
    fireEvent.change(search, { target: { value: '独特验收结果' } })
    expect(screen.getByText(channel.title)).toBeTruthy()
  })

  it('shows ordinary empty work without claiming the service is disabled', async () => {
    installSnapshotFetch({ ...snapshot, channels: [], runs: [] })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    expect(screen.getByText('这里还没有事情')).toBeTruthy()
    expect(screen.queryByText('服务端能力尚未启用')).toBeNull()
  })

  it('shows newest attention items first', async () => {
    const source = snapshot.messages[0]
    if (!source) throw new Error('missing attention fixture')
    installSnapshotFetch({
      ...snapshot,
      messages: [
        {
          ...source,
          id: 'older',
          createdAt: '2026-11-19T08:00:00.000Z',
          payload: { type: 'run.failed', error: '较早失败' },
        },
        {
          ...source,
          id: 'newer',
          createdAt: '2026-11-19T09:00:00.000Z',
          payload: { type: 'run.failed', error: '最新失败' },
        },
      ],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    const articles = screen.getAllByRole('article')
    expect(articles[0]?.textContent).toContain('最新失败')
    expect(articles[1]?.textContent).toContain('较早失败')
  })

  it('keeps protected data hidden until a replacement token is validated', async () => {
    vi.useFakeTimers()
    try {
      let eventRequests = 0
      let replacementPending: Promise<Response> | undefined
      installFetch(path => {
        if (!path.startsWith('/v1/events?')) return undefined
        eventRequests += 1
        if (eventRequests === 1)
          return Response.json({ events: snapshot.events })
        if (eventRequests === 2)
          return Response.json({ message: 'unauthorized' }, { status: 401 })
        replacementPending ??= new Promise<Response>(() => undefined)
        return replacementPending
      })
      render(<App />)
      await act(async () => vi.advanceTimersByTimeAsync(0))
      expect(screen.getByText(channel.title)).toBeTruthy()
      await act(async () => vi.advanceTimersByTimeAsync(5_000))
      expect(screen.getByRole('heading', { name: '连接到 Pegas' })).toBeTruthy()
      fireEvent.change(screen.getByLabelText('访问令牌'), {
        target: { value: 'invalid-replacement' },
      })
      fireEvent.click(screen.getByRole('button', { name: /继续/ }))
      await act(async () => Promise.resolve())
      expect(screen.getByRole('heading', { name: '连接到 Pegas' })).toBeTruthy()
      expect(screen.queryByText(channel.title)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows completed work by default under all work', async () => {
    installSnapshotFetch({
      ...snapshot,
      channels: [{ ...channel, status: 'completed' }],
      runs: [{ ...run, status: 'completed', output: '默认即可见的结果' }],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /所有事情/,
      }),
    )
    const list = screen.getByLabelText('事情列表')
    expect(within(list).getByText(channel.title)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: '全部' }).getAttribute('aria-pressed'),
    ).toBe('true')
    expect(screen.queryByText('这里还没有事情')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '进行中' }))
    expect(screen.getByText('当前筛选下没有事情')).toBeTruthy()
  })

  it('moves global search focus with arrow keys', async () => {
    installFetch()
    render(<App />)
    const trigger = await screen.findByRole('button', { name: '全局搜索' })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '全局搜索' })
    const input = within(dialog).getByRole('textbox', { name: '搜索事情' })
    const result = within(dialog).getByRole('button', {
      name: /安全自更新流程/,
    })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(result)
    fireEvent.keyDown(result, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(input)
  })

  it('makes the background inert while a modal is open', async () => {
    installFetch()
    render(<App />)
    const trigger = await screen.findByRole('button', { name: '全局搜索' })
    fireEvent.click(trigger)
    expect(document.querySelector<HTMLElement>('.app-shell')?.inert).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '关闭搜索' }))
    await waitFor(() =>
      expect(document.querySelector<HTMLElement>('.app-shell')?.inert).toBe(
        false,
      ),
    )
  })

  it('filters important results and marks them as results', async () => {
    const source = snapshot.messages[0]
    if (!source) throw new Error('missing attention fixture')
    installSnapshotFetch({
      ...snapshot,
      messages: [
        {
          ...source,
          id: 'result-1',
          payload: { type: 'run.completed', text: '验收结果已生成' },
        },
        {
          ...source,
          id: 'failed-1',
          payload: { type: 'run.failed', error: '执行失败原因' },
        },
      ],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    expect(document.querySelector('.attention-icon.is-result')).toBeTruthy()
    expect(document.querySelector('.attention-icon.is-failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重要结果 1' }))
    expect(screen.getByText('验收结果已生成')).toBeTruthy()
    expect(screen.queryByText('执行失败原因')).toBeNull()
  })

  it('labels long user messages as messages, not replies', async () => {
    const longText = '这是一条很长的用户输入。'.repeat(60)
    const userEvent = snapshot.events[0]
    if (!userEvent) throw new Error('missing user event fixture')
    installSnapshotFetch({
      ...snapshot,
      events: [{ ...userEvent, payload: { text: longText } }],
    })
    render(<App />)
    const expand = await screen.findByRole('button', {
      name: '展开完整消息',
    })
    expect(screen.queryByRole('button', { name: '展开完整回复' })).toBeNull()
    fireEvent.click(expand)
    expect(screen.getByRole('button', { name: '收起回复' })).toBeTruthy()
  })

  it('expands long drawer results and timeline entries on demand', () => {
    const longOutput = '长结果段落。'.repeat(120)
    const userEvent = snapshot.events[0]
    if (!userEvent) throw new Error('missing user event fixture')
    render(
      <DetailDrawer
        onChange={vi.fn()}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        view={{
          kind: 'task',
          channel: { ...channel, status: 'completed' },
          run: { ...run, status: 'completed', output: longOutput },
          timeline: {
            channel,
            events: [{ ...userEvent, payload: { text: longOutput } }],
            messages: [],
            runs: [],
          },
        }}
      />,
    )
    const expandResult = screen.getByRole('button', {
      name: '展开完整结果',
    })
    fireEvent.click(expandResult)
    expect(screen.getByText(longOutput)).toBeTruthy()
    expect(screen.getByRole('button', { name: '收起结果' })).toBeTruthy()
    const timelineExpand = screen.getByRole('button', {
      name: '展开完整消息',
    })
    fireEvent.click(timelineExpand)
    expect(screen.getAllByText(longOutput).length).toBeGreaterThan(1)
  })

  it('reports configured providers as configured until a test succeeds', async () => {
    installFetch()
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: '设置',
      }),
    )
    fireEvent.click(
      within(screen.getByLabelText('设置分类')).getByRole('button', {
        name: '模型服务',
      }),
    )
    expect((await screen.findAllByText('已配置')).length).toBeGreaterThan(0)
    expect(screen.queryByText('连接正常')).toBeNull()
  })

  it('lists server automations with truthful metrics and pauses them', async () => {
    let automation = {
      id: 'auto-1',
      userId: 'owner',
      revision: 1,
      title: '晨间简报',
      prompt: '整理今天需要处理的事情。',
      schedule: { kind: 'interval', everySeconds: 3600 },
      target: { kind: 'new_task' },
      status: 'active',
      nextFireAt: '2026-11-21T09:00:00.000Z',
      createdAt: '2026-11-21T08:00:00.000Z',
      updatedAt: '2026-11-21T08:00:00.000Z',
    }
    const fetchMock = installSnapshotFetch(snapshot, (path, init) => {
      if (path === '/v1/automations?userId=owner')
        return Response.json({ automations: [automation] })
      if (path === '/v1/automations/auto-1/pause' && init?.method === 'POST') {
        const body = JSON.parse(
          typeof init.body === 'string' ? init.body : '{}',
        ) as {
          expectedRevision: number
        }
        expect(body.expectedRevision).toBe(1)
        automation = { ...automation, status: 'paused', revision: 2 }
        return Response.json({ automation })
      }
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: '自动化',
      }),
    )
    expect(await screen.findByText('晨间简报')).toBeTruthy()
    expect(screen.queryByText('自动化能力正在建设')).toBeNull()
    const metric = (label: string) =>
      [...document.querySelectorAll('.metric-strip span')]
        .find(element => element.textContent.includes(label))
        ?.querySelector('b')?.textContent
    expect(metric('已启用')).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    await waitFor(() => expect(metric('已暂停')).toBe('1'))
    expect(
      fetchMock.mock.calls.some(
        ([path]) => path === '/v1/automations/auto-1/pause',
      ),
    ).toBe(true)
  })

  it('creates an automation through the server command contract', async () => {
    let created: unknown
    const automations: unknown[] = []
    const fetchMock = installSnapshotFetch(snapshot, (path, init) => {
      if (path === '/v1/automations?userId=owner')
        return Response.json({ automations })
      if (path === '/v1/automations' && init?.method === 'POST') {
        created = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
        const automation = {
          id: 'auto-new',
          userId: 'owner',
          revision: 1,
          title: '每周回顾',
          prompt: '回顾本周完成的事情。',
          schedule: { kind: 'interval', everySeconds: 3600 },
          target: { kind: 'new_task' },
          status: 'active',
          createdAt: '2026-11-21T08:00:00.000Z',
          updatedAt: '2026-11-21T08:00:00.000Z',
        }
        automations.push(automation)
        return Response.json({ automation }, { status: 201 })
      }
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: '自动化',
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /新建自动化/ }))
    const dialog = screen.getByRole('dialog', { name: '新建自动化' })
    fireEvent.change(within(dialog).getByLabelText('名称'), {
      target: { value: '每周回顾' },
    })
    fireEvent.change(within(dialog).getByLabelText('意图'), {
      target: { value: '回顾本周完成的事情。' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(created).toBeTruthy())
    const command = created as {
      userId: string
      commandId: string
      automation: { title: string; schedule: { everySeconds: number } }
    }
    expect(command.userId).toBe('owner')
    expect(command.commandId).toBeTruthy()
    expect(command.automation.title).toBe('每周回顾')
    expect(command.automation.schedule.everySeconds).toBe(3600)
    expect(await screen.findByText('每周回顾')).toBeTruthy()
    expect(fetchMock).toBeTruthy()
  })

  it('lists server memories with scope filters and deletes with revision', async () => {
    let memories: unknown[] = [
      {
        id: 'mem-1',
        userId: 'owner',
        scope: 'global',
        category: 'preference',
        content: '我喜欢安静、白底的界面。',
        source: { kind: 'user_confirmation' },
        revision: 3,
        createdAt: '2026-11-21T08:00:00.000Z',
        updatedAt: '2026-11-21T08:00:00.000Z',
        lastUsedAt: '2026-11-21T08:30:00.000Z',
      },
    ]
    let deleted: unknown
    installSnapshotFetch(snapshot, (path, init) => {
      if (path.startsWith('/v1/memories?')) return Response.json({ memories })
      if (path === '/v1/memories/mem-1/delete' && init?.method === 'POST') {
        deleted = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
        memories = []
        return Response.json({
          deletion: { id: 'mem-1', deleted: true, deletedAt: 'now' },
        })
      }
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: '记忆',
      }),
    )
    expect(await screen.findByText('我喜欢安静、白底的界面。')).toBeTruthy()
    expect(screen.queryByText('记忆能力正在建设')).toBeNull()
    expect(screen.getByText(/来源：用户确认/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '事情' }))
    expect(screen.getByText('该范围下还没有记忆')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    fireEvent.click(screen.getByRole('button', { name: /删除/ }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(deleted).toBeTruthy())
    expect((deleted as { expectedRevision: number }).expectedRevision).toBe(3)
    expect(await screen.findByText('还没有记忆')).toBeTruthy()
  })

  it('creates a global memory from the memory page form', async () => {
    let created: unknown
    const memories: unknown[] = []
    installSnapshotFetch(snapshot, (path, init) => {
      if (path.startsWith('/v1/memories?')) return Response.json({ memories })
      if (path === '/v1/memories' && init?.method === 'POST') {
        created = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
        const memory = {
          id: 'mem-new',
          userId: 'owner',
          scope: 'global',
          category: 'fact',
          content: '我的工作时间是上午。',
          source: { kind: 'user_confirmation' },
          revision: 1,
          createdAt: '2026-11-21T08:00:00.000Z',
          updatedAt: '2026-11-21T08:00:00.000Z',
        }
        memories.push(memory)
        return Response.json({ memory }, { status: 201 })
      }
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: '记忆',
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /添加记忆/ }))
    const dialog = screen.getByRole('dialog', { name: '添加记忆' })
    fireEvent.change(within(dialog).getByLabelText('内容'), {
      target: { value: '我的工作时间是上午。' },
    })
    fireEvent.change(within(dialog).getByLabelText('类别'), {
      target: { value: 'fact' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(created).toBeTruthy())
    const command = created as {
      memory: { scope: string; category: string; source: { kind: string } }
    }
    expect(command.memory.scope).toBe('global')
    expect(command.memory.category).toBe('fact')
    expect(command.memory.source.kind).toBe('user_confirmation')
    expect(await screen.findByText('我的工作时间是上午。')).toBeTruthy()
  })

  it('shows memory counts in settings and links to the memory page', async () => {
    installSnapshotFetch(snapshot, path => {
      if (path.startsWith('/v1/memories?'))
        return Response.json({
          memories: [
            {
              id: 'mem-1',
              userId: 'owner',
              scope: 'global',
              category: 'preference',
              content: '白底优先。',
              source: { kind: 'user_confirmation' },
              revision: 1,
              createdAt: '2026-11-21T08:00:00.000Z',
              updatedAt: '2026-11-21T08:00:00.000Z',
            },
          ],
        })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: '设置',
      }),
    )
    fireEvent.click(
      within(screen.getByLabelText('设置分类')).getByRole('button', {
        name: '记忆',
      }),
    )
    expect(await screen.findByText(/全局 1 条/)).toBeTruthy()
    expect(screen.queryByText('记忆服务尚未启用')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '管理记忆' }))
    expect(
      await screen.findByRole('heading', { name: '记忆', level: 1 }),
    ).toBeTruthy()
  })

  it('searches channels on the server and shows the match snippet', async () => {
    const fetchMock = installFetch()
    render(<App />)
    const trigger = await screen.findByRole('button', { name: '全局搜索' })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '全局搜索' })
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: '搜索事情' }),
      { target: { value: '安全' } },
    )
    expect(await within(dialog).findByText('搜索结果')).toBeTruthy()
    const result = await within(dialog).findByRole('button', {
      name: /安全自更新流程/,
    })
    expect(within(result).getByText(/服务端命中：/)).toBeTruthy()
    expect(
      fetchMock.mock.calls.some(
        ([path]) =>
          typeof path === 'string' && path.startsWith('/v1/channels/search?'),
      ),
    ).toBe(true)
    const searchCall = fetchMock.mock.calls.find(
      ([path]) =>
        typeof path === 'string' && path.startsWith('/v1/channels/search?'),
    )
    const searchUrl = new URL(
      typeof searchCall?.[0] === 'string' ? searchCall[0] : '',
      'http://localhost',
    )
    expect(searchUrl.searchParams.get('q')).toBe('安全')
    expect(searchUrl.searchParams.get('userId')).toBe('owner')
  })

  it('shows a retryable error when server search fails', async () => {
    let failures = 0
    installFetch(path => {
      if (path.startsWith('/v1/channels/search?')) {
        failures += 1
        if (failures === 1)
          return Response.json({ message: '搜索暂时不可用' }, { status: 500 })
        return Response.json({
          channels: snapshot.channels,
          matches: [],
        })
      }
      return undefined
    })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '全局搜索' }))
    const dialog = screen.getByRole('dialog', { name: '全局搜索' })
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: '搜索事情' }),
      { target: { value: '安全' } },
    )
    const alert = await within(dialog).findByRole('alert')
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }))
    expect(
      await within(dialog).findByRole('button', { name: /安全自更新流程/ }),
    ).toBeTruthy()
    expect(failures).toBe(2)
  })

  it('expands automation invocation history from the server', async () => {
    const automation = {
      id: 'auto-history',
      userId: 'owner',
      revision: 2,
      title: '晨间简报',
      prompt: '整理今天需要处理的事情。',
      schedule: { kind: 'interval', everySeconds: 3600 },
      target: { kind: 'new_task' },
      status: 'active',
      createdAt: '2026-11-21T08:00:00.000Z',
      updatedAt: '2026-11-21T09:00:00.000Z',
    }
    const fetchMock = installSnapshotFetch(snapshot, path => {
      if (path === '/v1/automations?userId=owner')
        return Response.json({ automations: [automation] })
      if (path.startsWith('/v1/automations/auto-history/invocations?'))
        return Response.json({
          invocations: [
            {
              id: 'inv-2',
              automationId: automation.id,
              userId: 'owner',
              scheduledFor: '2026-11-21T09:00:00.000Z',
              eventId: 'event-2',
              status: 'failed',
              attempts: 3,
              lastError: '目标事情已停止',
              createdAt: '2026-11-21T09:00:00.000Z',
              updatedAt: '2026-11-21T09:00:05.000Z',
            },
            {
              id: 'inv-1',
              automationId: automation.id,
              userId: 'owner',
              scheduledFor: '2026-11-21T08:00:00.000Z',
              eventId: 'event-1',
              status: 'dispatched',
              attempts: 1,
              createdAt: '2026-11-21T08:00:00.000Z',
              updatedAt: '2026-11-21T08:00:02.000Z',
            },
          ],
        })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: '自动化',
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: '触发记录' }))
    const history = await screen.findByLabelText('触发记录')
    expect(within(history).getByText('已派发')).toBeTruthy()
    expect(within(history).getByText('失败')).toBeTruthy()
    expect(within(history).getByText('目标事情已停止')).toBeTruthy()
    expect(within(history).getByText('尝试 3 次')).toBeTruthy()
    expect(
      fetchMock.mock.calls.some(
        ([path]) =>
          typeof path === 'string' &&
          path.startsWith('/v1/automations/auto-history/invocations?'),
      ),
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '触发记录' }))
    expect(screen.queryByLabelText('触发记录')).toBeNull()
  })

  it('reconciles an unknown action with a required note', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const approval: Approval = {
      ...approvalFixture('approval-reconcile'),
      status: 'approved',
      resolvedAt: '2026-11-21T00:02:00.000Z',
    }
    let action: DurableAction = {
      ...actionFixture(approval),
      status: 'unknown',
      result: { reason: '进程在网络请求后崩溃' },
    }
    let submitted: unknown
    const approvalMessage = {
      ...sourceMessage,
      payload: { type: 'approval.required', approvalId: approval.id },
    }
    installSnapshotFetch(
      { ...snapshot, messages: [approvalMessage] },
      (path, init) => {
        if (path.startsWith(`/v1/approvals/${approval.id}?`))
          return Response.json({ approval })
        if (path.startsWith(`/v1/actions/${approval.actionId}?`))
          return Response.json({ action })
        if (
          path === `/v1/actions/${approval.actionId}/reconcile` &&
          init?.method === 'POST'
        ) {
          submitted = JSON.parse(
            typeof init.body === 'string' ? init.body : '{}',
          )
          const draft = submitted as {
            commandId: string
            resolution: 'succeeded' | 'failed'
            note: string
          }
          action = {
            ...action,
            status: 'reconciled',
            result: { resolution: draft.resolution, note: draft.note },
            reconciliation: {
              id: 'recon-1',
              actionId: action.id,
              commandId: draft.commandId,
              resolution: draft.resolution,
              note: draft.note,
              previousStatus: 'unknown',
              reconciledBy: 'owner',
              createdAt: '2026-11-21T00:05:00.000Z',
            },
          }
          return Response.json({ action }, { status: 201 })
        }
        if (path.endsWith('/read'))
          return Response.json({
            message: { ...approvalMessage, readAt: '2026-11-21T00:01:00.000Z' },
          })
        return undefined
      },
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^查看内容：/ }))
    expect(await screen.findByText('结果未知，需核对')).toBeTruthy()
    const submit = screen.getByRole('button', { name: '提交核对结论' })
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /确认已失败/ }))
    fireEvent.change(screen.getByLabelText('核对依据（必填）'), {
      target: { value: '已在外部系统核实：转账没有发生。' },
    })
    fireEvent.click(submit)
    await waitFor(() => expect(submitted).toBeTruthy())
    const command = submitted as {
      userId: string
      commandId: string
      resolution: string
      note: string
    }
    expect(command.userId).toBe('owner')
    expect(command.commandId).toBeTruthy()
    expect(command.resolution).toBe('failed')
    expect(command.note).toBe('已在外部系统核实：转账没有发生。')
    expect(await screen.findByText('人工核对：确认已失败')).toBeTruthy()
    expect(screen.getByText('核对前状态：结果未知')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '提交核对结论' })).toBeNull()
  })

  it('does not offer reconciliation for a succeeded action', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const approval: Approval = {
      ...approvalFixture('approval-succeeded'),
      status: 'approved',
      resolvedAt: '2026-11-21T00:02:00.000Z',
    }
    const approvalMessage = {
      ...sourceMessage,
      payload: { type: 'approval.required', approvalId: approval.id },
    }
    installSnapshotFetch({ ...snapshot, messages: [approvalMessage] }, path => {
      if (path.startsWith(`/v1/approvals/${approval.id}?`))
        return Response.json({ approval })
      if (path.startsWith(`/v1/actions/${approval.actionId}?`))
        return Response.json({
          action: { ...actionFixture(approval), status: 'succeeded' },
        })
      if (path.endsWith('/read'))
        return Response.json({
          message: { ...approvalMessage, readAt: '2026-11-21T00:01:00.000Z' },
        })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^查看内容：/ }))
    expect(await screen.findByText('执行成功')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '提交核对结论' })).toBeNull()
    expect(screen.queryByText('人工核对结论')).toBeNull()
  })

  it('opens the reconciliation drawer from an action notice and submits', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    let action: DurableAction = {
      ...actionFixture(approvalFixture('approval-notice')),
      status: 'unknown',
      result: { providerRequestId: 'req-unknown' },
    }
    const notice = {
      ...sourceMessage,
      id: 'notice-reconcile',
      payload: {
        type: 'action.reconciliation_required',
        actionId: action.id,
      },
    }
    let submitted: unknown
    installSnapshotFetch({ ...snapshot, messages: [notice] }, (path, init) => {
      if (path.startsWith(`/v1/actions/${action.id}?`))
        return Response.json({ action })
      if (
        path === `/v1/actions/${action.id}/reconcile` &&
        init?.method === 'POST'
      ) {
        submitted = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
        const draft = submitted as {
          commandId: string
          resolution: 'succeeded' | 'failed'
          note: string
        }
        action = {
          ...action,
          status: 'reconciled',
          reconciliation: {
            id: 'recon-notice',
            actionId: action.id,
            commandId: draft.commandId,
            resolution: draft.resolution,
            note: draft.note,
            previousStatus: 'unknown',
            reconciledBy: 'owner',
            createdAt: '2026-11-21T00:06:00.000Z',
          },
        }
        return Response.json({ action }, { status: 201 })
      }
      if (path.endsWith('/read'))
        return Response.json({
          message: { ...notice, readAt: '2026-11-21T00:01:00.000Z' },
        })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^去核对：/ }))
    expect(await screen.findByText('高风险动作需要人工核对')).toBeTruthy()
    expect(screen.getByText('结果未知，需核对')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('核对依据（必填）'), {
      target: { value: '供应商后台确认请求已成功落地。' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提交核对结论' }))
    await waitFor(() => expect(submitted).toBeTruthy())
    expect((submitted as { resolution: string }).resolution).toBe('succeeded')
    expect(await screen.findByText('人工核对：确认已成功')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '提交核对结论' })).toBeNull()
  })

  it('shows goal, review pack criteria, and the evidence gallery in the task drawer', async () => {
    installFetch(path =>
      path.startsWith('/v1/tasks/task-1/delivery?')
        ? Response.json(deliveryFixture)
        : undefined,
    )
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    expect(await screen.findByText('目标与交付')).toBeTruthy()
    expect(
      screen.getByText('发布经过验证的候选版本，失败时自动回滚'),
    ).toBeTruthy()
    expect(screen.getByText('不做：不修改生产数据库结构')).toBeTruthy()
    expect(screen.getByText(/部分完成 · 按 2 条完成标准审查/)).toBeTruthy()
    const criteria = screen.getByLabelText('完成标准')
    expect(
      within(criteria).getByText('候选版本通过健康检查并留存截图'),
    ).toBeTruthy()
    expect(within(criteria).getAllByText('已满足').length).toBe(1)
    expect(within(criteria).getAllByText('未验证').length).toBe(1)
    expect(screen.getByText('剩余风险：回滚路径未经过真实演练')).toBeTruthy()
    const gallery = screen.getByLabelText('证据画廊')
    const card = within(gallery).getByRole('button', {
      name: /候选版本健康检查截图/,
    })
    expect(within(card).getByText('已通过')).toBeTruthy()
    fireEvent.click(card)
    const previewImage = await screen.findByAltText('候选版本健康检查截图')
    expect(previewImage.getAttribute('src')).toBe(
      '/v1/evidence/evidence-1/content?userId=owner',
    )
    fireEvent.click(screen.getByRole('button', { name: '返回交付审查' }))
    expect(await screen.findByText('目标与交付')).toBeTruthy()
    expect(screen.getByLabelText('证据画廊')).toBeTruthy()
  })

  it('surfaces a delivery fetch failure without hiding the task drawer', async () => {
    installFetch(path =>
      path.startsWith('/v1/tasks/task-1/delivery?')
        ? Response.json({ message: '读取交付失败' }, { status: 500 })
        : undefined,
    )
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    expect(await screen.findByText('目标与交付')).toBeTruthy()
    expect(await screen.findByText('读取交付失败')).toBeTruthy()
    expect(screen.getByText('Channel 时间线')).toBeTruthy()
  })

  it('opens the review drawer from a review.ready attention message', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const reviewMessage = {
      ...sourceMessage,
      id: 'message-review',
      payload: {
        type: 'review.ready',
        taskId: channel.id,
        text: '候选版本已交付，请审查。',
        review: reviewProjectionFixture,
      },
    }
    installSnapshotFetch({ ...snapshot, messages: [reviewMessage] }, path =>
      path.startsWith('/v1/tasks/task-1/delivery?')
        ? Response.json(deliveryFixture)
        : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^审查交付：/ }))
    expect(await screen.findByText('按完成标准审查交付')).toBeTruthy()
    expect(
      screen.getByText(/部分完成：结论来自服务端 Review Pack/),
    ).toBeTruthy()
    const criteria = screen.getByLabelText('完成标准')
    expect(within(criteria).getByText('已满足')).toBeTruthy()
    expect(within(criteria).getByText('未验证')).toBeTruthy()
    expect(
      await within(criteria).findByText('候选版本通过健康检查并留存截图'),
    ).toBeTruthy()
    expect(screen.getByText('局限：缺少回滚演练证据')).toBeTruthy()
    expect(
      screen.getAllByText('回滚路径未经过真实演练').length,
    ).toBeGreaterThan(0)
    const gallery = screen.getByLabelText('证据画廊')
    fireEvent.click(
      within(gallery).getByRole('button', { name: /候选版本健康检查截图/ }),
    )
    expect(await screen.findByAltText('候选版本健康检查截图')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回交付审查' }))
    expect(await screen.findByText('按完成标准审查交付')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: '打开事情详情与审计时间线' }),
    )
    expect(await screen.findByText('Channel 时间线')).toBeTruthy()
  })

  it('opens clarification questions and continues the task from the drawer', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const clarificationMessage = {
      ...sourceMessage,
      id: 'message-clarification',
      payload: {
        type: 'goal.clarification_required',
        taskId: channel.id,
        questions: ['发布窗口是哪个时间段？', '允许影响哪些用户？'],
        text: '发布窗口是哪个时间段？\n允许影响哪些用户？',
      },
    }
    const fetchMock = installSnapshotFetch({
      ...snapshot,
      channels: [{ ...channel, statusReason: 'awaiting_goal_clarification' }],
      messages: [clarificationMessage],
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^去回答：/ }))
    expect(await screen.findByText('Pegas 需要先确认这些问题')).toBeTruthy()
    const questions = screen.getByLabelText('待澄清问题')
    expect(within(questions).getByText('发布窗口是哪个时间段？')).toBeTruthy()
    expect(within(questions).getByText('允许影响哪些用户？')).toBeTruthy()
    const drawer = screen.getByRole('dialog')
    fireEvent.click(within(drawer).getByRole('button', { name: '去回答' }))
    expect(await screen.findByText(/继续事情：/)).toBeTruthy()
    const composer = screen.getByLabelText('给 Pegas 发消息')
    fireEvent.change(composer, {
      target: { value: '今晚 22:00 发布，仅内部用户。' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path, init]) => {
          if (path !== '/v1/events' || init?.method !== 'POST') return false
          const body = JSON.parse(
            typeof init.body === 'string' ? init.body : '{}',
          ) as { payload?: { taskId?: string } }
          return body.payload?.taskId === channel.id
        }),
      ).toBe(true),
    )
  })

  it('shows an inline clarification card in the conversation while waiting', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const clarificationMessage = {
      ...sourceMessage,
      id: 'message-clarification-inline',
      payload: {
        type: 'goal.clarification_required',
        taskId: channel.id,
        questions: ['发布窗口是哪个时间段？'],
        text: '发布窗口是哪个时间段？',
      },
      projection: {
        lane: 'decide' as const,
        weight: 'card' as const,
        anchor: { taskId: channel.id, eventId: 'event-1' },
      },
    }
    installSnapshotFetch({
      ...snapshot,
      channels: [{ ...channel, statusReason: 'awaiting_goal_clarification' }],
      messages: [clarificationMessage],
    })
    render(<App />)
    const card = await screen.findByLabelText(/需要你补充：/)
    expect(card.textContent).toContain('发布窗口是哪个时间段？')
    fireEvent.click(screen.getByRole('button', { name: /去回答/ }))
    expect(await screen.findByText(/继续事情：/)).toBeTruthy()
  })

  it('hides the inline clarification card once the task no longer waits', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const clarificationMessage = {
      ...sourceMessage,
      id: 'message-clarification-resolved',
      payload: {
        type: 'goal.clarification_required',
        taskId: channel.id,
        questions: ['发布窗口是哪个时间段？'],
        text: '发布窗口是哪个时间段？',
      },
    }
    installSnapshotFetch({
      ...snapshot,
      messages: [clarificationMessage],
    })
    render(<App />)
    await screen.findByText('你的私人智能工作伙伴')
    expect(screen.queryByRole('button', { name: /去回答/ })).toBeNull()
  })

  it('shows a compact review card in the conversation for review.ready', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const reviewMessage = {
      ...sourceMessage,
      id: 'message-review-inline',
      payload: {
        type: 'review.ready',
        taskId: channel.id,
        text: '候选版本已交付，请审查。',
        review: reviewProjectionFixture,
      },
      projection: {
        lane: 'work' as const,
        weight: 'card' as const,
        anchor: { taskId: channel.id, eventId: 'event-1' },
      },
    }
    installSnapshotFetch({ ...snapshot, messages: [reviewMessage] })
    render(<App />)
    const card = await screen.findByLabelText(/交付可审查：/)
    expect(card.textContent).toContain('候选版本已交付，请审查。')
    fireEvent.click(screen.getByRole('button', { name: /审查交付/ }))
    expect(await screen.findByText('按完成标准审查交付')).toBeTruthy()
  })

  it('loads and saves quiet-hours notification preferences', async () => {
    let saved: unknown
    const fetchMock = installFetch((path, init) => {
      if (path === '/v1/settings/notifications' && init?.method === 'PUT') {
        saved = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
        const draft = saved as {
          quietStart?: string
          quietEnd?: string
          utcOffsetMinutes: number
        }
        return Response.json({
          preferences: {
            userId: 'owner',
            revision: 2,
            updatedAt: '2026-11-21T00:00:00.000Z',
            ...draft,
          },
        })
      }
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '通知' }))
    const enable = await screen.findByLabelText('启用免打扰')
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path]) =>
            typeof path === 'string' &&
            path.startsWith('/v1/settings/notifications?'),
        ),
      ).toBe(true),
    )
    fireEvent.click(enable)
    fireEvent.change(screen.getByLabelText('开始时间'), {
      target: { value: '22:30' },
    })
    fireEvent.change(screen.getByLabelText('结束时间'), {
      target: { value: '07:00' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存通知偏好' }))
    expect(await screen.findByText('通知静默时段已保存')).toBeTruthy()
    expect(saved).toMatchObject({
      userId: 'owner',
      expectedRevision: 1,
      quietStart: '22:30',
      quietEnd: '07:00',
    })
    expect((saved as { utcOffsetMinutes: number }).utcOffsetMinutes).toBe(
      -new Date().getTimezoneOffset() || 0,
    )
  })

  it('resolves an unknown outbox delivery from the attention drawer', async () => {
    const sourceMessage = snapshot.messages[0]
    if (!sourceMessage) throw new Error('Expected an outbox message fixture')
    const failedNotice = {
      ...sourceMessage,
      id: 'message-delivery-unknown',
      taskId: undefined,
      status: 'unknown' as const,
      lastError: 'SMTP 连接中断，投递结果未知',
      payload: { type: 'run.failed', error: '上游执行失败，通知投递结果未知' },
    }
    let submitted: unknown
    installSnapshotFetch(
      { ...snapshot, messages: [failedNotice] },
      (path, init) => {
        if (
          path === '/v1/outbox/message-delivery-unknown/resolve' &&
          init?.method === 'POST'
        ) {
          submitted = JSON.parse(
            typeof init.body === 'string' ? init.body : '{}',
          )
          return Response.json(
            {
              message: {
                ...failedNotice,
                status: 'sent',
                resolution: {
                  resolution: 'sent',
                  note: '已在邮箱收到这条通知',
                  previousStatus: 'unknown',
                  resolvedBy: 'owner',
                  createdAt: '2026-11-21T00:10:00.000Z',
                },
              },
            },
            { status: 201 },
          )
        }
        if (path.endsWith('/read'))
          return Response.json({
            message: { ...failedNotice, readAt: '2026-11-21T00:01:00.000Z' },
          })
        return undefined
      },
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /待你处理/,
      }),
    )
    expect(await screen.findByText('投递结果未知，待核对')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^核对投递：/ }))
    expect(await screen.findByText('核对真实投递结果')).toBeTruthy()
    expect(screen.getByText('SMTP 连接中断，投递结果未知')).toBeTruthy()
    const submit = screen.getByRole('button', { name: '提交投递核对' })
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('radio', { name: /确认已送达/ }))
    fireEvent.change(screen.getByLabelText('核对依据（必填）'), {
      target: { value: '已在邮箱收到这条通知' },
    })
    fireEvent.click(submit)
    await waitFor(() => expect(submitted).toBeTruthy())
    expect(submitted).toMatchObject({
      userId: 'owner',
      resolution: 'sent',
      note: '已在邮箱收到这条通知',
    })
    expect(await screen.findByText('人工核对：确认已送达')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '提交投递核对' })).toBeNull()
    expect(await screen.findByText('人工核对：已送达')).toBeTruthy()
  })

  it('saves a task-level worker profile override with revision guard', async () => {
    let submitted: unknown
    const fetchMock = installFetch((path, init) => {
      if (
        path === '/v1/tasks/task-1/worker-profile' &&
        init?.method === 'PUT'
      ) {
        submitted = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
        const draft = submitted as {
          expectedRevision: number
          modelMode: 'inherit' | 'override'
          modelProvider?: string
          modelName?: string
        }
        const profile = {
          id: 'worker-profile-1',
          taskId: 'task-1',
          revision: draft.expectedRevision + 1,
          modelMode: draft.modelMode,
          ...(draft.modelProvider
            ? { modelProvider: draft.modelProvider }
            : {}),
          ...(draft.modelName ? { modelName: draft.modelName } : {}),
          createdAt: '2026-11-19T08:00:00.000Z',
          updatedAt: '2026-11-21T00:00:00.000Z',
        }
        return Response.json({
          profile,
          effective: {
            profile,
            source: draft.modelMode === 'override' ? 'task' : 'global',
            modelMode: draft.modelMode === 'override' ? 'override' : 'profile',
            ...(draft.modelProvider
              ? { modelProvider: draft.modelProvider }
              : {}),
            ...(draft.modelName ? { modelName: draft.modelName } : {}),
            modelRef:
              draft.modelMode === 'override'
                ? `${String(draft.modelProvider)}/${String(draft.modelName)}`
                : 'profile',
          },
        })
      }
      return undefined
    })
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    expect(await screen.findByText('事情级执行设置')).toBeTruthy()
    expect(await screen.findByText('Pegas 全局设置')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('执行模型'), {
      target: { value: 'override' },
    })
    const modelPicker = await screen.findByLabelText('指定模型')
    await waitFor(() =>
      expect(modelPicker.querySelectorAll('option').length).toBeGreaterThan(1),
    )
    fireEvent.change(modelPicker, {
      target: { value: 'Magpie/gpt-6.1-sol' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存执行设置' }))
    expect(
      await screen.findByText('执行设置已保存，对后续运行生效。'),
    ).toBeTruthy()
    expect(submitted).toMatchObject({
      userId: 'owner',
      expectedRevision: 1,
      modelMode: 'override',
      modelProvider: 'Magpie',
      modelName: 'gpt-6.1-sol',
    })
    expect(screen.getByText('这件事情的覆盖设置')).toBeTruthy()
    expect(screen.getByText('v2')).toBeTruthy()
    expect(
      fetchMock.mock.calls.filter(
        ([path]) => path === '/v1/settings/agent-models',
      ).length,
    ).toBeGreaterThan(0)
  })

  it('saves a task-level execution pool and effort selection', async () => {
    let submitted: unknown
    installFetch((path, init) => {
      if (
        path === '/v1/tasks/task-1/worker-profile' &&
        init?.method === 'PUT'
      ) {
        submitted = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
        const draft = submitted as {
          expectedRevision: number
          modelMode: 'inherit' | 'override'
          pool?: string
          effort?: string
        }
        const profile = {
          id: 'worker-profile-1',
          taskId: 'task-1',
          revision: draft.expectedRevision + 1,
          modelMode: draft.modelMode,
          ...(draft.pool ? { pool: draft.pool } : {}),
          ...(draft.effort ? { effort: draft.effort } : {}),
          createdAt: '2026-11-19T08:00:00.000Z',
          updatedAt: '2026-11-22T00:00:00.000Z',
        }
        return Response.json({
          profile,
          effective: {
            profile,
            source: 'task',
            modelMode: 'override',
            modelProvider: 'magpie',
            modelName: 'flash',
            modelRef: 'magpie/flash',
            ...(draft.pool ? { pool: draft.pool } : {}),
            ...(draft.effort ? { effort: draft.effort } : {}),
          },
        })
      }
      return undefined
    })
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    expect(await screen.findByText('事情级执行设置')).toBeTruthy()
    fireEvent.change(await screen.findByLabelText('执行池'), {
      target: { value: 'fast' },
    })
    const effortSelect = screen.getByLabelText('推理档位')
    expect(effortSelect.tagName).toBe('SELECT')
    fireEvent.change(effortSelect, { target: { value: 'low' } })
    fireEvent.click(screen.getByRole('button', { name: '保存执行设置' }))
    expect(
      await screen.findByText('执行设置已保存，对后续运行生效。'),
    ).toBeTruthy()
    expect(submitted).toMatchObject({
      userId: 'owner',
      modelMode: 'inherit',
      pool: 'fast',
      effort: 'low',
    })
    expect(await screen.findByText('magpie/flash')).toBeTruthy()
  })

  it('creates a related task carrying the ended source context reference', async () => {
    const fetchMock = installSnapshotFetch({
      ...snapshot,
      channels: [{ ...channel, status: 'cancelled', canStop: false }],
      runs: [],
    })
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(await screen.findByRole('button', { name: '已归档' }))
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(channel.title) }),
    )
    fireEvent.click(await screen.findByRole('button', { name: '新建相关事情' }))
    expect(await screen.findByText(/新建相关事情，携带终态摘要/)).toBeTruthy()
    const composer = screen.getByLabelText('给 Pegas 发消息')
    fireEvent.change(composer, { target: { value: '基于它的结论继续做计划' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path, init]) => {
          if (path !== '/v1/events' || init?.method !== 'POST') return false
          const body = JSON.parse(
            typeof init.body === 'string' ? init.body : '{}',
          ) as { payload?: { sourceTaskId?: string; taskId?: string } }
          return (
            body.payload?.sourceTaskId === channel.id &&
            body.payload.taskId === undefined
          )
        }),
      ).toBe(true),
    )
    await waitFor(() =>
      expect(screen.queryByText(/新建相关事情，携带终态摘要/)).toBeNull(),
    )
  })

  it('shows live execution activity for the running Run in the drawer', async () => {
    installSnapshotFetch(
      {
        ...snapshot,
        messages: [
          ...snapshot.messages,
          {
            id: 'message-progress',
            userId: 'owner',
            taskId: channel.id,
            payload: {
              type: 'run.progress',
              taskId: channel.id,
              runId: 'run-1',
              toolCalls: 2,
              steps: 1,
              recent: ['调用工具 read', '完成第 1 步推理', '调用工具 test'],
              text: '执行中 · 工具调用 2 次 · 已完成 1 步推理',
            },
            status: 'pending',
            createdAt: '2026-11-19T08:02:30.000Z',
          },
        ],
      },
      path => {
        if (!path.startsWith('/v1/runs/run-1/activity?')) return undefined
        return Response.json({
          runId: 'run-1',
          taskId: channel.id,
          totalEntries: 4,
          truncated: false,
          entries: [
            {
              seq: 1,
              kind: 'tool_call',
              status: 'completed',
              callId: 'call-read',
              tool: 'read',
              label: 'read',
              detail: '{"path":"README.md"}\n[结果]\n# Pegas',
              semantic: {
                kind: 'file_read',
                path: 'README.md',
                preview: '# Pegas',
              },
              createdAt: '2026-11-19T08:02:10.000Z',
              updatedAt: '2026-11-19T08:02:12.000Z',
            },
            {
              seq: 2,
              kind: 'step',
              status: 'completed',
              step: 1,
              label: '第 1 步完成',
              createdAt: '2026-11-19T08:02:20.000Z',
              updatedAt: '2026-11-19T08:02:20.000Z',
            },
            {
              seq: 3,
              kind: 'tool_call',
              status: 'completed',
              callId: 'call-test',
              tool: 'test',
              label: 'test',
              detail: '{"command":"pnpm test"}\n[结果]\nall green',
              createdAt: '2026-11-19T08:02:25.000Z',
              updatedAt: '2026-11-19T08:02:28.000Z',
            },
            {
              seq: 4,
              kind: 'text',
              label: '进展说明',
              detail: '已读取文档，正在跑测试。',
              createdAt: '2026-11-19T08:02:29.000Z',
              updatedAt: '2026-11-19T08:02:29.000Z',
            },
          ],
        })
      },
    )
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(channel.title) }),
    )
    const drawer = await screen.findByRole('dialog', { name: '工作详情' })
    expect(
      (await within(drawer).findAllByText(/工具 2 次 · 1 步推理/)).length,
    ).toBeTruthy()
    expect(within(drawer).getByText(/累计用时 12s/)).toBeTruthy()
    fireEvent.click(
      within(drawer).getByText(/工作流程记录 · 工具 2 次 · 1 步推理/),
    )
    fireEvent.click(await within(drawer).findByText('已读取'))
    expect(within(drawer).getAllByText('README.md').length).toBeGreaterThan(0)
    expect(within(drawer).queryByText('第 1 步完成')).toBeNull()
    fireEvent.click(within(drawer).getByText('test'))
    expect(within(drawer).getByText(/pnpm test/)).toBeTruthy()
    expect(within(drawer).getByText('已读取文档，正在跑测试。')).toBeTruthy()
    expect(
      within(drawer).queryByText('执行中 · 工具调用 2 次 · 已完成 1 步推理'),
    ).toBeNull()
    expect(
      screen.queryByText('执行中 · 工具调用 2 次 · 已完成 1 步推理'),
    ).toBeNull()
  })

  it('batches consecutive semantic tool calls and renders shell/diff cards', async () => {
    const entries: RunActivityEntry[] = [
      {
        seq: 1,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-git',
        tool: 'bash',
        label: 'bash',
        semantic: {
          kind: 'shell',
          command: 'git status --short',
          output: ' M web/src/api.ts',
        },
        createdAt: '2026-11-19T08:00:10.000Z',
        updatedAt: '2026-11-19T08:00:12.000Z',
      },
      {
        seq: 2,
        kind: 'tool_call',
        status: 'error',
        callId: 'call-merge',
        tool: 'bash',
        label: 'bash',
        semantic: {
          kind: 'shell',
          command: 'git merge origin/main --no-edit',
          output: 'CONFLICT (content): Merge conflict in web/src/api.ts',
        },
        createdAt: '2026-11-19T08:00:14.000Z',
        updatedAt: '2026-11-19T08:00:16.000Z',
      },
      {
        seq: 3,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-read-a',
        tool: 'read',
        label: 'read',
        semantic: {
          kind: 'file_read',
          path: 'web/src/api.ts',
          lineCount: 96,
          preview: '74:   async linkPreview(url: string) {',
        },
        createdAt: '2026-11-19T08:00:18.000Z',
        updatedAt: '2026-11-19T08:00:19.000Z',
      },
      {
        seq: 4,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-read-b',
        tool: 'read',
        label: 'read',
        semantic: { kind: 'file_read', path: 'web/src/types.ts' },
        createdAt: '2026-11-19T08:00:20.000Z',
        updatedAt: '2026-11-19T08:00:21.000Z',
      },
      {
        seq: 5,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-edit',
        tool: 'edit',
        label: 'edit',
        semantic: {
          kind: 'file_edit',
          path: 'web/src/api.ts',
          mode: 'edit',
          additions: 2,
          deletions: 3,
          hunks: [
            {
              lines: [
                { type: 'del', text: '<<<<<<< HEAD' },
                { type: 'add', text: '  }' },
                { type: 'add', text: '' },
                {
                  type: 'context',
                  text: '  async runActivity(runId: string) {',
                },
                { type: 'del', text: '=======' },
                { type: 'del', text: '>>>>>>> origin/main' },
              ],
            },
          ],
        },
        createdAt: '2026-11-19T08:00:22.000Z',
        updatedAt: '2026-11-19T08:00:24.000Z',
      },
      {
        seq: 6,
        kind: 'tool_call',
        status: 'started',
        callId: 'call-smoke',
        tool: 'bash',
        label: 'bash',
        semantic: { kind: 'shell', command: 'pnpm smoke' },
        createdAt: '2026-11-19T08:00:26.000Z',
        updatedAt: '2026-11-19T08:00:26.000Z',
      },
    ]
    installSnapshotFetch(
      {
        ...snapshot,
        channels: [{ ...channel, status: 'completed', canStop: false }],
        runs: [{ ...run, status: 'completed', output: '合并完成。' }],
      },
      path => {
        if (!path.startsWith('/v1/runs/run-1/activity?')) return undefined
        return Response.json({
          runId: 'run-1',
          taskId: channel.id,
          totalEntries: entries.length,
          truncated: false,
          entries,
        })
      },
    )
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(channel.title) }),
    )
    const drawer = await screen.findByRole('dialog', { name: '工作详情' })
    fireEvent.click(await within(drawer).findByText(/工作流程记录/))
    const commandBatch = (
      await within(drawer).findByText('运行了 2 条命令')
    ).closest('details')
    if (!commandBatch) throw new Error('expected command batch')
    expect(
      within(commandBatch as HTMLElement).getByText(/1 条失败/),
    ).toBeTruthy()
    expect(within(drawer).getByText('读取了 2 个文件')).toBeTruthy()
    expect(within(drawer).getAllByText('已编辑').length).toBeGreaterThan(0)
    expect(within(drawer).getAllByText('+2').length).toBeGreaterThan(0)
    expect(within(drawer).getAllByText('-3').length).toBeGreaterThan(0)
    fireEvent.click(within(drawer).getByText(/运行了 2 条命令/))
    const mergeHeadline = within(commandBatch as HTMLElement)
      .getAllByText('git merge origin/main --no-edit')
      .at(-1)
    if (!mergeHeadline) throw new Error('expected merge headline')
    fireEvent.click(mergeHeadline)
    const shellCard = [
      ...(commandBatch as HTMLElement).querySelectorAll('.shell-card'),
    ].find(card => card.textContent.includes('CONFLICT'))
    if (!shellCard) throw new Error('expected merge shell card')
    expect(
      within(shellCard as HTMLElement).getByText(/CONFLICT \(content\)/),
    ).toBeTruthy()
    expect(within(shellCard as HTMLElement).getByText('失败')).toBeTruthy()
    const smokeHeadline = within(drawer).getAllByText('pnpm smoke')[0]
    if (!smokeHeadline) throw new Error('expected running shell headline')
    const runningRow = smokeHeadline.closest('details')
    if (!runningRow) throw new Error('expected running shell row')
    expect(runningRow.querySelector('.activity-spinner')).toBeTruthy()
    fireEvent.click(smokeHeadline)
    expect(within(runningRow as HTMLElement).getByText('执行中')).toBeTruthy()
    const editHeadline = within(drawer).getAllByText('已编辑')[0]
    if (!editHeadline) throw new Error('expected edit headline')
    fireEvent.click(editHeadline)
    const diffCard = drawer.querySelector('.diff-card')
    if (!diffCard) throw new Error('expected diff card')
    expect(diffCard.querySelectorAll('.diff-line.is-add').length).toBe(2)
    expect(diffCard.querySelectorAll('.diff-line.is-del').length).toBe(3)
    expect(diffCard.querySelectorAll('.diff-gutter').length).toBeGreaterThan(0)
    fireEvent.click(
      within(diffCard as HTMLElement).getByRole('button', {
        name: '复制 diff',
      }),
    )
    await waitFor(() =>
      expect(
        within(diffCard as HTMLElement).getByRole('button', { name: '已复制' }),
      ).toBeTruthy(),
    )
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('+  }'))
    expect(
      within(diffCard as HTMLElement).getByRole('status').textContent,
    ).toBe('已复制')
  })

  it('renders web citation cards and the agent-team control family', async () => {
    const entries: RunActivityEntry[] = [
      {
        seq: 1,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-search',
        tool: 'web_search',
        label: 'web_search',
        semantic: {
          kind: 'web',
          query: '成都 社保 补缴',
          queries: ['成都 社保 补缴', '养老保险 缴费 2026'],
          sources: [
            {
              url: 'http://sc.people.com.cn/a',
              title: '人民网',
              snippet: '缴费金额公布',
            },
            { url: 'https://cdhrss.chengdu.gov.cn/b' },
          ],
          sourcesTruncated: true,
          preview: 'Sources:\n- [人民网](http://sc.people.com.cn/a)',
        },
        createdAt: '2026-11-19T08:00:10.000Z',
        updatedAt: '2026-11-19T08:00:12.000Z',
      },
      {
        seq: 2,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-fetch',
        tool: 'web_fetch',
        label: 'web_fetch',
        semantic: {
          kind: 'web',
          url: 'https://example.com/a',
          statusCode: 200,
          preview: '# 标题',
        },
        createdAt: '2026-11-19T08:00:14.000Z',
        updatedAt: '2026-11-19T08:00:16.000Z',
      },
      {
        seq: 3,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-wait',
        tool: 'wait_agent',
        label: 'wait_agent',
        semantic: {
          kind: 'agent_control',
          action: 'wait',
          timeoutMs: 60_000,
          timedOut: false,
        },
        createdAt: '2026-11-19T08:00:18.000Z',
        updatedAt: '2026-11-19T08:00:20.000Z',
      },
      {
        seq: 4,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-msg',
        tool: 'send_message',
        label: 'send_message',
        semantic: {
          kind: 'agent_control',
          action: 'message',
          agent: 'count-tests',
          message: '请以 78 结束',
        },
        createdAt: '2026-11-19T08:00:22.000Z',
        updatedAt: '2026-11-19T08:00:24.000Z',
      },
      {
        seq: 5,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-list',
        tool: 'list_agents',
        label: 'list_agents',
        semantic: {
          kind: 'agent_control',
          action: 'list',
          agents: [
            { name: 'lead', status: 'running', description: 'root agent' },
            { name: 'count-tests', status: 'inactive' },
          ],
        },
        createdAt: '2026-11-19T08:00:26.000Z',
        updatedAt: '2026-11-19T08:00:28.000Z',
      },
    ]
    installSnapshotFetch(
      {
        ...snapshot,
        channels: [{ ...channel, status: 'completed', canStop: false }],
        runs: [{ ...run, status: 'completed', output: '调研完成。' }],
      },
      path => {
        if (!path.startsWith('/v1/runs/run-1/activity?')) return undefined
        return Response.json({
          runId: 'run-1',
          taskId: channel.id,
          totalEntries: entries.length,
          truncated: false,
          entries,
        })
      },
    )
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(channel.title) }),
    )
    const drawer = await screen.findByRole('dialog', { name: '工作详情' })
    fireEvent.click(await within(drawer).findByText(/工作流程记录/))
    expect(await within(drawer).findByText('访问了 2 个网页')).toBeTruthy()
    expect(within(drawer).getByText('协调了 3 次子 agent')).toBeTruthy()
    const searchHeadline = within(drawer).getAllByText('已搜索网页')[0]
    if (!searchHeadline) throw new Error('expected search headline')
    fireEvent.click(searchHeadline)
    const sourceLink = within(drawer).getByRole('link', { name: '人民网' })
    expect(sourceLink.getAttribute('href')).toBe('http://sc.people.com.cn/a')
    expect(sourceLink.getAttribute('rel')).toContain('noopener')
    expect(within(drawer).getByText('缴费金额公布')).toBeTruthy()
    expect(within(drawer).getByText('来源过多，仅保留前段引用。')).toBeTruthy()
    expect(within(drawer).getByText(/等 2 个查询/)).toBeTruthy()
    const fetchHeadline = within(drawer).getAllByText('已访问')[0]
    if (!fetchHeadline) throw new Error('expected fetch headline')
    fireEvent.click(fetchHeadline)
    expect(within(drawer).getByText('HTTP 200')).toBeTruthy()
    const waitHeadline = within(drawer).getAllByText('收到子 agent 消息')[0]
    if (!waitHeadline) throw new Error('expected wait headline')
    fireEvent.click(waitHeadline)
    expect(within(drawer).getByText('上限 60s')).toBeTruthy()
    expect(within(drawer).getByText('收到新消息')).toBeTruthy()
    const messageHeadline = within(drawer).getAllByText('已发消息给')[0]
    if (!messageHeadline) throw new Error('expected message headline')
    fireEvent.click(messageHeadline)
    expect(within(drawer).getByText('请以 78 结束')).toBeTruthy()
    const listHeadline = within(drawer).getAllByText('查看了子 agent')[0]
    if (!listHeadline) throw new Error('expected list headline')
    fireEvent.click(listHeadline)
    expect(within(drawer).getAllByText('count-tests').length).toBeGreaterThan(1)
    expect(within(drawer).getByText('root agent')).toBeTruthy()
    expect(drawer.querySelectorAll('.agent-status').length).toBe(2)
  })

  it('renders todo checklist cards and structured grep/glob hit cards', async () => {
    const entries: RunActivityEntry[] = [
      {
        seq: 1,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-todo',
        tool: 'todo_write',
        label: 'todo_write',
        semantic: {
          kind: 'todo',
          items: [
            { content: '读取现有实现', status: 'completed' },
            { content: '补齐语义投影', status: 'in_progress' },
            { content: '跑完整门禁', status: 'pending' },
          ],
        },
        createdAt: '2026-11-19T08:00:10.000Z',
        updatedAt: '2026-11-19T08:00:12.000Z',
      },
      {
        seq: 2,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-grep',
        tool: 'grep',
        label: 'grep',
        semantic: {
          kind: 'search',
          query: 'runActivity',
          path: 'web/src',
          include: '*.ts',
          shape: 'matches',
          total: 3,
          files: [
            {
              path: 'web/src/api.ts',
              matches: [
                { line: 12, text: 'async runActivity(runId: string) {' },
                { line: 40, text: 'return runActivity(id)' },
              ],
            },
            {
              path: 'web/src/types.ts',
              matches: [
                { line: 8, text: 'export interface RunActivityReport {' },
              ],
            },
          ],
        },
        createdAt: '2026-11-19T08:00:14.000Z',
        updatedAt: '2026-11-19T08:00:16.000Z',
      },
      {
        seq: 3,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-glob',
        tool: 'glob',
        label: 'glob',
        semantic: {
          kind: 'search',
          query: '**/*.test.ts',
          shape: 'paths',
          total: 412,
          resultTruncated: true,
          paths: ['test/a.test.ts', 'test/b.test.ts'],
        },
        createdAt: '2026-11-19T08:00:18.000Z',
        updatedAt: '2026-11-19T08:00:20.000Z',
      },
      {
        seq: 4,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-grep-empty',
        tool: 'grep',
        label: 'grep',
        semantic: {
          kind: 'search',
          query: 'missing-symbol',
          shape: 'matches',
          total: 0,
          files: [],
        },
        createdAt: '2026-11-19T08:00:22.000Z',
        updatedAt: '2026-11-19T08:00:24.000Z',
      },
    ]
    installSnapshotFetch(
      {
        ...snapshot,
        channels: [{ ...channel, status: 'completed', canStop: false }],
        runs: [{ ...run, status: 'completed', output: '完成。' }],
      },
      path => {
        if (!path.startsWith('/v1/runs/run-1/activity?')) return undefined
        return Response.json({
          runId: 'run-1',
          taskId: channel.id,
          totalEntries: entries.length,
          truncated: false,
          entries,
        })
      },
    )
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(channel.title) }),
    )
    const drawer = await screen.findByRole('dialog', { name: '工作详情' })
    fireEvent.click(await within(drawer).findByText(/工作流程记录/))
    const todoHeadline = await within(drawer).findByText('更新任务清单')
    expect(within(drawer).getByText(/1\/3 · 补齐语义投影/)).toBeTruthy()
    fireEvent.click(todoHeadline)
    expect(within(drawer).getByText('任务清单')).toBeTruthy()
    expect(within(drawer).getByText('1/3 已完成')).toBeTruthy()
    expect(within(drawer).getByText('读取现有实现')).toBeTruthy()
    expect(within(drawer).getByText('进行中')).toBeTruthy()
    expect(within(drawer).getByText('待办')).toBeTruthy()
    expect(drawer.querySelectorAll('.todo-list .is-completed').length).toBe(1)
    expect(drawer.querySelectorAll('.todo-list .is-in_progress').length).toBe(1)
    const grepHeadline = within(drawer).getAllByText('搜索命中')[0]
    if (!grepHeadline) throw new Error('expected grep headline')
    fireEvent.click(grepHeadline)
    expect(within(drawer).getByText('3 处命中')).toBeTruthy()
    expect(within(drawer).getByText('web/src/api.ts')).toBeTruthy()
    expect(
      within(drawer).getByText('async runActivity(runId: string) {'),
    ).toBeTruthy()
    expect(drawer.querySelectorAll('.search-file').length).toBe(2)
    expect(drawer.querySelectorAll('.search-line-number').length).toBe(3)
    const globHeadline = within(drawer).getAllByText('匹配了文件')[0]
    if (!globHeadline) throw new Error('expected glob headline')
    fireEvent.click(globHeadline)
    expect(within(drawer).getByText('412 个文件')).toBeTruthy()
    expect(within(drawer).getByText('test/a.test.ts')).toBeTruthy()
    expect(within(drawer).getByText('结果过多，仅保留前段命中。')).toBeTruthy()
    const emptyHeadline = within(drawer).getAllByText('没有命中')[0]
    if (!emptyHeadline) throw new Error('expected empty headline')
    fireEvent.click(emptyHeadline)
    expect(within(drawer).getByText('没有命中任何行。')).toBeTruthy()
  })

  it('folds consecutive todo snapshots and renders ask_user question rows', async () => {
    const todoItems = (
      active: number,
    ): Extract<RunActivityEntry['semantic'], { kind: 'todo' }>['items'] => [
      { content: '读取现有实现', status: 'completed' },
      {
        content: '补齐语义投影',
        status: active >= 1 ? 'completed' : 'in_progress',
      },
      {
        content: '跑完整门禁',
        status: active >= 1 ? 'in_progress' : 'pending',
      },
    ]
    const entries: RunActivityEntry[] = [
      {
        seq: 1,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-todo-1',
        tool: 'todo_write',
        label: 'todo_write',
        semantic: { kind: 'todo', items: todoItems(0) },
        createdAt: '2026-11-19T08:00:10.000Z',
        updatedAt: '2026-11-19T08:00:12.000Z',
      },
      {
        seq: 2,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-todo-2',
        tool: 'todo_write',
        label: 'todo_write',
        semantic: { kind: 'todo', items: todoItems(1) },
        createdAt: '2026-11-19T08:00:14.000Z',
        updatedAt: '2026-11-19T08:00:16.000Z',
      },
      {
        seq: 3,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-ask',
        tool: 'ask_user_question',
        label: 'ask_user_question',
        semantic: {
          kind: 'ask_user',
          questions: [
            {
              id: 'scope',
              question: '先做哪一部分？',
              header: '范围',
              options: [
                { label: '语义投影 (Recommended)', description: '先打通数据' },
                { label: '只做 UI' },
              ],
            },
            { id: 'confirm', question: '可以开始吗？' },
          ],
          answers: [
            { id: 'scope', selected: ['语义投影 (Recommended)'] },
            { id: 'confirm', selected: [], custom: '可以，注意门禁' },
          ],
        },
        createdAt: '2026-11-19T08:00:18.000Z',
        updatedAt: '2026-11-19T08:00:20.000Z',
      },
      {
        seq: 4,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-ask-pending',
        tool: 'ask_user_question',
        label: 'ask_user_question',
        semantic: {
          kind: 'ask_user',
          questions: [{ id: 'retry', question: '要重跑门禁吗？' }],
          pending: true,
        },
        createdAt: '2026-11-19T08:00:22.000Z',
        updatedAt: '2026-11-19T08:00:24.000Z',
      },
      {
        seq: 5,
        kind: 'tool_call',
        status: 'started',
        callId: 'call-ask-running',
        tool: 'ask_user_question',
        label: 'ask_user_question',
        semantic: {
          kind: 'ask_user',
          questions: [{ id: 'go', question: '现在合并吗？' }],
        },
        createdAt: '2026-11-19T08:00:26.000Z',
        updatedAt: '2026-11-19T08:00:26.000Z',
      },
    ]
    installSnapshotFetch(
      {
        ...snapshot,
        channels: [{ ...channel, status: 'completed', canStop: false }],
        runs: [{ ...run, status: 'completed', output: '完成。' }],
      },
      path => {
        if (!path.startsWith('/v1/runs/run-1/activity?')) return undefined
        return Response.json({
          runId: 'run-1',
          taskId: channel.id,
          totalEntries: entries.length,
          truncated: false,
          entries,
        })
      },
    )
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(channel.title) }),
    )
    const drawer = await screen.findByRole('dialog', { name: '工作详情' })
    fireEvent.click(await within(drawer).findByText(/工作流程记录/))
    const foldHeadline = (await within(drawer).findAllByText('更新任务清单'))[0]
    if (!foldHeadline) throw new Error('expected todo fold headline')
    expect(within(drawer).getByText(/2\/3 · 跑完整门禁/)).toBeTruthy()
    expect(drawer.querySelectorAll('.activity-todo-fold').length).toBe(1)
    fireEvent.click(foldHeadline)
    expect(within(drawer).getByText('2/3 已完成')).toBeTruthy()
    const historySummary = within(drawer).getByText(/历史快照 · 1 次更早写入/)
    fireEvent.click(historySummary)
    expect(within(drawer).getByText('1/3 已完成')).toBeTruthy()
    const askHeadline = within(drawer).getAllByText('你回答了提问')[0]
    if (!askHeadline) throw new Error('expected ask headline')
    expect(within(drawer).getByText('2/2 已答')).toBeTruthy()
    fireEvent.click(askHeadline)
    expect(within(drawer).getByText('先做哪一部分？')).toBeTruthy()
    expect(within(drawer).getByText('范围')).toBeTruthy()
    expect(drawer.querySelectorAll('.ask-options .is-selected').length).toBe(1)
    expect(within(drawer).getByText('回答：可以，注意门禁')).toBeTruthy()
    const pendingHeadline = within(drawer).getAllByText('提问待回答')[0]
    if (!pendingHeadline) throw new Error('expected pending headline')
    fireEvent.click(pendingHeadline)
    expect(within(drawer).getByText('超时未答，问题仍可回答')).toBeTruthy()
    const runningHeadline = within(drawer).getAllByText('正在等待你的回答')[0]
    if (!runningHeadline) throw new Error('expected running headline')
    fireEvent.click(runningHeadline)
    expect(within(drawer).getByText('等待回答中')).toBeTruthy()
  })

  it('renders run change summaries, image metadata, deliverables and lifecycle markers', async () => {
    const editEntry = (
      seq: number,
      path: string,
      additions: number,
      deletions: number,
    ): RunActivityEntry => ({
      seq,
      kind: 'tool_call',
      status: 'completed',
      callId: `call-edit-${String(seq)}`,
      tool: 'edit',
      label: 'edit',
      semantic: {
        kind: 'file_edit',
        path,
        mode: 'edit',
        additions,
        deletions,
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: [
              { type: 'del', text: 'old line' },
              { type: 'add', text: 'new line' },
            ],
          },
        ],
      },
      createdAt: '2026-11-19T08:00:10.000Z',
      updatedAt: '2026-11-19T08:00:12.000Z',
    })
    const entries: RunActivityEntry[] = [
      editEntry(1, 'web/src/api.ts', 2, 3),
      editEntry(2, 'web/src/types.ts', 5, 0),
      editEntry(3, 'web/src/api.ts', 1, 1),
      {
        seq: 4,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-image',
        tool: 'read_image',
        label: 'read_image',
        semantic: {
          kind: 'image',
          path: '/repo/assets/flow.png',
          mediaType: 'image/png',
          width: 1200,
          height: 800,
          bytes: 245_760,
          originalWidth: 2400,
          originalHeight: 1600,
        },
        createdAt: '2026-11-19T08:00:14.000Z',
        updatedAt: '2026-11-19T08:00:16.000Z',
      },
      {
        seq: 5,
        kind: 'step',
        status: 'completed',
        label: '上下文已压缩',
        meta: { kind: 'compaction', note: '自动触发' },
        createdAt: '2026-11-19T08:00:18.000Z',
        updatedAt: '2026-11-19T08:00:18.000Z',
      },
      {
        seq: 6,
        kind: 'tool_call',
        status: 'completed',
        callId: 'call-present',
        tool: 'present',
        label: 'present',
        semantic: {
          kind: 'delivery',
          files: [
            { path: 'output/report.md', description: '调研报告' },
            { path: 'output/summary.csv' },
          ],
        },
        createdAt: '2026-11-19T08:00:20.000Z',
        updatedAt: '2026-11-19T08:00:22.000Z',
      },
      {
        seq: 7,
        kind: 'step',
        status: 'completed',
        label: '用户插话，本次运行由后继接管',
        meta: { kind: 'steered', note: '改成对比团队版价格' },
        createdAt: '2026-11-19T08:00:24.000Z',
        updatedAt: '2026-11-19T08:00:24.000Z',
      },
    ]
    installSnapshotFetch(
      {
        ...snapshot,
        channels: [{ ...channel, status: 'completed', canStop: false }],
        runs: [{ ...run, status: 'completed', output: '完成。' }],
      },
      path => {
        if (!path.startsWith('/v1/runs/run-1/activity?')) return undefined
        return Response.json({
          runId: 'run-1',
          taskId: channel.id,
          totalEntries: entries.length,
          truncated: false,
          entries,
        })
      },
    )
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(channel.title) }),
    )
    const drawer = await screen.findByRole('dialog', { name: '工作详情' })
    fireEvent.click(await within(drawer).findByText(/工作流程记录/))
    const changesHeadline =
      await within(drawer).findByText(/本次运行修改了 2 个文件/)
    fireEvent.click(changesHeadline)
    expect(within(drawer).getByText('文件变更汇总')).toBeTruthy()
    const changesCard = drawer.querySelector('.changes-card')
    if (!changesCard) throw new Error('expected changes card')
    expect(
      within(changesCard as HTMLElement).getAllByText('web/src/api.ts').length,
    ).toBeGreaterThan(0)
    expect(
      within(changesCard as HTMLElement).getAllByText('+3').length,
    ).toBeGreaterThan(0)
    expect(
      within(changesCard as HTMLElement).getAllByText('-4').length,
    ).toBeGreaterThan(0)
    const imageHeadline = within(drawer).getAllByText('查看了图片')[0]
    if (!imageHeadline) throw new Error('expected image headline')
    fireEvent.click(imageHeadline)
    expect(
      within(drawer).getByText(/image\/png · 1200×800 px · 240\.0 KB/),
    ).toBeTruthy()
    expect(within(drawer).getByText(/由 2400×1600 px 原图缩小/)).toBeTruthy()
    expect(
      within(drawer).getByText('图片内容未随执行记录留存，此处仅展示元数据。'),
    ).toBeTruthy()
    expect(within(drawer).getByText('上下文已压缩')).toBeTruthy()
    expect(within(drawer).getByText(/自动触发/)).toBeTruthy()
    const deliveryHeadline = within(drawer).getAllByText('声明了交付物')[0]
    if (!deliveryHeadline) throw new Error('expected delivery headline')
    fireEvent.click(deliveryHeadline)
    expect(within(drawer).getByText('output/report.md')).toBeTruthy()
    expect(within(drawer).getByText('调研报告')).toBeTruthy()
    expect(within(drawer).getByText('output/summary.csv')).toBeTruthy()
    expect(
      within(drawer).getByText('用户插话，本次运行由后继接管'),
    ).toBeTruthy()
    expect(within(drawer).getByText(/改成对比团队版价格/)).toBeTruthy()
    expect(drawer.querySelectorAll('.activity-meta-row').length).toBe(2)
  })

  it('keeps honest fallbacks for legacy and unknown tool records', async () => {
    installSnapshotFetch(
      {
        ...snapshot,
        channels: [{ ...channel, status: 'completed', canStop: false }],
        runs: [{ ...run, status: 'completed', output: '完成。' }],
      },
      path => {
        if (!path.startsWith('/v1/runs/run-1/activity?')) return undefined
        return Response.json({
          runId: 'run-1',
          taskId: channel.id,
          totalEntries: 2,
          truncated: false,
          entries: [
            {
              seq: 1,
              kind: 'tool_call',
              status: 'completed',
              callId: 'call-legacy',
              tool: 'test',
              label: 'test',
              detail: '{"command":"pnpm test"}\n[结果]\nall green',
              createdAt: '2026-11-19T08:00:10.000Z',
              updatedAt: '2026-11-19T08:00:12.000Z',
            },
            {
              seq: 2,
              kind: 'tool_call',
              status: 'completed',
              callId: 'call-empty',
              tool: 'mystery',
              label: 'mystery',
              createdAt: '2026-11-19T08:00:14.000Z',
              updatedAt: '2026-11-19T08:00:16.000Z',
            },
          ],
        })
      },
    )
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(channel.title) }),
    )
    const drawer = await screen.findByRole('dialog', { name: '工作详情' })
    fireEvent.click(await within(drawer).findByText(/工作流程记录/))
    expect(within(drawer).queryByText(/运行了/)).toBeNull()
    fireEvent.click(await within(drawer).findByText('test'))
    expect(drawer.querySelector('.activity-raw')?.textContent).toContain(
      'pnpm test',
    )
    fireEvent.click(within(drawer).getByText('mystery'))
    expect(within(drawer).getByText('没有留存参数或输出。')).toBeTruthy()
  })

  it('renders collaboration relations in the task drawer', async () => {
    installFetch(path =>
      path.startsWith('/v1/channels/task-1/collaborations?')
        ? Response.json({
            relations: [
              {
                id: 'relation-1',
                commandId: 'cmd-relation-1',
                userId: 'owner',
                kind: 'delegate',
                status: 'completed',
                sourceTaskId: 'task-1',
                sourceRunId: 'run-1',
                rootRelationId: 'relation-1',
                depth: 0,
                targetTaskId: 'task-2',
                request: {
                  commandId: 'cmd-relation-1',
                  kind: 'delegate',
                  goal: '验证候选版本健康检查',
                  reason: '需要独立环境执行',
                  expectedOutput: '健康检查截图',
                  contextRefs: [],
                },
                result: {
                  outcome: 'completed',
                  summary: '健康检查通过',
                  targetRunId: 'run-2',
                },
                createdAt: '2026-11-20T00:00:00.000Z',
                updatedAt: '2026-11-20T00:05:00.000Z',
                settledAt: '2026-11-20T00:05:00.000Z',
              },
            ],
          })
        : undefined,
    )
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    expect(await screen.findByText('协作记录')).toBeTruthy()
    expect(screen.getByText('委派 · 已完成')).toBeTruthy()
    expect(screen.getByText('验证候选版本健康检查')).toBeTruthy()
    expect(screen.getByText(/结果：已完成 · 健康检查通过/)).toBeTruthy()
    expect(screen.getByText(/目标事情：task-2/)).toBeTruthy()
  })

  it('drills into goal and review pack history from the task drawer', async () => {
    const fetchMock = installFetch(path => {
      if (path.startsWith('/v1/tasks/task-1/delivery?'))
        return Response.json(deliveryFixture)
      if (path.startsWith('/v1/tasks/task-1/goals?'))
        return Response.json({
          contracts: [
            {
              ...goalFixture,
              id: 'goal-0',
              revision: 1,
              desiredOutcome: '先发布一个可回滚的候选版本',
            },
            goalFixture,
          ],
          current: goalFixture,
        })
      if (path.startsWith('/v1/tasks/task-1/review-packs?'))
        return Response.json({
          reviewPacks: [reviewPackFixture],
          current: reviewPackFixture,
        })
      return undefined
    })
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    expect(await screen.findByText('目标与交付')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看历史修订' }))
    expect(await screen.findByText('先发布一个可回滚的候选版本')).toBeTruthy()
    expect(screen.getByText('v2 · 当前')).toBeTruthy()
    expect(screen.getByText('Review Pack 历史')).toBeTruthy()
    expect(screen.getByText(/修订 1 · 目标 v2 · 部分完成/)).toBeTruthy()
    expect(
      fetchMock.mock.calls.some(
        ([path]) =>
          typeof path === 'string' &&
          path.startsWith('/v1/tasks/task-1/goals?'),
      ),
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '收起历史修订' }))
    expect(screen.queryByText('先发布一个可回滚的候选版本')).toBeNull()
  })

  it('filters server search by status, attention, worker and sort', async () => {
    const fetchMock = installFetch()
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '全局搜索' }))
    const dialog = screen.getByRole('dialog', { name: '全局搜索' })
    const endedFilter = within(dialog).getByRole('button', { name: '已结束' })
    fireEvent.click(endedFilter)
    expect(await within(dialog).findByText('没有匹配的事情')).toBeTruthy()
    expect(endedFilter.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(dialog).getByRole('button', { name: '进行中' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '需关注' }))
    fireEvent.change(within(dialog).getByLabelText('搜索排序'), {
      target: { value: 'created' },
    })
    fireEvent.change(within(dialog).getByLabelText('执行者筛选'), {
      target: { value: 'computer' },
    })
    expect(
      await within(dialog).findByRole('button', { name: /安全自更新流程/ }),
    ).toBeTruthy()
    const searchCalls = fetchMock.mock.calls
      .map(([path]) => path)
      .filter(
        (path): path is string =>
          typeof path === 'string' && path.startsWith('/v1/channels/search?'),
      )
    const lastUrl = new URL(searchCalls.at(-1) ?? '', 'http://localhost')
    expect(lastUrl.searchParams.get('ended')).toBe('false')
    expect(lastUrl.searchParams.get('needsAttention')).toBe('true')
    expect(lastUrl.searchParams.get('sort')).toBe('created')
    expect(lastUrl.searchParams.get('workerIconId')).toBe('computer')
    expect(lastUrl.searchParams.get('q')).toBeNull()
  })

  it('loads more search results with the server cursor', async () => {
    const secondChannel: WorkChannel = {
      ...channel,
      id: 'task-2',
      taskId: 'task-2',
      title: '整理季度汇报',
      goal: '汇总本季度关键结果',
    }
    const fetchMock = installFetch(path => {
      if (!path.startsWith('/v1/channels/search?')) return undefined
      const params = new URL(path, 'http://localhost').searchParams
      if (params.get('cursor'))
        return Response.json({
          channels: [secondChannel],
          matches: [],
        })
      return Response.json({
        channels: [channel],
        matches: [],
        nextCursor: 'task-1',
      })
    })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '全局搜索' }))
    const dialog = screen.getByRole('dialog', { name: '全局搜索' })
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: '搜索事情' }),
      { target: { value: '季度' } },
    )
    const loadMore = await within(dialog).findByRole('button', {
      name: '加载更多',
    })
    fireEvent.click(loadMore)
    expect(
      await within(dialog).findByRole('button', { name: /整理季度汇报/ }),
    ).toBeTruthy()
    expect(
      within(dialog).getByRole('button', { name: /安全自更新流程/ }),
    ).toBeTruthy()
    expect(
      within(dialog).queryByRole('button', { name: '加载更多' }),
    ).toBeNull()
    const cursorCall = fetchMock.mock.calls
      .map(([path]) => path)
      .find(
        (path): path is string =>
          typeof path === 'string' &&
          path.startsWith('/v1/channels/search?') &&
          path.includes('cursor=task-1'),
      )
    expect(cursorCall).toBeTruthy()
  })

  it('shows a retryable error when loading more search results fails', async () => {
    installFetch(path => {
      if (!path.startsWith('/v1/channels/search?')) return undefined
      const params = new URL(path, 'http://localhost').searchParams
      if (params.get('cursor'))
        return Response.json({ message: '翻页暂时不可用' }, { status: 500 })
      return Response.json({
        channels: [channel],
        matches: [],
        nextCursor: 'task-1',
      })
    })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '全局搜索' }))
    const dialog = screen.getByRole('dialog', { name: '全局搜索' })
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: '搜索事情' }),
      { target: { value: '安全' } },
    )
    fireEvent.click(
      await within(dialog).findByRole('button', { name: '加载更多' }),
    )
    const alert = await within(dialog).findByRole('alert')
    expect(within(alert).getByText(/翻页暂时不可用/)).toBeTruthy()
    expect(
      within(dialog).queryByRole('button', { name: /安全自更新流程/ }),
    ).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }))
    expect(
      await within(dialog).findByRole('button', { name: /安全自更新流程/ }),
    ).toBeTruthy()
  })

  it('drills into evidence records per goal revision with pagination', async () => {
    const fetchMock = installFetch(path => {
      if (path.startsWith('/v1/tasks/task-1/delivery?'))
        return Response.json(deliveryFixture)
      if (path.startsWith('/v1/tasks/task-1/goals?'))
        return Response.json({
          contracts: [goalFixture],
          current: goalFixture,
        })
      if (path.startsWith('/v1/tasks/task-1/review-packs?'))
        return Response.json({
          reviewPacks: [reviewPackFixture],
          current: reviewPackFixture,
        })
      if (path.startsWith('/v1/tasks/task-1/evidence?')) {
        const params = new URL(path, 'http://localhost').searchParams
        if (params.get('cursor'))
          return Response.json({
            evidence: [
              {
                id: 'evidence-old-2',
                goalRevision: 2,
                criterionId: 'criterion-rollback',
                kind: 'log',
                verification: { result: 'failed' },
                sensitivity: 'internal',
                capturedAt: '2026-11-20T00:01:00.000Z',
                limitations: ['缺少回滚演练'],
              },
            ],
          })
        return Response.json({
          evidence: [
            {
              id: 'evidence-old-1',
              goalRevision: 2,
              criterionId: 'criterion-verify',
              kind: 'screenshot',
              verification: { result: 'passed' },
              sensitivity: 'internal',
              capturedAt: '2026-11-20T00:03:00.000Z',
              limitations: [],
            },
          ],
          nextCursor: 'cursor-evidence-1',
        })
      }
      return undefined
    })
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    expect(await screen.findByText('目标与交付')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看历史修订' }))
    fireEvent.click(
      await screen.findByRole('button', { name: '查看证据记录 v2' }),
    )
    expect(await screen.findByText('screenshot · 已通过')).toBeTruthy()
    expect(
      screen.getByText(/标准 criterion-verify · 敏感级 internal/),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '加载更多证据' }))
    expect(await screen.findByText('log · 未通过')).toBeTruthy()
    expect(screen.getByText('局限：缺少回滚演练')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '加载更多证据' })).toBeNull()
    const evidenceCalls = fetchMock.mock.calls
      .map(([path]) => path)
      .filter(
        (path): path is string =>
          typeof path === 'string' &&
          path.startsWith('/v1/tasks/task-1/evidence?'),
      )
    expect(evidenceCalls.length).toBe(2)
    const firstUrl = new URL(evidenceCalls[0] ?? '', 'http://localhost')
    expect(firstUrl.searchParams.get('goalRevision')).toBe('2')
    const secondUrl = new URL(evidenceCalls[1] ?? '', 'http://localhost')
    expect(secondUrl.searchParams.get('cursor')).toBe('cursor-evidence-1')
    fireEvent.click(screen.getByRole('button', { name: '收起证据记录 v2' }))
    expect(screen.queryByText('screenshot · 已通过')).toBeNull()
  })

  it('shows an empty state and retry for revision evidence failures', async () => {
    let evidenceRequests = 0
    installFetch(path => {
      if (path.startsWith('/v1/tasks/task-1/delivery?'))
        return Response.json(deliveryFixture)
      if (path.startsWith('/v1/tasks/task-1/goals?'))
        return Response.json({
          contracts: [
            {
              ...goalFixture,
              id: 'goal-0',
              revision: 1,
              desiredOutcome: '先发布一个可回滚的候选版本',
            },
            goalFixture,
          ],
          current: goalFixture,
        })
      if (path.startsWith('/v1/tasks/task-1/review-packs?'))
        return Response.json({ reviewPacks: [] })
      if (path.startsWith('/v1/tasks/task-1/evidence?')) {
        const params = new URL(path, 'http://localhost').searchParams
        if (params.get('goalRevision') === '1')
          return Response.json({ evidence: [] })
        evidenceRequests += 1
        if (evidenceRequests === 1)
          return Response.json({ message: '证据服务暂不可用' }, { status: 500 })
        return Response.json({
          evidence: [
            {
              id: 'evidence-retry',
              goalRevision: 2,
              criterionId: 'criterion-verify',
              kind: 'report',
              verification: { result: 'pending' },
              sensitivity: 'internal',
              capturedAt: '2026-11-20T00:03:00.000Z',
              limitations: [],
            },
          ],
        })
      }
      return undefined
    })
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    expect(await screen.findByText('目标与交付')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看历史修订' }))
    fireEvent.click(
      await screen.findByRole('button', { name: '查看证据记录 v1' }),
    )
    expect(await screen.findByText('这个修订还没有证据记录。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看证据记录 v2' }))
    const alert = await screen.findByText(/证据服务暂不可用/)
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByText('report · 待验证')).toBeTruthy()
  })

  it('jumps from a collaboration card to the target task drawer', async () => {
    const targetChannel: WorkChannel = {
      ...channel,
      id: 'task-2',
      taskId: 'task-2',
      title: '候选版本健康检查',
      goal: '在独立环境验证候选版本',
      status: 'completed',
      canResume: true,
      canStop: false,
    }
    const fetchMock = installFetch(path => {
      if (path.startsWith('/v1/channels/task-1/collaborations?'))
        return Response.json({
          relations: [
            {
              id: 'relation-1',
              commandId: 'cmd-relation-1',
              userId: 'owner',
              kind: 'delegate',
              status: 'completed',
              sourceTaskId: 'task-1',
              sourceRunId: 'run-1',
              rootRelationId: 'relation-1',
              depth: 0,
              targetTaskId: 'task-2',
              request: {
                commandId: 'cmd-relation-1',
                kind: 'delegate',
                goal: '验证候选版本健康检查',
                reason: '需要独立环境执行',
                expectedOutput: '健康检查截图',
                contextRefs: [],
              },
              result: {
                outcome: 'completed',
                summary: '健康检查通过',
                targetRunId: 'run-2',
              },
              createdAt: '2026-11-20T00:00:00.000Z',
              updatedAt: '2026-11-20T00:05:00.000Z',
              settledAt: '2026-11-20T00:05:00.000Z',
            },
          ],
        })
      if (path.startsWith('/v1/channels/task-2/timeline?'))
        return Response.json({
          channel: targetChannel,
          events: [
            {
              ...snapshot.events[0],
              id: 'target-event-1',
              payload: { text: '目标事情的时间线内容' },
            },
          ],
          messages: [],
          runs: [],
        })
      return undefined
    })
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    expect(await screen.findByText('协作记录')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开目标事情' }))
    expect(
      await screen.findByRole('heading', { name: '候选版本健康检查' }),
    ).toBeTruthy()
    expect(await screen.findByText('目标事情的时间线内容')).toBeTruthy()
    expect(
      fetchMock.mock.calls.some(
        ([path]) =>
          typeof path === 'string' &&
          path.startsWith('/v1/channels/task-2/timeline?'),
      ),
    ).toBe(true)
  })

  it('shows a collaboration jump error without leaving the drawer', async () => {
    installFetch(path => {
      if (path.startsWith('/v1/channels/task-1/collaborations?'))
        return Response.json({
          relations: [
            {
              id: 'relation-1',
              commandId: 'cmd-relation-1',
              userId: 'owner',
              kind: 'delegate',
              status: 'active',
              sourceTaskId: 'task-1',
              sourceRunId: 'run-1',
              rootRelationId: 'relation-1',
              depth: 0,
              targetTaskId: 'task-missing',
              request: {
                commandId: 'cmd-relation-1',
                kind: 'delegate',
                goal: '验证候选版本健康检查',
                reason: '需要独立环境执行',
                expectedOutput: '健康检查截图',
                contextRefs: [],
              },
              createdAt: '2026-11-20T00:00:00.000Z',
              updatedAt: '2026-11-20T00:05:00.000Z',
            },
          ],
        })
      if (path.startsWith('/v1/channels/task-missing/timeline?'))
        return Response.json({ message: '目标事情不存在' }, { status: 404 })
      return undefined
    })
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    expect(await screen.findByText('协作记录')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开目标事情' }))
    expect(await screen.findByText(/目标事情不存在/)).toBeTruthy()
    expect(screen.getByText('Pegas 正在推进这件事')).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开目标事情' })).toBeTruthy()
  })

  it('nests child collaboration relations under their parent', async () => {
    installFetch(path => {
      if (path.startsWith('/v1/channels/task-1/collaborations?'))
        return Response.json({
          relations: [
            {
              id: 'relation-child',
              commandId: 'cmd-relation-child',
              userId: 'owner',
              kind: 'delegate',
              status: 'active',
              sourceTaskId: 'task-1',
              sourceRunId: 'run-1',
              parentRelationId: 'relation-root',
              rootRelationId: 'relation-root',
              depth: 1,
              targetTaskId: 'task-3',
              request: {
                commandId: 'cmd-relation-child',
                kind: 'delegate',
                goal: '子协作任务',
                reason: '需要再拆分',
                expectedOutput: '子任务结果',
                contextRefs: [],
              },
              createdAt: '2026-11-20T00:01:00.000Z',
              updatedAt: '2026-11-20T00:02:00.000Z',
            },
            {
              id: 'relation-root',
              commandId: 'cmd-relation-root',
              userId: 'owner',
              kind: 'delegate',
              status: 'active',
              sourceTaskId: 'task-1',
              sourceRunId: 'run-1',
              rootRelationId: 'relation-root',
              depth: 0,
              targetTaskId: 'task-2',
              request: {
                commandId: 'cmd-relation-root',
                kind: 'delegate',
                goal: '根协作任务',
                reason: '需要独立环境执行',
                expectedOutput: '根任务结果',
                contextRefs: [],
              },
              createdAt: '2026-11-20T00:00:00.000Z',
              updatedAt: '2026-11-20T00:05:00.000Z',
            },
          ],
        })
      return undefined
    })
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    expect(await screen.findByText('协作记录')).toBeTruthy()
    const rootItem = screen.getByText('根协作任务').closest('li')
    if (!rootItem) throw new Error('missing root collaboration item')
    expect(within(rootItem).getByText('子协作任务')).toBeTruthy()
    expect(within(rootItem).getByText(/第 1 层/)).toBeTruthy()
    const nestedList = rootItem.querySelector('.collaboration-list.is-nested')
    expect(nestedList).toBeTruthy()
  })

  it('submits trusted verification for pending evidence', async () => {
    let verified = false
    const pendingDelivery: TaskDelivery = {
      ...deliveryFixture,
      evidence: [
        {
          id: 'evidence-pending',
          criterionId: 'criterion-verify',
          kind: 'screenshot',
          artifactId: artifactFixture.id,
          verification: { result: 'pending' },
          sensitivity: 'internal',
          capturedAt: '2026-11-20T00:03:00.000Z',
          presentation: {},
          limitations: [],
        },
      ],
    }
    installFetch((path, init) => {
      if (path.startsWith('/v1/tasks/task-1/delivery?'))
        return Response.json(pendingDelivery)
      if (
        path === '/v1/evidence/evidence-pending/verify' &&
        init?.method === 'POST'
      ) {
        verified = true
        return Response.json({ evidence: {} })
      }
      return undefined
    })
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    expect(await screen.findByText('目标与交付')).toBeTruthy()
    expect(await screen.findByText('有 1 条证据等待可信验证。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /验证证据 evidence/ }))
    expect(
      await screen.findByText('已提交可信验证；刷新事情详情可查看最新结论。'),
    ).toBeTruthy()
    expect(verified).toBe(true)
  })

  it('lists registered execution nodes in the runtime drawer and settings', async () => {
    const nodes = [
      {
        id: 'node-1',
        label: 'mac-studio worker',
        capabilities: ['dsh', 'browser'],
        lastHeartbeatAt: new Date().toISOString(),
        createdAt: '2026-11-20T00:00:00.000Z',
      },
    ]
    installFetch(path =>
      path === '/v1/nodes' ? Response.json({ nodes }) : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: '查看运行时' }))
    expect(await screen.findByText('已注册执行节点')).toBeTruthy()
    expect(await screen.findByText('mac-studio worker')).toBeTruthy()
    expect(screen.getByText('dsh · browser')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }))
    fireEvent.click(screen.getByRole('button', { name: '能力与连接' }))
    expect(await screen.findByText('mac-studio worker')).toBeTruthy()
    expect(screen.getByText(/工具授权清单 API 尚未提供/)).toBeTruthy()
  })

  it('shows real recovery status with active and previous releases', async () => {
    const fetchMock = installFetch(path =>
      path === '/v1/recovery/status'
        ? Response.json({
            available: true,
            integrity: 'ok',
            source: 'primary',
            diagnostics: [],
            phase: 'stable',
            updatedAt: new Date().toISOString(),
            active: {
              id: 'release-2026-11-21',
              commit: '2ef1eac999',
              createdAt: '2026-11-21T00:00:00.000Z',
              compatibility: { minimumSchema: 1, maximumSchema: 30 },
            },
            previous: {
              id: 'release-2026-11-20',
              createdAt: '2026-11-20T00:00:00.000Z',
            },
          })
        : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(
      within(screen.getByLabelText('设置分类')).getByRole('button', {
        name: '数据与恢复',
      }),
    )
    expect(await screen.findByText('状态完好')).toBeTruthy()
    expect(screen.getByText(/release-2026-11-21 · 2ef1eac9/)).toBeTruthy()
    expect(screen.getByText('稳定')).toBeTruthy()
    expect(screen.getByText('v1–v30')).toBeTruthy()
    expect(screen.getByText('release-2026-11-20')).toBeTruthy()
    expect(screen.getByText(/pnpm backup/)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /导出数据（待服务端 API）/ }),
    ).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: /清除本机数据/ })).toHaveProperty(
      'disabled',
      true,
    )
    fireEvent.click(screen.getByRole('button', { name: '刷新恢复状态' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([path]) => path === '/v1/recovery/status')
          .length,
      ).toBeGreaterThanOrEqual(2),
    )
  })

  it('shows degraded recovery state from the last-known-good backup', async () => {
    installFetch(path =>
      path === '/v1/recovery/status'
        ? Response.json({
            available: true,
            integrity: 'degraded',
            source: 'backup',
            diagnostics: ['主状态文件校验失败，已使用备份。'],
            phase: 'stable',
            active: {
              id: 'release-good',
              createdAt: '2026-11-20T00:00:00.000Z',
            },
          })
        : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(
      within(screen.getByLabelText('设置分类')).getByRole('button', {
        name: '数据与恢复',
      }),
    )
    expect(await screen.findByText('降级运行')).toBeTruthy()
    expect(
      screen.getByText('last-known-good 备份（主状态文件损坏）'),
    ).toBeTruthy()
    expect(screen.getByText('主状态文件校验失败，已使用备份。')).toBeTruthy()
    expect(screen.getByText('没有可回滚的上一个版本')).toBeTruthy()
  })

  it('shows honest unavailable recovery diagnostics without fake actions', async () => {
    installFetch(path =>
      path === '/v1/recovery/status'
        ? Response.json({
            available: false,
            integrity: 'unavailable',
            source: 'none',
            diagnostics: ['无法连接独立恢复平面；Supervisor 可能未运行。'],
          })
        : undefined,
    )
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(
      within(screen.getByLabelText('设置分类')).getByRole('button', {
        name: '数据与恢复',
      }),
    )
    expect(await screen.findByText('状态不可用')).toBeTruthy()
    expect(
      screen.getByText('无法连接独立恢复平面；Supervisor 可能未运行。'),
    ).toBeTruthy()
    expect(screen.getByText(/恢复平面当前不可用/)).toBeTruthy()
    expect(screen.queryByText('当前版本')).toBeNull()
  })

  it('offers a retry when the recovery status request fails', async () => {
    let failures = 0
    installFetch(path => {
      if (path !== '/v1/recovery/status') return undefined
      failures += 1
      if (failures === 1)
        return Response.json({ message: '恢复状态读取失败' }, { status: 500 })
      return Response.json({
        available: false,
        integrity: 'unavailable',
        source: 'none',
        diagnostics: ['未配置独立恢复平面（PEGAS_RECOVERY_BASE_URL）。'],
      })
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(
      within(screen.getByLabelText('设置分类')).getByRole('button', {
        name: '数据与恢复',
      }),
    )
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(/恢复状态读取失败/)).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: '重新读取' }))
    expect(await screen.findByText('状态不可用')).toBeTruthy()
    expect(failures).toBe(2)
  })

  it('lists server work rules and toggles them with revision', async () => {
    let rules: unknown[] = [
      {
        id: 'rule-1',
        userId: 'owner',
        title: '发布前先说明回滚路径',
        content: '涉及发布操作时，先列出回滚路径。',
        enabled: true,
        revision: 2,
        createdAt: '2026-11-21T08:00:00.000Z',
        updatedAt: '2026-11-21T08:00:00.000Z',
      },
    ]
    let toggled: unknown
    installSnapshotFetch(snapshot, (path, init) => {
      if (path.startsWith('/v1/rules?')) return Response.json({ rules })
      if (path.startsWith('/v1/settings/behavior?'))
        return Response.json({
          preferences: {
            userId: 'owner',
            customInstructions: '',
            revision: 0,
            updatedAt: '2026-11-21T08:00:00.000Z',
          },
        })
      if (path === '/v1/rules/rule-1' && init?.method === 'PUT') {
        toggled = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
        rules = rules.map(rule => ({
          ...(rule as Record<string, unknown>),
          enabled: false,
          revision: 3,
        }))
        return Response.json({ rule: rules[0] })
      }
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(await screen.findByRole('tab', { name: '行为与规则' }))
    expect(await screen.findByText('发布前先说明回滚路径')).toBeTruthy()
    expect(screen.getByText('高风险外部操作必须确认')).toBeTruthy()
    expect(screen.queryByText(/规则服务尚未建立/)).toBeNull()
    fireEvent.click(screen.getByLabelText('停用规则：发布前先说明回滚路径'))
    await waitFor(() => expect(toggled).toBeTruthy())
    const command = toggled as {
      expectedRevision: number
      rule: { enabled: boolean }
    }
    expect(command.expectedRevision).toBe(2)
    expect(command.rule.enabled).toBe(false)
    expect(await screen.findByText('全局 · 停用')).toBeTruthy()
  })

  it('creates a work rule from the drawer and saves custom instructions', async () => {
    let created: unknown
    let behaviorSaved: unknown
    const rules: unknown[] = []
    let preferences = {
      userId: 'owner',
      customInstructions: '',
      revision: 0,
      updatedAt: '2026-11-21T08:00:00.000Z',
    }
    installSnapshotFetch(snapshot, (path, init) => {
      if (path.startsWith('/v1/rules?')) return Response.json({ rules })
      if (path.startsWith('/v1/settings/behavior?'))
        return Response.json({ preferences })
      if (path === '/v1/rules' && init?.method === 'POST') {
        created = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
        const rule = {
          id: 'rule-new',
          userId: 'owner',
          title: '产品设计优先给出具体界面方案',
          content: '涉及产品设计时，优先给出具体界面方案。',
          enabled: true,
          revision: 1,
          createdAt: '2026-11-21T08:00:00.000Z',
          updatedAt: '2026-11-21T08:00:00.000Z',
        }
        rules.push(rule)
        return Response.json({ rule }, { status: 201 })
      }
      if (path === '/v1/settings/behavior' && init?.method === 'PUT') {
        behaviorSaved = JSON.parse(
          typeof init.body === 'string' ? init.body : '{}',
        )
        preferences = {
          ...preferences,
          customInstructions: (behaviorSaved as { customInstructions: string })
            .customInstructions,
          revision: 1,
        }
        return Response.json({ preferences })
      }
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(await screen.findByRole('tab', { name: '行为与规则' }))
    fireEvent.click(await screen.findByRole('button', { name: /添加规则/ }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('规则名称'), {
      target: { value: '产品设计优先给出具体界面方案' },
    })
    fireEvent.change(within(dialog).getByLabelText('规则内容'), {
      target: { value: '涉及产品设计时，优先给出具体界面方案。' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存规则' }))
    await waitFor(() => expect(created).toBeTruthy())
    expect((created as { rule: { enabled: boolean } }).rule.enabled).toBe(true)
    expect(await screen.findByText('规则已保存，对后续执行生效。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }))
    expect(await screen.findByText('产品设计优先给出具体界面方案')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('自定义指令'), {
      target: { value: '发布前先列出回滚路径。' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存自定义指令' }))
    await waitFor(() => expect(behaviorSaved).toBeTruthy())
    expect(
      (behaviorSaved as { expectedRevision: number }).expectedRevision,
    ).toBe(0)
    expect(
      await screen.findByText('自定义指令已保存，对后续执行生效。'),
    ).toBeTruthy()
  })

  it('recovers from a rule revision conflict by reloading the latest state', async () => {
    let conflictHits = 0
    installSnapshotFetch(snapshot, (path, init) => {
      if (path.startsWith('/v1/rules?'))
        return Response.json({
          rules: [
            {
              id: 'rule-1',
              userId: 'owner',
              title: '发布前先说明回滚路径',
              content: '涉及发布操作时，先列出回滚路径。',
              enabled: conflictHits === 0,
              revision: conflictHits > 0 ? 5 : 2,
              createdAt: '2026-11-21T08:00:00.000Z',
              updatedAt: '2026-11-21T08:00:00.000Z',
            },
          ],
        })
      if (path.startsWith('/v1/settings/behavior?'))
        return Response.json({
          preferences: {
            userId: 'owner',
            customInstructions: '',
            revision: 0,
            updatedAt: '2026-11-21T08:00:00.000Z',
          },
        })
      if (path === '/v1/rules/rule-1' && init?.method === 'PUT') {
        conflictHits += 1
        return Response.json({ error: 'rule_conflict' }, { status: 409 })
      }
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(await screen.findByRole('tab', { name: '行为与规则' }))
    fireEvent.click(
      await screen.findByLabelText('停用规则：发布前先说明回滚路径'),
    )
    expect(
      await screen.findByText(/更新冲突：这条规则已在别处更新/),
    ).toBeTruthy()
    expect(conflictHits).toBe(1)
    expect(await screen.findByText('全局 · 停用')).toBeTruthy()
  })

  it('shows an honest error and retry when work rules fail to load', async () => {
    let failures = 0
    installSnapshotFetch(snapshot, path => {
      if (path.startsWith('/v1/rules?')) {
        failures += 1
        if (failures === 1)
          return Response.json({ message: '规则读取失败' }, { status: 500 })
        return Response.json({ rules: [] })
      }
      if (path.startsWith('/v1/settings/behavior?'))
        return Response.json({
          preferences: {
            userId: 'owner',
            customInstructions: '',
            revision: 0,
            updatedAt: '2026-11-21T08:00:00.000Z',
          },
        })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(await screen.findByRole('tab', { name: '行为与规则' }))
    const alerts = await screen.findAllByRole('alert')
    const alert = alerts[0]
    if (!alert) throw new Error('Expected a work rules error alert')
    expect(within(alert).getByText(/规则读取失败/)).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: '重新读取' }))
    await waitFor(() => expect(failures).toBe(2))
    expect(await screen.findByText(/还没有自定义工作规则/)).toBeTruthy()
  })

  it('uploads a selected attachment after sending the message', async () => {
    const fetchMock = installFetch((path, init) => {
      if (
        path.startsWith('/v1/events/event-new/attachments?') &&
        init?.method === 'POST'
      )
        return Response.json(
          {
            attachment: {
              id: 'attachment-1',
              userId: 'owner',
              eventId: 'event-new',
              fileName: 'plan.txt',
              mediaType: 'text/plain',
              byteSize: 12,
              sha256: 'hash-attachment-1',
              createdAt: '2026-11-21T00:00:00.000Z',
            },
          },
          { status: 201 },
        )
      return undefined
    })
    render(<App />)
    const composer = await screen.findByLabelText('给 Pegas 发消息')
    const fileInput = screen.getByLabelText('选择附件文件')
    const file = new File(['hello pegas!'], 'plan.txt', { type: 'text/plain' })
    fireEvent.change(fileInput, { target: { files: [file] } })
    expect(await screen.findByText(/附件：/)).toBeTruthy()
    expect(screen.getByText('plan.txt')).toBeTruthy()
    fireEvent.change(composer, { target: { value: '带上这份计划' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) =>
            typeof path === 'string' &&
            path.startsWith('/v1/events/event-new/attachments?') &&
            typeof path === 'string' &&
            path.includes('fileName=plan.txt') &&
            init?.method === 'POST' &&
            init.body === file,
        ),
      ).toBe(true),
    )
    expect(screen.queryByText(/附件：/)).toBeNull()
  })

  it('opens an uploaded attachment preview from the task timeline', async () => {
    const sourceEvent = snapshot.events[0]
    if (!sourceEvent) throw new Error('Expected an inbox event fixture')
    const eventWithAttachment = {
      ...sourceEvent,
      attachment: {
        id: 'attachment-1',
        userId: 'owner',
        eventId: sourceEvent.id,
        fileName: '架构草图.png',
        mediaType: 'image/png',
        byteSize: 2048,
        sha256: 'hash-attachment-1',
        createdAt: '2026-11-21T00:00:00.000Z',
      },
    }
    installSnapshotFetch({
      ...snapshot,
      events: [eventWithAttachment],
    })
    render(<App />)
    const mainNav = await screen.findByLabelText('主导航')
    fireEvent.click(within(mainNav).getByRole('button', { name: /所有事情/ }))
    fireEvent.click(screen.getByRole('button', { name: /安全自更新流程/ }))
    const attachmentButton = await screen.findByRole('button', {
      name: /架构草图.png/,
    })
    fireEvent.click(attachmentButton)
    const preview = await screen.findByAltText('架构草图.png')
    expect(preview.getAttribute('src')).toBe(
      '/v1/events/event-1/attachments?userId=owner',
    )
    fireEvent.click(screen.getByRole('button', { name: '返回工作详情' }))
    expect(await screen.findByText('Channel 时间线')).toBeTruthy()
  })

  it('sends recorded voice directly as a message in direct-send mode', async () => {
    class FakeMediaRecorder {
      static isTypeSupported() {
        return false
      }
      state: RecordingState = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((event: BlobEvent) => void) | null = null
      onerror: (() => void) | null = null
      onstop: (() => void) | null = null
      start() {
        this.state = 'recording'
      }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({
          data: new Blob(['voice-bytes'], { type: 'audio/webm' }),
        } as BlobEvent)
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }),
      },
    })
    let voicePath = ''
    const fetchMock = installFetch((path, init) => {
      if (path.startsWith('/v1/voice/messages?') && init?.method === 'POST') {
        voicePath = path
        return Response.json(
          {
            event: {
              id: 'event-voice',
              userId: 'owner',
              type: 'user.message',
              source: 'web',
              payload: { text: '帮我检查发布状态', inputMode: 'voice' },
              status: 'pending',
              createdAt: '2026-11-21T00:00:00.000Z',
            },
            inserted: true,
            transcript: { text: '帮我检查发布状态' },
          },
          { status: 202 },
        )
      }
      return undefined
    })
    render(<App />)
    await screen.findByLabelText('给 Pegas 发消息')
    const toggle = screen.getByRole('button', { name: '说完直接发送' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '停止录音' })).toBeTruthy(),
    )
    fireEvent.click(screen.getByRole('button', { name: '停止录音' }))
    await waitFor(() => expect(voicePath).toContain('/v1/voice/messages?'))
    expect(voicePath).toContain('source=web')
    expect(voicePath).toContain('language=zh')
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) =>
          typeof path === 'string' &&
          path.startsWith('/v1/voice/messages?') &&
          Boolean(
            (init?.headers as Record<string, string> | undefined)?.[
              'idempotency-key'
            ],
          ),
      ),
    ).toBe(true)
    expect(screen.getByLabelText('给 Pegas 发消息')).toHaveProperty('value', '')
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) => path === '/v1/events' && init?.method === 'POST',
      ),
    ).toBe(false)
  })
})
