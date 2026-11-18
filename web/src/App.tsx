import {
  ArrowUp,
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
  PanelRightOpen,
  Plus,
  RotateCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  X,
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
  Snapshot,
  Task,
  TaskStatus,
} from './types'

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
  ): Promise<SettingsResponse>
}
const emptySnapshot: Snapshot = {
  events: [],
  messages: [],
  runs: [],
  tasks: [],
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

type AppView = 'conversation' | 'tasks' | 'settings'

function viewFromUrl(): AppView {
  const parameters = new URLSearchParams(window.location.search)
  const view = parameters.get('view')
  if (view === 'conversation' || view === 'tasks' || view === 'settings')
    return view
  return parameters.has('task') ? 'tasks' : 'conversation'
}

export function App() {
  const compact = useMediaQuery('(max-width: 820px)')
  const initialTaskId =
    new URLSearchParams(window.location.search).get('task') ?? ''
  const [token, setToken] = useState(
    () => sessionStorage.getItem('pegas-token') ?? '',
  )
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [unauthorized, setUnauthorized] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [activeView, setActiveView] = useState<AppView>(viewFromUrl)
  const [workspaceOpen, setWorkspaceOpen] = useState(Boolean(initialTaskId))
  const workspaceVisible = workspaceOpen && activeView !== 'settings'
  const [selectedTaskId, setSelectedTaskId] = useState(initialTaskId)
  const [attachmentHelpOpen, setAttachmentHelpOpen] = useState(false)
  const feedEnd = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const workspaceTrigger = useRef<HTMLElement | null>(null)
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
  const activeTaskCount = snapshot.tasks.filter(task =>
    isActiveTask(task.status),
  ).length

  const loadSnapshot = useCallback(
    async (quiet = false) => {
      if (!quiet) setRefreshing(true)
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
        setRefreshing(false)
      }
    },
    [api],
  )

  useEffect(() => {
    void loadSnapshot(true)
    const interval = window.setInterval(() => void loadSnapshot(true), 2500)
    return () => window.clearInterval(interval)
  }, [loadSnapshot])

  useEffect(() => {
    const handlePopState = () => {
      const taskId =
        new URLSearchParams(window.location.search).get('task') ?? ''
      setSelectedTaskId(taskId)
      setWorkspaceOpen(Boolean(taskId))
      setActiveView(viewFromUrl())
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

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

  const selectedTask = snapshot.tasks.find(task => task.id === selectedTaskId)

  function openTask(taskId: string): void {
    rememberWorkspaceTrigger()
    setActiveView('tasks')
    setSelectedTaskId(taskId)
    setWorkspaceOpen(true)
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'tasks')
    url.searchParams.set('task', taskId)
    window.history.pushState({ taskId }, '', url)
  }

  function closeWorkspace(): void {
    setWorkspaceOpen(false)
    setSelectedTaskId('')
    const url = new URL(window.location.href)
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

  function navigate(view: AppView): void {
    setActiveView(view)
    const url = new URL(window.location.href)
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
      await api.sendMessage(text)
      setDraft('')
      await loadSnapshot(true)
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
    <div className={`app-shell${workspaceVisible ? ' has-workspace' : ''}`}>
      <a className="skip-link" href="#page-title">
        跳到主要内容
      </a>
      <aside
        className="identity-rail"
        aria-label="Pegas 导航"
        aria-hidden={compact && workspaceVisible ? true : undefined}
        inert={compact && workspaceVisible ? true : undefined}
      >
        <button
          className="pegas-mark"
          aria-label="返回对话"
          onClick={() => navigate('conversation')}
        >
          P
        </button>
        <div className="rail-brand">
          <strong>Pegas</strong>
          <span>Personal agent</span>
        </div>
        <nav className="rail-nav" aria-label="主要页面">
          <button
            className={`rail-button${activeView === 'conversation' ? ' is-active' : ''}`}
            aria-label="对话"
            aria-current={activeView === 'conversation' ? 'page' : undefined}
            onClick={() => navigate('conversation')}
          >
            <MessageSquareText aria-hidden="true" />
            <span>对话</span>
          </button>
          <button
            className={`rail-button${activeView === 'tasks' ? ' is-active' : ''}`}
            aria-label="任务"
            aria-current={activeView === 'tasks' ? 'page' : undefined}
            onClick={() => navigate('tasks')}
          >
            <ListTodo aria-hidden="true" />
            <span>任务</span>
            {activeTaskCount > 0 && (
              <span
                className="rail-count"
                aria-label={`${String(activeTaskCount)} 个进行中任务`}
              >
                {activeTaskCount}
              </span>
            )}
          </button>
        </nav>
        <button
          className={`rail-button rail-settings${activeView === 'settings' ? ' is-active' : ''}`}
          aria-label="设置"
          aria-current={activeView === 'settings' ? 'page' : undefined}
          onClick={() => navigate('settings')}
        >
          <Settings2 aria-hidden="true" />
          <span>设置</span>
        </button>
      </aside>

      <main
        className="main-column"
        aria-hidden={compact && workspaceVisible ? true : undefined}
        inert={compact && workspaceVisible ? true : undefined}
      >
        <header className="conversation-header page-header">
          <div className="identity-copy">
            <div className="status-orbit" aria-hidden="true">
              <span />
            </div>
            <div>
              <h1 id="page-title" tabIndex={-1}>
                {activeView === 'conversation'
                  ? '对话'
                  : activeView === 'tasks'
                    ? '任务'
                    : '设置'}
              </h1>
              {activeView !== 'settings' && (
                <span>
                  {activeView === 'conversation'
                    ? error
                      ? '连接中断'
                      : '在线，随时可以开始'
                    : `${String(activeTaskCount)} 件正在推进`}
                </span>
              )}
            </div>
          </div>
          {activeView !== 'settings' && (
            <div className="header-actions">
              <button
                className="icon-button"
                aria-label="刷新"
                title="刷新"
                onClick={() => void loadSnapshot()}
                disabled={refreshing}
              >
                <RotateCw
                  className={refreshing ? 'is-spinning' : ''}
                  aria-hidden="true"
                />
              </button>
              <button
                className="workspace-toggle"
                aria-label="打开工作区"
                aria-expanded={workspaceOpen}
                onClick={openWorkspace}
              >
                <PanelRightOpen aria-hidden="true" />
                <span>工作区</span>
              </button>
            </div>
          )}
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
                    const task = snapshot.tasks.find(
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
                  return (
                    <PegasMessage
                      key={`message-${item.value.id}`}
                      message={item.value}
                      run={runForMessage(item.value, snapshot.runs)}
                    />
                  )
                })
              )}
              <div ref={feedEnd} />
            </section>

            <div className="composer-dock">
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
                    <X aria-hidden="true" />
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
                <textarea
                  ref={composer}
                  id="message-composer"
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder="和 Pegas 一起工作"
                  rows={2}
                  name="message"
                  aria-describedby="composer-hint"
                  disabled={sending || unauthorized}
                />
                <div className="composer-footer">
                  <div className="composer-tools">
                    <button
                      type="button"
                      className="attachment-button"
                      aria-label="添加附件"
                      title="添加附件"
                      aria-expanded={attachmentHelpOpen}
                      onClick={() => setAttachmentHelpOpen(open => !open)}
                      disabled={sending || unauthorized}
                    >
                      <Plus aria-hidden="true" />
                    </button>
                    <span className="composer-status" id="composer-hint">
                      {dictation.state === 'requesting' && '正在请求麦克风…'}
                      {dictation.state === 'recording' &&
                        `正在听写 · ${formatDuration(dictation.elapsedSeconds)}`}
                      {dictation.state === 'transcribing' && '正在转成文字…'}
                      {dictation.state === 'idle' && (
                        <span className="composer-shortcut">
                          Shift + Enter 换行
                        </span>
                      )}
                    </span>
                  </div>
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
                        onClick={dictation.toggle}
                        disabled={
                          sending ||
                          unauthorized ||
                          dictation.state === 'requesting' ||
                          dictation.state === 'transcribing'
                        }
                      >
                        {dictation.state === 'transcribing' ||
                        dictation.state === 'requesting' ? (
                          <span
                            className="dictation-loader"
                            aria-hidden="true"
                          />
                        ) : dictation.state === 'recording' ? (
                          <Square aria-hidden="true" />
                        ) : (
                          <Mic aria-hidden="true" />
                        )}
                      </button>
                      <span className="dictation-tooltip" role="tooltip">
                        {dictation.state === 'recording' ? '停止听写' : '听写'}
                      </span>
                    </div>
                    <button
                      type="submit"
                      className="send-button"
                      aria-label={sending ? '正在发送' : '发送给 Pegas'}
                      disabled={
                        !draft.trim() ||
                        sending ||
                        unauthorized ||
                        dictationBusy
                      }
                    >
                      {sending ? (
                        <span className="send-loader" aria-hidden="true" />
                      ) : (
                        <ArrowUp aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>
                {dictation.error && (
                  <p className="dictation-error" role="alert">
                    {dictation.error}
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
            tasks={snapshot.tasks}
            runs={snapshot.runs}
            onOpen={openTask}
          />
        ) : (
          <SettingsPage api={api} />
        )}
      </main>

      <WorkspacePanel
        onRetry={async runId => {
          await api.retryRun(runId)
          await loadSnapshot(true)
        }}
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

function SettingsPage({ api }: { api: SettingsClient }) {
  const [section, setSection] = useState<
    'models' | 'routing' | 'rewrite' | 'privacy'
  >('models')
  const [settings, setSettings] = useState<RuntimeSettings>()
  const [capabilities, setCapabilities] = useState<SettingsCapabilities>()
  const [providerDraft, setProviderDraft] = useState<ModelProviderDraft>()
  const [routerModels, setRouterModels] = useState<ModelCatalogItem[]>([])
  const [agentCatalog, setAgentCatalog] = useState<DshModelCatalog>()
  const [modelAction, setModelAction] = useState<
    'discovering' | 'testing' | undefined
  >()
  const [modelStatus, setModelStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void Promise.all([api.settings(), api.agentModels().catch(() => undefined)])
      .then(([response, catalog]) => {
        if (!active) return
        setSettings(response.settings)
        setCapabilities(response.capabilities)
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
      )
      setSettings(response.settings)
      setCapabilities(response.capabilities)
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
    setRouterModels([])
    setModelStatus('')
  }
  const discoverModels = async () => {
    if (!settings || !providerDraft || modelAction) return
    setModelAction('discovering')
    setModelStatus('')
    setError('')
    try {
      const models = await api.discoverModels(
        settings.modelProvider,
        settings.modelName,
        providerDraft,
      )
      setRouterModels(models)
      setModelStatus(
        models.length > 0
          ? `已获取 ${String(models.length)} 个模型`
          : '连接成功，但目录中没有可用模型',
      )
    } catch (caught) {
      setModelStatus(caught instanceof Error ? caught.message : '模型获取失败')
    } finally {
      setModelAction(undefined)
    }
  }
  const testSelectedModel = async () => {
    if (!settings || !providerDraft || modelAction) return
    setModelAction('testing')
    setModelStatus('')
    setError('')
    try {
      const result = await api.testModel(
        settings.modelProvider,
        settings.modelName.trim(),
        providerDraft,
      )
      setModelStatus(`模型可用 · ${String(result.latencyMs)} ms`)
    } catch (caught) {
      setModelStatus(caught instanceof Error ? caught.message : '模型测试失败')
    } finally {
      setModelAction(undefined)
    }
  }
  const selectedProvider = capabilities?.providers.find(
    provider => provider.id === settings?.modelProvider,
  )
  const customProvider = settings?.modelProvider === 'custom'
  const featuredProviderIds: readonly ModelProviderId[] = [
    'openai',
    'anthropic',
    'google',
    'deepseek',
    'ollama',
    'custom',
  ]
  const featuredProviders = capabilities?.providers.filter(provider =>
    featuredProviderIds.includes(provider.id),
  )
  const additionalProviders = capabilities?.providers.filter(
    provider => !featuredProviderIds.includes(provider.id),
  )
  const canSave = Boolean(
    settings?.modelName.trim() &&
    providerDraft?.name.trim() &&
    providerDraft.baseUrl.trim() &&
    (settings.agentModelMode === 'profile' ||
      (settings.agentModelProvider.trim() && settings.agentModelName.trim())),
  )
  return (
    <section className="settings-page" aria-labelledby="page-title">
      {loading ? (
        <div className="settings-loading" aria-label="正在读取设置">
          <span />
          <span />
          <span />
        </div>
      ) : settings && capabilities && providerDraft && selectedProvider ? (
        <form
          className="settings-form"
          aria-label="设置选项"
          onSubmit={event => void save(event)}
        >
          <div className="settings-layout">
            <div className="settings-tabs" role="tablist" aria-label="设置分类">
              {(
                [
                  ['models', '模型与供应商'],
                  ['routing', '任务路由'],
                  ['rewrite', '语音与输入'],
                  ['privacy', '隐私'],
                ] as const
              ).map(([id, label], index, tabs) => (
                <button
                  type="button"
                  role="tab"
                  id={`settings-tab-${id}`}
                  key={id}
                  aria-selected={section === id}
                  aria-controls={
                    section === id ? `settings-panel-${id}` : undefined
                  }
                  tabIndex={section === id ? 0 : -1}
                  onClick={() => setSection(id)}
                  onKeyDown={event => {
                    let next: number
                    if (event.key === 'ArrowRight')
                      next = (index + 1) % tabs.length
                    else if (event.key === 'ArrowLeft')
                      next = (index + tabs.length - 1) % tabs.length
                    else if (event.key === 'Home') next = 0
                    else if (event.key === 'End') next = tabs.length - 1
                    else return
                    event.preventDefault()
                    const nextTab = tabs[next]
                    if (!nextTab) return
                    setSection(nextTab[0])
                    event.currentTarget.parentElement
                      ?.querySelectorAll<HTMLButtonElement>('[role=tab]')
                      [next]?.focus()
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
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
                    <span className="provider-picker-label">常用供应商</span>
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
                      className={selectedProvider.available ? 'is-ready' : ''}
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
                    <label htmlFor="model-name">Router / 输入处理模型</label>
                    <input
                      id="model-name"
                      name="modelName"
                      list="router-model-options"
                      value={settings.modelName}
                      onChange={event =>
                        update('modelName', event.target.value)
                      }
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      maxLength={160}
                      required
                    />
                    <datalist id="router-model-options">
                      {routerModels.map(model => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </datalist>
                    <div className="model-actions">
                      <button
                        type="button"
                        onClick={() => void discoverModels()}
                        disabled={Boolean(modelAction)}
                      >
                        {modelAction === 'discovering'
                          ? '正在获取…'
                          : '获取模型列表'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void testSelectedModel()}
                        disabled={
                          Boolean(modelAction) || !settings.modelName.trim()
                        }
                      >
                        {modelAction === 'testing' ? '正在测试…' : '测试模型'}
                      </button>
                    </div>
                    <p
                      className="model-action-status"
                      role="status"
                      aria-live="polite"
                    >
                      {modelStatus ||
                        '可手工输入，也可从当前连接读取模型目录。'}
                    </p>
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
                    <p>内容离开 Worker 前替换高置信度敏感值，返回后恢复。</p>
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
                    <h2 id="rewrite-title">输入处理</h2>
                    <p>只调整执行视图，不覆盖 Conversation 中的用户原文。</p>
                  </header>
                  <div className="voice-settings-card">
                    <div className="settings-card-icon">
                      <Mic aria-hidden="true" />
                    </div>
                    <div>
                      <h3>语音输入</h3>
                      <p>在对话输入框中听写，转成可编辑文字后再发送。</p>
                    </div>
                    <span>
                      {'mediaDevices' in navigator &&
                      typeof navigator.mediaDevices.getUserMedia === 'function'
                        ? '浏览器可用'
                        : '浏览器不支持'}
                    </span>
                  </div>
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
                </section>
              )}
            </div>
          </div>

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
          会组织任务、持续执行，并在真正需要你时回来。
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

function PegasMessage({ message, run }: { message: OutboxMessage; run?: Run }) {
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
        P
      </div>
      <div>
        <MarkdownMessage content={text} />
        <time dateTime={message.createdAt}>
          {formatTime(message.createdAt)}
        </time>
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
      return '已进入任务'
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
      aria-label={`查看任务：${task.title}`}
    >
      <div className="task-pulse-head">
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
      <header className="tasks-intro">
        <div>
          <h2 id="task-board-title">
            <Columns3 aria-hidden="true" />
            任务看板
          </h2>
          <span className="board-total">{tasks.length} 个任务</span>
        </div>
        <label className="task-search">
          <Search aria-hidden="true" />
          <input
            aria-label="搜索任务"
            placeholder="搜索任务…"
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

      <div className="task-board" aria-label="按状态分组的任务">
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
                    <span>{query ? '没有匹配的任务' : '暂无任务'}</span>
                  </div>
                ) : (
                  columnTasks.map(task => {
                    const taskRuns = runs.filter(run => run.taskId === task.id)
                    return (
                      <button
                        className="task-board-card"
                        key={task.id}
                        onClick={() => onOpen(task.id)}
                        aria-label={`打开任务现场：${task.title}`}
                      >
                        <span className="task-card-id">
                          <ListTodo aria-hidden="true" />
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
  open,
  selectedTask,
  runs,
  onClose,
  compact,
}: {
  onRetry: (runId: string) => Promise<void>
  open: boolean
  selectedTask?: Task
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
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="workspace-empty-art">
            <FileOutput aria-hidden="true" />
          </div>
          <h3>结果会在这里打开</h3>
          <p>
            选择一个任务查看现场；后续生成的文档、图片和侧边对话也会留在这个可关闭的空间里。
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
  task,
  runs,
  onClose,
}: {
  onRetry: (runId: string) => Promise<void>
  task: Task
  runs: Run[]
  onClose: () => void
}) {
  const latestRun = runs.at(-1)
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState('')
  const steps = taskSteps(task.status)
  return (
    <div className="task-detail">
      <header className="detail-header">
        <div>
          <span>WORKSPACE</span>
          <strong>任务现场</strong>
        </div>
        <button
          className="panel-close"
          onClick={onClose}
          aria-label="关闭工作区"
          data-workspace-focus
        >
          <X aria-hidden="true" />
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
          {latestRun?.status === 'failed' && isActiveTask(task.status) && (
            <button
              className="workspace-toggle"
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
                    <p className="run-error">{run.lastError}</p>
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
