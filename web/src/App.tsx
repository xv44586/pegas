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
  type AppData,
  type AppPage,
  type DrawerView,
  type ThemeChoice,
} from './sealed/types'
import type {
  DshModelCatalog,
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
  const [page, setPage] = useState<AppPage>('conversation')
  const [drawer, setDrawer] = useState<DrawerView>()
  const [searchOpen, setSearchOpen] = useState(false)
  const [theme, setTheme] = useState<ThemeChoice>(() => readTheme())
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [unauthorized, setUnauthorized] = useState(false)
  const [setupOpen, setSetupOpen] = useState(
    () => new URLSearchParams(window.location.search).get('setup') === '1',
  )
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const loadSnapshot = useCallback(async () => {
    try {
      const snapshot = await api.snapshot()
      setData(current => ({ ...current, snapshot }))
      setError('')
      setUnauthorized(false)
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401)
        setUnauthorized(true)
      else
        setError(caught instanceof Error ? caught.message : '无法连接 Pegas。')
    } finally {
      setLoading(false)
    }
  }, [api])

  const loadConfiguration = useCallback(async () => {
    const [settings, usage, catalog] = await Promise.allSettled([
      api.settings(),
      api.modelUsage(),
      api.agentModels(),
    ])
    setData(current => ({
      ...current,
      ...(settings.status === 'fulfilled' ? { settings: settings.value } : {}),
      ...(usage.status === 'fulfilled' ? { usage: usage.value } : {}),
    }))
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
  }, [])

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
      return { ...view, run: view.run ?? data.snapshot.runs[0] }
    if (view.kind !== 'task') return view
    const records =
      data.usage?.records.filter(record => record.taskId === view.channel.id) ??
      []
    if (!records.length) return view
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
    message => !message.readAt,
  ).length

  return (
    <>
      <AppShell
        channels={data.snapshot.channels}
        onNavigate={setPage}
        onOpenChannel={channel =>
          openDrawer({
            kind: 'task',
            channel,
            run: data.snapshot.runs.find(run => run.taskId === channel.id),
          })
        }
        page={page}
        unreadCount={unreadCount}
      >
        {loading && <div className="top-progress" aria-label="正在加载" />}
        {error && (
          <div className="connection-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => void loadSnapshot()} type="button">
              <RotateCw size={15} />
              重新连接
            </button>
          </div>
        )}
        {page === 'conversation' && (
          <ConversationPage
            actions={actions}
            api={api}
            onSent={loadSnapshot}
            snapshot={data.snapshot}
          />
        )}
        {page === 'work' && (
          <WorkPage actions={actions} snapshot={data.snapshot} />
        )}
        {page === 'attention' && (
          <AttentionPage
            actions={actions}
            onRead={markRead}
            snapshot={data.snapshot}
          />
        )}
        {page === 'automation' && <AutomationPage actions={actions} />}
        {page === 'memory' && <MemoryPage actions={actions} />}
        {page === 'settings' && (
          <SettingsPage
            agentModels={agentModels}
            onBack={() => setPage('conversation')}
            onDiscoverModels={(provider, model, draft) =>
              api.discoverModels(provider, model, draft)
            }
            onOpenDrawer={openDrawer}
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
          />
        )}
      </AppShell>
      {searchOpen && (
        <GlobalSearch
          channels={data.snapshot.channels}
          onClose={closeSearch}
          onOpen={channel => {
            setSearchOpen(false)
            setDrawer(
              enrichDrawer({
                kind: 'task',
                channel,
                run: data.snapshot.runs.find(run => run.taskId === channel.id),
              }),
            )
          }}
        />
      )}
      {drawer && (
        <DetailDrawer
          onChange={view => setDrawer(enrichDrawer(view))}
          onClose={closeDrawer}
          onContinue={() => {
            setDrawer(undefined)
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
            await loadSnapshot()
          }}
          view={drawer}
        />
      )}
      {setupOpen && (
        <Onboarding
          response={data.settings}
          onContinueSettings={() => {
            setSetupOpen(false)
            setPage('settings')
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
