// @vitest-environment jsdom

import '../test-env'

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../App'
import type {
  InboxEvent,
  OutboxMessage,
  Run,
  Snapshot,
  WorkChannel,
} from '../types'
import {
  formatRunDuration,
  isRunProgressMessage,
  latestRunProgressText,
} from './types'

const channel: WorkChannel = {
  id: 'task-1',
  taskId: 'task-1',
  userId: 'owner',
  originEventId: 'event-1',
  title: '整理季度数据',
  goal: '把季度数据整理成报表',
  status: 'started',
  workerIconId: 'computer',
  canResume: false,
  canStop: true,
  latestActivityAt: '2026-11-22T08:00:00.000Z',
  createdAt: '2026-11-22T07:00:00.000Z',
  updatedAt: '2026-11-22T08:00:00.000Z',
}

const runningRun: Run = {
  id: 'run-1',
  taskId: channel.id,
  executor: 'dsh',
  status: 'running',
  input: channel.goal,
  attempts: 1,
  executionContext: { executor: 'dsh' },
  createdAt: '2026-11-22T08:00:00.000Z',
  updatedAt: '2026-11-22T08:02:00.000Z',
}

const baseSnapshot: Snapshot = {
  channels: [channel],
  runs: [runningRun],
  events: [
    {
      id: 'event-1',
      userId: 'owner',
      type: 'user.message',
      source: 'web',
      payload: { text: '帮我整理季度数据' },
      status: 'processed',
      createdAt: '2026-11-22T07:59:00.000Z',
    },
  ],
  messages: [
    {
      id: 'message-progress',
      userId: 'owner',
      taskId: channel.id,
      payload: {
        type: 'run.acknowledged',
        taskId: channel.id,
        runId: 'run-1',
        text: '正在核对数据来源',
      },
      status: 'sent',
      createdAt: '2026-11-22T08:01:00.000Z',
    },
  ],
}

const baseEvent: InboxEvent = {
  id: 'event-1',
  userId: 'owner',
  type: 'user.message',
  source: 'web',
  payload: { text: '帮我整理季度数据' },
  status: 'processed',
  createdAt: '2026-11-22T07:59:00.000Z',
}

const baseMessage: OutboxMessage = {
  id: 'message-progress',
  userId: 'owner',
  taskId: channel.id,
  payload: {
    type: 'run.acknowledged',
    taskId: channel.id,
    runId: 'run-1',
    text: '正在核对数据来源',
  },
  status: 'sent',
  createdAt: '2026-11-22T08:01:00.000Z',
}

