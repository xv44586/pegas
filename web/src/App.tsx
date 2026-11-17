import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  ListTodo,
  Mic,
  MessageSquareText,
  RotateCw,
  Send,
  Settings2,
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
  saveSettings(settings: RuntimeSettings): Promise<SettingsResponse>
}
const emptySnapshot: Snapshot = {
  events: [],
  messages: [],
  runs: [],
  tasks: [],
}

const statusCopy: Record<TaskStatus, string> = {
  inbox: '已接收',
  planning: '规划中',
  running: '执行中',
  waiting: '等你确认',
  completed: '已完成',
  failed: '出现问题',
  paused: '已暂停',
  cancelled: '已取消',
}

type TimelineItem =
  | { kind: 'event'; createdAt: string; value: InboxEvent }
  | { kind: 'message'; createdAt: string; value: OutboxMessage }

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
  const [taskPanelOpen, setTaskPanelOpen] = useState(Boolean(initialTaskId))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState(initialTaskId)
  const feedEnd = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
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
      setTaskPanelOpen(Boolean(taskId))
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

  function openTaskPanel(): void {
    rememberPanelTrigger()
    setSettingsOpen(false)
    setTaskPanelOpen(true)
  }

  function openTask(taskId: string): void {
    rememberPanelTrigger()
    setSettingsOpen(false)
    setSelectedTaskId(taskId)
    setTaskPanelOpen(true)
    const url = new URL(window.location.href)
    url.searchParams.set('task', taskId)
    window.history.pushState({ taskId }, '', url)
  }

  function closeTask(): void {
    setSelectedTaskId('')
    const url = new URL(window.location.href)
    url.searchParams.delete('task')
    window.history.pushState({}, '', url)
  }

  function closeTaskPanel(): void {
    setTaskPanelOpen(false)
    if (compact) {
      window.requestAnimationFrame(() => previousFocus.current?.focus())
    }
  }

  function openSettings(): void {
    rememberPanelTrigger()
    setTaskPanelOpen(false)
    setSettingsOpen(true)
  }

  function closeSettings(): void {
    setSettingsOpen(false)
    if (compact) {
      window.requestAnimationFrame(() => previousFocus.current?.focus())
    }
  }

  function rememberPanelTrigger(): void {
    if (!compact || taskPanelOpen || settingsOpen) return
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
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
    <div className="app-shell">
      <aside
        className="identity-rail"
        aria-label="Pegas 导航"
        aria-hidden={
          compact && (taskPanelOpen || settingsOpen) ? true : undefined
        }
        inert={compact && (taskPanelOpen || settingsOpen) ? true : undefined}
      >
        <button
          className="pegas-mark"
          aria-label="返回对话"
          onClick={() => window.scrollTo({ top: 0 })}
        >
          P
        </button>
        <nav className="rail-nav" aria-label="主要功能">
          <button
            className="rail-button is-active"
            aria-label="对话"
            title="对话"
          >
            <MessageSquareText aria-hidden="true" />
          </button>
          <button
            className="rail-button"
            aria-label="任务"
            title="任务"
            onClick={openTaskPanel}
          >
            <ListTodo aria-hidden="true" />
            {snapshot.tasks.some(task => isActiveTask(task.status)) && (
              <span className="rail-indicator" aria-label="有正在进行的任务" />
            )}
          </button>
        </nav>
        <button
          className={`rail-button rail-settings${settingsOpen ? ' is-active' : ''}`}
          aria-label="设置"
          title="设置"
          onClick={openSettings}
        >
          <Settings2 aria-hidden="true" />
        </button>
      </aside>

      <main
        className="conversation-column"
        aria-hidden={
          compact && (taskPanelOpen || settingsOpen) ? true : undefined
        }
        inert={compact && (taskPanelOpen || settingsOpen) ? true : undefined}
      >
        <header className="conversation-header">
          <div className="identity-copy">
            <div className="status-orbit" aria-hidden="true">
              <span />
            </div>
            <div>
              <strong>Pegas</strong>
              <span>{error ? '连接中断' : '在线，随时可以开始'}</span>
            </div>
          </div>
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
              className="icon-button mobile-settings-button"
              aria-label="打开设置"
              title="设置"
              onClick={openSettings}
            >
              <Settings2 aria-hidden="true" />
            </button>
            <button className="mobile-task-button" onClick={openTaskPanel}>
              <ListTodo aria-hidden="true" />
              任务
            </button>
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

        <section className="conversation-feed" aria-label="与 Pegas 的对话">
          {loading ? (
            <ConversationSkeleton />
          ) : timeline.length === 0 ? (
            <EmptyConversation />
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
          <div className="composer-wrap">
            <label htmlFor="message-composer">告诉 Pegas 你想完成什么</label>
            <textarea
              ref={composer}
              id="message-composer"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="提出一个问题、任务，或者刚想到的点子…"
              rows={1}
              disabled={sending || unauthorized}
            />
            <div className="composer-footer">
              <span className="composer-status">
                {dictation.state === 'requesting' && '正在请求麦克风…'}
                {dictation.state === 'recording' &&
                  `正在听写 · ${formatDuration(dictation.elapsedSeconds)}`}
                {dictation.state === 'transcribing' && '正在转成文字…'}
                {dictation.state === 'idle' &&
                  'Enter 发送 · Shift + Enter 换行'}
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
                      <span className="dictation-loader" aria-hidden="true" />
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
                  className="send-button"
                  aria-label={sending ? '正在发送' : '发送给 Pegas'}
                  onClick={() => void submitMessage()}
                  disabled={
                    !draft.trim() || sending || unauthorized || dictationBusy
                  }
                >
                  {sending ? (
                    <span className="send-loader" />
                  ) : (
                    <Send aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
            {dictation.error && (
              <p className="dictation-error" role="alert">
                {dictation.error}
              </p>
            )}
          </div>
          <div className="sr-only" aria-live="polite">
            {sending && '正在发送消息'}
            {dictation.state === 'recording' && '听写已开始'}
            {dictation.state === 'transcribing' && '录音结束，正在转成文字'}
          </div>
        </div>
      </main>

      {settingsOpen ? (
        <SettingsPanel
          open={settingsOpen}
          api={api}
          onClose={closeSettings}
          compact={compact}
        />
      ) : (
        <TaskPanel
          open={taskPanelOpen}
          tasks={snapshot.tasks}
          runs={snapshot.runs}
          selectedTask={selectedTask}
          onOpen={openTask}
          onBack={closeTask}
          onClose={closeTaskPanel}
          compact={compact}
        />
      )}
    </div>
  )
}

function SettingsPanel({
  open,
  api,
  onClose,
  compact,
}: {
  open: boolean
  api: SettingsClient
  onClose: () => void
  compact: boolean
}) {
  const [settings, setSettings] = useState<RuntimeSettings>()
  const [capabilities, setCapabilities] = useState<SettingsCapabilities>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setError('')
    void api
      .settings()
      .then(response => {
        if (!active) return
        setSettings(response.settings)
        setCapabilities(response.capabilities)
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
  }, [api, open])

  useEffect(() => {
    if (!compact || !open || !panel.current) return
    const element = panel.current
    const first = element.querySelector<HTMLElement>(
      '[data-panel-initial-focus]',
    )
    window.requestAnimationFrame(() => first?.focus())
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    element.addEventListener('keydown', handleKeyDown)
    return () => element.removeEventListener('keydown', handleKeyDown)
  }, [compact, onClose, open])

  async function save(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!settings || saving) return
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const response = await api.saveSettings({
        ...settings,
        modelName: settings.modelName.trim(),
      })
      setSettings(response.settings)
      setCapabilities(response.capabilities)
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
    setSaved(false)
    setSettings(current => (current ? { ...current, [key]: value } : current))
  }
  if (compact && !open) return null
  return (
    <aside
      ref={panel}
      className={`task-panel settings-panel${open ? ' is-open' : ''}`}
      aria-label="设置"
      aria-modal={compact ? true : undefined}
      role={compact ? 'dialog' : undefined}
    >
      <header className="settings-header">
        <div>
          <h2 id="runtime-settings-title">设置</h2>
          <p>统一控制模型入口、输入处理与隐私边界</p>
        </div>
        <button
          className="panel-close settings-close"
          type="button"
          onClick={onClose}
          aria-label="关闭设置"
          data-panel-initial-focus
        >
          <X aria-hidden="true" />
        </button>
      </header>

      {loading ? (
        <div className="settings-loading" aria-label="正在读取设置">
          <span />
          <span />
          <span />
        </div>
      ) : settings && capabilities ? (
        <form
          className="settings-form"
          aria-labelledby="runtime-settings-title"
          onSubmit={event => void save(event)}
        >
          <div className="settings-scroll">
            <fieldset>
              <legend>任务路由</legend>
              <p>决定一条新消息是继续已有任务，还是创建新的任务。</p>
              <SettingChoice
                name="router-mode"
                value="model"
                checked={settings.routerMode === 'model'}
                title="智能归类"
                description="由所选模型判断任务归属，不确定时安全地新建任务。"
                onChange={() => update('routerMode', 'model')}
              />
              <SettingChoice
                name="router-mode"
                value="rules"
                checked={settings.routerMode === 'rules'}
                title="确定性规则"
                description="只有明确指定任务时才续接，其余消息一律新建任务。"
                onChange={() => update('routerMode', 'rules')}
              />
            </fieldset>

            <fieldset>
              <legend>模型服务</legend>
              <p>
                Provider 的地址与凭证由服务端管理，浏览器只选择已配置的入口。
              </p>
              {capabilities.providers.map(provider => (
                <SettingChoice
                  key={provider.id}
                  name="model-provider"
                  value={provider.id}
                  checked={settings.modelProvider === provider.id}
                  title={
                    provider.id === 'codex-cli'
                      ? 'Codex 登录态'
                      : 'OpenAI-compatible'
                  }
                  description={
                    provider.reason ??
                    (provider.id === 'codex-cli'
                      ? '复用本机 Codex CLI 登录态。'
                      : '使用服务端配置的兼容 API。')
                  }
                  disabled={!provider.available}
                  onChange={() => update('modelProvider', provider.id)}
                />
              ))}
              <label className="settings-text-field" htmlFor="model-name">
                <span>对应模型</span>
                <input
                  id="model-name"
                  name="modelName"
                  value={settings.modelName}
                  onChange={event => update('modelName', event.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={120}
                  required
                />
                <small>
                  当前 Provider：
                  {settings.modelProvider === 'codex-cli'
                    ? 'Codex 登录态'
                    : 'OpenAI-compatible'}
                </small>
              </label>
            </fieldset>

            <fieldset>
              <legend>模型出站脱敏</legend>
              <p>
                在内容离开 Pegas Worker 前替换高置信度敏感值，返回后再恢复。
              </p>
              <SettingChoice
                name="privacy-mode"
                value="mask"
                checked={settings.privacyMode === 'mask'}
                title="开启脱敏"
                description={
                  capabilities.privacyAvailable
                    ? '保护密钥、密码、邮箱和手机号；原文仍保留在本地权威记录。'
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
                description="保持原有出站行为。适合完全受控的本地模型链路。"
                onChange={() => update('privacyMode', 'disabled')}
              />
            </fieldset>

            <fieldset>
              <legend>输入改写</legend>
              <p>
                改写只影响发送给 Router 与 Executor 的执行视图，不覆盖对话原文。
              </p>
              <SettingChoice
                name="rewrite-mode"
                value="light"
                checked={settings.rewriteMode === 'light'}
                title="轻量校正"
                description="修正明显的语音识别错误、口头语和标点，不补充事实或回答问题。"
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
          </div>

          <footer className="settings-footer">
            <div aria-live="polite" role="status">
              {saved
                ? `已保存 · revision ${String(settings.revision)}`
                : `服务端设置 · revision ${String(settings.revision)}`}
            </div>
            <button
              type="submit"
              disabled={saving || !settings.modelName.trim()}
            >
              {saving ? '正在保存…' : '保存设置'}
            </button>
          </footer>
        </form>
      ) : null}

      {error && (
        <div className="settings-error" role="alert">
          <CircleAlert aria-hidden="true" />
          <span>{error}</span>
          {!settings && (
            <button type="button" onClick={() => onClose()}>
              返回
            </button>
          )}
        </div>
      )}
    </aside>
  )
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

function EmptyConversation() {
  return (
    <div className="empty-conversation">
      <div className="empty-mark">
        <Sparkles aria-hidden="true" />
      </div>
      <h1>和 Pegas 说点什么</h1>
      <p>
        不必先创建任务，也不用决定该放在哪里。直接告诉我你想完成什么，剩下的由我来组织。
      </p>
      <div className="empty-prompts" aria-label="示例">
        <span>“把刚才的想法整理成一份方案”</span>
        <span>“帮我持续跟进这个功能，完成后告诉我”</span>
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

function TaskPanel({
  open,
  tasks,
  runs,
  selectedTask,
  onOpen,
  onBack,
  onClose,
  compact,
}: {
  open: boolean
  tasks: Task[]
  runs: Run[]
  selectedTask?: Task
  onOpen: (taskId: string) => void
  onBack: () => void
  onClose: () => void
  compact: boolean
}) {
  const [filter, setFilter] = useState<'active' | 'completed'>('active')
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!compact || !open || !panel.current) return
    const element = panel.current
    const focusable = () =>
      Array.from(
        element.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )
    const initial = element.querySelector<HTMLElement>(
      '[data-panel-initial-focus]',
    )
    window.requestAnimationFrame(() => initial?.focus())

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const candidates = focusable()
      const first = candidates[0]
      const last = candidates.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    element.addEventListener('keydown', handleKeyDown)
    return () => element.removeEventListener('keydown', handleKeyDown)
  }, [compact, onClose, open])

  if (compact && !open) return null
  const visibleTasks = tasks.filter(task =>
    filter === 'active'
      ? isActiveTask(task.status)
      : !isActiveTask(task.status),
  )

  return (
    <aside
      ref={panel}
      className={`task-panel${open ? ' is-open' : ''}`}
      aria-label="任务工作台"
      aria-modal={compact ? true : undefined}
      role={compact ? 'dialog' : undefined}
    >
      {selectedTask ? (
        <TaskDetail
          task={selectedTask}
          runs={runs.filter(run => run.taskId === selectedTask.id)}
          onBack={onBack}
          onClose={onClose}
        />
      ) : (
        <>
          <header className="panel-header">
            <div>
              <h2>任务</h2>
              <p>
                {tasks.filter(task => isActiveTask(task.status)).length}{' '}
                件正在推进
              </p>
            </div>
            <button
              className="panel-close"
              onClick={onClose}
              aria-label="关闭任务面板"
              data-panel-initial-focus
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="task-filters" role="group" aria-label="筛选任务">
            <button
              className={filter === 'active' ? 'is-active' : ''}
              onClick={() => setFilter('active')}
            >
              进行中
            </button>
            <button
              className={filter === 'completed' ? 'is-active' : ''}
              onClick={() => setFilter('completed')}
            >
              已结束
            </button>
          </div>
          <div className="task-list">
            {visibleTasks.length === 0 ? (
              <div className="empty-task-list">
                <Check aria-hidden="true" />
                <strong>
                  {filter === 'active'
                    ? '当前没有进行中的任务'
                    : '还没有已结束的任务'}
                </strong>
                <span>从对话中交给 Pegas 一件事情，它会出现在这里。</span>
              </div>
            ) : (
              visibleTasks.map(task => (
                <button
                  className="task-list-item"
                  key={task.id}
                  onClick={() => onOpen(task.id)}
                >
                  <span className={`status-dot status-${task.status}`} />
                  <span className="task-list-copy">
                    <strong>{task.title}</strong>
                    <span>
                      {statusCopy[task.status]} ·{' '}
                      {formatRelativeTime(task.updatedAt)}
                    </span>
                  </span>
                  <ChevronRight aria-hidden="true" />
                </button>
              ))
            )}
          </div>
        </>
      )}
    </aside>
  )
}

function TaskDetail({
  task,
  runs,
  onBack,
  onClose,
}: {
  task: Task
  runs: Run[]
  onBack: () => void
  onClose: () => void
}) {
  const latestRun = runs.at(-1)
  const steps = taskSteps(task.status)
  return (
    <div className="task-detail">
      <header className="detail-header">
        <button
          className="icon-button"
          onClick={onBack}
          aria-label="返回任务列表"
          data-panel-initial-focus
        >
          <ArrowLeft aria-hidden="true" />
        </button>
        <span>任务详情</span>
        <button
          className="panel-close"
          onClick={onClose}
          aria-label="关闭任务面板"
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
  return !['completed', 'failed', 'cancelled'].includes(status)
}

function taskSubtitle(task: Task, run?: Run): string {
  if (task.status === 'running') return 'Pegas 正在执行，重要进展会在这里出现。'
  if (task.status === 'planning') return '正在理解目标并安排下一步。'
  if (task.status === 'waiting') return '本轮执行已结束，等待你的反馈。'
  if (task.status === 'completed') return '目标已经完成。'
  if (task.status === 'failed')
    return run?.lastError ?? '执行遇到问题，可以从详情中检查。'
  if (task.status === 'paused') return '任务已暂停，状态和上下文都已保存。'
  return '任务已经进入 Pegas 的工作队列。'
}

function reasonCopy(reason: string): string {
  if (reason === 'awaiting_user_review') return '本轮执行已结束，等待你的反馈。'
  return reason.replaceAll('_', ' ')
}

function taskStageIndex(status: TaskStatus): number {
  const stage: Record<TaskStatus, number> = {
    inbox: 0,
    planning: 1,
    running: 2,
    waiting: 3,
    completed: 3,
    failed: 3,
    paused: 2,
    cancelled: 3,
  }
  return stage[status]
}

function taskStageLabel(status: TaskStatus): string {
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
  const position: Record<TaskStatus, number> = {
    inbox: 0,
    planning: 1,
    running: 2,
    waiting: 3,
    completed: 4,
    failed: 3,
    paused: 2,
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
