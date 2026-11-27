import { ChannelSidebar, type OrganizeChannel } from './ChannelOrganization'
import type { ChannelListClient } from './useChannelPage'
import {
  Archive,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Layers3,
  MessageCircle,
  MoonStar,
  Search,
  Settings,
  Sun,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SidebarNav,
} from '@bui/index'

import type {
  ChannelSearchFilters,
  ChannelSearchResult,
  ChannelSearchSort,
  WorkChannel,
  WorkerIconId,
} from '../types'
import { PegasMark } from './PegasMark'
import { PegasMascot, type PegasMascotPose } from './PegasMascot'
import type { AppPage } from './types'

const APP_PAGES: readonly AppPage[] = [
  'conversation',
  'work',
  'attention',
  'automation',
  'memory',
  'settings',
]

const navItems: readonly {
  id: AppPage
  label: string
  icon: typeof MessageCircle
}[] = [
  { id: 'conversation', label: '对话', icon: MessageCircle },
  { id: 'work', label: '所有事情', icon: Archive },
  { id: 'attention', label: '待你处理', icon: CheckCircle2 },
  { id: 'automation', label: '自动化', icon: Zap },
  { id: 'memory', label: '记忆', icon: Layers3 },
]

interface AppShellProps {
  activeTaskId?: string
  page: AppPage
  connectionStatus: 'connecting' | 'online' | 'offline'
  onNavigate: (page: AppPage) => void
  channels: WorkChannel[]
  client?: ChannelListClient
  onOrganize?: OrganizeChannel
  attentionTodoCount: number
  onOpenChannel: (channel: WorkChannel) => void
  children: React.ReactNode
}

export function AppShell({
  activeTaskId,
  page,
  connectionStatus,
  onNavigate,
  channels,
  attentionTodoCount,
  client,
  onOrganize,
  onOpenChannel,
  children,
}: AppShellProps) {
  return (
    <div
      className={`bui ${page === 'settings' ? 'app-shell is-settings' : 'app-shell'}`}
    >
      <a className="skip-link" href="#pegas-main">
        跳到主要内容
      </a>
      <div className="primary-rail bui-rail">
        <SidebarNav
          ariaLabel="主导航"
          fill
          showNewChat={false}
          activeNav={activeTaskId ? '' : page}
          activeRecentId={activeTaskId}
          activeTitle={null}
          navigateOnPick={false}
          navItems={navItems.map(({ id, label, icon: Icon }) => ({
            key: id,
            label,
            icon: <Icon size={18} strokeWidth={1.8} />,
            count:
              id === 'attention' && attentionTodoCount > 0
                ? String(Math.min(attentionTodoCount, 99))
                : undefined,
          }))}
          onNavigate={key => {
            const target = APP_PAGES.find(item => item === key)
            if (target) onNavigate(target)
          }}
          recentsSlot={
            page === 'settings' ? (
              <></>
            ) : (
              <ChannelSidebar
                channels={channels}
                {...(activeTaskId ? { activeTaskId } : {})}
                {...(client ? { client } : {})}
                onOpen={onOpenChannel}
                {...(onOrganize ? { onOrganize } : {})}
              />
            )
          }
          recentsLabel="最近的事情"
          recentsNavKey="conversation"
          recents={channels.slice(0, 8).map(channel => ({
            id: channel.id,
            label: channel.title,
          }))}
          onPick={id => {
            const channel = channels.find(item => item.id === id)
            if (channel) onOpenChannel(channel)
          }}
          footerLabel="设置"
          footerIcon={<Settings size={15} />}
          onFooterClick={() => onNavigate('settings')}
          workspaceSlot={
            <div className="brand-lockup sidebar-workspace-control absolute left-2 top-0 flex h-10 items-center gap-2 px-2">
              <PegasMark size={26} />
              <div className="sidebar-copy grid min-w-0">
                <strong>Pegas</strong>
                <span className={`connection-${connectionStatus}`}>
                  <i />
                  {connectionStatus === 'online'
                    ? '在线'
                    : connectionStatus === 'connecting'
                      ? '连接中'
                      : '离线'}
                </span>
              </div>
            </div>
          }
        />
      </div>
      <main className="main-canvas" id="pegas-main">
        {children}
      </main>
      <nav className="mobile-nav" aria-label="移动端主导航">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            className={page === id ? 'is-active' : ''}
            key={id}
            onClick={() => onNavigate(id)}
            type="button"
          >
            <Icon size={20} />
            <span>{label}</span>
          </button>
        ))}
        <button
          className={page === 'settings' ? 'is-active' : ''}
          onClick={() => onNavigate('settings')}
          type="button"
        >
          <Settings size={20} />
          <span>设置</span>
        </button>
      </nav>
    </div>
  )
}

