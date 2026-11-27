import {
  Archive,
  ArchiveRestore,
  Pin,
  PinOff,
  MoreHorizontal,
} from 'lucide-react'
import { useState } from 'react'
import { Button, Popover, PopoverContent, PopoverTrigger } from '@bui/index'
import type { WorkChannel } from '../types'
import { sortWorkChannels } from './types'
import {
  channelListKey,
  useChannelPage,
  type ChannelListClient,
} from './useChannelPage'

export type OrganizeChannel = (
  channel: WorkChannel,
  change: { pinned?: boolean; archived?: boolean },
) => Promise<void>

export function ChannelOrganizationActions({
  channel,
  onOrganize,
}: {
  channel: WorkChannel
  onOrganize: OrganizeChannel
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function change(update: { pinned?: boolean; archived?: boolean }) {
    if (pending) return
    setPending(true)
    setError('')
    try {
      await onOrganize(channel, update)
    } catch {
      setError('保存失败，请重试；若其他设备已修改，请刷新。')
    } finally {
      setPending(false)
    }
  }
  const pinned = channel.organization?.pinned ?? false
  const archived = channel.organization?.archived ?? false
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label="整理事情"
          className="channel-organization-trigger"
          title="整理事情"
          size="xs"
          variant="quiet"
          type="button"
        >
          <MoreHorizontal size={16} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="channel-organization flex w-52 flex-col items-stretch gap-1"
        align="end"
      >
        <p className="truncate px-2 text-[12px] text-ink-2">{channel.title}</p>
        <Button
          aria-label={`${pinned ? '取消固定' : '固定'}：${channel.title}`}
          disabled={pending}
          onClick={() => void change({ pinned: !pinned })}
          size="xs"
          variant="quiet"
          type="button"
        >
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          {pinned ? '取消固定' : '固定'}
        </Button>
        <Button
          aria-label={`${archived ? '恢复' : '归档'}：${channel.title}`}
          disabled={pending}
          onClick={() => void change({ archived: !archived })}
          size="xs"
          variant="quiet"
          type="button"
        >
          {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          {archived ? '恢复' : '归档'}
        </Button>
        {error && (
          <span className="w-full text-[12px] text-red" role="alert">
            {error}
          </span>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function ChannelSidebar({
  channels,
  client,
  onOpen,
  onOrganize,
  activeTaskId,
}: {
  activeTaskId?: string
  channels: WorkChannel[]
  client?: ChannelListClient
  onOpen: (channel: WorkChannel) => void
  onOrganize?: OrganizeChannel
}) {
  const refresh = channelListKey(channels)
  const pinned = useChannelPage(
    client,
    '',
    { pinned: true, archived: false, sort: 'created' },
    refresh,
  )
  const recent = useChannelPage(
    client,
    '',
    { pinned: false, archived: false, sort: 'updated' },
    refresh,
  )
  const [visibleCount, setVisibleCount] = useState(8)
  const fallback = sortWorkChannels(channels, 'updated').filter(
    channel => !channel.organization?.archived,
  )
  return (
    <div className="sidebar-copy channel-sidebar">
      {(
        [
          {
            title: '固定的事情',
            page: pinned,
            items: client
              ? pinned.channels
              : fallback.filter(c => c.organization?.pinned),
          },
          {
            title: '最近的事情',
            page: recent,
            items: client
              ? recent.channels
              : fallback
                  .filter(c => !c.organization?.pinned)
                  .slice(0, visibleCount),
          },
        ] as const
      ).map(group => (
        <section key={group.title} className="mb-5 px-2">
          <h2 className="px-2 py-2 text-[12px] font-medium text-ink-2">
            {group.title}
          </h2>
          <ul
            className="m-0 list-none p-0"
            role="list"
            aria-label={group.title}
          >
            {group.items.map(channel => (
              <li
                key={channel.id}
                className="flex min-w-0 items-center rounded-control hover:bg-hover"
              >
                <button
                  className="sidebar-row flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-control px-2 text-left text-[13px] text-ink-2 aria-[current=page]:bg-hover-2 aria-[current=page]:text-ink"
                  title={channel.title}
                  aria-current={
                    activeTaskId === channel.id ? 'page' : undefined
                  }
                  type="button"
                  onClick={() => onOpen(channel)}
                >
                  {channel.organization?.pinned && (
                    <Pin className="shrink-0" size={13} aria-hidden="true" />
                  )}
                  <span className="min-w-0 truncate">{channel.title}</span>
                </button>
                {onOrganize && (
                  <ChannelOrganizationActions
                    channel={channel}
                    onOrganize={onOrganize}
                  />
                )}
              </li>
            ))}
          </ul>
          {!group.items.length && !group.page.loading && !group.page.error && (
            <p className="px-2 text-[12px] text-ink-2">
              {group.title === '固定的事情'
                ? '固定常用的事情，方便下次继续。'
                : '还没有最近的事情'}
            </p>
          )}
          {group.page.error && (
            <p className="px-2 text-[12px] text-red" role="alert">
              {group.page.error}
            </p>
          )}
          {(Boolean(group.page.nextCursor) || Boolean(group.page.error)) && (
            <Button
              className="mt-1"
              disabled={group.page.loading}
              onClick={group.page.loadMore}
              size="xs"
              variant="quiet"
              type="button"
            >
              {group.page.error ? '重试' : '加载更多'}
            </Button>
          )}
          {group.page.loading && (
            <p className="px-2 text-[12px] text-ink-2">正在加载…</p>
          )}
          {!client &&
            group.title === '最近的事情' &&
            fallback.filter(c => !c.organization?.pinned).length >
              visibleCount && (
              <Button
                onClick={() => setVisibleCount(n => n + 8)}
                size="xs"
                variant="quiet"
                type="button"
              >
                加载更多
              </Button>
            )}
        </section>
      ))}
    </div>
  )
}
