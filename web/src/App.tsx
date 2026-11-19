import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Circle,
  CircleCheck,
  CircleX,
  CircleDot,
  CircleDashed,
  Columns3,
  FileOutput,
  KeyRound,
  ListTodo,
  Mic,
  MessageSquareText,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
} from 'lucide-react'
import {
  type KeyboardEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { ApiError, PegasApi } from './api'
import { MarkdownMessage } from './MarkdownMessage'
import {
  DsArrowUpIcon,
  DsCloseIcon,
  DsDotsIcon,
  DsFolderIcon,
  DsGearIcon,
  DsMainStarIcon,
  DsMicIcon,
  DsPanelIcon,
  DsPlugIcon,
  DsPlusIcon,
  DsReplyIcon,
  DsSearchIcon,
  DsSidebarIcon,
  DsSmileIcon,
  DsWaveIcon,
} from './DsBotIcons'
import { PegasAgentIcon } from './PegasAgentIcon'
import { fallbackWorkerIconId } from './agent-icon-id'
import { useVoiceDictation } from './useVoiceDictation'
import type {
  DshModelCatalog,
  ModelCatalogItem,
  ModelProviderDraft,
  ModelProviderId,
  InboxEvent,
  OutboxMessage,
  Run,
  RuntimeSettings,
  SettingsCapabilities,
  SettingsResponse,
  SpeechSettingsDraft,
  RewriteSettingsDraft,
  Snapshot,
  Task,
  TaskStatus,
  WorkChannel,
} from './types'

export const featuredModelProviderIds: readonly ModelProviderId[] = [
  'magpie',
  'openai',
  'anthropic',
  'deepseek',
  'ollama',
  'custom',
]

const userId = 'owner'
interface SettingsClient {
  settings(): Promise<SettingsResponse>
  discoverModels(
    modelProvider: ModelProviderId,
    modelName: string,
    provider: ModelProviderDraft,
  ): Promise<ModelCatalogItem[]>
  testModel(
    modelProvider: ModelProviderId,
    modelName: string,
    provider: ModelProviderDraft,
  ): Promise<{ ok: true; latencyMs: number }>
  agentModels(): Promise<DshModelCatalog>
  saveSettings(
    settings: RuntimeSettings,
    provider: ModelProviderDraft,
    speech?: SpeechSettingsDraft,
    rewrite?: RewriteSettingsDraft,
  ): Promise<SettingsResponse>
  testSpeechConnection(
    audio: Blob,
    speech: SpeechSettingsDraft,
  ): Promise<{
    transcript: { text: string; language?: string }
    latencyMs: number
  }>
  testRewrite(
    text: string,
    rewrite: RewriteSettingsDraft,
    settings: RuntimeSettings,
    provider: ModelProviderDraft,
  ): Promise<{
    original: string
    rewritten: string
    changed: boolean
    latencyMs: number
  }>
}
const emptySnapshot: Snapshot = {
  events: [],
  messages: [],
  runs: [],
  channels: [],
}

const statusCopy: Record<TaskStatus, string> = {
  backlog: '待安排',
  unstarted: '未开始',
  started: '进行中',
  completed: '已完成',
  cancelled: '已取消',
}

type TimelineItem =
  | { kind: 'event'; createdAt: string; value: InboxEvent }
  | { kind: 'message'; createdAt: string; value: OutboxMessage }

type AppView =
  'conversation' | 'tasks' | 'outbox' | 'bot' | 'settings' | 'plugins'

function viewFromUrl(): AppView {
  const parameters = new URLSearchParams(window.location.search)
  const view = parameters.get('view')
  if (
    view === 'conversation' ||
    view === 'tasks' ||
    view === 'outbox' ||
    view === 'bot' ||
    view === 'settings' ||
    view === 'plugins'
  )
    return view
  return 'conversation'
}

export function App() {
  const compact = useMediaQuery('(max-width: 820px)')
  const narrowSidebar = useMediaQuery('(max-width: 1100px)')
  const initialTaskId =
    new URLSearchParams(window.location.search).get('channel') ??
    new URLSearchParams(window.location.search).get('task') ??
    ''
  const [token, setToken] = useState(
    () => sessionStorage.getItem('pegas-token') ?? '',
  )
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot)
  const [loading, setLoading] = useState(true)
  const [unauthorized, setUnauthorized] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [activeView, setActiveView] = useState<AppView>(viewFromUrl)
  const [selectedOutboxId, setSelectedOutboxId] = useState(
    () => new URLSearchParams(window.location.search).get('outbox') ?? '',
  )
  const [sidebarCollapsed, setSidebarCollapsed] = useState(narrowSidebar)
  const [workspaceOpen, setWorkspaceOpen] = useState(Boolean(initialTaskId))
  const workspaceVisible =
    workspaceOpen &&
    activeView !== 'settings' &&
    activeView !== 'bot' &&
    activeView !== 'plugins'
  const [selectedTaskId, setSelectedTaskId] = useState(initialTaskId)
  const [attachmentHelpOpen, setAttachmentHelpOpen] = useState(false)

  useEffect(() => {
    if (narrowSidebar) setSidebarCollapsed(true)
  }, [narrowSidebar])
  const [voiceGateError, setVoiceGateError] = useState('')
  const feedEnd = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const workspaceTrigger = useRef<HTMLElement | null>(null)
  const modalTrigger = useRef<HTMLElement | null>(null)
  const markingOutboxRead = useRef(new Set<string>())
  const api = useMemo(() => new PegasApi(userId, token), [token])
  const appendTranscript = useCallback((text: string) => {
    setDraft(current => `${current}${current.trim() ? '\n' : ''}${text}`)
    window.requestAnimationFrame(() => composer.current?.focus())
  }, [])
  const dictation = useVoiceDictation({
    transcribe: audio => api.transcribeVoice(audio),
    onTranscript: appendTranscript,
  })
  const dictationBusy = dictation.state !== 'idle'
  const toggleDictation = async () => {
    if (dictation.state === 'recording') {
      dictation.toggle()
      return
    }
    setVoiceGateError('')
    try {
      const response = await api.settings()
      if (response.speech?.provider === 'disabled') {
        navigate('settings')
        const url = new URL(window.location.href)
        url.searchParams.set('section', 'voice')
        window.history.replaceState({ view: 'settings' }, '', url)
        return
      }
      dictation.toggle()
    } catch {
      setVoiceGateError('无法确认语音服务状态，请检查连接后重试。')
    }
  }
  const activeTaskCount = snapshot.channels.filter(task =>
    isActiveTask(task.status),
  ).length
  const unreadOutboxCount = snapshot.messages.filter(
    message => !message.readAt,
  ).length

  const loadSnapshot = useCallback(async () => {
    try {
      const next = await api.snapshot()
      setSnapshot(next)
      setUnauthorized(false)
      setError('')
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setUnauthorized(true)
        setError('')
      } else {
        setError(
          caught instanceof Error ? caught.message : '暂时无法连接 Pegas',
        )
      }
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void loadSnapshot()
    const interval = window.setInterval(() => void loadSnapshot(), 2500)
    return () => window.clearInterval(interval)
  }, [loadSnapshot])

  useEffect(() => {
    const handlePopState = () => {
      const taskId =
        new URLSearchParams(window.location.search).get('channel') ??
        new URLSearchParams(window.location.search).get('task') ??
        ''
      setSelectedTaskId(taskId)
      setSelectedOutboxId(
        new URLSearchParams(window.location.search).get('outbox') ?? '',
      )
      setWorkspaceOpen(Boolean(taskId))
      setActiveView(viewFromUrl())
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    if (activeView !== 'outbox' || !selectedOutboxId) return
    const message = snapshot.messages.find(
      candidate => candidate.id === selectedOutboxId,
    )
    if (!message || message.readAt || markingOutboxRead.current.has(message.id))
      return
    markingOutboxRead.current.add(message.id)
    void api
      .markOutboxRead(message.id)
      .then(read => {
        setSnapshot(current => ({
          ...current,
          messages: current.messages.map(candidate =>
            candidate.id === read.id ? { ...candidate, ...read } : candidate,
          ),
        }))
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : '无法标记为已读')
      })
      .finally(() => markingOutboxRead.current.delete(message.id))
  }, [activeView, api, selectedOutboxId, snapshot.messages])

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...snapshot.events
        .filter(event => event.type === 'user.message')
        .map(value => ({
          kind: 'event' as const,
          createdAt: value.createdAt,
          value,
        })),
      ...snapshot.messages.map(value => ({
        kind: 'message' as const,
        createdAt: value.createdAt,
        value,
      })),
    ]
    return items.toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    )
  }, [snapshot.events, snapshot.messages])

  const selectedTask = snapshot.channels.find(
    task => task.id === selectedTaskId,
  )
  const channelStopped = selectedTask?.status === 'cancelled'
  const startingNewTask = selectedTaskId === '__new__'
  const sidebarSelectedTask = startingNewTask ? undefined : selectedTask

  function startNewTask(): void {
    setActiveView('conversation')
    setSelectedTaskId('__new__')
    setWorkspaceOpen(false)
    const url = new URL(window.location.href)
    url.searchParams.delete('view')
    url.searchParams.delete('channel')
    url.searchParams.delete('task')
    url.searchParams.delete('outbox')
    window.history.pushState({ view: 'conversation' }, '', url)
    usePrompt('')
  }

  function startRelatedTask(): void {
    const related = selectedTask
    setActiveView('conversation')
    setSelectedTaskId('__new__')
    setWorkspaceOpen(false)
    const url = new URL(window.location.href)
    url.searchParams.delete('view')
    url.searchParams.delete('channel')
    url.searchParams.delete('task')
    url.searchParams.delete('outbox')
    window.history.pushState({ view: 'conversation' }, '', url)
    usePrompt(related ? `继续处理「${related.title}」：` : '')
  }

  function selectTask(taskId: string): void {
    rememberWorkspaceTrigger()
    setActiveView('conversation')
    setSelectedTaskId(taskId)
    setWorkspaceOpen(true)
    const url = new URL(window.location.href)
    url.searchParams.delete('view')
    url.searchParams.delete('task')
    url.searchParams.delete('outbox')
    url.searchParams.set('channel', taskId)
    window.history.pushState({ taskId }, '', url)
  }

  function openTask(taskId: string): void {
    rememberWorkspaceTrigger()
    setActiveView('tasks')
    setSelectedTaskId(taskId)
    setWorkspaceOpen(true)
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'tasks')
    url.searchParams.delete('task')
    url.searchParams.delete('outbox')
    url.searchParams.set('channel', taskId)
    window.history.pushState({ taskId }, '', url)
  }

  function openOutbox(messageId: string): void {
    setActiveView('outbox')
    setSelectedOutboxId(messageId)
    setWorkspaceOpen(false)
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'outbox')
    url.searchParams.set('outbox', messageId)
    url.searchParams.delete('channel')
    url.searchParams.delete('task')
    window.history.pushState({ messageId }, '', url)
  }

  function closeWorkspace(): void {
    setWorkspaceOpen(false)
    setSelectedTaskId('')
    const url = new URL(window.location.href)
    url.searchParams.delete('channel')
    url.searchParams.delete('task')
    window.history.replaceState({}, '', url)
    if (compact)
      window.requestAnimationFrame(() => workspaceTrigger.current?.focus())
  }

  function rememberWorkspaceTrigger(): void {
    if (!compact || workspaceOpen) return
    workspaceTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
  }

  function returnToPegas(): void {
    setActiveView('conversation')
    setSelectedTaskId('')
    setWorkspaceOpen(false)
    const url = new URL(window.location.href)
    url.searchParams.delete('view')
    url.searchParams.delete('channel')
    url.searchParams.delete('task')
    url.searchParams.delete('outbox')
    window.history.pushState({ view: 'conversation' }, '', url)
    window.requestAnimationFrame(() => composer.current?.focus())
  }

  function navigate(view: AppView): void {
    setActiveView(view)
    const url = new URL(window.location.href)
    if (view !== 'outbox') url.searchParams.delete('outbox')
    if (view === 'outbox' && !selectedOutboxId) {
      const first = snapshot.messages.toSorted((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      )[0]
      if (first) {
        setSelectedOutboxId(first.id)
        url.searchParams.set('outbox', first.id)
      }
    }
    if (view === 'conversation' && !url.searchParams.has('task'))
      url.searchParams.delete('view')
    else url.searchParams.set('view', view)
    window.history.pushState({ view }, '', url)
  }

  function openWorkspace(): void {
    rememberWorkspaceTrigger()
    setWorkspaceOpen(true)
  }

  function usePrompt(prompt: string): void {
    setDraft(prompt)
    window.requestAnimationFrame(() => composer.current?.focus())
  }

  async function submitMessage(): Promise<void> {
    const text = draft.trim()
    if (!text || sending || dictationBusy) return
    setSending(true)
    setError('')
    try {
      await api.sendMessage(text, sidebarSelectedTask?.taskId)
      setDraft('')
      await loadSnapshot()
      window.setTimeout(
        () => feedEnd.current?.scrollIntoView({ behavior: 'smooth' }),
        0,
      )
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401)
        setUnauthorized(true)
      else
        setError(
          caught instanceof Error ? caught.message : '消息发送失败，请重试',
        )
    } finally {
      setSending(false)
    }
  }

  function handleComposerKeyDown(
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void {
    if (event.key !== 'Enter' || event.shiftKey) return
    const nativeFields = event.nativeEvent as unknown as Record<string, unknown>
    const { keyCode } = nativeFields
    if (event.nativeEvent.isComposing || keyCode === 229) return
    event.preventDefault()
    void submitMessage()
  }

  function saveToken(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): void {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const tokenValue = form.get('token')
    const nextToken = typeof tokenValue === 'string' ? tokenValue.trim() : ''
    sessionStorage.setItem('pegas-token', nextToken)
    setToken(nextToken)
    setUnauthorized(false)
  }

  return (
    <div
      className={`app-shell${workspaceVisible ? ' has-workspace' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
    >
      <a className="skip-link" href="#page-title">
        跳到主要内容
      </a>
      <aside
        className="identity-rail"
        aria-label="Pegas 导航"
        aria-hidden={
          (compact && workspaceVisible) ||
          activeView === 'settings' ||
          activeView === 'bot' ||
          activeView === 'plugins'
            ? true
            : undefined
        }
        inert={
          (compact && workspaceVisible) ||
          activeView === 'settings' ||
          activeView === 'bot' ||
          activeView === 'plugins'
            ? true
            : undefined
        }
      >
        <div className="task-sidebar-head">
          <button
            className="task-sidebar-brand"
            aria-label="返回 Pegas 主对话"
            hidden={sidebarCollapsed}
            onClick={returnToPegas}
          >
            <span className="task-sidebar-brand-mark">
              <PegasAgentIcon iconId="bot" size={24} />
            </span>
            <strong>Pegas</strong>
          </button>
          <div className="task-sidebar-actions" aria-label="Channel 工具">
            <button
              className="ds-round-button"
              aria-label="Channel 列表"
              title="Channel 列表"
              hidden={sidebarCollapsed}
              onClick={() => navigate('tasks')}
            >
              <DsFolderIcon />
            </button>
            <button
              className="ds-round-button"
              aria-label="搜索 Channel"
              title="搜索 Channel"
              hidden={sidebarCollapsed}
              onClick={() => navigate('tasks')}
            >
              <DsSearchIcon />
            </button>
            <button
              className="ds-round-button"
              aria-label="开始新事情"
              title="开始新事情"
              hidden={sidebarCollapsed}
              onClick={startNewTask}
            >
              <DsPlusIcon size={18} />
            </button>
            <button
              className="ds-round-button"
              aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!sidebarCollapsed}
              onClick={() => setSidebarCollapsed(value => !value)}
            >
              <DsSidebarIcon />
            </button>
          </div>
        </div>

        <nav
          className="task-sidebar-list"
          aria-label="工作列表"
          hidden={sidebarCollapsed}
        >
          <button
            type="button"
            className="task-featured-card"
            aria-label="Pegas 设置"
            onClick={event => {
              modalTrigger.current = event.currentTarget
              navigate('bot')
            }}
          >
            <span className="task-featured-mark">
              <PegasAgentIcon iconId="bot" size={54} />
              <span className="task-featured-star">
                <DsMainStarIcon size={20} />
              </span>
            </span>
            <strong>Pegas</strong>
            <span>Personal agent</span>
          </button>

          <div className="sidebar-section-nav" aria-label="工作导航">
            <button
              type="button"
              className={activeView === 'outbox' ? '' : 'is-active'}
              aria-current={activeView === 'outbox' ? undefined : 'page'}
              onClick={() => navigate('tasks')}
            >
              <DsFolderIcon />
              <span>Channels</span>
              <span>{snapshot.channels.length}</span>
            </button>
            <button
              type="button"
              className={activeView === 'outbox' ? 'is-active' : ''}
              aria-current={activeView === 'outbox' ? 'page' : undefined}
              onClick={() => navigate('outbox')}
            >
              <MessageSquareText aria-hidden="true" />
              <span>Outbox</span>
              <span>{unreadOutboxCount}</span>
            </button>
          </div>
          <div className="channel-list-heading">
            <span>{activeView === 'outbox' ? '需要关注' : '最近 Channel'}</span>
            <span>
              {activeView === 'outbox'
                ? snapshot.messages.length
                : snapshot.channels.length}
            </span>
          </div>
          <div className="task-rows">
            {activeView === 'outbox' ? (
              snapshot.messages.length === 0 ? (
                <div className="sidebar-empty">暂无需要关注的消息</div>
              ) : (
                snapshot.messages
                  .toSorted((left, right) =>
                    right.createdAt.localeCompare(left.createdAt),
                  )
                  .map(message => {
                    const channel = snapshot.channels.find(
                      candidate => candidate.id === message.taskId,
                    )
                    return (
                      <button
                        type="button"
                        className={`task-row outbox-row${selectedOutboxId === message.id ? ' is-active' : ''}`}
                        aria-label={`查看 Outbox：${outboxTitle(message)}`}
                        aria-current={
                          selectedOutboxId === message.id ? 'page' : undefined
                        }
                        key={message.id}
                        onClick={() => openOutbox(message.id)}
                      >
                        <span className="task-row-mark">
                          {channel ? (
                            <PegasAgentIcon
                              iconId={channel.workerIconId}
                              status={channel.status}
                              size={34}
                            />
                          ) : (
                            <PegasAgentIcon iconId="bot" size={34} />
                          )}
                        </span>
                        <span className="task-row-copy">
                          <strong>{outboxTitle(message)}</strong>
                          <small>{outboxSummary(message)}</small>
                        </span>
                        {!message.readAt && (
                          <>
                            <span className="task-unread" aria-hidden="true" />
                            <span className="sr-only">未读</span>
                          </>
                        )}
                      </button>
                    )
                  })
              )
            ) : snapshot.channels.length === 0 ? (
              <button
                type="button"
                className="task-row is-active"
                aria-label="在 Pegas 中开始新事情"
                onClick={startNewTask}
              >
                <span className="task-row-mark">
                  <PegasAgentIcon iconId="bot" size={34} />
                </span>
                <span className="task-row-copy">
                  <strong>暂无 Channel</strong>
                  <small>告诉 Pegas 你想完成什么</small>
                </span>
              </button>
            ) : (
              snapshot.channels.map(task => (
                <button
                  type="button"
                  className={`task-row${sidebarSelectedTask?.id === task.id ? ' is-active' : ''}`}
                  aria-label={`打开 Channel：${task.title}`}
                  aria-describedby={`channel-status-${task.id}`}
                  aria-current={
                    sidebarSelectedTask?.id === task.id ? 'page' : undefined
                  }
                  key={task.id}
                  onClick={() => selectTask(task.id)}
                >
                  <span className="task-row-mark">
                    <PegasAgentIcon
                      iconId={task.workerIconId}
                      status={task.status}
                      size={34}
                    />
                  </span>
                  <span className="task-row-copy">
                    <strong>{task.title}</strong>
                    <small>{task.goal}</small>
                  </span>
                  {isActiveTask(task.status) && (
                    <span className="task-unread" aria-hidden="true" />
                  )}
                  <span className="sr-only" id={`channel-status-${task.id}`}>
                    状态：{statusCopy[task.status]}
                  </span>
                </button>
              ))
            )}
          </div>
        </nav>

        <div className="task-sidebar-foot" hidden={sidebarCollapsed}>
          <button
            className={`ds-foot-button${activeView === 'settings' ? ' is-active' : ''}`}
            aria-label="设置"
            aria-current={activeView === 'settings' ? 'page' : undefined}
            onClick={event => {
              modalTrigger.current = event.currentTarget
              navigate('settings')
            }}
          >
            <DsGearIcon />
          </button>
          <button
            className={`ds-foot-button${activeView === 'plugins' ? ' is-active' : ''}`}
            aria-label="插件"
            aria-current={activeView === 'plugins' ? 'page' : undefined}
            onClick={event => {
              modalTrigger.current = event.currentTarget
              navigate('plugins')
            }}
          >
            <DsPlugIcon />
          </button>
        </div>
      </aside>

      <main
        className="main-column"
        aria-hidden={compact && workspaceVisible ? true : undefined}
        inert={compact && workspaceVisible ? true : undefined}
      >
        <header className="conversation-header page-header">
          <div className="identity-copy">
            <PegasAgentIcon
              iconId={sidebarSelectedTask?.workerIconId ?? 'bot'}
              status={sidebarSelectedTask?.status}
              size={28}
            />
            <div>
              <h1 id="page-title" tabIndex={-1}>
                {activeView === 'conversation'
                  ? (sidebarSelectedTask?.title ?? 'Pegas')
                  : activeView === 'tasks'
                    ? 'Channels'
                    : activeView === 'outbox'
                      ? 'Outbox'
                      : activeView === 'bot'
                        ? 'Pegas 设置'
                        : activeView === 'plugins'
                          ? '插件'
                          : '设置'}
              </h1>
              {activeView !== 'settings' &&
                activeView !== 'bot' &&
                activeView !== 'plugins' && (
                  <span>
                    {activeView === 'outbox'
                      ? `${String(unreadOutboxCount)} 条未读`
                      : activeView === 'conversation'
                        ? error
                          ? '连接中断'
                          : '在线，随时可以开始'
                        : `${String(activeTaskCount)} 件正在推进`}
                  </span>
                )}
            </div>
          </div>
        </header>

        <div className="notice-stack">
          {error && (
            <div className="connection-banner" role="alert">
              <CircleAlert aria-hidden="true" />
              <span>{error}</span>
              <button onClick={() => void loadSnapshot()}>重新连接</button>
            </div>
          )}

          {unauthorized && <TokenForm onSubmit={saveToken} />}
        </div>

        {activeView === 'conversation' ? (
          <>
            <section className="conversation-feed" aria-label="与 Pegas 的对话">
              {loading ? (
                <ConversationSkeleton />
              ) : timeline.length === 0 ? (
                <EmptyConversation
                  activeTaskCount={activeTaskCount}
                  onPrompt={usePrompt}
                />
              ) : (
                timeline.map(item => {
                  if (item.kind === 'event') {
                    const task = snapshot.channels.find(
                      candidate => candidate.originEventId === item.value.id,
                    )
                    return (
                      <div
                        className="timeline-group"
                        key={`event-${item.value.id}`}
                      >
                        <UserMessage event={item.value} />
                        {task && (
                          <TaskPulse
                            task={task}
                            runs={snapshot.runs.filter(
                              run => run.taskId === task.id,
                            )}
                            onOpen={() => openTask(task.id)}
                          />
                        )}
                      </div>
                    )
                  }
                  const messageRun = runForMessage(item.value, snapshot.runs)
                  return (
                    <PegasMessage
                      key={`message-${item.value.id}`}
                      message={item.value}
                      run={messageRun}
                      task={
                        (messageRun
                          ? snapshot.channels.find(
                              channel => channel.id === messageRun.taskId,
                            )
                          : undefined) ?? sidebarSelectedTask
                      }
                    />
                  )
                })
              )}
              <div ref={feedEnd} />
            </section>

            <div className="composer-dock">
              {channelStopped && (
                <div className="channel-stopped-banner" role="status">
                  <span>这个 Channel 已由你停止，不能恢复。</span>
                  <button type="button" onClick={startRelatedTask}>
                    新建相关 Channel
                  </button>
                </div>
              )}
              {attachmentHelpOpen && (
                <div className="attachment-help" role="status">
                  <FileOutput aria-hidden="true" />
                  <span>
                    附件接入正在准备中。目前可以直接粘贴链接或文字内容。
                  </span>
                  <button
                    type="button"
                    onClick={() => setAttachmentHelpOpen(false)}
                    aria-label="关闭附件说明"
                  >
                    <DsCloseIcon />
                  </button>
                </div>
              )}
              <form
                className="composer-wrap"
                onSubmit={event => {
                  event.preventDefault()
                  void submitMessage()
                }}
              >
                <label className="sr-only" htmlFor="message-composer">
                  告诉 Pegas 你想完成什么
                </label>
                <button
                  type="button"
                  className="attachment-button"
                  aria-label="添加附件"
                  title="添加附件"
                  aria-expanded={attachmentHelpOpen}
                  onClick={() => setAttachmentHelpOpen(open => !open)}
                  disabled={sending || unauthorized || channelStopped}
                >
                  <DsPlusIcon />
                </button>
                <textarea
                  ref={composer}
                  id="message-composer"
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={
                    channelStopped
                      ? '这个 Channel 已停止'
                      : `给 ${sidebarSelectedTask?.title ?? 'Pegas'} 发消息`
                  }
                  rows={1}
                  name="message"
                  aria-describedby="composer-hint"
                  disabled={sending || unauthorized || channelStopped}
                />
                <span className="composer-status" id="composer-hint">
                  {dictation.state === 'requesting' && '正在请求麦克风…'}
                  {dictation.state === 'recording' &&
                    `正在听写 · ${formatDuration(dictation.elapsedSeconds)}`}
                  {dictation.state === 'transcribing' && '正在转成文字…'}
                  {dictation.state === 'idle' && 'Shift + Enter 换行'}
                </span>
                <div className="composer-actions">
                  <div className="dictation-control">
                    <button
                      type="button"
                      className={`dictation-button ${
                        dictation.state === 'recording' ? 'is-recording' : ''
                      }`}
                      aria-label={
                        dictation.state === 'recording'
                          ? '停止听写'
                          : dictation.state === 'transcribing'
                            ? '正在转写语音'
                            : dictation.state === 'requesting'
                              ? '正在请求麦克风'
                              : '开始听写'
                      }
                      aria-pressed={dictation.state === 'recording'}
                      onClick={() => void toggleDictation()}
                      disabled={
                        sending ||
                        unauthorized ||
                        channelStopped ||
                        dictation.state === 'requesting' ||
                        dictation.state === 'transcribing'
                      }
                    >
                      {dictation.state === 'transcribing' ||
                      dictation.state === 'requesting' ? (
                        <span className="dictation-loader" aria-hidden="true" />
                      ) : dictation.state === 'recording' ? (
                        <Square aria-hidden="true" />
                      ) : (
                        <DsMicIcon />
                      )}
                    </button>
                    <span className="dictation-tooltip" role="tooltip">
                      {dictation.state === 'recording' ? '停止听写' : '听写'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={`voice-button${dictation.state === 'recording' ? ' is-recording' : ''}`}
                    aria-label={
                      dictation.state === 'recording'
                        ? '停止语音输入'
                        : '开始语音输入'
                    }
                    aria-pressed={dictation.state === 'recording'}
                    onClick={() => void toggleDictation()}
                    disabled={
                      sending ||
                      unauthorized ||
                      channelStopped ||
                      dictation.state === 'requesting' ||
                      dictation.state === 'transcribing'
                    }
                  >
                    <DsWaveIcon />
                  </button>
                  <button
                    type="submit"
                    className="send-button"
                    aria-label={sending ? '正在发送' : '发送给 Pegas'}
                    disabled={
                      !draft.trim() ||
                      sending ||
                      unauthorized ||
                      channelStopped ||
                      dictationBusy
                    }
                  >
                    {sending ? (
                      <span className="send-loader" aria-hidden="true" />
                    ) : (
                      <DsArrowUpIcon />
                    )}
                  </button>
                </div>
                {(dictation.error || voiceGateError) && (
                  <p className="dictation-error" role="status">
                    {voiceGateError || dictation.error}
                  </p>
                )}
              </form>
              <div className="sr-only" aria-live="polite">
                {sending && '正在发送消息'}
                {dictation.state === 'recording' && '听写已开始'}
                {dictation.state === 'transcribing' && '录音结束，正在转成文字'}
              </div>
            </div>
          </>
        ) : activeView === 'tasks' ? (
          <TasksPage
            tasks={snapshot.channels}
            runs={snapshot.runs}
            onOpen={openTask}
          />
        ) : activeView === 'outbox' ? (
          <OutboxPage
            channels={snapshot.channels}
            messages={snapshot.messages}
            selectedId={selectedOutboxId}
            onSelect={openOutbox}
            onOpenChannel={openTask}
          />
        ) : activeView === 'bot' ? (
          <SettingsPage
            api={api}
            mode="bot"
            restoreFocusTo={modalTrigger.current}
            onClose={() => navigate('conversation')}
            onOpenBot={() => navigate('bot')}
            onOpenGeneral={() => navigate('settings')}
          />
        ) : activeView === 'plugins' ? (
          <PluginsPage
            onClose={() => navigate('conversation')}
            restoreFocusTo={modalTrigger.current}
          />
        ) : (
          <SettingsPage
            api={api}
            restoreFocusTo={modalTrigger.current}
            onClose={() => navigate('conversation')}
            onOpenBot={() => navigate('bot')}
            onOpenGeneral={() => navigate('settings')}
          />
        )}
      </main>

      {!workspaceVisible &&
        (activeView === 'conversation' || activeView === 'tasks') && (
          <div className="workspace-rail" aria-label="工作区标签">
            <button
              type="button"
              className="workspace-tab"
              aria-label="打开工作区"
              aria-expanded="false"
              onClick={openWorkspace}
            >
              <DsPanelIcon />
              <span>工作区</span>
            </button>
          </div>
        )}

      <WorkspacePanel
        onRetry={async runId => {
          await api.retryRun(runId)
          await loadSnapshot()
        }}
        onStop={async taskId => {
          await api.stopChannel(taskId, '用户在工作区停止 Channel')
          await loadSnapshot()
        }}
        onNewRelated={startRelatedTask}
        open={workspaceVisible}
        selectedTask={selectedTask}
        runs={
          selectedTask
            ? snapshot.runs.filter(run => run.taskId === selectedTask.id)
            : []
        }
        onClose={closeWorkspace}
        compact={compact}
      />
    </div>
  )
}

const pluginCatalog = [
  {
    id: 'dsh',
    name: 'DSH 执行器',
    description: '承载 Channel 的 Agent session、工具与工作区。',
    status: '由服务端管理',
  },
  {
    id: 'speech',
    name: '语音输入',
    description: '把输入框录音转成可编辑文字，再由你确认发送。',
    status: '在设置中配置',
  },
  {
    id: 'channels',
    name: '消息渠道',
    description: '为未来的 Web、移动端和消息应用保留统一入口。',
    status: '尚未接入',
  },
] as const

function PluginsPage({
  onClose,
  restoreFocusTo,
}: {
  onClose: () => void
  restoreFocusTo: HTMLElement | null
}) {
  const [selected, setSelected] = useState<(typeof pluginCatalog)[number]>()
  const pluginDialog = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const detailLayer = useRef<HTMLDivElement>(null)
  const detailTrigger = useRef<HTMLButtonElement>(null)
  onCloseRef.current = onClose

  useEffect(() => {
    const dialog = pluginDialog.current
    if (!dialog) return
    const initial = dialog.querySelector<HTMLElement>(
      '[data-plugin-page-focus]',
    )
    const frame = window.requestAnimationFrame(() => initial?.focus())
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (detailLayer.current) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
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
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKeyDown)
      window.requestAnimationFrame(() => restoreFocusTo?.focus())
    }
  }, [restoreFocusTo])

  const closeDetail = useCallback(() => {
    setSelected(undefined)
    window.requestAnimationFrame(() => detailTrigger.current?.focus())
  }, [])

  useEffect(() => {
    if (!selected || !detailLayer.current) return
    const layer = detailLayer.current
    const initial = layer.querySelector<HTMLElement>(
      '[data-plugin-detail-focus]',
    )
    const frame = window.requestAnimationFrame(() => initial?.focus())
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeDetail()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        layer.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
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
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeDetail, selected])

  return (
    <section className="plugin-page" aria-labelledby="plugin-page-title">
      <button
        className="settings-scrim"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        inert={selected ? true : undefined}
      />
      <div
        ref={pluginDialog}
        className="plugin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-page-title"
        inert={selected ? true : undefined}
      >
        <header>
          <div>
            <span>PLUGINS</span>
            <h1 id="plugin-page-title">插件</h1>
          </div>
          <button
            className="settings-close"
            aria-label="关闭插件"
            data-plugin-page-focus
            onClick={onClose}
          >
            <DsCloseIcon />
          </button>
        </header>
        <div className="plugin-grid">
          {pluginCatalog.map(plugin => (
            <button
              className="plugin-card"
              type="button"
              key={plugin.id}
              aria-label={`查看插件：${plugin.name}`}
              onClick={event => {
                detailTrigger.current = event.currentTarget
                setSelected(plugin)
              }}
            >
              <span className="plugin-mark">
                <DsPlugIcon size={20} />
              </span>
              <span>
                <strong>{plugin.name}</strong>
                <small>{plugin.description}</small>
              </span>
              <em>{plugin.status}</em>
            </button>
          ))}
        </div>
      </div>
      {selected && (
        <div
          ref={detailLayer}
          className="plugin-detail-layer"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`plugin-detail-${selected.id}`}
        >
          <button
            className="plugin-detail-scrim"
            aria-hidden="true"
            tabIndex={-1}
            onClick={closeDetail}
          />
          <article className="plugin-detail">
            <header>
              <span className="plugin-mark">
                <DsPlugIcon size={20} />
              </span>
              <div>
                <h2 id={`plugin-detail-${selected.id}`}>{selected.name}</h2>
                <p>{selected.status}</p>
              </div>
              <button
                className="settings-close"
                aria-label="关闭插件详情"
                data-plugin-detail-focus
                onClick={closeDetail}
              >
                <DsCloseIcon />
              </button>
            </header>
            <p>{selected.description}</p>
            <div className="plugin-boundary">
              <strong>配置边界</strong>
              <p>
                连接状态和凭证由 Pegas
                服务端管理；此页不会在浏览器保存或伪造插件配置。
              </p>
            </div>
          </article>
        </div>
      )}
    </section>
  )
}

function SettingsPage({
  api,
  mode = 'general',
  onClose,
  onOpenBot,
  onOpenGeneral,
  restoreFocusTo,
}: {
  api: SettingsClient
  mode?: 'general' | 'bot'
  onClose: () => void
  onOpenBot: () => void
  onOpenGeneral: () => void
  restoreFocusTo: HTMLElement | null
}) {
  interface ModelFeedback {
    kind: 'success' | 'error' | 'info'
    title: string
    description: string
  }
  const modelFailure = (
    caught: unknown,
    action: 'discover' | 'test',
  ): ModelFeedback => {
    if (caught instanceof ApiError) {
      const upstreamStatus =
        caught.status === 400
          ? /(?:Model provider returned|模型目录返回)\s+([1-5]\d\d)\b/.exec(
              caught.message,
            )?.[1]
          : undefined
      const status = upstreamStatus ? Number(upstreamStatus) : caught.status
      if (status === 404)
        return action === 'test'
          ? {
              kind: 'error',
              title: '找不到这个模型',
              description: '检查模型 ID，或从已获取的模型列表中选择后重试。',
            }
          : {
              kind: 'error',
              title: '无法获取模型列表',
              description: '该服务可能没有模型目录。仍可手动填写模型 ID。',
            }
      if (status === 401 || status === 403)
        return {
          kind: 'error',
          title: '连接未获授权',
          description:
            '检查 API key 是否正确，以及当前账号是否有权限使用此模型。',
        }
      if (status === 429)
        return {
          kind: 'error',
          title: '请求过于频繁',
          description: '稍后重试，或检查供应商的额度和限流设置。',
        }
      if (status >= 500)
        return {
          kind: 'error',
          title: '供应商暂时不可用',
          description: '稍后重试；如果持续失败，请检查服务地址和供应商状态。',
        }
    }
    return {
      kind: 'error',
      title: action === 'test' ? '模型测试未通过' : '模型列表获取失败',
      description: '检查服务地址、网络与连接配置后重试。',
    }
  }
  const [section, setSection] = useState<
    'models' | 'routing' | 'rewrite' | 'privacy'
  >(
    new URLSearchParams(window.location.search).get('section') === 'voice'
      ? 'rewrite'
      : 'models',
  )
  const [settings, setSettings] = useState<RuntimeSettings>()
  const [capabilities, setCapabilities] = useState<SettingsCapabilities>()
  const [providerDraft, setProviderDraft] = useState<ModelProviderDraft>()
  const [speechDraft, setSpeechDraft] = useState<SpeechSettingsDraft>()
  const [rewriteDraft, setRewriteDraft] = useState<RewriteSettingsDraft>()
  const [savedSpeech, setSavedSpeech] = useState<SettingsResponse['speech']>()
  const [routerModels, setRouterModels] = useState<ModelCatalogItem[]>([])
  const [modelSearch, setModelSearch] = useState('')
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelFeedback, setModelFeedback] = useState<ModelFeedback>()
  const modelSearchRef = useRef<HTMLInputElement>(null)
  const modelRequestRef = useRef(0)
  const [agentCatalog, setAgentCatalog] = useState<DshModelCatalog>()
  const [modelAction, setModelAction] = useState<
    'discovering' | 'testing' | undefined
  >()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)
  const settingsLayer = useRef<HTMLElement>(null)
  const settingsCloseRef = useRef(onClose)
  settingsCloseRef.current = onClose

  useEffect(() => {
    return () => {
      window.requestAnimationFrame(() => restoreFocusTo?.focus())
    }
  }, [restoreFocusTo])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void Promise.all([api.settings(), api.agentModels().catch(() => undefined)])
      .then(([response, catalog]) => {
        if (!active) return
        setSettings(response.settings)
        setCapabilities(response.capabilities)
        setSavedSpeech(response.speech)
        setSpeechDraft({
          provider: response.speech?.provider ?? 'openai-compatible',
          baseUrl: response.speech?.baseUrl ?? 'http://127.0.0.1:18081/v1',
          model: response.speech?.model ?? 'Qwen/Qwen3-ASR-0.6B',
          hasApiKey: response.speech?.hasApiKey ?? false,
          apiKey: '',
          clearApiKey: false,
        })
        setRewriteDraft({
          mode: response.rewrite?.mode ?? 'router',
          protocol: response.rewrite?.protocol ?? 'openai-chat',
          baseUrl: response.rewrite?.baseUrl ?? '',
          model: response.rewrite?.model ?? '',
          hasApiKey: response.rewrite?.hasApiKey ?? false,
          apiKey: '',
          clearApiKey: false,
        })
        setDirty(false)
        const selected = response.capabilities.providers.find(
          provider => provider.id === response.settings.modelProvider,
        )
        if (selected) setProviderDraft(providerDraftFrom(selected))
        setAgentCatalog(catalog)
      })
      .catch((caught: unknown) => {
        if (!active) return
        setError(caught instanceof Error ? caught.message : '无法读取设置')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [api])

  async function save(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!settings || !providerDraft || saving) return
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const response = await api.saveSettings(
        {
          ...settings,
          modelName: settings.modelName.trim(),
          agentModelProvider: settings.agentModelProvider.trim(),
          agentModelName: settings.agentModelName.trim(),
        },
        {
          ...providerDraft,
          name: providerDraft.name.trim(),
          baseUrl: providerDraft.baseUrl.trim(),
          apiKey: providerDraft.apiKey.trim(),
        },
        speechDraft && {
          ...speechDraft,
          baseUrl: speechDraft.baseUrl.trim(),
          model: speechDraft.model.trim(),
          apiKey: speechDraft.apiKey.trim(),
        },
        rewriteDraft && {
          ...rewriteDraft,
          baseUrl: rewriteDraft.baseUrl.trim(),
          model: rewriteDraft.model.trim(),
          apiKey: rewriteDraft.apiKey.trim(),
        },
      )
      setSettings(response.settings)
      setCapabilities(response.capabilities)
      setSavedSpeech(response.speech)
      if (response.speech)
        setSpeechDraft({ ...response.speech, apiKey: '', clearApiKey: false })
      if (response.rewrite)
        setRewriteDraft({ ...response.rewrite, apiKey: '', clearApiKey: false })
      const selected = response.capabilities.providers.find(
        provider => provider.id === response.settings.modelProvider,
      )
      if (selected) setProviderDraft(providerDraftFrom(selected))
      setDirty(false)
      setSaved(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '设置保存失败')
    } finally {
      setSaving(false)
    }
  }

  const update = <Key extends keyof RuntimeSettings>(
    key: Key,
    value: RuntimeSettings[Key],
  ) => {
    setDirty(true)
    setSaved(false)
    setSettings(current => (current ? { ...current, [key]: value } : current))
  }
  const updateSpeech = <Key extends keyof SpeechSettingsDraft>(
    key: Key,
    value: SpeechSettingsDraft[Key],
  ) => {
    setDirty(true)
    setSaved(false)
    setSpeechDraft(current =>
      current ? { ...current, [key]: value } : current,
    )
  }
  const updateRewrite = <Key extends keyof RewriteSettingsDraft>(
    key: Key,
    value: RewriteSettingsDraft[Key],
  ) => {
    setDirty(true)
    setSaved(false)
    setRewriteDraft(current =>
      current ? { ...current, [key]: value } : current,
    )
  }
  const resetModelLookup = () => {
    modelRequestRef.current += 1
    setModelAction(undefined)
    setRouterModels([])
    setModelSearch('')
    setModelPickerOpen(false)
    setModelFeedback(undefined)
  }
  const changeModelName = (name: string) => {
    modelRequestRef.current += 1
    setModelAction(undefined)
    setModelFeedback(undefined)
    update('modelName', name)
  }
  const selectProvider = (id: ModelProviderId) => {
    const provider = capabilities?.providers.find(
      candidate => candidate.id === id,
    )
    if (!provider) return
    setDirty(true)
    setSaved(false)
    setSettings(current =>
      current
        ? {
            ...current,
            modelProvider: id,
            modelName: provider.defaultModel || current.modelName,
          }
        : current,
    )
    setProviderDraft(providerDraftFrom(provider))
    resetModelLookup()
  }
  const discoverModels = async () => {
    if (!settings || !providerDraft || modelAction) return
    const requestId = ++modelRequestRef.current
    setModelAction('discovering')
    setModelFeedback(undefined)
    setError('')
    try {
      const models = await api.discoverModels(
        settings.modelProvider,
        settings.modelName,
        providerDraft,
      )
      if (requestId !== modelRequestRef.current) return
      setRouterModels(models)
      setModelSearch('')
      setModelPickerOpen(models.length > 0)
      setModelFeedback(
        models.length > 0
          ? {
              kind: 'success',
              title: `已获取 ${String(models.length)} 个模型`,
              description: '从列表选择一个模型，或继续手动填写模型 ID。',
            }
          : {
              kind: 'info',
              title: '模型列表为空',
              description: '该连接没有返回模型，仍可手动填写模型 ID。',
            },
      )
      if (models.length > 0)
        window.requestAnimationFrame(() => modelSearchRef.current?.focus())
    } catch (caught) {
      if (requestId === modelRequestRef.current)
        setModelFeedback(modelFailure(caught, 'discover'))
    } finally {
      if (requestId === modelRequestRef.current) setModelAction(undefined)
    }
  }
  const testSelectedModel = async () => {
    if (!settings || !providerDraft || modelAction) return
    const requestId = ++modelRequestRef.current
    setModelAction('testing')
    setModelFeedback(undefined)
    setError('')
    try {
      const result = await api.testModel(
        settings.modelProvider,
        settings.modelName.trim(),
        providerDraft,
      )
      if (requestId !== modelRequestRef.current) return
      setModelFeedback({
        kind: 'success',
        title: '模型连接正常',
        description: `已收到模型响应，耗时 ${String(result.latencyMs)} 毫秒。`,
      })
    } catch (caught) {
      if (requestId === modelRequestRef.current)
        setModelFeedback(modelFailure(caught, 'test'))
    } finally {
      if (requestId === modelRequestRef.current) setModelAction(undefined)
    }
  }
  const filteredModels = routerModels.filter(model =>
    `${model.id} ${model.name}`
      .toLocaleLowerCase()
      .includes(modelSearch.trim().toLocaleLowerCase()),
  )
  const shownModels = filteredModels.slice(0, 50)
  const modelNotListed =
    routerModels.length > 0 &&
    !routerModels.some(model => model.id === settings?.modelName.trim())
  const selectedProvider = capabilities?.providers.find(
    provider => provider.id === settings?.modelProvider,
  )
  const customProvider = settings?.modelProvider === 'custom'
  const featuredProviders = capabilities?.providers.filter(provider =>
    featuredModelProviderIds.includes(provider.id),
  )
  const additionalProviders = capabilities?.providers.filter(
    provider => !featuredModelProviderIds.includes(provider.id),
  )
  const canSave = Boolean(
    settings?.modelName.trim() &&
    providerDraft?.name.trim() &&
    providerDraft.baseUrl.trim() &&
    (speechDraft?.provider !== 'openai-compatible' ||
      (speechDraft.baseUrl.trim() && speechDraft.model.trim())) &&
    (settings.rewriteMode !== 'light' ||
      rewriteDraft?.mode !== 'custom' ||
      (rewriteDraft.baseUrl.trim() && rewriteDraft.model.trim())) &&
    (settings.agentModelMode === 'profile' ||
      (settings.agentModelProvider.trim() && settings.agentModelName.trim())),
  )
  const speechStatus =
    speechDraft?.provider === 'disabled'
      ? '未启用'
      : !speechDraft?.baseUrl.trim()
        ? '待填写服务地址'
        : speechDraft.provider === savedSpeech?.provider &&
            speechDraft.baseUrl.trim() === savedSpeech.baseUrl &&
            speechDraft.model.trim() === savedSpeech.model &&
            !speechDraft.apiKey &&
            !speechDraft.clearApiKey
          ? '已配置'
          : '待保存'
  const settingsTabs = [
    ['models', '模型与供应商'],
    ['routing', '任务路由'],
    ['rewrite', '语音与输入'],
    ['privacy', '隐私'],
  ] as const
  const settingsNavigation = (
    <div className="settings-tabs" role="tablist" aria-label="设置分类">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'bot'}
        tabIndex={mode === 'bot' ? 0 : -1}
        onClick={onOpenBot}
      >
        <PegasAgentIcon iconId="bot" size={18} />
        <span>Pegas</span>
      </button>
      <span className="settings-rule" aria-hidden="true" />
      {settingsTabs.map(([id, label], index, tabs) => (
        <button
          type="button"
          role="tab"
          id={`settings-tab-${id}`}
          key={id}
          aria-selected={mode === 'general' && section === id}
          aria-controls={
            mode === 'general' && section === id
              ? `settings-panel-${id}`
              : undefined
          }
          tabIndex={mode === 'general' && section === id ? 0 : -1}
          onClick={() => {
            setSection(id)
            onOpenGeneral()
          }}
          onKeyDown={event => {
            let next: number
            if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
            else if (event.key === 'ArrowLeft')
              next = (index + tabs.length - 1) % tabs.length
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = tabs.length - 1
            else return
            event.preventDefault()
            const nextTab = tabs[next]
            if (!nextTab) return
            setSection(nextTab[0])
            onOpenGeneral()
            window.requestAnimationFrame(() => {
              document.getElementById(`settings-tab-${nextTab[0]}`)?.focus()
            })
          }}
        >
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
  useEffect(() => {
    if (!settingsLayer.current) return
    const layer = settingsLayer.current
    const initial = layer.querySelector<HTMLElement>('[data-settings-focus]')
    const frame = window.requestAnimationFrame(() => initial?.focus())
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        settingsCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        layer.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
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
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [mode])

  return (
    <section
      ref={settingsLayer}
      className="settings-page settings-layer"
      aria-label={mode === 'bot' ? 'Pegas 设置' : '设置选项'}
      aria-modal="true"
      role="dialog"
    >
      <button
        type="button"
        className="settings-scrim"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <button
        type="button"
        className="settings-close settings-layer-close"
        aria-label="关闭设置"
        data-settings-focus
        onClick={onClose}
      >
        <DsCloseIcon />
      </button>
      {loading ? (
        <div className="settings-loading" aria-label="正在读取设置">
          <span />
          <span />
          <span />
        </div>
      ) : settings && capabilities && providerDraft && selectedProvider ? (
        <form
          className={`settings-form${mode === 'bot' ? ' is-bot-settings' : ''}`}
          onSubmit={event => void save(event)}
        >
          {mode === 'bot' ? (
            <div className="settings-layout bot-settings-layout">
              {settingsNavigation}
              <div className="settings-main">
                <header className="settings-dialog-head bot-settings-heading">
                  <span className="bot-profile-mark" aria-hidden="true">
                    <PegasAgentIcon iconId="bot" size={34} />
                  </span>
                  <span className="bot-settings-title">
                    <h2>Pegas</h2>
                    <p>长期、可靠、克制的个人执行伙伴 · 在线</p>
                  </span>
                </header>

                <div className="settings-scroll bot-settings-scroll">
                  <section className="bot-settings-section">
                    <h3>Agent 模型</h3>
                    <fieldset className="settings-choice-group agent-model-group">
                      <legend>执行模型来源</legend>
                      <SettingChoice
                        name="bot-agent-model-mode"
                        value="profile"
                        checked={settings.agentModelMode === 'profile'}
                        title="跟随 DSH profile"
                        description={
                          agentCatalog
                            ? `当前默认 ${agentCatalog.defaultProvider} / ${agentCatalog.defaultModel}`
                            : '由运行环境的 DSH profile 决定。'
                        }
                        onChange={() => update('agentModelMode', 'profile')}
                      />
                      <SettingChoice
                        name="bot-agent-model-mode"
                        value="override"
                        checked={settings.agentModelMode === 'override'}
                        title="覆盖新 Agent session"
                        description="只影响新建 session；恢复中的 Task 继续沿用原模型。"
                        onChange={() => update('agentModelMode', 'override')}
                      />
                      {settings.agentModelMode === 'override' && (
                        <div className="agent-model-field">
                          <label htmlFor="bot-agent-model-name">
                            DSH provider 与模型
                          </label>
                          <input
                            id="bot-agent-model-name"
                            name="botAgentModel"
                            list="bot-agent-model-options"
                            value={
                              settings.agentModelProvider
                                ? `${settings.agentModelProvider}::${settings.agentModelName}`
                                : settings.agentModelName
                            }
                            onChange={event => {
                              const value = event.target.value
                              const separator = value.indexOf('::')
                              update(
                                'agentModelProvider',
                                separator >= 0 ? value.slice(0, separator) : '',
                              )
                              update(
                                'agentModelName',
                                separator >= 0
                                  ? value.slice(separator + 2)
                                  : value,
                              )
                            }}
                            placeholder="provider::model"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            required
                          />
                          <datalist id="bot-agent-model-options">
                            {agentCatalog?.models.map(model => (
                              <option
                                key={`${model.provider}:${model.id}`}
                                value={`${model.provider}::${model.id}`}
                              >
                                {model.name}
                              </option>
                            ))}
                          </datalist>
                        </div>
                      )}
                    </fieldset>
                  </section>

                  <section className="bot-settings-section bot-boundaries">
                    <h3>工作边界</h3>
                    <div className="bot-boundaries-card">
                      <dl>
                        <div>
                          <dt>任务归属</dt>
                          <dd>
                            {settings.routerMode === 'model'
                              ? '由 Router 模型判断'
                              : '使用确定性规则'}
                          </dd>
                        </div>
                        <div>
                          <dt>出站隐私</dt>
                          <dd>
                            {settings.privacyMode === 'mask'
                              ? '高置信度敏感值脱敏'
                              : '不额外脱敏'}
                          </dd>
                        </div>
                        <div>
                          <dt>输入处理</dt>
                          <dd>
                            {settings.rewriteMode === 'light'
                              ? '轻量校正'
                              : '保持原文'}
                          </dd>
                        </div>
                      </dl>
                      <p className="bot-boundary-note">
                        修改 Router、Provider、语音或隐私策略，请使用左侧分类。
                      </p>
                    </div>
                  </section>
                </div>
              </div>
            </div>
          ) : (
            <div className="settings-layout">
              {settingsNavigation}
              <div className="settings-main">
                <div className="settings-scroll">
                  {section === 'models' && (
                    <section
                      className="settings-section"
                      role="tabpanel"
                      id="settings-panel-models"
                      aria-labelledby="settings-tab-models"
                    >
                      <header>
                        <h2 id="models-title">模型服务</h2>
                        <p>选择供应商并配置 Pegas Router 使用的模型连接。</p>
                      </header>

                      <div className="settings-group provider-picker">
                        <span className="provider-picker-label">
                          常用供应商
                        </span>
                        <div
                          className="provider-grid"
                          role="group"
                          aria-label="常用供应商"
                        >
                          {featuredProviders?.map(provider => (
                            <ProviderOption
                              key={provider.id}
                              provider={provider}
                              checked={settings.modelProvider === provider.id}
                              onChange={() => selectProvider(provider.id)}
                            />
                          ))}
                        </div>
                        <details
                          className="provider-more"
                          open={additionalProviders?.some(
                            provider => provider.id === settings.modelProvider,
                          )}
                        >
                          <summary>更多供应商</summary>
                          <div
                            className="provider-grid"
                            role="group"
                            aria-label="更多供应商"
                          >
                            {additionalProviders?.map(provider => (
                              <ProviderOption
                                key={provider.id}
                                provider={provider}
                                checked={settings.modelProvider === provider.id}
                                onChange={() => selectProvider(provider.id)}
                              />
                            ))}
                          </div>
                        </details>
                        <p className="provider-description">
                          {selectedProvider.description}
                        </p>
                      </div>

                      <div className="provider-status" role="status">
                        <span
                          className={
                            selectedProvider.available ? 'is-ready' : ''
                          }
                        />
                        <strong>{selectedProvider.name}</strong>
                        <small>
                          {selectedProvider.available
                            ? '连接信息已就绪'
                            : (selectedProvider.reason ?? '需要完成连接配置')}
                        </small>
                      </div>

                      <div className="settings-group provider-fields">
                        {customProvider && (
                          <>
                            <label htmlFor="provider-name">连接名称</label>
                            <input
                              id="provider-name"
                              name="providerName"
                              value={providerDraft.name}
                              onChange={event => {
                                resetModelLookup()
                                setSaved(false)
                                setProviderDraft(current =>
                                  current
                                    ? { ...current, name: event.target.value }
                                    : current,
                                )
                              }}
                              maxLength={60}
                              required
                              onInput={() => setDirty(true)}
                            />
                            <label htmlFor="provider-protocol">接口协议</label>
                            <select
                              id="provider-protocol"
                              name="providerProtocol"
                              value={providerDraft.protocol}
                              onChange={event => {
                                resetModelLookup()
                                setDirty(true)
                                setSaved(false)
                                setProviderDraft(current =>
                                  current
                                    ? {
                                        ...current,
                                        protocol: event.target
                                          .value as ModelProviderDraft['protocol'],
                                      }
                                    : current,
                                )
                              }}
                            >
                              <option value="openai-chat">
                                OpenAI Chat Completions
                              </option>
                              <option value="anthropic-messages">
                                Anthropic Messages
                              </option>
                            </select>
                          </>
                        )}
                        <label htmlFor="provider-base-url">Base URL</label>
                        <input
                          id="provider-base-url"
                          name="providerBaseUrl"
                          type="url"
                          value={providerDraft.baseUrl}
                          readOnly={!customProvider}
                          onChange={event => {
                            resetModelLookup()
                            setDirty(true)
                            setSaved(false)
                            setProviderDraft(current =>
                              current
                                ? { ...current, baseUrl: event.target.value }
                                : current,
                            )
                          }}
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          required
                        />
                        <label htmlFor="provider-api-key">API key</label>
                        <div className="provider-secret-field">
                          <KeyRound aria-hidden="true" />
                          <input
                            id="provider-api-key"
                            name="providerApiKey"
                            type="password"
                            value={providerDraft.apiKey}
                            placeholder={
                              selectedProvider.hasApiKey &&
                              !providerDraft.clearApiKey
                                ? '已保存；留空保持不变'
                                : selectedProvider.requiresApiKey
                                  ? '输入 API key'
                                  : '可选'
                            }
                            onChange={event => {
                              resetModelLookup()
                              setDirty(true)
                              setSaved(false)
                              setProviderDraft(current =>
                                current
                                  ? {
                                      ...current,
                                      apiKey: event.target.value,
                                      clearApiKey: false,
                                    }
                                  : current,
                              )
                            }}
                            autoComplete="new-password"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                          />
                        </div>
                        {selectedProvider.hasApiKey && (
                          <button
                            className="clear-provider-key"
                            type="button"
                            aria-pressed={providerDraft.clearApiKey}
                            onClick={() => {
                              resetModelLookup()
                              setDirty(true)
                              setSaved(false)
                              setProviderDraft(current =>
                                current
                                  ? {
                                      ...current,
                                      apiKey: '',
                                      clearApiKey: !current.clearApiKey,
                                    }
                                  : current,
                              )
                            }}
                          >
                            {providerDraft.clearApiKey
                              ? '保留已保存密钥'
                              : '清除已保存密钥'}
                          </button>
                        )}
                        <label htmlFor="model-name">
                          Router / 输入处理模型
                        </label>
                        <div className="model-input-row">
                          <input
                            id="model-name"
                            name="modelName"
                            value={settings.modelName}
                            onChange={event =>
                              changeModelName(event.target.value)
                            }
                            aria-describedby="model-guidance"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            maxLength={160}
                            required
                          />
                          {routerModels.length > 0 && (
                            <button
                              type="button"
                              className="model-picker-toggle"
                              aria-expanded={modelPickerOpen}
                              aria-controls="router-model-picker"
                              onClick={() => {
                                setModelPickerOpen(open => !open)
                                if (!modelPickerOpen)
                                  window.requestAnimationFrame(() =>
                                    modelSearchRef.current?.focus(),
                                  )
                              }}
                            >
                              选择模型
                              <ChevronRight aria-hidden="true" />
                            </button>
                          )}
                        </div>
                        {routerModels.length > 0 && (
                          <div
                            id="router-model-picker"
                            className="model-picker-panel"
                            hidden={!modelPickerOpen}
                          >
                            <div className="model-picker-head">
                              <strong>
                                {String(routerModels.length)} 个可选模型
                              </strong>
                              <span>选中后填入上方模型 ID</span>
                            </div>
                            <label htmlFor="router-model-search">
                              搜索已获取模型
                            </label>
                            <div className="model-picker-search">
                              <Search aria-hidden="true" />
                              <input
                                ref={modelSearchRef}
                                id="router-model-search"
                                name="modelSearch"
                                type="search"
                                value={modelSearch}
                                onChange={event =>
                                  setModelSearch(event.target.value)
                                }
                                onKeyDown={event => {
                                  if (event.key === 'Enter')
                                    event.preventDefault()
                                  if (event.key === 'Escape') {
                                    event.preventDefault()
                                    setModelPickerOpen(false)
                                  }
                                }}
                                placeholder="按名称或 ID 查找"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                              />
                            </div>
                            <div
                              className="model-picker-list"
                              role="group"
                              aria-label="可选模型"
                            >
                              {shownModels.map(model => (
                                <button
                                  type="button"
                                  key={model.id}
                                  className={
                                    settings.modelName === model.id
                                      ? 'is-selected'
                                      : undefined
                                  }
                                  aria-label={`选择模型 ${model.id}`}
                                  onClick={() => {
                                    changeModelName(model.id)
                                    setModelPickerOpen(false)
                                    setModelSearch('')
                                  }}
                                >
                                  <span>{model.name}</span>
                                  {model.name !== model.id && (
                                    <code>{model.id}</code>
                                  )}
                                  {settings.modelName === model.id && (
                                    <Check aria-hidden="true" />
                                  )}
                                </button>
                              ))}
                              {filteredModels.length === 0 && (
                                <p>没有匹配的模型。可直接在上方填写模型 ID。</p>
                              )}
                            </div>
                            {filteredModels.length > shownModels.length && (
                              <p className="model-picker-more">
                                当前显示前 50 个结果，输入关键词可查找其余模型。
                              </p>
                            )}
                          </div>
                        )}
                        <div className="model-actions">
                          <button
                            type="button"
                            onClick={() => void discoverModels()}
                            disabled={Boolean(modelAction)}
                          >
                            {modelAction === 'discovering'
                              ? '正在获取…'
                              : routerModels.length > 0
                                ? '刷新模型列表'
                                : '获取模型列表'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void testSelectedModel()}
                            disabled={
                              Boolean(modelAction) || !settings.modelName.trim()
                            }
                          >
                            {modelAction === 'testing'
                              ? '正在测试…'
                              : '测试连接'}
                          </button>
                        </div>
                        <p id="model-guidance" className="model-action-status">
                          可手动填写模型 ID；获取列表后也可搜索选择。
                        </p>
                        {modelNotListed && (
                          <p className="model-mismatch">
                            当前模型不在刚获取的列表中。请选择列表中的模型，或继续测试手填值。
                          </p>
                        )}
                        {modelFeedback && (
                          <div
                            className={`model-feedback is-${modelFeedback.kind}`}
                            role="status"
                            aria-live="polite"
                          >
                            {modelFeedback.kind === 'success' ? (
                              <CircleCheck aria-hidden="true" />
                            ) : modelFeedback.kind === 'error' ? (
                              <CircleAlert aria-hidden="true" />
                            ) : (
                              <Circle aria-hidden="true" />
                            )}
                            <div>
                              <strong>{modelFeedback.title}</strong>
                              <span>{modelFeedback.description}</span>
                            </div>
                          </div>
                        )}
                      </div>

                      <fieldset className="settings-choice-group agent-model-group">
                        <legend>Agent 执行模型</legend>
                        <SettingChoice
                          name="agent-model-mode"
                          value="profile"
                          checked={settings.agentModelMode === 'profile'}
                          title="跟随 DSH profile"
                          description={
                            agentCatalog
                              ? `当前默认 ${agentCatalog.defaultProvider} / ${agentCatalog.defaultModel}`
                              : '由运行环境的 DSH profile 决定。'
                          }
                          onChange={() => update('agentModelMode', 'profile')}
                        />
                        <SettingChoice
                          name="agent-model-mode"
                          value="override"
                          checked={settings.agentModelMode === 'override'}
                          title="覆盖新 Agent session"
                          description="只影响新建 session；恢复中的 Task 继续沿用原模型。"
                          onChange={() => update('agentModelMode', 'override')}
                        />
                        {settings.agentModelMode === 'override' && (
                          <div className="agent-model-field">
                            <label htmlFor="agent-model-name">
                              DSH provider 与模型
                            </label>
                            <input
                              id="agent-model-name"
                              list="agent-model-options"
                              value={
                                settings.agentModelProvider
                                  ? `${settings.agentModelProvider}::${settings.agentModelName}`
                                  : settings.agentModelName
                              }
                              onChange={event => {
                                const value = event.target.value
                                const separator = value.indexOf('::')
                                update(
                                  'agentModelProvider',
                                  separator >= 0
                                    ? value.slice(0, separator)
                                    : '',
                                )
                                update(
                                  'agentModelName',
                                  separator >= 0
                                    ? value.slice(separator + 2)
                                    : value,
                                )
                              }}
                              placeholder="provider::model"
                              autoCapitalize="none"
                              autoCorrect="off"
                              spellCheck={false}
                              required
                            />
                            <datalist id="agent-model-options">
                              {agentCatalog?.models.map(model => (
                                <option
                                  key={`${model.provider}:${model.id}`}
                                  value={`${model.provider}::${model.id}`}
                                >
                                  {model.name}
                                </option>
                              ))}
                            </datalist>
                          </div>
                        )}
                      </fieldset>
                    </section>
                  )}

                  {section === 'routing' && (
                    <section
                      className="settings-section"
                      role="tabpanel"
                      id="settings-panel-routing"
                      aria-labelledby="settings-tab-routing"
                    >
                      <header>
                        <h2 id="routing-title">任务路由</h2>
                        <p>决定新消息继续已有任务，还是创建一件新事情。</p>
                      </header>
                      <fieldset className="settings-choice-group">
                        <legend>路由方式</legend>
                        <SettingChoice
                          name="router-mode"
                          value="model"
                          checked={settings.routerMode === 'model'}
                          title="智能归类"
                          description="由所选模型判断任务归属；不确定时安全新建任务。"
                          onChange={() => update('routerMode', 'model')}
                        />
                        <SettingChoice
                          name="router-mode"
                          value="rules"
                          checked={settings.routerMode === 'rules'}
                          title="确定性规则"
                          description="只有明确指定任务时才续接，其余消息一律新建。"
                          onChange={() => update('routerMode', 'rules')}
                        />
                      </fieldset>
                    </section>
                  )}

                  {section === 'privacy' && (
                    <section
                      className="settings-section"
                      role="tabpanel"
                      id="settings-panel-privacy"
                      aria-labelledby="settings-tab-privacy"
                    >
                      <header>
                        <h2 id="privacy-title">模型出站隐私</h2>
                        <p>
                          内容离开 Worker 前替换高置信度敏感值，返回后恢复。
                        </p>
                      </header>
                      <fieldset className="settings-choice-group">
                        <legend>脱敏策略</legend>
                        <SettingChoice
                          name="privacy-mode"
                          value="mask"
                          checked={settings.privacyMode === 'mask'}
                          title="开启脱敏"
                          description={
                            capabilities.privacyAvailable
                              ? '保护密钥、密码、邮箱和手机号；权威记录保留原文。'
                              : '服务端尚未配置隐私 HMAC key。'
                          }
                          disabled={!capabilities.privacyAvailable}
                          onChange={() => update('privacyMode', 'mask')}
                        />
                        <SettingChoice
                          name="privacy-mode"
                          value="disabled"
                          checked={settings.privacyMode === 'disabled'}
                          title="关闭脱敏"
                          description="适合完全受控的本地模型链路。"
                          onChange={() => update('privacyMode', 'disabled')}
                        />
                      </fieldset>
                    </section>
                  )}

                  {section === 'rewrite' && (
                    <section
                      className="settings-section"
                      role="tabpanel"
                      id="settings-panel-rewrite"
                      aria-labelledby="settings-tab-rewrite"
                    >
                      <header>
                        <h2 id="rewrite-title">语音与输入</h2>
                        <p>连接语音识别服务，把录音转成可编辑文字。</p>
                      </header>
                      <div className="voice-settings-card">
                        <div className="settings-card-icon">
                          <Mic aria-hidden="true" />
                        </div>
                        <div>
                          <h3>语音输入</h3>
                          <p>在对话输入框中听写，转成可编辑文字后再发送。</p>
                        </div>
                        <span>{speechStatus}</span>
                      </div>
                      <fieldset className="settings-choice-group voice-provider-choice">
                        <legend>转写服务</legend>
                        <SettingChoice
                          name="speech-provider"
                          value="disabled"
                          checked={speechDraft?.provider === 'disabled'}
                          title="关闭语音输入"
                          description="麦克风按钮会引导到此页面。"
                          onChange={() => updateSpeech('provider', 'disabled')}
                        />
                        <SettingChoice
                          name="speech-provider"
                          value="openai-compatible"
                          checked={
                            speechDraft?.provider === 'openai-compatible'
                          }
                          title="OpenAI 兼容转写服务"
                          description="连接支持 /audio/transcriptions 的服务。"
                          onChange={() =>
                            updateSpeech('provider', 'openai-compatible')
                          }
                        />
                      </fieldset>
                      {speechDraft?.provider === 'openai-compatible' && (
                        <div className="speech-configuration">
                          <div className="speech-fields">
                            <label
                              className="settings-text-field"
                              htmlFor="speech-base-url"
                            >
                              <span>服务地址</span>
                              <input
                                id="speech-base-url"
                                type="url"
                                value={speechDraft.baseUrl}
                                placeholder="http://127.0.0.1:18081/v1"
                                required
                                onChange={event =>
                                  updateSpeech('baseUrl', event.target.value)
                                }
                              />
                              <small>
                                填写 API 根地址；Pegas 会调用
                                /audio/transcriptions。
                              </small>
                            </label>
                            <label
                              className="settings-text-field"
                              htmlFor="speech-model"
                            >
                              <span>语音识别模型</span>
                              <input
                                id="speech-model"
                                value={speechDraft.model}
                                required
                                onChange={event =>
                                  updateSpeech('model', event.target.value)
                                }
                              />
                            </label>
                            <label
                              className="settings-text-field"
                              htmlFor="speech-api-key"
                            >
                              <span>API key（可选）</span>
                              <input
                                id="speech-api-key"
                                type="password"
                                value={speechDraft.apiKey}
                                autoComplete="off"
                                placeholder={
                                  speechDraft.hasApiKey &&
                                  !speechDraft.clearApiKey
                                    ? '已保存，留空则保持不变'
                                    : '本地服务可留空'
                                }
                                onChange={event =>
                                  updateSpeech('apiKey', event.target.value)
                                }
                              />
                              <small>
                                密钥加密保存在服务端，不会显示原文。
                              </small>
                            </label>
                            {speechDraft.hasApiKey && (
                              <label className="speech-clear-key">
                                <input
                                  type="checkbox"
                                  checked={speechDraft.clearApiKey}
                                  onChange={event =>
                                    updateSpeech(
                                      'clearApiKey',
                                      event.target.checked,
                                    )
                                  }
                                />
                                清除已保存的 API key
                              </label>
                            )}
                          </div>
                          <SpeechConnectionTest
                            api={api}
                            speech={speechDraft}
                          />
                        </div>
                      )}
                      <p className="speech-browser-status">
                        浏览器录音：
                        {'mediaDevices' in navigator &&
                        typeof navigator.mediaDevices.getUserMedia ===
                          'function'
                          ? '可用（仍需允许麦克风权限）'
                          : '当前浏览器不支持'}
                      </p>
                      <fieldset className="settings-choice-group">
                        <legend>改写策略</legend>
                        <SettingChoice
                          name="rewrite-mode"
                          value="light"
                          checked={settings.rewriteMode === 'light'}
                          title="轻量校正"
                          description="修正明显的识别错误、口头语和标点，不补充事实。"
                          onChange={() => update('rewriteMode', 'light')}
                        />
                        <SettingChoice
                          name="rewrite-mode"
                          value="disabled"
                          checked={settings.rewriteMode === 'disabled'}
                          title="保持原文"
                          description="Router 与 Executor 直接使用用户发送的文字。"
                          onChange={() => update('rewriteMode', 'disabled')}
                        />
                      </fieldset>
                      {settings.rewriteMode === 'light' && rewriteDraft && (
                        <div className="rewrite-configuration">
                          <fieldset className="settings-choice-group rewrite-source-choice">
                            <legend>改写模型来源</legend>
                            <SettingChoice
                              name="rewrite-source"
                              value="router"
                              checked={rewriteDraft.mode === 'router'}
                              title="跟随 Router 模型"
                              description="使用模型页选择的连接与模型。"
                              onChange={() => updateRewrite('mode', 'router')}
                            />
                            <SettingChoice
                              name="rewrite-source"
                              value="custom"
                              checked={rewriteDraft.mode === 'custom'}
                              title="独立改写服务"
                              description="为文字校正单独指定服务和模型。"
                              onChange={() => updateRewrite('mode', 'custom')}
                            />
                          </fieldset>
                          {rewriteDraft.mode === 'custom' && (
                            <div className="rewrite-fields">
                              <label
                                className="settings-text-field"
                                htmlFor="rewrite-protocol"
                              >
                                <span>接口协议</span>
                                <select
                                  id="rewrite-protocol"
                                  value={rewriteDraft.protocol}
                                  onChange={event =>
                                    updateRewrite(
                                      'protocol',
                                      event.target
                                        .value as RewriteSettingsDraft['protocol'],
                                    )
                                  }
                                >
                                  <option value="openai-chat">
                                    OpenAI Chat Completions
                                  </option>
                                  <option value="anthropic-messages">
                                    Anthropic Messages
                                  </option>
                                </select>
                              </label>
                              <label
                                className="settings-text-field"
                                htmlFor="rewrite-base-url"
                              >
                                <span>API 根地址</span>
                                <input
                                  id="rewrite-base-url"
                                  type="url"
                                  required
                                  placeholder="http://127.0.0.1:3425/v1"
                                  value={rewriteDraft.baseUrl}
                                  onChange={event =>
                                    updateRewrite('baseUrl', event.target.value)
                                  }
                                />
                              </label>
                              <label
                                className="settings-text-field"
                                htmlFor="rewrite-model"
                              >
                                <span>改写模型</span>
                                <input
                                  id="rewrite-model"
                                  required
                                  value={rewriteDraft.model}
                                  placeholder="provider/model"
                                  onChange={event =>
                                    updateRewrite('model', event.target.value)
                                  }
                                />
                              </label>
                              <label
                                className="settings-text-field"
                                htmlFor="rewrite-api-key"
                              >
                                <span>API key（可选）</span>
                                <input
                                  id="rewrite-api-key"
                                  type="password"
                                  autoComplete="off"
                                  value={rewriteDraft.apiKey}
                                  placeholder={
                                    rewriteDraft.hasApiKey &&
                                    !rewriteDraft.clearApiKey
                                      ? '已保存，留空则保持不变'
                                      : '本地服务可留空'
                                  }
                                  onChange={event =>
                                    updateRewrite('apiKey', event.target.value)
                                  }
                                />
                              </label>
                              {rewriteDraft.hasApiKey && (
                                <label className="speech-clear-key">
                                  <input
                                    type="checkbox"
                                    checked={rewriteDraft.clearApiKey}
                                    onChange={event =>
                                      updateRewrite(
                                        'clearApiKey',
                                        event.target.checked,
                                      )
                                    }
                                  />
                                  清除已保存的 API key
                                </label>
                              )}
                            </div>
                          )}
                          <RewriteConnectionTest
                            api={api}
                            rewrite={rewriteDraft}
                            settings={settings}
                            provider={providerDraft}
                          />
                        </div>
                      )}
                    </section>
                  )}
                </div>
              </div>
            </div>
          )}

          <footer className="settings-footer">
            <div aria-live="polite" role="status">
              {saving
                ? '正在保存更改'
                : saved
                  ? '更改已保存'
                  : dirty
                    ? '有未保存的更改'
                    : '设置已同步'}
            </div>
            <button type="submit" disabled={saving || !canSave}>
              {saving ? '正在保存…' : '保存更改'}
            </button>
          </footer>
        </form>
      ) : null}

      {error && (
        <div className="settings-error" role="alert">
          <CircleAlert aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
    </section>
  )
}

function RewriteConnectionTest({
  api,
  rewrite,
  settings,
  provider,
}: {
  api: SettingsClient
  rewrite: RewriteSettingsDraft
  settings: RuntimeSettings
  provider: ModelProviderDraft
}) {
  const [sample, setSample] = useState(
    '呃，帮我把明天上午的会议安排一下，然后提醒我带上材料。',
  )
  const [result, setResult] = useState<{
    original: string
    rewritten: string
    changed: boolean
    latencyMs: number
  }>()
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)
  const requestId = useRef(0)
  useEffect(() => {
    requestId.current += 1
    setResult(undefined)
    setError('')
    setTesting(false)
  }, [
    rewrite.mode,
    rewrite.protocol,
    rewrite.baseUrl,
    rewrite.model,
    rewrite.apiKey,
    rewrite.clearApiKey,
    settings.modelProvider,
    settings.modelName,
    settings.privacyMode,
    provider.baseUrl,
    provider.protocol,
    provider.apiKey,
    provider.clearApiKey,
  ])
  const test = async () => {
    const activeId = ++requestId.current
    setTesting(true)
    setError('')
    setResult(undefined)
    try {
      const response = await api.testRewrite(
        sample,
        rewrite,
        settings,
        provider,
      )
      if (activeId === requestId.current) setResult(response)
    } catch (caught) {
      if (activeId === requestId.current)
        setError(
          caught instanceof Error
            ? caught.message
            : '改写测试失败，请检查连接后重试',
        )
    } finally {
      if (activeId === requestId.current) setTesting(false)
    }
  }
  return (
    <div className="rewrite-test-panel">
      <div>
        <strong>试写一段文字</strong>
        <p>用当前填写的连接测试，结果仅用于预览，不会保存设置或发送消息。</p>
      </div>
      <label htmlFor="rewrite-sample">测试文本</label>
      <textarea
        id="rewrite-sample"
        value={sample}
        maxLength={4000}
        rows={3}
        onChange={event => {
          requestId.current += 1
          setSample(event.target.value)
          setResult(undefined)
          setTesting(false)
        }}
      />
      <button
        type="button"
        className="speech-test-button"
        disabled={
          testing ||
          !sample.trim() ||
          (rewrite.mode === 'custom' &&
            (!rewrite.baseUrl.trim() || !rewrite.model.trim()))
        }
        onClick={() => void test()}
      >
        {testing ? '正在测试…' : '测试改写'}
      </button>
      {result && (
        <div className="rewrite-test-result" role="status">
          <strong>
            {result.changed ? '改写完成' : '未发现需要校正的内容'} ·{' '}
            {(result.latencyMs / 1000).toFixed(1)} 秒
          </strong>
          <div className="rewrite-result-grid">
            <div>
              <span>原文</span>
              <p>{result.original}</p>
            </div>
            <div>
              <span>改写后</span>
              <p>{result.rewritten}</p>
            </div>
          </div>
        </div>
      )}
      {error && (
        <p className="speech-test-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function SpeechConnectionTest({
  api,
  speech,
}: {
  api: SettingsClient
  speech: SpeechSettingsDraft
}) {
  const [result, setResult] = useState<{
    text: string
    latencyMs: number
  }>()
  useEffect(
    () => setResult(undefined),
    [speech.baseUrl, speech.model, speech.apiKey, speech.clearApiKey],
  )
  const dictation = useVoiceDictation({
    maximumSeconds: 20,
    transcribe: async audio => {
      const tested = await api.testSpeechConnection(audio, speech)
      setResult({ text: tested.transcript.text, latencyMs: tested.latencyMs })
      return tested.transcript
    },
  })
  const busy =
    dictation.state === 'requesting' || dictation.state === 'transcribing'
  return (
    <div className="speech-test-panel">
      <div>
        <strong>测试语音识别</strong>
        <p>
          用当前填写的连接录一小段话，看看识别效果。测试不会保存设置或发送消息。
        </p>
      </div>
      <button
        type="button"
        className="speech-test-button"
        disabled={busy || !speech.baseUrl.trim() || !speech.model.trim()}
        onClick={() => {
          if (dictation.state === 'idle') setResult(undefined)
          dictation.toggle()
        }}
      >
        <Mic aria-hidden="true" />
        {dictation.state === 'recording'
          ? `结束并识别 · ${formatDuration(dictation.elapsedSeconds)}`
          : dictation.state === 'requesting'
            ? '正在请求麦克风…'
            : dictation.state === 'transcribing'
              ? '正在识别…'
              : '录一段测试'}
      </button>
      {result && (
        <div className="speech-test-result" role="status">
          <strong>识别成功 · {(result.latencyMs / 1000).toFixed(1)} 秒</strong>
          <p>{result.text}</p>
        </div>
      )}
      {dictation.error && (
        <p className="speech-test-error" role="alert">
          {dictation.error}
        </p>
      )}
    </div>
  )
}

function ProviderOption({
  provider,
  checked,
  onChange,
}: {
  provider: SettingsCapabilities['providers'][number]
  checked: boolean
  onChange: () => void
}) {
  const id = `provider-${provider.id}`
  return (
    <label className="provider-option" htmlFor={id}>
      <input
        id={id}
        type="radio"
        name="modelProvider"
        value={provider.id}
        checked={checked}
        onChange={onChange}
      />
      <span>{provider.id === 'custom' ? '自定义' : provider.name}</span>
      <small>
        {provider.hasApiKey
          ? '已配置'
          : provider.category === 'local'
            ? '本地'
            : ''}
      </small>
    </label>
  )
}

function providerDraftFrom(
  provider: SettingsCapabilities['providers'][number],
): ModelProviderDraft {
  return {
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: '',
    clearApiKey: false,
  }
}

function SettingChoice({
  name,
  value,
  checked,
  title,
  description,
  disabled = false,
  onChange,
}: {
  name: string
  value: string
  checked: boolean
  title: string
  description: string
  disabled?: boolean
  onChange: () => void
}) {
  const id = `${name}-${value}`
  return (
    <label
      className={`setting-choice${disabled ? ' is-disabled' : ''}`}
      htmlFor={id}
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </label>
  )
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(
    2,
    '0',
  )}`
}

function TokenForm({
  onSubmit,
}: {
  onSubmit: (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => void
}) {
  return (
    <form className="token-form" onSubmit={onSubmit}>
      <div>
        <strong>连接 Pegas</strong>
        <p>这个服务启用了访问令牌。令牌只保存在当前浏览器会话中。</p>
      </div>
      <label htmlFor="api-token">访问令牌</label>
      <div className="token-input-row">
        <input
          id="api-token"
          name="token"
          type="password"
          autoComplete="off"
          required
        />
        <button type="submit">连接</button>
      </div>
    </form>
  )
}

const starterPrompts = [
  {
    title: '梳理一个计划',
    description: '把模糊想法变成可执行的下一步',
    prompt: '帮我把这个想法梳理成一份清晰的执行计划：',
    icon: ListTodo,
  },
  {
    title: '研究并比较',
    description: '收集信息，给出有依据的建议',
    prompt: '帮我研究并比较下面这个问题，最后给我一个建议：',
    icon: Search,
  },
  {
    title: '持续跟进',
    description: '记住目标，在关键节点再联系你',
    prompt: '请持续跟进这件事，只在需要我判断或完成时告诉我：',
    icon: Clock3,
  },
]

function EmptyConversation({
  activeTaskCount,
  onPrompt,
}: {
  activeTaskCount: number
  onPrompt: (prompt: string) => void
}) {
  return (
    <div className="empty-conversation">
      <div className="empty-hero">
        <div className="empty-mark">
          <Sparkles aria-hidden="true" />
        </div>
        <p className="empty-eyebrow">你的个人智能代理</p>
        <h2>现在想先推进什么？</h2>
        <p>
          直接说出目标，不必先创建项目或挑选工具。Pegas
          会组织这些事情、持续执行，并在真正需要你时回来。
        </p>
      </div>

      <div className="starter-grid" aria-label="常用开始方式">
        {starterPrompts.map(({ title, description, prompt, icon: Icon }) => (
          <button key={title} type="button" onClick={() => onPrompt(prompt)}>
            <span className="starter-icon">
              <Icon aria-hidden="true" />
            </span>
            <span>
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
            <ArrowUpRight aria-hidden="true" />
          </button>
        ))}
      </div>

      <div className="trust-strip" aria-label="Pegas 工作方式">
        <span>
          <span className="trust-value">{activeTaskCount}</span>
          件事情正在推进
        </span>
        <span>
          <ShieldCheck aria-hidden="true" />
          高风险动作会先确认
        </span>
        <span>
          <ListTodo aria-hidden="true" />
          过程与结果随时可查
        </span>
      </div>
    </div>
  )
}

function ConversationSkeleton() {
  return (
    <div className="conversation-skeleton" aria-label="正在载入对话">
      <span />
      <span />
      <span />
    </div>
  )
}

function UserMessage({ event }: { event: InboxEvent }) {
  return (
    <article className="message-row is-user">
      <div>
        <p>{payloadText(event.payload, '消息内容不可用')}</p>
        <div className="message-meta">
          <time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time>
          <span>{eventStatusCopy(event.status)}</span>
        </div>
      </div>
    </article>
  )
}

function PegasMessage({
  message,
  run,
  task,
}: {
  message: OutboxMessage
  run?: Run
  task?: WorkChannel
}) {
  const payload = asRecord(message.payload)
  const failed = payload?.type === 'run.failed'
  const result = failed
    ? recordString(payload, 'error', '任务执行失败，请查看任务详情。')
    : recordString(payload, 'text', '任务状态已经更新。')
  const text =
    run?.executor === 'echo-test' && !failed
      ? `Echo 测试执行器已经完成验证，并原样返回了输入：“${result}”`
      : result
  return (
    <article className={`message-row is-pegas${failed ? ' is-error' : ''}`}>
      <div className="message-avatar" aria-hidden="true">
        <PegasAgentIcon
          iconId={task?.workerIconId ?? 'bot'}
          status={task?.status}
          size={28}
        />
      </div>
      <div>
        <MarkdownMessage content={text} />
        <div className="assistant-message-meta">
          <time dateTime={message.createdAt}>
            {formatTime(message.createdAt)}
          </time>
          <div className="message-actions" aria-label="消息操作">
            <button type="button" aria-label="添加回应">
              <DsSmileIcon />
            </button>
            <button type="button" aria-label="回复">
              <DsReplyIcon />
            </button>
            <button type="button" aria-label="更多操作">
              <DsDotsIcon />
            </button>
          </div>
        </div>
      </div>
    </article>
  )
}

function eventStatusCopy(status: InboxEvent['status']): string {
  switch (status) {
    case 'pending':
      return '已送达'
    case 'processing':
      return '正在分配'
    case 'processed':
      return '已进入 Channel'
    case 'failed':
      return '处理失败'
  }
}

function TaskPulse({
  task,
  runs,
  onOpen,
}: {
  task: Task
  runs: Run[]
  onOpen: () => void
}) {
  const latestRun = runs.at(-1)
  return (
    <button
      className={`task-pulse status-${task.status}`}
      onClick={onOpen}
      aria-label={`查看 Channel：${task.title}`}
    >
      <div className="task-pulse-head">
        <PegasAgentIcon
          iconId={task.workerIconId ?? fallbackWorkerIconId(task.id)}
          status={task.status}
          size={24}
        />
        <span className={`status-dot status-${task.status}`} />
        <span>{statusCopy[task.status]}</span>
        <time dateTime={task.updatedAt}>
          {formatRelativeTime(task.updatedAt)}
        </time>
      </div>
      <strong>{task.title}</strong>
      <p>
        {task.statusReason
          ? reasonCopy(task.statusReason)
          : taskSubtitle(task, latestRun)}
      </p>
      <div className="task-stage" aria-label={taskStageLabel(task.status)}>
        {[0, 1, 2, 3].map(stage => (
          <span
            className={stage <= taskStageIndex(task.status) ? 'is-reached' : ''}
            key={stage}
          />
        ))}
      </div>
      <div className="task-pulse-foot">
        <span>
          {runs.length > 0
            ? `${String(runs.length)} 次执行`
            : '正在建立执行计划'}
        </span>
        <span>
          查看详情 <ChevronRight aria-hidden="true" />
        </span>
      </div>
    </button>
  )
}

function outboxTitle(message: OutboxMessage): string {
  const payload = asRecord(message.payload)
  switch (recordString(payload, 'type', '')) {
    case 'run.completed':
      return 'Channel 已完成'
    case 'run.failed':
      return '执行失败，需要处理'
    case 'run.acknowledged':
      return 'Worker 已开始处理'
    case 'agent.message':
      return 'Pegas 消息'
    default:
      return '工作状态更新'
  }
}

function outboxSummary(message: OutboxMessage): string {
  const payload = asRecord(message.payload)
  return recordString(
    payload,
    'text',
    recordString(payload, 'error', '打开查看详情'),
  )
}

function outboxDeliveryCopy(status: OutboxMessage['status']): string {
  switch (status) {
    case 'pending':
      return '等待投递'
    case 'sending':
      return '正在投递'
    case 'sent':
      return '已投递'
    case 'failed':
      return '投递失败'
    case 'unknown':
      return '投递状态未知'
  }
}

function OutboxPage({
  messages,
  channels,
  selectedId,
  onSelect,
  onOpenChannel,
}: {
  messages: OutboxMessage[]
  channels: WorkChannel[]
  selectedId: string
  onSelect: (messageId: string) => void
  onOpenChannel: (channelId: string) => void
}) {
  const sorted = messages.toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )
  const selected =
    sorted.find(message => message.id === selectedId) ?? sorted[0]
  const source = selected?.taskId
    ? channels.find(channel => channel.id === selected.taskId)
    : undefined

  return (
    <section className="outbox-page" aria-labelledby="outbox-page-title">
      <header className="outbox-intro">
        <div>
          <h2 id="outbox-page-title">需要你关注的消息</h2>
          <p>已读状态与外部投递状态分开记录。</p>
        </div>
        <span className="outbox-unread-total">
          {String(messages.filter(message => !message.readAt).length)} 条未读
        </span>
      </header>

      {sorted.length === 0 ? (
        <div className="outbox-empty">
          <MessageSquareText aria-hidden="true" />
          <h3>目前没有需要处理的消息</h3>
          <p>重要结果、失败和等待你决定的事项会出现在这里。</p>
        </div>
      ) : (
        <div className="outbox-layout">
          <section className="outbox-list" aria-labelledby="outbox-list-title">
            <h3 id="outbox-list-title">消息列表</h3>
            <ul role="list">
              {sorted.map(message => (
                <li key={message.id}>
                  <button
                    type="button"
                    className={
                      selected?.id === message.id ? 'is-selected' : undefined
                    }
                    aria-current={
                      selected?.id === message.id ? 'true' : undefined
                    }
                    onClick={() => onSelect(message.id)}
                  >
                    <span className="outbox-list-title">
                      {!message.readAt && (
                        <span
                          className="outbox-unread-dot"
                          aria-hidden="true"
                        />
                      )}
                      {outboxTitle(message)}
                    </span>
                    <span>{outboxSummary(message)}</span>
                    <time dateTime={message.createdAt}>
                      {formatRelativeTime(message.createdAt)}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {selected && (
            <article
              className="outbox-detail"
              aria-labelledby="outbox-detail-title"
            >
              <header>
                <span
                  className={`outbox-read-state${selected.readAt ? '' : ' is-unread'}`}
                >
                  {selected.readAt ? '已读' : '未读'}
                </span>
                <h3 id="outbox-detail-title">{outboxTitle(selected)}</h3>
                <time dateTime={selected.createdAt}>
                  {new Date(selected.createdAt).toLocaleString('zh-CN')}
                </time>
              </header>
              <p className="outbox-detail-copy">{outboxSummary(selected)}</p>
              <dl>
                <div>
                  <dt>产品状态</dt>
                  <dd>{selected.readAt ? '已读' : '未读'}</dd>
                </div>
                <div>
                  <dt>投递状态</dt>
                  <dd>{outboxDeliveryCopy(selected.status)}</dd>
                </div>
                {source && (
                  <div>
                    <dt>来源 Channel</dt>
                    <dd>
                      <button
                        type="button"
                        onClick={() => onOpenChannel(source.id)}
                      >
                        {source.title}
                      </button>
                    </dd>
                  </div>
                )}
              </dl>
            </article>
          )}
        </div>
      )}
    </section>
  )
}

const taskColumns: {
  id: string
  title: string
  description: string
  statuses: TaskStatus[]
}[] = [
  {
    id: 'planned',
    title: '待安排',
    description: '已接收，正在形成计划',
    statuses: ['backlog'],
  },
  {
    id: 'unstarted',
    title: '未开始',
    description: '已安排，等待执行',
    statuses: ['unstarted'],
  },
  {
    id: 'active',
    title: '进行中',
    description: '目标正在推进',
    statuses: ['started'],
  },
  {
    id: 'finished',
    title: '已完成',
    description: '目标已完成',
    statuses: ['completed'],
  },
  {
    id: 'cancelled',
    title: '已取消',
    description: '不再继续的目标',
    statuses: ['cancelled'],
  },
]

function TasksPage({
  tasks,
  runs,
  onOpen,
}: {
  tasks: Task[]
  runs: Run[]
  onOpen: (taskId: string) => void
}) {
  const [query, setQuery] = useState('')
  const visibleTasks = tasks.filter(task =>
    `${task.title} ${task.goal}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  )
  return (
    <section className="tasks-page" aria-labelledby="task-board-title">
      <section className="home-profile" aria-labelledby="home-profile-title">
        <div className="home-profile-mark" aria-hidden="true">
          <PegasAgentIcon iconId="bot" size={36} />
        </div>
        <div>
          <h2 id="home-profile-title">Pegas</h2>
          <p>把你的输入组织成可追踪、可恢复的工作 Channel。</p>
        </div>
        <span className="home-profile-status">
          <span aria-hidden="true" /> 在线
        </span>
      </section>
      <header className="tasks-intro">
        <div>
          <h2 id="task-board-title">
            <Columns3 aria-hidden="true" />
            Channels
          </h2>
          <span className="board-total">{tasks.length} 个 Channel</span>
        </div>
        <label className="task-search">
          <Search aria-hidden="true" />
          <input
            aria-label="搜索 Channel"
            placeholder="搜索 Channel…"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </label>
        <dl className="task-summary">
          <div>
            <dt>进行中</dt>
            <dd>
              {String(tasks.filter(task => isActiveTask(task.status)).length)}
            </dd>
          </div>
          <div>
            <dt>已完成</dt>
            <dd>
              {String(tasks.filter(task => task.status === 'completed').length)}
            </dd>
          </div>
        </dl>
      </header>

      <div className="task-board" aria-label="按状态分组的 Channels">
        {taskColumns.map(column => {
          const columnTasks = visibleTasks.filter(task =>
            column.statuses.includes(task.status),
          )
          return (
            <section
              className="task-column"
              key={column.id}
              aria-labelledby={`column-${column.id}`}
            >
              <header>
                <div>
                  {column.id === 'planned' ? (
                    <CircleDashed aria-hidden="true" />
                  ) : column.id === 'active' ? (
                    <CircleDot aria-hidden="true" />
                  ) : column.id === 'unstarted' ? (
                    <Circle aria-hidden="true" />
                  ) : column.id === 'cancelled' ? (
                    <CircleX aria-hidden="true" />
                  ) : (
                    <CircleCheck aria-hidden="true" />
                  )}
                  <h3 id={`column-${column.id}`}>{column.title}</h3>
                  <span>{columnTasks.length}</span>
                </div>
                <p>{column.description}</p>
              </header>
              <div className="task-column-list">
                {columnTasks.length === 0 ? (
                  <div className="task-column-empty">
                    <span>{query ? '没有匹配的 Channel' : '暂无 Channel'}</span>
                  </div>
                ) : (
                  columnTasks.map(task => {
                    const taskRuns = runs.filter(run => run.taskId === task.id)
                    return (
                      <button
                        className="task-board-card"
                        key={task.id}
                        onClick={() => onOpen(task.id)}
                        aria-label={`打开 Channel 现场：${task.title}`}
                      >
                        <span className="task-card-id">
                          <PegasAgentIcon
                            iconId={
                              task.workerIconId ?? fallbackWorkerIconId(task.id)
                            }
                            status={task.status}
                            size={24}
                          />
                          {task.id.slice(0, 8).toUpperCase()}
                          <ArrowUpRight aria-hidden="true" />
                        </span>
                        <strong>{task.title}</strong>
                        <p>{task.goal}</p>
                        {taskRuns.at(-1)?.status === 'failed' &&
                          isActiveTask(task.status) && (
                            <span className="run-error">
                              最近执行失败 · 可重试
                            </span>
                          )}
                        {task.statusReason === 'awaiting_user_review' && (
                          <span className="task-state">等待你的确认</span>
                        )}
                        <span className="task-card-meta">
                          <span className={`task-state status-${task.status}`}>
                            <span className="status-dot" />
                            {statusCopy[task.status]}
                          </span>
                          <span>
                            {taskRuns.length > 0
                              ? `${String(taskRuns.length)} 次执行`
                              : '尚无执行记录'}
                          </span>
                          <time dateTime={task.updatedAt}>
                            {formatRelativeTime(task.updatedAt)}
                          </time>
                        </span>
                      </button>
                    )
                  })
                )}
              </div>
            </section>
          )
        })}
      </div>
    </section>
  )
}

function WorkspacePanel({
  onRetry,
  onStop,
  onNewRelated,
  open,
  selectedTask,
  runs,
  onClose,
  compact,
}: {
  onRetry: (runId: string) => Promise<void>
  onStop: (taskId: string) => Promise<void>
  onNewRelated: () => void
  open: boolean
  selectedTask?: WorkChannel
  runs: Run[]
  onClose: () => void
  compact: boolean
}) {
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open || !panel.current) return
    const element = panel.current
    const initial = element.querySelector<HTMLElement>('[data-workspace-focus]')
    if (compact) window.requestAnimationFrame(() => initial?.focus())
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (!compact || event.key !== 'Tab') return
      const focusable = Array.from(
        element.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
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
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [compact, onClose, open])

  if (!open) return null
  return (
    <aside
      ref={panel}
      className="workspace-panel"
      aria-label="工作区"
      aria-modal={compact ? true : undefined}
      role={compact ? 'dialog' : 'complementary'}
    >
      {selectedTask ? (
        <TaskDetail
          key={selectedTask.id}
          task={selectedTask}
          runs={runs}
          onClose={onClose}
          onRetry={onRetry}
          onStop={onStop}
          onNewRelated={onNewRelated}
        />
      ) : (
        <div className="workspace-empty">
          <header>
            <div>
              <span>WORKSPACE</span>
              <h2>工作区</h2>
            </div>
            <button
              className="panel-close"
              onClick={onClose}
              aria-label="关闭工作区"
              data-workspace-focus
            >
              <DsCloseIcon />
            </button>
          </header>
          <div className="workspace-empty-art">
            <FileOutput aria-hidden="true" />
          </div>
          <h3>结果会在这里打开</h3>
          <p>
            选择一个 Channel
            查看现场；后续生成的文档、图片和侧边对话也会留在这个可关闭的空间里。
          </p>
          <div className="workspace-capabilities">
            <span>
              <FileOutput aria-hidden="true" /> 内容预览
            </span>
            <span>
              <MessageSquareText aria-hidden="true" /> 侧边对话
            </span>
          </div>
        </div>
      )}
    </aside>
  )
}

function TaskDetail({
  onRetry,
  onStop,
  onNewRelated,
  task,
  runs,
  onClose,
}: {
  onRetry: (runId: string) => Promise<void>
  onStop: (taskId: string) => Promise<void>
  onNewRelated: () => void
  task: WorkChannel
  runs: Run[]
  onClose: () => void
}) {
  const latestRun = runs.at(-1)
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState('')
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState('')
  const stopDialog = useRef<HTMLDialogElement>(null)
  const steps = taskSteps(task.status)
  return (
    <div className="task-detail">
      <header className="detail-header">
        <div>
          <span>WORKSPACE</span>
          <strong>Channel 现场</strong>
        </div>
        <button
          className="panel-close"
          onClick={onClose}
          aria-label="关闭工作区"
          data-workspace-focus
        >
          <DsCloseIcon />
        </button>
      </header>
      <div className="detail-scroll">
        <div className="detail-title">
          <div className={`status-label status-${task.status}`}>
            <span className="status-dot" />
            {statusCopy[task.status]}
          </div>
          <h2>{task.title}</h2>
          <p>{task.goal}</p>
        </div>

        <section className="detail-section">
          <h3>进程</h3>
          <ol className="step-list">
            {steps.map(step => (
              <li className={step.state} key={step.label}>
                <span>
                  {step.state === 'done' ? <Check aria-hidden="true" /> : null}
                </span>
                <div>
                  <strong>{step.label}</strong>
                  <small>{step.detail}</small>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="detail-section">
          <h3>执行记录</h3>
          {task.canStop && (
            <button
              type="button"
              className="workspace-toggle workspace-text-action"
              disabled={stopping}
              onClick={() => stopDialog.current?.showModal()}
            >
              停止 Channel
            </button>
          )}
          {task.status === 'cancelled' && (
            <button
              className="workspace-toggle workspace-text-action"
              onClick={onNewRelated}
            >
              新建相关 Channel
            </button>
          )}
          <dialog
            ref={stopDialog}
            className="stop-channel-dialog"
            aria-labelledby={`stop-channel-title-${task.id}`}
          >
            <h2 id={`stop-channel-title-${task.id}`}>永久停止 Channel？</h2>
            <p>
              停止后，这个 Channel 和未完成的 Run
              将永久关闭，不能恢复。要继续相同工作，需要新建相关 Channel。
            </p>
            {stopError && <p role="alert">{stopError}</p>}
            <form method="dialog" className="stop-channel-actions">
              <button
                type="submit"
                value="cancel"
                autoFocus
                ref={element => element?.setAttribute('autofocus', '')}
                disabled={stopping}
                onClick={() => stopDialog.current?.close('cancel')}
              >
                保留 Channel
              </button>
              <button
                type="button"
                className="is-destructive"
                disabled={stopping}
                onClick={() => {
                  setStopping(true)
                  setStopError('')
                  void onStop(task.id)
                    .then(() => stopDialog.current?.close('stopped'))
                    .catch((caught: unknown) => {
                      setStopError(
                        caught instanceof Error ? caught.message : '停止失败',
                      )
                    })
                    .finally(() => setStopping(false))
                }}
              >
                {stopping ? '正在停止…' : '永久停止'}
              </button>
            </form>
          </dialog>
          {latestRun?.status === 'failed' && isActiveTask(task.status) && (
            <button
              className="workspace-toggle workspace-text-action"
              disabled={retrying}
              onClick={() => {
                setRetrying(true)
                setRetryError('')
                void onRetry(latestRun.id)
                  .catch((caught: unknown) =>
                    setRetryError(
                      caught instanceof Error ? caught.message : '重试失败',
                    ),
                  )
                  .finally(() => setRetrying(false))
              }}
            >
              {retrying ? '正在安排…' : '新建 Run 重试'}
            </button>
          )}
          {retryError && <p role="alert">{retryError}</p>}
          {runs.length === 0 ? (
            <p className="detail-empty">
              Pegas 正在为这件事建立第一条执行记录。
            </p>
          ) : (
            <div className="run-list">
              {runs.toReversed().map((run, index) => (
                <article className="run-item" key={run.id}>
                  <div>
                    <strong>Run {String(runs.length - index)}</strong>
                    <span className={`run-state run-${run.status}`}>
                      {runStatusCopy(run.status)}
                    </span>
                  </div>
                  <dl>
                    <div>
                      <dt>执行器</dt>
                      <dd>{run.executor}</dd>
                    </div>
                    <div>
                      <dt>尝试</dt>
                      <dd>{String(run.attempts)}</dd>
                    </div>
                    <div>
                      <dt>更新</dt>
                      <dd>{formatTime(run.updatedAt)}</dd>
                    </div>
                  </dl>
                  {run.lastError && (
                    <p className="run-error">
                      {run.lastError === 'stopped_by_user'
                        ? '用户已停止这个 Channel'
                        : run.lastError}
                    </p>
                  )}
                  {run.retryOfRunId && (
                    <p className="detail-empty">
                      重试自 {run.retryOfRunId.slice(0, 8)}
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        {latestRun?.output && (
          <section className="detail-section">
            <h3>
              {latestRun.executor === 'echo-test'
                ? 'Echo 测试结果'
                : '最近结果'}
            </h3>
            {latestRun.executor === 'echo-test' && (
              <p className="test-data-note">
                这是测试执行器的回显数据，用于验证任务链路，不代表 Agent
                的实际回答。
              </p>
            )}
            <div className="run-output">{latestRun.output}</div>
          </section>
        )}

        <section className="detail-section detail-metadata">
          <h3>时间</h3>
          <dl>
            <div>
              <dt>创建</dt>
              <dd>{formatFullTime(task.createdAt)}</dd>
            </div>
            <div>
              <dt>更新</dt>
              <dd>{formatFullTime(task.updatedAt)}</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  )
}

function payloadText(payload: unknown, fallback: string): string {
  const record = asRecord(payload)
  return typeof record?.text === 'string' ? record.text : fallback
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function recordString(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const value = record?.[key]
  return typeof value === 'string' ? value : fallback
}

function runForMessage(message: OutboxMessage, runs: Run[]): Run | undefined {
  const runId = recordString(asRecord(message.payload), 'runId', '')
  if (runId) return runs.find(run => run.id === runId)
  return message.taskId
    ? runs.findLast(run => run.taskId === message.taskId)
    : undefined
}

function isActiveTask(status: TaskStatus): boolean {
  return !['completed', 'cancelled'].includes(status)
}

function taskSubtitle(task: Task, run?: Run): string {
  if (run?.status === 'failed')
    return run.lastError ?? '最近执行失败，可以重试。'
  if (task.status === 'started') return '任务正在推进，执行记录可随时查看。'
  if (task.status === 'unstarted') return '已安排，等待执行。'
  if (task.status === 'completed') return '目标已经完成。'
  if (task.status === 'cancelled') return '任务已取消，不再继续。'
  return '任务已经进入 Pegas 的工作队列。'
}

function reasonCopy(reason: string): string {
  if (reason === 'last_run_failed')
    return '最近执行失败，可在详情中新建 Run 重试。'
  if (reason === 'retry_queued') return '重试已安排，等待执行。'
  if (reason === 'paused') return '任务已暂停。'
  if (reason === 'awaiting_user_review') return '本轮执行已结束，等待你的反馈。'
  return reason.replaceAll('_', ' ')
}

function taskStageIndex(status: TaskStatus): number {
  const stage: Record<TaskStatus, number> = {
    backlog: 0,
    unstarted: 1,
    started: 2,
    completed: 3,
    cancelled: 3,
  }
  return stage[status]
}

function taskStageLabel(status: TaskStatus): string {
  if (status === 'cancelled') return '任务已取消'
  const labels = ['已接收', '规划', '执行', '交付']
  return `当前阶段：${labels[taskStageIndex(status)] ?? '未知'}`
}

function runStatusCopy(status: Run['status']): string {
  const copy: Record<Run['status'], string> = {
    queued: '排队中',
    running: '运行中',
    waiting: '等待中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }
  return copy[status]
}

function taskSteps(
  status: TaskStatus,
): { label: string; detail: string; state: 'done' | 'active' | 'pending' }[] {
  if (status === 'cancelled')
    return [
      {
        label: '已取消',
        detail: '目标已关闭，执行记录仍保留。',
        state: 'done',
      },
    ]
  const position: Record<TaskStatus, number> = {
    backlog: 0,
    unstarted: 1,
    started: 2,
    completed: 4,
    cancelled: 3,
  }
  const current = position[status]
  const definitions = [
    ['已接收', '意图已写入持久事件队列'],
    ['规划', '理解目标并确定执行方式'],
    ['执行', '调用能力并保存恢复点'],
    ['交付', '汇总结果或等待你的决定'],
  ] as const
  return definitions.map(([label, detail], index) => ({
    label,
    detail,
    state: index < current ? 'done' : index === current ? 'active' : 'pending',
  }))
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

export function formatRelativeTime(value: string, now = Date.now()): string {
  const difference = new Date(value).getTime() - now
  const minutes = Math.round(difference / 60_000)
  if (Math.abs(minutes) < 1) return '刚刚'
  if (Math.abs(minutes) < 60)
    return new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }).format(
      minutes,
      'minute',
    )
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24)
    return new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }).format(
      hours,
      'hour',
    )
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}

function formatFullTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  )

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])

  return matches
}
