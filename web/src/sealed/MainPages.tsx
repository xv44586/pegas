import { InlineReply } from './InlineReply'
import { answerFollowUps } from '../../../src/conversation/follow-ups'
import {
  ArrowUp,
  ArrowUpToLine,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleQuestionMark,
  FileText,
  GitBranch,
  Layers3,
  Link2,
  LoaderCircle,
  Mic,
  PauseCircle,
  Plus,
  Reply,
  RotateCw,
  Search,
  Send,
  ShieldCheck,
  Square,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'

import { quotableAgentReply } from '../../../src/conversation/projection'
import type { PegasApi, MessageTarget } from '../api'
import { MarkdownMessage } from '../MarkdownMessage'
import type {
  Automation,
  AutomationDraft,
  AutomationInvocation,
  ChannelSearchSort,
  DshModelCatalogItem,
  DerivedMemoryRecord,
  DerivedMemorySyncState,
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
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  FormField,
  GlideMenu,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusPill,
  TextArea,
  TextInput,
} from '@bui/index'
import {
  CopyMessageButton,
  MetaIconButton,
  RowStatusPill,
  RunTrace,
  SayBody,
  statusTone,
  WorkEntryButton,
  type FactTone,
} from './ConversationBui'
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
  routingClarification,
  conversationAnchor,
  conversationLane,
  formatRelativeTime,
  formatRunDuration,
  hasActiveAutomationFact,
  isReconciliationMessage,
  isHistoricalWorkWait,
  isResolvedDecisionMessage,
  isSilentConversationMessage,
  isStreamingSayMessage,
  latestRunForTask,
  latestRunProgressText,
  needsOutboxResolution,
  reviewProjection,
  sortWorkChannels,
  statusLabel,
  taskContextCue,
  textFromPayload,
  type AttentionActionKind,
  type AttentionGroup,
  type ConversationAnchor,
  type ConversationLane,
  type ComposerTarget,
  type DrawerView,
  type TaskContextCue,
} from './types'
import { useChatScroll } from './useChatScroll'
import { useBrowserResultTrace } from './useBrowserResultTrace'

interface PageActions {
  onSearch: () => void
  onToggleAppearance: () => void
  isDark: boolean
  onOpenDrawer: (drawer: DrawerView) => void
}

const WORK_SORT_LABELS: Record<ChannelSearchSort, string> = {
  updated: '最近更新',
  created: '最近创建',
  ended: '最近结束',
}

function PageHeader({
  title,
  description,
  actions,
  children,
  compact = false,
  hasPageSearch = false,
}: {
  title: string
  description: string
  actions: PageActions
  children?: React.ReactNode
  compact?: boolean
  hasPageSearch?: boolean
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
          showSearch={!hasPageSearch}
        />
      </div>
    </header>
  )
}

