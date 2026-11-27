// @vitest-environment jsdom
import '../test-env'
import {
  act,
  waitFor,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkPage } from './MainPages'
import {
  ChannelSidebar,
  ChannelOrganizationActions,
} from './ChannelOrganization'
import type {
  ChannelSearchFilters,
  ChannelSearchResult,
  WorkChannel,
} from '../types'

const stopped: WorkChannel = {
  id: 'stopped',
  taskId: 'stopped',
  userId: 'owner',
  originEventId: 'event',
  title: '已经停止的事情',
  goal: '讨论',
  status: 'cancelled',
  workerIconId: 'computer',
  createdAt: '2026-11-20T00:00:00Z',
  updatedAt: '2026-11-20T00:00:00Z',
  latestActivityAt: '2026-11-20T00:00:00Z',
  canStop: false,
  canResume: false,
}
const actions = {
  onSearch: vi.fn(),
  onToggleAppearance: vi.fn(),
  isDark: false,
  onOpenDrawer: vi.fn(),
}
afterEach(cleanup)
describe('CHANNEL-004 lists', () => {
  it('does not label stopped tasks as archived', () => {
    render(
      <WorkPage
        actions={actions}
        snapshot={{ channels: [stopped], runs: [], events: [], messages: [] }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '已归档' }))
    expect(
      within(screen.getByRole('region', { name: '事情列表' })).queryByText(
        stopped.title,
      ),
    ).toBeNull()
  })
})

const empty = { channels: [], matches: [] }
it('uses server pages, preserves continuation for retry and resets filters', async () => {
  const second = {
    ...stopped,
    id: 'second',
    taskId: 'second',
    title: '第二件事情',
  }
  const searchChannels = vi
    .fn()
    .mockResolvedValueOnce({
      channels: [stopped],
      matches: [],
      nextCursor: 'cursor-1',
    })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ channels: [stopped, second], matches: [] })
    .mockResolvedValue(empty)
  render(
    <WorkPage
      client={{ searchChannels }}
      actions={actions}
      snapshot={{ channels: [], runs: [], events: [], messages: [] }}
    />,
  )
  expect(await screen.findByText(stopped.title)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '加载更多事情' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByText(stopped.title)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText(second.title)).toBeTruthy()
  expect(screen.getAllByText(stopped.title)).toHaveLength(1)
  expect(searchChannels.mock.calls[2]?.[2]).toBe('cursor-1')
  fireEvent.click(screen.getByRole('button', { name: '已归档' }))
  await waitFor(() =>
    expect(searchChannels).toHaveBeenLastCalledWith(
      '',
      { sort: 'updated', archived: true },
      undefined,
    ),
  )
  fireEvent.click(screen.getByRole('button', { name: '排序：最近更新' }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: '最近创建' }))
  await waitFor(() =>
    expect(searchChannels).toHaveBeenLastCalledWith(
      '',
      { sort: 'created', archived: true },
      undefined,
    ),
  )
})

it('discards a stale query response after changing scope', async () => {
  let resolveOld!: (value: ChannelSearchResult) => void
  const searchChannels = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<ChannelSearchResult>(resolve => {
          resolveOld = resolve
        }),
    )
    .mockResolvedValue(empty)
  render(
    <WorkPage
      client={{ searchChannels }}
      actions={actions}
      snapshot={{ channels: [], runs: [], events: [], messages: [] }}
    />,
  )
  await waitFor(() => expect(searchChannels).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: '已归档' }))
  await waitFor(() => expect(searchChannels).toHaveBeenCalledTimes(2))
  await act(async () => {
    resolveOld({ channels: [stopped], matches: [] })
    await Promise.resolve()
  })
  expect(screen.queryByText(stopped.title)).toBeNull()
})

it('keeps old pinned work reachable independently from recent pagination', async () => {
  const pinned = {
    ...stopped,
    id: 'pinned',
    title: '长期会议纪要',
    organization: { pinned: true, archived: false, revision: 1 },
  }
  const searchChannels = vi.fn(
    (_query: string, filters?: ChannelSearchFilters, cursor?: string) =>
      Promise.resolve(
        filters?.pinned
          ? { channels: [pinned], matches: [] }
          : cursor
            ? { channels: [stopped], matches: [] }
            : { ...empty, nextCursor: 'older' },
      ),
  )
  const onOpen = vi.fn()
  render(
    <ChannelSidebar
      client={{ searchChannels }}
      channels={[]}
      onOpen={onOpen}
    />,
  )
  const fixed = screen.getByRole('list', { name: '固定的事情' })
  fireEvent.click(
    await within(fixed).findByRole('button', { name: pinned.title }),
  )
  expect(onOpen).toHaveBeenCalledWith(pinned)
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
  expect(
    await within(screen.getByRole('list', { name: '最近的事情' })).findByText(
      stopped.title,
    ),
  ).toBeTruthy()
  expect(within(fixed).getByText(pinned.title)).toBeTruthy()
})

it('submits reversible organization changes and keeps a retry path on failure', async () => {
  const onOrganize = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined)
  render(
    <ChannelOrganizationActions channel={stopped} onOrganize={onOrganize} />,
  )
  fireEvent.click(screen.getByRole('button', { name: '整理事情' }))
  fireEvent.click(
    screen.getByRole('button', { name: `固定：${stopped.title}` }),
  )
  expect(await screen.findByRole('alert')).toBeTruthy()
  fireEvent.click(
    screen.getByRole('button', { name: `固定：${stopped.title}` }),
  )
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(onOrganize).toHaveBeenLastCalledWith(stopped, { pinned: true })
  fireEvent.click(
    screen.getByRole('button', { name: `归档：${stopped.title}` }),
  )
  await waitFor(() =>
    expect(onOrganize).toHaveBeenLastCalledWith(stopped, { archived: true }),
  )
})