function installChatFetch(
  snapshot: Snapshot,
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
      const params = new URL(path, 'http://localhost').searchParams
      const channels = snapshot.channels.filter(
        channel =>
          (!params.has('pinned') ||
            Boolean(channel.organization?.pinned) ===
              (params.get('pinned') === 'true')) &&
          (!params.has('archived') ||
            Boolean(channel.organization?.archived) ===
              (params.get('archived') === 'true')),
      )
      return Promise.resolve(Response.json({ channels, matches: [] }))
    }
    if (path.startsWith('/v1/channels?'))
      return Promise.resolve(Response.json({ channels: snapshot.channels }))
    if (path.startsWith('/v1/runs?'))
      return Promise.resolve(Response.json({ runs: snapshot.runs }))
    if (path.startsWith('/v1/outbox?'))
      return Promise.resolve(Response.json({ messages: snapshot.messages }))
    if (path.startsWith('/v1/usage?'))
      return Promise.resolve(
        Response.json({
          summary: { inputTokens: 0, outputTokens: 0 },
          records: [],
        }),
      )
    if (path === '/v1/settings')
      return Promise.resolve(
        Response.json({
          settings: {
            revision: 1,
            routerModelProvider: 'Magpie',
            routerModelName: 'router',
            agentModelMode: 'profile',
            agentModelProvider: 'Magpie',
            agentModelName: 'deepseek-v4.1-flash',
          },
          capabilities: {},
        }),
      )
    if (path === '/v1/settings/agent-models')
      return Promise.resolve(
        Response.json({
          provider: 'Magpie',
          models: [
            {
              id: 'deepseek-v4.1-flash',
              name: 'DeepSeek V4.1 Flash',
              provider: 'Magpie',
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
            createdAt: '2026-11-22T09:00:00.000Z',
          },
          inserted: true,
        }),
      )
    if (path.includes('/retry'))
      return Promise.resolve(
        Response.json({
          event: {
            ...snapshot.events[0],
            status: 'pending',
          },
        }),
      )
    if (path.includes('/stop'))
      return Promise.resolve(Response.json({ ok: true }))
    if (path.includes('/read'))
      return Promise.resolve(Response.json({ ok: true }))
    return Promise.resolve(
      Response.json({ message: `Unhandled ${path}` }, { status: 404 }),
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
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

describe('CONV-002 task conversation', () => {
  function installTaskHistory(
    options: {
      eventCount?: number
      stopped?: boolean
      failPage?: boolean
      noRecents?: boolean
      loop?: boolean
    } = {},
    custom?: Parameters<typeof installChatFetch>[1],
  ) {
    const events = Array.from(
      { length: options.eventCount ?? 3 },
      (_, index) => ({
        ...baseEvent,
        id: `history-${String(index)}`,
        payload: { text: `事情内输入 ${String(index)}` },
      }),
    )
    const task = {
      ...channel,
      ...(options.stopped
        ? { status: 'cancelled' as const, canStop: false }
        : {}),
    }
    const mock = installChatFetch(
      { ...baseSnapshot, channels: options.noRecents ? [] : [task] },
      (path, init) => {
        const overridden = custom?.(path, init)
        if (overridden) return overridden
        if (path.startsWith(`/v1/channels/${channel.id}/timeline?`)) {
          const cursor = new URL(path, 'http://localhost').searchParams.get(
            'cursor',
          )
          if (cursor && options.failPage)
            return Response.json({ message: '历史续页失败' }, { status: 503 })
          return Response.json({
            channel: task,
            events: cursor ? events.slice(199) : events.slice(0, 200),
            messages: [
              {
                ...baseMessage,
                id: 'task-answer',
                payload: { type: 'agent.message', text: '这件事的回复' },
              },
            ],
            runs: [],
            ...((!cursor && events.length > 200) || options.loop
              ? { nextCursor: 'history-199' }
              : {}),
          })
        }
        return undefined
      },
    )
    return { mock, options }
  }

  it('removes redundant reply and origin arrows only in the task conversation', async () => {
    installTaskHistory({}, path =>
      path.includes('/timeline?')
        ? Response.json({
            channel,
            events: [baseEvent],
            runs: [],
            messages: [
              {
                ...baseMessage,
                projection: {
                  lane: 'work',
                  weight: 'card',
                  anchor: { taskId: channel.id, eventId: baseEvent.id },
                },
                payload: {
                  type: 'agent.message',
                  text: '可以直接继续聊天的回复',
                },
              },
            ],
          })
        : undefined,
    )
    window.history.replaceState({}, '', '/?task=task-1')
    render(<App />)
    await screen.findByText('可以直接继续聊天的回复')
    expect(screen.queryByRole('button', { name: '追问这条回复' })).toBeNull()
    expect(screen.queryByRole('button', { name: '回到发起消息' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '复制消息' })).toHaveLength(2)
  })

  it('shows every page of execution details chronologically in the main conversation without opening the inspector', async () => {
    const entries = Array.from({ length: 401 }, (_, index) => ({
      seq: index + 1,
      kind: 'text',
      label: `执行中间结果 ${String(index + 1)}`,
      detail: `执行中间结果 ${String(index + 1)}`,
      createdAt:
        index === 0 ? '2026-11-22T08:00:01.000Z' : '2026-11-22T08:02:00.000Z',
      updatedAt: runningRun.updatedAt,
    }))
    const { mock } = installTaskHistory({}, path => {
      if (path.includes('/timeline?'))
        return Response.json({
          channel,
          events: [baseEvent],
          messages: [
            {
              ...baseMessage,
              payload: { type: 'agent.message', text: '中途汇报' },
            },
          ],
          runs: [runningRun],
        })
      if (path.includes('/run-1/activity?')) {
        const earlier = path.includes('beforeSeq=2')
        return Response.json({
          runId: 'run-1',
          taskId: 'task-1',
          totalEntries: 401,
          entries: earlier ? entries.slice(0, 1) : entries.slice(1),
          truncated: true,
          ...(!earlier ? { nextBeforeSeq: 2 } : {}),
        })
      }
      if (path.includes('/run-1/subagents?'))
        return Response.json({
          runId: 'run-1',
          taskId: 'task-1',
          subagents: [],
        })
      return undefined
    })
    window.history.replaceState({}, '', '/?task=task-1')
    render(<App />)
    const first = await screen.findByText('执行中间结果 1')
    const last = await screen.findByText('执行中间结果 401')
    const reply = screen.getByText('中途汇报')
    expect(first.closest('.conversation-flow')).toBeTruthy()
    expect(
      first.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      reply.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      mock.mock.calls.some(
        ([path]) => typeof path === 'string' && path.includes('beforeSeq=2'),
      ),
    ).toBe(true)
    expect(screen.queryByRole('tab', { name: '执行记录' })).toBeNull()
  })

  it('opens an isolated page from recents and reads every history page without duplicates', async () => {
    const { mock } = installTaskHistory({ eventCount: 205 })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: channel.title }))
    expect(
      await screen.findByRole('heading', { name: channel.title, level: 1 }),
    ).toBeTruthy()
    expect(await screen.findByText('事情内输入 204')).toBeTruthy()
    expect(screen.getAllByText('事情内输入 199')).toHaveLength(1)
    expect(screen.queryByText('帮我整理季度数据')).toBeNull()
    expect(screen.queryByRole('group', { name: '进行中的事情' })).toBeNull()
    expect(screen.queryByText('继续事情：')).toBeNull()
    expect(
      mock.mock.calls.some(
        ([path]) =>
          typeof path === 'string' && path.includes('cursor=history-199'),
      ),
    ).toBe(true)
  })

  it('keeps successive sends targeted and restores separate main and task drafts', async () => {
    const { mock } = installTaskHistory()
    render(<App />)
    const mainInput = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(mainInput, { target: { value: '主聊天草稿' } })
    fireEvent.click(await screen.findByRole('button', { name: channel.title }))
    const input = await screen.findByLabelText('就这件事继续聊天')
    for (const text of ['第一次补充', '第二次补充']) {
      fireEvent.change(input, { target: { value: text } })
      fireEvent.click(screen.getByRole('button', { name: '发送' }))
      await waitFor(() => expect(input).toHaveProperty('value', ''))
    }
    const sends = mock.mock.calls.filter(
      ([path, init]) => path === '/v1/events' && init?.method === 'POST',
    )
    expect(sends).toHaveLength(2)
    for (const [, init] of sends)
      expect(
        (
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
            dedupeKey?: string
            payload?: { taskId?: string; replyToMessageId?: string }
          }
        ).payload?.taskId,
      ).toBe(channel.id)
    fireEvent.change(input, { target: { value: '事情草稿' } })
    fireEvent.click(
      within(screen.getByLabelText('主导航')).getByRole('button', {
        name: '对话',
      }),
    )
    expect(await screen.findByLabelText('给 Pegas 发消息')).toHaveProperty(
      'value',
      '主聊天草稿',
    )
    fireEvent.click(await screen.findByRole('button', { name: channel.title }))
    expect(await screen.findByLabelText('就这件事继续聊天')).toHaveProperty(
      'value',
      '事情草稿',
    )
  })

  it('restores a direct task URL even outside the recent list', async () => {
    installTaskHistory({ noRecents: true })
    window.history.replaceState(
      {},
      '',
      `/?view=conversation&task=${channel.id}`,
    )
    render(<App />)
    expect(await screen.findByText('事情内输入 2')).toBeTruthy()
    expect(screen.getByLabelText('就这件事继续聊天')).toBeTruthy()
  })

  it('makes a stopped task read-only', async () => {
    installTaskHistory({ stopped: true })
    window.history.replaceState({}, '', `/?task=${channel.id}`)
    render(<App />)
    expect(await screen.findByText('事情内输入 2')).toBeTruthy()
    expect(screen.getByLabelText('就这件事继续聊天')).toHaveProperty(
      'disabled',
      true,
    )
  })

  it('does not silently present truncated history when a later page fails', async () => {
    const { options } = installTaskHistory({ failPage: true, eventCount: 205 })
    window.history.replaceState({}, '', `/?task=${channel.id}`)
    render(<App />)
    expect(
      await screen.findByRole('button', { name: '重新读取事情历史' }),
    ).toBeTruthy()
    options.failPage = false
    fireEvent.click(screen.getByRole('button', { name: '重新读取事情历史' }))
    expect(await screen.findByText('事情内输入 204')).toBeTruthy()
  })
  it('fails visibly on a repeated history cursor instead of looping', async () => {
    const { mock } = installTaskHistory({ loop: true })
    window.history.replaceState({}, '', '/?task=task-1')
    render(<App />)
    expect(await screen.findByText(/游标未前进/)).toBeTruthy()
    expect(
      mock.mock.calls.filter(
        ([path]) => typeof path === 'string' && path.includes('/timeline?'),
      ),
    ).toHaveLength(2)
    expect(screen.queryByLabelText('就这件事继续聊天')).toBeNull()
  })

  it('does not display a foreign task response or fall back to main chat', async () => {
    installTaskHistory({}, path =>
      path.includes('/timeline?')
        ? Response.json({
            channel: { ...channel, id: 'foreign' },
            events: [baseEvent],
            messages: [baseMessage],
            runs: [],
          })
        : undefined,
    )
    window.history.replaceState({}, '', '/?task=task-1')
    render(<App />)
    expect(
      await screen.findByRole('button', { name: '重新读取事情历史' }),
    ).toBeTruthy()
    expect(screen.queryByText('帮我整理季度数据')).toBeNull()
    expect(screen.queryByLabelText('给 Pegas 发消息')).toBeNull()
  })

  it('keeps the same dedupe key and quoted target after a failed send and page switch', async () => {
    let fail = true
    const { mock } = installTaskHistory({}, (path, init) =>
      path === '/v1/events' && init?.method === 'POST' && fail
        ? Response.json({ message: '临时离线' }, { status: 503 })
        : undefined,
    )
    window.history.replaceState({}, '', '/?task=task-1')
    sessionStorage.setItem(
      'pegas-task-draft:task-1',
      JSON.stringify({
        text: '',
        quote: { kind: 'reply', id: 'task-answer', text: '这件事的回复' },
      }),
    )
    render(<App />)
    await screen.findByLabelText('就这件事继续聊天')
    fireEvent.change(screen.getByLabelText('就这件事继续聊天'), {
      target: { value: '引用追问草稿' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText('临时离线')
    fireEvent.click(
      within(screen.getByLabelText('主导航')).getByRole('button', {
        name: '对话',
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: channel.title }))
    const input = await screen.findByLabelText('就这件事继续聊天')
    expect(input).toHaveProperty('value', '引用追问草稿')
    expect(screen.getByRole('button', { name: '取消引用回复' })).toBeTruthy()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(input).toHaveProperty('value', ''))
    fireEvent.change(input, { target: { value: '普通续聊' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(input).toHaveProperty('value', ''))
    const bodies = mock.mock.calls
      .filter(
        ([path, init]) => path === '/v1/events' && init?.method === 'POST',
      )
      .map(
        ([, init]) =>
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
            dedupeKey?: string
            payload?: { taskId?: string; replyToMessageId?: string }
          },
      )
    expect(bodies).toHaveLength(3)
    expect(bodies[0]?.dedupeKey).toBe(bodies[1]?.dedupeKey)
    expect(bodies[1]?.payload?.replyToMessageId).toBe('task-answer')
    expect(bodies[2]?.payload?.taskId).toBe('task-1')
  })

  it('retains accepted-send semantics when refreshing history fails', async () => {
    const options = { failPage: false, eventCount: 205 }
    const { mock } = installTaskHistory(options, (path, init) => {
      if (path === '/v1/events' && init?.method === 'POST')
        options.failPage = true
      return undefined
    })
    window.history.replaceState({}, '', '/?task=task-1')
    render(<App />)
    const input = await screen.findByLabelText('就这件事继续聊天')
    fireEvent.change(input, { target: { value: '已经送达' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByRole('button', { name: '重新读取事情历史' })
    expect(input).toHaveProperty('value', '')
    expect(screen.getByText('事情内输入 204')).toBeTruthy()
    options.failPage = false
    fireEvent.click(screen.getByRole('button', { name: '重新读取事情历史' }))
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: '重新读取事情历史' }),
      ).toBeNull(),
    )
    expect(
      mock.mock.calls.filter(
        ([path, init]) => path === '/v1/events' && init?.method === 'POST',
      ),
    ).toHaveLength(1)
  })

  it('keeps the task fixed when typing @ or /auto and removes redundant task links', async () => {
    installTaskHistory()
    window.history.replaceState({}, '', '/?task=task-1')
    render(<App />)
    const input = await screen.findByLabelText('就这件事继续聊天')
    expect(screen.queryByRole('button', { name: '查看工作详情' })).toBeNull()
    expect(screen.queryByRole('button', { name: '快速回复' })).toBeNull()
    fireEvent.change(input, { target: { value: '@另一件事' } })
    expect(screen.queryByRole('option')).toBeNull()
    fireEvent.change(input, { target: { value: '/auto' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText(/此页始终在当前事情内聊天/)).toBeTruthy()
    expect(input).toHaveProperty('value', '/auto')
  })

  it('ignores an old task response when navigating between task URLs and restores the correct draft', async () => {
    let resolveFirst: ((value: Response) => void) | undefined
    const delayed = new Promise<Response>(resolve => {
      resolveFirst = resolve
    })
    installTaskHistory({}, path => {
      if (path.includes('/task-1/timeline?')) return delayed
      if (path.includes('/task-2/timeline?'))
        return Response.json({
          channel: { ...channel, id: 'task-2', title: '第二件事' },
          events: [
            { ...baseEvent, id: 'second', payload: { text: '第二件事的历史' } },
          ],
          messages: [],
          runs: [],
        })
      return undefined
    })
    window.history.replaceState({}, '', '/?task=task-1')
    render(<App />)
    await screen.findByText('正在读取完整事情历史…')
    window.history.pushState({}, '', '/?task=task-2')
    fireEvent.popState(window)
    const input = await screen.findByLabelText('就这件事继续聊天')
    fireEvent.change(input, { target: { value: '第二件事草稿' } })
    resolveFirst?.(
      Response.json({
        channel,
        events: [{ ...baseEvent, payload: { text: '不应串入的历史' } }],
        messages: [],
        runs: [],
      }),
    )
    await waitFor(() => expect(screen.getByText('第二件事的历史')).toBeTruthy())
    expect(screen.queryByText('不应串入的历史')).toBeNull()
    window.history.pushState({}, '', '/')
    fireEvent.popState(window)
    expect(await screen.findByLabelText('给 Pegas 发消息')).toHaveProperty(
      'value',
      '',
    )
    window.history.pushState({}, '', '/?task=task-2')
    fireEvent.popState(window)
    expect(await screen.findByLabelText('就这件事继续聊天')).toHaveProperty(
      'value',
      '第二件事草稿',
    )
  })

  it('adds one browser history entry per recent task selection', async () => {
    installTaskHistory()
    render(<App />)
    const recent = await screen.findByRole('button', { name: channel.title })
    const length = window.history.length
    fireEvent.click(recent)
    await screen.findByLabelText('就这件事继续聊天')
    expect(window.history.length).toBe(length + 1)
    expect(new URLSearchParams(window.location.search).get('task')).toBe(
      channel.id,
    )
  })

  it('retries only the attachment after its message was accepted', async () => {
    let uploads = 0
    const { mock } = installTaskHistory({}, (path, init) => {
      if (path.includes('/event-new/attachment') && init?.method === 'POST') {
        uploads += 1
        return uploads === 1
          ? Response.json({ message: '附件上传暂时失败' }, { status: 503 })
          : Response.json({ ok: true })
      }
      return undefined
    })
    window.history.replaceState({}, '', '/?task=task-1')
    render(<App />)
    const input = await screen.findByLabelText('就这件事继续聊天')
    fireEvent.change(screen.getByLabelText('选择附件文件'), {
      target: {
        files: [new File(['evidence'], 'evidence.txt', { type: 'text/plain' })],
      },
    })
    fireEvent.change(input, { target: { value: '请看附件' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    const retry = await screen.findByRole('button', { name: '重试上传附件' })
    await waitFor(() => expect(retry).toHaveProperty('disabled', false))
    expect(input).toHaveProperty('value', '')
    fireEvent.click(retry)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '重试上传附件' })).toBeNull(),
    )
    expect(uploads).toBe(2)
    expect(
      mock.mock.calls.filter(
        ([path, init]) => path === '/v1/events' && init?.method === 'POST',
      ),
    ).toHaveLength(1)
  })

  it('does not expose or send another task queued draft', async () => {
    const queued = [
      {
        id: 'other-queued',
        text: '另一件事的排队稿',
        channel: { ...channel, id: 'task-other' },
      },
    ]
    sessionStorage.setItem('pegas-queued-messages', JSON.stringify(queued))
    const { mock } = installTaskHistory()
    window.history.replaceState({}, '', '/?task=task-1')
    render(<App />)
    await screen.findByLabelText('就这件事继续聊天')
    expect(screen.queryByLabelText('排队消息')).toBeNull()
    expect(sessionStorage.getItem('pegas-queued-messages')).toBe(
      JSON.stringify(queued),
    )
    expect(
      mock.mock.calls.filter(
        ([path, init]) => path === '/v1/events' && init?.method === 'POST',
      ),
    ).toHaveLength(0)
  })

  it('searches only the complete task history without losing the draft', async () => {
    const { mock } = installTaskHistory({ eventCount: 205 })
    window.history.replaceState({}, '', '/?task=task-1')
    render(<App />)
    const composer = await screen.findByLabelText('就这件事继续聊天')
    fireEvent.change(composer, { target: { value: '继续聊的草稿' } })
    expect(screen.queryByRole('button', { name: '全局搜索' })).toBeNull()
    expect(screen.queryByRole('button', { name: /切换到.*外观/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '搜索当前事情' }))
    const dialog = await screen.findByRole('dialog', { name: '搜索当前事情' })
    const search = within(dialog).getByRole('searchbox', {
      name: '搜索当前事情的对话',
    })
    fireEvent.change(search, { target: { value: '这件事的回复' } })
    expect(
      within(dialog).getByRole('button', { name: /定位消息：这件事的回复/ }),
    ).toBeTruthy()
    fireEvent.change(search, { target: { value: '事情内输入 204' } })
    expect(within(dialog).getByText('找到 1 条消息')).toBeTruthy()
    fireEvent.click(
      within(dialog).getByRole('button', { name: /定位消息：事情内输入 204/ }),
    )
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-message-id')).toBe(
        'history-204',
      ),
    )
    expect(composer).toHaveProperty('value', '继续聊的草稿')
    expect(window.location.search).toBe('?task=task-1')
    expect(
      mock.mock.calls.some(
        ([path]) =>
          typeof path === 'string' &&
          path.includes('/search') &&
          new URL(path, 'http://localhost').searchParams.has('q'),
      ),
    ).toBe(false)
  })

  it('searches folded message text and restores focus when cancelling', async () => {
    const longText = '可折叠的历史正文。'.repeat(100) + '末尾核对暗号'
    installTaskHistory({}, path =>
      path.includes('/timeline?')
        ? Response.json({
            channel,
            events: [
              { ...baseEvent, id: 'long-input', payload: { text: longText } },
            ],
            messages: [],
            runs: [],
          })
        : undefined,
    )
    window.history.replaceState({}, '', '/?task=task-1')
    render(<App />)
    const toggle = await screen.findByRole('button', { name: '搜索当前事情' })
    fireEvent.click(toggle)
    let dialog = await screen.findByRole('dialog', { name: '搜索当前事情' })
    fireEvent.change(within(dialog).getByRole('searchbox'), {
      target: { value: '另一件事的内容' },
    })
    expect(within(dialog).getByText('当前事情中没有匹配的消息。')).toBeTruthy()
    fireEvent.click(
      within(dialog).getByRole('button', { name: '关闭事情搜索' }),
    )
    await waitFor(() => expect(document.activeElement).toBe(toggle))
    fireEvent.click(toggle)
    dialog = await screen.findByRole('dialog', { name: '搜索当前事情' })
    fireEvent.change(within(dialog).getByRole('searchbox'), {
      target: { value: '末尾核对暗号' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: /定位消息/ }))
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain('末尾核对暗号'),
    )
    expect(screen.queryByRole('dialog', { name: '搜索当前事情' })).toBeNull()
  })

  it('keeps the inspector latest run open while full histories also load in the conversation', async () => {
    const { mock } = installTaskHistory({}, path => {
      if (path.includes('/timeline?'))
        return Response.json({
          channel,
          events: [],
          messages: [],
          runs: [
            {
              ...runningRun,
              id: 'old-run',
              createdAt: '2026-11-21T08:00:00.000Z',
            },
            runningRun,
          ],
        })
      if (path.includes('/run-1/activity'))
        return Response.json({
          runId: 'run-1',
          taskId: 'task-1',
          totalEntries: 1,
          truncated: false,
          entries: [
            {
              seq: 1,
              kind: 'thinking',
              label: '先核对口径',
              detail: '先核对口径，再汇总变化。',
              createdAt: runningRun.createdAt,
              updatedAt: runningRun.updatedAt,
            },
          ],
        })
      return undefined
    })
    window.history.replaceState({}, '', '/?task=task-1')
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '展开事情信息' }))
    expect(
      mock.mock.calls.some(
        ([path]) => typeof path === 'string' && path.includes('/activity'),
      ),
    ).toBe(true)
    fireEvent.mouseDown(screen.getByRole('tab', { name: '执行记录' }), {
      button: 0,
      ctrlKey: false,
    })
    const latest = await screen.findByText('执行过程 · 最新一次')
    expect(latest.closest('details')?.open).toBe(true)
    expect(
      screen.getByText('执行过程 · 历史执行').closest('details')?.open,
    ).toBe(false)
    expect(
      await within(latest.closest('details') ?? latest).findByText(
        '先核对口径，再汇总变化。',
      ),
    ).toBeTruthy()
    expect(
      mock.mock.calls.some(
        ([path]) =>
          typeof path === 'string' && path.includes('/old-run/activity'),
      ),
    ).toBe(true)
  })

  it('moves task message traces into execution records and opens the exact input trace', async () => {
    const { mock } = installTaskHistory()
    window.history.replaceState({}, '', '/?task=task-1')
    render(<App />)
    await screen.findByLabelText('就这件事继续聊天')
    expect(screen.queryByRole('button', { name: '查看调用链' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开事情信息' }))
    fireEvent.mouseDown(screen.getByRole('tab', { name: '执行记录' }), {
      button: 0,
      ctrlKey: false,
    })
    const summary = screen.getByText(/消息调用链/).closest('summary')
    if (!summary) throw new Error('Expected trace disclosure')
    fireEvent.click(summary)
    fireEvent.click(
      screen.getByRole('button', { name: '查看调用链：事情内输入 1' }),
    )
    expect(await screen.findByRole('dialog', { name: '调用链' })).toBeTruthy()
    await waitFor(() =>
      expect(
        mock.mock.calls.some(
          ([path]) =>
            typeof path === 'string' && path.includes('/history-1/trace'),
        ),
      ).toBe(true),
    )
  })

  it.each([390, 1440])(
    'keeps the selected inspector tab after close/reopen at width %i',
    async width => {
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width)
      installTaskHistory()
      window.history.replaceState({}, '', '/?task=task-1')
      render(<App />)
      await screen.findByLabelText('就这件事继续聊天')
      if (width < 1200)
        fireEvent.click(screen.getByRole('button', { name: '展开事情信息' }))
      expect(
        screen
          .getByRole('button', { name: '收起事情信息', hidden: width < 1200 })
          .getAttribute('aria-expanded'),
      ).toBe('true')
      fireEvent.mouseDown(screen.getByRole('tab', { name: '执行记录' }), {
        button: 0,
        ctrlKey: false,
      })
      fireEvent.click(screen.getByRole('button', { name: '关闭事情信息' }))
      const toggle = screen.getByRole('button', { name: '展开事情信息' })
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      await waitFor(() => expect(document.activeElement).toBe(toggle))
      fireEvent.click(toggle)
      expect(
        screen
          .getByRole('tab', { name: '执行记录' })
          .getAttribute('aria-selected'),
      ).toBe('true')
      if (width >= 1200) {
        fireEvent.click(screen.getByRole('button', { name: '收起事情信息' }))
        fireEvent.click(screen.getByRole('button', { name: '展开事情信息' }))
        expect(
          screen
            .getByRole('tab', { name: '执行记录' })
            .getAttribute('aria-selected'),
        ).toBe('true')
      }
    },
  )

  it('offers the four supported inspector tabs with expandable execution history', async () => {
    installTaskHistory({}, path => {
      if (path.includes('/timeline?'))
        return Response.json({
          channel,
          events: [],
          messages: [],
          runs: [runningRun],
        })
      if (path.includes('/delivery?'))
        return Response.json({ artifacts: [], evidence: [] })
      if (path.includes('/run-1/activity'))
        return Response.json({
          runId: 'run-1',
          taskId: 'task-1',
          entries: [],
          totalEntries: 2,
          truncated: true,
        })
      return undefined
    })
    window.history.replaceState({}, '', '/?task=task-1')
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '展开事情信息' }))
    for (const name of ['概览', '交付', '执行记录', '设置'])
      expect(screen.getByRole('tab', { name })).toBeTruthy()
    fireEvent.mouseDown(screen.getByRole('tab', { name: '执行记录' }), {
      button: 0,
      ctrlKey: false,
    })
    const record = await screen.findByText('进行中', { selector: 'strong' })
    const summary = record.closest('summary')
    const details = record.closest('details')
    if (!summary || !details) throw new Error('Expected expandable Run')
    expect(details.open).toBe(true)
    expect(await screen.findByText(/0 \/ 2 条记录/)).toBeTruthy()
  })
})

