import { ArrowRight, KeyRound, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ApiError, PegasApi } from './api'
import { DetailDrawer } from './sealed/DetailDrawer'
import {
  AttentionPage,
  AutomationPage,
  ConversationPage,
  MemoryPage,
  WorkPage,
} from './sealed/MainPages'
import { Onboarding } from './sealed/Onboarding'
import { PegasMark } from './sealed/PegasMark'
import { SettingsPage } from './sealed/SettingsPage'
import { AppShell, GlobalSearch } from './sealed/Shell'
import { type ReviewFixture, UiReviewHarness } from './sealed/UiReviewHarness'
import {
  emptySnapshot,
  isAttentionMessage,
  latestRunForTask,
  type AppData,
  type AppPage,
  type DrawerView,
  type SettingsSection,
  type ThemeChoice,
} from './sealed/types'
import type {
  DshModelCatalog,
  DshModelCatalogItem,
  ModelProviderDraft,
  OutboxMessage,
  RuntimeSettings,
  RewriteSettingsDraft,
  SpeechSettingsDraft,
} from './types'

const userId = 'owner'

declare global {
  interface Window {
    __PEGAS_UI_REVIEW__?: ReviewFixture
  }
}

export function App() {
  const [token, setToken] = useState(
    () => sessionStorage.getItem('pegas-token') ?? '',
  )
  const api = useMemo(() => new PegasApi(userId, token), [token])
  const [data, setData] = useState<AppData>({ snapshot: emptySnapshot })
  const [agentModels, setAgentModels] = useState<DshModelCatalog>()
  const [page, setPage] = useState<AppPage>(() => pageFromLocation())
  const [drawer, setDrawer] = useState<DrawerView>()
  const [continuationTaskId, setContinuationTaskId] = useState<string>()
  const [composerDraft, setComposerDraft] = useState('')
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>('pegas')
  const [searchOpen, setSearchOpen] = useState(false)
  const [theme, setTheme] = useState<ThemeChoice>(() => readTheme())
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [configurationError, setConfigurationError] = useState('')
  const [unauthorized, setUnauthorized] = useState(false)
  const [snapshotLoaded, setSnapshotLoaded] = useState(false)
  const [setupOpen, setSetupOpen] = useState(
    () =>
      new URLSearchParams(window.location.search).get('setup') === '1' ||
      localStorage.getItem('pegas-setup-complete') !== 'true',
  )
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const restoredOutboxRef = useRef(false)
  const snapshotRequestRef = useRef(0)

  const loadSnapshot = useCallback(async () => {
    const requestId = snapshotRequestRef.current + 1
    snapshotRequestRef.current = requestId
    try {
      const [snapshotResult, usageResult] = await Promise.allSettled([
        api.snapshot(),
        api.modelUsage(),
      ])
      if (requestId !== snapshotRequestRef.current) return
      if (snapshotResult.status === 'rejected') throw snapshotResult.reason
      const usageError =
        usageResult.status === 'rejected'
          ? usageResult.reason instanceof Error
            ? usageResult.reason.message
            : '无法读取模型用量。'
          : ''
      setData(current => ({
        ...current,
        snapshot: snapshotResult.value,
        usage:
          usageResult.status === 'fulfilled'
            ? usageResult.value
            : current.usage,
        usageError,
      }))
      setSnapshotLoaded(true)
      setError('')
      setUnauthorized(false)
    } catch (caught) {
      if (requestId !== snapshotRequestRef.current) return
      if (caught instanceof ApiError && caught.status === 401)
        setUnauthorized(true)
      else
        setError(caught instanceof Error ? caught.message : '无法连接 Pegas。')
    } finally {
      if (requestId === snapshotRequestRef.current) setLoading(false)
    }
  }, [api])

  const loadConfiguration = useCallback(async () => {
    const [settings, catalog] = await Promise.allSettled([
      api.settings(),
      api.agentModels(),
    ])
    setData(current => ({
      ...current,
      ...(settings.status === 'fulfilled' ? { settings: settings.value } : {}),
    }))
    const failures = [
      settings.status === 'rejected'
        ? settings.reason instanceof Error
          ? settings.reason.message
          : '无法读取设置。'
        : '',
      catalog.status === 'rejected'
        ? catalog.reason instanceof Error
          ? catalog.reason.message
          : '无法读取执行模型目录。'
        : '',
    ].filter(Boolean)
    setConfigurationError(failures.join('；'))
    if (catalog.status === 'fulfilled') setAgentModels(catalog.value)
  }, [api])

  useEffect(() => {
    void loadSnapshot()
    void loadConfiguration()
    const interval = window.setInterval(() => void loadSnapshot(), 5_000)
    return () => window.clearInterval(interval)
  }, [loadConfiguration, loadSnapshot])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (setupOpen) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        rememberFocus()
        setSearchOpen(true)
      }
      if (event.key === 'Escape') {
        closeSearch()
        closeDrawer()
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [setupOpen])

  function rememberFocus() {
    if (document.activeElement instanceof HTMLElement)
      returnFocusRef.current = document.activeElement
  }
  function restoreFocus() {
    window.setTimeout(() => {
      const target = returnFocusRef.current
      if (target?.isConnected) target.focus()
      returnFocusRef.current = null
    })
  }
  function enrichDrawer(view: DrawerView): DrawerView {
    if (view.kind === 'runtime')
      return { ...view, run: data.snapshot.runs.at(-1) ?? view.run }
    if (view.kind !== 'task') return view
    const snapshotChannel = data.snapshot.channels.find(
      item => item.id === view.channel.id,
    )
    const channel =
      snapshotChannel &&
      Date.parse(snapshotChannel.updatedAt) > Date.parse(view.channel.updatedAt)
        ? snapshotChannel
        : view.channel
    const runsById = new Map(view.runs?.map(run => [run.id, run]) ?? [])
    for (const snapshotRun of data.snapshot.runs.filter(
      item => item.taskId === channel.id,
    )) {
      const current = runsById.get(snapshotRun.id)
      if (
        !current ||
        Date.parse(snapshotRun.updatedAt) > Date.parse(current.updatedAt)
      )
        runsById.set(snapshotRun.id, snapshotRun)
    }
    const runs = [...runsById.values()]
    const run = latestRunForTask(runs, channel.id) ?? view.run
    const records =
      data.usage?.records.filter(record => record.runId === run?.id) ?? []
    if (!records.length)
      return { ...view, channel, run, runs, usage: undefined }
    const sum = (key: 'totalTokens' | 'durationMs' | 'costUsd') => {
      const values = records
        .map(record => record[key])
        .filter((value): value is number => value !== undefined)
      return values.length
        ? values.reduce((total, value) => total + value, 0)
        : undefined
    }
    return {
      ...view,
      channel,
      run,
      runs,
      usage: {
        totalTokens: sum('totalTokens'),
        durationMs: sum('durationMs'),
        costUsd: sum('costUsd'),
      },
    }
  }
  function openDrawer(view: DrawerView) {
    rememberFocus()
    setDrawer(enrichDrawer(view))
    if (view.kind === 'task') void loadTaskDrawer(view.channel.id)
  }
  async function loadTaskDrawer(channelId: string) {
    try {
      const scoped = await api.snapshot(channelId)
      const timeline = scoped.channelTimeline
      setDrawer(current => {
        if (current?.kind !== 'task' || current.channel.id !== channelId)
          return current
        const runs = timeline?.runs ?? scoped.runs
        return enrichDrawer({
          ...current,
          channel: timeline?.channel ?? current.channel,
          run: latestRunForTask(runs, channelId) ?? current.run,
          runs,
          ...(timeline ? { timeline } : {}),
          timelineError: undefined,
        })
      })
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : '无法读取 Channel 时间线。'
      setDrawer(current =>
        current?.kind === 'task' && current.channel.id === channelId
          ? { ...current, timelineError: message }
          : current,
      )
    }
  }
  function closeDrawer() {
    setDrawer(undefined)
    restoreFocus()
  }
  function openSearch() {
    rememberFocus()
    setSearchOpen(true)
  }
  function closeSearch() {
    setSearchOpen(false)
    restoreFocus()
  }

  function navigate(nextPage: AppPage) {
    setPage(nextPage)
    const url = new URL(window.location.href)
    if (nextPage === 'conversation') url.searchParams.delete('view')
    else
      url.searchParams.set(
        'view',
        nextPage === 'attention' ? 'outbox' : nextPage,
      )
    if (nextPage !== 'attention') url.searchParams.delete('outbox')
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`)
  }

  useEffect(() => {
    const restorePage = () => {
      setPage(pageFromLocation())
      const messageId = new URLSearchParams(window.location.search).get(
        'outbox',
      )
      const message = data.snapshot.messages.find(item => item.id === messageId)
      if (message) restoreAttentionDrawer(message)
      else setDrawer(undefined)
    }
    window.addEventListener('popstate', restorePage)
    return () => window.removeEventListener('popstate', restorePage)
  }, [data.snapshot.channels, data.snapshot.messages, data.snapshot.runs])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (event: MediaQueryListEvent) =>
      setSystemDark(event.matches)
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [])

  useEffect(() => {
    const listener = (event: StorageEvent) => {
      if (event.key === 'pegas-theme') setTheme(readTheme())
    }
    window.addEventListener('storage', listener)
    return () => window.removeEventListener('storage', listener)
  }, [])

  const isDark = theme === 'dark' || (theme === 'system' && systemDark)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('pegas-theme', theme)
    const colorScheme = document.querySelector<HTMLMetaElement>(
      'meta[name="color-scheme"]',
    )
    if (colorScheme)
      colorScheme.content =
        theme === 'system' ? 'light dark' : isDark ? 'dark' : 'light'
    const themeColor = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    )
    if (themeColor) themeColor.content = isDark ? '#151615' : '#ffffff'
  }, [isDark, theme])

  async function saveSettings(
    settings: RuntimeSettings,
    provider: ModelProviderDraft,
    speech?: SpeechSettingsDraft,
    rewrite?: RewriteSettingsDraft,
  ) {
    const response = await api.saveSettings(settings, provider, speech, rewrite)
    setData(current => ({ ...current, settings: response }))
  }

  async function selectAgentModel(model: DshModelCatalogItem) {
    const response = data.settings
    if (!response) throw new Error('模型设置仍在加载，请稍后重试。')
    const routerProvider = response.capabilities.providers.find(
      provider => provider.id === response.settings.modelProvider,
    )
    if (!routerProvider) throw new Error('当前 Router 接入点不可用。')
    const settings = await api.saveSettings(
      {
        ...response.settings,
        agentModelMode: 'override',
        agentModelProvider: model.provider,
        agentModelName: model.id,
      },
      {
        name: routerProvider.name,
        protocol: routerProvider.protocol,
        baseUrl: routerProvider.baseUrl,
        apiKey: '',
        clearApiKey: false,
      },
    )
    setData(current => ({ ...current, settings }))
  }

  async function markRead(message: OutboxMessage) {
    const updated = await api.markOutboxRead(message.id)
    setData(current => ({
      ...current,
      snapshot: {
        ...current.snapshot,
        messages: current.snapshot.messages.map(item =>
          item.id === updated.id ? updated : item,
        ),
      },
    }))
  }

  async function openAttentionMessage(message: OutboxMessage) {
    rememberFocus()
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'outbox')
    url.searchParams.set('outbox', message.id)
    window.history.replaceState(
      {},
      '',
      `${url.pathname}${url.search}${url.hash}`,
    )
    restoreAttentionDrawer(message)
    try {
      await markRead(message)
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401)
        setUnauthorized(true)
      else
        setError(
          caught instanceof Error ? caught.message : '标记已读失败，请重试。',
        )
    }
  }

  function restoreAttentionDrawer(message: OutboxMessage) {
    const channel = data.snapshot.channels.find(
      item => item.id === message.taskId,
    )
    if (!channel) {
      setDrawer(undefined)
      return
    }
    setDrawer(
      enrichDrawer({
        kind: 'task',
        channel,
        run: latestRunForTask(data.snapshot.runs, channel.id),
      }),
    )
    void loadTaskDrawer(channel.id)
  }

  useEffect(() => {
    if (restoredOutboxRef.current || loading || !snapshotLoaded) return
    const messageId = new URLSearchParams(window.location.search).get('outbox')
    if (!messageId) {
      restoredOutboxRef.current = true
      return
    }
    const message = data.snapshot.messages.find(item => item.id === messageId)
    if (!message) {
      restoredOutboxRef.current = true
      return
    }
    restoredOutboxRef.current = true
    setPage('attention')
    void openAttentionMessage(message)
  }, [data.snapshot.messages, loading, snapshotLoaded])

  if (unauthorized)
    return (
      <AccessGate
        onToken={nextToken => {
          sessionStorage.setItem('pegas-token', nextToken)
          setToken(nextToken)
          setUnauthorized(false)
        }}
      />
    )

  if (window.__PEGAS_UI_REVIEW__)
    return <UiReviewHarness fixture={window.__PEGAS_UI_REVIEW__} />

  const actions = {
    onSearch: openSearch,
    onToggleAppearance: () => setTheme(isDark ? 'light' : 'dark'),
    isDark,
    onOpenDrawer: openDrawer,
  }
  const unreadCount = data.snapshot.messages.filter(
    message => !message.readAt && isAttentionMessage(message),
  ).length
  const selectedAgentProvider =
    data.settings?.settings.agentModelMode === 'override'
      ? data.settings.settings.agentModelProvider
      : agentModels?.defaultProvider
  const selectedAgentModelId =
    data.settings?.settings.agentModelMode === 'override'
      ? data.settings.settings.agentModelName
      : agentModels?.defaultModel
  const availableAgentModels =
    agentModels?.models.filter(
      model =>
        model.provider.toLocaleLowerCase() ===
        selectedAgentProvider?.toLocaleLowerCase(),
    ) ?? []
  const continuationChannel = continuationTaskId
    ? data.snapshot.channels.find(channel => channel.id === continuationTaskId)
    : undefined
  const resolvedDrawer = drawer ? enrichDrawer(drawer) : undefined

  return (
    <>
      <AppShell
        channels={data.snapshot.channels}
        onNavigate={nextPage => {
          if (nextPage === 'settings') setSettingsSection('pegas')
          navigate(nextPage)
        }}
        onOpenChannel={channel =>
          openDrawer({
            kind: 'task',
            channel,
            run: latestRunForTask(data.snapshot.runs, channel.id),
          })
        }
        page={page}
        unreadCount={unreadCount}
      >
        {loading && <div className="top-progress" aria-label="正在加载" />}
        {(error || configurationError) && (
          <div className="connection-banner" role="alert">
            <span>{error || configurationError}</span>
            <button
              onClick={() => {
                void loadSnapshot()
                void loadConfiguration()
              }}
              type="button"
            >
              <RotateCw size={15} />
              重新连接
            </button>
          </div>
        )}
        {page === 'conversation' && (
          <ConversationPage
            actions={actions}
            api={api}
            continuationChannel={continuationChannel}
            draft={composerDraft}
            modelProvider={selectedAgentProvider}
            models={availableAgentModels}
            onClearContinuation={() => setContinuationTaskId(undefined)}
            onConfigureVoice={() => {
              setSettingsSection('voice')
              navigate('settings')
            }}
            onDraftChange={setComposerDraft}
            onSelectModel={selectAgentModel}
            onSent={loadSnapshot}
            selectedModelId={selectedAgentModelId}
            speechEnabled={
              data.settings?.speech?.provider === 'openai-compatible'
            }
            snapshot={data.snapshot}
          />
        )}
        {page === 'work' && (
          <WorkPage actions={actions} snapshot={data.snapshot} />
        )}
        {page === 'attention' && (
          <AttentionPage
            actions={actions}
            onOpen={openAttentionMessage}
            snapshot={data.snapshot}
          />
        )}
        {page === 'automation' && <AutomationPage actions={actions} />}
        {page === 'memory' && <MemoryPage actions={actions} />}
        {page === 'settings' && (
          <SettingsPage
            agentModels={agentModels}
            initialSection={settingsSection}
            onBack={() => navigate('conversation')}
            onDiscoverModels={(provider, model, draft) =>
              api.discoverModels(provider, model, draft)
            }
            onOpenDrawer={openDrawer}
            onReloadUsage={() => void loadSnapshot()}
            onThemeChange={setTheme}
            onSave={saveSettings}
            onTestModel={(provider, model, draft) =>
              api.testModel(provider, model, draft)
            }
            onTestRewrite={(text, rewrite, settings, provider) =>
              api.testRewrite(text, rewrite, settings, provider)
            }
            onTestSpeech={(audio, speech) =>
              api.testSpeechConnection(audio, speech)
            }
            response={data.settings}
            systemDark={systemDark}
            theme={theme}
            usage={data.usage}
            usageError={data.usageError}
          />
        )}
      </AppShell>
      {searchOpen && (
        <GlobalSearch
          channels={data.snapshot.channels}
          onClose={closeSearch}
          onOpen={channel => {
            setSearchOpen(false)
            openDrawer({
              kind: 'task',
              channel,
              run: latestRunForTask(data.snapshot.runs, channel.id),
            })
          }}
        />
      )}
      {resolvedDrawer && (
        <DetailDrawer
          onChange={setDrawer}
          onClose={closeDrawer}
          onContinue={channel => {
            setContinuationTaskId(channel.id)
            setDrawer(undefined)
            navigate('conversation')
            window.setTimeout(() =>
              document
                .querySelector<HTMLTextAreaElement>(
                  '[aria-label="给 Pegas 发消息"]',
                )
                ?.focus(),
            )
          }}
          onRetry={async run => {
            await api.retryRun(run.id)
            await Promise.all([loadSnapshot(), loadTaskDrawer(run.taskId)])
          }}
          onStop={async channel => {
            await api.stopChannel(channel.id, 'Stopped from the Pegas UI')
            await Promise.all([loadSnapshot(), loadTaskDrawer(channel.id)])
          }}
          view={resolvedDrawer}
        />
      )}
      {setupOpen && (
        <Onboarding
          response={data.settings}
          onContinueSettings={() => {
            setSetupOpen(false)
            localStorage.setItem('pegas-setup-complete', 'true')
            setSettingsSection('pegas')
            navigate('settings')
          }}
          onComplete={() => {
            setSetupOpen(false)
            localStorage.setItem('pegas-setup-complete', 'true')
          }}
        />
      )}
    </>
  )
}

function pageFromLocation(): AppPage {
  const view = new URLSearchParams(window.location.search).get('view')
  if (view === 'outbox') return 'attention'
  if (
    view === 'work' ||
    view === 'attention' ||
    view === 'automation' ||
    view === 'memory' ||
    view === 'settings'
  )
    return view
  return 'conversation'
}

function AccessGate({ onToken }: { onToken: (token: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <main className="access-page">
      <section>
        <PegasMark size={55} />
        <span className="access-icon">
          <KeyRound size={20} />
        </span>
        <h1>连接到 Pegas</h1>
        <p>输入本机 Control Plane 的访问令牌。令牌只保存在当前浏览器会话中。</p>
        <form
          onSubmit={event => {
            event.preventDefault()
            if (value.trim()) onToken(value.trim())
          }}
        >
          <label htmlFor="access-token">访问令牌</label>
          <input
            autoFocus
            id="access-token"
            onChange={event => setValue(event.target.value)}
            type="password"
            value={value}
          />
          <button
            className="primary-button"
            disabled={!value.trim()}
            type="submit"
          >
            继续 <ArrowRight size={16} />
          </button>
        </form>
      </section>
    </main>
  )
}

function readTheme(): ThemeChoice {
  const value = localStorage.getItem('pegas-theme')
  return value === 'light' ||
    value === 'warm' ||
    value === 'dark' ||
    value === 'system'
    ? value
    : 'light'
}

function systemPrefersDark(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

export { formatRelativeTime } from './sealed/types'