export function PageToolbar({
  onSearch,
  onToggleAppearance,
  isDark,
  showSearch = true,
}: {
  onSearch: () => void
  onToggleAppearance: () => void
  isDark: boolean
  showSearch?: boolean
}) {
  const appearanceLabel = isDark ? '切换到明亮外观' : '切换到深色外观'
  return (
    <div className="page-toolbar flex items-center gap-1">
      {showSearch && (
        <Button
          aria-label="全局搜索"
          className="size-[38px] rounded-control p-0 text-ink-2"
          onClick={onSearch}
          size="xs"
          type="button"
          variant="quiet"
        >
          <Search size={20} />
        </Button>
      )}
      <Button
        aria-label={appearanceLabel}
        className="size-[38px] rounded-control p-0 text-ink-2"
        onClick={onToggleAppearance}
        size="xs"
        title={appearanceLabel}
        type="button"
        variant="quiet"
      >
        {isDark ? <Sun size={20} /> : <MoonStar size={20} />}
      </Button>
    </div>
  )
}

export function GlobalSearch({
  channels,
  onClose,
  onOpen,
  onSearch,
}: {
  channels: WorkChannel[]
  onClose: () => void
  onOpen: (channel: WorkChannel) => void
  onSearch?: (
    query: string,
    filters: ChannelSearchFilters,
    cursor?: string,
  ) => Promise<ChannelSearchResult>
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ChannelSearchResult>()
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [scope, setScope] = useState<'all' | 'active' | 'ended'>('all')
  const [needsAttention, setNeedsAttention] = useState(false)
  const [workerIcon, setWorkerIcon] = useState<WorkerIconId | 'all'>('all')
  const [sort, setSort] = useState<ChannelSearchSort>('updated')
  const [loadingMore, setLoadingMore] = useState(false)
  const searchRequestRef = useRef(0)
  const trimmedQuery = query.trim()
  const hasFilters =
    scope !== 'all' ||
    needsAttention ||
    workerIcon !== 'all' ||
    sort !== 'updated'
  const serverMode = Boolean(onSearch) && (Boolean(trimmedQuery) || hasFilters)
  const runSearch = useCallback(
    (searchQuery: string, filters: ChannelSearchFilters) => {
      if (!onSearch) return
      const requestId = searchRequestRef.current + 1
      searchRequestRef.current = requestId
      setSearching(true)
      setLoadingMore(false)
      onSearch(searchQuery, filters)
        .then(next => {
          if (requestId !== searchRequestRef.current) return
          setResult(next)
          setSearchError('')
          setSearching(false)
        })
        .catch((caught: unknown) => {
          if (requestId !== searchRequestRef.current) return
          setSearchError(
            caught instanceof Error ? caught.message : '搜索失败，请重试。',
          )
          setSearching(false)
        })
    },
    [onSearch],
  )
  useEffect(() => {
    if (!onSearch) return
    if (!trimmedQuery && !hasFilters) {
      searchRequestRef.current += 1
      setResult(undefined)
      setSearching(false)
      setSearchError('')
      setLoadingMore(false)
      return
    }
    const filters: ChannelSearchFilters = {
      sort,
      ...(scope === 'all' ? {} : { ended: scope === 'ended' }),
      ...(needsAttention ? { needsAttention: true } : {}),
      ...(workerIcon === 'all' ? {} : { workerIconId: workerIcon }),
    }
    const timer = window.setTimeout(
      () => runSearch(trimmedQuery, filters),
      trimmedQuery ? 200 : 0,
    )
    return () => window.clearTimeout(timer)
  }, [
    onSearch,
    runSearch,
    trimmedQuery,
    hasFilters,
    scope,
    needsAttention,
    workerIcon,
    sort,
  ])
  async function loadMore() {
    if (!onSearch || !result?.nextCursor || loadingMore || searching) return
    const cursor = result.nextCursor
    const requestId = searchRequestRef.current
    const filters: ChannelSearchFilters = {
      sort,
      ...(scope === 'all' ? {} : { ended: scope === 'ended' }),
      ...(needsAttention ? { needsAttention: true } : {}),
      ...(workerIcon === 'all' ? {} : { workerIconId: workerIcon }),
    }
    setLoadingMore(true)
    try {
      const next = await onSearch(trimmedQuery, filters, cursor)
      if (requestId !== searchRequestRef.current) return
      setResult(current =>
        current
          ? {
              channels: [
                ...current.channels,
                ...next.channels.filter(
                  channel =>
                    !current.channels.some(item => item.id === channel.id),
                ),
              ],
              matches: [...current.matches, ...next.matches],
              ...(next.nextCursor ? { nextCursor: next.nextCursor } : {}),
            }
          : next,
      )
      setSearchError('')
    } catch (caught) {
      if (requestId !== searchRequestRef.current) return
      setSearchError(
        caught instanceof Error ? caught.message : '加载更多结果失败。',
      )
    } finally {
      if (requestId === searchRequestRef.current) setLoadingMore(false)
    }
  }
  const localChannels = channels
    .filter(channel =>
      `${channel.title} ${channel.goal}`
        .toLowerCase()
        .includes(trimmedQuery.toLowerCase()),
    )
    .slice(0, 5)
  const visibleChannels = serverMode ? (result?.channels ?? []) : localChannels
  const snippetFor = (channelId: string) =>
    result?.matches.find(
      match => match.channelId === channelId && match.sourceKind !== 'channel',
    )?.snippet ??
    result?.matches.find(match => match.channelId === channelId)?.snippet
  const resultRefs = useRef<(HTMLButtonElement | null)[]>([])
  resultRefs.current = []
  const filterControls: {
    label: string
    pressed: boolean
    toggle: () => void
  }[] = [
    { label: '全部', pressed: scope === 'all', toggle: () => setScope('all') },
    {
      label: '进行中',
      pressed: scope === 'active',
      toggle: () => setScope('active'),
    },
    {
      label: '已结束',
      pressed: scope === 'ended',
      toggle: () => setScope('ended'),
    },
    {
      label: '需关注',
      pressed: needsAttention,
      toggle: () => setNeedsAttention(current => !current),
    },
  ]
  function focusResult(index: number) {
    const options = resultRefs.current.filter(Boolean)
    if (!options.length) return
    const clamped = Math.max(0, Math.min(index, options.length - 1))
    options[clamped]?.focus()
  }
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  return (
    <Dialog open onOpenChange={next => !next && onClose()}>
      <DialogContent
        aria-label="全局搜索"
        className="command-dialog top-[12vh] w-[min(640px,calc(100vw-32px))] translate-y-0 overflow-hidden rounded-window p-0 max-[820px]:top-[8vh] max-[820px]:w-[calc(100vw-28px)]"
        closeLabel="关闭搜索"
      >
        <DialogTitle className="visually-hidden">全局搜索</DialogTitle>
        <div className="flex items-center gap-3 border-b border-line py-[15px] pr-[52px] pl-[18px] pointer-coarse:pr-[64px]">
          <Search className="shrink-0 text-ink-3" size={20} />
          <input
            aria-label="搜索事情"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3"
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                focusResult(0)
              }
            }}
            placeholder="搜索事情"
            ref={inputRef}
            value={query}
          />
        </div>
        {onSearch && (
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-line px-[18px] py-2.5">
            <div
              aria-label="搜索状态筛选"
              className="flex flex-wrap gap-1.5"
              role="group"
            >
              {filterControls.map(control => (
                <Button
                  aria-pressed={control.pressed}
                  className="h-[26px] px-3 text-[12px] aria-pressed:bg-accent-tint aria-pressed:text-accent-ink aria-pressed:shadow-[0_0_0_1px_var(--accent)]"
                  key={control.label}
                  onClick={control.toggle}
                  size="xs"
                  type="button"
                  variant="secondary"
                >
                  {control.label}
                </Button>
              ))}
            </div>
            <div className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
              <span>排序</span>
              <Select
                onValueChange={value => setSort(value as ChannelSearchSort)}
                value={sort}
              >
                <SelectTrigger
                  aria-label="搜索排序"
                  className="h-[26px] rounded-chip px-2 text-[12px] font-normal shadow-hairline hover:bg-inset"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="updated">最近更新</SelectItem>
                  <SelectItem value="created">最近创建</SelectItem>
                  <SelectItem value="ended">最近结束</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
              <span>执行者</span>
              <Select
                onValueChange={value =>
                  setWorkerIcon(value as WorkerIconId | 'all')
                }
                value={workerIcon}
              >
                <SelectTrigger
                  aria-label="执行者筛选"
                  className="h-[26px] rounded-chip px-2 text-[12px] font-normal shadow-hairline hover:bg-inset"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="car">汽车</SelectItem>
                  <SelectItem value="camera">相机</SelectItem>
                  <SelectItem value="computer">电脑</SelectItem>
                  <SelectItem value="phone">手机</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        <div className="max-h-[min(52vh,460px)] overflow-y-auto">
          <p className="mt-3.5 mb-1.5 px-[18px] text-[11px] text-ink-2 uppercase">
            {serverMode ? '搜索结果' : '最近'}
          </p>
          {searchError && (
            <div
              className="px-[18px] pt-6 pb-9 text-center text-[13px] text-ink-2"
              role="alert"
            >
              {searchError}
              <button
                className="inline-link mt-0 inline-flex items-center gap-[5px] font-medium text-accent-ink"
                onClick={() =>
                  runSearch(trimmedQuery, {
                    sort,
                    ...(scope === 'all' ? {} : { ended: scope === 'ended' }),
                    ...(needsAttention ? { needsAttention: true } : {}),
                    ...(workerIcon === 'all'
                      ? {}
                      : { workerIconId: workerIcon }),
                  })
                }
                type="button"
              >
                重试
              </button>
            </div>
          )}
          {searching && !searchError && (
            <div className="px-[18px] pt-6 pb-9 text-center text-[13px] text-ink-2">
              正在搜索…
            </div>
          )}
          {!searching && !searchError && visibleChannels.length ? (
            visibleChannels.map((channel, index) => (
              <button
                className="grid w-full grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 px-[18px] py-3 text-left transition-colors duration-100 hover:bg-hover"
                key={channel.id}
                onClick={() => onOpen(channel)}
                onKeyDown={event => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    focusResult(index + 1)
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    if (index === 0) inputRef.current?.focus()
                    else focusResult(index - 1)
                  }
                }}
                ref={element => {
                  resultRefs.current[index] = element
                }}
                type="button"
              >
                <Clock3 className="text-ink-3" size={17} />
                <span className="grid min-w-0 gap-0.5">
                  <strong className="truncate text-[13px] font-medium text-ink">
                    {channel.title}
                  </strong>
                  <small className="truncate text-[12px] text-ink-2">
                    {snippetFor(channel.id) ?? channel.goal}
                  </small>
                </span>
                <ChevronRight className="text-ink-3" size={16} />
              </button>
            ))
          ) : !searching && !searchError ? (
            <div className="px-[18px] pt-6 pb-9 text-center text-[13px] text-ink-2">
              {trimmedQuery || hasFilters || channels.length
                ? '没有匹配的事情'
                : '还没有可搜索的事情'}
            </div>
          ) : null}
          {serverMode && !searching && Boolean(result?.nextCursor) && (
            <Button
              className="h-auto w-full rounded-none border-t border-line px-[18px] py-2.5 text-[13px] text-accent-ink shadow-none"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              type="button"
              variant="quiet"
            >
              {loadingMore ? '正在加载…' : '加载更多'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function EmptyCapability({
  icon: Icon = Bot,
  title,
  description,
  availabilityLabel,
  mascot,
}: {
  icon?: typeof Bot
  title: string
  description: string
  availabilityLabel?: string
  mascot?: PegasMascotPose
}) {
  return (
    <div className="empty-capability">
      {mascot ? (
        <PegasMascot pose={mascot} size={104} />
      ) : (
        <span>
          <Icon size={24} />
        </span>
      )}
      <h2>{title}</h2>
      <p>{description}</p>
      {availabilityLabel && <small>{availabilityLabel}</small>}
    </div>
  )
}