describe('DESIGN-003 run progress projection', () => {
  it('identifies run.acknowledged messages and picks the latest text per run', () => {
    const older = {
      ...baseMessage,
      id: 'progress-old',
      createdAt: '2026-11-22T08:00:30.000Z',
      payload: {
        type: 'run.acknowledged',
        runId: 'run-1',
        text: '开始处理',
      },
    }
    const newer = baseMessage
    const otherRun = {
      ...newer,
      id: 'progress-other',
      payload: { type: 'run.acknowledged', runId: 'run-2', text: '别的事情' },
    }
    expect(isRunProgressMessage(newer)).toBe(true)
    expect(
      isRunProgressMessage({ ...newer, payload: { type: 'run.completed' } }),
    ).toBe(false)
    expect(latestRunProgressText([older, newer, otherRun], 'run-1')).toBe(
      '正在核对数据来源',
    )
    expect(latestRunProgressText([older, newer], 'run-missing')).toBeUndefined()
  })

  it('formats run durations honestly across scales', () => {
    const run = (created: string, updated: string): Run => ({
      ...runningRun,
      createdAt: created,
      updatedAt: updated,
    })
    expect(
      formatRunDuration(run('2026-11-22T08:00:00Z', '2026-11-22T08:00:42Z')),
    ).toBe('42 秒')
    expect(
      formatRunDuration(run('2026-11-22T08:00:00Z', '2026-11-22T08:05:00Z')),
    ).toBe('5 分钟')
    expect(
      formatRunDuration(run('2026-11-22T08:00:00Z', '2026-11-22T08:01:05Z')),
    ).toBe('1 分 5 秒')
    expect(
      formatRunDuration(run('2026-11-22T08:00:00Z', '2026-11-22T10:03:00Z')),
    ).toBe('2 小时 3 分')
    expect(
      formatRunDuration(run('2026-11-22T08:05:00Z', '2026-11-22T08:00:00Z')),
    ).toBe('')
  })
})

