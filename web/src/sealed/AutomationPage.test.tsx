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

import type { Automation, WorkChannel } from '../types'
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
})
