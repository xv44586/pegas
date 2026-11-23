// @vitest-environment jsdom

import '../test-env'

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Automation, AutomationInvocation, WorkChannel } from '../types'
import { AutomationPage } from './MainPages'

afterEach(cleanup)

const actions = {
  onSearch: vi.fn(),
  onToggleAppearance: vi.fn(),
  isDark: false,
  onOpenDrawer: vi.fn(),
}

const longPrompt = [
  '这是「从 1 数到 10」周期自动化的本次触发，是独立的机器输入。',
  '严格按以下步骤执行，禁止用 sleep/循环模拟周期等待：',
  '1. 读取状态文件 /Users/ming/.pegas/workspaces/bf7a95154b6f/count-automation-state.json，字段为 {count, automationId, revision}。',
  '2. 将 count 加 1，写回状态文件（automationId、revision 字段保持不变）。',
  '3. 报数：使用本次触发 Run 自己的环境变量 PEGAS_CONTROL_PLANE_URL、PEGAS_RUN_ID，以及 PEGAS_RUN_CAPABILITY_FILE 指向的本机 JSON 文件中的 claimToken，调用 POST /v1/runs/:runId/messages。',
  '4. 若加 1 后的 count 等于 10，报数完成后取消本自动化。',
  '5. 若 count 小于 10，报数后直接结束本次 Run，把等待交给调度器，下一次触发继续。',
].join('\n')

function automationFixture(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    userId: 'owner',
    revision: 1,
    title: '每分钟报数 1→10',
    prompt: longPrompt,
    schedule: { kind: 'interval', everySeconds: 60 },
    target: { kind: 'existing_task', taskId: 'task-1' },
    status: 'active',
    nextFireAt: '2026-11-23T07:00:00.000Z',
    lastFiredAt: '2026-11-23T06:59:00.000Z',
    createdAt: '2026-11-23T06:00:00.000Z',
    updatedAt: '2026-11-23T06:59:00.000Z',
    ...overrides,
  }
}

const channel: WorkChannel = {
  id: 'task-1',
  taskId: 'task-1',
  userId: 'owner',
  originEventId: 'event-1',
  title: '每分钟数数 1 到 10 的周期自动化',
  goal: '每分钟数一个数',
  status: 'started',
  workerIconId: 'computer',
  canResume: false,
  canStop: true,
  latestActivityAt: '2026-11-23T06:59:00.000Z',
  createdAt: '2026-11-23T06:00:00.000Z',
  updatedAt: '2026-11-23T06:59:00.000Z',
}

function renderPage(
  automations: Automation[],
  overrides: Partial<Parameters<typeof AutomationPage>[0]> = {},
) {
  const props = {
    actions,
    automations,
    channels: [channel],
    error: '',
    onCreate: vi.fn(() => Promise.resolve()),
    onReload: vi.fn(),
    onSetStatus: vi.fn(() => Promise.resolve()),
    onUpdate: vi.fn(() => Promise.resolve()),
    ...overrides,
  }
  render(<AutomationPage {...props} />)
  return props
}

function invocationFixture(
  overrides: Partial<AutomationInvocation> = {},
): AutomationInvocation {
  return {
    id: 'inv-1',
    automationId: 'auto-1',
    userId: 'owner',
    scheduledFor: '2026-11-23T06:59:00.000Z',
    eventId: 'event-inv-1',
    status: 'dispatched',
    attempts: 1,
    createdAt: '2026-11-23T06:59:00.000Z',
    updatedAt: '2026-11-23T06:59:00.000Z',
    ...overrides,
  }
}