describe('DESIGN-003 chat page', () => {
  it('folds run progress into the status bar instead of a chat bubble', async () => {
    installChatFetch(baseSnapshot)
    render(<App />)
    const bar = await screen.findByRole('button', {
      name: /进行中 · 整理季度数据/,
    })
    expect(bar.getAttribute('aria-label')).toContain('正在核对数据来源')
    expect(
      bar.querySelector('img[data-pose="working"]')?.getAttribute('src'),
    ).toBe('/brand/pegas-flight.svg')
    expect(
      screen.queryByText('正在核对数据来源', {
        selector: '.message-content *',
      }),
    ).toBeNull()
    expect(document.querySelector('.run-status-card[data-active]')).toBeTruthy()
  })

  it.each(['queued', 'waiting', 'completed', 'failed', 'cancelled'] as const)(
    'keeps the %s run from showing the flight animation',
    async status => {
      installChatFetch({
        ...baseSnapshot,
        runs: [{ ...runningRun, status }],
      })
      render(<App />)
      const bar = await waitFor(() => {
        const element = document.querySelector('.run-status-bar')
        expect(element).not.toBeNull()
        return element
      })
      expect(bar?.querySelector('img[data-pose="working"]')).toBeNull()
    },
  )

  it('CONV-006: keeps server-marked silent facts out of the chat stream', async () => {
    const projected: Snapshot = {
      ...baseSnapshot,
      messages: [
        {
          ...baseMessage,
          projection: {
            lane: 'work',
            weight: 'silent',
            anchor: { taskId: channel.id, eventId: 'event-1' },
          },
        },
        {
          id: 'message-future-silent',
          userId: 'owner',
          taskId: channel.id,
          payload: { type: 'future.process', text: '过程噪声不应出现' },
          status: 'sent',
          createdAt: '2026-11-22T08:01:30.000Z',
          projection: { lane: 'work', weight: 'silent' },
        },
        {
          id: 'message-say',
          userId: 'owner',
          taskId: channel.id,
          payload: { type: 'run.completed', text: '报表已完成' },
          status: 'sent',
          createdAt: '2026-11-22T08:03:00.000Z',
          projection: {
            lane: 'work',
            weight: 'card',
            anchor: { taskId: channel.id, eventId: 'event-1' },
          },
        },
      ],
    }
    installChatFetch(projected)
    render(<App />)
    expect(await screen.findByText('报表已完成')).toBeTruthy()
    expect(screen.queryByText('过程噪声不应出现')).toBeNull()
    expect(
      screen.queryByText('正在核对数据来源', {
        selector: '.message-content *',
      }),
    ).toBeNull()
  })

  it('CONV-006: old servers without projection keep the legacy filter', async () => {
    installChatFetch(baseSnapshot)
    render(<App />)
    const bar = await screen.findByRole('button', {
      name: /进行中 · 整理季度数据/,
    })
    expect(bar.getAttribute('aria-label')).toContain('正在核对数据来源')
    expect(
      screen.queryByText('正在核对数据来源', {
        selector: '.message-content *',
      }),
    ).toBeNull()
  })

  it('EXEC-005: renders a streaming say draft in place and settles without a duplicate bubble', async () => {
    const streamingMessage: OutboxMessage = {
      id: 'message-say-stream',
      userId: 'owner',
      taskId: channel.id,
      payload: {
        type: 'agent.message',
        taskId: channel.id,
        runId: 'run-chat',
        text: '今天是',
        streaming: true,
      },
      status: 'sent',
      createdAt: '2026-11-22T08:01:00.000Z',
      projection: {
        lane: 'say',
        weight: 'inline',
        anchor: { taskId: channel.id, eventId: 'event-1' },
      },
    }
    const snapshot: Snapshot = {
      ...baseSnapshot,
      messages: [streamingMessage],
    }
    installChatFetch(snapshot)
    render(<App />)
    expect(await screen.findByText('今天是')).toBeTruthy()
    expect(screen.getByRole('status', { name: '正在输入' })).toBeTruthy()
    snapshot.messages = [
      {
        ...streamingMessage,
        payload: {
          type: 'agent.message',
          taskId: channel.id,
          runId: 'run-chat',
          text: '今天是星期六。',
        },
      },
      {
        id: 'message-chat-completed',
        userId: 'owner',
        taskId: channel.id,
        payload: {
          type: 'run.completed',
          taskId: channel.id,
          runId: 'run-chat',
        },
        status: 'sent',
        createdAt: '2026-11-22T08:02:00.000Z',
        projection: {
          lane: 'work',
          weight: 'silent',
          anchor: { taskId: channel.id, eventId: 'event-1' },
        },
      },
    ]
    await waitFor(
      () => {
        expect(screen.getByText('今天是星期六。')).toBeTruthy()
      },
      { timeout: 8_000 },
    )
    expect(screen.queryByRole('status', { name: '正在输入' })).toBeNull()
    expect(screen.getAllByText('今天是星期六。')).toHaveLength(1)
  }, 15_000)

  it('CONV-006: renders decide facts as action cards and marks them resolved', async () => {
    const decideSnapshot: Snapshot = {
      ...baseSnapshot,
      runs: [{ ...runningRun, status: 'waiting' }],
      messages: [
        {
          id: 'message-approval',
          userId: 'owner',
          taskId: channel.id,
          payload: {
            type: 'approval.required',
            taskId: channel.id,
            approvalId: 'approval-1',
            text: '发布前需要确认影响范围',
          },
          status: 'sent',
          createdAt: '2026-11-22T08:02:00.000Z',
          projection: {
            lane: 'decide',
            weight: 'card',
            anchor: { taskId: channel.id, eventId: 'event-1' },
          },
        },
        {
          id: 'message-approval-done',
          userId: 'owner',
          taskId: channel.id,
          payload: {
            type: 'approval.resolved',
            taskId: channel.id,
            approvalId: 'approval-1',
            text: '已确认：暂不发布。',
          },
          status: 'sent',
          createdAt: '2026-11-22T08:04:00.000Z',
          projection: {
            lane: 'work',
            weight: 'card',
            anchor: { taskId: channel.id, eventId: 'event-1' },
          },
        },
      ],
    }
    installChatFetch(decideSnapshot)
    render(<App />)
    const decideCard = await screen.findByLabelText(/已处理：/)
    expect(decideCard.classList.contains('opacity-70')).toBe(false)
    expect(decideCard.textContent).toContain('发布前需要确认影响范围')
    expect(
      within(decideCard).queryByRole('button', { name: /查看内容|去处理/ }),
    ).toBeNull()
    expect(screen.getByLabelText(/工作进展：|已完成：/)).toBeTruthy()
  })

  it('CONV-006: unresolved decide cards keep an explicit action', async () => {
    const decideSnapshot: Snapshot = {
      ...baseSnapshot,
      runs: [{ ...runningRun, status: 'waiting' }],
      messages: [
        {
          id: 'message-approval-open',
          userId: 'owner',
          taskId: channel.id,
          payload: {
            type: 'approval.required',
            taskId: channel.id,
            approvalId: 'approval-open',
            text: '发布前需要确认影响范围',
          },
          status: 'sent',
          createdAt: '2026-11-22T08:02:00.000Z',
          projection: { lane: 'decide', weight: 'card' },
        },
      ],
    }
    installChatFetch(decideSnapshot)
    render(<App />)
    const decideCard = await screen.findByLabelText(/需要你决定：/)
    expect(decideCard.classList.contains('is-resolved')).toBe(false)
    expect(
      within(decideCard).getByRole('button', { name: /查看内容/ }),
    ).toBeTruthy()
    expect(
      within(decideCard).queryByRole('button', { name: '回到发起消息' }),
    ).toBeNull()
  })

  it('hides stale progress once the run reaches a terminal state', async () => {
    const completed: Snapshot = {
      ...baseSnapshot,
      runs: [{ ...runningRun, status: 'completed', output: '报表已完成' }],
      messages: [
        ...baseSnapshot.messages,
        {
          id: 'message-done',
          userId: 'owner',
          taskId: channel.id,
          payload: {
            type: 'run.completed',
            taskId: channel.id,
            runId: 'run-1',
            text: '报表已完成',
          },
          status: 'sent',
          createdAt: '2026-11-22T08:03:00.000Z',
        },
      ],
    }
    installChatFetch(completed)
    render(<App />)
    expect(await screen.findByText('报表已完成')).toBeTruthy()
    expect(screen.queryByText('正在核对数据来源')).toBeNull()
    const bar = screen.getByRole('button', { name: /已完成 · 整理季度数据/ })
    expect(bar.getAttribute('aria-label')).toContain('工作了')
  })

  it('offers an explicit stop control with confirmation while work is running', async () => {
    const fetchMock = installChatFetch(baseSnapshot)
    render(<App />)
    const stop = await screen.findByRole('button', { name: '停止' })
    fireEvent.click(stop)
    expect(
      screen.getByRole('alertdialog', { name: /确定停止这件事/ }),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认停止' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) =>
            path === '/v1/channels/task-1/stop' && init?.method === 'POST',
        ),
      ).toBe(true),
    )
  })

  it('sends a steer intent when the user chooses 插话 during a run', async () => {
    const fetchMock = installChatFetch(baseSnapshot)
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: /整理季度数据.*进行中/ }),
    )
    const composer =
      await screen.findByLabelText<HTMLTextAreaElement>('给 Pegas 发消息')
    fireEvent.change(composer, { target: { value: '先只做华东区' } })
    fireEvent.click(await screen.findByRole('button', { name: /插话/ }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path, init]) => {
          if (path !== '/v1/events' || init?.method !== 'POST') return false
          const body = JSON.parse(
            typeof init.body === 'string' ? init.body : '{}',
          ) as { payload: { text?: string; taskId?: string; intent?: string } }
          return (
            body.payload.text === '先只做华东区' &&
            body.payload.taskId === 'task-1' &&
            body.payload.intent === 'steer'
          )
        }),
      ).toBe(true),
    )
    await waitFor(() => expect(composer.value).toBe(''))
  })

  it('queues a message while work runs and sends it after the run finishes', async () => {
    let current: Snapshot = baseSnapshot
    const fetchMock = installChatFetch(baseSnapshot, (path, init) => {
      if (path === '/v1/events' && init?.method === 'POST') {
        const body = JSON.parse(
          typeof init.body === 'string' ? init.body : '{}',
        ) as { payload?: { text?: string; taskId?: string } }
        return Response.json({
          event: {
            id: `event-${String(fetchMock.mock.calls.length)}`,
            userId: 'owner',
            type: 'user.message',
            source: 'web',
            payload: body.payload ?? { text: '' },
            status: 'pending',
            createdAt: '2026-11-22T09:00:00.000Z',
          },
          inserted: true,
        })
      }
      if (path.startsWith('/v1/events?'))
        return Response.json({ events: current.events })
      if (path.startsWith('/v1/channels?'))
        return Response.json({ channels: current.channels })
      if (path.startsWith('/v1/runs?'))
        return Response.json({ runs: current.runs })
      if (path.startsWith('/v1/outbox?'))
        return Response.json({ messages: current.messages })
      return undefined
    })
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: /整理季度数据.*进行中/ }),
    )
    const composer =
      await screen.findByLabelText<HTMLTextAreaElement>('给 Pegas 发消息')
    fireEvent.change(composer, { target: { value: '完成后顺便发我一份摘要' } })
    fireEvent.click(await screen.findByRole('button', { name: '排队' }))
    expect(await screen.findByLabelText('排队消息')).toBeTruthy()
    expect(screen.getByText('完成后顺便发我一份摘要')).toBeTruthy()
    expect(composer.value).toBe('')
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) =>
          path === '/v1/events' &&
          init?.method === 'POST' &&
          typeof init.body === 'string' &&
          init.body.includes('完成后顺便发我一份摘要'),
      ),
    ).toBe(false)
    current = {
      ...baseSnapshot,
      runs: [{ ...runningRun, status: 'completed', output: 'done' }],
    }
    await waitFor(
      () =>
        expect(
          fetchMock.mock.calls.some(
            ([path, init]) =>
              path === '/v1/events' &&
              init?.method === 'POST' &&
              typeof init.body === 'string' &&
              init.body.includes('完成后顺便发我一份摘要'),
          ),
        ).toBe(true),
      { timeout: 8000 },
    )
    await waitFor(
      () => expect(screen.queryByLabelText('排队消息')).toBeNull(),
      { timeout: 8000 },
    )
  }, 12_000)

  it('lets the user edit or delete a queued message before it sends', async () => {
    installChatFetch(baseSnapshot)
    const first = render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: /整理季度数据.*进行中/ }),
    )
    const composer =
      await screen.findByLabelText<HTMLTextAreaElement>('给 Pegas 发消息')
    fireEvent.change(composer, { target: { value: '第一条排队' } })
    fireEvent.click(await screen.findByRole('button', { name: '排队' }))
    first.unmount()
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: '编辑排队消息 1' }),
    )
    expect(screen.getByLabelText('给 Pegas 发消息')).toHaveProperty(
      'value',
      '第一条排队',
    )
    expect(screen.getByText(/继续事情：/)).toBeTruthy()
    expect(screen.queryByLabelText('排队消息')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '排队' }))
    fireEvent.click(screen.getByRole('button', { name: '删除排队消息 1' }))
    expect(screen.queryByLabelText('排队消息')).toBeNull()
  })

  it('CONV-007: tray lists open tasks, hides terminal ones and toggles selection', async () => {
    const secondChannel: WorkChannel = {
      ...channel,
      id: 'task-2',
      taskId: 'task-2',
      title: '整理供应商合同',
      goal: '整理供应商合同',
      latestActivityAt: '2026-11-22T08:05:00.000Z',
    }
    const doneChannel: WorkChannel = {
      ...channel,
      id: 'task-3',
      taskId: 'task-3',
      title: '已经完成的旧事情',
      status: 'completed',
    }
    installChatFetch({
      ...baseSnapshot,
      channels: [channel, secondChannel, doneChannel],
      runs: [
        runningRun,
        { ...runningRun, id: 'run-2', taskId: 'task-2', status: 'waiting' },
      ],
    })
    render(<App />)
    const tray = await screen.findByRole('group', { name: '进行中的事情' })
    expect(within(tray).getByText('整理季度数据')).toBeTruthy()
    expect(within(tray).getByText('整理供应商合同')).toBeTruthy()
    expect(within(tray).queryByText('已经完成的旧事情')).toBeNull()
    const second = within(tray).getByRole('button', {
      name: /整理供应商合同/,
    })
    expect(second.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(second)
    expect(second.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(/继续事情：/)).toBeTruthy()
    fireEvent.click(second)
    expect(second.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByText(/继续事情：/)).toBeNull()
  })

  it('uses local follow-ups instead of the old explanation action and preserves the draft', async () => {
    const delivery = (id: string, text: string): OutboxMessage => ({
      ...baseMessage,
      id,
      payload: {
        type: 'run.completed',
        text,
        ...(id === 'current-delivery' ? { followUps: ['进一步比较方案'] } : {}),
      },
      projection: { lane: 'work', weight: 'card' },
    })
    installChatFetch({
      ...baseSnapshot,
      channels: [
        {
          ...channel,
          status: 'completed',
          canResume: true,
          canStop: false,
          workflow: { state: 'delivered', resultMessageId: 'current-delivery' },
        },
      ],
      runs: [{ ...runningRun, status: 'completed' }],
      messages: [
        delivery('older-delivery', '旧交付'),
        delivery('current-delivery', '当前交付'),
      ],
    })
    render(<App />)
    const composer = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(composer, { target: { value: '用户正在写的草稿' } })
    const action = await screen.findByRole('button', { name: '进一步比较方案' })
    expect(screen.queryByRole('button', { name: '解释这次结果' })).toBeNull()
    expect(action.closest('article')?.getAttribute('data-message-id')).toBe(
      'current-delivery',
    )
    expect(screen.queryByText('这件事还有哪些没做完？')).toBeNull()
    fireEvent.click(action)
    expect(composer).toHaveProperty('value', '用户正在写的草稿')
  })

  it('quotes the selected agent reply even when another task was selected', async () => {
    const reply = (id: string, text: string): OutboxMessage => ({
      ...baseMessage,
      id,
      taskId: 'hidden-conversation',
      payload: { type: 'agent.message', text },
      projection: { lane: 'say', weight: 'inline' },
    })
    let failedOnce = false
    const fetchMock = installChatFetch(
      {
        ...baseSnapshot,
        messages: [
          reply('earlier-reply', '第一份回答，只涉及预算'),
          reply('later-reply', '第二份回答，只涉及时间'),
        ],
      },
      (path, init) => {
        if (path !== '/v1/events' || init?.method !== 'POST' || failedOnce)
          return undefined
        failedOnce = true
        return Response.json({ message: '暂时无法提交追问' }, { status: 503 })
      },
    )
    render(<App />)
    const tray = await screen.findByRole('group', { name: '进行中的事情' })
    fireEvent.click(within(tray).getByRole('button', { name: /整理季度数据/ }))
    const earlierReply = (
      await screen.findByText('第一份回答，只涉及预算')
    ).closest('article')
    if (!earlierReply) throw new Error('Expected the agent reply article')
    fireEvent.click(
      within(earlierReply).getByRole('button', { name: '追问这条回复' }),
    )

    const composer = screen.getByLabelText('给 Pegas 发消息')
    expect(document.activeElement).toBe(composer)
    expect(screen.getByText('追问这条回复：')).toBeTruthy()
    fireEvent.change(composer, { target: { value: '再展开这一点' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('暂时无法提交追问')).toBeTruthy()
    expect(screen.getByText('追问这条回复：')).toBeTruthy()
    expect(composer).toHaveProperty('value', '再展开这一点')
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([path, init]) => path === '/v1/events' && init?.method === 'POST',
      )
      expect(posts).toHaveLength(2)
      const messages = posts.map(([, init]) => {
        if (typeof init?.body !== 'string')
          throw new Error('Expected a JSON message')
        return JSON.parse(init.body) as { payload: unknown; dedupeKey: string }
      })
      for (const message of messages) {
        expect(message.payload).toEqual({
          text: '再展开这一点',
          replyToMessageId: 'earlier-reply',
        })
      }
      expect(messages[0]?.dedupeKey).toBeTruthy()
      expect(messages[1]?.dedupeKey).toBe(messages[0]?.dedupeKey)
    })
    await waitFor(() => expect(screen.queryByText('追问这条回复：')).toBeNull())
  })

  it('CONV-007: input follows the selected task even when another is more active', async () => {
    const idleSelected: WorkChannel = {
      ...channel,
      id: 'task-idle',
      taskId: 'task-idle',
      title: '等待中的调研',
      statusReason: 'awaiting_goal_clarification',
    }
    const fetchMock = installChatFetch({
      ...baseSnapshot,
      channels: [idleSelected, channel],
      runs: [
        {
          ...runningRun,
          id: 'run-idle',
          taskId: 'task-idle',
          status: 'waiting',
        },
        runningRun,
      ],
    })
    render(<App />)
    const tray = await screen.findByRole('group', { name: '进行中的事情' })
    fireEvent.click(within(tray).getByRole('button', { name: /等待中的调研/ }))
    const composer =
      screen.getByLabelText<HTMLTextAreaElement>('给 Pegas 发消息')
    fireEvent.change(composer, { target: { value: '补充：只做华东区' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path, init]) => {
          if (path !== '/v1/events' || init?.method !== 'POST') return false
          const body = JSON.parse(
            typeof init.body === 'string' ? init.body : '{}',
          ) as { payload?: { taskId?: string; intent?: string } }
          return (
            body.payload?.taskId === 'task-idle' &&
            body.payload.intent === undefined
          )
        }),
      ).toBe(true),
    )
    expect(screen.queryByRole('button', { name: /插话/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '排队' })).toBeNull()
  })

  it('CONV-007: steer and queue target the selected active task, not the busiest one', async () => {
    const secondActive: WorkChannel = {
      ...channel,
      id: 'task-busy',
      taskId: 'task-busy',
      title: '更活跃的执行',
      latestActivityAt: '2026-11-22T08:09:00.000Z',
    }
    const fetchMock = installChatFetch({
      ...baseSnapshot,
      channels: [secondActive, channel],
      runs: [
        { ...runningRun, id: 'run-busy', taskId: 'task-busy' },
        runningRun,
      ],
    })
    render(<App />)
    const tray = await screen.findByRole('group', { name: '进行中的事情' })
    fireEvent.click(within(tray).getByRole('button', { name: /整理季度数据/ }))
    const composer =
      screen.getByLabelText<HTMLTextAreaElement>('给 Pegas 发消息')
    fireEvent.change(composer, { target: { value: '改成按月汇总' } })
    fireEvent.click(await screen.findByRole('button', { name: /插话/ }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path, init]) => {
          if (path !== '/v1/events' || init?.method !== 'POST') return false
          const body = JSON.parse(
            typeof init.body === 'string' ? init.body : '{}',
          ) as { payload?: { taskId?: string; intent?: string } }
          return (
            body.payload?.taskId === 'task-1' && body.payload.intent === 'steer'
          )
        }),
      ).toBe(true),
    )
    fireEvent.change(composer, { target: { value: '完成后发我摘要' } })
    fireEvent.click(await screen.findByRole('button', { name: '排队' }))
    expect(await screen.findByLabelText('排队消息')).toBeTruthy()
  })

  it('CONV-007: an empty tray takes no layout and terminal selection auto-clears', async () => {
    installChatFetch({
      ...baseSnapshot,
      channels: [{ ...channel, status: 'completed' }],
      runs: [{ ...runningRun, status: 'completed', output: 'done' }],
    })
    render(<App />)
    await screen.findByLabelText('给 Pegas 发消息')
    expect(screen.queryByRole('group', { name: '进行中的事情' })).toBeNull()
  })

  it('CONV-007: consecutive same-task facts render as one structural thread', async () => {
    const threadSnapshot: Snapshot = {
      ...baseSnapshot,
      messages: [
        {
          id: 'message-work-1',
          userId: 'owner',
          taskId: channel.id,
          payload: {
            type: 'run.status',
            taskId: channel.id,
            runId: 'run-1',
            text: '已核对数据来源',
          },
          status: 'sent',
          createdAt: '2026-11-22T08:01:00.000Z',
          projection: {
            lane: 'work',
            weight: 'card',
            anchor: { taskId: channel.id, eventId: 'event-1' },
          },
        },
        {
          id: 'message-work-2',
          userId: 'owner',
          taskId: channel.id,
          payload: {
            type: 'run.completed',
            taskId: channel.id,
            runId: 'run-1',
            text: '报表已完成',
          },
          status: 'sent',
          createdAt: '2026-11-22T08:02:00.000Z',
          projection: {
            lane: 'work',
            weight: 'card',
            anchor: { taskId: channel.id, eventId: 'event-1' },
          },
        },
      ],
    }
    installChatFetch(threadSnapshot)
    const { container } = render(<App />)
    const thread = await screen.findByLabelText('事情进展：整理季度数据')
    expect(thread.classList.contains('message-thread')).toBe(true)
    expect(thread.querySelectorAll('.message-row')).toHaveLength(2)
    expect(
      container.querySelectorAll('.conversation-flow > .message-thread'),
    ).toHaveLength(1)
    expect(
      within(thread).getAllByRole('button', { name: '整理季度数据' }),
    ).toHaveLength(1)
    expect(
      within(thread).getAllByRole('button', { name: '回到发起消息' }),
    ).toHaveLength(2)
  })

  it('CONV-007: a lone fact or an interleaved task does not form a thread', async () => {
    const otherChannel: WorkChannel = {
      ...channel,
      id: 'task-2',
      taskId: 'task-2',
      originEventId: 'event-2',
      title: '核对发布窗口',
    }
    const mixedSnapshot: Snapshot = {
      ...baseSnapshot,
      channels: [channel, otherChannel],
      events: [
        ...baseSnapshot.events,
        {
          ...baseEvent,
          id: 'event-2',
          payload: { text: '顺便核对发布窗口' },
          createdAt: '2026-11-22T08:00:30.000Z',
        },
      ],
      messages: [
        {
          id: 'message-a1',
          userId: 'owner',
          taskId: channel.id,
          payload: {
            type: 'run.status',
            taskId: channel.id,
            runId: 'run-1',
            text: 'A 的进展',
          },
          status: 'sent',
          createdAt: '2026-11-22T08:01:00.000Z',
          projection: { lane: 'work', weight: 'card' },
        },
        {
          id: 'message-b1',
          userId: 'owner',
          taskId: otherChannel.id,
          payload: {
            type: 'run.status',
            taskId: otherChannel.id,
            runId: 'run-2',
            text: 'B 的进展',
          },
          status: 'sent',
          createdAt: '2026-11-22T08:01:30.000Z',
          projection: { lane: 'work', weight: 'card' },
        },
        {
          id: 'message-a2',
          userId: 'owner',
          taskId: channel.id,
          payload: {
            type: 'run.completed',
            taskId: channel.id,
            runId: 'run-1',
            text: 'A 已完成',
          },
          status: 'sent',
          createdAt: '2026-11-22T08:02:00.000Z',
          projection: { lane: 'work', weight: 'card' },
        },
      ],
    }
    installChatFetch(mixedSnapshot)
    const { container } = render(<App />)
    await screen.findByText('A 已完成')
    expect(container.querySelectorAll('.message-thread')).toHaveLength(0)
    expect(
      screen.getAllByRole('button', { name: '整理季度数据' }).length,
    ).toBeGreaterThanOrEqual(2)
  })

  it('retries a failed user message in place', async () => {
    const failed: Snapshot = {
      ...baseSnapshot,
      events: [
        {
          ...baseEvent,
          id: 'event-failed',
          status: 'failed',
          payload: { text: '这条发送失败了' },
        },
      ],
    }
    const fetchMock = installChatFetch(failed)
    render(<App />)
    const retry = await screen.findByRole('button', { name: /重试/ })
    fireEvent.click(retry)
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) =>
            path === '/v1/events/event-failed/retry' && init?.method === 'POST',
        ),
      ).toBe(true),
    )
  })

  it('DESIGN-005/008: keeps the status slot out of the bubble and opens the derived task drawer', async () => {
    const originEvent: InboxEvent = {
      ...baseEvent,
      id: 'event-origin',
      status: 'processed',
      payload: { text: '帮我整理季度数据' },
    }
    const derivedFact: OutboxMessage = {
      ...baseMessage,
      id: 'fact-done',
      payload: { type: 'run.completed', text: '报表已完成' },
      createdAt: '2026-11-22T08:05:00.000Z',
      projection: {
        lane: 'work',
        weight: 'card',
        anchor: { taskId: channel.id, eventId: originEvent.id },
      },
    }
    installChatFetch(
      {
        ...baseSnapshot,
        events: [originEvent],
        messages: [derivedFact],
      },
      path =>
        path.startsWith(`/v1/channels/${channel.id}/timeline?`)
          ? Response.json({
              channel,
              events: [originEvent],
              messages: [derivedFact],
              runs: baseSnapshot.runs,
            })
          : undefined,
    )
    render(<App />)
    const trigger = await screen.findByRole('button', {
      name: '查看工作详情',
    })
    expect(trigger.closest('.message-content')).toBeNull()
    expect(trigger.closest('.message-row.is-user')).toBeTruthy()
    expect(trigger.getAttribute('title')).toBe('查看工作详情')
    expect(
      document.querySelector('.message-row.is-user .message-content button'),
    ).toBeNull()
    expect(screen.queryByText('已进入事情')).toBeNull()
    fireEvent.click(trigger)
    expect(await screen.findByRole('dialog', { name: '工作详情' })).toBeTruthy()
  })

  it('DESIGN-005/008: multiple derived tasks open a menu with per-task state and drawer target', async () => {
    const secondChannel: WorkChannel = {
      ...channel,
      id: 'task-2',
      taskId: 'task-2',
      title: '账单提醒归档策略',
      status: 'started',
      statusReason: 'awaiting_goal_clarification',
    }
    const originEvent: InboxEvent = {
      ...baseEvent,
      id: 'event-origin',
      status: 'processed',
      payload: { text: '帮我整理季度数据' },
    }
    const factOne: OutboxMessage = {
      ...baseMessage,
      id: 'fact-one',
      payload: { type: 'run.completed', text: '报表已完成' },
      createdAt: '2026-11-22T08:05:00.000Z',
      projection: {
        lane: 'work',
        weight: 'card',
        anchor: { taskId: channel.id, eventId: originEvent.id },
      },
    }
    const factTwo: OutboxMessage = {
      ...baseMessage,
      id: 'fact-two',
      taskId: secondChannel.id,
      payload: {
        type: 'goal.clarification_required',
        taskId: secondChannel.id,
        questions: ['保留原件吗？'],
        text: '保留原件吗？',
      },
      createdAt: '2026-11-22T08:06:00.000Z',
      projection: {
        lane: 'decide',
        weight: 'card',
        anchor: { taskId: secondChannel.id, eventId: originEvent.id },
      },
    }
    installChatFetch(
      {
        ...baseSnapshot,
        channels: [
          { ...channel, status: 'completed', canStop: false },
          secondChannel,
        ],
        runs: [{ ...runningRun, status: 'completed', output: 'done' }],
        events: [originEvent],
        messages: [factOne, factTwo],
      },
      path =>
        path.startsWith(`/v1/channels/${secondChannel.id}/timeline?`)
          ? Response.json({
              channel: secondChannel,
              events: [],
              messages: [factTwo],
              runs: [],
            })
          : undefined,
    )
    render(<App />)
    const trigger = await screen.findByRole('button', {
      name: '查看工作详情：2 个事情',
    })
    expect(trigger.textContent).toContain('2')
    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu', {
      name: '这条消息派生的事情',
    })
    const items = within(menu).getAllByRole('menuitem')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain(channel.title)
    expect(items[0]?.textContent).toContain('已完成')
    expect(items[1]?.textContent).toContain(secondChannel.title)
    const secondItem = items[1]
    if (!secondItem) throw new Error('expected two derived task entries')
    fireEvent.click(secondItem)
    expect(await screen.findByRole('dialog', { name: '工作详情' })).toBeTruthy()
    expect(
      screen.queryByRole('menu', { name: '这条消息派生的事情' }),
    ).toBeNull()
  })

  it('DESIGN-005: failed messages keep an always-visible retry and never a progress link', async () => {
    installChatFetch({
      ...baseSnapshot,
      events: [
        {
          ...baseEvent,
          id: 'event-failed-2',
          status: 'failed',
          payload: { text: '这条发送失败了' },
        },
      ],
    })
    render(<App />)
    const icon = await screen.findByRole('img', { name: '发送失败' })
    expect(icon.closest('.message-meta')).toBeTruthy()
    const retry = screen.getByRole('button', { name: /重试/ })
    expect(retry.closest('.message-meta')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /查看工作详情/ })).toBeNull()
  })

  it('DESIGN-008: scheduled completion reads 已安排 and every work entry is a meta-row icon opening the drawer', async () => {
    const originEvent: InboxEvent = {
      ...baseEvent,
      id: 'event-origin',
      status: 'processed',
      payload: { text: '帮我建一个每分钟数数 1 到 10 的周期自动化' },
    }
    const scheduledFact: OutboxMessage = {
      ...baseMessage,
      id: 'fact-scheduled',
      payload: {
        type: 'run.completed',
        taskId: channel.id,
        automationActive: true,
        text: '周期自动化已创建并生效：每分钟报数 1→10。',
      },
      createdAt: '2026-11-22T08:05:00.000Z',
      projection: {
        lane: 'work',
        weight: 'card',
        anchor: { taskId: channel.id, eventId: originEvent.id },
      },
    }
    const sayTick: OutboxMessage = {
      ...baseMessage,
      id: 'say-tick-1',
      payload: {
        type: 'agent.message',
        taskId: channel.id,
        text: '1',
      },
      createdAt: '2026-11-22T08:06:00.000Z',
      projection: {
        lane: 'say',
        weight: 'inline',
        anchor: { taskId: channel.id, eventId: originEvent.id },
      },
    }
    installChatFetch(
      {
        ...baseSnapshot,
        runs: [
          {
            ...runningRun,
            status: 'completed',
            output: '周期自动化已创建并生效：每分钟报数 1→10。',
          },
        ],
        events: [originEvent],
        messages: [scheduledFact, sayTick],
      },
      path =>
        path.startsWith(`/v1/channels/${channel.id}/timeline?`)
          ? Response.json({
              channel,
              events: [originEvent],
              messages: [scheduledFact, sayTick],
              runs: [
                {
                  ...runningRun,
                  status: 'completed',
                  output: '周期自动化已创建并生效：每分钟报数 1→10。',
                },
              ],
            })
          : undefined,
    )
    render(<App />)
    const card = await screen.findByLabelText(/已安排：/)
    expect(card.textContent).toContain('已安排')
    expect(card.textContent).not.toContain('已完成')
    expect(
      within(card).getByRole('button', { name: '回到发起消息' }),
    ).toBeTruthy()
    expect(
      within(card).queryByRole('button', { name: /查看工作详情/ }),
    ).toBeNull()
    const cardRow = card.closest('.message-row')
    const cardEntry = cardRow?.querySelector(
      '.message-meta .message-work-entry',
    )
    expect(cardEntry).toBeTruthy()
    expect(cardEntry?.getAttribute('title')).toBe('查看工作详情')
    const sayRow = document.querySelector('[data-message-id="say-tick-1"]')
    expect(sayRow?.querySelector('.message-content .inline-link')).toBeNull()
    const sayEntry = sayRow?.querySelector('.message-meta .message-work-entry')
    expect(sayEntry).toBeTruthy()
    expect(sayRow?.classList.contains('has-work-entry')).toBe(true)
    if (!(sayEntry instanceof HTMLButtonElement))
      throw new Error('expected the say work entry button')
    fireEvent.click(sayEntry)
    const drawer = await screen.findByRole('dialog', { name: '工作详情' })
    expect(
      within(drawer).getByText('已安排，自动化仍会按周期推进'),
    ).toBeTruthy()
    expect(within(drawer).queryByText('工作已完成')).toBeNull()
  })

  it('DESIGN-008: plain completion keeps 已完成 and the drawer hero stays completed', async () => {
    const doneFact: OutboxMessage = {
      ...baseMessage,
      id: 'fact-plain-done',
      payload: {
        type: 'run.completed',
        taskId: channel.id,
        text: '报表已完成',
      },
      createdAt: '2026-11-22T08:05:00.000Z',
      projection: {
        lane: 'work',
        weight: 'card',
        anchor: { taskId: channel.id, eventId: 'event-1' },
      },
    }
    installChatFetch(
      {
        ...baseSnapshot,
        channels: [{ ...channel, status: 'completed', canStop: false }],
        runs: [{ ...runningRun, status: 'completed', output: '报表已完成' }],
        messages: [doneFact],
      },
      path =>
        path.startsWith(`/v1/channels/${channel.id}/timeline?`)
          ? Response.json({
              channel: { ...channel, status: 'completed', canStop: false },
              events: baseSnapshot.events,
              messages: [doneFact],
              runs: [
                { ...runningRun, status: 'completed', output: '报表已完成' },
              ],
            })
          : undefined,
    )
    render(<App />)
    const card = await screen.findByLabelText(/已完成：/)
    expect(card.textContent).not.toContain('已安排')
    const entry = card
      .closest('.message-row')
      ?.querySelector('.message-meta .message-work-entry')
    if (!(entry instanceof HTMLButtonElement))
      throw new Error('expected the card work entry button')
    fireEvent.click(entry)
    const drawer = await screen.findByRole('dialog', { name: '工作详情' })
    expect(within(drawer).getByText('工作已完成')).toBeTruthy()
  })

  it('copies the full message text including collapsed content', async () => {
    const longText = `第一段\n\n${'很长的内容。'.repeat(120)}`
    const write = vi.fn((items: unknown[]) => {
      expect(items.length).toBeGreaterThan(0)
      return Promise.resolve()
    })
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write, writeText },
    })
    vi.stubGlobal(
      'ClipboardItem',
      class {
        items: Record<string, Blob>
        constructor(items: Record<string, Blob>) {
          this.items = items
        }
      },
    )
    const longSnapshot: Snapshot = {
      ...baseSnapshot,
      events: [
        {
          ...baseEvent,
          payload: { text: longText },
        },
      ],
    }
    installChatFetch(longSnapshot)
    render(<App />)
    const copy = await screen.findByRole('button', { name: '复制消息' })
    fireEvent.click(copy)
    await waitFor(() => expect(write).toHaveBeenCalled())
    const items = write.mock.calls[0]?.[0] as
      [{ items: Record<string, Blob> }] | undefined
    const plain = items?.[0].items['text/plain']
    expect(plain).toBeTruthy()
    expect(await plain?.text()).toBe(longText)
    expect(await screen.findByRole('button', { name: '已复制' })).toBeTruthy()
  })

  it('shows a new-replies jump button when the reader is scrolled away', async () => {
    installChatFetch(baseSnapshot)
    render(<App />)
    await screen.findByLabelText('给 Pegas 发消息')
    const scroller = document.querySelector('.conversation-scroll')
    expect(scroller).toBeTruthy()
    if (!scroller) return
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      value: 2000,
    })
    Object.defineProperty(scroller, 'clientHeight', {
      configurable: true,
      value: 500,
    })
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(screen.queryByRole('button', { name: /新回复/ })).toBeNull()
  })
})

