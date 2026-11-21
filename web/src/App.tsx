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
  actionIdFromMessage,
  approvalIdFromMessage,
  clarificationQuestions,
  isReconciliationMessage,
  latestRunForTask,
  reviewProjection,
  runIdFromMessage,
  unresolvedAttentionMessages,
  type AppData,
  type AppPage,
  type DrawerView,
  type SettingsSection,
  type ThemeChoice,
} from './sealed/types'
import type {
  Approval,
  Automation,
  DshModelCatalog,
  DshModelCatalogItem,
  MemoryRecord,
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
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(() =>
    settingsSectionFromLocation(),
  )
  const [searchOpen, setSearchOpen] = useState(false)
  const [automations, setAutomations] = useState<Automation[]>()
  const [automationsError, setAutomationsError] = useState('')
  const [memories, setMemories] = useState<MemoryRecord[]>()
  const [memoriesError, setMemoriesError] = useState('')
  const [memoriesTruncated, setMemoriesTruncated] = useState(false)
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
  const restoredDetailRef = useRef(false)
  const snapshotRequestRef = useRef(0)
  const usageRequestRef = useRef(0)
  const configurationRequestRef = useRef(0)
  const taskDrawerRequestRef = useRef(new Map<string, number>())
  const attentionRequestRef = useRef(0)
  const approvalProjectionRequestRef = useRef(0)
  const automationsRequestRef = useRef(0)
  const memoriesRequestRef = useRef(0)

  const loadSnapshot = useCallback(async () => {
    const requestId = snapshotRequestRef.current + 1
    snapshotRequestRef.current = requestId
    try {
      const snapshotResult = await api.snapshot()
      if (requestId !== snapshotRequestRef.current) return
      setData(current => ({
        ...current,
        snapshot: snapshotResult,
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

  const loadUsage = useCallback(async () => {
    const requestId = usageRequestRef.current + 1
    usageRequestRef.current = requestId
    try {
      const usage = await api.modelUsage()
      if (requestId !== usageRequestRef.current) return
      setData(current => ({ ...current, usage, usageError: '' }))
    } catch (caught) {
      if (requestId !== usageRequestRef.current) return
      setData(current => ({
        ...current,
        usageError:
          caught instanceof Error ? caught.message : '无法读取模型用量。',
      }))
    }
  }, [api])

  const loadAutomations = useCallback(async () => {
    const requestId = automationsRequestRef.current + 1
    automationsRequestRef.current = requestId
    try {
      const items = await api.automations()
      if (requestId !== automationsRequestRef.current) return
      setAutomations(items)
      setAutomationsError('')
    } catch (caught) {
      if (requestId !== automationsRequestRef.current) return
      setAutomationsError(
        caught instanceof Error ? caught.message : '无法读取自动化。',
      )
    }
  }, [api])

  const loadMemories = useCallback(async () => {
    const requestId = memoriesRequestRef.current + 1
    memoriesRequestRef.current = requestId
    try {
      const items: MemoryRecord[] = []
      let cursor: string | undefined
      let truncated = false
      for (let page = 0; page < 3; page += 1) {
        const result = await api.memories({
          ...(cursor ? { cursor } : {}),
        })
        items.push(...result.memories)
        cursor = result.nextCursor
        if (!cursor) break
        truncated = true
      }
      if (requestId !== memoriesRequestRef.current) return
      setMemories(items)
      setMemoriesTruncated(truncated)
      setMemoriesError('')
    } catch (caught) {
      if (requestId !== memoriesRequestRef.current) return
      setMemoriesError(
        caught instanceof Error ? caught.message : '无法读取记忆。',
      )
    }
  }, [api])

  useEffect(() => {
    if (page === 'automation') void loadAutomations()
    if (
      page === 'memory' ||
      (page === 'settings' && settingsSection === 'memory')
    )
      void loadMemories()
  }, [page, settingsSection, loadAutomations, loadMemories])

  const loadConfiguration = useCallback(
    async (preserveSettings = false) => {
      const requestId = configurationRequestRef.current + 1
      configurationRequestRef.current = requestId
      const [settings, catalog] = await Promise.allSettled([
        api.settings(),
        api.agentModels(),
      ])
      if (requestId !== configurationRequestRef.current) return
      setData(current => ({
        ...current,
        ...(settings.status === 'fulfilled' &&
        (!preserveSettings || !current.settings)
          ? { settings: settings.value }
          : {}),
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
    },
    [api],
  )

  useEffect(() => {
    void loadSnapshot()
    void loadUsage()
    void loadConfiguration()
    const snapshotInterval = window.setInterval(
      () => void loadSnapshot(),
      5_000,
    )
    const usageInterval = window.setInterval(() => void loadUsage(), 30_000)
    return () => {
      window.clearInterval(snapshotInterval)
      window.clearInterval(usageInterval)
    }
  }, [loadConfiguration, loadSnapshot, loadUsage])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (setupOpen) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (drawer || searchOpen) return
        rememberFocus()
        setSearchOpen(true)
      }
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (searchOpen) closeSearch()
        else if (drawer) closeDrawer()
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [drawer, searchOpen, setupOpen])

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('.app-shell')
    if (!shell) return
    const modalOpen =
      Boolean(drawer) ||
      searchOpen ||
      setupOpen ||
      Boolean(document.querySelector('.modal-backdrop'))
    shell.inert = modalOpen
    return () => {
      shell.inert = false
    }
  }, [drawer, searchOpen, setupOpen, page])

  useEffect(() => {
    const titles: Record<AppPage, string> = {
      conversation: '对话',
      work: '所有事情',
      attention: '待你处理',
      automation: '自动化',
      memory: '记忆',
      settings: '设置',
    }
    document.title = `${titles[page]} · Pegas`
  }, [page])

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
    const run =
      (view.selectedRunId
        ? runs.find(item => item.id === view.selectedRunId)
        : undefined) ??
      latestRunForTask(runs, channel.id) ??
      view.run
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
    const totalTokens = records
      .map(record => {
        if (record.totalTokens !== undefined) return record.totalTokens
        if (
          record.inputTokens === undefined &&
          record.outputTokens === undefined
        )
          return undefined
        return (record.inputTokens ?? 0) + (record.outputTokens ?? 0)
      })
      .filter((value): value is number => value !== undefined)
    return {
      ...view,
      channel,
      run,
      runs,
      usage: {
        totalTokens: totalTokens.length
          ? totalTokens.reduce((total, value) => total + value, 0)
          : undefined,
        durationMs: sum('durationMs'),
        costUsd: sum('costUsd'),
      },
    }
  }
  const loadTaskDrawer = useCallback(
    async (channelId: string) => {
      const requestId = (taskDrawerRequestRef.current.get(channelId) ?? 0) + 1
      taskDrawerRequestRef.current.set(channelId, requestId)
      void api
        .taskDelivery(channelId)
        .then(delivery => {
          if (taskDrawerRequestRef.current.get(channelId) !== requestId) return
          setDrawer(current =>
            current?.kind === 'task' && current.channel.id === channelId
              ? { ...current, delivery, deliveryError: undefined }
              : current,
          )
        })
        .catch((caught: unknown) => {
          if (taskDrawerRequestRef.current.get(channelId) !== requestId) return
          setDrawer(current =>
            current?.kind === 'task' && current.channel.id === channelId
              ? {
                  ...current,
                  deliveryError:
                    caught instanceof Error
                      ? caught.message
                      : '读取交付审查数据失败。',
                }
              : current,
          )
        })
      try {
        const scoped = await api.snapshot(channelId)
        if (taskDrawerRequestRef.current.get(channelId) !== requestId) return
        const timeline = scoped.channelTimeline
        setDrawer(current => {
          if (current?.kind !== 'task' || current.channel.id !== channelId)
            return current
          const runs = timeline?.runs ?? scoped.runs
          const selectedRun = current.selectedRunId
            ? runs.find(item => item.id === current.selectedRunId)
            : undefined
          return {
            ...current,
            channel: timeline?.channel ?? current.channel,
            run:
              selectedRun ?? latestRunForTask(runs, channelId) ?? current.run,
            runs,
            ...(timeline ? { timeline } : {}),
            timelineError: undefined,
          }
        })
      } catch (caught) {
        if (taskDrawerRequestRef.current.get(channelId) !== requestId) return
        const message =
          caught instanceof Error ? caught.message : '无法读取 Channel 时间线。'
        setDrawer(current =>
          current?.kind === 'task' && current.channel.id === channelId
            ? { ...current, timelineError: message }
            : current,
        )
      }
    },
    [api],
  )
  function openDrawer(
    view: DrawerView,
    options: { rememberTrigger?: boolean; updateLocation?: boolean } = {},
  ) {
    attentionRequestRef.current += 1
    if (options.rememberTrigger !== false) rememberFocus()
    setDrawer(enrichDrawer(view))
    if (view.kind === 'task') {
      if (options.updateLocation !== false) {
        const url = new URL(window.location.href)
        url.searchParams.set('channel', view.channel.id)
        url.searchParams.delete('task')
        url.searchParams.delete('outbox')
        window.history.pushState(
          {},
          '',
          `${url.pathname}${url.search}${url.hash}`,
        )
      }
      void loadTaskDrawer(view.channel.id)
    }
  }
  function closeDrawer() {
    attentionRequestRef.current += 1
    drawerReturnRef.current = undefined
    const url = new URL(window.location.href)
    if (url.searchParams.has('channel') || url.searchParams.has('task')) {
      url.searchParams.delete('channel')
      url.searchParams.delete('task')
      window.history.replaceState(
        {},
        '',
        `${url.pathname}${url.search}${url.hash}`,
      )
    }
    setDrawer(undefined)
    restoreFocus()
  }
  const drawerReturnRef = useRef<DrawerView | undefined>(undefined)
  function openNestedDrawer(view: DrawerView) {
    if (drawer) drawerReturnRef.current = drawer
    setDrawer(view)
    if (view.kind === 'task') void loadTaskDrawer(view.channel.id)
    if (view.kind === 'review' && !view.goal) loadReviewGoal(view)
  }
  function loadReviewGoal(view: Extract<DrawerView, { kind: 'review' }>) {
    void api
      .taskDelivery(view.channel.id)
      .then(delivery => {
        setDrawer(current =>
          current?.kind === 'review' &&
          current.message.id === view.message.id &&
          delivery.goal
            ? { ...current, goal: delivery.goal }
            : current,
        )
      })
      .catch(() => undefined)
  }
  function changeDrawer(view: DrawerView) {
    if (
      drawer?.kind === 'preview' &&
      drawer.backLabel &&
      view.kind === 'preview' &&
      view.contentUrl === drawer.contentUrl &&
      drawerReturnRef.current
    ) {
      const parent = drawerReturnRef.current
      drawerReturnRef.current = undefined
      setDrawer(parent)
      if (parent.kind === 'task') void loadTaskDrawer(parent.channel.id)
      return
    }
    setDrawer(view)
  }
  function openSearch() {
    rememberFocus()
    setSearchOpen(true)
  }
  function closeSearch() {
    setSearchOpen(false)
    restoreFocus()
  }

  function navigate(nextPage: AppPage, nextSettingsSection?: SettingsSection) {
    setPage(nextPage)
    const url = new URL(window.location.href)
    if (nextPage === 'conversation') url.searchParams.delete('view')
    else
      url.searchParams.set(
        'view',
        nextPage === 'attention' ? 'outbox' : nextPage,
      )
    if (nextPage !== 'attention') url.searchParams.delete('outbox')
    if (nextPage === 'settings')
      url.searchParams.set(
        'section',
        nextSettingsSection ?? settingsSectionFromLocation(),
      )
    else url.searchParams.delete('section')
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`)
  }

  const openDrawerChannelId = drawer?.kind === 'task' ? drawer.channel.id : ''
  const openApprovalId = drawer?.kind === 'approval' ? drawer.approval.id : ''
  const openReconciliationActionId =
    drawer?.kind === 'reconciliation' ? drawer.action.id : ''
  useEffect(() => {
    if (!openReconciliationActionId) return
    let cancelled = false
    const refresh = async () => {
      try {
        const action = await api.action(openReconciliationActionId)
        if (cancelled) return
        setDrawer(current =>
          current?.kind === 'reconciliation' &&
          current.action.id === openReconciliationActionId &&
          Date.parse(action.updatedAt) >= Date.parse(current.action.updatedAt)
            ? { ...current, action }
            : current,
        )
      } catch {
        return
      }
    }
    const interval = window.setInterval(() => void refresh(), 5_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [api, openReconciliationActionId])
  useEffect(() => {
    if (!openDrawerChannelId) return
    const interval = window.setInterval(
      () => void loadTaskDrawer(openDrawerChannelId),
      5_000,
    )
    return () => window.clearInterval(interval)
  }, [loadTaskDrawer, openDrawerChannelId])

  useEffect(() => {
    if (!openApprovalId) return
    let cancelled = false
    const refresh = async () => {
      const requestId = approvalProjectionRequestRef.current + 1
      approvalProjectionRequestRef.current = requestId
      try {
        const approval = await api.approval(openApprovalId)
        if (requestId !== approvalProjectionRequestRef.current) return
        const action = await api.action(approval.actionId)
        if (cancelled || requestId !== approvalProjectionRequestRef.current)
          return
        setDrawer(current =>
          current?.kind === 'approval' && current.approval.id === openApprovalId
            ? current.approval.status !== 'pending' &&
              approval.status === 'pending'
              ? current
              : { ...current, approval, action, decisionError: undefined }
            : current,
        )
      } catch {
        // Keep the last authoritative projection visible during transient polls.
      }
    }
    const interval = window.setInterval(() => void refresh(), 5_000)
    return () => {
      cancelled = true
      approvalProjectionRequestRef.current += 1
      window.clearInterval(interval)
    }
  }, [api, openApprovalId])

  useEffect(() => {
    const restorePage = () => {
      const attentionRequestId = attentionRequestRef.current + 1
      attentionRequestRef.current = attentionRequestId
      setPage(pageFromLocation())
      setSettingsSection(settingsSectionFromLocation())
      const messageId = new URLSearchParams(window.location.search).get(
        'outbox',
      )
      const message = data.snapshot.messages.find(item => item.id === messageId)
      if (message) {
        void restoreAttentionDrawer(message, attentionRequestId)
        return
      }
      const parameters = new URLSearchParams(window.location.search)
      const channelId = parameters.get('channel') ?? parameters.get('task')
      const channel = data.snapshot.channels.find(item => item.id === channelId)
      if (channel) {
        setDrawer({
          kind: 'task',
          channel,
          run: latestRunForTask(data.snapshot.runs, channel.id),
        })
        void loadTaskDrawer(channel.id)
      } else
        setDrawer(current => {
          if (current) restoreFocus()
          return undefined
        })
    }
    window.addEventListener('popstate', restorePage)
    return () => window.removeEventListener('popstate', restorePage)
  }, [
    data.snapshot.channels,
    data.snapshot.messages,
    data.snapshot.runs,
    loadTaskDrawer,
  ])

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
    setDrawer(current =>
      current?.kind === 'message' && current.message.id === updated.id
        ? { ...current, message: updated }
        : current,
    )
  }

  async function openAttentionMessage(message: OutboxMessage) {
    const requestId = attentionRequestRef.current + 1
    attentionRequestRef.current = requestId
    rememberFocus()
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'outbox')
    url.searchParams.set('outbox', message.id)
    window.history.replaceState(
      {},
      '',
      `${url.pathname}${url.search}${url.hash}`,
    )
    const restored = await restoreAttentionDrawer(message, requestId)
    if (!restored) return
    if (message.readAt) return
    try {
      await markRead(message)
    } catch (caught) {
      handleAttentionError(caught)
    }
  }

  function handleAttentionError(caught: unknown) {
    if (caught instanceof ApiError && caught.status === 401)
      setUnauthorized(true)
    else
      setError(
        caught instanceof Error ? caught.message : '标记已读失败，请重试。',
      )
  }

  async function restoreAttentionDrawer(
    message: OutboxMessage,
    requestId: number,
  ): Promise<boolean> {
    const review = reviewProjection(message)
    const questions = clarificationQuestions(message)
    if (review ?? questions) {
      const channel = data.snapshot.channels.find(
        item => item.id === message.taskId,
      )
      if (channel) {
        if (requestId !== attentionRequestRef.current) return false
        if (review) {
          const reviewView = {
            kind: 'review',
            review,
            channel,
            message,
          } as const
          setDrawer(reviewView)
          loadReviewGoal(reviewView)
        } else
          setDrawer({
            kind: 'clarification',
            questions: questions ?? [],
            channel,
            message,
          })
        return true
      }
    }
    if (isReconciliationMessage(message)) {
      const actionId = actionIdFromMessage(message)
      if (actionId) {
        try {
          const action = await api.action(actionId)
          if (requestId !== attentionRequestRef.current) return false
          setDrawer({ kind: 'reconciliation', action, message })
          return true
        } catch (caught) {
          if (requestId !== attentionRequestRef.current) return false
          if (caught instanceof ApiError && caught.status === 401)
            setUnauthorized(true)
          else
            setError(
              caught instanceof Error
                ? caught.message
                : '读取待核对动作失败，请重试。',
            )
          return false
        }
      }
    }
    const approvalId = approvalIdFromMessage(message)
    if (approvalId) {
      try {
        const approval = await api.approval(approvalId)
        if (requestId !== attentionRequestRef.current) return false
        const action = await api.action(approval.actionId)
        if (requestId !== attentionRequestRef.current) return false
        setDrawer({ kind: 'approval', approval, action, message })
        return true
      } catch (caught) {
        if (requestId !== attentionRequestRef.current) return false
        if (caught instanceof ApiError && caught.status === 401)
          setUnauthorized(true)
        else
          setError(
            caught instanceof Error
              ? caught.message
              : '读取审批详情失败，请重试。',
          )
        return false
      }
    }
    const channel = data.snapshot.channels.find(
      item => item.id === message.taskId,
    )
    if (!channel) {
      setDrawer({ kind: 'message', message })
      return true
    }
    const selectedRunId = runIdFromMessage(message)
    setDrawer(
      enrichDrawer({
        kind: 'task',
        channel,
        run:
          data.snapshot.runs.find(item => item.id === selectedRunId) ??
          latestRunForTask(data.snapshot.runs, channel.id),
        ...(selectedRunId ? { selectedRunId } : {}),
      }),
    )
    void loadTaskDrawer(channel.id)
    return true
  }

  useEffect(() => {
    if (restoredDetailRef.current || loading || !snapshotLoaded) return
    const parameters = new URLSearchParams(window.location.search)
    const messageId = parameters.get('outbox')
    const message = data.snapshot.messages.find(item => item.id === messageId)
    if (message) {
      restoredDetailRef.current = true
      setPage('attention')
      void openAttentionMessage(message)
      return
    }
    const channelId = parameters.get('channel') ?? parameters.get('task')
    const channel = data.snapshot.channels.find(item => item.id === channelId)
    if (!channelId || channel) restoredDetailRef.current = true
    if (!channel) return
    setDrawer({
      kind: 'task',
      channel,
      run: latestRunForTask(data.snapshot.runs, channel.id),
    })
    void loadTaskDrawer(channel.id)
  }, [
    data.snapshot.channels,
    data.snapshot.messages,
    data.snapshot.runs,
    loadTaskDrawer,
    loading,
    snapshotLoaded,
  ])

  if (unauthorized)
    return (
      <AccessGate
        onToken={nextToken => {
          sessionStorage.setItem('pegas-token', nextToken)
          setToken(nextToken)
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
  function continueChannel(channelId: string) {
    setContinuationTaskId(channelId)
    const url = new URL(window.location.href)
    url.searchParams.delete('channel')
    url.searchParams.delete('task')
    window.history.replaceState(
      {},
      '',
      `${url.pathname}${url.search}${url.hash}`,
    )
    setDrawer(undefined)
    navigate('conversation')
    window.setTimeout(() =>
      document.querySelector<HTMLTextAreaElement>('#pegas-message')?.focus(),
    )
  }
  const unreadCount = unresolvedAttentionMessages(
    data.snapshot.messages,
  ).filter(message => !message.readAt).length
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
        connectionStatus={loading ? 'connecting' : error ? 'offline' : 'online'}
        onNavigate={nextPage => {
          if (nextPage === 'settings') {
            setSettingsSection('pegas')
            navigate(nextPage, 'pegas')
          } else navigate(nextPage)
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
                if (error) void loadSnapshot()
                if (configurationError)
                  void loadConfiguration(Boolean(data.settings))
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
            onAnswerClarification={channel => continueChannel(channel.id)}
            onClearContinuation={() => setContinuationTaskId(undefined)}
            onConfigureVoice={() => {
              setSettingsSection('voice')
              navigate('settings', 'voice')
            }}
            onDraftChange={setComposerDraft}
            onSelectModel={selectAgentModel}
            onSent={async () => {
              await loadSnapshot()
              void loadUsage()
            }}
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
        {page === 'automation' && (
          <AutomationPage
            actions={actions}
            automations={automations}
            channels={data.snapshot.channels}
            error={automationsError}
            onCreate={async draft => {
              await api.createAutomation(draft)
              await loadAutomations()
            }}
            onLoadInvocations={automation =>
              api.automationInvocations(automation.id)
            }
            onReload={() => void loadAutomations()}
            onSetStatus={async (automation, action) => {
              await api.setAutomationStatus(
                automation.id,
                automation.revision,
                action,
              )
              await loadAutomations()
            }}
            onUpdate={async (automation, draft) => {
              await api.updateAutomation(
                automation.id,
                automation.revision,
                draft,
              )
              await loadAutomations()
            }}
          />
        )}
        {page === 'memory' && (
          <MemoryPage
            actions={actions}
            channels={data.snapshot.channels}
            error={memoriesError}
            memories={memories}
            onCreate={async draft => {
              await api.createMemory(draft)
              await loadMemories()
            }}
            onDelete={async memory => {
              await api.deleteMemory(memory.id, memory.revision)
              await loadMemories()
            }}
            onReload={() => void loadMemories()}
            onUpdate={async (memory, draft) => {
              await api.updateMemory(memory.id, memory.revision, draft)
              await loadMemories()
            }}
            truncated={memoriesTruncated}
          />
        )}
        {page === 'settings' && (
          <SettingsPage
            agentModels={agentModels}
            initialSection={settingsSection}
            memories={memories}
            memoriesError={memoriesError}
            onBack={() => navigate('conversation')}
            onDiscoverModels={(provider, model, draft) =>
              api.discoverModels(provider, model, draft)
            }
            onOpenDrawer={openDrawer}
            onOpenMemory={() => navigate('memory')}
            onReloadUsage={() => void loadUsage()}
            onSectionChange={nextSection => {
              setSettingsSection(nextSection)
              const url = new URL(window.location.href)
              url.searchParams.set('section', nextSection)
              window.history.replaceState(
                {},
                '',
                `${url.pathname}${url.search}${url.hash}`,
              )
            }}
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
          onSearch={query => api.searchChannels(query)}
          onOpen={channel => {
            setSearchOpen(false)
            openDrawer(
              {
                kind: 'task',
                channel,
                run: latestRunForTask(data.snapshot.runs, channel.id),
              },
              { rememberTrigger: false },
            )
          }}
        />
      )}
      {resolvedDrawer && (
        <DetailDrawer
          onChange={changeDrawer}
          onClose={closeDrawer}
          onOpenView={openNestedDrawer}
          onContinue={channel => continueChannel(channel.id)}
          onDecideApproval={async (approvalId, optionId, rationale) => {
            approvalProjectionRequestRef.current += 1
            let approval: Approval
            try {
              approval = await api.decideApproval(
                approvalId,
                optionId,
                rationale,
              )
            } catch (caught) {
              let refreshedApproval: Approval
              try {
                refreshedApproval = await api.approval(approvalId)
              } catch {
                throw caught
              }
              if (refreshedApproval.status === 'pending') throw caught
              approvalProjectionRequestRef.current += 1
              setDrawer(current =>
                current?.kind === 'approval' &&
                current.approval.id === approvalId
                  ? { ...current, approval: refreshedApproval }
                  : current,
              )
              const actionRequestId = approvalProjectionRequestRef.current
              try {
                const refreshedAction = await api.action(
                  refreshedApproval.actionId,
                )
                if (actionRequestId !== approvalProjectionRequestRef.current)
                  return
                setDrawer(current =>
                  current?.kind === 'approval' &&
                  current.approval.id === approvalId
                    ? {
                        ...current,
                        approval: refreshedApproval,
                        action: refreshedAction,
                      }
                    : current,
                )
              } catch (refreshError) {
                if (actionRequestId !== approvalProjectionRequestRef.current)
                  return
                const message =
                  refreshError instanceof Error
                    ? `决定已保存，但 Action 状态刷新失败：${refreshError.message}`
                    : '决定已保存，但 Action 状态刷新失败，请稍后重试。'
                setDrawer(current =>
                  current?.kind === 'approval' &&
                  current.approval.id === approvalId
                    ? { ...current, decisionError: message }
                    : current,
                )
                void loadSnapshot().catch(handleAttentionError)
                return
              }
              void loadSnapshot().catch(handleAttentionError)
              return
            }
            approvalProjectionRequestRef.current += 1
            setDrawer(current =>
              current?.kind === 'approval' && current.approval.id === approvalId
                ? { ...current, approval }
                : current,
            )
            const actionRequestId = approvalProjectionRequestRef.current
            try {
              const action = await api.action(approval.actionId)
              if (actionRequestId !== approvalProjectionRequestRef.current)
                return
              setDrawer(current =>
                current?.kind === 'approval' &&
                current.approval.id === approvalId
                  ? { ...current, approval, action }
                  : current,
              )
            } catch (caught) {
              if (actionRequestId !== approvalProjectionRequestRef.current)
                return
              const message =
                caught instanceof Error
                  ? `决定已保存，但 Action 状态刷新失败：${caught.message}`
                  : '决定已保存，但 Action 状态刷新失败，请稍后重试。'
              setDrawer(current =>
                current?.kind === 'approval' &&
                current.approval.id === approvalId
                  ? { ...current, decisionError: message }
                  : current,
              )
              void loadSnapshot().catch(handleAttentionError)
              return
            }
            void loadSnapshot().catch(handleAttentionError)
          }}
          onRetry={async run => {
            const successor = await api.retryRun(run.id)
            setDrawer(current => {
              if (current?.kind !== 'task' || current.channel.id !== run.taskId)
                return current
              return {
                ...current,
                run: successor,
                runs: [
                  ...(current.runs?.filter(item => item.id !== successor.id) ??
                    []),
                  successor,
                ],
                selectedRunId: successor.id,
              }
            })
            await Promise.all([loadSnapshot(), loadTaskDrawer(run.taskId)])
          }}
          onStop={async channel => {
            await api.stopChannel(channel.id, 'Stopped from the Pegas UI')
            await Promise.all([loadSnapshot(), loadTaskDrawer(channel.id)])
          }}
          onReconcileAction={async (actionId, resolution, note) => {
            approvalProjectionRequestRef.current += 1
            const action = await api.reconcileAction(actionId, resolution, note)
            const approvalId =
              drawer?.kind === 'approval' && drawer.action.id === actionId
                ? drawer.approval.id
                : undefined
            setDrawer(current =>
              current?.kind === 'approval' && current.action.id === actionId
                ? { ...current, action, decisionError: undefined }
                : current?.kind === 'reconciliation' &&
                    current.action.id === actionId
                  ? { ...current, action }
                  : current,
            )
            if (approvalId) {
              const requestId = approvalProjectionRequestRef.current
              try {
                const approval = await api.approval(approvalId)
                if (requestId !== approvalProjectionRequestRef.current) return
                setDrawer(current =>
                  current?.kind === 'approval' && current.action.id === actionId
                    ? { ...current, approval }
                    : current,
                )
              } catch {
                void loadSnapshot().catch(handleAttentionError)
                return
              }
            }
            await loadSnapshot()
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
  if (view === 'tasks') return 'work'
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

function settingsSectionFromLocation(): SettingsSection {
  const section = new URLSearchParams(window.location.search).get('section')
  const valid: readonly SettingsSection[] = [
    'pegas',
    'appearance',
    'models',
    'router',
    'voice',
    'connections',
    'memory',
    'privacy',
    'notifications',
    'usage',
    'recovery',
    'about',
  ]
  return valid.includes(section as SettingsSection)
    ? (section as SettingsSection)
    : 'pegas'
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