describe('DESIGN-006 automation list', () => {
  it('summarizes the machine prompt in one clamped line instead of dumping it', () => {
    renderPage([automationFixture()])
    const summary = document.querySelector('.automation-summary')
    expect(summary).toBeTruthy()
    expect(summary?.textContent).toContain('从 1 数到 10')
    expect(summary?.textContent).not.toContain('\n')
    expect((summary?.textContent ?? '').length).toBeLessThanOrEqual(160)
    expect(
      document.querySelector('.record-copy small:not(.record-meta)'),
    ).toBeNull()
  })

  it('keeps the full prompt behind an explicit disclosure', () => {
    renderPage([automationFixture()])
    expect(screen.queryByText(/PEGAS_RUN_CAPABILITY_FILE/)).toBeNull()
    const toggle = screen.getByRole('button', { name: '查看指令' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    const detail = document.querySelector('.automation-prompt')
    expect(detail?.textContent).toContain('PEGAS_RUN_CAPABILITY_FILE')
    expect(detail?.textContent).toContain('5. 若 count 小于 10')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '收起指令' }))
    expect(document.querySelector('.automation-prompt')).toBeNull()
  })

  it('renders schedule, target and timing as one plain meta row', () => {
    renderPage([automationFixture()])
    const meta = document.querySelector('.record-meta')
    expect(meta?.textContent).toContain('每 1 分钟')
    expect(meta?.textContent).toContain('续接：每分钟数数 1 到 10 的周期自动化')
    expect(meta?.textContent).toContain('下次触发')
    expect(document.querySelectorAll('.record-meta')).toHaveLength(1)
    expect(document.querySelector('.status-text')?.textContent).toBe('已启用')
  })

  it('groups ended automations behind a disclosure and keeps them reachable', () => {
    renderPage([
      automationFixture(),
      automationFixture({
        id: 'auto-2',
        title: '旧晨报',
        status: 'completed',
        nextFireAt: undefined,
      }),
      automationFixture({
        id: 'auto-3',
        title: '旧提醒',
        status: 'cancelled',
        nextFireAt: undefined,
      }),
    ])
    expect(screen.getByText('每分钟报数 1→10')).toBeTruthy()
    expect(screen.queryByText('旧晨报')).toBeNull()
    const toggle = screen.getByRole('button', { name: /已结束 2/ })
    fireEvent.click(toggle)
    expect(screen.getByText('旧晨报')).toBeTruthy()
    expect(screen.getByText('旧提醒')).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.queryByText('旧晨报')).toBeNull()
  })

  it('shows every automation flat when none is running', () => {
    renderPage([
      automationFixture({
        title: '旧晨报',
        status: 'completed',
        nextFireAt: undefined,
      }),
      automationFixture({
        id: 'auto-2',
        title: '旧提醒',
        status: 'cancelled',
        nextFireAt: undefined,
      }),
    ])
    expect(screen.getByText('旧晨报')).toBeTruthy()
    expect(screen.getByText('旧提醒')).toBeTruthy()
    expect(document.querySelectorAll('.record-list article')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /已结束 2/ })).toBeNull()
  })

  it('keeps pause and cancel commands working from the compact row', async () => {
    const pausing = renderPage([automationFixture()])
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    await waitFor(() =>
      expect(pausing.onSetStatus).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'auto-1' }),
        'pause',
      ),
    )
    cleanup()
    const props = renderPage([automationFixture()])
    fireEvent.click(screen.getByRole('button', { name: '结束' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '确认结束' })).toBeTruthy(),
    )
    fireEvent.click(screen.getByRole('button', { name: '确认结束' }))
    await waitFor(() =>
      expect(props.onSetStatus).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'auto-1' }),
        'cancel',
      ),
    )
  })

  it('offers two-step delete only on ended rows and removes the row after confirm', async () => {
    const ended = automationFixture({
      id: 'auto-ended',
      status: 'cancelled',
      nextFireAt: undefined,
    })
    const onDelete = vi.fn(() => Promise.resolve())
    const props = renderPage([automationFixture(), ended], { onDelete })
    fireEvent.click(screen.getByRole('button', { name: /已结束 1/ }))
    const deleteButtons = screen.getAllByRole('button', { name: '删除' })
    expect(deleteButtons).toHaveLength(1)
    const deleteButton = deleteButtons[0]
    if (!deleteButton) throw new Error('Expected delete button')
    fireEvent.click(deleteButton)
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保留' }))
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(1)
    const reopenedDelete = screen.getAllByRole('button', { name: '删除' })[0]
    if (!reopenedDelete) throw new Error('Expected delete button')
    fireEvent.click(reopenedDelete)
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() =>
      expect(props.onDelete).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'auto-ended' }),
      ),
    )
  })

  it('shows the run summary and a channel link per invocation, without inventing facts for failed runs', async () => {
    const onOpenChannel = vi.fn()
    renderPage([automationFixture()], {
      onLoadInvocations: () =>
        Promise.resolve({
          invocations: [
            invocationFixture({
              taskId: 'task-1',
              summary: '9',
            }),
            invocationFixture({
              id: 'inv-2',
              status: 'failed',
              attempts: 3,
              lastError: '目标事情已停止',
              scheduledFor: '2026-11-23T06:58:00.000Z',
            }),
          ],
        }),
      onOpenChannel,
    })
    fireEvent.click(screen.getByRole('button', { name: '触发记录' }))
    await waitFor(() => expect(screen.getByText('9')).toBeTruthy())
    expect(screen.getByText('目标事情已停止')).toBeTruthy()
    const links = screen.getAllByRole('button', { name: '查看事情' })
    expect(links).toHaveLength(1)
    const channelLink = links[0]
    if (!channelLink) throw new Error('Expected channel link')
    fireEvent.click(channelLink)
    expect(onOpenChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
    )
  })

  it('loads more invocations with the returned cursor and stops when exhausted', async () => {
    const onLoadInvocations = vi
      .fn()
      .mockResolvedValueOnce({
        invocations: [invocationFixture()],
        nextCursor: 'inv-1',
      })
      .mockResolvedValueOnce({
        invocations: [
          invocationFixture({
            id: 'inv-2',
            scheduledFor: '2026-11-23T06:58:00.000Z',
          }),
        ],
      })
    renderPage([automationFixture()], { onLoadInvocations })
    fireEvent.click(screen.getByRole('button', { name: '触发记录' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '加载更多' })).toBeTruthy(),
    )
    expect(onLoadInvocations.mock.calls[0]?.[0]).toMatchObject({
      id: 'auto-1',
    })
    expect(onLoadInvocations.mock.calls[0]?.[1]).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await waitFor(() => expect(onLoadInvocations).toHaveBeenCalledTimes(2))
    expect(onLoadInvocations).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'auto-1' }),
      'inv-1',
    )
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull(),
    )
    expect(screen.getAllByText(/计划/)).toHaveLength(2)
  })

  it('keeps loaded pages and offers retry when loading more fails', async () => {
    const onLoadInvocations = vi
      .fn()
      .mockResolvedValueOnce({
        invocations: [invocationFixture()],
        nextCursor: 'inv-1',
      })
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce({
        invocations: [invocationFixture({ id: 'inv-2' })],
      })
    renderPage([automationFixture()], { onLoadInvocations })
    fireEvent.click(screen.getByRole('button', { name: '触发记录' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '加载更多' })).toBeTruthy(),
    )
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await waitFor(() => expect(screen.getByText(/网络中断/)).toBeTruthy())
    expect(screen.getAllByText(/计划/)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(onLoadInvocations).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.getAllByText(/计划/)).toHaveLength(2))
  })

  it('orders live rows by next fire and ended rows by recency without a sort menu', () => {
    const later = automationFixture({
      id: 'auto-later',
      title: '晚触发',
      nextFireAt: '2026-11-23T08:00:00.000Z',
    })
    const sooner = automationFixture({
      id: 'auto-sooner',
      title: '早触发',
      nextFireAt: '2026-11-23T07:00:00.000Z',
    })
    const paused = automationFixture({
      id: 'auto-paused',
      title: '已暂停项',
      status: 'paused',
      nextFireAt: undefined,
    })
    const endedOld = automationFixture({
      id: 'auto-ended-old',
      title: '早结束',
      status: 'completed',
      nextFireAt: undefined,
      updatedAt: '2026-11-23T05:00:00.000Z',
    })
    const endedNew = automationFixture({
      id: 'auto-ended-new',
      title: '晚结束',
      status: 'cancelled',
      nextFireAt: undefined,
      updatedAt: '2026-11-23T06:30:00.000Z',
    })
    renderPage([endedOld, paused, later, endedNew, sooner])
    const liveTitles = screen
      .getByLabelText('自动化列表')
      .querySelectorAll('.record-title strong')
    expect([...liveTitles].map(node => node.textContent)).toEqual([
      '早触发',
      '晚触发',
      '已暂停项',
    ])
    fireEvent.click(screen.getByRole('button', { name: /已结束 2/ }))
    const endedTitles = screen
      .getByLabelText('已结束的自动化')
      .querySelectorAll('.record-title strong')
    expect([...endedTitles].map(node => node.textContent)).toEqual([
      '晚结束',
      '早结束',
    ])
    expect(screen.queryByRole('button', { name: /排序/ })).toBeNull()
  })
})
