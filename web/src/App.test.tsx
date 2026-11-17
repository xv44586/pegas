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
})

describe('Pegas web app', () => {
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
      await screen.findByRole('heading', { name: '和 Pegas 说点什么' }),
    ).toBeTruthy()
    expect(screen.getByLabelText('告诉 Pegas 你想完成什么')).toBeTruthy()
    expect(
      screen.getByRole('complementary', { name: '任务工作台' }),
    ).toBeTruthy()
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
