import {
  ArrowUp,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleQuestionMark,
  Copy,
  FileText,
  Layers3,
  Link2,
  LoaderCircle,
  Mic,
  PauseCircle,
  Plus,
  RotateCw,
  Search,
  Send,
  ShieldCheck,
  Square,
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
import { ModelPicker, modelSelectionKey } from './ModelPicker'
import { PegasMascot } from './PegasMascot'
import { EmptyCapability, PageToolbar } from './Shell'
import {
  attentionActionKind,
  attentionActivityPage,
  attentionBoard,
  attentionKind,
  attentionSummary,
  clarificationQuestions,
  conversationAnchor,
  conversationLane,
  formatRelativeTime,
  formatRunDuration,
  isReconciliationMessage,
  isResolvedDecisionMessage,
  isSilentConversationMessage,
  latestRunForTask,
  latestRunProgressText,
  needsOutboxResolution,
  reviewProjection,
  statusLabel,
  taskContextCue,
  textFromPayload,
  type AttentionActionKind,
  type AttentionGroup,
  type ConversationAnchor,
  type ConversationLane,
  type DrawerView,
  type TaskContextCue,
} from './types'
import { useChatScroll } from './useChatScroll'

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
  compact = false,
}: {
  title: string
  description: string
  actions: PageActions
  children?: React.ReactNode
  compact?: boolean
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {!compact && <p>{description}</p>}
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

export function ConversationPage({
  api,
  snapshot,
  actions,
  onSent,
  models,
  modelProvider,
  selectedModelId,
  onSelectModel,
  onAnswerClarification,
  onOpenAttention,
  onSelectTask,
  continuationChannel,
  sourceContextChannel,
  onClearContinuation,
  onClearSourceContext,
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
  onAnswerClarification: (channel: Snapshot['channels'][number]) => void
  onOpenAttention: (message: OutboxMessage) => Promise<void>
  onSelectTask: (taskId: string) => void
  continuationChannel?: Snapshot['channels'][number]
  sourceContextChannel?: Snapshot['channels'][number]
  onClearContinuation: () => void
  onClearSourceContext: () => void
  draft: string
  onDraftChange: (draft: string) => void
  speechEnabled: boolean
  onConfigureVoice: () => void
}) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [attachment, setAttachment] = useState<File>()
  const [voiceDirectSend, setVoiceDirectSend] = useState(false)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(
    () => new Set(),
  )
  const chatScroll = useChatScroll()
  const [copiedMessageId, setCopiedMessageId] = useState<string>()
  const [retryingMessageId, setRetryingMessageId] = useState<string>()
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([])
  const [confirmingStop, setConfirmingStop] = useState(false)
  const [stopping, setStopping] = useState(false)
  const previousPegasIdsRef = useRef<Set<string>>(new Set())
  const sendOriginRef = useRef<DOMRect | undefined>(undefined)
  const messages = useMemo(() => {
    const user = snapshot.events
      .filter(event => event.type === 'user.message')
      .map(event => ({
        id: event.id,
        role: 'user' as const,
        text: textFromPayload(event.payload),
        at: event.createdAt,
        status: event.status,
        attachment: event.attachment,
        cue: undefined as TaskContextCue | undefined,
        lane: 'say',
        taskId: undefined as string | undefined,
        anchor: undefined as ConversationAnchor | undefined,
        resolved: false,
        source: undefined as OutboxMessage | undefined,
      }))
    const pegas = snapshot.messages
      .filter(message => !isSilentConversationMessage(message))
      .map(message => {
        const channel = snapshot.channels.find(
          item => item.id === message.taskId,
        )
        const questions = clarificationQuestions(message)
        return {
          id: message.id,
          role: 'pegas' as const,
          text: textFromPayload(message.payload),
          at: message.createdAt,
          taskId: message.taskId,
          cue: taskContextCue(message, snapshot.channels),
          clarification:
            channel?.statusReason === 'awaiting_goal_clarification'
              ? questions
              : undefined,
          review: reviewProjection(message),
          lane: conversationLane(message),
          anchor: conversationAnchor(message),
          resolved: isResolvedDecisionMessage(message, snapshot.messages),
          source: message,
        }
      })
    const visible = [...user, ...pegas]
      .filter(message => message.text)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    const derivedByOrigin = new Map<string, string[]>()
    for (const message of visible) {
      if (message.role !== 'pegas' || !message.anchor?.eventId) continue
      if (message.lane === 'say') continue
      const list = derivedByOrigin.get(message.anchor.eventId) ?? []
      list.push(message.id)
      derivedByOrigin.set(message.anchor.eventId, list)
    }
    return visible.map(message => ({
      ...message,
      derivedIds:
        message.role === 'user' ? (derivedByOrigin.get(message.id) ?? []) : [],
    }))
  }, [snapshot.channels, snapshot.events, snapshot.messages])
  const messageBlocks = useMemo(
    () => groupMessageThreads<(typeof messages)[number]>(messages),
    [messages],
  )
  useEffect(() => {
    const previous = previousPegasIdsRef.current
    const fresh = messages.filter(
      message => message.role === 'pegas' && !previous.has(message.id),
    )
    previousPegasIdsRef.current = new Set(
      messages
        .filter(message => message.role === 'pegas')
        .map(message => message.id),
    )
    if (fresh.length > 0) {
      chatScroll.noteNewReply('Pegas 发来了新回复')
    }
  }, [messages, chatScroll])
  const dictation = useVoiceDictation({
    transcribe: async blob => {
      if (!voiceDirectSend) return api.transcribeVoice(blob)
      const result = await api.sendVoiceMessage(blob, continuationChannel?.id)
      if (attachment) {
        await api.uploadEventAttachment(result.event.id, attachment)
      }
      setAttachment(undefined)
      onClearContinuation()
      await onSent()
      return result.transcript
    },
    onTranscript: text => {
      if (voiceDirectSend) return
      onDraftChange(`${draft}${draft ? ' ' : ''}${text}`)
    },
  })
  const dictationBusy = dictation.state !== 'idle'
  const trayChannels = useMemo(
    () =>
      snapshot.channels
        .filter(
          channel =>
            channel.status !== 'completed' && channel.status !== 'cancelled',
        )
        .toSorted(
          (left, right) =>
            Date.parse(right.latestActivityAt) -
            Date.parse(left.latestActivityAt),
        ),
    [snapshot.channels],
  )
  useEffect(() => {
    if (continuationChannel?.status === 'cancelled') onClearContinuation()
  }, [continuationChannel, onClearContinuation])
  const summaryChannel =
    snapshot.channels.find(item => item.id === continuationChannel?.id) ??
    trayChannels[0] ??
    snapshot.channels[0]
  const summaryRun = summaryChannel
    ? latestRunForTask(snapshot.runs, summaryChannel.id)
    : undefined
  const summaryActive =
    summaryRun?.status === 'running' || summaryRun?.status === 'queued'
  const steerTarget = continuationChannel
  const steerRun = steerTarget
    ? latestRunForTask(snapshot.runs, steerTarget.id)
    : undefined
  const canSteer =
    steerRun?.status === 'running' || steerRun?.status === 'queued'
  const canQueue =
    continuationChannel !== undefined &&
    continuationChannel.status !== 'completed' &&
    continuationChannel.status !== 'cancelled' &&
    summaryActive

  async function send() {
    const text = draft.trim()
    if (!text || sending || dictationBusy) return
    sendOriginRef.current = captureSendOrigin()
    setSending(true)
    setError('')
    try {
      const event = await api.sendMessage(
        text,
        sourceContextChannel ? undefined : continuationChannel?.id,
        sourceContextChannel?.id,
      )
      if (attachment) {
        try {
          await api.uploadEventAttachment(event.id, attachment)
        } catch (caught) {
          setError(
            `消息已发送，但附件上传失败：${caught instanceof Error ? caught.message : '请重试。'}`,
          )
        }
      }
      setAttachment(undefined)
      onDraftChange('')
      onClearContinuation()
      onClearSourceContext()
      await onSent()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '发送失败，请重试。')
    } finally {
      setSending(false)
    }
  }

  async function steer() {
    const text = draft.trim()
    if (!text || !steerTarget || sending || dictationBusy) return
    sendOriginRef.current = captureSendOrigin()
    setSending(true)
    setError('')
    try {
      await api.sendSteerMessage(text, steerTarget.id)
      onDraftChange('')
      await onSent()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `插话失败：${caught.message}`
          : '插话失败，请重试。',
      )
    } finally {
      setSending(false)
    }
  }

  function queueDraft() {
    const text = draft.trim()
    if (!text || !continuationChannel) return
    setQueuedMessages(current => [
      ...current,
      { id: crypto.randomUUID(), text, channelId: continuationChannel.id },
    ])
    onDraftChange('')
    setError('')
  }

  useEffect(() => {
    if (queuedMessages.length === 0 || sending) return
    const next = queuedMessages[0]
    if (!next) return
    const channel = snapshot.channels.find(item => item.id === next.channelId)
    if (!channel || channel.status === 'cancelled') {
      setQueuedMessages(current => current.slice(1))
      return
    }
    const run = latestRunForTask(snapshot.runs, channel.id)
    if (run && (run.status === 'running' || run.status === 'queued')) return
    void (async () => {
      setSending(true)
      try {
        await api.sendMessage(next.text, channel.id)
        setQueuedMessages(current => current.slice(1))
        await onSent()
      } catch (caught) {
        setError(
          caught instanceof Error
            ? `排队消息发送失败：${caught.message}`
            : '排队消息发送失败，请重试。',
        )
      } finally {
        setSending(false)
      }
    })()
  }, [queuedMessages, sending, snapshot.channels, snapshot.runs, api, onSent])

  async function copyMessage(messageId: string, text: string) {
    try {
      const html = `<div>${text
        .split(/\n{2,}/u)
        .map(
          paragraph =>
            `<p>${escapeHtml(paragraph).replace(/\n/gu, '<br>')}</p>`,
        )
        .join('')}</div>`
      if (typeof navigator.clipboard.write === 'function') {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([text], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' }),
          }),
        ])
      } else {
        await navigator.clipboard.writeText(text)
      }
      setCopiedMessageId(messageId)
      window.setTimeout(() => {
        setCopiedMessageId(current =>
          current === messageId ? undefined : current,
        )
      }, 1500)
    } catch {
      setError('复制失败，请检查浏览器剪贴板权限。')
    }
  }

  async function retryMessage(eventId: string) {
    setRetryingMessageId(eventId)
    setError('')
    try {
      await api.retryEvent(eventId)
      await onSent()
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : '重试失败，请稍后再试。',
      )
    } finally {
      setRetryingMessageId(undefined)
    }
  }

  async function stopSummary() {
    if (!summaryChannel || stopping) return
    setStopping(true)
    setError('')
    try {
      await api.stopChannel(summaryChannel.id, 'Stopped from the Pegas UI')
      setConfirmingStop(false)
      await onSent()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '停止失败，请重试。')
    } finally {
      setStopping(false)
    }
  }

  function captureSendOrigin(): DOMRect | undefined {
    const textarea =
      document.querySelector<HTMLTextAreaElement>('#pegas-message')
    return textarea?.getBoundingClientRect()
  }

  useEffect(() => {
    const origin = sendOriginRef.current
    if (!origin) return
    sendOriginRef.current = undefined
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const content = chatScroll.contentRef.current
    if (!content) return
    const rows = content.querySelectorAll<HTMLElement>('.message-row.is-user')
    const row = rows[rows.length - 1]
    const body = row?.querySelector<HTMLElement>('.message-content')
    if (!row || !body) return
    const target = body.getBoundingClientRect()
    if (target.width === 0 || target.height === 0) return
    const deltaX = origin.left - target.left
    const deltaY = origin.top - target.top
    const scaleX = Math.max(0.5, Math.min(1, origin.width / target.width))
    const scaleY = Math.max(0.5, Math.min(1, origin.height / target.height))
    row.dataset.sendAnimating = 'true'
    const animation = body.animate(
      [
        {
          transform: `translate(${String(deltaX)}px, ${String(deltaY)}px) scale(${String(scaleX)}, ${String(scaleY)})`,
          opacity: 0.4,
        },
        {
          transform: 'translate(0, -3px) scale(1.01, 1.02)',
          opacity: 1,
          offset: 0.8,
        },
        { transform: 'translate(0, 0) scale(1, 1)', opacity: 1 },
      ],
      { duration: 600, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
    )
    const finish = () => {
      delete row.dataset.sendAnimating
    }
    animation.onfinish = finish
    animation.oncancel = finish
  }, [messages, chatScroll.contentRef])

  function selectAttachment(file: File | undefined) {
    if (!file) return
    if (file.size > 25 * 1024 * 1024) {
      setError('附件超过 25MB 上限，请压缩后再试。')
      return
    }
    setError('')
    setAttachment(file)
  }

  const [highlightedId, setHighlightedId] = useState<string>()
  const highlightTimerRef = useRef<number>(0)
  useEffect(() => () => window.clearTimeout(highlightTimerRef.current), [])

  function jumpToMessage(messageId: string) {
    const content = chatScroll.contentRef.current
    const row = content?.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    )
    if (!row) return
    if ('scrollIntoView' in row)
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setHighlightedId(messageId)
    window.clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = window.setTimeout(
      () => setHighlightedId(undefined),
      1600,
    )
  }

  function openTaskDetails(taskId: string | undefined) {
    if (!taskId) return
    const channel = snapshot.channels.find(item => item.id === taskId)
    if (channel)
      actions.onOpenDrawer({
        kind: 'task',
        channel,
        run: latestRunForTask(snapshot.runs, channel.id),
      })
  }

  function renderMessage(
    message: (typeof messages)[number],
    groupedNext: boolean,
    inThreadContinuation: boolean,
  ) {
    return (
      <article
        className={[
          'message-row',
          `is-${message.role}`,
          message.role === 'pegas' && message.lane !== 'say'
            ? `is-lane-${message.lane}`
            : '',
          groupedNext ? 'grouped-next' : '',
          highlightedId === message.id ? 'is-anchor-highlight' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-message-id={message.id}
        key={message.id}
      >
        <div className="message-content">
          {message.role === 'pegas' && message.lane !== 'say' ? (
            <FactCard
              actions={actions}
              expanded={expandedMessages.has(message.id)}
              hideTaskTitle={inThreadContinuation}
              message={message}
              onAnswerClarification={onAnswerClarification}
              onJumpToMessage={jumpToMessage}
              onOpenAttention={onOpenAttention}
              onOpenTask={openTaskDetails}
              onToggleExpanded={() =>
                setExpandedMessages(current => {
                  const next = new Set(current)
                  if (next.has(message.id)) next.delete(message.id)
                  else next.add(message.id)
                  return next
                })
              }
              snapshot={snapshot}
            />
          ) : (
            <>
              {message.role === 'pegas' && message.cue && (
                <p className="message-context-cue">
                  <span>「{message.cue.title}」</span>
                </p>
              )}
              <MarkdownMessage
                content={
                  message.text.length > 520 && !expandedMessages.has(message.id)
                    ? `${message.text.slice(0, 520)}…`
                    : message.text
                }
                linkPreviewLoader={url => api.linkPreview(url)}
              />
            </>
          )}
          {message.role === 'user' && message.attachment && (
            <span className="message-attachment">
              <FileText size={14} />
              {message.attachment.fileName} ·{' '}
              {formatFileSize(message.attachment.byteSize)}
            </span>
          )}
          {message.text.length > 520 && message.lane === 'say' && (
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
          {message.role === 'pegas' &&
            message.lane === 'say' &&
            message.taskId && (
              <button
                className="inline-link"
                onClick={() => openTaskDetails(message.taskId)}
                type="button"
              >
                查看工作详情 <ArrowRight size={15} />
              </button>
            )}
        </div>
        <div className="message-meta">
          {message.role === 'user' && (
            <UserMessageStatus
              message={message}
              onJumpToMessage={jumpToMessage}
              onRetry={() => void retryMessage(message.id)}
              retrying={retryingMessageId === message.id}
              snapshot={snapshot}
            />
          )}
          <time dateTime={message.at}>{formatRelativeTime(message.at)}</time>
          <button
            aria-label={copiedMessageId === message.id ? '已复制' : '复制消息'}
            className="message-action"
            onClick={() => void copyMessage(message.id, message.text)}
            type="button"
          >
            {copiedMessageId === message.id ? (
              <Check size={14} />
            ) : (
              <Copy size={14} />
            )}
          </button>
        </div>
      </article>
    )
  }

  return (
    <div className="conversation-page">
      <PageHeader
        actions={actions}
        compact
        description="你的私人智能工作伙伴"
        title="Pegas"
      />
      <div
        className="conversation-scroll"
        onScroll={chatScroll.onScroll}
        ref={chatScroll.scrollRef}
      >
        <div className="conversation-flow" ref={chatScroll.contentRef}>
          {messages.length === 0 ? (
            <section className="conversation-welcome">
              <PegasMascot size={148} />
              <h2>今天想一起完成什么？</h2>
              <p>告诉我目标。我会整理事情、推进执行，并在需要你决定时回来。</p>
            </section>
          ) : (
            messageBlocks.map(block =>
              block.kind === 'thread' ? (
                <section
                  aria-label={`事情进展：${
                    snapshot.channels.find(item => item.id === block.taskId)
                      ?.title ?? 'Pegas'
                  }`}
                  className="message-thread"
                  key={`thread-${block.messages[0]?.id ?? block.taskId}`}
                >
                  {block.messages.map((message, threadIndex) =>
                    renderMessage(
                      message,
                      threadIndex < block.messages.length - 1,
                      threadIndex > 0,
                    ),
                  )}
                </section>
              ) : (
                renderMessage(block.message, false, false)
              ),
            )
          )}

          {summaryChannel && summaryRun && (
            <RunStatusBar
              channel={summaryChannel}
              messages={snapshot.messages}
              onOpen={() =>
                actions.onOpenDrawer({
                  kind: 'task',
                  channel: summaryChannel,
                  run: summaryRun,
                })
              }
              run={summaryRun}
            />
          )}
        </div>
        <p aria-live="polite" className="visually-hidden" role="status">
          {chatScroll.announcement}
        </p>
      </div>

      {chatScroll.hasNewReplies && (
        <button
          className="new-replies-button"
          onClick={chatScroll.jumpToBottom}
          type="button"
        >
          新回复 <ArrowUp size={14} className="is-flipped" />
        </button>
      )}

      <div className="composer-wrap" ref={chatScroll.composerRef}>
        {trayChannels.length > 0 && (
          <div aria-label="进行中的事情" className="task-tray" role="group">
            {trayChannels.map(channel => {
              const channelRun = latestRunForTask(snapshot.runs, channel.id)
              const selected = continuationChannel?.id === channel.id
              const waitingOnUser = channel.statusReason !== undefined
              return (
                <button
                  aria-pressed={selected}
                  className="task-tray-item"
                  data-status={
                    waitingOnUser
                      ? 'attention'
                      : channelRun?.status === 'running' ||
                          channelRun?.status === 'queued'
                        ? 'active'
                        : 'idle'
                  }
                  key={channel.id}
                  onClick={() => {
                    if (selected) onClearContinuation()
                    else onSelectTask(channel.id)
                  }}
                  title={
                    selected
                      ? '取消选中，恢复自动归属'
                      : `选中后输入指向「${channel.title}」`
                  }
                  type="button"
                >
                  <i aria-hidden="true" />
                  <span className="task-tray-title">{channel.title}</span>
                  <small>{statusLabel(channel, channelRun)}</small>
                </button>
              )
            })}
          </div>
        )}
        {confirmingStop && summaryChannel && (
          <div
            aria-labelledby="composer-stop-title"
            className="stop-confirmation"
            role="alertdialog"
          >
            <div>
              <strong id="composer-stop-title">确定停止这件事？</strong>
              <p>
                停止后无法继续当前运行；历史记录会保留，你仍可重新发起事情。
              </p>
            </div>
            <div className="stop-confirmation-actions">
              <button onClick={() => setConfirmingStop(false)} type="button">
                继续执行
              </button>
              <button
                className="is-danger"
                disabled={stopping}
                onClick={() => void stopSummary()}
                type="button"
              >
                {stopping ? '正在停止…' : '确认停止'}
              </button>
            </div>
          </div>
        )}
        {queuedMessages.length > 0 && (
          <ol aria-label="排队消息" className="composer-queue">
            {queuedMessages.map((item, index) => (
              <li key={item.id}>
                <span className="composer-queue-preview" title={item.text}>
                  {item.text}
                </span>
                <button
                  aria-label={`编辑排队消息 ${String(index + 1)}`}
                  onClick={() => {
                    setQueuedMessages(current =>
                      current.filter(entry => entry.id !== item.id),
                    )
                    onDraftChange(item.text)
                  }}
                  type="button"
                >
                  编辑
                </button>
                <button
                  aria-label={`删除排队消息 ${String(index + 1)}`}
                  onClick={() =>
                    setQueuedMessages(current =>
                      current.filter(entry => entry.id !== item.id),
                    )
                  }
                  type="button"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ol>
        )}
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
        {attachment && (
          <div className="composer-context" role="status">
            <span>
              附件：<strong>{attachment.name}</strong> ·{' '}
              {formatFileSize(attachment.size)}
            </span>
            <button
              aria-label="移除附件"
              onClick={() => setAttachment(undefined)}
              type="button"
            >
              <X size={15} />
            </button>
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
        {sourceContextChannel && (
          <div className="composer-context" role="status">
            <span>
              新建相关事情，携带终态摘要：
              <strong>{sourceContextChannel.title}</strong>
            </span>
            <button
              aria-label="取消携带来源事情摘要"
              onClick={onClearSourceContext}
              type="button"
            >
              <X size={15} />
            </button>
          </div>
        )}
        <form
          aria-label="发送消息"
          className={[
            'composer',
            draft.includes('\n') || attachment || continuationChannel
              ? 'is-multiline'
              : 'is-single-line',
          ].join(' ')}
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
                ? voiceDirectSend
                  ? `正在听，说完直接发送 · ${String(dictation.elapsedSeconds)} 秒`
                  : `正在听 · ${String(dictation.elapsedSeconds)} 秒`
                : '和 Pegas 一起工作'
            }
            rows={1}
            value={draft}
          />
          <div className="composer-toolbar">
            <div className="composer-tools" aria-label="输入工具">
              <input
                aria-label="选择附件文件"
                className="visually-hidden"
                onChange={event => {
                  selectAttachment(event.target.files?.[0])
                  event.target.value = ''
                }}
                ref={attachmentInputRef}
                tabIndex={-1}
                type="file"
              />
              <button
                aria-label="添加附件"
                className="composer-add-button"
                disabled={sending || dictationBusy}
                onClick={() => attachmentInputRef.current?.click()}
                title="添加附件（最大 25MB，随下一条消息发送）"
                type="button"
              >
                <Plus size={22} />
              </button>
              <button
                aria-label="说完直接发送"
                aria-pressed={voiceDirectSend}
                className={voiceDirectSend ? 'is-armed' : ''}
                disabled={dictationBusy}
                onClick={() => setVoiceDirectSend(current => !current)}
                title={
                  voiceDirectSend
                    ? '语音直发已开启：录音结束后直接发送'
                    : '开启后，录音结束会直接发送，不进入草稿'
                }
                type="button"
              >
                <Send size={18} />
              </button>
            </div>
            <div className="composer-actions">
              {sending && (
                <span className="composer-working">
                  <PegasMascot pose="waiting" size={30} />
                  正在整理…
                </span>
              )}
              {canSteer && draft.trim() && (
                <button
                  className="composer-steer-button"
                  disabled={sending || dictationBusy}
                  onClick={() => void steer()}
                  title="不打断当前执行，把这条指示立即交给正在做的事情"
                  type="button"
                >
                  <Zap size={15} /> 插话
                </button>
              )}
              {canQueue && draft.trim() && (
                <button
                  className="composer-queue-button"
                  disabled={sending || dictationBusy}
                  onClick={queueDraft}
                  title="选中的事情完成后自动发送这条消息"
                  type="button"
                >
                  排队
                </button>
              )}
              <ModelPicker
                ariaLabel="选择执行模型"
                footer="模型变更只作用于新建执行会话"
                models={models}
                onSelect={(_, model) => {
                  if (model) return onSelectModel(model)
                }}
                placeholder="执行模型"
                value={
                  selectedModelId
                    ? modelSelectionKey(
                        models.find(
                          model =>
                            model.id === selectedModelId &&
                            (!modelProvider ||
                              model.provider === modelProvider),
                        ) ??
                          models.find(
                            model => model.id === selectedModelId,
                          ) ?? {
                            provider: modelProvider ?? '',
                            id: selectedModelId,
                            name: selectedModelId,
                          },
                      )
                    : ''
                }
                variant="composer"
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
                title={voiceDirectSend ? '录音并直接发送' : '语音转文字'}
                type="button"
              >
                <Mic size={20} />
              </button>
              {summaryActive && summaryChannel?.canStop && !draft.trim() ? (
                <button
                  aria-label="停止"
                  className="send-button is-stop"
                  disabled={stopping}
                  onClick={() => setConfirmingStop(true)}
                  title="停止当前执行"
                  type="button"
                >
                  <Square size={16} />
                </button>
              ) : (
                <button
                  aria-label="发送"
                  className="send-button"
                  disabled={!draft.trim() || sending || dictationBusy}
                  type="submit"
                >
                  <ArrowUp size={20} />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

interface ThreadMessage {
  id: string
  role: 'user' | 'pegas'
  lane: string
  taskId?: string
}

type MessageBlock<T extends ThreadMessage> =
  | { kind: 'message'; message: T }
  | { kind: 'thread'; taskId: string; messages: T[] }

function groupMessageThreads<T extends ThreadMessage>(
  messages: readonly T[],
): MessageBlock<T>[] {
  const blocks: MessageBlock<T>[] = []
  let run: T[] = []
  const flush = () => {
    if (run.length === 0) return
    const taskId = run[0]?.taskId
    if (run.length >= 2 && taskId)
      blocks.push({ kind: 'thread', taskId, messages: run })
    else for (const message of run) blocks.push({ kind: 'message', message })
    run = []
  }
  for (const message of messages) {
    const isFact = message.role === 'pegas' && message.lane !== 'say'
    if (
      isFact &&
      message.taskId &&
      run.length > 0 &&
      run[0]?.taskId === message.taskId
    ) {
      run.push(message)
      continue
    }
    flush()
    if (isFact && message.taskId) run = [message]
    else blocks.push({ kind: 'message', message })
  }
  flush()
  return blocks
}

interface QueuedMessage {
  id: string
  text: string
  channelId: string
}

interface FactCardMessage {
  id: string
  text: string
  taskId?: string
  lane: ConversationLane
  anchor?: ConversationAnchor
  resolved: boolean
  clarification?: string[]
  review?: ReturnType<typeof reviewProjection>
  source?: OutboxMessage
}

function factCardHeading(message: FactCardMessage): {
  icon: typeof Check
  label: string
} {
  if (message.lane === 'decide') {
    if (message.resolved) return { icon: CheckCircle2, label: '已处理' }
    if (message.review) return { icon: CheckCircle2, label: '需要你审查' }
    if (message.clarification)
      return { icon: CircleQuestionMark, label: '需要你补充' }
    if (message.source && isReconciliationMessage(message.source))
      return { icon: ShieldCheck, label: '需要你核对' }
    return { icon: ShieldCheck, label: '需要你决定' }
  }
  const type =
    message.source?.payload &&
    typeof message.source.payload === 'object' &&
    typeof (message.source.payload as { type?: unknown }).type === 'string'
      ? (message.source.payload as { type: string }).type
      : undefined
  if (type === 'run.failed' || type === 'action.failed')
    return { icon: CircleAlert, label: '执行失败' }
  if (message.review) return { icon: CheckCircle2, label: '交付可审查' }
  if (type === 'run.completed') return { icon: CheckCircle2, label: '已完成' }
  return { icon: Layers3, label: '工作进展' }
}

function FactCard({
  message,
  snapshot,
  actions,
  expanded,
  hideTaskTitle = false,
  onToggleExpanded,
  onJumpToMessage,
  onOpenTask,
  onAnswerClarification,
  onOpenAttention,
}: {
  message: FactCardMessage
  snapshot: Snapshot
  actions: PageActions
  expanded: boolean
  hideTaskTitle?: boolean
  onToggleExpanded: () => void
  onJumpToMessage: (messageId: string) => void
  onOpenTask: (taskId: string | undefined) => void
  onAnswerClarification: (channel: Snapshot['channels'][number]) => void
  onOpenAttention: (message: OutboxMessage) => Promise<void>
}) {
  const heading = factCardHeading(message)
  const Icon = heading.icon
  const channel = message.taskId
    ? snapshot.channels.find(item => item.id === message.taskId)
    : undefined
  const summary = message.source
    ? attentionSummary(message.source)
    : { title: message.text }
  const decideLabel = message.review
    ? '审查交付'
    : (message.clarification ||
          (message.source &&
            attentionKind(message.source) === 'input' &&
            channel)) &&
        channel
      ? '去回答'
      : message.source && needsOutboxResolution(message.source)
        ? '核对投递'
        : message.source && isReconciliationMessage(message.source)
          ? '去核对'
          : message.source && attentionKind(message.source) === 'approval'
            ? '查看内容'
            : '去处理'
  const collapsedBody =
    message.text.length > 520 ? `${message.text.slice(0, 520)}…` : message.text
  const originEventId = message.anchor?.eventId
  const originVisible =
    originEventId !== undefined &&
    snapshot.events.some(
      event => event.id === originEventId && event.type === 'user.message',
    )
  return (
    <section
      aria-label={`${heading.label}：${channel?.title ?? summary.title}`}
      className={[
        'fact-card',
        `is-${message.lane}`,
        message.resolved ? 'is-resolved' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <header className="fact-card-header">
        <Icon size={16} />
        <strong>{heading.label}</strong>
        {channel && !hideTaskTitle && (
          <button
            className="fact-card-task"
            onClick={() => onOpenTask(message.taskId)}
            type="button"
          >
            {channel.title}
          </button>
        )}
        {originVisible && originEventId && (
          <button
            aria-label="回到发起消息"
            className="fact-card-origin"
            onClick={() => onJumpToMessage(originEventId)}
            type="button"
          >
            <Link2 size={14} />
          </button>
        )}
      </header>
      <div className="fact-card-body">
        <MarkdownMessage content={expanded ? message.text : collapsedBody} />
        {message.text.length > 520 && (
          <button
            className="inline-link"
            onClick={onToggleExpanded}
            type="button"
          >
            {expanded ? '收起' : '展开完整内容'}
          </button>
        )}
      </div>
      {message.lane === 'decide' && !message.resolved && (
        <div className="fact-card-actions">
          <button
            className="primary-button"
            onClick={() => {
              if (message.review && channel && message.source) {
                actions.onOpenDrawer({
                  kind: 'review',
                  review: message.review,
                  channel,
                  message: message.source,
                })
                return
              }
              if (message.clarification && channel) {
                onAnswerClarification(channel)
                return
              }
              if (
                message.source &&
                attentionKind(message.source) === 'input' &&
                channel
              ) {
                onAnswerClarification(channel)
                return
              }
              if (
                message.source &&
                (attentionKind(message.source) === 'approval' ||
                  isReconciliationMessage(message.source) ||
                  needsOutboxResolution(message.source))
              ) {
                void onOpenAttention(message.source)
                return
              }
              onOpenTask(message.taskId)
            }}
            type="button"
          >
            {decideLabel} <ArrowRight size={15} />
          </button>
        </div>
      )}
      {message.lane === 'work' && channel && (
        <div className="fact-card-actions">
          <button
            className="secondary-button"
            onClick={() => {
              if (message.review && message.source) {
                actions.onOpenDrawer({
                  kind: 'review',
                  review: message.review,
                  channel,
                  message: message.source,
                })
                return
              }
              onOpenTask(message.taskId)
            }}
            type="button"
          >
            {message.review ? '审查交付' : '查看工作详情'}{' '}
            <ArrowRight size={15} />
          </button>
        </div>
      )}
    </section>
  )
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

const WAITING_PHRASES = [
  '正在梳理思路',
  '正在拆解步骤',
  '正在核对已有信息',
  '正在推进这件事',
] as const

const LONG_WAIT_PHRASES = [
  '这件事比平时花的时间长一些',
  '还在继续推进，可以先去忙别的',
  '仍在处理中，有结果会第一时间回来',
] as const

function RunStatusBar({
  channel,
  run,
  messages,
  onOpen,
}: {
  channel: WorkChannel
  run: NonNullable<ReturnType<typeof latestRunForTask>>
  messages: readonly OutboxMessage[]
  onOpen: () => void
}) {
  const active = run.status === 'running' || run.status === 'queued'
  const progressText = latestRunProgressText(messages, run.id)
  const [phraseIndex, setPhraseIndex] = useState(0)
  useEffect(() => {
    if (!active || progressText) return
    const started = Date.parse(run.createdAt)
    const timer = window.setInterval(() => {
      setPhraseIndex(current => current + 1)
    }, 5000)
    const elapsed = Date.now() - started
    if (elapsed > 120_000) setPhraseIndex(current => current + 1)
    return () => window.clearInterval(timer)
  }, [active, progressText, run.createdAt])
  const elapsedLong = Date.now() - Date.parse(run.createdAt) > 120_000
  const waitingPhrase = elapsedLong
    ? LONG_WAIT_PHRASES[phraseIndex % LONG_WAIT_PHRASES.length]
    : WAITING_PHRASES[phraseIndex % WAITING_PHRASES.length]
  const duration = formatRunDuration(run)
  const headline = active
    ? statusLabel(channel, run)
    : run.status === 'completed'
      ? '已完成'
      : run.status === 'failed'
        ? '执行失败'
        : run.status === 'cancelled'
          ? '已停止'
          : '等待中'
  const detail = active
    ? (progressText ?? waitingPhrase)
    : run.status === 'completed' && duration
      ? `工作了 ${duration}`
      : run.status === 'failed'
        ? (run.lastError ?? '可以重试或补充说明后继续')
        : `${(run.output ?? channel.goal).slice(0, 160)}${(run.output ?? channel.goal).length > 160 ? '…' : ''}`
  return (
    <button
      className="run-status-bar"
      data-active={active || undefined}
      onClick={onOpen}
      type="button"
    >
      <i data-status={run.status} />
      <span>
        <strong className={active ? 'is-shimmer' : undefined}>
          {headline} · {channel.title}
        </strong>
        <small>{detail}</small>
      </span>
      <ArrowRight size={18} />
    </button>
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
      <div className="filter-row" role="group" aria-label="筛选">
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
            key={id}
            onClick={() => setFilter(id)}
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
  return '发送失败'
}

function UserMessageStatus({
  message,
  snapshot,
  retrying,
  onJumpToMessage,
  onRetry,
}: {
  message: {
    id: string
    status: Snapshot['events'][number]['status']
    derivedIds: string[]
  }
  snapshot: Snapshot
  retrying: boolean
  onJumpToMessage: (messageId: string) => void
  onRetry: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!menuOpen) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (
        menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      )
        return
      setMenuOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [menuOpen])

  if (message.status === 'failed') {
    return (
      <span className="message-status">
        <span
          aria-label="发送失败"
          className="message-status-icon is-failed"
          role="img"
          title="发送失败"
        >
          <CircleAlert size={14} />
        </span>
        <button
          className="message-action is-retry"
          disabled={retrying}
          onClick={onRetry}
          type="button"
        >
          <RotateCw size={14} />
          {retrying ? '重试中…' : '重试'}
        </button>
      </span>
    )
  }
  if (message.status === 'pending' || message.status === 'processing') {
    const label = deliveryStatusLabel(message.status)
    return (
      <span className="message-status">
        <span
          aria-label={label}
          className={`message-status-icon${
            message.status === 'processing' ? ' is-processing' : ''
          }`}
          role="img"
          title={label}
        >
          {message.status === 'processing' ? (
            <LoaderCircle size={14} />
          ) : (
            <Check size={14} />
          )}
        </span>
      </span>
    )
  }
  if (message.derivedIds.length === 0) return null
  if (message.derivedIds.length === 1) {
    const targetId = message.derivedIds[0] ?? message.id
    return (
      <span className="message-status">
        <button
          aria-label="查看进展"
          className="message-derived-trigger"
          onClick={() => onJumpToMessage(targetId)}
          title="查看进展"
          type="button"
        >
          <Link2 size={14} />
        </button>
      </span>
    )
  }
  const derived = message.derivedIds
    .map(id => snapshot.messages.find(item => item.id === id))
    .filter((item): item is OutboxMessage => Boolean(item))
  const entries = derived.map(fact => {
    const channel = fact.taskId
      ? snapshot.channels.find(item => item.id === fact.taskId)
      : undefined
    const run = channel
      ? latestRunForTask(snapshot.runs, channel.id)
      : undefined
    const state =
      channel?.status === 'completed'
        ? 'done'
        : channel?.statusReason?.startsWith('awaiting')
          ? 'wait'
          : run?.status === 'failed'
            ? 'failed'
            : 'run'
    return {
      id: fact.id,
      title: channel?.title ?? attentionSummary(fact).title,
      state,
      label: channel ? statusLabel(channel, run) : '工作进展',
    }
  })
  if (entries.length === 0) return null
  return (
    <span className="message-status">
      <button
        aria-controls={menuId}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label={`查看进展：${String(message.derivedIds.length)} 个事情`}
        className="message-derived-trigger"
        onClick={() => setMenuOpen(current => !current)}
        ref={triggerRef}
        title={`查看进展 · ${String(message.derivedIds.length)} 个事情`}
        type="button"
      >
        <Link2 size={14} />
        <span className="message-derived-count">
          {message.derivedIds.length}
        </span>
      </button>
      {menuOpen && (
        <div
          aria-label="这条消息派生的事情"
          className="message-derived-menu"
          id={menuId}
          ref={menuRef}
          role="menu"
        >
          {entries.map(entry => (
            <button
              key={entry.id}
              onClick={() => {
                setMenuOpen(false)
                onJumpToMessage(entry.id)
              }}
              role="menuitem"
              type="button"
            >
              <span className="derived-task-name">
                <FileText size={14} />
                <span>{entry.title}</span>
              </span>
              <span className={`status-text status-${entry.label}`}>
                {entry.label}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${String(Math.round(bytes / 1024))}KB`
  return `${String(bytes)}B`
}

function attentionAction(message: OutboxMessage): {
  label: string
  icon: typeof Check
} {
  if (needsOutboxResolution(message))
    return { label: '核对投递', icon: ShieldCheck }
  const kind = attentionKind(message)
  if (kind === 'failed') return { label: '查看原因', icon: RotateCw }
  if (
    isReconciliationMessage(message) ||
    attentionActionKind(message) === 'reconcile'
  )
    return { label: '去核对', icon: ShieldCheck }
  if (reviewProjection(message))
    return { label: '审查交付', icon: CheckCircle2 }
  if (clarificationQuestions(message))
    return { label: '去回答', icon: CircleQuestionMark }
  if (kind === 'approval') return { label: '查看内容', icon: ShieldCheck }
  return { label: '打开事情', icon: ArrowRight }
}

function attentionTodoLabel(kind: AttentionActionKind): string {
  if (kind === 'confirm') return '确认'
  if (kind === 'answer') return '回答'
  if (kind === 'review') return '验收'
  return '核对'
}

function attentionTodoIcon(kind: AttentionActionKind): typeof Check {
  if (kind === 'confirm') return ShieldCheck
  if (kind === 'answer') return CircleQuestionMark
  if (kind === 'review') return CheckCircle2
  return ShieldCheck
}

function attentionDeliveryNote(message: OutboxMessage): string | undefined {
  if (needsOutboxResolution(message))
    return message.status === 'unknown'
      ? '投递结果未知，待核对'
      : '投递失败，待核对'
  if (message.resolution)
    return message.resolution.resolution === 'sent'
      ? '人工核对：已送达'
      : '人工核对：未送达'
  return undefined
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
  const [filter, setFilter] = useState<'all' | 'todo' | 'failed' | 'activity'>(
    'all',
  )
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set())
  const board = attentionBoard(snapshot.messages)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  function matchesQuery(message: OutboxMessage): boolean {
    if (!normalizedQuery) return true
    const channel = snapshot.channels.find(item => item.id === message.taskId)
    const summary = attentionSummary(message)
    return `${summary.title} ${summary.preview ?? ''} ${textFromPayload(message.payload)} ${channel?.title ?? 'Pegas'}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  }
  const visibleTodo = board.todo.filter(matchesQuery)
  const visibleFailed = board.failed.filter(group =>
    group.messages.some(matchesQuery),
  )
  const visibleActivity = board.activity.filter(group =>
    group.messages.some(matchesQuery),
  )
  const counts = {
    all: board.todo.length + board.failed.length + board.activity.length,
    todo: board.todo.length,
    failed: board.failed.reduce((sum, group) => sum + group.messages.length, 0),
    activity: board.activity.length,
  }
  const activityPage = attentionActivityPage(visibleActivity, page)
  const hasAttention = board.totalNotifications > 0
  const hasVisible =
    ((filter === 'all' || filter === 'todo') && visibleTodo.length > 0) ||
    ((filter === 'all' || filter === 'failed') && visibleFailed.length > 0) ||
    ((filter === 'all' || filter === 'activity') && visibleActivity.length > 0)
  function toggleExpanded(key: string) {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  function toggleShowAll(key: string) {
    setShowAll(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  function renderTodoRow(message: OutboxMessage) {
    const channel = snapshot.channels.find(item => item.id === message.taskId)
    const action = attentionAction(message)
    const Icon = action.icon
    const actionKind = attentionActionKind(message) ?? 'answer'
    const TodoIcon = attentionTodoIcon(actionKind)
    const summary = attentionSummary(message)
    const deliveryNote = attentionDeliveryNote(message)
    const source = channel?.title ?? 'Pegas'
    const titleId = `attention-title-${message.id}`
    return (
      <li key={message.id}>
        <article
          aria-labelledby={titleId}
          className={message.readAt ? 'is-read' : 'is-unread'}
        >
          <span className={`attention-icon is-${actionKind}`}>
            <TodoIcon size={18} />
          </span>
          <div className="attention-copy">
            <div className="attention-heading">
              <span className={`attention-kind is-${actionKind}`}>
                {attentionTodoLabel(actionKind)}
              </span>
              <h2>
                <button
                  className="attention-title"
                  id={titleId}
                  onClick={() => {
                    void onOpen(message)
                  }}
                  type="button"
                >
                  {summary.title}
                </button>
              </h2>
            </div>
            {summary.preview && (
              <p className="attention-preview">{summary.preview}</p>
            )}
            <div className="attention-meta">
              <span className="attention-read-state">
                {message.readAt ? '已读' : '未读'}
              </span>
              <span>来自：{source}</span>
              <time dateTime={message.createdAt}>
                {formatRelativeTime(message.createdAt)}
              </time>
              {deliveryNote && (
                <span className="attention-delivery-note">{deliveryNote}</span>
              )}
            </div>
          </div>
          <button
            aria-label={`${action.label}：${summary.title}`}
            className="attention-action"
            onClick={() => {
              void onOpen(message)
            }}
            type="button"
          >
            <Icon size={15} />
            {action.label}
          </button>
        </article>
      </li>
    )
  }
  function renderGroupRow(group: AttentionGroup) {
    const channel = snapshot.channels.find(item => item.id === group.taskId)
    const source = channel?.title ?? 'Pegas'
    const latestSummary = attentionSummary(group.latest)
    const groupTitle = group.taskId ? source : latestSummary.title
    const isExpanded = expanded.has(group.key)
    const expandedAll = showAll.has(group.key)
    const timeline = group.messages.slice(1)
    const visibleTimeline = expandedAll ? timeline : timeline.slice(0, 3)
    const action = attentionAction(group.latest)
    const ActionIcon = action.icon
    const titleId = `attention-title-${group.key}`
    const isFailed = group.section === 'failed'
    const unreadLabel =
      group.unreadCount > 0
        ? `${String(group.messages.length)} 条 · ${String(group.unreadCount)} 未读`
        : `${String(group.messages.length)} 条`
    return (
      <li key={group.key}>
        <article
          aria-labelledby={titleId}
          className={[
            group.unreadCount > 0 ? 'is-unread' : 'is-read',
            isExpanded ? 'is-expanded' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span
            className={`attention-icon ${isFailed ? 'is-failed' : 'is-result'}`}
          >
            {isFailed ? <CircleAlert size={18} /> : <CheckCircle2 size={18} />}
          </span>
          <div className="attention-copy">
            <div className="attention-heading">
              <h2>
                <button
                  aria-expanded={isExpanded}
                  className="attention-title"
                  id={titleId}
                  onClick={() => toggleExpanded(group.key)}
                  type="button"
                >
                  {groupTitle}
                </button>
              </h2>
            </div>
            <p className="attention-preview">最新：{latestSummary.title}</p>
            <div className="attention-meta">
              {group.taskId && <span>来自：{source}</span>}
              <time dateTime={group.latest.createdAt}>
                {formatRelativeTime(group.latest.createdAt)}
              </time>
              {group.unreadCount === 0 && <span>已读</span>}
              {attentionDeliveryNote(group.latest) && (
                <span className="attention-delivery-note">
                  {attentionDeliveryNote(group.latest)}
                </span>
              )}
            </div>
            {isExpanded && timeline.length > 0 && (
              <div className="attention-group-timeline">
                <ul role="list">
                  {visibleTimeline.map(message => {
                    const summary = attentionSummary(message)
                    return (
                      <li key={message.id}>
                        <button
                          className="attention-group-entry"
                          onClick={() => {
                            void onOpen(message)
                          }}
                          type="button"
                        >
                          <span
                            className={`attention-group-entry-dot${message.readAt ? '' : ' is-unread'}`}
                          />
                          <span className="attention-group-entry-title">
                            {summary.title}
                          </span>
                          <time dateTime={message.createdAt}>
                            {formatRelativeTime(message.createdAt)}
                          </time>
                        </button>
                      </li>
                    )
                  })}
                </ul>
                {(expandedAll || timeline.length > 3) && (
                  <button
                    className="attention-group-more"
                    onClick={() => toggleShowAll(group.key)}
                    type="button"
                  >
                    {expandedAll
                      ? '收起更早通知'
                      : `查看全部 ${String(group.messages.length)} 条`}
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="attention-group-side">
            <span
              className={`attention-count${isFailed ? ' is-failed' : ''}${group.unreadCount > 0 ? ' is-unread' : ''}`}
            >
              {unreadLabel}
            </span>
            <button
              aria-label={`${isExpanded ? '收起' : '展开'}：${groupTitle}`}
              aria-expanded={isExpanded}
              className="attention-toggle"
              onClick={() => toggleExpanded(group.key)}
              type="button"
            >
              {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            <button
              aria-label={`${action.label}：${groupTitle}`}
              className="attention-action"
              onClick={() => {
                void onOpen(group.latest)
              }}
              type="button"
            >
              <ActionIcon size={15} />
              {action.label}
            </button>
          </div>
        </article>
      </li>
    )
  }
  return (
    <div className="standard-page">
      <PageHeader
        actions={actions}
        description={
          hasAttention
            ? `${String(board.totalThings)} 件事情 · ${String(board.totalNotifications)} 条通知 · ${String(board.totalUnread)} 条未读`
            : 'Pegas 现在需要你处理的事情'
        }
        title="待你处理"
      >
        <label className="page-search">
          <Search size={17} />
          <input
            aria-label="搜索待处理内容"
            onChange={event => {
              setQuery(event.target.value)
              setPage(1)
            }}
            placeholder="搜索内容或来源"
            type="search"
            value={query}
          />
        </label>
      </PageHeader>
      <div
        className="filter-row attention-filters"
        role="group"
        aria-label="筛选"
      >
        {(
          [
            ['all', '全部'],
            ['todo', '待你处理'],
            ['failed', '失败'],
            ['activity', '事情动态'],
          ] as const
        ).map(([id, label]) => (
          <button
            aria-pressed={filter === id}
            key={id}
            onClick={event => {
              setFilter(id)
              setPage(1)
              if ('scrollIntoView' in event.currentTarget)
                event.currentTarget.scrollIntoView({
                  block: 'nearest',
                  inline: 'nearest',
                })
            }}
            type="button"
          >
            {label} {counts[id]}
          </button>
        ))}
      </div>
      <section className="attention-list" aria-label="待处理列表">
        {hasVisible ? (
          <>
            {(filter === 'all' || filter === 'todo') &&
              visibleTodo.length > 0 && (
                <div className="attention-section">
                  <h3 className="attention-section-title">
                    待你处理
                    <small>需要你确认、回答、验收或核对</small>
                  </h3>
                  <ul className="attention-items" role="list">
                    {visibleTodo.map(renderTodoRow)}
                  </ul>
                </div>
              )}
            {(filter === 'all' || filter === 'failed') &&
              visibleFailed.length > 0 && (
                <div className="attention-section">
                  <h3 className="attention-section-title">
                    失败
                    <small>同一事情的失败已合并</small>
                  </h3>
                  <ul className="attention-items" role="list">
                    {visibleFailed.map(renderGroupRow)}
                  </ul>
                </div>
              )}
            {(filter === 'all' || filter === 'activity') &&
              visibleActivity.length > 0 && (
                <div className="attention-section">
                  <h3 className="attention-section-title">
                    事情动态
                    <small>同一事情的通知已合并，最新在上</small>
                  </h3>
                  <ul className="attention-items" role="list">
                    {activityPage.groups.map(renderGroupRow)}
                  </ul>
                  {activityPage.pageCount > 1 && (
                    <nav
                      aria-label="事情动态分页"
                      className="pagination attention-pagination"
                    >
                      <span>
                        第 {activityPage.rangeStart}–{activityPage.rangeEnd}{' '}
                        件事情，共 {visibleActivity.length} 件
                      </span>
                      <button
                        disabled={activityPage.page <= 1}
                        onClick={() => setPage(activityPage.page - 1)}
                        type="button"
                      >
                        上一页
                      </button>
                      {Array.from(
                        { length: activityPage.pageCount },
                        (_, index) => index + 1,
                      ).map(candidate => (
                        <button
                          aria-current={
                            candidate === activityPage.page ? 'page' : undefined
                          }
                          key={candidate}
                          onClick={() => setPage(candidate)}
                          type="button"
                        >
                          {candidate}
                        </button>
                      ))}
                      <button
                        disabled={activityPage.page >= activityPage.pageCount}
                        onClick={() => setPage(activityPage.page + 1)}
                        type="button"
                      >
                        下一页
                      </button>
                    </nav>
                  )}
                </div>
              )}
          </>
        ) : (
          <EmptyCapability
            mascot={hasAttention ? 'waiting' : 'celebrate'}
            title={hasAttention ? '当前筛选下没有待处理项' : '现在没有待处理项'}
            description={
              hasAttention
                ? '切换其他筛选，或清除搜索词后再看看。'
                : '需要确认、补充信息或处理失败时，Pegas 会把它放在这里。'
            }
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
  const [promptId, setPromptId] = useState<string>()
  const [showEnded, setShowEnded] = useState(false)
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
        <div className="automation-lists">
          <section className="record-list" aria-label="自动化列表">
            {(hasLiveAutomations(automations)
              ? automations.filter(item => !isEndedAutomation(item))
              : automations
            ).map(automation => (
              <AutomationRow
                automation={automation}
                busyId={busyId}
                channels={channels}
                confirmCancelId={confirmCancelId}
                historyError={historyError}
                historyId={historyId}
                historyLoading={historyLoading}
                invocations={invocations}
                onCancelConfirm={() => setConfirmCancelId(undefined)}
                onConfirmCancel={() => setConfirmCancelId(automation.id)}
                onEdit={() => setForm({ mode: 'edit', automation })}
                onRunStatus={runStatus}
                onToggleHistory={toggleHistory}
                onTogglePrompt={() =>
                  setPromptId(current =>
                    current === automation.id ? undefined : automation.id,
                  )
                }
                promptOpen={promptId === automation.id}
              />
            ))}
          </section>
          {hasLiveAutomations(automations) && endedCount > 0 && (
            <section className="automation-ended" aria-label="已结束的自动化">
              <button
                aria-expanded={showEnded}
                className="quiet-button automation-ended-toggle"
                onClick={() => setShowEnded(current => !current)}
                type="button"
              >
                <ChevronDown
                  className={showEnded ? 'is-open' : undefined}
                  size={15}
                />
                已结束 {endedCount}
              </button>
              {showEnded && (
                <div className="record-list">
                  {automations.filter(isEndedAutomation).map(automation => (
                    <AutomationRow
                      automation={automation}
                      busyId={busyId}
                      channels={channels}
                      confirmCancelId={confirmCancelId}
                      historyError={historyError}
                      historyId={historyId}
                      historyLoading={historyLoading}
                      invocations={invocations}
                      onCancelConfirm={() => setConfirmCancelId(undefined)}
                      onConfirmCancel={() => setConfirmCancelId(automation.id)}
                      onEdit={() => setForm({ mode: 'edit', automation })}
                      onRunStatus={runStatus}
                      onToggleHistory={toggleHistory}
                      onTogglePrompt={() =>
                        setPromptId(current =>
                          current === automation.id ? undefined : automation.id,
                        )
                      }
                      promptOpen={promptId === automation.id}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
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

function isEndedAutomation(automation: Automation): boolean {
  return automation.status === 'completed' || automation.status === 'cancelled'
}

function hasLiveAutomations(automations: Automation[]): boolean {
  return automations.some(item => !isEndedAutomation(item))
}

function automationPromptSummary(prompt: string): string {
  const collapsed = prompt.replaceAll(/\s+/g, ' ').trim()
  return collapsed.length > 120 ? `${collapsed.slice(0, 120)}…` : collapsed
}

function AutomationRow({
  automation,
  busyId,
  channels,
  confirmCancelId,
  historyError,
  historyId,
  historyLoading,
  invocations,
  onCancelConfirm,
  onConfirmCancel,
  onEdit,
  onRunStatus,
  onToggleHistory,
  onTogglePrompt,
  promptOpen,
}: {
  automation: Automation
  busyId: string
  channels: WorkChannel[]
  confirmCancelId?: string
  historyError: string
  historyId?: string
  historyLoading: boolean
  invocations?: AutomationInvocation[]
  onCancelConfirm: () => void
  onConfirmCancel: () => void
  onEdit: () => void
  onRunStatus: (
    automation: Automation,
    action: 'pause' | 'resume' | 'cancel',
  ) => Promise<void>
  onToggleHistory: (automation: Automation) => Promise<void>
  onTogglePrompt: () => void
  promptOpen: boolean
}) {
  const promptRegionId = useId()
  return (
    <article key={automation.id}>
      <span className={`record-icon is-${automation.status}`}>
        <Zap size={18} />
      </span>
      <div className="record-copy">
        <div className="record-title">
          <strong>{automation.title}</strong>
          <span
            className={`status-text status-${automationStatusLabel(automation.status)}`}
          >
            {automationStatusLabel(automation.status)}
          </span>
        </div>
        <p className="automation-summary">
          {automationPromptSummary(automation.prompt)}
        </p>
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
          {' · '}
          {automation.status === 'active' && automation.nextFireAt
            ? `下次触发 ${formatDateTime(automation.nextFireAt)}`
            : automation.status === 'paused'
              ? '恢复后重新计算触发时间'
              : '保留历史记录'}
          {automation.lastFiredAt
            ? ` · 最近触发 ${formatRelativeTime(automation.lastFiredAt)}`
            : ''}
        </small>
        {promptOpen && (
          <pre className="automation-prompt" id={promptRegionId}>
            {automation.prompt}
          </pre>
        )}
      </div>
      <div className="record-actions">
        <button
          aria-controls={promptRegionId}
          aria-expanded={promptOpen}
          className="quiet-button"
          onClick={onTogglePrompt}
          type="button"
        >
          {promptOpen ? '收起指令' : '查看指令'}
        </button>
        <button
          aria-expanded={historyId === automation.id}
          className="quiet-button"
          onClick={() => void onToggleHistory(automation)}
          type="button"
        >
          触发记录
        </button>
        {(automation.status === 'active' || automation.status === 'paused') && (
          <button
            className="secondary-button"
            disabled={busyId === automation.id}
            onClick={onEdit}
            type="button"
          >
            编辑
          </button>
        )}
        {automation.status === 'active' && (
          <button
            className="secondary-button"
            disabled={busyId === automation.id}
            onClick={() => void onRunStatus(automation, 'pause')}
            type="button"
          >
            暂停
          </button>
        )}
        {automation.status === 'paused' && (
          <button
            className="secondary-button"
            disabled={busyId === automation.id}
            onClick={() => void onRunStatus(automation, 'resume')}
            type="button"
          >
            恢复
          </button>
        )}
        {(automation.status === 'active' || automation.status === 'paused') &&
          (confirmCancelId === automation.id ? (
            <>
              <button
                className="danger-button"
                disabled={busyId === automation.id}
                onClick={() => void onRunStatus(automation, 'cancel')}
                type="button"
              >
                确认结束
              </button>
              <button
                className="quiet-button"
                onClick={onCancelConfirm}
                type="button"
              >
                保留
              </button>
            </>
          ) : (
            <button
              className="quiet-button"
              disabled={busyId === automation.id}
              onClick={onConfirmCancel}
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
                onClick={() => void onToggleHistory(automation)}
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
                    <span>计划 {formatDateTime(invocation.scheduledFor)}</span>
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
      <div className="filter-row" role="group" aria-label="筛选">
        {memoryScopes.map(scope => (
          <button
            aria-pressed={filter === scope.id}
            key={scope.id}
            onClick={() => setFilter(scope.id)}
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
