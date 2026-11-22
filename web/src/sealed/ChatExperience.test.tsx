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
    if (path.startsWith('/v1/channels/search?'))
      return Promise.resolve(Response.json({ channels: [], matches: [] }))
    if (path.startsWith('/v1/channels?'))
      return Promise.resolve(Response.json({ channels: snapshot.channels }))
    if (path.startsWith('/v1/runs?'))
      return Promise.resolve(Response.json({ runs: snapshot.runs }))
    if (path.startsWith('/v1/outbox?'))
      return Promise.resolve(Response.json({ messages: snapshot.messages }))
    if (path.startsWith('/v1/usage?'))
      return Promise.resolve(
        Response.json({
          usage: [],
          totals: { inputTokens: 0, outputTokens: 0 },
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
    expect(bar.textContent).toContain('正在核对数据来源')
    expect(
      screen.queryByText('正在核对数据来源', {
        selector: '.message-content *',
      }),
    ).toBeNull()
    expect(document.querySelector('.run-status-bar[data-active]')).toBeTruthy()
  })

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
    expect(bar.textContent).toContain('正在核对数据来源')
    expect(
      screen.queryByText('正在核对数据来源', {
        selector: '.message-content *',
      }),
    ).toBeNull()
  })

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
    expect(decideCard.classList.contains('is-resolved')).toBe(true)
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
    expect(bar.textContent).toContain('工作了')
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
    render(<App />)
    fireEvent.click(
      await screen.findByRole('button', { name: /整理季度数据.*进行中/ }),
    )
    const composer =
      await screen.findByLabelText<HTMLTextAreaElement>('给 Pegas 发消息')
    fireEvent.change(composer, { target: { value: '第一条排队' } })
    fireEvent.click(await screen.findByRole('button', { name: '排队' }))
    fireEvent.click(screen.getByRole('button', { name: '编辑排队消息 1' }))
    expect(composer.value).toBe('第一条排队')
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
    await screen.findByText('你的私人智能工作伙伴')
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