describe('DESIGN-009 contextual follow-ups', () => {
  const questions = [
    '哪些因素推动了增长？',
    '比较两个季度的毛利率',
    '哪些假设会影响结论？',
    '进一步分析成本结构',
  ]
  function suggestionsSnapshot(
    options: { streaming?: boolean; empty?: boolean } = {},
  ): Snapshot {
    return {
      ...baseSnapshot,
      channels: [
        {
          ...channel,
          status: 'completed',
          canResume: true,
          canStop: false,
          workflow: { state: 'delivered', resultMessageId: 'current-result' },
        },
        {
          ...channel,
          id: 'other-task',
          taskId: 'other-task',
          title: '分析其他产品',
        },
      ],
      runs: [
        { ...runningRun, status: 'completed' },
        { ...runningRun, id: 'other-run', taskId: 'other-task' },
      ],
      messages: [
        {
          ...baseMessage,
          id: 'old-result',
          payload: {
            type: 'run.completed',
            text: '旧报告',
            followUps: ['过期的问题'],
          },
          projection: { lane: 'work', weight: 'card' },
        },
        {
          ...baseMessage,
          id: 'current-result',
          payload: {
            type: 'run.completed',
            text: '收入增长分析',
            followUps: options.empty ? [] : questions,
            ...(options.streaming ? { streaming: true } : {}),
          },
          projection: { lane: 'work', weight: 'card' },
        },
        {
          ...baseMessage,
          id: 'other-reply',
          taskId: 'other-task',
          payload: {
            type: 'agent.message',
            text: '其他产品的分析',
            followUps: ['比较其他产品的销量'],
          },
          projection: { lane: 'say', weight: 'inline' },
        },
      ],
    }
  }
  function installSuggestionsFetch(snapshot: Snapshot, failFirst = false) {
    let fails = failFirst
    return installChatFetch(snapshot, (path, init) => {
      if (path !== '/v1/events' || init?.method !== 'POST') return undefined
      if (fails) {
        fails = false
        return Response.json({ message: '追问发送失败' }, { status: 503 })
      }
      if (typeof init.body !== 'string') throw new Error('Expected JSON event')
      const body = JSON.parse(init.body) as {
        payload: InboxEvent['payload']
      }
      const event: InboxEvent = {
        id: `followup-event-${String(snapshot.events.length)}`,
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        payload: body.payload,
        status: 'pending',
        createdAt: new Date().toISOString(),
      }
      snapshot.events = [...snapshot.events, event]
      return Response.json({ event, inserted: true }, { status: 202 })
    })
  }
  function posts(mock: ReturnType<typeof installChatFetch>) {
    return mock.mock.calls
      .filter(
        ([path, init]) => path === '/v1/events' && init?.method === 'POST',
      )
      .map(([, init]) => {
        if (typeof init?.body !== 'string')
          throw new Error('Expected JSON event')
        return JSON.parse(init.body) as { payload: unknown; dedupeKey: string }
      })
  }
  it('sends four choices directly to their own replies while preserving another task and the global draft', async () => {
    const mock = installSuggestionsFetch(suggestionsSnapshot())
    render(<App />)
    const tray = await screen.findByRole('group', { name: '进行中的事情' })
    fireEvent.click(within(tray).getByRole('button', { name: /分析其他产品/ }))
    const composer = screen.getByLabelText('给 Pegas 发消息')
    fireEvent.change(composer, { target: { value: '写给另一件事情的草稿' } })
    for (const question of questions)
      expect(await screen.findByRole('button', { name: question })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '过期的问题' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: questions[0] }))
    await waitFor(() => expect(posts(mock)).toHaveLength(1))
    expect(posts(mock)[0]?.payload).toEqual({
      text: questions[0],
      replyToMessageId: 'current-result',
    })
    expect(composer).toHaveProperty('value', '写给另一件事情的草稿')
    await waitFor(() =>
      expect(document.querySelectorAll('.message-row.is-user')).toHaveLength(2),
    )
    const sent = document.querySelector('[data-message-id="followup-event-1"]')
    expect(sent?.textContent).toContain(questions[0])
    expect(sent?.textContent).not.toContain('收入增长分析')
    expect(screen.getByText(/继续事情：/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '比较其他产品的销量' }))
    await waitFor(() => expect(posts(mock)).toHaveLength(2))
    expect(posts(mock)[1]?.payload).toEqual({
      text: '比较其他产品的销量',
      replyToMessageId: 'other-reply',
    })
    expect(composer).toHaveProperty('value', '写给另一件事情的草稿')
  })
  it('retains a failed suggestion at its reply and retries with the same key', async () => {
    const mock = installSuggestionsFetch(suggestionsSnapshot(), true)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: questions[0] }))
    await screen.findByText('追问发送失败')
    fireEvent.click(screen.getByRole('button', { name: '重试发送' }))
    await waitFor(() => expect(posts(mock)).toHaveLength(2))
    expect(posts(mock)[0]).toEqual(posts(mock)[1])
    expect(screen.getByLabelText('给 Pegas 发消息')).toHaveProperty('value', '')
  })
  it('supports an inline custom reply without sending IME composition or touching the common composer', async () => {
    const mock = installSuggestionsFetch(suggestionsSnapshot())
    render(<App />)
    const message = (await screen.findByText('收入增长分析')).closest('article')
    if (!message) throw new Error('Expected result article')
    fireEvent.click(within(message).getByRole('button', { name: '快速回复' }))
    const editor = within(message).getByRole('textbox', { name: '回复内容' })
    await waitFor(() => expect(document.activeElement).toBe(editor))
    expect(
      within(message).getByRole('form', { name: '发送到「整理季度数据」' }),
    ).toBeTruthy()
    expect(
      within(message).queryByText('发送到「整理季度数据」', { exact: true }),
    ).toBeNull()
    fireEvent.change(editor, { target: { value: '展开收入的季节性影响' } })
    fireEvent.compositionStart(editor)
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 })
    expect(posts(mock)).toHaveLength(0)
    fireEvent.compositionEnd(editor)
    fireEvent.keyDown(editor, { key: 'Enter' })
    await waitFor(() => expect(posts(mock)).toHaveLength(1))
    expect(posts(mock)[0]?.payload).toEqual({
      text: '展开收入的季节性影响',
      replyToMessageId: 'current-result',
    })
    await waitFor(() =>
      expect(
        document.querySelector('[data-message-id="followup-event-1"]')
          ?.textContent,
      ).toContain('展开收入的季节性影响'),
    )
    expect(screen.getByLabelText('给 Pegas 发消息')).toHaveProperty('value', '')
  })
  it.each([{ streaming: true }, { empty: true }])(
    'does not invent candidates for %j',
    async options => {
      installChatFetch(suggestionsSnapshot(options))
      render(<App />)
      await screen.findByText('收入增长分析')
      for (const question of questions)
        expect(screen.queryByRole('button', { name: question })).toBeNull()
    },
  )
})

