// @vitest-environment jsdom

import {
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
import type { Run, SettingsResponse, Snapshot, WorkChannel } from './types'

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
    workerProfile: 'pegas',
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
    installFetch()
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
    expect(screen.getByText('pegas')).toBeTruthy()
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
    expect(screen.getByText(/Run · run-newe/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续追问' }))
    expect(screen.getByText(/继续事情：/)).toBeTruthy()

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
    expect(within(list).queryByText(channel.title)).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '等待中' }))
    expect(within(list).getByText(channel.title)).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: /继续/ }))
    expect(screen.getByText('连接模型服务')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /继续/ }))
    expect(screen.getByText('准备执行环境')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /继续/ }))
    expect(screen.getByText('语音与完成确认')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /进入 Pegas/ }))
    expect(onComplete).toHaveBeenCalledOnce()
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
})
