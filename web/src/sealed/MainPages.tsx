import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Mic,
  Paperclip,
  PauseCircle,
  RotateCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Volume2,
  Zap,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { PegasApi } from '../api'
import { MarkdownMessage } from '../MarkdownMessage'
import type { OutboxMessage, Snapshot } from '../types'
import { useVoiceDictation } from '../useVoiceDictation'
import { EmptyCapability, PageToolbar } from './Shell'
import {
  formatRelativeTime,
  statusLabel,
  textFromPayload,
  type DrawerView,
} from './types'

interface PageActions {
  onSearch: () => void
  onTheme: () => void
  onOpenDrawer: (drawer: DrawerView) => void
}

function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description: string
  actions: PageActions
  children?: React.ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="page-header-actions">
        {children}
        <PageToolbar onSearch={actions.onSearch} onTheme={actions.onTheme} />
      </div>
    </header>
  )
}

export function ConversationPage({
  api,
  snapshot,
  actions,
  onSent,
}: {
  api: PegasApi
  snapshot: Snapshot
  actions: PageActions
  onSent: () => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(
    () => new Set(),
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const messages = useMemo(() => {
    const user = snapshot.events
      .filter(event => event.type === 'user.message')
      .map(event => ({
        id: event.id,
        role: 'user' as const,
        text: textFromPayload(event.payload),
        at: event.createdAt,
      }))
    const pegas = snapshot.messages.map(message => ({
      id: message.id,
      role: 'pegas' as const,
      text: textFromPayload(message.payload),
      at: message.createdAt,
      taskId: message.taskId,
    }))
    return [...user, ...pegas]
      .filter(message => message.text)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .slice(-6)
  }, [snapshot.events, snapshot.messages])
  useEffect(() => {
    const area = scrollRef.current
    if (area) area.scrollTop = area.scrollHeight
  }, [messages.length])
  const dictation = useVoiceDictation({
    transcribe: blob => api.transcribeVoice(blob),
    onTranscript: text =>
      setDraft(current => `${current}${current ? ' ' : ''}${text}`),
  })
  const latestChannel = snapshot.channels[0]
  const latestRun = latestChannel
    ? snapshot.runs.find(run => run.taskId === latestChannel.id)
    : undefined

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError('')
    try {
      await api.sendMessage(text)
      setDraft('')
      await onSent()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '发送失败，请重试。')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="conversation-page">
      <PageHeader
        actions={actions}
        description="你的私人智能工作伙伴"
        title="Pegas"
      />
      <div className="conversation-scroll" ref={scrollRef}>
        <div className="conversation-flow">
          {messages.length === 0 ? (
            <section className="conversation-welcome">
              <span>
                <Sparkles size={23} />
              </span>
              <h2>今天想一起完成什么？</h2>
              <p>告诉我目标。我会整理事情、推进执行，并在需要你决定时回来。</p>
            </section>
          ) : (
            messages.map(message => (
              <article
                className={`message-row is-${message.role}`}
                key={message.id}
              >
                <div className="message-content">
                  <MarkdownMessage
                    content={
                      message.text.length > 520 &&
                      !expandedMessages.has(message.id)
                        ? `${message.text.slice(0, 520)}…`
                        : message.text
                    }
                  />
                  {message.text.length > 520 && (
                    <button
                      className="inline-link"
                      onClick={() =>
                        setExpandedMessages(current => {
                          const next = new Set(current)
                          if (next.has(message.id)) next.delete(message.id)
                          else next.add(message.id)
                          return next
                        })
                      }
                      type="button"
                    >
                      {expandedMessages.has(message.id)
                        ? '收起回复'
                        : '展开完整回复'}
                    </button>
                  )}
                  {message.role === 'pegas' && message.taskId && (
                    <button
                      className="inline-link"
                      onClick={() => {
                        const channel = snapshot.channels.find(
                          item => item.id === message.taskId,
                        )
                        if (channel)
                          actions.onOpenDrawer({
                            kind: 'task',
                            channel,
                            run: snapshot.runs.find(
                              run => run.taskId === channel.id,
                            ),
                          })
                      }}
                      type="button"
                    >
                      查看工作详情 <ArrowRight size={15} />
                    </button>
                  )}
                </div>
              </article>
            ))
          )}

          {latestChannel && latestRun && (
            <button
              className="run-summary"
              onClick={() =>
                actions.onOpenDrawer({
                  kind: 'task',
                  channel: latestChannel,
                  run: latestRun,
                })
              }
              type="button"
            >
              <i data-status={latestRun.status} />
              <span>
                <strong>
                  {statusLabel(latestChannel, latestRun)} ·{' '}
                  {latestChannel.title}
                </strong>
                <small>
                  {latestRun.status === 'running'
                    ? 'Pegas 正在推进这件事'
                    : `${(latestRun.output ?? latestChannel.goal).slice(0, 160)}${(latestRun.output ?? latestChannel.goal).length > 160 ? '…' : ''}`}
                </small>
              </span>
              <ArrowRight size={18} />
            </button>
          )}
        </div>
      </div>

      <div className="composer-wrap">
        {error && (
          <div className="composer-error" role="alert">
            {error}
          </div>
        )}
        {dictation.error && (
          <div className="composer-error" role="alert">
            {dictation.error}
          </div>
        )}
        <div className="composer">
          <button
            aria-label="添加附件"
            disabled
            title="服务端 Artifact API 尚未提供"
            type="button"
          >
            <Paperclip size={21} />
          </button>
          <button
            aria-label={
              dictation.state === 'recording' ? '停止录音' : '语音输入'
            }
            className={dictation.state === 'recording' ? 'is-recording' : ''}
            onClick={dictation.toggle}
            type="button"
          >
            <Mic size={21} />
          </button>
          <textarea
            aria-label="给 Pegas 发消息"
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder={
              dictation.state === 'recording'
                ? `正在听 · ${String(dictation.elapsedSeconds)} 秒`
                : '告诉 Pegas 你想做什么…'
            }
            rows={1}
            value={draft}
          />
          <button
            aria-label="发送"
            className="send-button"
            disabled={!draft.trim() || sending}
            onClick={() => void send()}
            type="button"
          >
            <Send size={20} />
          </button>
        </div>
      </div>
    </div>
  )
}

export function WorkPage({
  snapshot,
  actions,
}: {
  snapshot: Snapshot
  actions: PageActions
}) {
  const [filter, setFilter] = useState<
    'active' | 'waiting' | 'completed' | 'archived'
  >('active')
  const [query, setQuery] = useState('')
  const visible = snapshot.channels.filter(channel => {
    if (
      query &&
      !`${channel.title} ${channel.goal}`
        .toLowerCase()
        .includes(query.toLowerCase())
    )
      return false
    if (filter === 'completed') return channel.status === 'completed'
    if (filter === 'archived') return channel.status === 'cancelled'
    const run = snapshot.runs.find(item => item.taskId === channel.id)
    if (filter === 'waiting')
      return !run || run.status === 'waiting' || run.status === 'queued'
    return channel.status === 'started' || run?.status === 'running'
  })
  return (
    <div className="standard-page">
      <PageHeader
        actions={actions}
        description="你和 Pegas 一起做过的所有事情"
        title="所有事情"
      >
        <label className="page-search">
          <Search size={17} />
          <input
            aria-label="搜索事情"
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索事情、结果或文件"
            value={query}
          />
        </label>
      </PageHeader>
      <div className="filter-row" role="tablist">
        {(
          [
            ['active', '进行中'],
            ['waiting', '等待中'],
            ['completed', '已完成'],
            ['archived', '已归档'],
          ] as const
        ).map(([id, label]) => (
          <button
            aria-selected={filter === id}
            key={id}
            onClick={() => setFilter(id)}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
        <button
          className="sort-button"
          disabled
          title="当前仅支持按最近更新排序"
          type="button"
        >
          最近更新 <ChevronDown size={15} />
        </button>
      </div>
      <section className="work-list" aria-label="事情列表">
        {visible.length ? (
          visible.map(channel => {
            const run = snapshot.runs.find(item => item.taskId === channel.id)
            const state = statusLabel(channel, run)
            return (
              <button
                key={channel.id}
                onClick={() =>
                  actions.onOpenDrawer({ kind: 'task', channel, run })
                }
                type="button"
              >
                <span className="work-icon">
                  <FileText size={20} />
                </span>
                <span className="work-copy">
                  <strong>{channel.title}</strong>
                  <small>{channel.goal}</small>
                </span>
                <span className="work-artifacts">
                  <FileText size={15} />
                </span>
                <time>{formatRelativeTime(channel.latestActivityAt)}</time>
                <span className={`status-text status-${state}`}>{state}</span>
              </button>
            )
          })
        ) : (
          <EmptyCapability
            icon={FileText}
            title="这里还没有事情"
            description="在对话中告诉 Pegas 一个目标，事情会自动出现在这里。"
          />
        )}
      </section>
    </div>
  )
}

function attentionAction(message: OutboxMessage): {
  label: string
  icon: typeof Check
} {
  const text = textFromPayload(message.payload).toLowerCase()
  if (message.status === 'failed' || text.includes('失败'))
    return { label: '查看原因', icon: RotateCw }
  if (text.includes('确认')) return { label: '查看内容', icon: ShieldCheck }
  return { label: '打开事情', icon: ArrowRight }
}

export function AttentionPage({
  snapshot,
  actions,
  onRead,
}: {
  snapshot: Snapshot
  actions: PageActions
  onRead: (message: OutboxMessage) => Promise<void>
}) {
  const [filter, setFilter] = useState<'all' | 'approval' | 'input' | 'failed'>(
    'all',
  )
  const unread = snapshot.messages.filter(message => !message.readAt)
  const visible = unread.filter(message => {
    if (filter === 'all') return true
    const text = textFromPayload(message.payload).toLowerCase()
    if (filter === 'failed')
      return message.status === 'failed' || text.includes('失败')
    if (filter === 'approval') return text.includes('确认')
    return text.includes('补充') || text.includes('提供')
  })
  return (
    <div className="standard-page">
      <PageHeader
        actions={actions}
        description="Pegas 现在需要你处理的事情"
        title="待你处理"
      />
      <div className="filter-row" role="tablist">
        <button
          aria-selected={filter === 'all'}
          onClick={() => setFilter('all')}
          role="tab"
          type="button"
        >
          全部 {unread.length}
        </button>
        <button
          aria-selected={filter === 'approval'}
          onClick={() => setFilter('approval')}
          role="tab"
          type="button"
        >
          需要确认
        </button>
        <button
          aria-selected={filter === 'input'}
          onClick={() => setFilter('input')}
          role="tab"
          type="button"
        >
          需要补充
        </button>
        <button
          aria-selected={filter === 'failed'}
          onClick={() => setFilter('failed')}
          role="tab"
          type="button"
        >
          失败
        </button>
      </div>
      <section className="attention-list">
        {visible.length ? (
          visible.map(message => {
            const channel = snapshot.channels.find(
              item => item.id === message.taskId,
            )
            const action = attentionAction(message)
            const Icon = action.icon
            return (
              <article key={message.id}>
                <span className="attention-icon">
                  <CircleAlert size={20} />
                </span>
                <div>
                  <strong>
                    {textFromPayload(message.payload) || 'Pegas 有一项更新'}
                  </strong>
                  <small>
                    来自：{channel?.title ?? 'Pegas'} ·{' '}
                    {formatRelativeTime(message.createdAt)}
                  </small>
                </div>
                <button
                  onClick={() => {
                    void onRead(message)
                    if (channel)
                      actions.onOpenDrawer({
                        kind: 'task',
                        channel,
                        run: snapshot.runs.find(
                          run => run.taskId === channel.id,
                        ),
                      })
                  }}
                  type="button"
                >
                  <Icon size={15} />
                  {action.label}
                </button>
                <button
                  className="later-action"
                  onClick={() => void onRead(message)}
                  type="button"
                >
                  稍后处理
                </button>
              </article>
            )
          })
        ) : (
          <EmptyCapability
            icon={Check}
            title="现在没有待处理项"
            description="需要确认、补充信息或处理失败时，Pegas 会把它放在这里。"
          />
        )}
      </section>
    </div>
  )
}

export function AutomationPage({ actions }: { actions: PageActions }) {
  return (
    <div className="standard-page">
      <PageHeader
        actions={actions}
        description="让 Pegas 在合适的时候自动开始"
        title="自动化"
      />
      <div className="metric-strip">
        <span>
          <Check size={17} />
          已启用 <b>0</b>
        </span>
        <span>
          <PauseCircle size={17} />
          已暂停 <b>0</b>
        </span>
        <span>
          <CircleAlert size={17} />
          需要处理 <b>0</b>
        </span>
      </div>
      <EmptyCapability
        icon={Zap}
        title="自动化能力正在建设"
        description="计划任务与条件触发会在服务端形成可恢复的事实来源后出现在这里。"
      />
    </div>
  )
}

export function MemoryPage({ actions }: { actions: PageActions }) {
  return (
    <div className="standard-page">
      <PageHeader
        actions={actions}
        description="查看、修改或删除 Pegas 记住的内容"
        title="记忆"
      />
      <div className="filter-row" role="tablist">
        <button aria-selected="true" disabled role="tab" type="button">
          关于我
        </button>
        <button disabled role="tab" type="button">
          偏好
        </button>
        <button disabled role="tab" type="button">
          长期规则
        </button>
        <button disabled role="tab" type="button">
          事情记忆
        </button>
      </div>
      <EmptyCapability
        icon={Volume2}
        title="记忆能力正在建设"
        description="记忆会带来源、作用范围和删除路径；在服务端能力完成前不会写入本机假数据。"
      />
    </div>
  )
}
