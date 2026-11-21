import {
  Archive,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileText,
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

import type { ChannelSearchResult, WorkChannel } from '../types'
import { PegasMark } from './PegasMark'
import type { AppPage } from './types'

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
  unreadCount: number
  onOpenChannel: (channel: WorkChannel) => void
  children: React.ReactNode
}

export function AppShell({
  page,
  connectionStatus,
  onNavigate,
  channels,
  unreadCount,
  onOpenChannel,
  children,
}: AppShellProps) {
  return (
    <div
      className={page === 'settings' ? 'app-shell is-settings' : 'app-shell'}
    >
      <a className="skip-link" href="#pegas-main">
        跳到主要内容
      </a>
      <aside className="primary-rail" aria-label="主导航">
        <div className="brand-lockup">
          <PegasMark size={42} />
          <div>
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

        <nav className="primary-nav">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              className={page === id ? 'nav-item is-active' : 'nav-item'}
              key={id}
              onClick={() => onNavigate(id)}
              type="button"
            >
              <Icon size={19} strokeWidth={1.8} />
              <span>{label}</span>
              {id === 'attention' && unreadCount > 0 && (
                <b>{Math.min(unreadCount, 99)}</b>
              )}
            </button>
          ))}
        </nav>

        {page === 'conversation' && channels.length > 0 && (
          <section className="recent-work" aria-labelledby="recent-work-title">
            <p id="recent-work-title">最近的事情</p>
            {channels.slice(0, 3).map(channel => (
              <button
                key={channel.id}
                onClick={() => onOpenChannel(channel)}
                type="button"
              >
                <FileText size={16} />
                <span>{channel.title}</span>
              </button>
            ))}
          </section>
        )}

        <button
          className={
            page === 'settings'
              ? 'nav-item is-active rail-settings'
              : 'nav-item rail-settings'
          }
          onClick={() => onNavigate('settings')}
          type="button"
        >
          <Settings size={19} />
          <span>设置</span>
        </button>
      </aside>
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
}: {
  onSearch: () => void
  onToggleAppearance: () => void
  isDark: boolean
}) {
  const appearanceLabel = isDark ? '切换到明亮外观' : '切换到深色外观'
  return (
    <div className="page-toolbar">
      <button aria-label="全局搜索" onClick={onSearch} type="button">
        <Search size={20} />
      </button>
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
  onSearch?: (query: string) => Promise<ChannelSearchResult>
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ChannelSearchResult>()
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const searchRequestRef = useRef(0)
  const trimmedQuery = query.trim()
  const runSearch = useCallback(
    (searchQuery: string) => {
      if (!onSearch) return
      const requestId = searchRequestRef.current + 1
      searchRequestRef.current = requestId
      setSearching(true)
      onSearch(searchQuery)
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
    if (!trimmedQuery) {
      searchRequestRef.current += 1
      setResult(undefined)
      setSearching(false)
      setSearchError('')
      return
    }
    const timer = window.setTimeout(() => runSearch(trimmedQuery), 200)
    return () => window.clearTimeout(timer)
  }, [onSearch, runSearch, trimmedQuery])
  const localChannels = channels
    .filter(channel =>
      `${channel.title} ${channel.goal}`
        .toLowerCase()
        .includes(trimmedQuery.toLowerCase()),
    )
    .slice(0, 5)
  const visibleChannels =
    onSearch && trimmedQuery ? (result?.channels ?? []) : localChannels
  const snippetFor = (channelId: string) =>
    result?.matches.find(
      match => match.channelId === channelId && match.sourceKind !== 'channel',
    )?.snippet ??
    result?.matches.find(match => match.channelId === channelId)?.snippet
  const resultRefs = useRef<(HTMLButtonElement | null)[]>([])
  resultRefs.current = []
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
        <p className="command-section-label">
          {trimmedQuery ? '搜索结果' : '最近'}
        </p>
        {searchError && (
          <div className="command-empty" role="alert">
            {searchError}
            <button
              className="inline-link"
              onClick={() => runSearch(trimmedQuery)}
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
            {trimmedQuery || channels.length
              ? '没有匹配的事情'
              : '还没有可搜索的事情'}
          </div>
        ) : null}
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
}: {
  icon?: typeof Bot
  title: string
  description: string
  availabilityLabel?: string
}) {
  return (
    <div className="empty-capability">
      <span>
        <Icon size={24} />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {availabilityLabel && <small>{availabilityLabel}</small>}
    </div>
  )
}
