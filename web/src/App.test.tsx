// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App, formatRelativeTime } from './App'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

describe('Pegas web app', () => {
  it('centralizes model, privacy, and rewriting choices in server settings', async () => {
    const settings = {
      revision: 1,
      routerMode: 'model' as const,
      modelProvider: 'codex-cli' as const,
      modelName: 'gpt-5.6-luna',
      privacyMode: 'disabled' as const,
      rewriteMode: 'disabled' as const,
      updatedAt: '2026-11-17T00:00:00.000Z',
    }
    const capabilities = {
      providers: [
        { id: 'codex-cli' as const, available: true },
        {
          id: 'openai-compatible' as const,
          available: false,
          reason: '服务端尚未配置兼容 API',
        },
      ],
      privacyAvailable: true,
    }
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
      if (path === '/v1/settings' && init?.method === 'PUT') {
        const body = parseRequestBody(init)
        return Promise.resolve(
          Response.json({
            settings: { ...settings, ...body, revision: 2 },
            capabilities,
          }),
        )
      }
      if (path === '/v1/settings') {
        return Promise.resolve(Response.json({ settings, capabilities }))
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
    fireEvent.click(screen.getByRole('button', { name: '设置' }))

    expect(
      await screen.findByRole('heading', { name: '设置', level: 1 }),
    ).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '偏好设置' })).toBeNull()
    expect(screen.queryByText('模型、语音与路由偏好')).toBeNull()
    expect(
      screen.queryByText('选择模型，调整 Pegas 理解和处理任务的方式。'),
    ).toBeNull()
    expect(screen.queryByRole('heading', { name: '语音输入' })).toBeNull()
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull()
    expect(screen.queryByRole('button', { name: '打开工作区' })).toBeNull()
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      '模型',
      '任务路由',
      '语音与输入',
      '隐私',
    ])
    fireEvent.keyDown(screen.getByRole('tab', { name: '模型' }), {
      key: 'ArrowRight',
    })
    expect(screen.getByRole('tab', { name: '任务路由' })).toHaveProperty(
      'tabIndex',
      0,
    )
    expect(screen.getByRole('radio', { name: /智能归类/ })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('tab', { name: '任务路由' }), {
      key: 'Home',
    })
    expect(
      screen.getByRole('radio', { name: /OpenAI-compatible/ }),
    ).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByRole('textbox', { name: /对应模型/ }), {
      target: { value: 'gpt-settings-test' },
    })
    fireEvent.click(screen.getByRole('tab', { name: '语音与输入' }))
    expect(screen.getByRole('heading', { name: '语音输入' })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /轻量校正/ }))
    fireEvent.click(screen.getByRole('tab', { name: '隐私' }))
    fireEvent.click(screen.getByRole('radio', { name: /开启脱敏/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    expect(await screen.findByText('设置已保存')).toBeTruthy()
    const put = fetchMock.mock.calls.find(
      ([path, init]) => path === '/v1/settings' && init?.method === 'PUT',
    )
    expect(parseRequestBody(put?.[1])).toMatchObject({
      expectedRevision: 1,
      modelName: 'gpt-settings-test',
      privacyMode: 'mask',
      rewriteMode: 'light',
    })
  })

  it('presents conversation as the primary entry', async () => {
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

    expect(
      await screen.findByRole('heading', { name: '现在想先推进什么？' }),
    ).toBeTruthy()
    expect(screen.getByRole('heading', { name: '对话', level: 1 })).toBeTruthy()
    expect(screen.getByLabelText('告诉 Pegas 你想完成什么')).toBeTruthy()
    expect(
      screen.getByText('高风险动作会先确认', { exact: false }),
    ).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: '工作区' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /研究并比较/ }))
    expect(screen.getByLabelText('告诉 Pegas 你想完成什么')).toHaveProperty(
      'value',
      '帮我研究并比较下面这个问题，最后给我一个建议：',
    )
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
    fireEvent.click(screen.getByRole('button', { name: /任务/ }))

    expect(
      await screen.findByRole('heading', { name: '任务看板' }),
    ).toBeTruthy()
    expect(screen.getByRole('heading', { name: '进行中' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '已完成' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '已取消' })).toBeTruthy()

    fireEvent.change(screen.getByRole('textbox', { name: '搜索任务' }), {
      target: { value: '发布' },
    })
    expect(
      screen.queryByRole('button', { name: '打开任务现场：检查测试结果' }),
    ).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索任务' }), {
      target: { value: '' },
    })
    expect(
      screen.getByRole('button', { name: '打开任务现场：检查测试结果' }),
    ).toBeTruthy()

    fireEvent.click(
      screen.getByRole('button', { name: '打开任务现场：整理发布说明' }),
    )
    expect(screen.getByRole('complementary', { name: '工作区' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '整理发布说明' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(screen.queryByRole('complementary', { name: '工作区' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '任务' }))
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
    fireEvent.click(screen.getByRole('button', { name: '任务' }))
    fireEvent.click(
      await screen.findByRole('button', { name: '打开任务现场：可重试的任务' }),
    )
    fireEvent.click(screen.getByRole('button', { name: '新建 Run 重试' }))
    expect(await screen.findByText('暂时无法重试')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '新建 Run 重试' }))
    expect(await screen.findByText('Run 2')).toBeTruthy()
    expect(screen.getByText('Run 1')).toBeTruthy()
    expect(screen.getByText('provider timeout')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '新建 Run 重试' })).toBeNull()
    expect(
      screen.getAllByRole('button', { name: '打开任务现场：可重试的任务' }),
    ).toHaveLength(1)
  })

  it('formats recent updates in conversational language', () => {
    const now = new Date('2026-11-16T10:00:00.000Z').getTime()
    expect(formatRelativeTime('2026-11-16T09:58:00.000Z', now)).toBe('2分钟前')
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

function parseRequestBody(
  init: RequestInit | undefined,
): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON body')
  return JSON.parse(init.body) as Record<string, unknown>
}