describe('DESIGN-009 prompt bar', () => {
  it('opens the add menu before invoking the file picker', async () => {
    installChatFetch(baseSnapshot)
    render(<App />)
    await screen.findByLabelText('给 Pegas 发消息')
    const input = screen.getByLabelText('选择附件文件')
    const chooseFile = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: '添加内容' }))
    expect(chooseFile).not.toHaveBeenCalled()
    fireEvent.click(
      await screen.findByRole('menuitem', { name: /添加照片和文件/ }),
    )
    expect(chooseFile).toHaveBeenCalledOnce()
  })

  it('offers slash commands and opens the real model picker without sending a message', async () => {
    const fetchMock = installChatFetch(baseSnapshot)
    render(<App />)
    const input = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(input, { target: { value: '/model' } })
    expect(await screen.findByRole('option', { name: /选择模型/ })).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('dialog', { name: '选择模型' })).toBeTruthy()
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) =>
          typeof path === 'string' &&
          path.startsWith('/v1/events') &&
          init?.method === 'POST',
      ),
    ).toBe(false)
  })

  it.each(['/not-a-command', '/unknown123', '/unknown_cmd'])(
    'keeps unknown slash command %s local and preserves the draft',
    async command => {
      const fetchMock = installChatFetch(baseSnapshot)
      render(<App />)
      const input = await screen.findByLabelText('给 Pegas 发消息')
      fireEvent.change(input, { target: { value: command } })
      fireEvent.click(screen.getByRole('button', { name: '发送' }))
      expect(await screen.findByRole('alert')).toHaveProperty(
        'textContent',
        expect.stringContaining('未知命令'),
      )
      expect(input).toHaveProperty('value', command)
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) =>
            typeof path === 'string' &&
            path.startsWith('/v1/events') &&
            init?.method === 'POST',
        ),
      ).toBe(false)
    },
  )
})

