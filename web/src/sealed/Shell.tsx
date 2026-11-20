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
import { useEffect, useRef, useState } from 'react'

import type { WorkChannel } from '../types'
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
  onNavigate: (page: AppPage) => void
  channels: WorkChannel[]
  unreadCount: number
  onOpenChannel: (channel: WorkChannel) => void
  children: React.ReactNode
}

export function AppShell({
  page,
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
      <aside className="primary-rail" aria-label="主导航">
        <div className="brand-lockup">
          <PegasMark size={42} />
          <div>
            <strong>Pegas</strong>
            <span>
              <i />
              在线
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
      <main className="main-canvas">{children}</main>
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
}: {
  channels: WorkChannel[]
  onClose: () => void
  onOpen: (channel: WorkChannel) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const visibleChannels = channels
    .filter(channel =>
      `${channel.title} ${channel.goal}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .slice(0, 5)
  useEffect(() => inputRef.current?.focus(), [])
  return (
    <div
      className="modal-backdrop"
      onMouseDown={event => event.target === event.currentTarget && onClose()}
    >
      <section aria-label="全局搜索" className="command-dialog" role="dialog">
        <div className="command-input">
          <Search size={20} />
          <input
            aria-label="搜索事情、消息或文件"
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索事情、消息或文件"
            ref={inputRef}
            value={query}
          />
          <kbd>ESC</kbd>
        </div>
        <p className="command-section-label">最近</p>
        {visibleChannels.length ? (
          visibleChannels.map(channel => (
            <button
              key={channel.id}
              onClick={() => onOpen(channel)}
              type="button"
            >
              <Clock3 size={17} />
              <span>
                <strong>{channel.title}</strong>
                <small>{channel.goal}</small>
              </span>
              <ChevronRight size={16} />
            </button>
          ))
        ) : (
          <div className="command-empty">
            {channels.length ? '没有匹配的事情' : '还没有可搜索的事情'}
          </div>
        )}
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
}: {
  icon?: typeof Bot
  title: string
  description: string
}) {
  return (
    <div className="empty-capability">
      <span>
        <Icon size={24} />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      <small>服务端能力尚未启用</small>
    </div>
  )
}
