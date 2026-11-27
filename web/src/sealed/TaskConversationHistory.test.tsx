// @vitest-environment jsdom
import '../test-env'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PegasApi } from '../api'
import type { Run, RunActivityEntry } from '../types'
import { TaskConversationHistory } from './TaskConversationHistory'
import type { TaskActivitySearchSnapshot } from './taskActivitySearch'

const run: Run = {
  id: 'run-a',
  taskId: 'task-a',
  executor: 'dsh',
  status: 'completed',
  input: '核对数据',
  attempts: 1,
  createdAt: '2026-11-27T00:00:00.000Z',
  updatedAt: '2026-11-27T00:01:00.000Z',
}
const entry = (seq: number, text: string): RunActivityEntry => ({
  seq,
  kind: 'text',
  label: text,
  detail: text,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
})
const report = (entries: RunActivityEntry[]) => ({
  runId: run.id,
  taskId: run.taskId,
  entries,
  totalEntries: entries.length,
  truncated: false,
})
function install(
  handler: (path: string) => Response | Promise<Response> | undefined,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) =>
      Promise.resolve(
        handler(path) ??
          Response.json({ runId: run.id, taskId: run.taskId, subagents: [] }),
      ),
    ),
  )
  return new PegasApi('owner')
}
const messages = [
  { id: 'input', at: '2026-11-26T23:59:00.000Z', text: '保留的输入' },
]
const renderMessage = (message: (typeof messages)[number]) => (
  <p>{message.text}</p>
)
function mount(
  api: PegasApi,
  onSearchSnapshot?: (snapshot: TaskActivitySearchSnapshot) => void,
) {
  return render(
    <TaskConversationHistory
      api={api}
      taskId={run.taskId}
      runs={[run]}
      messages={messages}
      renderMessage={renderMessage}
      onSearchSnapshot={onSearchSnapshot}
    />,
  )
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('CONV-002 inline execution history', () => {
  it('keeps messages available when a later page fails and retries all pages without duplicates', async () => {
    const search = vi.fn<(snapshot: TaskActivitySearchSnapshot) => void>()
    let fail = true
    const api = install(path =>
      path.includes('/activity?')
        ? path.includes('beforeSeq=2')
          ? fail
            ? Response.json({ message: '续页失败' }, { status: 503 })
            : Response.json(report([entry(1, '早期过程')]))
          : Response.json({
              ...report([entry(2, '近期过程')]),
              totalEntries: 2,
              truncated: true,
              nextBeforeSeq: 2,
            })
        : undefined,
    )
    mount(api, search)
    await screen.findByRole('alert')
    expect(screen.getByText('保留的输入')).toBeTruthy()
    expect(screen.queryByText('近期过程')).toBeNull()
    expect(search.mock.lastCall?.[0]).toMatchObject({
      pending: false,
      failed: true,
      entries: [],
    })
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '重新读取本轮过程' }))
    expect(await screen.findByText('早期过程')).toBeTruthy()
    expect(screen.getAllByText('近期过程')).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() =>
      expect(search.mock.lastCall?.[0]).toMatchObject({
        pending: false,
        failed: false,
        entries: [{ text: '早期过程' }, { text: '近期过程' }],
      }),
    )
  })

  it('reveals saved thinking, planning, tool input and output, and child transcript in the conversation', async () => {
    const api = install(path => {
      if (path.includes('/activity?'))
        return Response.json(
          report([
            {
              ...entry(1, '核对口径的决策'),
              kind: 'thinking',
              detail: '缺失凭证不纳入已确认成本。',
            },
            {
              ...entry(2, '计划'),
              kind: 'tool_call',
              tool: 'todo_write',
              status: 'completed',
              semantic: {
                kind: 'todo',
                items: [{ content: '核对成本凭证', status: 'completed' }],
              },
            },
            {
              ...entry(3, '校验'),
              kind: 'tool_call',
              callId: 'tool-a',
              tool: 'bash',
              status: 'error',
              detail: '[输入]\npython check.py\n[结果]\n需要补充凭证',
              semantic: {
                kind: 'shell',
                command: 'python check.py',
                output: '需要补充凭证',
                exitCode: 1,
              },
            },
          ]),
        )
      if (path.includes('/subagents?'))
        return Response.json({
          runId: run.id,
          taskId: run.taskId,
          subagents: [
            {
              sessionId: 'child-a',
              parentSessionId: 'root',
              delegationDepth: 1,
              label: '核对助手',
              createdAt: run.createdAt,
              entries: [entry(1, '子 Agent 核对结论')],
              totalEntries: 2,
              truncated: true,
            },
          ],
        })
      return undefined
    })
    mount(api)
    await screen.findByText('缺失凭证不纳入已确认成本。')
    expect(screen.getByText('核对成本凭证')).toBeTruthy()
    expect(screen.getAllByText('python check.py').length).toBeGreaterThan(0)
    expect(screen.getByText('需要补充凭证')).toBeTruthy()
    fireEvent.click(screen.getByText('子 Agent · 核对助手'))
    expect(screen.getByText('子 Agent 核对结论')).toBeTruthy()
    expect(screen.getByText(/源记录已截断/)).toBeTruthy()
  })

  it.each(['foreign', 'loop', 'incomplete'])(
    'rejects %s history rather than presenting it as complete',
    async mode => {
      const api = install(path =>
        path.includes('/activity?')
          ? Response.json({
              ...report([entry(2, '不能显示的过程')]),
              ...(mode === 'foreign'
                ? { taskId: 'other' }
                : mode === 'loop'
                  ? { totalEntries: 3, nextBeforeSeq: 2 }
                  : { totalEntries: 3, truncated: true }),
            })
          : undefined,
      )
      mount(api)
      await screen.findByRole('alert')
      expect(screen.queryByText('不能显示的过程')).toBeNull()
      expect(screen.getByText('保留的输入')).toBeTruthy()
    },
  )

  it('does not let an old response replace another task after navigation', async () => {
    const search = vi.fn<(snapshot: TaskActivitySearchSnapshot) => void>()
    let resolve!: (response: Response) => void
    const api = install(path =>
      path.includes('/run-a/activity?')
        ? new Promise<Response>(done => {
            resolve = done
          })
        : path.includes('/run-b/activity?')
          ? Response.json({
              ...report([entry(1, 'B 的过程')]),
              runId: 'run-b',
              taskId: 'task-b',
            })
          : path.includes('/run-b/subagents?')
            ? Response.json({ runId: 'run-b', taskId: 'task-b', subagents: [] })
            : undefined,
    )
    const view = mount(api, search)
    await waitFor(() => expect(resolve).toBeTypeOf('function'))
    expect(search.mock.lastCall?.[0]).toMatchObject({
      taskId: 'task-a',
      pending: true,
      entries: [],
    })
    view.rerender(
      <TaskConversationHistory
        api={api}
        taskId="task-b"
        runs={[{ ...run, id: 'run-b', taskId: 'task-b' }]}
        messages={[]}
        renderMessage={renderMessage}
        onSearchSnapshot={search}
      />,
    )
    await screen.findByText('B 的过程')
    resolve(Response.json(report([entry(1, 'A 的旧响应')])))
    await waitFor(() => expect(screen.queryByText('A 的旧响应')).toBeNull())
    expect(search.mock.lastCall?.[0]).toMatchObject({
      taskId: 'task-b',
      entries: [{ text: 'B 的过程' }],
    })
  })

  it('refreshes an active run even before its version changes and preserves earlier records on a failed refresh', async () => {
    const search = vi.fn<(snapshot: TaskActivitySearchSnapshot) => void>()
    let count = 0
    const api = install(path =>
      path.includes('/activity?')
        ? ++count === 2
          ? Response.json({ message: '临时离线' }, { status: 503 })
          : Response.json(
              report([
                entry(1, '持续可读的过程'),
                ...(count > 2 ? [entry(2, '新增过程')] : []),
              ]),
            )
        : undefined,
    )
    vi.useFakeTimers()
    try {
      render(
        <TaskConversationHistory
          api={api}
          taskId={run.taskId}
          runs={[{ ...run, status: 'running' }]}
          messages={messages}
          renderMessage={renderMessage}
          onSearchSnapshot={search}
        />,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(screen.getByText('持续可读的过程')).toBeTruthy()
      expect(search.mock.lastCall?.[0]).toMatchObject({
        failed: false,
        entries: [{ text: '持续可读的过程' }],
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(screen.getByRole('alert').textContent).toContain('临时离线')
      expect(search.mock.lastCall?.[0]).toMatchObject({
        failed: true,
        entries: [{ text: '持续可读的过程' }],
      })
      expect(screen.getByText('持续可读的过程')).toBeTruthy()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(screen.getByText('新增过程')).toBeTruthy()
      expect(search.mock.lastCall?.[0]).toMatchObject({
        failed: false,
        entries: [{ text: '持续可读的过程' }, { text: '新增过程' }],
      })
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('shows root activity without waiting for a slow child transcript request', async () => {
    const api = install(path =>
      path.includes('/activity?')
        ? Response.json(report([entry(1, '已读取的根记录')]))
        : path.includes('/subagents?')
          ? new Promise<Response>(() => {
              /* Simulate an outstanding child read until unmount. */
            })
          : undefined,
    )
    mount(api)
    expect(await screen.findByText('已读取的根记录')).toBeTruthy()
  })

  it('keeps root activity visible when child transcripts fail and retries the child read', async () => {
    let fail = true
    const api = install(path =>
      path.includes('/activity?')
        ? Response.json(report([entry(1, '根执行结果')]))
        : path.includes('/subagents?') && fail
          ? Response.json({ message: '子记录离线' }, { status: 503 })
          : undefined,
    )
    mount(api)
    await screen.findByText('根执行结果')
    await screen.findByText('子 Agent 记录读取失败，请重试。')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '重新读取本轮过程' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByText('根执行结果')).toBeTruthy()
  })

  it('keeps completed history cached when a new snapshot has the same run version', async () => {
    const api = install(path =>
      path.includes('/activity?')
        ? Response.json(report([entry(1, '只读取一次的过程')]))
        : undefined,
    )
    const view = mount(api)
    await screen.findByText('只读取一次的过程')
    view.rerender(
      <TaskConversationHistory
        api={api}
        taskId={run.taskId}
        runs={[{ ...run }]}
        messages={messages}
        renderMessage={renderMessage}
      />,
    )
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([path]) => typeof path === 'string' && path.includes('/activity?'),
        ),
    ).toHaveLength(1)
  })
})