export function ConversationPage({
  api,
  snapshot,
  snapshotReady = true,
  actions,
  onSent,
  models,
  modelProvider,
  selectedModelId,
  onSelectModel,
  onAnswerClarification,
  onOpenAttention,
  target,
  onTargetChange,
  onClearTarget,
  draft,
  onDraftChange,
  speechEnabled,
  onConfigureVoice,
}: {
  api: PegasApi
  snapshot: Snapshot
  snapshotReady?: boolean
  actions: PageActions
  onSent: () => Promise<void>
  models: DshModelCatalogItem[]
  modelProvider?: string
  selectedModelId?: string
  onSelectModel: (model: DshModelCatalogItem) => Promise<void>
  onAnswerClarification: (channel: Snapshot['channels'][number]) => void
  onOpenAttention: (message: OutboxMessage) => Promise<void>
  target?: ComposerTarget
  onTargetChange: (target: ComposerTarget) => void
  onClearTarget: (target: ComposerTarget | undefined) => void
  draft: string
  onDraftChange: Dispatch<SetStateAction<string>>
  speechEnabled: boolean
  onConfigureVoice: () => void
}) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [attachment, setAttachment] = useState<File>()
  const [voiceDirectSend, setVoiceDirectSend] = useState(false)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const composerInputRef = useRef<HTMLTextAreaElement>(null)
  const pendingSendRef = useRef<
    | {
        text: string
        target?: ComposerTarget
        dedupeKey: string
      }
    | undefined
  >(undefined)
  const voiceTargetRef = useRef<ComposerTarget | undefined>(undefined)
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(
    () => new Set(),
  )
  const chatScroll = useChatScroll()
  const [copiedMessageId, setCopiedMessageId] = useState<string>()
  const [retryingMessageId, setRetryingMessageId] = useState<string>()
  const [queuedMessages, setQueuedMessages] = useState(readQueuedMessages)
  const [stopTarget, setStopTarget] = useState<WorkChannel>()
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
        streaming: false,
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
          resolved:
            isHistoricalWorkWait(message, channel) ||
            isResolvedDecisionMessage(message, snapshot.messages),
          streaming: isStreamingSayMessage(message),
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
  useBrowserResultTrace(api, messages, chatScroll.contentRef)
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
  const targetChannel =
    target && target.kind !== 'reply'
      ? (snapshot.channels.find(channel => channel.id === target.channel.id) ??
        target.channel)
      : undefined
  const continuationChannel =
    target?.kind === 'task' ? targetChannel : undefined
  const sourceContextChannel =
    target?.kind === 'source' ? targetChannel : undefined

  async function attachToSentMessage(eventId: string) {
    if (!attachment) return
    try {
      await api.uploadEventAttachment(eventId, attachment)
    } catch (caught) {
      setError(
        `消息已发送，但附件上传失败：${caught instanceof Error ? caught.message : '请重试。'}`,
      )
    }
    setAttachment(undefined)
  }

  const dictation = useVoiceDictation({
    transcribe: async blob => {
      if (!voiceDirectSend) return api.transcribeVoice(blob)
      const recordedTarget = voiceTargetRef.current
      const result = await api.sendVoiceMessage(
        blob,
        messageTarget(recordedTarget),
      )
      await attachToSentMessage(result.event.id)
      onClearTarget(recordedTarget)
      await onSent()
      return result.transcript
    },
    onTranscript: text => {
      if (voiceDirectSend) return
      onDraftChange(current => `${current}${current ? ' ' : ''}${text}`)
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
  const summaryChannel =
    snapshot.channels.find(item => item.id === continuationChannel?.id) ??
    trayChannels[0] ??
    snapshot.channels[0]
  const summaryRun = summaryChannel
    ? latestRunForTask(snapshot.runs, summaryChannel.id)
    : undefined
  const summaryActive =
    summaryRun?.status === 'running' || summaryRun?.status === 'queued'
  const steerTarget =
    continuationChannel?.status === 'cancelled'
      ? undefined
      : continuationChannel
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
      const last = pendingSendRef.current
      const attempt =
        last?.text === text && last.target === target
          ? last
          : { text, target, dedupeKey: crypto.randomUUID() }
      pendingSendRef.current = attempt
      const event = await api.sendMessage(
        text,
        messageTarget(target),
        attempt.dedupeKey,
      )
      pendingSendRef.current = undefined
      await attachToSentMessage(event.id)
      onDraftChange(current => (current === draft ? '' : current))
      onClearTarget(target)
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
    if (attachment || sending || dictationBusy) return
    setQueuedMessages(current => [
      ...current,
      { id: crypto.randomUUID(), text, channel: continuationChannel },
    ])
    onDraftChange('')
    setError('')
  }

  useEffect(() => {
    try {
      if (queuedMessages.length)
        sessionStorage.setItem(
          queuedMessagesStorageKey,
          JSON.stringify(queuedMessages),
        )
      else sessionStorage.removeItem(queuedMessagesStorageKey)
    } catch {
      // Storage restrictions limit queued drafts to the current page.
    }
  }, [queuedMessages])

  useEffect(() => {
    if (!snapshotReady || sending || dictationBusy) return
    const next = queuedMessages[0]
    if (!next || next.error) return
    const channel = snapshot.channels.find(item => item.id === next.channel.id)
    function markFailure(message: string) {
      setQueuedMessages(current =>
        current.map(item =>
          item.id === next?.id ? { ...item, error: message } : item,
        ),
      )
    }
    if (
      !channel ||
      channel.status === 'cancelled' ||
      (channel.status === 'completed' &&
        channel.workflow &&
        channel.workflow.state !== 'delivered')
    ) {
      markFailure(
        channel
          ? '原事情已关闭，稿件已保留。'
          : '暂时读取不到原事情，稿件已保留。',
      )
      return
    }
    const run = latestRunForTask(snapshot.runs, channel.id)
    const busy = channel.workflow
      ? !['delivered', 'failed', 'not_started'].includes(channel.workflow.state)
      : run && ['running', 'queued', 'waiting'].includes(run.status)
    if (busy) return
    void (async () => {
      setSending(true)
      try {
        await api.sendMessage(next.text, { taskId: channel.id }, next.id)
        setQueuedMessages(current =>
          current.filter(item => item.id !== next.id),
        )
        await onSent()
      } catch (caught) {
        markFailure(
          caught instanceof Error
            ? caught.message
            : '待发消息提交失败，请重试。',
        )
      } finally {
        setSending(false)
      }
    })()
  }, [
    queuedMessages,
    sending,
    dictationBusy,
    snapshotReady,
    snapshot.channels,
    snapshot.runs,
    api,
    onSent,
  ])

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
    if (!stopTarget || stopping) return
    setStopping(true)
    setError('')
    try {
      await api.stopChannel(stopTarget.id, 'Stopped from the Pegas UI')
      setStopTarget(undefined)
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
    const workEntryChannel =
      message.role === 'pegas' && message.taskId
        ? snapshot.channels.find(item => item.id === message.taskId)
        : undefined
    const messageReview = message.role === 'pegas' ? message.review : undefined
    const workEntry =
      workEntryChannel &&
      messageReview &&
      (message.lane === 'work' || message.resolved)
        ? { channel: workEntryChannel, label: '审查交付' }
        : workEntryChannel &&
            (message.lane === 'say' || message.lane === 'work')
          ? { channel: workEntryChannel, label: '查看工作详情' }
          : undefined
    const replyQuote = message.source
      ? quotableAgentReply(message.source)
      : undefined
    const quote =
      workEntryChannel?.status === 'cancelled' ? undefined : replyQuote
    const selectQuote = quote
      ? (explain = workEntryChannel?.status === 'completed') => {
          if (sending || dictationBusy) return
          onTargetChange({
            kind: 'reply',
            id: message.id,
            text: quote.text,
            explain,
          })
          setError('')
          composerInputRef.current?.focus()
        }
      : undefined
    const followUps =
      quote &&
      !message.streaming &&
      (message.lane === 'say' ||
        workEntryChannel?.workflow?.resultMessageId === message.id)
        ? answerFollowUps(message.source?.payload)
        : []
    return (
      <article
        className={[
          'message-row group/reply',
          `is-${message.role}`,
          message.role === 'pegas' && message.lane !== 'say'
            ? `is-lane-${message.lane}`
            : '',
          message.streaming ? 'is-streaming' : '',
          workEntry ? 'has-work-entry' : '',
          selectQuote ? 'has-reply-action' : '',
          groupedNext ? 'grouped-next' : '',
          highlightedId === message.id ? 'is-anchor-highlight' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-message-id={message.id}
        data-result-trace={message.role === 'pegas' ? message.id : undefined}
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
              onExplainResult={
                selectQuote ? () => selectQuote(true) : undefined
              }
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
              <SayBody
                linkPreviewLoader={url => api.linkPreview(url)}
                streaming={message.streaming}
                text={
                  message.text.length > 520 && !expandedMessages.has(message.id)
                    ? `${message.text.slice(0, 520)}…`
                    : message.text
                }
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
              className="mt-2 inline-flex items-center gap-[5px] font-medium text-accent-ink"
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
        </div>
        {replyQuote && (
          <InlineReply
            items={followUps}
            taskTitle={workEntryChannel?.title ?? message.source?.taskId}
            excerpt={replyQuote.text}
            disabledReason={
              workEntryChannel?.status === 'cancelled'
                ? '事情已停止，无法继续发送。'
                : undefined
            }
            onSend={async (text, dedupeKey) => {
              await api.sendMessage(
                text,
                { replyToMessageId: message.id },
                dedupeKey,
              )
            }}
            onRefresh={onSent}
          />
        )}
        <div className="message-meta">
          {message.role === 'user' && (
            <UserMessageStatus
              message={message}
              onOpenTask={openTaskDetails}
              onRetry={() => void retryMessage(message.id)}
              retrying={retryingMessageId === message.id}
              snapshot={snapshot}
            />
          )}
          {workEntry && (
            <WorkEntryButton
              label={workEntry.label}
              onClick={() => {
                if (
                  workEntry.label === '审查交付' &&
                  messageReview &&
                  message.source
                ) {
                  actions.onOpenDrawer({
                    kind: 'review',
                    review: messageReview,
                    channel: workEntry.channel,
                    message: message.source,
                  })
                  return
                }
                openTaskDetails(workEntry.channel.id)
              }}
              taskTitle={workEntry.channel.title}
            />
          )}
          {message.role === 'user' && (
            <MetaIconButton
              label="查看调用链"
              onClick={() =>
                actions.onOpenDrawer({ kind: 'trace', eventId: message.id })
              }
            >
              <GitBranch aria-hidden="true" size={13} />
            </MetaIconButton>
          )}
          <time dateTime={message.at}>{formatRelativeTime(message.at)}</time>
          {selectQuote && (
            <MetaIconButton label="追问这条回复" onClick={() => selectQuote()}>
              <Reply size={14} />
            </MetaIconButton>
          )}
          <CopyMessageButton
            copied={copiedMessageId === message.id}
            onCopy={() => void copyMessage(message.id, message.text)}
          />
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
              api={api}
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
        <Button
          className="new-replies-button"
          onClick={chatScroll.jumpToBottom}
          size="sm"
          type="button"
          variant="secondary"
        >
          新回复 <ArrowUp size={14} className="is-flipped" />
        </Button>
      )}

      <div
        className="composer-wrap bui relative px-[42px] pt-3 pb-6 max-[820px]:px-3.5 max-[820px]:pt-2.5 max-[820px]:pb-3.5"
        ref={chatScroll.composerRef}
      >
        {trayChannels.length > 0 && (
          <div
            aria-label="进行中的事情"
            className="task-tray mx-auto mb-2 flex max-w-[1040px] gap-2 overflow-x-auto pb-0.5 [scrollbar-width:thin]"
            role="group"
          >
            {trayChannels.map(channel => {
              const channelRun = latestRunForTask(snapshot.runs, channel.id)
              const selected = continuationChannel?.id === channel.id
              const waitingOnUser = channel.workflow
                ? [
                    'awaiting_input',
                    'awaiting_approval',
                    'awaiting_reconciliation',
                    'awaiting_review',
                  ].includes(channel.workflow.state)
                : channel.statusReason !== undefined
              return (
                <button
                  aria-pressed={selected}
                  className="task-tray-item inline-flex h-[34px] max-w-[260px] shrink-0 items-center gap-[7px] rounded-full bg-surface px-3 text-[13px] shadow-hairline transition-colors duration-150 hover:bg-inset aria-pressed:bg-accent-tint aria-pressed:text-accent-ink"
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
                    if (selected) onClearTarget(target)
                    else onTargetChange({ kind: 'task', channel })
                  }}
                  title={
                    selected
                      ? '取消选中，恢复自动归属'
                      : `选中后输入指向「${channel.title}」`
                  }
                  type="button"
                >
                  <i aria-hidden="true" />
                  <span className="task-tray-title min-w-0 truncate">
                    {channel.title}
                  </span>
                  <small className="shrink-0 text-[11px] text-ink-3">
                    {statusLabel(channel, channelRun)}
                  </small>
                </button>
              )
            })}
          </div>
        )}
        {stopTarget && (
          <div
            aria-labelledby="composer-stop-title"
            className="stop-confirmation mx-auto mt-3.5 mb-2.5 flex max-w-[1040px] items-center justify-between gap-3.5 rounded-card bg-red-tint p-4 shadow-hairline"
            role="alertdialog"
          >
            <div>
              <strong className="text-red-text" id="composer-stop-title">
                确定停止这件事？
              </strong>
              <p className="mt-1 text-[13px] leading-[1.55] text-ink-2">
                「{stopTarget.title}
                」停止后无法继续当前运行；历史记录会保留，你仍可重新发起事情。
              </p>
            </div>
            <div className="stop-confirmation-actions flex shrink-0 gap-2">
              <Button
                onClick={() => setStopTarget(undefined)}
                size="sm"
                type="button"
                variant="secondary"
              >
                继续执行
              </Button>
              <Button
                disabled={stopping}
                onClick={() => void stopSummary()}
                size="sm"
                type="button"
                variant="danger"
              >
                {stopping ? '正在停止…' : '确认停止'}
              </Button>
            </div>
          </div>
        )}
        {queuedMessages.length > 0 && (
          <div className="mx-auto mb-2 max-w-[1040px]">
            <p className="mb-1 text-[12px] text-ink-2">本标签页待发</p>
            <ol
              aria-label="排队消息"
              className="composer-queue mx-auto mb-2 grid w-full max-w-[1040px] gap-1.5"
            >
              {queuedMessages.map((item, index) => (
                <li
                  className="flex min-h-9 items-center gap-2 rounded-card bg-surface px-2 py-1 text-[13px] shadow-hairline"
                  key={item.id}
                >
                  <span
                    className="composer-queue-preview min-w-0 flex-1 truncate text-ink-2"
                    title={item.text}
                  >
                    <strong className="mr-2">{item.channel.title}</strong>
                    {item.text}
                    {item.error && (
                      <small
                        className="block whitespace-normal text-red-text"
                        role="alert"
                      >
                        {item.error}
                      </small>
                    )}
                  </span>
                  {item.error && (
                    <Button
                      disabled={sending || dictationBusy}
                      onClick={() =>
                        setQueuedMessages(current =>
                          current.map(entry =>
                            entry.id === item.id
                              ? { ...entry, error: undefined }
                              : entry,
                          ),
                        )
                      }
                      size="xs"
                      type="button"
                      variant="quiet"
                    >
                      重试发送
                    </Button>
                  )}
                  <Button
                    aria-label={`编辑排队消息 ${String(index + 1)}`}
                    disabled={Boolean(draft.trim()) || sending || dictationBusy}
                    onClick={() => {
                      setQueuedMessages(current =>
                        current.filter(entry => entry.id !== item.id),
                      )
                      onTargetChange({ kind: 'task', channel: item.channel })
                      onDraftChange(item.text)
                      composerInputRef.current?.focus()
                    }}
                    size="xs"
                    type="button"
                    variant="quiet"
                  >
                    编辑
                  </Button>
                  <Button
                    aria-label={`删除排队消息 ${String(index + 1)}`}
                    className="w-7 px-0"
                    disabled={sending}
                    onClick={() =>
                      setQueuedMessages(current =>
                        current.filter(entry => entry.id !== item.id),
                      )
                    }
                    size="xs"
                    type="button"
                    variant="quiet"
                  >
                    <Trash2 size={14} />
                  </Button>
                </li>
              ))}
            </ol>
          </div>
        )}
        {error && (
          <div
            className="composer-error mx-auto mb-2 max-w-[1040px] text-[12px] text-red-text"
            role="alert"
          >
            {error}
          </div>
        )}
        {dictation.error && (
          <div
            className="composer-error mx-auto mb-2 max-w-[1040px] text-[12px] text-red-text"
            role="alert"
          >
            {dictation.error}
          </div>
        )}
        {attachment && (
          <div
            className="composer-context mx-auto mb-2 flex min-h-[38px] w-full max-w-[1040px] items-center justify-between gap-3 rounded-card bg-accent-tint px-3 py-1.5 text-[13px] text-ink-2"
            role="status"
          >
            <span>
              附件：<strong>{attachment.name}</strong> ·{' '}
              {formatFileSize(attachment.size)}
            </span>
            <MetaIconButton
              label="移除附件"
              onClick={() => setAttachment(undefined)}
            >
              <X size={15} />
            </MetaIconButton>
          </div>
        )}
        {continuationChannel && (
          <div
            className="composer-context mx-auto mb-2 flex min-h-[38px] w-full max-w-[1040px] items-center justify-between gap-3 rounded-card bg-accent-tint px-3 py-1.5 text-[13px] text-ink-2"
            role="status"
          >
            <span>
              继续事情：<strong>{continuationChannel.title}</strong>
            </span>
            <MetaIconButton
              label="取消继续当前事情"
              onClick={() => onClearTarget(target)}
            >
              <X size={15} />
            </MetaIconButton>
          </div>
        )}
        {sourceContextChannel && (
          <div
            className="composer-context mx-auto mb-2 flex min-h-[38px] w-full max-w-[1040px] items-center justify-between gap-3 rounded-card bg-accent-tint px-3 py-1.5 text-[13px] text-ink-2"
            role="status"
          >
            <span>
              新建相关事情，携带终态摘要：
              <strong>{sourceContextChannel.title}</strong>
            </span>
            <MetaIconButton
              label="取消携带来源事情摘要"
              onClick={() => onClearTarget(target)}
            >
              <X size={15} />
            </MetaIconButton>
          </div>
        )}
        {target?.kind === 'reply' && (
          <div
            className="composer-context mx-auto mb-2 flex min-h-[38px] w-full max-w-[1040px] items-center justify-between gap-3 rounded-card bg-accent-tint px-3 py-1.5 text-[13px] text-ink-2"
            role="status"
          >
            <button
              className="min-w-0 truncate text-left"
              onClick={() => jumpToMessage(target.id)}
              type="button"
            >
              <span>
                {target.explain ? '解释这次结果：' : '追问这条回复：'}
              </span>
              <strong>{target.text.slice(0, 120)}</strong>
            </button>
            <MetaIconButton
              label="取消引用回复"
              onClick={() => onClearTarget(target)}
            >
              <X size={15} />
            </MetaIconButton>
          </div>
        )}
        <form
          aria-label="发送消息"
          className={[
            'composer',
            'mx-auto grid max-w-[1040px] grid-rows-[auto_auto] bg-surface shadow-card transition-[border-radius,box-shadow,padding] duration-150 focus-within:shadow-raised pointer-coarse:pb-2',
            draft.includes('\n') || attachment || target
              ? 'is-multiline rounded-[24px] px-3.5 py-2.5 pl-5 max-[820px]:rounded-[20px] max-[820px]:px-3 max-[820px]:py-2.5 max-[820px]:pl-4'
              : 'is-single-line rounded-full py-1.5 pr-2 pl-5 max-[820px]:pl-4',
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
            className={`w-full min-w-0 resize-none overflow-y-auto border-0 bg-transparent py-[7px] text-[16px] leading-[1.55] caret-accent outline-none [field-sizing:content] [max-block-size:6lh] placeholder:text-ink-2 placeholder:opacity-55 ${
              draft.includes('\n') || attachment || target
                ? 'min-h-[54px] pb-3 max-[820px]:min-h-[46px] max-[820px]:pt-[5px]'
                : 'min-h-[38px] max-[820px]:min-h-[46px] max-[820px]:pt-[5px]'
            }`}
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
            ref={composerInputRef}
            rows={1}
            value={draft}
          />
          <div className="composer-toolbar flex min-w-0 items-center justify-between gap-3">
            <div
              className="composer-tools flex items-center gap-1.5"
              aria-label="输入工具"
            >
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
              <Button
                aria-label="添加附件"
                className="composer-add-button size-10 rounded-full p-0 text-ink-3 hover:bg-hover hover:text-ink pointer-coarse:size-11"
                disabled={sending || dictationBusy}
                onClick={() => attachmentInputRef.current?.click()}
                size="sm"
                title="添加附件（最大 25MB，随下一条消息发送）"
                type="button"
                variant="quiet"
              >
                <Plus size={22} />
              </Button>
              <Button
                aria-label="说完直接发送"
                aria-pressed={voiceDirectSend}
                className="size-10 rounded-full p-0 text-ink-3 hover:bg-hover hover:text-ink aria-pressed:bg-accent-tint aria-pressed:text-accent-ink pointer-coarse:size-11"
                disabled={dictationBusy}
                onClick={() => setVoiceDirectSend(current => !current)}
                size="sm"
                title={
                  voiceDirectSend
                    ? '语音直发已开启：录音结束后直接发送'
                    : '开启后，录音结束会直接发送，不进入草稿'
                }
                type="button"
                variant="quiet"
              >
                <Send size={18} />
              </Button>
            </div>
            <div className="composer-actions flex min-w-0 items-center gap-[7px]">
              {sending && (
                <span className="composer-working mr-auto inline-flex items-center gap-1.5 text-[12px] text-ink-2">
                  <PegasMascot pose="waiting" size={30} />
                  正在整理…
                </span>
              )}
              {canSteer && draft.trim() && !attachment && (
                <Button
                  className="composer-steer-button h-[34px] rounded-full bg-accent-tint px-3 text-[13px] font-medium text-accent-ink hover:bg-accent-tint hover:brightness-95"
                  disabled={sending || dictationBusy}
                  onClick={() => void steer()}
                  size="xs"
                  title="不打断当前执行，把这条指示立即交给正在做的事情"
                  type="button"
                  variant="quiet"
                >
                  <Zap size={15} /> 插话
                </Button>
              )}
              {canQueue && draft.trim() && !attachment && (
                <Button
                  className="composer-queue-button h-[34px] rounded-full bg-accent-tint px-3 text-[13px] font-medium text-accent-ink hover:bg-accent-tint hover:brightness-95"
                  disabled={sending || dictationBusy}
                  onClick={queueDraft}
                  size="xs"
                  title="选中的事情完成后自动发送这条消息"
                  type="button"
                  variant="quiet"
                >
                  排队
                </Button>
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
              <Button
                aria-label={
                  dictation.state === 'recording' ? '停止录音' : '语音输入'
                }
                className={`size-10 rounded-full p-0 text-ink-3 hover:bg-hover hover:text-ink pointer-coarse:size-11 ${dictation.state === 'recording' ? 'is-recording bg-red-tint text-red-text hover:bg-red-tint hover:text-red-text' : ''}`}
                onClick={() => {
                  if (dictation.state === 'recording') {
                    dictation.toggle()
                    return
                  }
                  if (!speechEnabled) {
                    onConfigureVoice()
                    return
                  }
                  if (dictation.state === 'idle')
                    voiceTargetRef.current = target
                  dictation.toggle()
                }}
                size="sm"
                title={voiceDirectSend ? '录音并直接发送' : '语音转文字'}
                type="button"
                variant="quiet"
              >
                <Mic size={20} />
              </Button>
              {summaryActive && summaryChannel?.canStop && !draft.trim() ? (
                <Button
                  aria-label="停止"
                  className="send-button is-stop size-[42px] rounded-full bg-red p-0 text-white hover:bg-red hover:brightness-95 [&_svg]:fill-current pointer-coarse:size-11"
                  disabled={stopping}
                  onClick={() => setStopTarget(summaryChannel)}
                  size="sm"
                  title="停止当前执行"
                  type="button"
                  variant="quiet"
                >
                  <Square size={16} />
                </Button>
              ) : (
                <Button
                  aria-label="发送"
                  className="send-button size-[42px] rounded-full bg-ink p-0 text-canvas hover:bg-ink hover:text-canvas hover:opacity-90 disabled:bg-line-strong disabled:text-ink-2 disabled:opacity-100 pointer-coarse:size-11"
                  disabled={!draft.trim() || sending || dictationBusy}
                  size="sm"
                  type="submit"
                  variant="quiet"
                >
                  <ArrowUp size={20} />
                </Button>
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
  channel: WorkChannel
  error?: string
}

const queuedMessagesStorageKey = 'pegas-queued-messages'

function readQueuedMessages(): QueuedMessage[] {
  try {
    const stored: unknown = JSON.parse(
      sessionStorage.getItem(queuedMessagesStorageKey) ?? '[]',
    )
    if (!Array.isArray(stored)) return []
    return (stored as unknown[]).filter((item): item is QueuedMessage => {
      if (!item || typeof item !== 'object') return false
      const value = item as Partial<QueuedMessage>
      return (
        typeof value.id === 'string' &&
        typeof value.text === 'string' &&
        typeof value.channel?.id === 'string' &&
        typeof value.channel.title === 'string'
      )
    })
  } catch {
    return []
  }
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
  if (type === 'run.completed') {
    if (message.source && hasActiveAutomationFact(message.source.payload))
      return { icon: CalendarClock, label: '已安排' }
    return { icon: CheckCircle2, label: '已完成' }
  }
  return { icon: Layers3, label: '工作进展' }
}

function factCardTone(message: FactCardMessage): FactTone {
  if (message.lane === 'decide') return message.resolved ? 'neutral' : 'orange'
  const type =
    message.source?.payload &&
    typeof message.source.payload === 'object' &&
    typeof (message.source.payload as { type?: unknown }).type === 'string'
      ? (message.source.payload as { type: string }).type
      : undefined
  if (type === 'run.failed' || type === 'action.failed') return 'red'
  if (type === 'run.completed')
    return message.source && hasActiveAutomationFact(message.source.payload)
      ? 'accent'
      : 'green'
  return 'neutral'
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
  onExplainResult,
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
  onExplainResult?: () => void
}) {
  const heading = factCardHeading(message)
  const tone = factCardTone(message)
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
        'bui',
        'fact-card',
        `is-${message.lane}`,
        'mt-3.5 grid w-full max-w-[560px] min-w-0 gap-2.5 rounded-card bg-surface p-3.5 shadow-card',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="fact-card-header flex min-w-0 flex-wrap items-center gap-2">
        <StatusPill tone={tone}>{heading.label}</StatusPill>
        {channel && !hideTaskTitle && (
          <button
            className="fact-card-task min-w-0 truncate text-[12px] text-ink-3 transition-colors duration-100 hover:text-ink hover:underline"
            onClick={() => onOpenTask(message.taskId)}
            type="button"
          >
            {channel.title}
          </button>
        )}
        {originVisible && originEventId && (
          <button
            aria-label="回到发起消息"
            className="fact-card-origin ml-auto flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink"
            onClick={() => onJumpToMessage(originEventId)}
            title="回到发起消息"
            type="button"
          >
            <ArrowUpToLine size={14} />
          </button>
        )}
      </div>
      <div className="fact-card-body mt-2 grid min-w-0 justify-items-start gap-1 text-[13px] leading-[1.6] text-ink-2">
        <MarkdownMessage content={expanded ? message.text : collapsedBody} />
        {message.text.length > 520 && (
          <button
            className="mt-2 inline-flex items-center gap-[5px] font-medium text-accent-ink"
            onClick={onToggleExpanded}
            type="button"
          >
            {expanded ? '收起' : '展开完整内容'}
          </button>
        )}
      </div>
      {message.lane === 'decide' && !message.resolved && (
        <div className="fact-card-actions mt-2.5 flex gap-2">
          <Button
            size="sm"
            variant="accent"
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
          >
            {decideLabel} <ArrowRight size={15} />
          </Button>
        </div>
      )}
      {channel?.workflow?.resultMessageId === message.id && onExplainResult && (
        <Button
          className="mt-2"
          onClick={onExplainResult}
          size="sm"
          type="button"
          variant="quiet"
        >
          解释这次结果
        </Button>
      )}
    </section>
  )
}

function messageTarget(
  target: ComposerTarget | undefined,
): MessageTarget | undefined {
  if (!target) return undefined
  if (target.kind === 'reply')
    return {
      replyToMessageId: target.id,
      ...(target.explain ? { intent: 'explain' as const } : {}),
    }
  return target.kind === 'task'
    ? { taskId: target.channel.id }
    : { sourceTaskId: target.channel.id }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

function RunStatusBar({
  channel,
  run,
  messages,
  api,
  onOpen,
}: {
  channel: WorkChannel
  run: NonNullable<ReturnType<typeof latestRunForTask>>
  messages: readonly OutboxMessage[]
  api: PegasApi
  onOpen: () => void
}) {
  const active = run.status === 'running' || run.status === 'queued'
  const progressText = latestRunProgressText(messages, run.id)
  const duration = formatRunDuration(run)
  const headline = channel.workflow
    ? statusLabel(channel)
    : active
      ? statusLabel(channel, run)
      : run.status === 'completed'
        ? '已完成'
        : run.status === 'failed'
          ? '执行失败'
          : run.status === 'cancelled'
            ? '已停止'
            : '等待中'
  const tone: FactTone = statusTone(headline)
  const detail = active
    ? undefined
    : run.status === 'completed' && duration
      ? `工作了 ${duration}`
      : run.status === 'failed'
        ? (run.lastError ?? '可以重试或补充说明后继续')
        : `${(run.output ?? channel.goal).slice(0, 160)}${(run.output ?? channel.goal).length > 160 ? '…' : ''}`
  const summary = `${headline} · ${channel.title}${
    detail ? ` ${detail}` : progressText ? ` ${progressText}` : ''
  }`
  return (
    <section
      className="bui run-status-card mt-3.5 w-full rounded-card bg-surface p-3.5 shadow-card"
      data-active={active || undefined}
    >
      <button
        aria-label={summary}
        className="run-status-bar flex w-full items-center gap-2.5 text-left"
        onClick={onOpen}
        type="button"
      >
        {run.status === 'running' ? (
          <PegasMascot pose="working" size={30} />
        ) : (
          <StatusPill tone={tone}>{headline}</StatusPill>
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
          {channel.title}
        </span>
        <ArrowRight
          className="shrink-0 text-ink-3 transition-transform duration-150"
          size={16}
        />
      </button>
      {detail && (
        <p className="mt-1.5 truncate text-[12.5px] text-ink-2">{detail}</p>
      )}
      {active && (
        <RunTrace
          active={active}
          api={api}
          onOpen={onOpen}
          {...(progressText ? { progressText } : {})}
          runId={run.id}
        />
      )}
    </section>
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
  const [sort, setSort] = useState<ChannelSearchSort>('updated')
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const sortTriggerRef = useRef<HTMLButtonElement>(null)
  const sortMenuRef = useRef<HTMLDivElement>(null)
  const sortMenuId = useId()
  useEffect(() => {
    if (!sortMenuOpen) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (
        sortMenuRef.current?.contains(target) ||
        sortTriggerRef.current?.contains(target)
      )
        return
      setSortMenuOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setSortMenuOpen(false)
      sortTriggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [sortMenuOpen])
  const visible = sortWorkChannels(snapshot.channels, sort).filter(channel => {
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
        hasPageSearch
        title="所有事情"
      >
        <label className="page-search bui flex h-10 min-w-[280px] items-center gap-2 rounded-control bg-field px-3 shadow-hairline transition-shadow duration-150 focus-within:bg-surface focus-within:shadow-[0_0_0_1px_var(--accent)]">
          <Search className="shrink-0 text-ink-3" size={16} />
          <input
            aria-label="搜索事情"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索事情或结果"
            type="search"
            value={query}
          />
        </label>
      </PageHeader>
      <div className="filter-row-wrap relative" ref={sortMenuRef}>
        <div
          className="filter-row flex items-center gap-2 border-b border-line pb-4"
          role="group"
          aria-label="筛选"
        >
          {(
            [
              ['all', '全部'],
              ['active', '进行中'],
              ['waiting', '等待中'],
              ['completed', '已完成'],
              ['archived', '已归档'],
            ] as const
          ).map(([id, label]) => (
            <Button
              aria-pressed={filter === id}
              className="h-9 rounded-full px-4 text-[13px] aria-pressed:bg-accent-tint aria-pressed:text-accent-ink"
              key={id}
              onClick={() => setFilter(id)}
              size="xs"
              type="button"
              variant="secondary"
            >
              {label}
            </Button>
          ))}
          <Button
            aria-controls={sortMenuId}
            aria-expanded={sortMenuOpen}
            aria-haspopup="menu"
            aria-label={`排序：${WORK_SORT_LABELS[sort]}`}
            className="sort-button ml-auto h-9 rounded-full px-4 text-[13px]"
            onClick={() => setSortMenuOpen(current => !current)}
            ref={sortTriggerRef}
            size="xs"
            type="button"
            variant="secondary"
          >
            {WORK_SORT_LABELS[sort]} <ChevronDown size={15} />
          </Button>
        </div>
        {sortMenuOpen && (
          <div
            aria-label="排序方式"
            className="sort-menu bui absolute right-0 top-[calc(100%+6px)] z-20 min-w-[160px] rounded-card bg-surface p-1 shadow-overlay"
            id={sortMenuId}
            role="menu"
            style={{
              animation: 'pop-in 150ms cubic-bezier(0.16,1,0.3,1) both',
            }}
          >
            <GlideMenu className="flex flex-col">
              {(
                [
                  'updated',
                  'created',
                  'ended',
                ] as const satisfies readonly ChannelSearchSort[]
              ).map(option => (
                <button
                  aria-checked={sort === option}
                  className="relative z-10 flex min-h-[34px] items-center justify-between gap-2 rounded-control px-2.5 py-2 text-left text-[13px] text-ink aria-checked:text-accent-ink"
                  data-menu-row
                  key={option}
                  onClick={() => {
                    setSort(option)
                    setSortMenuOpen(false)
                    sortTriggerRef.current?.focus()
                  }}
                  role="menuitemradio"
                  type="button"
                >
                  {WORK_SORT_LABELS[option]}
                  {sort === option && <Check size={15} />}
                </button>
              ))}
            </GlideMenu>
          </div>
        )}
      </div>
      <section className="work-list mb-10" aria-label="事情列表">
        {visible.length ? (
          visible.map(channel => {
            const run = latestRunForTask(snapshot.runs, channel.id)
            const state = statusLabel(channel, run)
            return (
              <button
                className="grid w-full min-h-[78px] grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-line px-3 py-3 text-left transition-colors duration-100 hover:bg-hover min-[521px]:gap-4 min-[521px]:grid-cols-[42px_minmax(160px,1fr)_100px_80px] min-[1121px]:grid-cols-[42px_minmax(180px,1fr)_130px_90px]"
                key={channel.id}
                onClick={() =>
                  actions.onOpenDrawer({ kind: 'task', channel, run })
                }
                type="button"
              >
                <span className="work-icon flex size-[38px] items-center justify-center">
                  <PegasAgentIcon iconId={channel.workerIconId} size={38} />
                </span>
                <span className="work-copy grid min-w-0 gap-[5px]">
                  <strong className="truncate text-[14px] font-medium text-ink">
                    {channel.title}
                  </strong>
                  <small className="truncate text-[12px] text-ink-2">
                    {channel.goal}
                  </small>
                  <small className="work-context truncate text-[11px] text-ink-3">
                    {run
                      ? [run.executor, run.executionContext?.model]
                          .filter(Boolean)
                          .join(' · ')
                      : '尚未分配执行器'}
                  </small>
                </span>
                <time className="hidden text-[12px] text-ink-3 min-[521px]:block">
                  {formatRelativeTime(channel.latestActivityAt)}
                </time>
                <RowStatusPill label={state} />
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
  onOpenTask,
  onRetry,
}: {
  message: {
    id: string
    status: Snapshot['events'][number]['status']
    derivedIds: string[]
  }
  snapshot: Snapshot
  retrying: boolean
  onOpenTask: (taskId: string | undefined) => void
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
          className="message-status-icon is-failed inline-flex h-[22px] w-5 items-center justify-center text-red-text"
          role="img"
          title="发送失败"
        >
          <CircleAlert size={14} />
        </span>
        <Button
          className="h-[22px] px-1.5 text-[12px]"
          disabled={retrying}
          onClick={onRetry}
          size="xs"
          variant="quiet"
        >
          <RotateCw size={14} />
          {retrying ? '重试中…' : '重试'}
        </Button>
      </span>
    )
  }
  if (message.status === 'pending' || message.status === 'processing') {
    const label = deliveryStatusLabel(message.status)
    return (
      <span className="message-status">
        <span
          aria-label={label}
          className={`message-status-icon inline-flex h-[22px] w-5 items-center justify-center text-ink-3${
            message.status === 'processing' ? ' is-processing' : ''
          }`}
          role="img"
          title={label}
        >
          {message.status === 'processing' ? (
            <LoaderCircle
              size={14}
              style={{ animation: 'spin 900ms linear infinite' }}
            />
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
    const fact = snapshot.messages.find(item => item.id === targetId)
    return (
      <span className="message-status">
        <MetaIconButton
          accent
          className="message-derived-trigger"
          label="查看工作详情"
          onClick={() => onOpenTask(fact?.taskId)}
          title="查看工作详情"
        >
          <Link2 size={14} />
        </MetaIconButton>
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
      taskId: fact.taskId,
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
        aria-label={`查看工作详情：${String(message.derivedIds.length)} 个事情`}
        className="message-derived-trigger inline-flex h-[22px] items-center justify-center gap-[3px] rounded-[7px] px-1 text-accent-ink transition-colors duration-100 hover:bg-accent-tint"
        onClick={() => setMenuOpen(current => !current)}
        ref={triggerRef}
        title={`查看工作详情 · ${String(message.derivedIds.length)} 个事情`}
        type="button"
      >
        <Link2 size={14} />
        <span className="message-derived-count text-[11px] font-medium leading-none">
          {message.derivedIds.length}
        </span>
      </button>
      {menuOpen && (
        <div
          aria-label="这条消息派生的事情"
          className="message-derived-menu bui absolute right-0 top-[calc(100%+6px)] z-20 flex min-w-[250px] flex-col rounded-card bg-surface p-1 shadow-overlay"
          style={{ animation: 'pop-in 150ms cubic-bezier(0.16,1,0.3,1) both' }}
          id={menuId}
          ref={menuRef}
          role="menu"
        >
          {entries.map(entry => (
            <button
              key={entry.id}
              className="flex items-center justify-between gap-2 rounded-control px-2.5 py-2 text-left text-[13px] text-ink transition-colors duration-100 hover:bg-hover-2"
              onClick={() => {
                setMenuOpen(false)
                onOpenTask(entry.taskId)
              }}
              role="menuitem"
              type="button"
            >
              <span className="derived-task-name inline-flex min-w-0 items-center gap-[7px]">
                <FileText size={14} />
                <span className="truncate">{entry.title}</span>
              </span>
              <RowStatusPill label={entry.label} />
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
  if (routingClarification(message))
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

const attentionIconTones: Record<string, string> = {
  result: 'bg-green-tint text-green-text',
  failed: 'bg-red-tint text-red-text',
  approval: 'bg-accent-tint text-accent-ink',
  confirm: 'bg-orange-tint text-orange-text',
  answer: 'bg-accent-tint text-accent-ink',
  review: 'bg-green-tint text-green-text',
  reconcile: 'bg-inset text-ink-2',
}

const attentionKindTones: Record<string, string> = {
  confirm: 'text-orange-text',
  answer: 'text-accent-ink',
  review: 'text-green-text',
  reconcile: 'text-ink-2',
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
  const board = attentionBoard(snapshot.messages, snapshot.channels)
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
          className={`grid min-h-[88px] grid-cols-[32px_minmax(0,1fr)] items-start gap-3 border-b border-line px-2.5 py-4 transition-colors duration-100 hover:bg-hover min-[521px]:grid-cols-[32px_minmax(0,1fr)_auto] ${message.readAt ? 'is-read' : 'is-unread'}`}
        >
          <span
            className={`attention-icon is-${actionKind} mt-0.5 flex size-8 items-center justify-center rounded-card ${attentionIconTones[actionKind] ?? 'bg-orange-tint text-orange-text'}`}
          >
            <TodoIcon size={18} />
          </span>
          <div className="attention-copy grid min-w-0 gap-1.5">
            <div className="attention-heading flex min-w-0 items-baseline gap-2.5">
              <span
                className={`attention-kind is-${actionKind} shrink-0 text-[12px] font-medium leading-[1.4] ${attentionKindTones[actionKind] ?? 'text-orange-text'}`}
              >
                {attentionTodoLabel(actionKind)}
              </span>
              <h2 className="m-0 min-w-0 text-[14px] font-medium">
                <button
                  className="attention-title line-clamp-2 min-h-0 cursor-pointer p-0 text-left text-[14px] font-medium leading-[1.45] text-ink [overflow-wrap:anywhere] transition-colors duration-100 hover:text-accent-ink"
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
              <p className="attention-preview line-clamp-1 m-0 text-[13px] leading-normal text-ink-2 [overflow-wrap:anywhere]">
                {summary.preview}
              </p>
            )}
            <div className="attention-meta flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] leading-[1.4] text-ink-2">
              <span
                className={`attention-read-state inline-flex items-center gap-1.5 ${message.readAt ? '' : 'font-medium text-ink'}`}
              >
                {!message.readAt && (
                  <span className="size-1.5 rounded-full bg-accent" />
                )}
                {message.readAt ? '已读' : '未读'}
              </span>
              <span>来自：{source}</span>
              <time dateTime={message.createdAt}>
                {formatRelativeTime(message.createdAt)}
              </time>
              {deliveryNote && (
                <span className="attention-delivery-note text-orange-text">
                  {deliveryNote}
                </span>
              )}
            </div>
          </div>
          <Button
            aria-label={`${action.label}：${summary.title}`}
            className="attention-action col-start-2 h-9 justify-self-end rounded-control px-3 text-[13px] min-[521px]:col-start-3 min-[521px]:self-center"
            onClick={() => {
              void onOpen(message)
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            <Icon size={15} />
            {action.label}
          </Button>
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
    const timeline = group.messages
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
            'grid min-h-[88px] grid-cols-[32px_minmax(0,1fr)] items-start gap-3 border-b border-line px-2.5 py-4 transition-colors duration-100 hover:bg-hover min-[521px]:grid-cols-[32px_minmax(0,1fr)_auto]',
            group.unreadCount > 0 ? 'is-unread' : 'is-read',
            isExpanded ? 'is-expanded' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span
            className={`attention-icon mt-0.5 flex size-8 items-center justify-center rounded-card ${isFailed ? 'is-failed bg-red-tint text-red-text' : 'is-result bg-green-tint text-green-text'}`}
          >
            {isFailed ? <CircleAlert size={18} /> : <CheckCircle2 size={18} />}
          </span>
          <div className="attention-copy grid min-w-0 gap-1.5">
            <div className="attention-heading flex min-w-0 items-baseline gap-2.5">
              <h2 className="m-0 min-w-0 text-[14px] font-medium">
                <button
                  aria-expanded={isExpanded}
                  className="attention-title line-clamp-2 min-h-0 cursor-pointer p-0 text-left text-[14px] font-medium leading-[1.45] text-ink [overflow-wrap:anywhere] transition-colors duration-100 hover:text-accent-ink"
                  id={titleId}
                  onClick={() => toggleExpanded(group.key)}
                  type="button"
                >
                  {groupTitle}
                </button>
              </h2>
            </div>
            <p className="attention-preview line-clamp-1 m-0 text-[13px] leading-normal text-ink-2 [overflow-wrap:anywhere]">
              <button
                className="attention-latest block w-full cursor-pointer p-0 text-left text-[13px] leading-normal text-ink-2 transition-colors duration-100 hover:text-accent-ink hover:underline"
                onClick={() => {
                  void onOpen(group.latest)
                }}
                type="button"
              >
                最新：{latestSummary.title}
              </button>
            </p>
            <div className="attention-meta flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] leading-[1.4] text-ink-2">
              {group.taskId && <span>来自：{source}</span>}
              <time dateTime={group.latest.createdAt}>
                {formatRelativeTime(group.latest.createdAt)}
              </time>
              {group.unreadCount === 0 && <span>已读</span>}
              {attentionDeliveryNote(group.latest) && (
                <span className="attention-delivery-note text-orange-text">
                  {attentionDeliveryNote(group.latest)}
                </span>
              )}
            </div>
            {isExpanded && (
              <div className="attention-group-timeline mt-1.5 border-t border-line pt-1.5">
                <ul className="m-0 list-none p-0" role="list">
                  {visibleTimeline.map(message => {
                    const summary = attentionSummary(message)
                    return (
                      <li key={message.id}>
                        <button
                          className="attention-group-entry flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-control px-2 py-1 text-left text-ink-2 transition-colors duration-100 hover:bg-inset hover:text-ink"
                          onClick={() => {
                            void onOpen(message)
                          }}
                          type="button"
                        >
                          <span
                            className={`attention-group-entry-dot size-1.5 shrink-0 rounded-full ${message.readAt ? 'bg-line-strong' : 'is-unread bg-accent'}`}
                          />
                          <span className="attention-group-entry-title line-clamp-1 min-w-0 flex-1 text-[13px] leading-normal [overflow-wrap:anywhere]">
                            {summary.title}
                          </span>
                          <time
                            className="shrink-0 text-[12px] text-ink-2"
                            dateTime={message.createdAt}
                          >
                            {formatRelativeTime(message.createdAt)}
                          </time>
                        </button>
                      </li>
                    )
                  })}
                </ul>
                {(expandedAll || timeline.length > 3) && (
                  <Button
                    className="attention-group-more mx-auto mt-1 flex h-8 px-3 text-[12px] text-accent-ink"
                    onClick={() => toggleShowAll(group.key)}
                    size="xs"
                    type="button"
                    variant="quiet"
                  >
                    {expandedAll
                      ? '收起更早通知'
                      : `查看全部 ${String(group.messages.length)} 条`}
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="attention-group-side col-start-2 flex flex-wrap items-center justify-end gap-2 min-[521px]:col-start-3 min-[521px]:flex-nowrap min-[521px]:self-center">
            <StatusPill
              className={`attention-count h-auto px-2.5 py-[3px] text-[12px] font-normal leading-[1.4] whitespace-nowrap${isFailed ? ' is-failed' : ''}${group.unreadCount > 0 ? ' is-unread font-medium text-ink' : ''}`}
              dot={false}
              tone={isFailed ? 'red' : 'neutral'}
            >
              {unreadLabel}
            </StatusPill>
            <Button
              aria-label={`${isExpanded ? '收起' : '展开'}：${groupTitle}`}
              aria-expanded={isExpanded}
              className="attention-toggle size-8 rounded-control p-0 text-ink-2"
              onClick={() => toggleExpanded(group.key)}
              size="xs"
              type="button"
              variant="quiet"
            >
              {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </Button>
            <Button
              aria-label={`${action.label}：${groupTitle}`}
              className="attention-action h-9 rounded-control px-3 text-[13px]"
              onClick={() => {
                void onOpen(group.latest)
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              <ActionIcon size={15} />
              {action.label}
            </Button>
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
        hasPageSearch
        title="待你处理"
      >
        <label className="page-search bui flex h-10 min-w-[280px] items-center gap-2 rounded-control bg-field px-3 shadow-hairline transition-shadow duration-150 focus-within:bg-surface focus-within:shadow-[0_0_0_1px_var(--accent)]">
          <Search className="shrink-0 text-ink-3" size={16} />
          <input
            aria-label="搜索待处理内容"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
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
        className="filter-row attention-filters flex items-center gap-2 overflow-x-auto border-b border-line pb-4"
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
          <Button
            aria-pressed={filter === id}
            className="h-9 shrink-0 rounded-full px-4 text-[13px] aria-pressed:bg-accent-tint aria-pressed:text-accent-ink"
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
            size="xs"
            type="button"
            variant="secondary"
          >
            {label} {counts[id]}
          </Button>
        ))}
      </div>
      <section className="attention-list mb-10" aria-label="待处理列表">
        {hasVisible ? (
          <>
            {(filter === 'all' || filter === 'todo') &&
              visibleTodo.length > 0 && (
                <div className="attention-section mt-6 first:mt-0">
                  <h3 className="attention-section-title mb-1 flex items-baseline gap-2.5 text-[14px] font-medium text-ink">
                    待你处理
                    <small className="text-[12px] font-normal text-ink-3">
                      需要你确认、回答、验收或核对
                    </small>
                  </h3>
                  <ul className="attention-items m-0 list-none p-0" role="list">
                    {visibleTodo.map(renderTodoRow)}
                  </ul>
                </div>
              )}
            {(filter === 'all' || filter === 'failed') &&
              visibleFailed.length > 0 && (
                <div className="attention-section mt-6 first:mt-0">
                  <h3 className="attention-section-title mb-1 flex items-baseline gap-2.5 text-[14px] font-medium text-ink">
                    失败
                    <small className="text-[12px] font-normal text-ink-3">
                      同一事情的失败已合并
                    </small>
                  </h3>
                  <ul className="attention-items m-0 list-none p-0" role="list">
                    {visibleFailed.map(renderGroupRow)}
                  </ul>
                </div>
              )}
            {(filter === 'all' || filter === 'activity') &&
              visibleActivity.length > 0 && (
                <div className="attention-section mt-6 first:mt-0">
                  <h3 className="attention-section-title mb-1 flex items-baseline gap-2.5 text-[14px] font-medium text-ink">
                    事情动态
                    <small className="text-[12px] font-normal text-ink-3">
                      同一事情的通知已合并，最新在上
                    </small>
                  </h3>
                  <ul className="attention-items m-0 list-none p-0" role="list">
                    {activityPage.groups.map(renderGroupRow)}
                  </ul>
                  {activityPage.pageCount > 1 && (
                    <nav
                      aria-label="事情动态分页"
                      className="pagination attention-pagination mt-0 flex items-center gap-2 border-t border-line pt-3"
                    >
                      <span className="flex-1 text-[11px] text-ink-2">
                        第 {activityPage.rangeStart}–{activityPage.rangeEnd}{' '}
                        件事情，共 {visibleActivity.length} 件
                      </span>
                      <Button
                        className="h-[30px] rounded-control px-3 text-[13px]"
                        disabled={activityPage.page <= 1}
                        onClick={() => setPage(activityPage.page - 1)}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        上一页
                      </Button>
                      {Array.from(
                        { length: activityPage.pageCount },
                        (_, index) => index + 1,
                      ).map(candidate => (
                        <Button
                          aria-current={
                            candidate === activityPage.page ? 'page' : undefined
                          }
                          className="h-[30px] min-w-[30px] rounded-control px-2 text-[13px] aria-[current=page]:text-accent-ink aria-[current=page]:shadow-[0_0_0_1px_var(--accent)]"
                          key={candidate}
                          onClick={() => setPage(candidate)}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          {candidate}
                        </Button>
                      ))}
                      <Button
                        className="h-[30px] rounded-control px-3 text-[13px]"
                        disabled={activityPage.page >= activityPage.pageCount}
                        onClick={() => setPage(activityPage.page + 1)}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        下一页
                      </Button>
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
  onDelete,
  onLoadInvocations,
  onOpenChannel,
  onReload,
  onSetStatus,
  onUpdate,
}: {
  actions: PageActions
  automations?: Automation[]
  channels: WorkChannel[]
  error: string
  onCreate: (draft: AutomationDraft) => Promise<void>
  onDelete?: (automation: Automation) => Promise<void>
  onLoadInvocations?: (
    automation: Automation,
    cursor?: string,
  ) => Promise<{ invocations: AutomationInvocation[]; nextCursor?: string }>
  onOpenChannel?: (channel: WorkChannel) => void
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
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>()
  const [actionError, setActionError] = useState('')
  const [historyId, setHistoryId] = useState<string>()
  const [invocations, setInvocations] = useState<AutomationInvocation[]>()
  const [historyCursor, setHistoryCursor] = useState<string>()
  const [historyError, setHistoryError] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false)
  const [historyMoreError, setHistoryMoreError] = useState('')
  const [promptId, setPromptId] = useState<string>()
  const [showEnded, setShowEnded] = useState(false)
  const historyRequestRef = useRef(0)
  async function toggleHistory(automation: Automation) {
    if (!onLoadInvocations) return
    if (historyId === automation.id) {
      historyRequestRef.current += 1
      setHistoryId(undefined)
      setInvocations(undefined)
      setHistoryCursor(undefined)
      setHistoryError('')
      setHistoryLoading(false)
      setHistoryLoadingMore(false)
      setHistoryMoreError('')
      return
    }
    const requestId = historyRequestRef.current + 1
    historyRequestRef.current = requestId
    setHistoryId(automation.id)
    setInvocations(undefined)
    setHistoryCursor(undefined)
    setHistoryError('')
    setHistoryLoading(true)
    setHistoryLoadingMore(false)
    setHistoryMoreError('')
    try {
      const next = await onLoadInvocations(automation)
      if (requestId !== historyRequestRef.current) return
      setInvocations(next.invocations)
      setHistoryCursor(next.nextCursor)
    } catch (caught) {
      if (requestId !== historyRequestRef.current) return
      setHistoryError(
        caught instanceof Error ? caught.message : '读取触发记录失败，请重试。',
      )
    } finally {
      if (requestId === historyRequestRef.current) setHistoryLoading(false)
    }
  }
  async function loadMoreHistory(automation: Automation) {
    if (!onLoadInvocations || !historyCursor || historyLoadingMore) return
    const requestId = historyRequestRef.current
    setHistoryLoadingMore(true)
    setHistoryMoreError('')
    try {
      const next = await onLoadInvocations(automation, historyCursor)
      if (requestId !== historyRequestRef.current) return
      setInvocations(current => [...(current ?? []), ...next.invocations])
      setHistoryCursor(next.nextCursor)
    } catch (caught) {
      if (requestId !== historyRequestRef.current) return
      setHistoryMoreError(
        caught instanceof Error ? caught.message : '加载更多失败，请重试。',
      )
    } finally {
      if (requestId === historyRequestRef.current) setHistoryLoadingMore(false)
    }
  }
  async function runDelete(automation: Automation) {
    if (!onDelete) return
    setBusyId(automation.id)
    setActionError('')
    try {
      await onDelete(automation)
      setConfirmDeleteId(undefined)
      if (historyId === automation.id) {
        historyRequestRef.current += 1
        setHistoryId(undefined)
        setInvocations(undefined)
        setHistoryCursor(undefined)
      }
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : '删除失败，请重试。',
      )
    } finally {
      setBusyId('')
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
        <Button
          className="page-header-action h-9 px-4 text-[13px]"
          onClick={() => setForm({ mode: 'create' })}
          size="sm"
          type="button"
          variant="primary"
        >
          <Plus size={16} />
          新建自动化
        </Button>
      </PageHeader>
      <div className="metric-strip mb-9 flex overflow-x-auto rounded-card border border-line p-4">
        <span className="flex shrink-0 items-center gap-2 border-r border-line px-4 text-green-text first:pl-0 sm:px-8">
          <Check size={17} />
          已启用 <b>{activeCount}</b>
        </span>
        <span className="flex shrink-0 items-center gap-2 border-r border-line px-4 text-orange-text sm:px-8">
          <PauseCircle size={17} />
          已暂停 <b>{pausedCount}</b>
        </span>
        <span className="flex shrink-0 items-center gap-2 px-4 text-ink-2 sm:px-8">
          <CircleAlert size={17} />
          已结束 <b>{endedCount}</b>
        </span>
      </div>
      {error && (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card border border-red bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text"
          role="alert"
        >
          {error}
          <button
            className="mt-0 inline-flex items-center gap-[5px] font-medium text-inherit"
            onClick={onReload}
            type="button"
          >
            重试
          </button>
        </div>
      )}
      {actionError && (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card border border-red bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text"
          role="alert"
        >
          {actionError}
        </div>
      )}
      {!automations && !error && (
        <p className="my-6 text-ink-2">正在读取自动化…</p>
      )}
      {automations?.length === 0 && !error && (
        <EmptyCapability
          icon={Zap}
          title="还没有自动化"
          description="创建一个定时或周期意图，Pegas 会到点自动开始并留下记录。"
        />
      )}
      {automations && automations.length > 0 && (
        <div className="automation-lists mb-10 [&_.record-list]:mb-0">
          <section className="record-list mb-10" aria-label="自动化列表">
            {sortLiveAutomations(
              hasLiveAutomations(automations)
                ? automations.filter(item => !isEndedAutomation(item))
                : automations,
            ).map(automation => (
              <AutomationRow
                automation={automation}
                busyId={busyId}
                channels={channels}
                confirmCancelId={confirmCancelId}
                confirmDeleteId={confirmDeleteId}
                historyError={historyError}
                historyId={historyId}
                historyLoading={historyLoading}
                historyLoadingMore={historyLoadingMore}
                historyMoreError={historyMoreError}
                historyCursor={historyCursor}
                invocations={invocations}
                onCancelConfirm={() => setConfirmCancelId(undefined)}
                onCancelDelete={() => setConfirmDeleteId(undefined)}
                onConfirmCancel={() => setConfirmCancelId(automation.id)}
                onConfirmDelete={() => setConfirmDeleteId(automation.id)}
                onDelete={onDelete ? () => runDelete(automation) : undefined}
                onEdit={() => setForm({ mode: 'edit', automation })}
                onLoadMoreHistory={loadMoreHistory}
                onOpenChannel={onOpenChannel}
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
            <section
              className="automation-ended mt-3"
              aria-label="已结束的自动化"
            >
              <Button
                aria-expanded={showEnded}
                className="automation-ended-toggle mb-1 ml-2.5 h-8 px-3 text-[13px] text-ink-2"
                onClick={() => setShowEnded(current => !current)}
                size="xs"
                type="button"
                variant="quiet"
              >
                <ChevronDown
                  className={`transition-transform duration-150 ${showEnded ? 'rotate-180' : ''}`}
                  size={15}
                />
                已结束 {endedCount}
              </Button>
              {showEnded && (
                <div className="record-list">
                  {sortEndedAutomations(
                    automations.filter(isEndedAutomation),
                  ).map(automation => (
                    <AutomationRow
                      automation={automation}
                      busyId={busyId}
                      channels={channels}
                      confirmCancelId={confirmCancelId}
                      confirmDeleteId={confirmDeleteId}
                      historyError={historyError}
                      historyId={historyId}
                      historyLoading={historyLoading}
                      historyLoadingMore={historyLoadingMore}
                      historyMoreError={historyMoreError}
                      historyCursor={historyCursor}
                      invocations={invocations}
                      onCancelConfirm={() => setConfirmCancelId(undefined)}
                      onCancelDelete={() => setConfirmDeleteId(undefined)}
                      onConfirmCancel={() => setConfirmCancelId(automation.id)}
                      onConfirmDelete={() => setConfirmDeleteId(automation.id)}
                      onDelete={
                        onDelete ? () => runDelete(automation) : undefined
                      }
                      onEdit={() => setForm({ mode: 'edit', automation })}
                      onLoadMoreHistory={loadMoreHistory}
                      onOpenChannel={onOpenChannel}
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

function sortLiveAutomations(automations: Automation[]): Automation[] {
  return [...automations].sort((left, right) => {
    const statusOrder =
      Number(left.status !== 'active') - Number(right.status !== 'active')
    if (statusOrder !== 0) return statusOrder
    const leftFire = left.nextFireAt ? Date.parse(left.nextFireAt) : Infinity
    const rightFire = right.nextFireAt ? Date.parse(right.nextFireAt) : Infinity
    if (leftFire !== rightFire) return leftFire - rightFire
    return left.title.localeCompare(right.title)
  })
}

function sortEndedAutomations(automations: Automation[]): Automation[] {
  return [...automations].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  )
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
  confirmDeleteId,
  historyError,
  historyId,
  historyLoading,
  historyLoadingMore,
  historyMoreError,
  historyCursor,
  invocations,
  onCancelConfirm,
  onCancelDelete,
  onConfirmCancel,
  onConfirmDelete,
  onDelete,
  onEdit,
  onLoadMoreHistory,
  onOpenChannel,
  onRunStatus,
  onToggleHistory,
  onTogglePrompt,
  promptOpen,
}: {
  automation: Automation
  busyId: string
  channels: WorkChannel[]
  confirmCancelId?: string
  confirmDeleteId?: string
  historyError: string
  historyId?: string
  historyLoading: boolean
  historyLoadingMore: boolean
  historyMoreError: string
  historyCursor?: string
  invocations?: AutomationInvocation[]
  onCancelConfirm: () => void
  onCancelDelete: () => void
  onConfirmCancel: () => void
  onConfirmDelete: () => void
  onDelete?: () => Promise<void>
  onEdit: () => void
  onLoadMoreHistory: (automation: Automation) => Promise<void>
  onOpenChannel?: (channel: WorkChannel) => void
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
    <article
      key={automation.id}
      className="grid grid-cols-[34px_minmax(0,1fr)] items-start gap-3.5 border-b border-line px-2.5 py-4 min-[821px]:grid-cols-[40px_minmax(0,1fr)_auto]"
    >
      <span
        className={`record-icon is-${automation.status} flex size-[38px] items-center justify-center rounded-full ${
          automation.status === 'active'
            ? 'bg-accent-tint text-accent-ink'
            : automation.status === 'paused'
              ? 'bg-orange-tint text-orange-text'
              : 'bg-inset text-ink-2'
        }`}
      >
        <Zap size={18} />
      </span>
      <div className="record-copy grid min-w-0 gap-[5px]">
        <div className="record-title flex items-baseline justify-between gap-3">
          <strong className="text-[14px] [overflow-wrap:anywhere]">
            {automation.title}
          </strong>
          <span className="status-text shrink-0">
            <RowStatusPill label={automationStatusLabel(automation.status)} />
          </span>
        </div>
        <p className="automation-summary line-clamp-1 m-0 text-[13px] text-ink-2 [overflow-wrap:anywhere]">
          {automationPromptSummary(automation.prompt)}
        </p>
        <small className="record-meta text-[12px] text-ink-2 [overflow-wrap:anywhere]">
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
          <pre
            className="automation-prompt mt-1 max-h-[320px] overflow-auto rounded-card bg-inset px-3.5 py-3 font-sans text-[13px] leading-[1.65] whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]"
            id={promptRegionId}
          >
            {automation.prompt}
          </pre>
        )}
      </div>
      <div className="record-actions col-span-full flex flex-wrap items-center justify-start gap-2 min-[821px]:col-start-2 min-[821px]:justify-end">
        <Button
          aria-controls={promptRegionId}
          aria-expanded={promptOpen}
          className="h-8 px-3 text-[13px] text-ink-2"
          onClick={onTogglePrompt}
          size="xs"
          type="button"
          variant="quiet"
        >
          {promptOpen ? '收起指令' : '查看指令'}
        </Button>
        <Button
          aria-expanded={historyId === automation.id}
          className="h-8 px-3 text-[13px] text-ink-2"
          onClick={() => void onToggleHistory(automation)}
          size="xs"
          type="button"
          variant="quiet"
        >
          触发记录
        </Button>
        {(automation.status === 'active' || automation.status === 'paused') && (
          <Button
            className="h-8 px-3.5 text-[13px]"
            disabled={busyId === automation.id}
            onClick={onEdit}
            size="xs"
            type="button"
            variant="secondary"
          >
            编辑
          </Button>
        )}
        {automation.status === 'active' && (
          <Button
            className="h-8 px-3.5 text-[13px]"
            disabled={busyId === automation.id}
            onClick={() => void onRunStatus(automation, 'pause')}
            size="xs"
            type="button"
            variant="secondary"
          >
            暂停
          </Button>
        )}
        {automation.status === 'paused' && (
          <Button
            className="h-8 px-3.5 text-[13px]"
            disabled={busyId === automation.id}
            onClick={() => void onRunStatus(automation, 'resume')}
            size="xs"
            type="button"
            variant="secondary"
          >
            恢复
          </Button>
        )}
        {(automation.status === 'active' || automation.status === 'paused') &&
          (confirmCancelId === automation.id ? (
            <>
              <Button
                className="h-8 px-3.5 text-[13px]"
                disabled={busyId === automation.id}
                onClick={() => void onRunStatus(automation, 'cancel')}
                size="xs"
                type="button"
                variant="danger"
              >
                确认结束
              </Button>
              <Button
                className="h-8 px-3 text-[13px] text-ink-2"
                onClick={onCancelConfirm}
                size="xs"
                type="button"
                variant="quiet"
              >
                保留
              </Button>
            </>
          ) : (
            <Button
              className="h-8 px-3 text-[13px] text-ink-2"
              disabled={busyId === automation.id}
              onClick={onConfirmCancel}
              size="xs"
              type="button"
              variant="quiet"
            >
              结束
            </Button>
          ))}
        {isEndedAutomation(automation) &&
          onDelete &&
          (confirmDeleteId === automation.id ? (
            <>
              <Button
                className="h-8 px-3.5 text-[13px]"
                disabled={busyId === automation.id}
                onClick={() => void onDelete()}
                size="xs"
                type="button"
                variant="danger"
              >
                确认删除
              </Button>
              <Button
                className="h-8 px-3 text-[13px] text-ink-2"
                onClick={onCancelDelete}
                size="xs"
                type="button"
                variant="quiet"
              >
                保留
              </Button>
            </>
          ) : (
            <Button
              className="h-8 px-3 text-[13px] text-ink-2"
              disabled={busyId === automation.id}
              onClick={onConfirmDelete}
              size="xs"
              type="button"
              variant="quiet"
            >
              删除
            </Button>
          ))}
      </div>
      {historyId === automation.id && (
        <div className="record-history col-span-full rounded-card bg-inset px-3.5 py-2.5 text-ink-2 min-[821px]:col-start-2">
          {historyLoading && <small>正在读取触发记录…</small>}
          {historyError && (
            <small
              className="record-history-error flex items-center gap-2 text-red-text"
              role="alert"
            >
              {historyError}
              <button
                className="mt-0 inline-flex items-center gap-[5px] font-medium text-accent-ink"
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
              <>
                <ul
                  className="m-0 grid list-none gap-2 p-0"
                  aria-label="触发记录"
                >
                  {invocations.map(invocation => {
                    const invocationChannel = invocation.taskId
                      ? channels.find(item => item.id === invocation.taskId)
                      : undefined
                    return (
                      <li
                        key={invocation.id}
                        className="flex flex-wrap items-baseline gap-2.5 text-[13px]"
                      >
                        <span
                          className={`invocation-status is-${invocation.status}`}
                        >
                          <RowStatusPill
                            label={invocationStatusLabel(invocation.status)}
                          />
                        </span>
                        <span>
                          计划 {formatDateTime(invocation.scheduledFor)}
                        </span>
                        {invocation.attempts > 1 && (
                          <span>尝试 {invocation.attempts} 次</span>
                        )}
                        {invocation.summary && (
                          <span className="invocation-summary min-w-0 flex-[1_1_160px] truncate text-ink">
                            {invocation.summary}
                          </span>
                        )}
                        {invocation.lastError && (
                          <span className="invocation-error text-red-text [overflow-wrap:anywhere]">
                            {invocation.lastError}
                          </span>
                        )}
                        {invocationChannel && onOpenChannel && (
                          <button
                            className="mt-0 inline-flex items-center gap-[5px] font-medium text-accent-ink"
                            onClick={() => onOpenChannel(invocationChannel)}
                            type="button"
                          >
                            查看事情
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
                {historyMoreError && (
                  <small
                    className="record-history-error mt-2 flex items-center gap-2 text-red-text"
                    role="alert"
                  >
                    {historyMoreError}
                    <button
                      className="mt-0 inline-flex items-center gap-[5px] font-medium text-accent-ink"
                      onClick={() => void onLoadMoreHistory(automation)}
                      type="button"
                    >
                      重试
                    </button>
                  </small>
                )}
                {historyCursor && (
                  <div className="history-more mt-2.5 flex justify-center">
                    <Button
                      className="h-8 px-3 text-[13px] text-ink-2"
                      disabled={historyLoadingMore}
                      onClick={() => void onLoadMoreHistory(automation)}
                      size="xs"
                      type="button"
                      variant="quiet"
                    >
                      {historyLoadingMore ? '正在加载…' : '加载更多'}
                    </Button>
                  </div>
                )}
              </>
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
  derivedMemories,
  derivedMemorySync,
  memories,
  onCreate,
  onDelete,
  onDeleteDerived,
  onCorrectDerived,
  onReload,
  onUpdate,
  truncated,
}: {
  actions: PageActions
  channels: WorkChannel[]
  error: string
  derivedMemories?: DerivedMemoryRecord[]
  derivedMemorySync?: DerivedMemorySyncState | null
  memories?: MemoryRecord[]
  onCreate: (draft: MemoryDraft) => Promise<void>
  onDelete: (memory: MemoryRecord) => Promise<void>
  onDeleteDerived: (memory: DerivedMemoryRecord) => Promise<void>
  onCorrectDerived: (
    memory: DerivedMemoryRecord,
    correction: string,
  ) => Promise<void>
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
  const [correctionMemory, setCorrectionMemory] =
    useState<DerivedMemoryRecord>()
  const [actionError, setActionError] = useState('')
  const visible = (memories ?? []).filter(
    memory => filter === 'all' || memory.scope === filter,
  )
  const visibleDerived =
    filter === 'all' || filter === 'worker' ? (derivedMemories ?? []) : []
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
  async function runDeleteDerived(memory: DerivedMemoryRecord) {
    setBusyId(memory.id)
    setActionError('')
    try {
      await onDeleteDerived(memory)
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
        <Button
          className="page-header-action h-9 px-4 text-[13px]"
          onClick={() => setForm({ mode: 'create' })}
          size="sm"
          type="button"
          variant="primary"
        >
          <Plus size={16} />
          添加记忆
        </Button>
      </PageHeader>
      <div
        className="filter-row flex items-center gap-2 overflow-x-auto border-b border-line pb-4"
        role="group"
        aria-label="筛选"
      >
        {memoryScopes.map(scope => (
          <Button
            aria-pressed={filter === scope.id}
            className="h-9 shrink-0 rounded-full px-4 text-[13px] aria-pressed:bg-accent-tint aria-pressed:text-accent-ink"
            key={scope.id}
            onClick={() => setFilter(scope.id)}
            size="xs"
            type="button"
            variant="secondary"
          >
            {scope.label}
          </Button>
        ))}
      </div>
      {truncated && (
        <p className="text-[12px] leading-[1.6] text-ink-2">
          仅显示最近的一部分记忆；完整列表以服务端为准。
        </p>
      )}
      {error && (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card border border-red bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text"
          role="alert"
        >
          {error}
          <button
            className="mt-0 inline-flex items-center gap-[5px] font-medium text-inherit"
            onClick={onReload}
            type="button"
          >
            重试
          </button>
        </div>
      )}
      {actionError && (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card border border-red bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text"
          role="alert"
        >
          {actionError}
        </div>
      )}
      {derivedMemorySync?.status === 'failed' && (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card border border-line bg-surface px-3.5 py-2.5 text-[13px] text-ink-2"
          role="status"
        >
          自动记忆同步暂时失败，当前展示的是最近一次成功同步的内容。后台会继续重试。
        </div>
      )}
      {(!memories || !derivedMemories) && !error && (
        <p className="my-6 text-ink-2">正在读取记忆…</p>
      )}
      {memories &&
        derivedMemories &&
        visible.length === 0 &&
        visibleDerived.length === 0 &&
        !error && (
          <EmptyCapability
            icon={Layers3}
            title={
              memories.length || derivedMemories.length
                ? '该范围下还没有记忆'
                : '还没有记忆'
            }
            description={
              memories.length || derivedMemories.length
                ? '切换其他范围，或添加一条新的记忆。'
                : 'Pegas 会在事情完成后自动沉淀经验；你也可以手动添加明确偏好。'
            }
          />
        )}
      {memories && visible.length > 0 && (
        <section className="record-list mb-10" aria-label="记忆列表">
          {visible.map(memory => (
            <article
              key={memory.id}
              className="grid grid-cols-[34px_minmax(0,1fr)] items-start gap-3.5 border-b border-line px-2.5 py-4 min-[821px]:grid-cols-[40px_minmax(0,1fr)_auto]"
            >
              <span className="record-icon is-active flex size-[38px] items-center justify-center rounded-full bg-accent-tint text-accent-ink">
                <Layers3 size={18} />
              </span>
              <div className="record-copy grid min-w-0 gap-[5px]">
                <strong className="text-[14px] [overflow-wrap:anywhere]">
                  {memory.content}
                </strong>
                <small className="record-meta text-[12px] text-ink-2 [overflow-wrap:anywhere]">
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
                <small className="record-meta text-[12px] text-ink-2 [overflow-wrap:anywhere]">
                  更新于 {formatRelativeTime(memory.updatedAt)}
                  {memory.lastUsedAt
                    ? ` · 最近使用 ${formatRelativeTime(memory.lastUsedAt)}`
                    : ''}
                </small>
              </div>
              <div className="record-actions col-span-full flex flex-wrap items-center justify-start gap-2 min-[821px]:col-start-2 min-[821px]:justify-end">
                <Button
                  className="h-8 px-3.5 text-[13px]"
                  disabled={busyId === memory.id}
                  onClick={() => setForm({ mode: 'edit', memory })}
                  size="xs"
                  type="button"
                  variant="secondary"
                >
                  编辑
                </Button>
                {confirmDeleteId === memory.id ? (
                  <>
                    <Button
                      className="h-8 px-3.5 text-[13px]"
                      disabled={busyId === memory.id}
                      onClick={() => void runDelete(memory)}
                      size="xs"
                      type="button"
                      variant="danger"
                    >
                      确认删除
                    </Button>
                    <Button
                      className="h-8 px-3 text-[13px] text-ink-2"
                      onClick={() => setConfirmDeleteId(undefined)}
                      size="xs"
                      type="button"
                      variant="quiet"
                    >
                      保留
                    </Button>
                  </>
                ) : (
                  <Button
                    className="h-8 px-3 text-[13px] text-ink-2"
                    disabled={busyId === memory.id}
                    onClick={() => setConfirmDeleteId(memory.id)}
                    size="xs"
                    type="button"
                    variant="quiet"
                  >
                    <Trash2 size={15} />
                    删除
                  </Button>
                )}
              </div>
            </article>
          ))}
        </section>
      )}
      {derivedMemories && visibleDerived.length > 0 && (
        <section className="record-list" aria-label="自动沉淀的记忆">
          {visibleDerived.map(memory => (
            <article key={`derived:${memory.id}`}>
              <span className="record-icon is-active">
                <Zap size={18} />
              </span>
              <div className="record-copy">
                <strong>{memory.text}</strong>
                <small className="record-meta">
                  Worker · 自动沉淀 · {derivedMemoryTypeLabel(memory.type)}
                </small>
                <small className="record-meta">
                  来源：Hindsight
                  {typeof memory.metadata.task_id === 'string'
                    ? ` · 事情 ${memory.metadata.task_id.slice(0, 8)}`
                    : ''}
                </small>
              </div>
              <div className="record-actions">
                <button
                  className="secondary-button"
                  disabled={busyId === memory.id}
                  onClick={() => setCorrectionMemory(memory)}
                  type="button"
                >
                  纠正
                </button>
                {confirmDeleteId === memory.id ? (
                  <>
                    <button
                      className="danger-button"
                      disabled={busyId === memory.id}
                      onClick={() => void runDeleteDerived(memory)}
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
      {correctionMemory && (
        <DerivedMemoryCorrectionForm
          memory={correctionMemory}
          onCancel={() => setCorrectionMemory(undefined)}
          onSubmit={async correction => {
            await onCorrectDerived(correctionMemory, correction)
            setCorrectionMemory(undefined)
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

function derivedMemoryTypeLabel(type: DerivedMemoryRecord['type']): string {
  if (type === 'experience') return '经验'
  if (type === 'observation') return '归纳'
  return '事实'
}

function DerivedMemoryCorrectionForm({
  memory,
  onCancel,
  onSubmit,
}: {
  memory: DerivedMemoryRecord
  onCancel: () => void
  onSubmit: (correction: string) => Promise<void>
}) {
  const [correction, setCorrection] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function submit() {
    if (saving) return
    const next = correction.trim()
    if (!next) {
      setError('请写下正确内容。')
      return
    }
    setSaving(true)
    setError('')
    try {
      await onSubmit(next)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '纠正失败，请重试。')
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open onOpenChange={open => !open && onCancel()}>
      <DialogContent
        aria-label="纠正自动记忆"
        aria-describedby={undefined}
        className="record-form flex max-h-[min(720px,86dvh)] w-[min(560px,calc(100vw-32px))] flex-col p-0"
      >
        <header className="record-form-header flex items-center justify-between border-b border-line px-4.5 py-3.5">
          <DialogTitle>纠正自动记忆</DialogTitle>
        </header>
        <div className="record-form-body overflow-auto px-4.5 py-4">
          {error && (
            <div
              className="mb-4 rounded-card bg-red-tint p-3 text-[13px] text-red-text"
              role="alert"
            >
              {error}
            </div>
          )}
          <p className="my-3 text-[12px] leading-[1.6] text-ink-2">
            原内容：{memory.text}
          </p>
          <FormField className="my-3.5" label="正确内容">
            <TextArea
              maxLength={4_000}
              onChange={event => setCorrection(event.target.value)}
              rows={3}
              value={correction}
            />
          </FormField>
          <p className="my-3 text-[12px] leading-[1.6] text-ink-2">
            旧内容会立即停止注入；新内容由 Worker 在后台沉淀，不需要审批。
          </p>
        </div>
        <footer className="record-form-footer flex items-center justify-end gap-2 border-t border-line px-4.5 py-3">
          <Button variant="quiet" onClick={onCancel} type="button">
            取消
          </Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => void submit()}
            type="button"
          >
            {saving ? '保存中…' : '保存纠正'}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
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
    <Dialog open onOpenChange={open => !open && onCancel()}>
      <DialogContent
        aria-label={draft ? '编辑自动化' : '新建自动化'}
        aria-describedby={undefined}
        className="record-form flex max-h-[min(720px,86dvh)] w-[min(560px,calc(100vw-32px))] flex-col p-0"
      >
        <header className="record-form-header flex items-center justify-between border-b border-line px-4.5 py-3.5">
          <DialogTitle>{draft ? '编辑自动化' : '新建自动化'}</DialogTitle>
        </header>
        <div className="record-form-body overflow-auto px-4.5 py-4">
          {error && (
            <div
              className="mb-4 flex items-center gap-2.5 rounded-card border border-red bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text"
              role="alert"
            >
              {error}
            </div>
          )}
          <FormField className="my-3.5" label="名称">
            <TextInput
              onChange={event => setTitle(event.target.value)}
              value={title}
            />
          </FormField>
          <FormField className="my-3.5" label="意图">
            <TextArea
              onChange={event => setPrompt(event.target.value)}
              rows={3}
              value={prompt}
            />
          </FormField>
          <FormField
            className="my-3.5"
            htmlFor="automation-kind"
            label="触发方式"
          >
            <Select
              onValueChange={value => setKind(value as 'interval' | 'once')}
              value={kind}
            >
              <SelectTrigger
                className="h-9 w-full rounded-control"
                id="automation-kind"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="interval">固定间隔</SelectItem>
                <SelectItem value="once">一次性</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          {kind === 'interval' ? (
            <FormField className="my-3.5" label="间隔（分钟）">
              <TextInput
                min={1}
                onChange={event => setEveryMinutes(event.target.value)}
                type="number"
                value={everyMinutes}
              />
            </FormField>
          ) : (
            <FormField className="my-3.5" label="执行时间">
              <TextInput
                onChange={event => setOnceAt(event.target.value)}
                type="datetime-local"
                value={onceAt}
              />
            </FormField>
          )}
          <FormField
            className="my-3.5"
            htmlFor="automation-target"
            label="目标"
          >
            <Select
              onValueChange={value =>
                setTargetKind(value as 'new_task' | 'existing_task')
              }
              value={targetKind}
            >
              <SelectTrigger
                className="h-9 w-full rounded-control"
                id="automation-target"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new_task">每次创建新事情</SelectItem>
                <SelectItem value="existing_task">续接已有事情</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          {targetKind === 'existing_task' && (
            <FormField
              className="my-3.5"
              htmlFor="automation-task"
              label="事情"
            >
              <Select onValueChange={setTargetTaskId} value={targetTaskId}>
                <SelectTrigger
                  className="h-9 w-full rounded-control"
                  id="automation-task"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {channels.map(channel => (
                    <SelectItem key={channel.id} value={channel.id}>
                      {channel.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
        </div>
        <footer className="record-form-footer flex items-center justify-end gap-2 border-t border-line px-4.5 py-3">
          <Button
            className="h-9 px-4 text-[13px] text-ink-2"
            onClick={onCancel}
            size="sm"
            type="button"
            variant="quiet"
          >
            取消
          </Button>
          <Button
            className="h-9 px-4 text-[13px]"
            disabled={saving}
            onClick={() => void submit()}
            size="sm"
            type="button"
            variant="primary"
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
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
    <Dialog open onOpenChange={open => !open && onCancel()}>
      <DialogContent
        aria-label={draft ? '编辑记忆' : '添加记忆'}
        aria-describedby={undefined}
        className="record-form flex max-h-[min(720px,86dvh)] w-[min(560px,calc(100vw-32px))] flex-col p-0"
      >
        <header className="record-form-header flex items-center justify-between border-b border-line px-4.5 py-3.5">
          <DialogTitle>{draft ? '编辑记忆' : '添加记忆'}</DialogTitle>
        </header>
        <div className="record-form-body overflow-auto px-4.5 py-4">
          {error && (
            <div
              className="mb-4 flex items-center gap-2.5 rounded-card border border-red bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text"
              role="alert"
            >
              {error}
            </div>
          )}
          <FormField className="my-3.5" label="内容">
            <TextArea
              onChange={event => setContent(event.target.value)}
              rows={3}
              value={content}
            />
          </FormField>
          <FormField className="my-3.5" htmlFor="memory-category" label="类别">
            <Select
              onValueChange={value => setCategory(value as MemoryCategory)}
              value={category}
            >
              <SelectTrigger
                className="h-9 w-full rounded-control"
                id="memory-category"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {memoryCategories.map(item => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField className="my-3.5" htmlFor="memory-scope" label="作用范围">
            <Select
              onValueChange={value => setScope(value as MemoryScope)}
              value={scope}
            >
              <SelectTrigger
                className="h-9 w-full rounded-control"
                id="memory-scope"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">全局</SelectItem>
                <SelectItem value="worker">Worker</SelectItem>
                <SelectItem value="channel">事情</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          {scope !== 'global' && (
            <FormField className="my-3.5" htmlFor="memory-task" label="事情">
              <Select onValueChange={setTaskId} value={taskId}>
                <SelectTrigger
                  className="h-9 w-full rounded-control"
                  id="memory-task"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {channels.map(channel => (
                    <SelectItem key={channel.id} value={channel.id}>
                      {channel.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
          <p className="text-[12px] leading-[1.6] text-ink-2">
            {draft
              ? '来源保持服务端记录不变；修改会以新修订保存。'
              : '手动添加的记忆来源记为“用户确认”。'}
          </p>
        </div>
        <footer className="record-form-footer flex items-center justify-end gap-2 border-t border-line px-4.5 py-3">
          <Button
            className="h-9 px-4 text-[13px] text-ink-2"
            onClick={onCancel}
            size="sm"
            type="button"
            variant="quiet"
          >
            取消
          </Button>
          <Button
            className="h-9 px-4 text-[13px]"
            disabled={saving}
            onClick={() => void submit()}
            size="sm"
            type="button"
            variant="primary"
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
