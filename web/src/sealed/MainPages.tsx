import {
  ArrowUp,
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Mic,
  PauseCircle,
  Plus,
  RotateCw,
  Search,
  ShieldCheck,
  Sparkles,
  Volume2,
  X,
  Zap,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { PegasApi } from '../api'
import { MarkdownMessage } from '../MarkdownMessage'
import type { DshModelCatalogItem, OutboxMessage, Snapshot } from '../types'
import { useVoiceDictation } from '../useVoiceDictation'
import { PegasAgentIcon } from '../PegasAgentIcon'
import { EmptyCapability, PageToolbar } from './Shell'
import {
  attentionKind,
  formatRelativeTime,
  latestRunForTask,
  statusLabel,
  textFromPayload,
  unresolvedAttentionMessages,
  type DrawerView,
} from './types'

interface PageActions {
  onSearch: () => void
  onToggleAppearance: () => void
  isDark: boolean
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
        <PageToolbar
          isDark={actions.isDark}
          onSearch={actions.onSearch}
          onToggleAppearance={actions.onToggleAppearance}
        />
      </div>
    </header>
  )
}

function ComposerModelPicker({
  models,
  provider,
  selectedModelId,
  onSelect,
}: {
  models: DshModelCatalogItem[]
  provider?: string
  selectedModelId?: string
  onSelect: (model: DshModelCatalogItem) => Promise<void>
}) {
  const pickerId = useId()
  const pickerTitleId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [savingId, setSavingId] = useState('')
  const [error, setError] = useState('')
  const [displayModelId, setDisplayModelId] = useState(selectedModelId)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const selected = models.find(model => model.id === displayModelId)
  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) {
      const current = models.find(model => model.id === displayModelId)
      return current
        ? [current, ...models.filter(model => model.id !== displayModelId)]
        : models
    }
    return models.filter(model =>
      `${model.name} ${model.id}`.toLocaleLowerCase().includes(normalized),
    )
  }, [displayModelId, models, query])

  useEffect(() => setDisplayModelId(selectedModelId), [selectedModelId])

  function closePicker(restoreFocus = true) {
    setOpen(false)
    setQuery('')
    setError('')
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0)
  }

  useEffect(() => {
    if (!open) return
    window.setTimeout(() => searchRef.current?.focus(), 0)
    const dismiss = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (
        pickerRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      )
        return
      closePicker(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])

  function focusOption(index: number) {
    const options = Array.from(
      pickerRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
    )
    if (!options.length) return
    options[Math.max(0, Math.min(index, options.length - 1))]?.focus()
  }

  async function selectModel(model: DshModelCatalogItem) {
    if (savingId || model.id === displayModelId) {
      closePicker()
      return
    }
    setSavingId(model.id)
    setError('')
    try {
      await onSelect(model)
      setDisplayModelId(model.id)
      closePicker()
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : '模型切换失败，请重试。',
      )
    } finally {
      setSavingId('')
    }
  }

  return (
    <div className="composer-model-control">
      <button
        aria-controls={pickerId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`选择执行模型，当前 ${selected?.name ?? '未选择'}`}
        className="composer-model-button"
        disabled={!models.length}
        onClick={() => {
          if (open) closePicker(false)
          else setOpen(true)
        }}
        ref={triggerRef}
        title={selected?.name ?? '服务端未提供可用模型'}
        type="button"
      >
        <span>{selected?.name ?? '执行模型'}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div
          aria-labelledby={pickerTitleId}
          className="composer-model-picker"
          id={pickerId}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              closePicker()
              return
            }
            const target = event.target
            const options = Array.from(
              pickerRef.current?.querySelectorAll<HTMLElement>(
                '[role="option"]',
              ) ?? [],
            )
            if (event.key === 'ArrowDown' && target === searchRef.current) {
              event.preventDefault()
              focusOption(
                Math.max(
                  0,
                  filteredModels.findIndex(
                    model => model.id === displayModelId,
                  ),
                ),
              )
              return
            }
            if (!(target instanceof HTMLElement)) return
            const currentIndex = options.indexOf(target)
            if (currentIndex < 0) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const step = event.key === 'ArrowDown' ? 1 : -1
              focusOption(
                (currentIndex + step + options.length) % options.length,
              )
            } else if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault()
              focusOption(event.key === 'Home' ? 0 : options.length - 1)
            } else if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              target.click()
            }
          }}
          ref={pickerRef}
          role="dialog"
        >
          <header>
            <div>
              <h2 id={pickerTitleId}>选择模型</h2>
              <p>{provider ? `${provider} 接入点` : '当前接入点'}</p>
            </div>
            <span>{models.length} 个可用</span>
          </header>
          <label className="composer-model-search">
            <Search size={16} />
            <span className="visually-hidden">搜索模型</span>
            <input
              autoComplete="off"
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索模型"
              ref={searchRef}
              spellCheck={false}
              type="search"
              value={query}
            />
          </label>
          <div
            aria-label="可用模型"
            className="composer-model-list"
            role="listbox"
          >
            {filteredModels.length ? (
              filteredModels.map((model, index) => {
                const isSelected = model.id === displayModelId
                const isSaving = savingId === model.id
                return (
                  <div
                    aria-disabled={Boolean(savingId)}
                    aria-selected={isSelected}
                    className="composer-model-option"
                    data-model-id={model.id}
                    key={`${model.provider}/${model.id}`}
                    onClick={() => {
                      if (!savingId) void selectModel(model)
                    }}
                    role="option"
                    tabIndex={
                      isSelected || (!displayModelId && index === 0) ? 0 : -1
                    }
                  >
                    <span>
                      <strong>{model.name}</strong>
                      {model.id !== model.name && <small>{model.id}</small>}
                    </span>
                    {isSaving ? (
                      <RotateCw className="is-spinning" size={17} />
                    ) : (
                      isSelected && <Check size={18} />
                    )}
                  </div>
                )
              })
            ) : (
              <p className="composer-model-empty">没有匹配的模型</p>
            )}
          </div>
          {error && (
            <p className="composer-model-error" role="alert">
              {error}
            </p>
          )}
          <footer>模型变更只作用于新建执行会话</footer>
        </div>
      )}
    </div>
  )
}