describe('DESIGN-009 prompt bar boundaries', () => {
  it('selects a Chinese @ task and sends through the existing task target', async () => {
    const fetchMock = installChatFetch(baseSnapshot)
    render(<App />)
    const input = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(input, { target: { value: '@季度' } })
    fireEvent.click(await screen.findByRole('option', { name: /整理季度数据/ }))
    expect(input).toHaveProperty('value', '')
    expect(await screen.findByText('继续事情：')).toBeTruthy()
    fireEvent.change(input, { target: { value: '继续核对收入' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => {
      const request = fetchMock.mock.calls.find(
        ([path, init]) => path === '/v1/events' && init?.method === 'POST',
      )
      expect(JSON.parse(request?.[1]?.body as string)).toMatchObject({
        payload: { text: '继续核对收入', taskId: 'task-1' },
      })
    })
  })

  it('requires the existing stop confirmation and never sends /stop to the agent', async () => {
    const fetchMock = installChatFetch(baseSnapshot)
    render(<App />)
    const input = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(input, { target: { value: '/stop' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const confirmation = await screen.findByRole('alertdialog', {
      name: '确定停止这件事？',
    })
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) =>
          typeof path === 'string' &&
          path.includes('/stop') &&
          init?.method === 'POST',
      ),
    ).toBe(false)
    fireEvent.click(
      within(confirmation).getByRole('button', { name: '确认停止' }),
    )
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) =>
            typeof path === 'string' &&
            path.includes('/stop') &&
            init?.method === 'POST',
        ),
      ).toBe(true),
    )
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) => path === '/v1/events' && init?.method === 'POST',
      ),
    ).toBe(false)
  })

  it('keeps stop errors visible and preserves input when no task is stoppable', async () => {
    installChatFetch({ ...baseSnapshot, channels: [], runs: [] })
    render(<App />)
    const input = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(input, { target: { value: '/stop' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '当前没有可停止的事情。',
    )
    expect(input).toHaveProperty('value', '/stop')
  })

  it('ignores IME confirmation and supports keyboard completion and Escape', async () => {
    installChatFetch(baseSnapshot)
    render(<App />)
    const input = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(input, { target: { value: '/' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(input).toHaveProperty('value', '/')
    expect(screen.getAllByRole('option')).toHaveLength(5)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(
      screen
        .getByRole('option', { name: /添加照片和文件/ })
        .getAttribute('aria-selected'),
    ).toBe('true')
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: '基础命令' })).toBeNull(),
    )
    expect(input).toHaveProperty('value', '/')
  })

  it('routes /attach to the file picker and /help to local help', async () => {
    installChatFetch(baseSnapshot)
    render(<App />)
    const input = await screen.findByLabelText('给 Pegas 发消息')
    const chooseFile = vi.spyOn(screen.getByLabelText('选择附件文件'), 'click')
    fireEvent.change(input, { target: { value: '/attach' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(chooseFile).toHaveBeenCalledOnce()
    fireEvent.change(input, { target: { value: '/help' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByRole('menu', { name: '基础命令' })).toBeTruthy()
    expect(input).toHaveProperty('value', '')
  })

  it('restores automatic targeting without discarding attachments', async () => {
    installChatFetch(baseSnapshot)
    render(<App />)
    const input = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(input, { target: { value: '@季度' } })
    fireEvent.click(await screen.findByRole('option', { name: /整理季度数据/ }))
    fireEvent.change(screen.getByLabelText('选择附件文件'), {
      target: { files: [new File(['notes'], 'notes.txt')] },
    })
    fireEvent.change(input, { target: { value: '/auto' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(screen.queryByText('继续事情：')).toBeNull()
    expect(screen.getByText('notes.txt')).toBeTruthy()
  })

  it('preserves prose around a caret @ token and excludes cancelled tasks', async () => {
    installChatFetch({
      ...baseSnapshot,
      channels: [
        ...baseSnapshot.channels,
        {
          ...channel,
          id: 'cancelled',
          title: '已停止事情',
          status: 'cancelled',
        },
      ],
    })
    render(<App />)
    const input =
      await screen.findByLabelText<HTMLTextAreaElement>('给 Pegas 发消息')
    fireEvent.change(input, {
      target: {
        value: '请继续 @季度 后续',
        selectionStart: 7,
        selectionEnd: 7,
      },
    })
    fireEvent.select(input, { target: { selectionStart: 7, selectionEnd: 7 } })
    fireEvent.click(await screen.findByRole('option', { name: /整理季度数据/ }))
    expect(input.value).toBe('请继续  后续')
    fireEvent.change(input, { target: { value: '@已停止' } })
    expect(await screen.findByText(/没有匹配的事情/)).toBeTruthy()
    expect(screen.queryByRole('option', { name: /已停止事情/ })).toBeNull()
  })

  it('does not interpret a URL or slash inside prose as a command', async () => {
    const fetchMock = installChatFetch(baseSnapshot)
    render(<App />)
    const input = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(input, {
      target: { value: '查看 https://example.com/a/b 和 /tmp/file' },
    })
    expect(screen.queryByRole('listbox', { name: '基础命令' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, init]) => path === '/v1/events' && init?.method === 'POST',
        ),
      ).toBe(true),
    )
  })

  it('rejects command arguments instead of silently losing text', async () => {
    const fetchMock = installChatFetch(baseSnapshot)
    render(<App />)
    const input = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(input, { target: { value: '/model 这段正文要保留' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('不接受参数'),
    )
    expect(input).toHaveProperty('value', '/model 这段正文要保留')
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) => path === '/v1/events' && init?.method === 'POST',
      ),
    ).toBe(false)
  })

  it('keeps a draft while navigating the add menu and restores focus on Escape', async () => {
    installChatFetch(baseSnapshot)
    render(<App />)
    const input = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(input, { target: { value: '未发送草稿' } })
    const trigger = screen.getByRole('button', { name: '添加内容' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const menu = await screen.findByRole('menu', { name: '添加内容' })
    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: /基础命令/ }),
    )
    fireEvent.keyDown(document.activeElement ?? menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(input).toHaveProperty('value', '未发送草稿')
    expect(document.activeElement).toBe(trigger)
  })
})

it('preserves text after a bare slash instead of clearing it as help', async () => {
  installChatFetch(baseSnapshot)
  render(<App />)
  const input = await screen.findByLabelText('给 Pegas 发消息')
  fireEvent.change(input, { target: { value: '/ 这段正文不能丢失' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('正文已保留'),
  )
  expect(input).toHaveProperty('value', '/ 这段正文不能丢失')
})

it.each(['/model\nfirst\nsecond', '/unknown\nfirst\nsecond'])(
  'keeps multiline command %s local without losing the draft',
  async draft => {
    const fetchMock = installChatFetch(baseSnapshot)
    render(<App />)
    const input = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(input, { target: { value: draft } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(input).toHaveProperty('value', draft)
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) => path === '/v1/events' && init?.method === 'POST',
      ),
    ).toBe(false)
  },
)

it('preserves steer and queue for path-leading prose while blocking command bypass', async () => {
  installChatFetch(baseSnapshot)
  render(<App />)
  const input = await screen.findByLabelText('给 Pegas 发消息')
  fireEvent.change(input, { target: { value: '@季度' } })
  fireEvent.click(await screen.findByRole('option', { name: /整理季度数据/ }))
  fireEvent.change(input, { target: { value: '/tmp/file 请检查这个文件' } })
  expect(screen.getByRole('button', { name: '插话' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '排队' })).toBeTruthy()
  fireEvent.change(input, { target: { value: '/stop' } })
  expect(screen.queryByRole('button', { name: '插话' })).toBeNull()
  expect(screen.queryByRole('button', { name: '排队' })).toBeNull()
})

it.each(['/stop', '/model'])(
  'reports unavailable command %s on Enter and preserves input',
  async command => {
    installChatFetch({ ...baseSnapshot, channels: [], runs: [] }, path =>
      path === '/v1/settings/agent-models'
        ? Response.json({ models: [] })
        : undefined,
    )
    render(<App />)
    const input = await screen.findByLabelText('给 Pegas 发消息')
    fireEvent.change(input, { target: { value: command } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(input).toHaveProperty('value', command)
  },
)
