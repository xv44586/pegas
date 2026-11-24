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
  X,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { SidebarNav } from '@bui/index'

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
  page: AppPage
  connectionStatus: 'connecting' | 'online' | 'offline'
  onNavigate: (page: AppPage) => void
  channels: WorkChannel[]
  attentionTodoCount: number
  onOpenChannel: (channel: WorkChannel) => void
  children: React.ReactNode
}

export function AppShell({
  page,
  connectionStatus,
  onNavigate,
  channels,
  attentionTodoCount,
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
          activeNav={page}
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
    <div className="page-toolbar">
      {showSearch && (
        <button aria-label="全局搜索" onClick={onSearch} type="button">
          <Search size={20} />
        </button>
      )}
      <button
        aria-label={appearanceLabel}
        onClick={onToggleAppearance}
        title={appearanceLabel}
        type="button"
      >
        {isDark ? <Sun size={20} /> : <MoonStar size={20} />}
      </button>
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
  const dialogRef = useRef<HTMLElement>(null)
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
    const containFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      )
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', containFocus)
    return () => document.removeEventListener('keydown', containFocus)
  }, [])
  return (
    <div
      className="modal-backdrop"
      onMouseDown={event => event.target === event.currentTarget && onClose()}
    >
      <section
        aria-label="全局搜索"
        aria-modal="true"
        className="command-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <div className="command-input">
          <Search size={20} />
          <input
            aria-label="搜索事情"
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
          <kbd>ESC</kbd>
        </div>
        {onSearch && (
          <div className="command-filters">
            <div
              aria-label="搜索状态筛选"
              className="command-filter-group"
              role="group"
            >
              {filterControls.map(control => (
                <button
                  aria-pressed={control.pressed}
                  className="command-filter"
                  key={control.label}
                  onClick={control.toggle}
                  type="button"
                >
                  {control.label}
                </button>
              ))}
            </div>
            <label className="command-select">
              <span>排序</span>
              <select
                aria-label="搜索排序"
                onChange={event =>
                  setSort(event.target.value as ChannelSearchSort)
                }
                value={sort}
              >
                <option value="updated">最近更新</option>
                <option value="created">最近创建</option>
                <option value="ended">最近结束</option>
              </select>
            </label>
            <label className="command-select">
              <span>执行者</span>
              <select
                aria-label="执行者筛选"
                onChange={event =>
                  setWorkerIcon(event.target.value as WorkerIconId | 'all')
                }
                value={workerIcon}
              >
                <option value="all">全部</option>
                <option value="car">汽车</option>
                <option value="camera">相机</option>
                <option value="computer">电脑</option>
                <option value="phone">手机</option>
              </select>
            </label>
          </div>
        )}
        <div className="command-dialog-body">
          <p className="command-section-label">
            {serverMode ? '搜索结果' : '最近'}
          </p>
          {searchError && (
            <div className="command-empty" role="alert">
              {searchError}
              <button
                className="inline-link"
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
            <div className="command-empty">正在搜索…</div>
          )}
          {!searching && !searchError && visibleChannels.length ? (
            visibleChannels.map((channel, index) => (
              <button
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
                <Clock3 size={17} />
                <span>
                  <strong>{channel.title}</strong>
                  <small>{snippetFor(channel.id) ?? channel.goal}</small>
                </span>
                <ChevronRight size={16} />
              </button>
            ))
          ) : !searching && !searchError ? (
            <div className="command-empty">
              {trimmedQuery || hasFilters || channels.length
                ? '没有匹配的事情'
                : '还没有可搜索的事情'}
            </div>
          ) : null}
          {serverMode && !searching && Boolean(result?.nextCursor) && (
            <button
              className="command-load-more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              type="button"
            >
              {loadingMore ? '正在加载…' : '加载更多'}
            </button>
          )}
        </div>
        <button
          aria-label="关闭搜索"
          className="command-close"
          onClick={onClose}
          type="button"
        >
          <X size={18} />
        </button>
      </section>
    </div>
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