export function ConversationPage({
  api,
  snapshot,
  actions,
  onSent,
  models,
  modelProvider,
  selectedModelId,
  onSelectModel,
  continuationChannel,
  onClearContinuation,
  draft,
  onDraftChange,
  speechEnabled,
  onConfigureVoice,
}: {
  api: PegasApi
  snapshot: Snapshot
  actions: PageActions
  onSent: () => Promise<void>
  models: DshModelCatalogItem[]
  modelProvider?: string
  selectedModelId?: string
  onSelectModel: (model: DshModelCatalogItem) => Promise<void>
  continuationChannel?: Snapshot['channels'][number]
  onClearContinuation: () => void
  draft: string
  onDraftChange: (draft: string) => void
  speechEnabled: boolean
  onConfigureVoice: () => void
}) {
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
        status: event.status,
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
  }, [snapshot.events, snapshot.messages])
  useEffect(() => {
    const area = scrollRef.current
    if (area) area.scrollTop = area.scrollHeight
  }, [messages.length])
  const dictation = useVoiceDictation({
    transcribe: blob => api.transcribeVoice(blob),
    onTranscript: text => onDraftChange(`${draft}${draft ? ' ' : ''}${text}`),
  })
  const dictationBusy = dictation.state !== 'idle'
  const latestChannel = snapshot.channels[0]
  const latestRun = latestChannel
    ? latestRunForTask(snapshot.runs, latestChannel.id)
    : undefined

  async function send() {
    const text = draft.trim()
    if (!text || sending || dictationBusy) return
    setSending(true)
    setError('')
    try {
      await api.sendMessage(text, continuationChannel?.id)
      onDraftChange('')
      onClearContinuation()
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
                  {message.role === 'user' && (
                    <small className="message-delivery">
                      {deliveryStatusLabel(message.status)}
                    </small>
                  )}
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
                            run: latestRunForTask(snapshot.runs, channel.id),
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
        {continuationChannel && (
          <div className="composer-context" role="status">
            <span>
              继续事情：<strong>{continuationChannel.title}</strong>
            </span>
            <button
              aria-label="取消继续当前事情"
              onClick={onClearContinuation}
              type="button"
            >
              <X size={15} />
            </button>
          </div>
        )}
        <form
          aria-label="发送消息"
          className="composer"
          onSubmit={event => {
            event.preventDefault()
            void send()
          }}
        >
          <label className="visually-hidden" htmlFor="pegas-message">
            给 Pegas 发消息
          </label>
          <textarea
            enterKeyHint="send"
            id="pegas-message"
            name="message"
            onChange={event => onDraftChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                const legacyKeyCode = (
                  event.nativeEvent as unknown as { keyCode?: number }
                ).keyCode
                if (event.nativeEvent.isComposing || legacyKeyCode === 229)
                  return
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder={
              dictation.state === 'recording'
                ? `正在听 · ${String(dictation.elapsedSeconds)} 秒`
                : '和 Pegas 一起工作'
            }
            rows={1}
            value={draft}
          />
          <div className="composer-toolbar">
            <div className="composer-tools" aria-label="输入工具">
              <button
                aria-label="添加附件"
                className="composer-add-button"
                disabled
                title="附件能力将在 Artifact API 接入后启用"
                type="button"
              >
                <Plus size={22} />
              </button>
            </div>
            <div className="composer-actions">
              <ComposerModelPicker
                models={models}
                onSelect={onSelectModel}
                provider={modelProvider}
                selectedModelId={selectedModelId}
              />
              <button
                aria-label={
                  dictation.state === 'recording' ? '停止录音' : '语音输入'
                }
                className={
                  dictation.state === 'recording' ? 'is-recording' : ''
                }
                onClick={() => {
                  if (dictation.state === 'recording') {
                    dictation.toggle()
                    return
                  }
                  if (!speechEnabled) {
                    onConfigureVoice()
                    return
                  }
                  dictation.toggle()
                }}
                type="button"
              >
                <Mic size={20} />
              </button>
              <button
                aria-label="发送"
                className="send-button"
                disabled={!draft.trim() || sending || dictationBusy}
                type="submit"
              >
                <ArrowUp size={20} />
              </button>
            </div>
          </div>
        </form>
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
    const run = latestRunForTask(snapshot.runs, channel.id)
    if (
      query &&
      !`${channel.title} ${channel.goal} ${run?.output ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase())
    )
      return false
    if (filter === 'completed') return channel.status === 'completed'
    if (filter === 'archived') return channel.status === 'cancelled'
    if (
      filter === 'waiting' &&
      (channel.status === 'completed' || channel.status === 'cancelled')
    )
      return false
    if (filter === 'waiting') return !run || run.status === 'waiting'
    if (channel.status === 'completed' || channel.status === 'cancelled')
      return false
    return (
      run?.status === 'queued' ||
      run?.status === 'running' ||
      run?.status === 'failed'
    )
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
            placeholder="搜索事情或结果"
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
            const run = latestRunForTask(snapshot.runs, channel.id)
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
                  <PegasAgentIcon iconId={channel.workerIconId} size={38} />
                </span>
                <span className="work-copy">
                  <strong>{channel.title}</strong>
                  <small>{channel.goal}</small>
                  <small className="work-context">
                    {run
                      ? [run.executor, run.executionContext?.model]
                          .filter(Boolean)
                          .join(' · ')
                      : '尚未分配执行器'}
                  </small>
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

function deliveryStatusLabel(
  status: Snapshot['events'][number]['status'],
): string {
  if (status === 'pending') return '已送达'
  if (status === 'processing') return '正在分配'
  if (status === 'failed') return '处理失败'
  return '已进入事情'
}

function attentionAction(message: OutboxMessage): {
  label: string
  icon: typeof Check
} {
  const kind = attentionKind(message)
  if (kind === 'failed') return { label: '查看原因', icon: RotateCw }
  if (kind === 'approval') return { label: '查看内容', icon: ShieldCheck }
  return { label: '打开事情', icon: ArrowRight }
}

export function AttentionPage({
  snapshot,
  actions,
  onOpen,
}: {
  snapshot: Snapshot
  actions: PageActions
  onOpen: (message: OutboxMessage) => Promise<void>
}) {
  const [filter, setFilter] = useState<'all' | 'approval' | 'input' | 'failed'>(
    'all',
  )
  const attentionMessages = unresolvedAttentionMessages(
    snapshot.messages,
  ).toSorted(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  )
  const visible = attentionMessages.filter(message => {
    if (filter === 'all') return true
    return attentionKind(message) === filter
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
          全部 {attentionMessages.length}
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
                    {message.readAt ? '已读' : '未读'} · 来自：
                    {channel?.title ?? 'Pegas'} ·{' '}
                    {formatRelativeTime(message.createdAt)}
                  </small>
                </div>
                <button
                  onClick={() => {
                    void onOpen(message)
                  }}
                  type="button"
                >
                  <Icon size={15} />
                  {action.label}
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
        availabilityLabel="服务端能力尚未启用"
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
        availabilityLabel="服务端能力尚未启用"
        icon={Volume2}
        title="记忆能力正在建设"
        description="记忆会带来源、作用范围和删除路径；在服务端能力完成前不会写入本机假数据。"
      />
    </div>
  )
}
