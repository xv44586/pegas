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
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { App, featuredModelProviderIds, formatRelativeTime } from './App'

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
)
const originalShowModal = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  'showModal',
)
const originalDialogClose = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  'close',
)

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '')
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    },
  })
})

afterAll(() => {
  if (originalScrollIntoView)
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollIntoView',
      originalScrollIntoView,
    )
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  if (originalShowModal)
    Object.defineProperty(
      HTMLDialogElement.prototype,
      'showModal',
      originalShowModal,
    )
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  if (originalDialogClose)
    Object.defineProperty(
      HTMLDialogElement.prototype,
      'close',
      originalDialogClose,
    )
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

describe('Pegas web app', () => {
  it('keeps Magpie first and Gemini behind the more-providers disclosure', () => {
    expect(featuredModelProviderIds).toEqual([
      'magpie',
      'openai',
      'anthropic',
      'deepseek',
      'ollama',
      'custom',
    ])
    expect(featuredModelProviderIds).not.toContain('google')
  })

  it('centralizes model, privacy, and rewriting choices in server settings', async () => {
    const settings = {
      revision: 1,
      routerMode: 'model' as const,
      modelProvider: 'openai' as const,
      modelName: 'gpt-5-mini',
      agentModelMode: 'profile' as const,
      agentModelProvider: '',
      agentModelName: '',
      privacyMode: 'disabled' as const,
      rewriteMode: 'disabled' as const,
      updatedAt: '2026-11-17T00:00:00.000Z',
    }
    const capabilities = {
      providers: [
        {
          id: 'openai' as const,
          name: 'OpenAI',
          category: 'vendor' as const,
          protocol: 'openai-chat' as const,
          baseUrl: 'https://api.openai.com/v1',
          defaultModel: 'gpt-5-mini',
          description: 'OpenAI API',
          requiresApiKey: true,
          hasApiKey: true,
          available: true,
        },
        {
          id: 'anthropic' as const,
          name: 'Anthropic',
          category: 'vendor' as const,
          protocol: 'anthropic-messages' as const,
          baseUrl: 'https://api.anthropic.com',
          defaultModel: 'claude-sonnet-4-5',
          description: 'Anthropic Messages API',
          requiresApiKey: true,
          hasApiKey: false,
          available: false,
          reason: '需要 API key',
        },
        {
          id: 'custom' as const,
          name: '自定义兼容服务',
          category: 'custom' as const,
          protocol: 'openai-chat' as const,
          baseUrl: '',
          defaultModel: '',
          description: '连接自托管或其他兼容服务',
          requiresApiKey: false,
          hasApiKey: false,
          available: false,
          reason: '需要 Base URL 和模型名',
        },
      ],
      privacyAvailable: true,
    }
    const speech = {
      provider: 'openai-compatible' as const,
      baseUrl: 'http://127.0.0.1:18081/v1',
      model: 'Qwen/Qwen3-ASR-0.6B',
      hasApiKey: true,
    }
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
      if (path === '/v1/settings/rewrite/test' && init?.method === 'POST') {
        return Promise.resolve(
          Response.json({
            original: '呃，请安排会议',
            rewritten: '请安排会议。',
            changed: true,
            latencyMs: 850,
          }),
        )
      }
      if (path === '/v1/settings' && init?.method === 'PUT') {
        const body = parseRequestBody(init)
        const customProvider = {
          ...capabilities.providers[2],
          name: '公司模型网关',
          protocol: 'openai-chat' as const,
          baseUrl: 'https://models.example.com/v1',
          defaultModel: 'gpt-settings-test',
          hasApiKey: true,
          available: true,
          reason: undefined,
        }
        return Promise.resolve(
          Response.json({
            settings: {
              ...settings,
              routerMode: body.routerMode,
              modelProvider: body.modelProvider,
              modelName: body.modelName,
              agentModelMode: body.agentModelMode,
              agentModelProvider: body.agentModelProvider,
              agentModelName: body.agentModelName,
              privacyMode: body.privacyMode,
              rewriteMode: body.rewriteMode,
              revision: 2,
            },
            capabilities: {
              ...capabilities,
              providers: [
                capabilities.providers[0],
                capabilities.providers[1],
                customProvider,
              ],
            },
          }),
        )
      }
      if (path === '/v1/settings') {
        return Promise.resolve(
          Response.json({ settings, capabilities, speech }),
        )
      }
      if (path === '/v1/settings/agent-models') {
        return Promise.resolve(
          Response.json({
            defaultProvider: 'magpie',
            defaultModel: 'agent-default',
            models: [
              {
                provider: 'magpie',
                id: 'agent-fast',
                name: 'Agent fast',
              },
            ],
          }),
        )
      }
      if (path === '/v1/settings/models/discover') {
        return Promise.resolve(
          Response.json({
            models: [
              { id: 'gpt-settings-test', name: 'Settings test' },
              ...Array.from({ length: 163 }, (_, index) => ({
                id: `model-${String(index)}`,
                name: `Model ${String(index)}`,
              })),
              { id: 'company/fast', name: 'Company fast' },
            ],
          }),
        )
      }
      if (path === '/v1/settings/models/test') {
        if (parseRequestBody(init).modelName === 'gpt-5-mini')
          return Promise.resolve(
            Response.json(
              {
                message:
                  'Model provider returned 404: magpie knows no model gpt-5-mini; available models: company/fast, gpt-settings-test, many others',
              },
              { status: 400 },
            ),
          )
        return Promise.resolve(Response.json({ ok: true, latencyMs: 42 }))
      }
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/tasks'))
        return Promise.resolve(Response.json({ tasks: [] }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      return Promise.resolve(Response.json({ messages: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Channel 列表' }))
    expect(
      await screen.findByRole('heading', { name: 'Channels', level: 1 }),
    ).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: 'Pegas', level: 2 }),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Pegas 设置' }))
    expect(
      await screen.findByRole('heading', { name: 'Pegas 设置', level: 1 }),
    ).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Agent 模型' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '模型服务' }))

    expect(
      await screen.findByRole('heading', { name: '设置', level: 1 }),
    ).toBeTruthy()
    const settingsDialog = await screen.findByRole('dialog', {
      name: '设置选项',
    })
    const settingsClose = within(settingsDialog).getByRole('button', {
      name: '关闭设置',
    })
    await waitFor(() => expect(document.activeElement).toBe(settingsClose))
    expect(
      document.querySelector('.identity-rail')?.hasAttribute('inert'),
    ).toBe(true)
    const settingsLast = within(settingsDialog).getByRole('button', {
      name: '保存更改',
    })
    settingsLast.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(settingsClose)
    expect(screen.queryByText(/Codex/)).toBeNull()
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'Pegas',
      '模型服务',
      '任务路由',
      '语音与输入',
      '隐私',
    ])
    fireEvent.click(screen.getByRole('tab', { name: '语音与输入' }))
    const savedSpeechKey =
      screen.getByLabelText<HTMLInputElement>(/API key（可选）/)
    expect(savedSpeechKey.type).toBe('password')
    expect(savedSpeechKey.value).toBe('')
    expect(savedSpeechKey.placeholder).toBe('已保存，留空则保持不变')
    expect(
      screen.getByText('密钥加密保存在服务端，不会显示原文。'),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '模型服务' }))
    expect(
      screen.queryByRole('radio', { name: /覆盖新 Agent session/ }),
    ).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /自定义/ }))
    fireEvent.change(screen.getByLabelText('连接名称'), {
      target: { value: '公司模型网关' },
    })
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://models.example.com/v1' },
    })
    fireEvent.change(screen.getByLabelText('模型 ID'), {
      target: { value: 'gpt-settings-test' },
    })
    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'secret-for-test' },
    })
    fireEvent.click(screen.getByRole('tab', { name: '任务路由' }))
    fireEvent.click(screen.getByRole('tab', { name: '模型服务' }))
    expect(screen.getByLabelText<HTMLInputElement>('连接名称').value).toBe(
      '公司模型网关',
    )
    expect(screen.getByLabelText<HTMLInputElement>('API key').value).toBe(
      'secret-for-test',
    )
    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }))
    const discoveryFeedback = await screen.findByText('已获取 165 个模型')
    expect(discoveryFeedback.closest('.model-feedback')).toBeTruthy()
    expect(screen.getByText('第 1–20 项，共 165 项')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: '选择模型 gpt-settings-test' }),
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: '选择模型 company/fast' }),
    ).toBeNull()
    for (let page = 1; page < 9; page += 1) {
      fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    }
    expect(screen.getByText('第 161–165 项，共 165 项')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: '选择模型 company/fast' }),
    ).toBeTruthy()
    fireEvent.change(
      screen.getByRole('searchbox', { name: '搜索已获取模型' }),
      {
        target: { value: 'model-1' },
      },
    )
    expect(screen.getByText(/第 1–20 项，共 \d+ 项/)).toBeTruthy()
    fireEvent.change(
      screen.getByRole('searchbox', { name: '搜索已获取模型' }),
      {
        target: { value: 'company' },
      },
    )
    fireEvent.click(
      screen.getByRole('button', { name: '选择模型 company/fast' }),
    )
    expect(screen.getByLabelText<HTMLInputElement>('模型 ID').value).toBe(
      'company/fast',
    )
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    expect(await screen.findByText('模型连接正常')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('模型 ID'), {
      target: { value: 'gpt-5-mini' },
    })
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    expect(await screen.findByText('找不到这个模型')).toBeTruthy()
    expect(screen.queryByText(/magpie knows no model/)).toBeNull()
    fireEvent.change(screen.getByLabelText('模型 ID'), {
      target: { value: 'company/fast' },
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Pegas' }))
    expect(screen.getByRole('heading', { name: 'Agent 模型' })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /覆盖新 Agent session/ }))
    fireEvent.change(screen.getByLabelText('DSH provider 与模型'), {
      target: { value: 'magpie::agent-fast' },
    })
    fireEvent.click(screen.getByRole('tab', { name: '语音与输入' }))
    fireEvent.click(screen.getByRole('radio', { name: /轻量校正/ }))
    fireEvent.click(screen.getByRole('radio', { name: /独立改写服务/ }))
    fireEvent.change(screen.getByLabelText('API 根地址'), {
      target: { value: 'https://rewrite.example.com/v1' },
    })
    fireEvent.change(screen.getByLabelText('改写模型'), {
      target: { value: 'rewrite-model' },
    })
    fireEvent.change(screen.getByLabelText('测试文本'), {
      target: { value: '呃，请安排会议' },
    })
    fireEvent.click(screen.getByRole('button', { name: '测试改写' }))
    expect(await screen.findByText('请安排会议。')).toBeTruthy()
    expect(
      parseRequestBody(
        fetchMock.mock.calls.find(
          ([path, init]) =>
            path === '/v1/settings/rewrite/test' && init?.method === 'POST',
        )?.[1],
      ),
    ).toMatchObject({
      rewrite: {
        mode: 'custom',
        baseUrl: 'https://rewrite.example.com/v1',
        model: 'rewrite-model',
      },
    })
    fireEvent.click(screen.getByRole('tab', { name: '隐私' }))
    fireEvent.click(screen.getByRole('radio', { name: /开启脱敏/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))

    expect(await screen.findByText('更改已保存')).toBeTruthy()
    const put = fetchMock.mock.calls.find(
      ([path, init]) => path === '/v1/settings' && init?.method === 'PUT',
    )
    expect(parseRequestBody(put?.[1])).toMatchObject({
      expectedRevision: 1,
      modelProvider: 'custom',
      modelName: 'company/fast',
      agentModelMode: 'override',
      agentModelProvider: 'magpie',
      agentModelName: 'agent-fast',
      privacyMode: 'mask',
      rewriteMode: 'light',
      rewrite: {
        mode: 'custom',
        baseUrl: 'https://rewrite.example.com/v1',
        model: 'rewrite-model',
      },
      provider: {
        name: '公司模型网关',
        protocol: 'openai-chat',
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-for-test',
        clearApiKey: false,
      },
    })
  })

  it('presents the DS Bot task shell as the primary entry', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
      if (path.startsWith('/v1/events') && init?.method === 'POST')
        return Promise.resolve(new Response(null))
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/tasks'))
        return Promise.resolve(Response.json({ tasks: [] }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      return Promise.resolve(Response.json({ messages: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Pegas', level: 1 }),
    ).toBeTruthy()
    expect(
      screen.getByRole('complementary', { name: 'Pegas 导航' }),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Channel 列表' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '搜索 Channel' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '开始新事情' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '收起侧栏' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pegas 设置' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '插件' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开工作区' })).toBeTruthy()
    expect(screen.getByLabelText('告诉 Pegas 你想完成什么')).toBeTruthy()
    expect(screen.getByRole('button', { name: '开始听写' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '开始语音输入' })).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: '工作区' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '收起侧栏' }))
    const collapsedNavigation = screen.getByRole('complementary', {
      name: 'Pegas 导航',
    })
    expect(within(collapsedNavigation).getAllByRole('button')).toHaveLength(1)
    expect(
      within(collapsedNavigation).getByRole('button', { name: '展开侧栏' }),
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /研究并比较/ }))
    expect(screen.getByLabelText('告诉 Pegas 你想完成什么')).toHaveProperty(
      'value',
      '帮我研究并比较下面这个问题，最后给我一个建议：',
    )
  })

  it('anchors the empty workspace header inside the opened panel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input
        if (path.startsWith('/v1/events'))
          return Promise.resolve(Response.json({ events: [] }))
        if (path.startsWith('/v1/tasks'))
          return Promise.resolve(Response.json({ tasks: [] }))
        if (path.startsWith('/v1/runs'))
          return Promise.resolve(Response.json({ runs: [] }))
        return Promise.resolve(Response.json({ messages: [] }))
      }),
    )

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '打开工作区' }))

    const workspace = screen.getByRole('complementary', { name: '工作区' })
    expect(workspace.querySelector('.workspace-empty > header')).not.toBeNull()
  })

  it('traps plugin detail focus, closes with Escape, and restores the trigger', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
      if (path.startsWith('/v1/events') && init?.method === 'POST')
        return Promise.resolve(new Response(null))
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/tasks'))
        return Promise.resolve(Response.json({ tasks: [] }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      return Promise.resolve(Response.json({ messages: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    const pluginLauncher = await screen.findByRole('button', { name: '插件' })
    fireEvent.click(pluginLauncher)
    const pluginDialog = screen.getByRole('dialog', { name: '插件' })
    const pluginClose = within(pluginDialog).getByRole('button', {
      name: '关闭插件',
    })
    await waitFor(() => expect(document.activeElement).toBe(pluginClose))
    const trigger = within(pluginDialog).getByRole('button', {
      name: '查看插件：语音输入',
    })
    const lastPlugin = within(pluginDialog).getByRole('button', {
      name: '查看插件：消息渠道',
    })
    lastPlugin.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(pluginClose)
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: '语音输入' })
    const close = within(dialog).getByRole('button', {
      name: '关闭插件详情',
    })
    await waitFor(() => expect(document.activeElement).toBe(close))
    expect(
      document.querySelector('.plugin-dialog')?.hasAttribute('inert'),
    ).toBe(true)
    expect(close.querySelector('svg')?.getAttribute('viewBox')).toBe(
      '0 0 20 20',
    )

    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(dialog.isConnected).toBe(false)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(pluginDialog.isConnected).toBe(false)
    await waitFor(() => expect(document.activeElement).toBe(pluginLauncher))
  })

  it('maps server Tasks to DS Bot-style task rows and keeps workspace collapsed', async () => {
    const tasks = [
      {
        id: 'task-one',
        userId: 'owner',
        originEventId: 'event-one',
        title: '整理发布说明',
        goal: '生成一份可审阅的发布说明',
        status: 'started' as const,
        createdAt: '2026-11-18T08:00:00.000Z',
        updatedAt: '2026-11-18T09:00:00.000Z',
      },
    ]
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
      if (path.startsWith('/v1/events') && init?.method === 'POST')
        return Promise.resolve(new Response(null))
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/tasks'))
        return Promise.resolve(Response.json({ tasks }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      return Promise.resolve(Response.json({ messages: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    const taskRow = await screen.findByRole('button', {
      name: '打开 Channel：整理发布说明',
    })
    const channelIcon = taskRow.querySelector('.pegas-agent-avatar')
    expect(channelIcon?.classList.contains('status-started')).toBe(true)
    expect(channelIcon?.querySelector('use')?.getAttribute('href')).toMatch(
      /^\/icons\/agents\/pegas-agents\.svg#pegas-agent-(car|camera|computer|phone)$/,
    )
    expect(document.querySelector('[href*="whale"]')).toBeNull()
    expect(screen.queryByRole('complementary', { name: '工作区' })).toBeNull()
    fireEvent.click(taskRow)
    expect(screen.getByRole('complementary', { name: '工作区' })).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: '整理发布说明', level: 2 }),
    ).toBeTruthy()
    expect(screen.getByLabelText('告诉 Pegas 你想完成什么')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('告诉 Pegas 你想完成什么'), {
      target: { value: '继续这个任务' },
    })
    fireEvent.keyDown(screen.getByLabelText('告诉 Pegas 你想完成什么'), {
      key: 'Enter',
    })
    await waitFor(() => {
      const sent = fetchMock.mock.calls.find(
        ([path, init]) => path === '/v1/events' && init?.method === 'POST',
      )
      expect(parseRequestBody(sent?.[1])).toMatchObject({
        payload: { text: '继续这个任务', taskId: 'task-one' },
      })
    })
  })

  it('shows tasks as a board and opens the selected task in the workspace', async () => {
    const tasks = [
      {
        id: 'task-running',
        userId: 'owner',
        originEventId: 'event-running',
        title: '整理发布说明',
        goal: '生成一份可审阅的发布说明',
        status: 'started',
        createdAt: '2026-11-18T08:00:00.000Z',
        updatedAt: '2026-11-18T09:00:00.000Z',
      },
      {
        id: 'task-done',
        userId: 'owner',
        originEventId: 'event-done',
        title: '检查测试结果',
        goal: '确认回归测试通过',
        status: 'completed',
        createdAt: '2026-11-17T08:00:00.000Z',
        updatedAt: '2026-11-17T09:00:00.000Z',
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input
        if (path.startsWith('/v1/events'))
          return Promise.resolve(Response.json({ events: [] }))
        if (path.startsWith('/v1/tasks'))
          return Promise.resolve(Response.json({ tasks }))
        if (path.startsWith('/v1/runs'))
          return Promise.resolve(Response.json({ runs: [] }))
        return Promise.resolve(Response.json({ messages: [] }))
      }),
    )

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Channel 列表' }))

    expect(
      await screen.findByRole('heading', { name: 'Channels', level: 1 }),
    ).toBeTruthy()
    expect(screen.getByRole('heading', { name: '进行中' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '已完成' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '已取消' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull()
    expect(screen.getByRole('button', { name: '打开工作区' })).toBeTruthy()

    fireEvent.change(screen.getByRole('textbox', { name: '搜索 Channel' }), {
      target: { value: '发布' },
    })
    expect(
      screen.queryByRole('button', { name: '打开 Channel 现场：检查测试结果' }),
    ).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索 Channel' }), {
      target: { value: '' },
    })
    expect(
      screen.getByRole('button', { name: '打开 Channel 现场：检查测试结果' }),
    ).toBeTruthy()

    fireEvent.click(
      screen.getByRole('button', { name: '打开 Channel 现场：整理发布说明' }),
    )
    expect(screen.getByRole('complementary', { name: '工作区' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '整理发布说明' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(screen.queryByRole('complementary', { name: '工作区' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    fireEvent.click(screen.getByRole('button', { name: 'Channel 列表' }))
    expect(screen.getByRole('complementary', { name: '工作区' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭工作区' }))
    expect(screen.queryByRole('complementary', { name: '工作区' })).toBeNull()
  })

  it('preserves composed text and failed drafts in the composer', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
      if (init?.method === 'POST')
        return Promise.resolve(
          Response.json({ error: '发送失败，请重试' }, { status: 503 }),
        )
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/tasks'))
        return Promise.resolve(Response.json({ tasks: [] }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      return Promise.resolve(Response.json({ messages: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    const input = await screen.findByRole('textbox', {
      name: '告诉 Pegas 你想完成什么',
    })
    const send = screen.getByRole('button', { name: '发送给 Pegas' })
    expect(send).toHaveProperty('disabled', true)
    fireEvent.change(input, { target: { value: '整理这个想法' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(0)
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(send).toHaveProperty('disabled', false))
    expect(input).toHaveProperty('value', '整理这个想法')
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1)
  })

  it('uses the WorkChannel projection for scoped chat and returns to Pegas routing', async () => {
    const channel = {
      id: 'task-channel-1',
      taskId: 'task-channel-1',
      userId: 'owner',
      originEventId: 'event-channel-1',
      title: '发布检查',
      goal: '检查发布候选版本',
      status: 'started',
      createdAt: '2026-11-19T08:00:00.000Z',
      updatedAt: '2026-11-19T08:00:00.000Z',
      latestActivityAt: '2026-11-19T08:00:00.000Z',
    }
    const submitted: Record<string, unknown>[] = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
      if (path.startsWith('/v1/events') && init?.method === 'POST') {
        submitted.push(parseRequestBody(init))
        return Promise.resolve(Response.json({ inserted: true }))
      }
      if (path.startsWith('/v1/channels'))
        return Promise.resolve(Response.json({ channels: [channel] }))
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      return Promise.resolve(Response.json({ messages: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    expect(await screen.findByText('Channels')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: '打开 Channel：发布检查' }),
    )
    const input = screen.getByRole('textbox', {
      name: '告诉 Pegas 你想完成什么',
    })
    fireEvent.change(input, { target: { value: '继续检查' } })
    fireEvent.click(screen.getByRole('button', { name: '发送给 Pegas' }))
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0]).toMatchObject({
      payload: { text: '继续检查', taskId: channel.taskId },
    })

    fireEvent.click(screen.getByRole('button', { name: '返回 Pegas 主对话' }))
    fireEvent.change(input, { target: { value: '开始另一件事' } })
    fireEvent.click(screen.getByRole('button', { name: '发送给 Pegas' }))
    await waitFor(() => expect(submitted).toHaveLength(2))
    expect(submitted[1]).toMatchObject({
      payload: { text: '开始另一件事' },
    })
    expect(
      (submitted[1]?.payload as Record<string, unknown>).taskId,
    ).toBeUndefined()
  })

  it('replaces the global conversation with the selected Channel timeline', async () => {
    const first = {
      id: 'task-first',
      taskId: 'task-first',
      userId: 'owner',
      originEventId: 'event-first',
      title: 'First channel',
      goal: 'First goal',
      status: 'started',
      workerIconId: 'computer',
      createdAt: '2026-11-19T08:00:00.000Z',
      updatedAt: '2026-11-19T08:03:00.000Z',
      latestActivityAt: '2026-11-19T08:03:00.000Z',
      canResume: false,
      canStop: true,
    }
    const second = {
      ...first,
      id: 'task-second',
      taskId: 'task-second',
      originEventId: 'event-second',
      title: 'Second channel',
      goal: 'Second goal',
    }
    const globalEvents = [
      {
        id: 'event-first',
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        payload: { text: 'First global input' },
        status: 'processed',
        createdAt: '2026-11-19T08:00:00.000Z',
      },
      {
        id: 'event-second',
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        payload: { text: 'Second global input' },
        status: 'processed',
        createdAt: '2026-11-19T08:01:00.000Z',
      },
    ]
    const globalMessages = [
      {
        id: 'message-first',
        userId: 'owner',
        taskId: first.id,
        payload: { type: 'run.completed', text: 'First isolated result' },
        status: 'sent',
        createdAt: '2026-11-19T08:02:00.000Z',
      },
      {
        id: 'message-second',
        userId: 'owner',
        taskId: second.id,
        payload: { type: 'run.completed', text: 'Second must disappear' },
        status: 'sent',
        createdAt: '2026-11-19T08:03:00.000Z',
      },
    ]
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
      if (path.startsWith('/v1/channels/task-first/timeline'))
        return Promise.resolve(
          Response.json({
            channel: first,
            events: [globalEvents[0]],
            runs: [],
            messages: [globalMessages[0]],
          }),
        )
      if (path.startsWith('/v1/channels'))
        return Promise.resolve(Response.json({ channels: [first, second] }))
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: globalEvents }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      return Promise.resolve(Response.json({ messages: globalMessages }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    expect(await screen.findByText('Second must disappear')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: '打开 Channel：First channel' }),
    )

    expect(screen.queryByText('Second must disappear')).toBeNull()
    expect(await screen.findByText('First isolated result')).toBeTruthy()
    expect(screen.queryByText('Second global input')).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/channels/task-first/timeline?userId=owner',
      expect.any(Object),
    )
  })

  it('does not fall back to global history when a Channel timeline fails', async () => {
    const first = testChannel('task-failure-first', 'Failure first')
    const second = testChannel('task-failure-second', 'Failure second')
    const globalMessage = testMessage(
      'message-failure-second',
      second.id,
      'Another Channel must stay hidden',
    )
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input)
      if (path.startsWith(`/v1/channels/${first.id}/timeline`))
        return Promise.resolve(
          Response.json(
            { message: 'Channel timeline unavailable' },
            { status: 503 },
          ),
        )
      if (path.startsWith('/v1/channels'))
        return Promise.resolve(Response.json({ channels: [first, second] }))
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      return Promise.resolve(Response.json({ messages: [globalMessage] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    expect(
      await screen.findByText('Another Channel must stay hidden'),
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: '打开 Channel：Failure first' }),
    )

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Channel timeline unavailable')).toBeTruthy()
    expect(screen.queryByText('Another Channel must stay hidden')).toBeNull()
  })

  it('keeps the direct Channel target when its metadata fails to load', async () => {
    const channelId = 'task-direct-target'
    let postedBody: Record<string, unknown> | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input)
      if (path === '/v1/events' && init?.method === 'POST') {
        postedBody = parseRequestBody(init)
        return Promise.resolve(Response.json({}, { status: 202 }))
      }
      if (path.startsWith(`/v1/channels/${channelId}/timeline`))
        return Promise.resolve(
          Response.json({ message: 'Channel unavailable' }, { status: 503 }),
        )
      if (path.startsWith('/v1/channels'))
        return Promise.resolve(Response.json({ channels: [] }))
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      return Promise.resolve(Response.json({ messages: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState({}, '', `/?channel=${channelId}`)

    render(<App />)
    await screen.findByText('Channel unavailable')
    fireEvent.change(screen.getByLabelText('告诉 Pegas 你想完成什么'), {
      target: { value: 'Continue this Channel' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送给 Pegas' }))

    await waitFor(() =>
      expect(postedBody).toMatchObject({
        payload: { text: 'Continue this Channel', taskId: channelId },
      }),
    )
  })

  it('clears a previously loaded Channel timeline when its refresh fails', async () => {
    const channel = testChannel('task-refresh-failure', 'Refresh failure')
    const sensitive = testMessage(
      'message-refresh-failure',
      channel.id,
      'Previously loaded private result',
    )
    let timelineRequests = 0
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input)
      if (path === '/v1/events' && init?.method === 'POST')
        return Promise.resolve(Response.json({}, { status: 202 }))
      if (path.startsWith(`/v1/channels/${channel.id}/timeline`)) {
        timelineRequests += 1
        return timelineRequests === 1
          ? Promise.resolve(
              Response.json({
                channel,
                events: [],
                runs: [],
                messages: [sensitive],
              }),
            )
          : Promise.resolve(
              Response.json(
                { message: 'Channel refresh failed' },
                { status: 503 },
              ),
            )
      }
      if (path.startsWith('/v1/channels'))
        return Promise.resolve(Response.json({ channels: [channel] }))
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      return Promise.resolve(Response.json({ messages: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState({}, '', `/?channel=${channel.id}`)

    render(<App />)
    expect(
      await screen.findByText('Previously loaded private result'),
    ).toBeTruthy()
    fireEvent.change(screen.getByLabelText('告诉 Pegas 你想完成什么'), {
      target: { value: 'Refresh now' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送给 Pegas' }))

    expect(await screen.findByText('Channel refresh failed')).toBeTruthy()
    expect(screen.queryByText('Previously loaded private result')).toBeNull()
  })

  it('does not refresh the previous Channel after a delayed send completes', async () => {
    const first = testChannel('task-send-first', 'Send first')
    const second = testChannel('task-send-second', 'Send second')
    const secondMessage = testMessage(
      'message-send-second',
      second.id,
      'Second remains current',
    )
    let resolveSend: ((response: Response) => void) | undefined
    const delayedSend = new Promise<Response>(resolve => {
      resolveSend = resolve
    })
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input)
      if (path === '/v1/events' && init?.method === 'POST') return delayedSend
      if (path.startsWith(`/v1/channels/${first.id}/timeline`))
        return Promise.resolve(
          Response.json({
            channel: first,
            events: [],
            runs: [],
            messages: [],
          }),
        )
      if (path.startsWith(`/v1/channels/${second.id}/timeline`))
        return Promise.resolve(
          Response.json({
            channel: second,
            events: [],
            runs: [],
            messages: [secondMessage],
          }),
        )
      if (path.startsWith('/v1/channels'))
        return Promise.resolve(Response.json({ channels: [first, second] }))
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      return Promise.resolve(Response.json({ messages: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await screen.findByText('Channels')
    fireEvent.click(
      screen.getByRole('button', { name: '打开 Channel：Send first' }),
    )
    await screen.findByPlaceholderText('给 Send first 发消息')
    fireEvent.change(screen.getByLabelText('告诉 Pegas 你想完成什么'), {
      target: { value: 'Delayed send' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送给 Pegas' }))
    fireEvent.click(
      screen.getByRole('button', { name: '打开 Channel：Send second' }),
    )
    expect(await screen.findByText('Second remains current')).toBeTruthy()

    await act(async () => {
      resolveSend?.(Response.json({}, { status: 202 }))
      await Promise.resolve()
    })
    expect(screen.getByText('Second remains current')).toBeTruthy()
  })

  it('ignores an older Channel snapshot after switching Channels', async () => {
    const first = testChannel('task-race-first', 'Race first')
    const second = testChannel('task-race-second', 'Race second')
    const firstMessage = testMessage(
      'message-race-first',
      first.id,
      'Stale first result',
    )
    const secondMessage = testMessage(
      'message-race-second',
      second.id,
      'Current second result',
    )
    let resolveFirst: ((response: Response) => void) | undefined
    const delayedFirst = new Promise<Response>(resolve => {
      resolveFirst = resolve
    })
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input)
      if (path.startsWith(`/v1/channels/${first.id}/timeline`))
        return delayedFirst
      if (path.startsWith(`/v1/channels/${second.id}/timeline`))
        return Promise.resolve(
          Response.json({
            channel: second,
            events: [],
            runs: [],
            messages: [secondMessage],
          }),
        )
      if (path.startsWith('/v1/channels'))
        return Promise.resolve(Response.json({ channels: [first, second] }))
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      return Promise.resolve(Response.json({ messages: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await screen.findByText('Channels')
    fireEvent.click(
      screen.getByRole('button', { name: '打开 Channel：Race first' }),
    )
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/v1/channels/${first.id}/timeline?userId=owner`,
        expect.any(Object),
      ),
    )
    fireEvent.click(
      screen.getByRole('button', { name: '打开 Channel：Race second' }),
    )
    expect(await screen.findByText('Current second result')).toBeTruthy()

    await act(async () => {
      resolveFirst?.(
        Response.json({
          channel: first,
          events: [],
          runs: [],
          messages: [firstMessage],
        }),
      )
      await Promise.resolve()
    })
    expect(screen.getByText('Current second result')).toBeTruthy()
    expect(screen.queryByText('Stale first result')).toBeNull()
  })

  it('shows provider-reported token and cache usage in the Channel workspace', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(max-width: 1100px)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    )
    const channel = {
      id: 'task-usage-1',
      taskId: 'task-usage-1',
      userId: 'owner',
      originEventId: 'event-usage-1',
      title: '整理模型用量',
      goal: '查看这个 Channel 的真实模型消耗',
      status: 'completed',
      workerIconId: 'computer',
      createdAt: '2026-11-19T08:00:00.000Z',
      updatedAt: '2026-11-19T08:05:00.000Z',
      latestActivityAt: '2026-11-19T08:05:00.000Z',
      canResume: true,
      canStop: false,
    }
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
      if (path.startsWith('/v1/channels'))
        return Promise.resolve(Response.json({ channels: [channel] }))
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      if (path.startsWith('/v1/outbox'))
        return Promise.resolve(Response.json({ messages: [] }))
      if (path.startsWith('/v1/usage'))
        return Promise.resolve(
          Response.json({
            summary: {
              records: 3,
              completeRecords: 1,
              partialRecords: 1,
              unavailableRecords: 1,
              inputTokens: 105,
              outputTokens: 21,
              cacheReadTokens: 80,
              cacheWriteTokens: 20,
              durationMs: 1250,
            },
            records: [
              {
                runId: 'run-reported-1234',
                taskId: channel.id,
                userId: 'owner',
                workerIconId: 'computer',
                executor: 'dsh-headless',
                modelRef:
                  'magpie/a-very-long-model-name-that-must-not-overflow',
                completeness: 'complete',
                tokenSource: 'provider_reported',
                inputTokens: 100,
                outputTokens: 20,
                cacheReadTokens: 80,
                cacheWriteTokens: 20,
                reportedSteps: 1,
                unreportedSteps: 0,
                durationMs: 1250,
                latencySource: 'pegas_observed',
                observedAt: '2026-11-19T08:05:00.000Z',
              },
              {
                runId: 'run-partial',
                taskId: channel.id,
                userId: 'owner',
                workerIconId: 'computer',
                executor: 'dsh-headless',
                modelRef: 'magpie/partial-model',
                completeness: 'partial',
                tokenSource: 'provider_reported',
                inputTokens: 5,
                outputTokens: 1,
                reportedSteps: 1,
                unreportedSteps: 1,
                observedAt: '2026-11-19T08:04:30.000Z',
              },
              {
                runId: 'run-unavailable',
                taskId: channel.id,
                userId: 'owner',
                workerIconId: 'computer',
                executor: 'legacy-executor',
                completeness: 'unavailable',
                reportedSteps: 0,
                unreportedSteps: 0,
                observedAt: '2026-11-19T08:04:00.000Z',
              },
            ],
          }),
        )
      return Promise.resolve(Response.json({}))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '展开侧栏' }))
    fireEvent.click(
      screen.getByRole('button', {
        name: '打开 Channel：整理模型用量',
      }),
    )

    expect(await screen.findByText('1 个 Run 未回报')).toBeTruthy()
    const collapsedNavigation = screen.getByRole('complementary', {
      name: 'Pegas 导航',
    })
    expect(within(collapsedNavigation).getAllByRole('button')).toHaveLength(1)
    expect(
      within(collapsedNavigation).getByRole('button', { name: '展开侧栏' }),
    ).toBeTruthy()
    const usageTable = screen.getByRole('table', {
      name: '按 Run 查看模型用量',
    })
    expect(within(usageTable).getByText('100')).toBeTruthy()
    expect(within(usageTable).getByText('40%')).toBeTruthy()
    expect(within(usageTable).getByText('部分回报')).toBeTruthy()
    expect(within(usageTable).getByText('执行器未回报')).toBeTruthy()
    expect(
      within(usageTable).getAllByText('供应商未提供').length,
    ).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/usage?userId=owner&taskId=task-usage-1',
      expect.any(Object),
    )
  })

  it('navigates Outbox from the left rail, keeps read and delivery state separate, and opens the source Channel', async () => {
    const channel = {
      id: 'task-outbox-1',
      taskId: 'task-outbox-1',
      userId: 'owner',
      originEventId: 'event-outbox-1',
      title: '检查发布结果',
      goal: '确认发布是否完成',
      status: 'completed',
      workerIconId: 'computer',
      createdAt: '2026-11-19T08:00:00.000Z',
      updatedAt: '2026-11-19T08:05:00.000Z',
      latestActivityAt: '2026-11-19T08:05:00.000Z',
      canResume: true,
      canStop: false,
    }
    const message = {
      id: 'outbox-1',
      userId: 'owner',
      taskId: channel.id,
      payload: {
        type: 'run.completed',
        text: '发布检查已经完成。',
      },
      status: 'pending',
      createdAt: '2026-11-19T08:05:00.000Z',
    }
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
      if (path === '/v1/outbox/outbox-1/read' && init?.method === 'POST')
        return Promise.resolve(
          Response.json({
            message: { ...message, readAt: '2026-11-19T08:06:00.000Z' },
          }),
        )
      if (path.startsWith('/v1/channels'))
        return Promise.resolve(Response.json({ channels: [channel] }))
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      if (path.startsWith('/v1/outbox'))
        return Promise.resolve(Response.json({ messages: [message] }))
      return Promise.resolve(Response.json({}))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    const outboxNavigation = await screen.findByRole('button', {
      name: /Outbox/,
    })
    expect(within(outboxNavigation).getByText('1')).toBeTruthy()
    fireEvent.click(outboxNavigation)
    expect(
      await screen.findByRole('heading', { name: 'Outbox', level: 1 }),
    ).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: '需要你关注的消息' }),
    ).toBeTruthy()
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) =>
            path === '/v1/outbox/outbox-1/read' && init?.method === 'POST',
        ),
      ).toBe(true),
    )
    expect(screen.getByText('等待投递')).toBeTruthy()
    expect(screen.getAllByText('已读').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '检查发布结果' }))
    expect(screen.getByRole('complementary', { name: '工作区' })).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: '检查发布结果', level: 2 }),
    ).toBeTruthy()
  })

  it('confirms a permanent stop and makes the stopped channel read-only', async () => {
    let channel = {
      id: 'task-stop-1',
      taskId: 'task-stop-1',
      userId: 'owner',
      originEventId: 'event-stop-1',
      title: '停止测试',
      goal: '验证永久停止',
      status: 'started',
      canResume: false,
      canStop: true,
      createdAt: '2026-11-19T08:00:00.000Z',
      updatedAt: '2026-11-19T08:00:00.000Z',
      latestActivityAt: '2026-11-19T08:00:00.000Z',
    }
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
      if (path.endsWith('/stop') && init?.method === 'POST') {
        expect(parseRequestBody(init)).toMatchObject({
          userId: 'owner',
          reason: '用户在工作区停止 Channel',
        })
        channel = {
          ...channel,
          status: 'cancelled',
          canStop: false,
          updatedAt: '2026-11-19T08:01:00.000Z',
          latestActivityAt: '2026-11-19T08:01:00.000Z',
        }
        return Promise.resolve(Response.json({ channel }))
      }
      if (path.startsWith('/v1/channels'))
        return Promise.resolve(Response.json({ channels: [channel] }))
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      return Promise.resolve(Response.json({ messages: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: '打开 Channel：停止测试' }),
    )
    fireEvent.click(screen.getByRole('button', { name: '停止 Channel' }))

    const dialog = screen.getByRole('dialog', {
      name: '永久停止 Channel？',
    })
    expect(
      within(dialog)
        .getByRole('button', { name: '保留 Channel' })
        .hasAttribute('autofocus'),
    ).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: '永久停止' }))

    expect(
      await screen.findByText('这个 Channel 已由你停止，不能恢复。'),
    ).toBeTruthy()
    expect(
      screen.getByRole('textbox', { name: '告诉 Pegas 你想完成什么' }),
    ).toHaveProperty('disabled', true)
    expect(
      screen.getAllByRole('button', { name: '新建相关 Channel' }),
    ).toHaveLength(2)
  })

  it('keeps failed execution history and retries within the same work item', async () => {
    const task = {
      id: 'task-retry',
      userId: 'owner',
      originEventId: 'event-retry',
      title: '可重试的任务',
      goal: '保留目标',
      status: 'started',
      statusReason: 'last_run_failed',
      createdAt: '2026-11-18T08:00:00.000Z',
      updatedAt: '2026-11-18T08:00:00.000Z',
    }
    const failed = {
      id: 'run-failed',
      taskId: task.id,
      executor: 'test',
      status: 'failed',
      input: '原输入',
      attempts: 1,
      lastError: 'provider timeout',
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }
    const runs = [failed]
    let attempts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input
        if (path.endsWith('/retry')) {
          expect(parseRequestBody(init)).toEqual({ userId: 'owner' })
          attempts++
          if (attempts === 1)
            return Promise.resolve(
              Response.json({ message: '暂时无法重试' }, { status: 503 }),
            )
          const retry = {
            ...failed,
            id: 'run-retry',
            status: 'queued',
            attempts: 0,
            lastError: '',
          }
          runs.push(retry)
          return Promise.resolve(Response.json({ run: retry }))
        }
        if (path.startsWith('/v1/tasks'))
          return Promise.resolve(Response.json({ tasks: [task] }))
        if (path.startsWith('/v1/runs'))
          return Promise.resolve(Response.json({ runs }))
        if (path.startsWith('/v1/events'))
          return Promise.resolve(Response.json({ events: [] }))
        return Promise.resolve(Response.json({ messages: [] }))
      }),
    )
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Channel 列表' }))
    fireEvent.click(
      await screen.findByRole('button', {
        name: '打开 Channel 现场：可重试的任务',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '新建 Run 重试' }))
    expect(await screen.findByText('暂时无法重试')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '新建 Run 重试' }))
    expect(await screen.findByText('Run 2')).toBeTruthy()
    expect(screen.getByText('Run 1')).toBeTruthy()
    expect(screen.getByText('provider timeout')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '新建 Run 重试' })).toBeNull()
    expect(
      screen.getAllByRole('button', {
        name: '打开 Channel 现场：可重试的任务',
      }),
    ).toHaveLength(1)
  })

  it('formats recent updates in conversational language', () => {
    const now = new Date('2026-11-16T10:00:00.000Z').getTime()
    expect(formatRelativeTime('2026-11-16T09:58:00.000Z', now)).toBe('2分钟前')
  })

  it('opens voice settings without requesting the microphone when speech is unconfigured', async () => {
    const stopTrack = vi.fn()
    const getUserMedia = vi.fn(() =>
      Promise.resolve({
        getTracks: () => [{ stop: stopTrack }],
      } as unknown as MediaStream),
    )
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    class TestMediaRecorder {
      static isTypeSupported(): boolean {
        return true
      }
      readonly mimeType = 'audio/webm'
      state = 'inactive'
      ondataavailable: ((event: BlobEvent) => void) | null = null
      onerror: (() => void) | null = null
      onstop: (() => void) | null = null
      start(): void {
        this.state = 'recording'
      }
      stop(): void {
        this.state = 'inactive'
        this.ondataavailable?.({
          data: new Blob(['sample'], { type: this.mimeType }),
        } as BlobEvent)
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', TestMediaRecorder)
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
      if (path === '/v1/settings/speech/test' && init?.method === 'POST')
        return Promise.resolve(
          Response.json({
            transcript: { text: '这是测试转写' },
            latencyMs: 1200,
          }),
        )
      if (path === '/v1/settings')
        return Promise.resolve(
          Response.json({
            settings: {
              revision: 1,
              routerMode: 'rules',
              modelProvider: 'openai',
              modelName: 'gpt-test',
              agentModelMode: 'profile',
              agentModelProvider: '',
              agentModelName: '',
              privacyMode: 'disabled',
              rewriteMode: 'disabled',
              updatedAt: '2026-11-18T00:00:00.000Z',
            },
            capabilities: {
              providers: [
                {
                  id: 'openai',
                  name: 'OpenAI',
                  category: 'vendor',
                  protocol: 'openai-chat',
                  baseUrl: 'https://api.openai.com/v1',
                  defaultModel: 'gpt-test',
                  description: '',
                  requiresApiKey: true,
                  hasApiKey: true,
                  available: true,
                },
              ],
              privacyAvailable: false,
            },
            speech: {
              provider: 'disabled',
              baseUrl: '',
              model: 'asr-test',
              hasApiKey: false,
            },
          }),
        )
      if (path === '/v1/settings/agent-models')
        return Promise.resolve(
          Response.json({
            defaultProvider: 'magpie',
            defaultModel: 'agent',
            models: [],
          }),
        )
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/tasks'))
        return Promise.resolve(Response.json({ tasks: [] }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      return Promise.resolve(Response.json({ messages: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '开始听写' }))
    expect(
      (await screen.findByRole('tab', { name: '语音与输入' })).getAttribute(
        'aria-selected',
      ),
    ).toBe('true')
    expect(screen.getByText('未启用')).toBeTruthy()
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(
      fetchMock.mock.calls.some(([path]) =>
        (path instanceof Request
          ? path.url
          : path instanceof URL
            ? path.href
            : path
        ).startsWith('/v1/voice/transcriptions'),
      ),
    ).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: /OpenAI 兼容转写服务/ }))
    fireEvent.change(screen.getByLabelText(/服务地址/), {
      target: { value: 'http://127.0.0.1:18081/v1' },
    })
    fireEvent.change(screen.getByLabelText(/API key（可选）/), {
      target: { value: 'probe-credential' },
    })
    fireEvent.click(screen.getByRole('button', { name: '录一段测试' }))
    fireEvent.click(await screen.findByRole('button', { name: /结束并识别/ }))
    expect(await screen.findByText('这是测试转写')).toBeTruthy()
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(stopTrack).toHaveBeenCalledOnce()
    const probe = fetchMock.mock.calls.find(
      ([path]) => path === '/v1/settings/speech/test',
    )
    expect(probe?.[1]?.body).toBeInstanceOf(FormData)
    const probeSpeech = JSON.parse(
      (probe?.[1]?.body as FormData).get('speech') as string,
    ) as Record<string, unknown>
    expect(probeSpeech).toMatchObject({
      baseUrl: 'http://127.0.0.1:18081/v1',
      apiKey: 'probe-credential',
    })
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) => path === '/v1/settings' && init?.method === 'PUT',
      ),
    ).toBe(false)
  })

  it('turns recorded speech into an editable draft without sending it', async () => {
    const stopTrack = vi.fn()
    const getUserMedia = vi.fn(() =>
      Promise.resolve({
        getTracks: () => [{ stop: stopTrack }],
      } as unknown as MediaStream),
    )
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
      if (path.startsWith('/v1/voice/transcriptions'))
        return Promise.resolve(
          Response.json({ transcript: { text: '帮我整理会议记录' } }),
        )
      if (path.startsWith('/v1/events'))
        return Promise.resolve(Response.json({ events: [] }))
      if (path.startsWith('/v1/tasks'))
        return Promise.resolve(Response.json({ tasks: [] }))
      if (path.startsWith('/v1/runs'))
        return Promise.resolve(Response.json({ runs: [] }))
      if (init?.method === 'POST') return Promise.resolve(new Response(null))
      return Promise.resolve(Response.json({ messages: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
      },
    })

    class TestMediaRecorder {
      static isTypeSupported(): boolean {
        return true
      }

      readonly mimeType = 'audio/webm;codecs=opus'
      state = 'inactive'
      ondataavailable: ((event: BlobEvent) => void) | null = null
      onerror: (() => void) | null = null
      onstop: (() => void) | null = null

      start(): void {
        this.state = 'recording'
      }

      stop(): void {
        this.state = 'inactive'
        this.ondataavailable?.({
          data: new Blob(['recorded-audio'], { type: this.mimeType }),
        } as BlobEvent)
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', TestMediaRecorder)

    render(<App />)
    const composer = await screen.findByLabelText('告诉 Pegas 你想完成什么')
    const start = screen.getByRole('button', { name: '开始听写' })
    fireEvent.click(start)
    const stop = await screen.findByRole('button', { name: '停止听写' })
    fireEvent.click(stop)

    await waitFor(() => {
      expect(composer).toHaveProperty('value', '帮我整理会议记录')
    })
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(
      fetchMock.mock.calls.some(([path, init]) => {
        const requestedPath =
          path instanceof Request
            ? path.url
            : path instanceof URL
              ? path.href
              : path
        return requestedPath.startsWith('/v1/events') && init?.method === 'POST'
      }),
    ).toBe(false)
  })

  it('shows speech failures as an inline composer status', async () => {
    const getUserMedia = vi.fn(() =>
      Promise.resolve({
        getTracks: () => [{ stop: vi.fn() }],
      } as unknown as MediaStream),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input
        if (path.startsWith('/v1/voice/transcriptions'))
          return Promise.resolve(
            Response.json(
              {
                message:
                  '语音服务暂时不可用，请检查服务地址、模型和密钥后重试。',
              },
              { status: 502 },
            ),
          )
        if (path.startsWith('/v1/events'))
          return Promise.resolve(Response.json({ events: [] }))
        if (path.startsWith('/v1/tasks'))
          return Promise.resolve(Response.json({ tasks: [] }))
        if (path.startsWith('/v1/runs'))
          return Promise.resolve(Response.json({ runs: [] }))
        return Promise.resolve(Response.json({ messages: [] }))
      }),
    )
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })

    class FailingMediaRecorder {
      static isTypeSupported(): boolean {
        return true
      }

      readonly mimeType = 'audio/webm;codecs=opus'
      state = 'inactive'
      ondataavailable: ((event: BlobEvent) => void) | null = null
      onerror: (() => void) | null = null
      onstop: (() => void) | null = null

      start(): void {
        this.state = 'recording'
      }

      stop(): void {
        this.state = 'inactive'
        this.ondataavailable?.({
          data: new Blob(['recorded-audio'], { type: this.mimeType }),
        } as BlobEvent)
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', FailingMediaRecorder)

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '开始听写' }))
    fireEvent.click(await screen.findByRole('button', { name: '停止听写' }))

    const status = await screen.findByRole('status')
    expect(status.textContent).toBe(
      '语音服务暂时不可用，请检查服务地址、模型和密钥后重试。',
    )
    expect(status.closest('form')?.className).toContain('composer-wrap')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows delivery as message metadata instead of a Pegas reply', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input
        if (path.startsWith('/v1/events'))
          return Promise.resolve(
            Response.json({
              events: [
                {
                  id: 'event-1',
                  userId: 'owner',
                  type: 'user.message',
                  source: 'web',
                  payload: { text: '检查发布流程' },
                  status: 'pending',
                  createdAt: '2026-11-16T10:00:00.000Z',
                },
              ],
            }),
          )
        if (path.startsWith('/v1/tasks'))
          return Promise.resolve(Response.json({ tasks: [] }))
        if (path.startsWith('/v1/runs'))
          return Promise.resolve(Response.json({ runs: [] }))
        return Promise.resolve(Response.json({ messages: [] }))
      }),
    )

    render(<App />)

    expect(await screen.findByText('检查发布流程')).toBeTruthy()
    expect(screen.getByText('已送达')).toBeTruthy()
    expect(screen.queryAllByText('已送达')).toHaveLength(1)
  })

  it('renders Pegas replies as safe, structured Markdown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input
        if (path.startsWith('/v1/events'))
          return Promise.resolve(Response.json({ events: [] }))
        if (path.startsWith('/v1/tasks'))
          return Promise.resolve(Response.json({ tasks: [] }))
        if (path.startsWith('/v1/runs'))
          return Promise.resolve(Response.json({ runs: [] }))
        return Promise.resolve(
          Response.json({
            messages: [
              {
                id: 'message-1',
                userId: 'owner',
                payload: {
                  type: 'agent.message',
                  text: [
                    '## 验证结果',
                    '',
                    '**检查通过**，运行 `pnpm check`。',
                    '',
                    '- 13 个测试文件',
                    '- 42 个测试',
                    '',
                    '```text',
                    'EXIT=0',
                    '```',
                    '',
                    '[查看文档](https://example.com/docs)',
                    '',
                    '<script>alert("unsafe")</script>',
                  ].join('\n'),
                },
                status: 'sent',
                createdAt: '2026-11-16T10:00:00.000Z',
              },
            ],
          }),
        )
      }),
    )

    const { container } = render(<App />)

    expect(
      await screen.findByRole('heading', { name: '验证结果', level: 2 }),
    ).toBeTruthy()
    expect(screen.getByText('检查通过').tagName).toBe('STRONG')
    expect(screen.getByText('pnpm check').tagName).toBe('CODE')
    expect(container.querySelector('pre')?.getAttribute('tabindex')).toBe('0')
    expect(container.querySelector('pre code')?.textContent).toContain('EXIT=0')
    expect(screen.getByRole('list').children).toHaveLength(2)
    expect(
      screen.getByRole('link', { name: '查看文档' }).getAttribute('href'),
    ).toBe('https://example.com/docs')
    expect(container.querySelector('script')).toBeNull()
    expect(screen.queryByText('alert("unsafe")')).toBeNull()
  })
})

function requestPath(input: RequestInfo | URL): string {
  return input instanceof Request
    ? input.url
    : input instanceof URL
      ? input.href
      : input
}

function testChannel(id: string, title: string) {
  return {
    id,
    taskId: id,
    userId: 'owner',
    originEventId: `event-${id}`,
    title,
    goal: `${title} goal`,
    status: 'started' as const,
    workerIconId: 'computer' as const,
    createdAt: '2026-11-19T08:00:00.000Z',
    updatedAt: '2026-11-19T08:03:00.000Z',
    latestActivityAt: '2026-11-19T08:03:00.000Z',
    canResume: false,
    canStop: true,
  }
}

function testMessage(id: string, taskId: string, text: string) {
  return {
    id,
    userId: 'owner',
    taskId,
    payload: { type: 'run.completed', text },
    status: 'sent' as const,
    createdAt: '2026-11-19T08:03:00.000Z',
  }
}

function parseRequestBody(
  init: RequestInit | undefined,
): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON body')
  return JSON.parse(init.body) as Record<string, unknown>
}
