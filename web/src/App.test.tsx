// @vitest-environment jsdom

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
  Run,
  SettingsResponse,
  Snapshot,
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
      return Promise.resolve(Response.json({ ok: true }))
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
    expect(within(dialog).getByText('没有匹配的事情')).toBeTruthy()
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: '搜索事情' }),
      { target: { value: '安全' } },
    )
    fireEvent.click(
      within(dialog).getByRole('button', { name: /安全自更新流程/ }),
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
    fireEvent.click(screen.getByRole('tab', { name: '进行中' }))
    expect(within(list).queryByText(channel.title)).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '等待中' }))
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
    expect(screen.getByRole('button', { name: '查看原因' })).toBeTruthy()
    expect(screen.queryByText('传输失败但不是执行失败')).toBeNull()
    expect(screen.queryByRole('button', { name: '稍后处理' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '失败' }))
    expect(screen.getByText('执行确实失败')).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: '查看内容' }))
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
    fireEvent.click(screen.getByRole('button', { name: '查看内容' }))
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
    fireEvent.click(screen.getByRole('button', { name: '查看内容' }))
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
    fireEvent.click(screen.getByRole('button', { name: '查看内容' }))
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
    fireEvent.click(screen.getByRole('button', { name: '查看内容' }))
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
    fireEvent.click(screen.getByRole('button', { name: '查看内容' }))
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
      within(slowArticle).getByRole('button', { name: '查看内容' }),
    )
    fireEvent.click(
      within(fastArticle).getByRole('button', { name: '查看内容' }),
    )
    expect(
      await screen.findByRole('heading', { name: '快速审批' }),
    ).toBeTruthy()
    resolveFirst?.(Response.json({ approval: first }))
    await act(async () => Promise.resolve())
    expect(screen.getByRole('heading', { name: '快速审批' })).toBeTruthy()
    expect(
      screen.queryByRole('heading', { name: first.prompt.summary }),
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
      fireEvent.click(screen.getByRole('button', { name: '查看内容' }))
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
    expect(
      screen.getByRole('button', { name: '发送' }).getAttribute('type'),
    ).toBe('submit')
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
    fireEvent.click(screen.getByRole('tab', { name: '等待中' }))
    expect(screen.queryByText(channel.title)).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '已归档' }))
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
    const action = screen.getByRole('button', { name: '查看原因' })
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
    fireEvent.click(screen.getByRole('button', { name: '查看原因' }))
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
    fireEvent.click(screen.getByRole('button', { name: '查看原因' }))
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
    fireEvent.click(screen.getByRole('button', { name: '查看原因' }))
    expect(await screen.findByText('无法标记已读')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }))
    expect(screen.getByText('需要处理的失败')).toBeTruthy()
    expect(screen.getByText(/未读 · 来自/)).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: '查看原因' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '关闭详情' })).toBeTruthy(),
    )
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }))
    expect(screen.getByText('已读但仍需处理')).toBeTruthy()
    expect(screen.getByText(/已读 · 来自/)).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: '查看原因' }))
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
    fireEvent.click(screen.getByRole('button', { name: '查看原因' }))
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
    fireEvent.click(screen.getByRole('tab', { name: '已完成' }))
    const list = screen.getByLabelText('事情列表')
    expect(
      list.querySelector('use[href$="#pegas-agent-computer"]'),
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
    expect(screen.getByRole('tab', { name: '全部' }).ariaSelected).toBe('true')
    expect(screen.queryByText('这里还没有事情')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '进行中' }))
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
    fireEvent.click(screen.getByRole('tab', { name: '重要结果' }))
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
    fireEvent.click(screen.getByRole('tab', { name: '事情' }))
    expect(screen.getByText('该范围下还没有记忆')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '全部' }))
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
})
