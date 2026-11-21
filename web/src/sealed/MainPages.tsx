import {
  ArrowUp,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleQuestionMark,
  FileText,
  Layers3,
  Mic,
  PauseCircle,
  Plus,
  RotateCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { PegasApi } from '../api'
import { MarkdownMessage } from '../MarkdownMessage'
import type {
  Automation,
  AutomationDraft,
  AutomationInvocation,
  DshModelCatalogItem,
  MemoryCategory,
  MemoryDraft,
  MemoryRecord,
  MemoryScope,
  OutboxMessage,
  Snapshot,
  WorkChannel,
} from '../types'
import { useVoiceDictation } from '../useVoiceDictation'
import { PegasAgentIcon } from '../PegasAgentIcon'
import { EmptyCapability, PageToolbar } from './Shell'
import {
  attentionKind,
  formatRelativeTime,
  isReconciliationMessage,
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
  const stickToBottomRef = useRef(true)
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
    if (area && stickToBottomRef.current) area.scrollTop = area.scrollHeight
  }, [messages])
  const dictation = useVoiceDictation({
    transcribe: blob => api.transcribeVoice(blob),
    onTranscript: text => onDraftChange(`${draft}${draft ? ' ' : ''}${text}`),
  })
  const dictationBusy = dictation.state !== 'idle'
  const summaryChannel =
    snapshot.channels.find(item => item.id === continuationChannel?.id) ??
    snapshot.channels[0]
  const summaryRun = summaryChannel
    ? latestRunForTask(snapshot.runs, summaryChannel.id)
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
      <div
        className="conversation-scroll"
        onScroll={event => {
          const area = event.currentTarget
          stickToBottomRef.current =
            area.scrollHeight - area.scrollTop - area.clientHeight < 48
        }}
        ref={scrollRef}
      >
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
                        : message.role === 'user'
                          ? '展开完整消息'
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

          {summaryChannel && summaryRun && (
            <button
              className="run-summary"
              onClick={() =>
                actions.onOpenDrawer({
                  kind: 'task',
                  channel: summaryChannel,
                  run: summaryRun,
                })
              }
              type="button"
            >
              <i data-status={summaryRun.status} />
              <span>
                <strong>
                  {statusLabel(summaryChannel, summaryRun)} ·{' '}
                  {summaryChannel.title}
                </strong>
                <small>
                  {summaryRun.status === 'running'
                    ? 'Pegas 正在推进这件事'
                    : `${(summaryRun.output ?? summaryChannel.goal).slice(0, 160)}${(summaryRun.output ?? summaryChannel.goal).length > 160 ? '…' : ''}`}
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
    'all' | 'active' | 'waiting' | 'completed' | 'archived'
  >('all')
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
    if (filter === 'all') return true
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
            ['all', '全部'],
            ['active', '进行中'],
            ['waiting', '等待中'],
            ['completed', '已完成'],
            ['archived', '已归档'],
          ] as const
        ).map(([id, label]) => (
          <button
            aria-pressed={filter === id}
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
            title={
              snapshot.channels.length ? '当前筛选下没有事情' : '这里还没有事情'
            }
            description={
              snapshot.channels.length
                ? '切换其他筛选，或清除搜索词后再看看。'
                : '在对话中告诉 Pegas 一个目标，事情会自动出现在这里。'
            }
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
  if (isReconciliationMessage(message))
    return { label: '去核对', icon: ShieldCheck }
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
  const [filter, setFilter] = useState<
    'all' | 'approval' | 'input' | 'failed' | 'result'
  >('all')
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
          aria-pressed={filter === 'all'}
          aria-selected={filter === 'all'}
          onClick={() => setFilter('all')}
          role="tab"
          type="button"
        >
          全部 {attentionMessages.length}
        </button>
        <button
          aria-pressed={filter === 'approval'}
          aria-selected={filter === 'approval'}
          onClick={() => setFilter('approval')}
          role="tab"
          type="button"
        >
          需要确认
        </button>
        <button
          aria-pressed={filter === 'input'}
          aria-selected={filter === 'input'}
          onClick={() => setFilter('input')}
          role="tab"
          type="button"
        >
          需要补充
        </button>
        <button
          aria-pressed={filter === 'failed'}
          aria-selected={filter === 'failed'}
          onClick={() => setFilter('failed')}
          role="tab"
          type="button"
        >
          失败
        </button>
        <button
          aria-pressed={filter === 'result'}
          aria-selected={filter === 'result'}
          onClick={() => setFilter('result')}
          role="tab"
          type="button"
        >
          重要结果
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
            const kind = attentionKind(message)
            return (
              <article key={message.id}>
                <span className={`attention-icon is-${kind}`}>
                  {kind === 'result' ? (
                    <CheckCircle2 size={20} />
                  ) : kind === 'failed' ? (
                    <CircleAlert size={20} />
                  ) : kind === 'approval' ? (
                    <ShieldCheck size={20} />
                  ) : (
                    <CircleQuestionMark size={20} />
                  )}
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

export function AutomationPage({
  actions,
  automations,
  channels,
  error,
  onCreate,
  onLoadInvocations,
  onReload,
  onSetStatus,
  onUpdate,
}: {
  actions: PageActions
  automations?: Automation[]
  channels: WorkChannel[]
  error: string
  onCreate: (draft: AutomationDraft) => Promise<void>
  onLoadInvocations?: (
    automation: Automation,
  ) => Promise<AutomationInvocation[]>
  onReload: () => void
  onSetStatus: (
    automation: Automation,
    action: 'pause' | 'resume' | 'cancel',
  ) => Promise<void>
  onUpdate: (automation: Automation, draft: AutomationDraft) => Promise<void>
}) {
  const [form, setForm] = useState<
    { mode: 'create' } | { mode: 'edit'; automation: Automation }
  >()
  const [busyId, setBusyId] = useState('')
  const [confirmCancelId, setConfirmCancelId] = useState<string>()
  const [actionError, setActionError] = useState('')
  const [historyId, setHistoryId] = useState<string>()
  const [invocations, setInvocations] = useState<AutomationInvocation[]>()
  const [historyError, setHistoryError] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const historyRequestRef = useRef(0)
  async function toggleHistory(automation: Automation) {
    if (!onLoadInvocations) return
    if (historyId === automation.id) {
      historyRequestRef.current += 1
      setHistoryId(undefined)
      setInvocations(undefined)
      setHistoryError('')
      setHistoryLoading(false)
      return
    }
    const requestId = historyRequestRef.current + 1
    historyRequestRef.current = requestId
    setHistoryId(automation.id)
    setInvocations(undefined)
    setHistoryError('')
    setHistoryLoading(true)
    try {
      const next = await onLoadInvocations(automation)
      if (requestId !== historyRequestRef.current) return
      setInvocations(next)
    } catch (caught) {
      if (requestId !== historyRequestRef.current) return
      setHistoryError(
        caught instanceof Error ? caught.message : '读取触发记录失败，请重试。',
      )
    } finally {
      if (requestId === historyRequestRef.current) setHistoryLoading(false)
    }
  }
  const activeCount =
    automations?.filter(item => item.status === 'active').length ?? 0
  const pausedCount =
    automations?.filter(item => item.status === 'paused').length ?? 0
  const endedCount =
    automations?.filter(
      item => item.status === 'completed' || item.status === 'cancelled',
    ).length ?? 0
  async function runStatus(
    automation: Automation,
    action: 'pause' | 'resume' | 'cancel',
  ) {
    setBusyId(automation.id)
    setActionError('')
    try {
      await onSetStatus(automation, action)
      setConfirmCancelId(undefined)
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : '操作失败，请重试。',
      )
    } finally {
      setBusyId('')
    }
  }
  return (
    <div className="standard-page">
      <PageHeader
        actions={actions}
        description="让 Pegas 在合适的时候自动开始"
        title="自动化"
      >
        <button
          className="primary-button page-header-action"
          onClick={() => setForm({ mode: 'create' })}
          type="button"
        >
          <Plus size={16} />
          新建自动化
        </button>
      </PageHeader>
      <div className="metric-strip">
        <span>
          <Check size={17} />
          已启用 <b>{activeCount}</b>
        </span>
        <span>
          <PauseCircle size={17} />
          已暂停 <b>{pausedCount}</b>
        </span>
        <span>
          <CircleAlert size={17} />
          已结束 <b>{endedCount}</b>
        </span>
      </div>
      {error && (
        <div className="page-error" role="alert">
          {error}
          <button className="inline-link" onClick={onReload} type="button">
            重试
          </button>
        </div>
      )}
      {actionError && (
        <div className="page-error" role="alert">
          {actionError}
        </div>
      )}
      {!automations && !error && (
        <p className="page-loading">正在读取自动化…</p>
      )}
      {automations?.length === 0 && !error && (
        <EmptyCapability
          icon={Zap}
          title="还没有自动化"
          description="创建一个定时或周期意图，Pegas 会到点自动开始并留下记录。"
        />
      )}
      {automations && automations.length > 0 && (
        <section className="record-list" aria-label="自动化列表">
          {automations.map(automation => (
            <article key={automation.id}>
              <span className={`record-icon is-${automation.status}`}>
                <Zap size={18} />
              </span>
              <div className="record-copy">
                <strong>{automation.title}</strong>
                <small>{automation.prompt}</small>
                <small className="record-meta">
                  {describeSchedule(automation)} ·{' '}
                  {automation.target.kind === 'new_task'
                    ? '每次创建新事情'
                    : `续接：${
                        channels.find(
                          channel =>
                            channel.id ===
                            (automation.target as { taskId: string }).taskId,
                        )?.title ?? '已有事情'
                      }`}
                </small>
                <small className="record-meta">
                  {automation.status === 'active' && automation.nextFireAt
                    ? `下次触发 ${formatDateTime(automation.nextFireAt)}`
                    : automation.status === 'paused'
                      ? '已暂停，恢复后重新计算触发时间'
                      : '已结束，保留历史记录'}
                  {automation.lastFiredAt
                    ? ` · 最近触发 ${formatRelativeTime(automation.lastFiredAt)}`
                    : ''}
                </small>
              </div>
              <span
                className={`status-text status-${automationStatusLabel(automation.status)}`}
              >
                {automationStatusLabel(automation.status)}
              </span>
              <div className="record-actions">
                {onLoadInvocations && (
                  <button
                    aria-expanded={historyId === automation.id}
                    className="quiet-button"
                    onClick={() => void toggleHistory(automation)}
                    type="button"
                  >
                    触发记录
                  </button>
                )}
                {(automation.status === 'active' ||
                  automation.status === 'paused') && (
                  <button
                    className="secondary-button"
                    disabled={busyId === automation.id}
                    onClick={() => setForm({ mode: 'edit', automation })}
                    type="button"
                  >
                    编辑
                  </button>
                )}
                {automation.status === 'active' && (
                  <button
                    className="secondary-button"
                    disabled={busyId === automation.id}
                    onClick={() => void runStatus(automation, 'pause')}
                    type="button"
                  >
                    暂停
                  </button>
                )}
                {automation.status === 'paused' && (
                  <button
                    className="secondary-button"
                    disabled={busyId === automation.id}
                    onClick={() => void runStatus(automation, 'resume')}
                    type="button"
                  >
                    恢复
                  </button>
                )}
                {(automation.status === 'active' ||
                  automation.status === 'paused') &&
                  (confirmCancelId === automation.id ? (
                    <>
                      <button
                        className="danger-button"
                        disabled={busyId === automation.id}
                        onClick={() => void runStatus(automation, 'cancel')}
                        type="button"
                      >
                        确认结束
                      </button>
                      <button
                        className="quiet-button"
                        onClick={() => setConfirmCancelId(undefined)}
                        type="button"
                      >
                        保留
                      </button>
                    </>
                  ) : (
                    <button
                      className="quiet-button"
                      disabled={busyId === automation.id}
                      onClick={() => setConfirmCancelId(automation.id)}
                      type="button"
                    >
                      结束
                    </button>
                  ))}
              </div>
              {historyId === automation.id && (
                <div className="record-history">
                  {historyLoading && <small>正在读取触发记录…</small>}
                  {historyError && (
                    <small className="record-history-error" role="alert">
                      {historyError}
                      <button
                        className="inline-link"
                        onClick={() => {
                          setHistoryId(undefined)
                          void toggleHistory(automation)
                        }}
                        type="button"
                      >
                        重试
                      </button>
                    </small>
                  )}
                  {!historyLoading &&
                    !historyError &&
                    invocations &&
                    (invocations.length ? (
                      <ul aria-label="触发记录">
                        {invocations.map(invocation => (
                          <li key={invocation.id}>
                            <span
                              className={`invocation-status is-${invocation.status}`}
                            >
                              {invocationStatusLabel(invocation.status)}
                            </span>
                            <span>
                              计划 {formatDateTime(invocation.scheduledFor)}
                            </span>
                            {invocation.attempts > 1 && (
                              <span>尝试 {invocation.attempts} 次</span>
                            )}
                            {invocation.lastError && (
                              <span className="invocation-error">
                                {invocation.lastError}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <small>还没有触发记录</small>
                    ))}
                </div>
              )}
            </article>
          ))}
        </section>
      )}
      {form && (
        <AutomationForm
          channels={channels}
          draft={form.mode === 'edit' ? form.automation : undefined}
          onCancel={() => setForm(undefined)}
          onSubmit={async draft => {
            if (form.mode === 'edit') await onUpdate(form.automation, draft)
            else await onCreate(draft)
            setForm(undefined)
          }}
        />
      )}
    </div>
  )
}

export function MemoryPage({
  actions,
  channels,
  error,
  memories,
  onCreate,
  onDelete,
  onReload,
  onUpdate,
  truncated,
}: {
  actions: PageActions
  channels: WorkChannel[]
  error: string
  memories?: MemoryRecord[]
  onCreate: (draft: MemoryDraft) => Promise<void>
  onDelete: (memory: MemoryRecord) => Promise<void>
  onReload: () => void
  onUpdate: (memory: MemoryRecord, draft: MemoryDraft) => Promise<void>
  truncated: boolean
}) {
  const [filter, setFilter] = useState<'all' | MemoryScope>('all')
  const [form, setForm] = useState<
    { mode: 'create' } | { mode: 'edit'; memory: MemoryRecord }
  >()
  const [busyId, setBusyId] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>()
  const [actionError, setActionError] = useState('')
  const visible = (memories ?? []).filter(
    memory => filter === 'all' || memory.scope === filter,
  )
  async function runDelete(memory: MemoryRecord) {
    setBusyId(memory.id)
    setActionError('')
    try {
      await onDelete(memory)
      setConfirmDeleteId(undefined)
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : '删除失败，请重试。',
      )
    } finally {
      setBusyId('')
    }
  }
  return (
    <div className="standard-page">
      <PageHeader
        actions={actions}
        description="查看、修改或删除 Pegas 记住的内容"
        title="记忆"
      >
        <button
          className="primary-button page-header-action"
          onClick={() => setForm({ mode: 'create' })}
          type="button"
        >
          <Plus size={16} />
          添加记忆
        </button>
      </PageHeader>
      <div className="filter-row" role="tablist">
        {memoryScopes.map(scope => (
          <button
            aria-pressed={filter === scope.id}
            aria-selected={filter === scope.id}
            key={scope.id}
            onClick={() => setFilter(scope.id)}
            role="tab"
            type="button"
          >
            {scope.label}
          </button>
        ))}
      </div>
      {truncated && (
        <p className="field-hint">
          仅显示最近的一部分记忆；完整列表以服务端为准。
        </p>
      )}
      {error && (
        <div className="page-error" role="alert">
          {error}
          <button className="inline-link" onClick={onReload} type="button">
            重试
          </button>
        </div>
      )}
      {actionError && (
        <div className="page-error" role="alert">
          {actionError}
        </div>
      )}
      {!memories && !error && <p className="page-loading">正在读取记忆…</p>}
      {memories && visible.length === 0 && !error && (
        <EmptyCapability
          icon={Layers3}
          title={memories.length ? '该范围下还没有记忆' : '还没有记忆'}
          description={
            memories.length
              ? '切换其他范围，或添加一条新的记忆。'
              : '把偏好、事实或经验告诉 Pegas，它会带来源和作用范围保存。'
          }
        />
      )}
      {memories && visible.length > 0 && (
        <section className="record-list" aria-label="记忆列表">
          {visible.map(memory => (
            <article key={memory.id}>
              <span className="record-icon is-active">
                <Layers3 size={18} />
              </span>
              <div className="record-copy">
                <strong>{memory.content}</strong>
                <small className="record-meta">
                  {memoryScopeLabel(memory.scope)}
                  {memory.taskId
                    ? ` · ${
                        channels.find(channel => channel.id === memory.taskId)
                          ?.title ?? '已有事情'
                      }`
                    : ''}{' '}
                  · {memoryCategoryLabel(memory.category)} ·{' '}
                  {memory.source.kind === 'user_confirmation'
                    ? '来源：用户确认'
                    : `来源：${memory.source.kind}`}
                </small>
                <small className="record-meta">
                  更新于 {formatRelativeTime(memory.updatedAt)}
                  {memory.lastUsedAt
                    ? ` · 最近使用 ${formatRelativeTime(memory.lastUsedAt)}`
                    : ''}
                </small>
              </div>
              <div className="record-actions">
                <button
                  className="secondary-button"
                  disabled={busyId === memory.id}
                  onClick={() => setForm({ mode: 'edit', memory })}
                  type="button"
                >
                  编辑
                </button>
                {confirmDeleteId === memory.id ? (
                  <>
                    <button
                      className="danger-button"
                      disabled={busyId === memory.id}
                      onClick={() => void runDelete(memory)}
                      type="button"
                    >
                      确认删除
                    </button>
                    <button
                      className="quiet-button"
                      onClick={() => setConfirmDeleteId(undefined)}
                      type="button"
                    >
                      保留
                    </button>
                  </>
                ) : (
                  <button
                    className="quiet-button"
                    disabled={busyId === memory.id}
                    onClick={() => setConfirmDeleteId(memory.id)}
                    type="button"
                  >
                    <Trash2 size={15} />
                    删除
                  </button>
                )}
              </div>
            </article>
          ))}
        </section>
      )}
      {form && (
        <MemoryForm
          channels={channels}
          draft={form.mode === 'edit' ? form.memory : undefined}
          onCancel={() => setForm(undefined)}
          onSubmit={async draft => {
            if (form.mode === 'edit') await onUpdate(form.memory, draft)
            else await onCreate(draft)
            setForm(undefined)
          }}
        />
      )}
    </div>
  )
}

const memoryScopes: readonly { id: 'all' | MemoryScope; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'global', label: '全局' },
  { id: 'worker', label: 'Worker' },
  { id: 'channel', label: '事情' },
]

const memoryCategories: readonly { id: MemoryCategory; label: string }[] = [
  { id: 'preference', label: '偏好' },
  { id: 'fact', label: '事实' },
  { id: 'context', label: '情境' },
  { id: 'experience', label: '经验' },
  { id: 'procedure', label: '过程' },
  { id: 'sensitive_reference', label: '受保护引用' },
]

function memoryScopeLabel(scope: MemoryScope): string {
  return memoryScopes.find(item => item.id === scope)?.label ?? scope
}

function memoryCategoryLabel(category: MemoryCategory): string {
  return memoryCategories.find(item => item.id === category)?.label ?? category
}

function automationStatusLabel(status: Automation['status']): string {
  if (status === 'active') return '已启用'
  if (status === 'paused') return '已暂停'
  if (status === 'completed') return '已完成'
  return '已结束'
}

function invocationStatusLabel(status: AutomationInvocation['status']): string {
  if (status === 'pending') return '待触发'
  if (status === 'processing') return '处理中'
  if (status === 'dispatched') return '已派发'
  return '失败'
}

function formatDateTime(value: string): string {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function describeSchedule(automation: Automation): string {
  if (automation.schedule.kind === 'once')
    return `一次性 · ${formatDateTime(automation.schedule.at)}`
  const minutes = Math.round(automation.schedule.everySeconds / 60)
  return minutes % 60 === 0
    ? `每 ${String(minutes / 60)} 小时`
    : `每 ${String(minutes)} 分钟`
}

function AutomationForm({
  channels,
  draft,
  onCancel,
  onSubmit,
}: {
  channels: WorkChannel[]
  draft?: Automation
  onCancel: () => void
  onSubmit: (draft: AutomationDraft) => Promise<void>
}) {
  const [title, setTitle] = useState(draft?.title ?? '')
  const [prompt, setPrompt] = useState(draft?.prompt ?? '')
  const [kind, setKind] = useState<'interval' | 'once'>(
    draft?.schedule.kind ?? 'interval',
  )
  const [everyMinutes, setEveryMinutes] = useState(
    draft?.schedule.kind === 'interval'
      ? String(Math.max(1, Math.round(draft.schedule.everySeconds / 60)))
      : '60',
  )
  const [onceAt, setOnceAt] = useState(() => {
    const base =
      draft?.schedule.kind === 'once'
        ? new Date(draft.schedule.at)
        : new Date(Date.now() + 3_600_000)
    const local = new Date(base.getTime() - base.getTimezoneOffset() * 60_000)
    return local.toISOString().slice(0, 16)
  })
  const [targetKind, setTargetKind] = useState<'new_task' | 'existing_task'>(
    draft?.target.kind ?? 'new_task',
  )
  const [targetTaskId, setTargetTaskId] = useState(
    draft?.target.kind === 'existing_task'
      ? draft.target.taskId
      : (channels[0]?.id ?? ''),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    dialogRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])
  async function submit() {
    if (saving) return
    if (!title.trim() || !prompt.trim()) {
      setError('名称和意图都不能为空。')
      return
    }
    const minutes = Number(everyMinutes)
    if (kind === 'interval' && (!Number.isFinite(minutes) || minutes < 1)) {
      setError('间隔至少 1 分钟。')
      return
    }
    const at = new Date(onceAt)
    if (kind === 'once' && Number.isNaN(at.getTime())) {
      setError('请选择有效的执行时间。')
      return
    }
    if (targetKind === 'existing_task' && !targetTaskId) {
      setError('请选择要续接的事情。')
      return
    }
    setSaving(true)
    setError('')
    try {
      await onSubmit({
        title: title.trim(),
        prompt: prompt.trim(),
        schedule:
          kind === 'once'
            ? { kind: 'once', at: at.toISOString() }
            : { kind: 'interval', everySeconds: Math.round(minutes * 60) },
        target:
          targetKind === 'new_task'
            ? { kind: 'new_task' }
            : { kind: 'existing_task', taskId: targetTaskId },
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败，请重试。')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={event => event.target === event.currentTarget && onCancel()}
    >
      <section
        aria-label={draft ? '编辑自动化' : '新建自动化'}
        aria-modal="true"
        className="command-dialog record-form"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="record-form-header">
          <h2>{draft ? '编辑自动化' : '新建自动化'}</h2>
          <button aria-label="关闭" onClick={onCancel} type="button">
            <X size={18} />
          </button>
        </header>
        <div className="record-form-body">
          {error && (
            <div className="page-error" role="alert">
              {error}
            </div>
          )}
          <label className="field-label">
            名称
            <input
              onChange={event => setTitle(event.target.value)}
              value={title}
            />
          </label>
          <label className="field-label">
            意图
            <textarea
              onChange={event => setPrompt(event.target.value)}
              rows={3}
              value={prompt}
            />
          </label>
          <label className="field-label">
            触发方式
            <select
              onChange={event =>
                setKind(event.target.value as 'interval' | 'once')
              }
              value={kind}
            >
              <option value="interval">固定间隔</option>
              <option value="once">一次性</option>
            </select>
          </label>
          {kind === 'interval' ? (
            <label className="field-label">
              间隔（分钟）
              <input
                min={1}
                onChange={event => setEveryMinutes(event.target.value)}
                type="number"
                value={everyMinutes}
              />
            </label>
          ) : (
            <label className="field-label">
              执行时间
              <input
                onChange={event => setOnceAt(event.target.value)}
                type="datetime-local"
                value={onceAt}
              />
            </label>
          )}
          <label className="field-label">
            目标
            <select
              onChange={event =>
                setTargetKind(
                  event.target.value as 'new_task' | 'existing_task',
                )
              }
              value={targetKind}
            >
              <option value="new_task">每次创建新事情</option>
              <option value="existing_task">续接已有事情</option>
            </select>
          </label>
          {targetKind === 'existing_task' && (
            <label className="field-label">
              事情
              <select
                onChange={event => setTargetTaskId(event.target.value)}
                value={targetTaskId}
              >
                {channels.map(channel => (
                  <option key={channel.id} value={channel.id}>
                    {channel.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <footer className="record-form-footer">
          <button className="quiet-button" onClick={onCancel} type="button">
            取消
          </button>
          <button
            className="primary-button"
            disabled={saving}
            onClick={() => void submit()}
            type="button"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </section>
    </div>
  )
}

function MemoryForm({
  channels,
  draft,
  onCancel,
  onSubmit,
}: {
  channels: WorkChannel[]
  draft?: MemoryRecord
  onCancel: () => void
  onSubmit: (draft: MemoryDraft) => Promise<void>
}) {
  const [scope, setScope] = useState<MemoryScope>(draft?.scope ?? 'global')
  const [taskId, setTaskId] = useState(draft?.taskId ?? channels[0]?.id ?? '')
  const [category, setCategory] = useState<MemoryCategory>(
    draft?.category ?? 'preference',
  )
  const [content, setContent] = useState(draft?.content ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    dialogRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])
  async function submit() {
    if (saving) return
    if (!content.trim()) {
      setError('记忆内容不能为空。')
      return
    }
    if (scope !== 'global' && !taskId) {
      setError('Worker 与事情范围必须选择一件事情。')
      return
    }
    setSaving(true)
    setError('')
    try {
      await onSubmit({
        scope,
        ...(scope !== 'global' ? { taskId } : {}),
        category,
        content: content.trim(),
        source: draft?.source ?? { kind: 'user_confirmation' },
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败，请重试。')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={event => event.target === event.currentTarget && onCancel()}
    >
      <section
        aria-label={draft ? '编辑记忆' : '添加记忆'}
        aria-modal="true"
        className="command-dialog record-form"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="record-form-header">
          <h2>{draft ? '编辑记忆' : '添加记忆'}</h2>
          <button aria-label="关闭" onClick={onCancel} type="button">
            <X size={18} />
          </button>
        </header>
        <div className="record-form-body">
          {error && (
            <div className="page-error" role="alert">
              {error}
            </div>
          )}
          <label className="field-label">
            内容
            <textarea
              onChange={event => setContent(event.target.value)}
              rows={3}
              value={content}
            />
          </label>
          <label className="field-label">
            类别
            <select
              onChange={event =>
                setCategory(event.target.value as MemoryCategory)
              }
              value={category}
            >
              {memoryCategories.map(item => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            作用范围
            <select
              onChange={event => setScope(event.target.value as MemoryScope)}
              value={scope}
            >
              <option value="global">全局</option>
              <option value="worker">Worker</option>
              <option value="channel">事情</option>
            </select>
          </label>
          {scope !== 'global' && (
            <label className="field-label">
              事情
              <select
                onChange={event => setTaskId(event.target.value)}
                value={taskId}
              >
                {channels.map(channel => (
                  <option key={channel.id} value={channel.id}>
                    {channel.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="field-hint">
            {draft
              ? '来源保持服务端记录不变；修改会以新修订保存。'
              : '手动添加的记忆来源记为“用户确认”。'}
          </p>
        </div>
        <footer className="record-form-footer">
          <button className="quiet-button" onClick={onCancel} type="button">
            取消
          </button>
          <button
            className="primary-button"
            disabled={saving}
            onClick={() => void submit()}
            type="button"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </section>
    </div>
  )
}
