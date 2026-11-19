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
  custom?: (path: string, init?: RequestInit) => Response | undefined,
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
          ],
        }),
      )
    if (path === '/v1/events' && init?.method === 'POST')
      return Promise.resolve(Response.json({ ok: true }))
    if (path === '/v1/settings' && init?.method === 'PUT')
      return Promise.resolve(
        Response.json({
          ...settingsResponse,
          settings: { ...settingsResponse.settings, revision: 2 },
        }),
      )
    if (path.includes('/read') || path.includes('/retry'))
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

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('sealed Pegas UI', () => {
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
    expect(
      within(dialog).getByPlaceholderText('搜索事情、消息或文件'),
    ).toBeTruthy()
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: '搜索事情、消息或文件' }),
      { target: { value: '不存在' } },
    )
    expect(within(dialog).getByText('没有匹配的事情')).toBeTruthy()
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: '搜索事情、消息或文件' }),
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

  it('switches appearance with semantic theme tokens', async () => {
    installFetch()
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '切换外观' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /深色/ }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('pegas-theme')).toBe('dark')
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

  it('edits and saves the active provider connection', async () => {
    const fetchMock = installFetch()
    render(<App />)
    fireEvent.click(
      within(await screen.findByLabelText('主导航')).getByRole('button', {
        name: /设置/,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: /模型服务/ }))
    fireEvent.change(screen.getByLabelText('服务地址'), {
      target: { value: 'https://new-provider.example/v1' },
    })
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
            init.body.includes('https://new-provider.example/v1'),
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

  it('sends a message and preserves the live API behavior', async () => {
    const fetchMock = installFetch()
    render(<App />)
    const composer = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(composer, { target: { value: '继续执行并报告结果' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/v1/events',
        expect.objectContaining({ method: 'POST' }),
      ),
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
