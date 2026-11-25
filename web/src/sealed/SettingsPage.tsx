import {
  AlertTriangle,
  Bell,
  Bot,
  Box,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Database,
  Layers3,
  Link2,
  LockKeyhole,
  Mic,
  Monitor,
  MoonStar,
  Network,
  Palette,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Volume2,
  Zap,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  Button,
  FormField,
  RadioGroup,
  RadioItem,
  SegmentedControl,
  Switch,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TextArea,
  TextInput,
} from '@bui/index'

import type {
  BehaviorPreferences,
  DesktopResidency,
  DshModelCatalog,
  ExecutionNode,
  MemoryRecord,
  ModelCatalogItem,
  ModelProviderCapability,
  ModelProviderDraft,
  ModelUsageRecord,
  ModelUsageReport,
  NotificationPreferences,
  NotificationPreferencesUpdate,
  RecoveryStatus,
  RuntimeSettings,
  RewriteSettingsDraft,
  RewriteSettings,
  SettingsResponse,
  SpeechSettingsDraft,
  SpeechSettings,
  WorkRuleRecord,
  RoutingRuleRecord,
  RoutingPreview,
} from '../types'

const RULES_PAGE_SIZE = 10

function settingsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameSettings(
  left: RuntimeSettings | undefined,
  right: RuntimeSettings | undefined,
): boolean {
  if (!left || !right) return left === right
  const normalize = (settings: RuntimeSettings) =>
    Object.fromEntries(
      Object.entries(settings).filter(
        ([key, value]) =>
          key !== 'revision' && key !== 'updatedAt' && value !== undefined,
      ),
    )
  return settingsEqual(normalize(left), normalize(right))
}

function providerDraftDirty(
  draft: ModelProviderDraft | undefined,
  saved: ModelProviderCapability | undefined,
): boolean {
  if (!draft) return false
  if (draft.clearApiKey || draft.apiKey !== '') return true
  if (!saved) return true
  return (
    draft.name !== saved.name ||
    draft.protocol !== saved.protocol ||
    draft.baseUrl !== saved.baseUrl
  )
}

function connectionDraftDirty(
  draft: SpeechSettingsDraft | RewriteSettingsDraft | undefined,
  saved: SpeechSettings | RewriteSettings | undefined,
): boolean {
  if (!draft) return false
  if (draft.clearApiKey || draft.apiKey !== '') return true
  const defaults = {
    provider: 'disabled',
    mode: 'router',
    protocol: 'openai-chat',
    baseUrl: '',
    model: '',
    hasApiKey: false,
  }
  const comparable = (entry: object) =>
    Object.fromEntries(
      Object.entries(entry).filter(
        ([key]) => key !== 'apiKey' && key !== 'clearApiKey',
      ),
    )
  const baseline = saved ?? defaults
  const draftFields = comparable(draft)
  const baselineFields = comparable(baseline)
  return Object.keys(baselineFields).some(
    key => draftFields[key] !== baselineFields[key],
  )
}

function RulePagination({
  total,
  page,
  onPageChange,
  label,
}: {
  total: number
  page: number
  onPageChange: (page: number) => void
  label: string
}) {
  const pageCount = Math.max(1, Math.ceil(total / RULES_PAGE_SIZE))
  if (pageCount <= 1) return null
  const current = Math.min(page, pageCount - 1)
  return (
    <div
      aria-label={label}
      className="mt-2 flex items-center gap-2"
      role="navigation"
    >
      <span className="flex-1 text-[11px] text-ink-2">
        {current * RULES_PAGE_SIZE + 1}–
        {Math.min((current + 1) * RULES_PAGE_SIZE, total)} / {total}
      </span>
      <Button
        className="h-[30px] flex-none rounded-control px-3 text-[13px] whitespace-nowrap"
        disabled={current === 0}
        onClick={() => onPageChange(Math.max(0, current - 1))}
        size="sm"
        type="button"
        variant="secondary"
      >
        上一页
      </Button>
      <Button
        className="h-[30px] flex-none rounded-control px-3 text-[13px] whitespace-nowrap"
        disabled={current >= pageCount - 1}
        onClick={() => onPageChange(Math.min(pageCount - 1, current + 1))}
        size="sm"
        type="button"
        variant="secondary"
      >
        下一页
      </Button>
    </div>
  )
}
import { useVoiceDictation } from '../useVoiceDictation'
import { ModelPicker, modelSelectionKey } from './ModelPicker'
import { PegasMark } from './PegasMark'
import { PegasMascot } from './PegasMascot'
import {
  formatRelativeTime,
  settingsSections,
  type DrawerView,
  type SettingsSection,
  type ThemeChoice,
} from './types'

const sectionIcons: Record<SettingsSection, typeof Bot> = {
  pegas: Bot,
  appearance: Palette,
  models: Layers3,
  router: SlidersHorizontal,
  voice: Mic,
  connections: Link2,
  memory: Database,
  privacy: Shield,
  notifications: Bell,
  usage: Volume2,
  recovery: Box,
  about: CircleHelp,
}

interface SettingsPageProps {
  initialSection?: SettingsSection
  response?: SettingsResponse
  memories?: MemoryRecord[]
  memoriesError?: string
  workRules?: WorkRuleRecord[]
  workRulesError?: string
  routingRules?: RoutingRuleRecord[]
  routingRulesError?: string
  behaviorPreferences?: BehaviorPreferences
  behaviorPreferencesError?: string
  residency?: DesktopResidency
  residencyError?: string
  notificationPreferences?: NotificationPreferences
  notificationPreferencesError?: string
  executionNodes?: ExecutionNode[]
  executionNodesError?: string
  recoveryStatus?: RecoveryStatus
  recoveryStatusError?: string
  usage?: ModelUsageReport
  usageError?: string
  agentModels?: DshModelCatalog
  onSave: (
    settings: RuntimeSettings,
    provider: ModelProviderDraft,
    speech?: SpeechSettingsDraft,
    rewrite?: RewriteSettingsDraft,
  ) => Promise<void>
  onOpenDrawer: (drawer: DrawerView) => void
  onOpenMemory?: () => void
  onReloadUsage: () => void
  onReloadWorkRules?: () => void
  onToggleWorkRule?: (rule: WorkRuleRecord) => Promise<void>
  onReloadRoutingRules?: () => void
  onToggleRoutingRule?: (rule: RoutingRuleRecord) => Promise<void>
  onTestRouting?: (text: string) => Promise<RoutingPreview>
  onSaveBehavior?: (customInstructions: string) => Promise<void>
  onToggleResidency?: (resident: boolean) => Promise<void>
  onReloadNotifications?: () => void
  onReloadExecutionNodes?: () => void
  onReloadRecovery?: () => void
  onSaveNotifications?: (update: NotificationPreferencesUpdate) => Promise<void>
  onBack: () => void
  onSectionChange?: (section: SettingsSection) => void
  onDiscoverModels: (
    provider: RuntimeSettings['modelProvider'],
    model: string,
    draft: ModelProviderDraft,
  ) => Promise<ModelCatalogItem[]>
  onTestModel: (
    provider: RuntimeSettings['modelProvider'],
    model: string,
    draft: ModelProviderDraft,
  ) => Promise<{ ok: true; latencyMs: number }>
  onTestSpeech: SettingsTestSpeech
  onTestRewrite: SettingsTestRewrite
  theme: ThemeChoice
  systemDark: boolean
  onThemeChange: (theme: ThemeChoice) => void
}

type SettingsTestSpeech = (
  audio: Blob,
  speech: SpeechSettingsDraft,
) => Promise<{ transcript: { text: string }; latencyMs: number }>
type SettingsTestRewrite = (
  text: string,
  rewrite: RewriteSettingsDraft,
  settings: RuntimeSettings,
  provider: ModelProviderDraft,
) => Promise<{
  original: string
  rewritten: string
  changed: boolean
  latencyMs: number
}>

export function SettingsPage({
  initialSection = 'pegas',
  response,
  memories,
  memoriesError,
  workRules,
  workRulesError,
  routingRules,
  routingRulesError,
  behaviorPreferences,
  behaviorPreferencesError,
  residency,
  residencyError,
  notificationPreferences,
  notificationPreferencesError,
  executionNodes,
  executionNodesError,
  recoveryStatus,
  recoveryStatusError,
  usage,
  usageError,
  agentModels,
  onSave,
  onOpenDrawer,
  onOpenMemory,
  onReloadUsage,
  onReloadWorkRules,
  onToggleWorkRule,
  onReloadRoutingRules,
  onToggleRoutingRule,
  onTestRouting,
  onSaveBehavior,
  onToggleResidency,
  onReloadNotifications,
  onReloadExecutionNodes,
  onReloadRecovery,
  onSaveNotifications,
  onBack,
  onSectionChange,
  onDiscoverModels,
  onTestModel,
  onTestSpeech,
  onTestRewrite,
  theme,
  systemDark,
  onThemeChange,
}: SettingsPageProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [draft, setDraft] = useState<RuntimeSettings | undefined>(
    response?.settings,
  )
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{
    kind: 'success' | 'error'
    message: string
  }>()
  const [modelServiceProvider, setModelServiceProvider] =
    useState<RuntimeSettings['modelProvider']>()
  const [providerDraft, setProviderDraft] = useState<ModelProviderDraft>()
  const [providerCatalogs, setProviderCatalogs] = useState<
    Record<
      string,
      {
        generation: number
        models: ModelCatalogItem[]
      }
    >
  >({})
  const [catalogGeneration, setCatalogGeneration] = useState(0)
  const [speechDraft, setSpeechDraft] = useState<SpeechSettingsDraft>()
  const [rewriteDraft, setRewriteDraft] = useState<RewriteSettingsDraft>()
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)
  useEffect(() => setSection(initialSection), [initialSection])
  useEffect(() => {
    if (notice?.kind !== 'success') return
    const timer = window.setTimeout(() => setNotice(undefined), 2400)
    return () => window.clearTimeout(timer)
  }, [notice])
  const savedProvider = response?.capabilities.providers.find(
    provider => provider.id === response.settings.modelProvider,
  )
  const dirty =
    !sameSettings(draft, response?.settings) ||
    providerDraftDirty(providerDraft, savedProvider) ||
    connectionDraftDirty(speechDraft, response?.speech) ||
    connectionDraftDirty(rewriteDraft, response?.rewrite)
  const footerActive = dirty || saving || notice !== undefined
  useEffect(() => {
    setDraft(response?.settings)
    setProviderCatalogs({})
    setCatalogGeneration(current => current + 1)
    setNotice(undefined)
    setModelServiceProvider(response?.settings.modelProvider)
    const provider = response?.capabilities.providers.find(
      item => item.id === response.settings.modelProvider,
    )
    setProviderDraft(
      provider
        ? {
            name: provider.name,
            protocol: provider.protocol,
            baseUrl: provider.baseUrl,
            apiKey: '',
            clearApiKey: false,
          }
        : undefined,
    )
    setSpeechDraft(
      response?.speech
        ? { ...response.speech, apiKey: '', clearApiKey: false }
        : response
          ? {
              provider: 'disabled',
              baseUrl: '',
              model: '',
              hasApiKey: false,
              apiKey: '',
              clearApiKey: false,
            }
          : undefined,
    )
    setRewriteDraft(
      response?.rewrite
        ? { ...response.rewrite, apiKey: '', clearApiKey: false }
        : response
          ? {
              mode: 'router',
              protocol: 'openai-chat',
              baseUrl: '',
              model: '',
              hasApiKey: false,
              apiKey: '',
              clearApiKey: false,
            }
          : undefined,
    )
  }, [response])

  async function save(skipFullAccessConfirmation = false) {
    if (!draft || !providerDraft || saving) return
    if (
      draft.permissionTier === 'full' &&
      response?.settings.permissionTier !== 'full' &&
      !skipFullAccessConfirmation
    ) {
      setConfirmingFullAccess(true)
      return
    }
    setSaving(true)
    setNotice(undefined)
    try {
      await onSave(draft, providerDraft, speechDraft, rewriteDraft)
      setNotice({ kind: 'success', message: '更改已保存' })
    } catch (caught) {
      setNotice({
        kind: 'error',
        message:
          caught instanceof Error ? caught.message : '保存失败，请重试。',
      })
    } finally {
      setSaving(false)
    }
  }

  function selectSection(next: SettingsSection) {
    setSection(next)
    onSectionChange?.(next)
  }

  function editDraft(next: RuntimeSettings) {
    setNotice(undefined)
    setDraft(next)
  }

  function editProviderDraft(next: ModelProviderDraft) {
    setProviderCatalogs({})
    setCatalogGeneration(current => current + 1)
    setNotice(undefined)
    setProviderDraft(next)
  }

  function editSpeechDraft(next: SpeechSettingsDraft) {
    setNotice(undefined)
    setSpeechDraft(next)
  }

  function editRewriteDraft(next: RewriteSettingsDraft) {
    setNotice(undefined)
    setRewriteDraft(next)
  }

  return (
    <div className="settings-page bui grid h-full min-h-0 [grid-template-columns:210px_minmax(0,1fr)] max-[1120px]:[grid-template-columns:190px_minmax(0,1fr)] max-[820px]:block max-[820px]:overflow-auto">
      <aside
        className="settings-nav overflow-auto border-r border-line bg-inset px-3 py-[27px] max-[820px]:flex max-[820px]:gap-[5px] max-[820px]:overflow-x-auto max-[820px]:border-r-0 max-[820px]:border-b max-[820px]:px-3.5 max-[820px]:py-3 max-[820px]:whitespace-nowrap max-[820px]:[mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)]"
        aria-label="设置分类"
      >
        <div className="settings-nav-title mx-2.5 mb-[22px] flex items-center justify-between max-[820px]:m-0">
          <h1 className="text-[20px] leading-[1.25] tracking-[-0.02em] max-[820px]:hidden">
            设置
          </h1>
          <Button
            aria-label="返回 Pegas"
            className="h-[30px] px-1 text-[12px] font-normal text-ink-2 max-[820px]:min-w-12"
            onClick={onBack}
            size="xs"
            type="button"
            variant="quiet"
          >
            返回
          </Button>
        </div>
        {settingsSections.map(item => {
          const Icon = sectionIcons[item.id]
          return (
            <Button
              aria-current={section === item.id ? 'page' : undefined}
              className="h-[39px] w-full justify-start gap-2.5 rounded-control px-3 text-[14px] font-normal hover:bg-hover aria-[current=page]:bg-accent-tint aria-[current=page]:font-medium aria-[current=page]:text-accent-ink max-[820px]:h-9 max-[820px]:w-auto max-[820px]:flex-none"
              key={item.id}
              onClick={() => selectSection(item.id)}
              size="sm"
              type="button"
              variant="quiet"
            >
              <Icon size={17} />
              <span>{item.label}</span>
            </Button>
          )
        })}
      </aside>
      <section className="settings-content relative grid min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-clip max-[820px]:h-[calc(100dvh-61px)]">
        <div className="settings-scroll-region min-h-0 overflow-auto overscroll-contain [scrollbar-gutter:stable]">
          <fieldset
            className="settings-fields m-0 w-full min-w-0 border-0 p-0"
            disabled={saving}
          >
            {section === 'appearance' ? (
              <AppearanceSettings
                onChange={onThemeChange}
                systemDark={systemDark}
                theme={theme}
              />
            ) : !draft || !response ? (
              <div className="p-12 text-[13px] text-ink-2">正在读取设置…</div>
            ) : (
              <>
                {section === 'pegas' && (
                  <PegasSettings
                    agentModels={agentModels}
                    behaviorPreferences={behaviorPreferences}
                    behaviorPreferencesError={behaviorPreferencesError}
                    draft={draft}
                    onChange={editDraft}
                    onOpenDrawer={onOpenDrawer}
                    onReloadWorkRules={onReloadWorkRules}
                    onSaveBehavior={onSaveBehavior}
                    onToggleWorkRule={onToggleWorkRule}
                    residency={residency}
                    residencyError={residencyError}
                    onToggleResidency={onToggleResidency}
                    onGoPrivacy={() => selectSection('privacy')}
                    workRules={workRules}
                    workRulesError={workRulesError}
                  />
                )}
                {section === 'models' && (
                  <ModelServices
                    catalogFor={provider => {
                      const cached = providerCatalogs[provider]
                      const currentDraft =
                        provider === draft.modelProvider
                          ? providerDraft
                          : undefined
                      if (cached?.generation === catalogGeneration)
                        return cached.models
                      const saved = response.capabilities.providers.find(
                        item => item.id === provider,
                      )
                      if (
                        currentDraft &&
                        providerDraftDirty(currentDraft, saved)
                      )
                        return []
                      return (agentModels?.models ?? []).filter(
                        model => model.provider === provider,
                      )
                    }}
                    onCatalog={(provider, models) =>
                      setProviderCatalogs(current => ({
                        ...current,
                        [provider]: {
                          generation: catalogGeneration,
                          models,
                        },
                      }))
                    }
                    draft={draft}
                    onDiscoverModels={onDiscoverModels}
                    onOpenRouter={() => selectSection('router')}
                    onOpenVoice={() => selectSection('voice')}
                    onTestModel={onTestModel}
                    providerDraft={providerDraft}
                    response={response}
                    selected={modelServiceProvider}
                    setSelected={setModelServiceProvider}
                    setProviderDraft={editProviderDraft}
                  />
                )}
                {section === 'router' && (
                  <RouterSettings
                    agentModels={agentModels}
                    draft={draft}
                    response={response}
                    routingRules={routingRules}
                    routingRulesError={routingRulesError}
                    onOpenDrawer={onOpenDrawer}
                    onReloadRoutingRules={onReloadRoutingRules}
                    onToggleRoutingRule={onToggleRoutingRule}
                    onTestRouting={onTestRouting}
                    onChange={next => {
                      if (next.modelProvider !== draft.modelProvider) {
                        const provider = response.capabilities.providers.find(
                          item => item.id === next.modelProvider,
                        )
                        if (provider)
                          editProviderDraft({
                            name: provider.name,
                            protocol: provider.protocol,
                            baseUrl: provider.baseUrl,
                            apiKey: '',
                            clearApiKey: false,
                          })
                      }
                      editDraft(next)
                    }}
                  />
                )}
                {section === 'voice' &&
                  speechDraft &&
                  rewriteDraft &&
                  providerDraft && (
                    <VoiceSettings
                      draft={draft}
                      onChange={editDraft}
                      onSpeechChange={editSpeechDraft}
                      onRewriteChange={editRewriteDraft}
                      onTestRewrite={onTestRewrite}
                      onTestSpeech={onTestSpeech}
                      providerDraft={providerDraft}
                      rewriteDraft={rewriteDraft}
                      speechDraft={speechDraft}
                    />
                  )}
                {section === 'connections' && (
                  <ConnectionsSettings
                    error={executionNodesError}
                    nodes={executionNodes}
                    onReload={onReloadExecutionNodes}
                  />
                )}
                {section === 'memory' && (
                  <MemorySettings
                    error={memoriesError}
                    memories={memories}
                    onOpenMemory={onOpenMemory}
                  />
                )}
                {section === 'privacy' && (
                  <PrivacySettings
                    available={response.capabilities.privacyAvailable}
                    draft={draft}
                    onChange={editDraft}
                  />
                )}
                {section === 'notifications' && (
                  <NotificationSettings
                    error={notificationPreferencesError}
                    onReload={onReloadNotifications}
                    onSave={onSaveNotifications}
                    preferences={notificationPreferences}
                  />
                )}
                {section === 'usage' && (
                  <UsageSettings
                    error={usageError}
                    onRetry={onReloadUsage}
                    usage={usage}
                  />
                )}
                {section === 'recovery' && (
                  <RecoverySettings
                    error={recoveryStatusError}
                    onReload={onReloadRecovery}
                    status={recoveryStatus}
                  />
                )}
                {section === 'about' && <AboutSettings />}
              </>
            )}
          </fieldset>
        </div>
        {draft &&
          providerDraft &&
          footerActive &&
          ['pegas', 'models', 'router', 'voice', 'privacy'].includes(section) &&
          (section !== 'models' ||
            modelServiceProvider === draft.modelProvider) && (
            <footer className="settings-footer relative z-[5] flex min-h-16 animate-[message-reveal_200ms_cubic-bezier(0.16,1,0.3,1)] items-center gap-2.5 border-t border-line bg-surface px-7 py-2.5 max-[520px]:px-3.5">
              <span
                className={`flex-1 text-[12px] max-[520px]:min-w-0 max-[520px]:wrap-anywhere ${notice?.kind === 'error' ? 'text-red-text' : 'text-green-text'}`}
                role={notice?.kind === 'error' ? 'alert' : 'status'}
              >
                {notice?.message ?? '有未保存的更改'}
              </span>
              <Button
                className="h-8 px-3.5 text-[13px]"
                disabled={saving}
                onClick={() => {
                  setNotice(undefined)
                  setDraft(response?.settings)
                  setModelServiceProvider(response?.settings.modelProvider)
                  const savedProvider = response?.capabilities.providers.find(
                    provider => provider.id === response.settings.modelProvider,
                  )
                  if (savedProvider)
                    editProviderDraft({
                      name: savedProvider.name,
                      protocol: savedProvider.protocol,
                      baseUrl: savedProvider.baseUrl,
                      apiKey: '',
                      clearApiKey: false,
                    })
                  if (response?.speech)
                    setSpeechDraft({
                      ...response.speech,
                      apiKey: '',
                      clearApiKey: false,
                    })
                  else
                    setSpeechDraft({
                      provider: 'disabled',
                      baseUrl: '',
                      model: '',
                      hasApiKey: false,
                      apiKey: '',
                      clearApiKey: false,
                    })
                  if (response?.rewrite)
                    setRewriteDraft({
                      ...response.rewrite,
                      apiKey: '',
                      clearApiKey: false,
                    })
                  else
                    setRewriteDraft({
                      mode: 'router',
                      protocol: 'openai-chat',
                      baseUrl: '',
                      model: '',
                      hasApiKey: false,
                      apiKey: '',
                      clearApiKey: false,
                    })
                }}
                type="button"

                size="xs"
                variant="secondary"
              >
                取消
              </Button>
              <Button
                className="h-9 px-4 text-[13px]"
                disabled={saving}
                onClick={() => void save()}
                type="button"

                size="sm"
                variant="primary"
              >
                {saving ? '保存中…' : '保存更改'}
              </Button>
            </footer>
          )}
        {confirmingFullAccess && (
          <div
            aria-labelledby="settings-full-access-risk-title"
            aria-modal="true"
            className="stop-confirmation"
            role="dialog"
          >
            <header>
              <AlertTriangle size={18} />
              <strong id="settings-full-access-risk-title">
                确认完全访问风险
              </strong>
            </header>
            <p>
              完全访问档位下，Pegas 不再拦截工作区之外的写入与命令副作用；
              高风险动作仍会请求你的审批，控制面自修改仍被强制拦截。
              该默认档位会应用到所有未单独覆盖权限的事情。
            </p>
            <div className="stop-confirmation-actions">
              <Button
                className="h-8 px-3.5 text-[13px]"
                onClick={() => setConfirmingFullAccess(false)}
                type="button"

                size="xs"
                variant="secondary"
              >
                取消
              </Button>
              <Button
                className="h-8 px-3.5 text-[13px]"
                onClick={() => {
                  setConfirmingFullAccess(false)
                  void save(true)
                }}
                type="button"

                size="xs"
                variant="danger"
              >
                我已了解，启用完全访问
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function SettingsHeading({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <header className="settings-heading mb-[22px] border-b border-line pb-[18px]">
      <h2 className="mb-[5px] text-[26px] leading-[1.2] tracking-[-0.03em]">
        {title}
      </h2>
      <p className="text-ink-2">{description}</p>
    </header>
  )
}

function AppearanceSettings({
  theme,
  systemDark,
  onChange,
}: {
  theme: ThemeChoice
  systemDark: boolean
  onChange: (theme: ThemeChoice) => void
}) {
  const choices: readonly {
    id: ThemeChoice
    label: string
    description: string
    icon: typeof Sun
  }[] = [
    {
      id: 'system',
      label: '跟随系统',
      description: `随系统自动切换；当前为${systemDark ? '深色' : '明亮'}。`,
      icon: Monitor,
    },
    {
      id: 'light',
      label: '明亮',
      description: '默认白底，适合明亮环境。',
      icon: Sun,
    },
    {
      id: 'dark',
      label: '深色',
      description: '深色表面，适合低光环境。',
      icon: MoonStar,
    },
  ]
  return (
    <div className="settings-pane mx-auto max-w-[900px] px-9 pt-[34px] pb-10 max-[1120px]:px-6 max-[820px]:px-[18px] max-[820px]:pt-6 max-[820px]:pb-[34px] appearance-settings">
      <SettingsHeading
        title="外观"
        description="选择 Pegas 在这台设备上的显示方式。"
      />
      <fieldset>
        <legend>主题</legend>
        <RadioGroup
          aria-label="主题"
          className="appearance-options bui grid grid-cols-2 gap-3 max-[820px]:grid-cols-1"
          onValueChange={value => onChange(value as ThemeChoice)}
          value={theme}
        >
          {choices.map(({ id, label, description, icon: Icon }) => (
            <label
              className="grid min-h-[104px] cursor-pointer grid-cols-[76px_minmax(0,1fr)_18px] items-center gap-3.5 rounded-card bg-surface p-3.5 shadow-hairline transition-shadow duration-150 hover:bg-inset has-[[data-state=checked]]:bg-accent-tint has-[[data-state=checked]]:shadow-[0_0_0_1px_var(--accent)] has-[[data-focus-visible]]:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_33%,transparent)]"
              key={id}
            >
              <span
                aria-hidden="true"
                className={`appearance-preview is-${id}`}
              >
                <i />
                <i />
                <i />
              </span>
              <span className="grid min-w-0 gap-1.5">
                <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
                  <Icon size={17} />
                  <strong>{label}</strong>
                </span>
                <small className="text-[12px] leading-normal text-ink-2">
                  {description}
                </small>
              </span>
              <RadioItem aria-label={label} value={id} />
            </label>
          ))}
        </RadioGroup>
      </fieldset>
      <div className="my-3 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2">
        <CircleHelp size={16} />
        更改会立即生效，并保存在当前设备。
      </div>
    </div>
  )
}

function PegasSettings({
  draft,
  agentModels,
  workRules,
  workRulesError,
  behaviorPreferences,
  behaviorPreferencesError,
  residency,
  residencyError,
  onChange,
  onOpenDrawer,
  onReloadWorkRules,
  onToggleWorkRule,
  onSaveBehavior,
  onToggleResidency,
  onGoPrivacy,
}: {
  draft: RuntimeSettings
  agentModels?: DshModelCatalog
  workRules?: WorkRuleRecord[]
  workRulesError?: string
  behaviorPreferences?: BehaviorPreferences
  behaviorPreferencesError?: string
  residency?: DesktopResidency
  residencyError?: string
  onChange: (settings: RuntimeSettings) => void
  onOpenDrawer: (drawer: DrawerView) => void
  onReloadWorkRules?: () => void
  onToggleWorkRule?: (rule: WorkRuleRecord) => Promise<void>
  onSaveBehavior?: (customInstructions: string) => Promise<void>
  onToggleResidency?: (resident: boolean) => Promise<void>
  onGoPrivacy?: () => void
}) {
  const [tab, setTab] = useState<'model' | 'behavior' | 'autonomy'>('model')
  const [modelPickerRequest, setModelPickerRequest] = useState(0)
  const models = agentModels?.models ?? []
  const selectedModel = draft.agentModelName.trim()
    ? draft.agentModelName
    : (agentModels?.defaultModel ?? '')
  const selectedProvider = draft.agentModelProvider.trim()
    ? draft.agentModelProvider
    : (agentModels?.defaultProvider ?? '')
  const selectedModelValue =
    draft.agentModelMode === 'profile'
      ? 'profile'
      : selectedProvider && selectedModel
        ? `${selectedProvider}::${selectedModel}`
        : ''
  const selectedCatalogModel = models.find(
    model =>
      modelSelectionKey(model) === selectedModelValue ||
      (model.id === selectedModel &&
        model.provider.toLocaleLowerCase() ===
          selectedProvider.toLocaleLowerCase()),
  )
  const selectedModelAvailable = agentModels?.models.some(
    model =>
      model.provider.toLocaleLowerCase() ===
        selectedProvider.toLocaleLowerCase() && model.id === selectedModel,
  )
  const availability = !agentModels
    ? { dotClassName: 'bg-orange', label: '目录未知' }
    : selectedModelAvailable
      ? { dotClassName: 'bg-green', label: '可用' }
      : { dotClassName: 'bg-red', label: '未在模型目录中' }
  return (
    <div className="settings-pane mx-auto max-w-[900px] px-9 pt-[34px] pb-10 max-[1120px]:px-6 max-[820px]:px-[18px] max-[820px]:pt-6 max-[820px]:pb-[34px] pegas-settings">
      <div className="pegas-settings-title flex items-center gap-3.5 [&_.settings-heading]:m-0 [&_.settings-heading]:border-0 [&_.settings-heading]:p-0">
        <PegasMark size={44} />
        <SettingsHeading
          title="Pegas"
          description="设置你的个人执行伙伴如何工作和与你沟通。"
        />
      </div>
      <div className="setting-summary-row grid min-h-[54px] items-center gap-3 border-b border-line [grid-template-columns:100px_minmax(180px,1fr)_auto_auto] max-[820px]:[grid-template-columns:90px_1fr_auto] max-[520px]:[grid-template-columns:1fr_auto] max-[520px]:py-2.5">
        <span className="font-medium max-[520px]:[grid-column:1/3]">
          执行模型
        </span>
        <b className="text-[13px] max-[520px]:wrap-anywhere">
          {selectedProvider && selectedModel
            ? `${selectedProvider} · ${selectedModel}`
            : '服务端未提供'}
        </b>
        <em className="flex items-center gap-1.5 text-[12px] not-italic text-green-text">
          <i
            className={`size-[7px] rounded-full ${availability.dotClassName}`}
          />
          {availability.label}
        </em>
        <Button
          className="h-8 px-3.5 text-[13px]"
          onClick={() => {
            setTab('model')
            setModelPickerRequest(request => request + 1)
          }}
          type="button"

          size="xs"
          variant="secondary"
        >
          更换模型
        </Button>
      </div>
      <div className="setting-summary-row grid min-h-[54px] items-center gap-3 border-b border-line [grid-template-columns:100px_minmax(180px,1fr)_auto_auto] max-[820px]:[grid-template-columns:90px_1fr_auto] max-[520px]:[grid-template-columns:1fr_auto] max-[520px]:py-2.5">
        <span className="font-medium max-[520px]:[grid-column:1/3]">
          执行环境
        </span>
        <b className="text-[13px] max-[520px]:wrap-anywhere">隔离执行环境</b>
        <em className="flex items-center gap-1.5 text-[12px] not-italic text-green-text">
          <i className="size-[7px] rounded-full bg-green" />
          运行时快照
        </em>
        <Button
          className="h-8 px-3.5 text-[13px]"
          onClick={() => onOpenDrawer({ kind: 'runtime' })}
          type="button"

          size="xs"
          variant="secondary"
        >
          查看运行时
        </Button>
      </div>
      <div className="my-3 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2">
        <CircleHelp size={16} />
        模型变更仅作用于新会话；已有会话继续使用创建时的模型。
      </div>
      <div
        className="settings-tabs bui mt-3 flex gap-4 border-b border-line"
        role="tablist"
      >
        {(
          [
            ['model', '执行模型'],
            ['behavior', '行为与规则'],
            ['autonomy', '自主程度'],
          ] as const
        ).map(([value, label]) => (
          <button
            aria-selected={tab === value}
            className="-mb-px min-h-[42px] border-b-2 border-transparent px-2 text-[13px] text-ink-2 transition-colors duration-150 hover:text-ink aria-selected:border-accent aria-selected:font-medium aria-selected:text-accent-ink"
            key={value}
            onClick={() => setTab(value)}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'model' && (
        <div className="setting-section py-[18px]">
          <h3 className="mt-4 mb-2.5 text-[14px]">新建执行会话</h3>
          <div className="my-3.5 grid gap-1.5">
            <span className="text-[13px] font-medium text-ink">模型</span>
            <ModelPicker
              ariaLabel="模型"
              fixedOptions={[
                {
                  value: 'profile',
                  label: '隔离环境默认模型（Pegas 专属 profile）',
                  hint: '跟随隔离执行环境的默认配置',
                },
              ]}
              footer="选择后仍需点击「保存更改」生效"
              models={models}
              onSelect={(value, model) => {
                if (value === 'profile') {
                  onChange({
                    ...draft,
                    agentModelMode: 'profile',
                    agentModelProvider: '',
                    agentModelName: '',
                  })
                  return
                }
                if (!model) return
                onChange({
                  ...draft,
                  agentModelMode: 'override',
                  agentModelProvider: model.provider,
                  agentModelName: model.id,
                })
              }}
              openRequest={modelPickerRequest}
              placeholder={models.length ? '选择模型' : '服务端未提供可选模型'}
              value={
                selectedCatalogModel
                  ? modelSelectionKey(selectedCatalogModel)
                  : selectedModelValue
              }
            />
          </div>
          <p className="text-[12px] leading-[1.6] text-ink-2">
            凭证由 Pegas 的模型服务或隔离的 DSH profile 提供，不读取个人默认
            profile。
          </p>
          <h3 className="mt-4 mb-2.5 text-[14px]">执行池（可选）</h3>
          <p className="text-[12px] leading-[1.6] text-ink-2">
            为事情级执行设置提供 fast / balanced / deep 档位。留空的池按
            fast→balanced→全局默认 显式降级，绝不静默换池。
          </p>
          {(['fast', 'balanced', 'deep'] as const).map(poolKey => {
            const poolModel = draft.executionPools?.[poolKey]
            const value = poolModel
              ? `${poolModel.provider}::${poolModel.model}`
              : ''
            const poolCatalogModel = models.find(
              model =>
                modelSelectionKey(model) === value ||
                (model.id === poolModel?.model &&
                  model.provider.toLocaleLowerCase() ===
                    poolModel.provider.toLocaleLowerCase()),
            )
            return (
              <div className="my-3.5 grid gap-1.5" key={poolKey}>
                <span className="text-[13px] font-medium text-ink">
                  {poolKey} 池模型
                </span>
                <ModelPicker
                  ariaLabel={`${poolKey} 池模型`}
                  fixedOptions={[
                    {
                      value: '',
                      label: '未配置（按降级链处理）',
                      hint: '清除该池的覆盖',
                    },
                  ]}
                  footer="选择后仍需点击「保存更改」生效"
                  models={models}
                  onSelect={(nextValue, model) => {
                    if (!nextValue) {
                      const next = Object.fromEntries(
                        Object.entries(draft.executionPools ?? {}).filter(
                          ([key]) => key !== poolKey,
                        ),
                      )
                      onChange({ ...draft, executionPools: next })
                      return
                    }
                    if (!model) return
                    const next = {
                      ...(draft.executionPools ?? {}),
                      [poolKey]: {
                        provider: model.provider,
                        model: model.id,
                      },
                    }
                    onChange({ ...draft, executionPools: next })
                  }}
                  placeholder="未配置（按降级链处理）"
                  title={`${poolKey} 池模型`}
                  value={
                    poolCatalogModel
                      ? modelSelectionKey(poolCatalogModel)
                      : value
                  }
                />
              </div>
            )
          })}
        </div>
      )}
      {tab === 'behavior' && (
        <BehaviorSettings
          behaviorPreferences={behaviorPreferences}
          behaviorPreferencesError={behaviorPreferencesError}
          onOpenDrawer={onOpenDrawer}
          onReloadWorkRules={onReloadWorkRules}
          onSaveBehavior={onSaveBehavior}
          onToggleWorkRule={onToggleWorkRule}
          workRules={workRules}
          workRulesError={workRulesError}
        />
      )}
      {tab === 'autonomy' && (
        <div className="setting-section py-[18px]">
          <h3 className="mt-4 mb-2.5 text-[14px]">自主程度</h3>
          <p className="text-[12px] leading-[1.6] text-ink-2">
            自主程度由默认权限档位与自动审阅决定；高风险与关键风险 Action
            始终由服务端强制进入持久 Approval，不受档位影响。
          </p>
          <div className="compact-field-row grid min-h-[52px] items-center gap-3.5 border-b border-line py-2 [grid-template-columns:120px_minmax(0,1fr)] max-[820px]:items-start max-[820px]:[grid-template-columns:1fr] max-[820px]:py-3">
            <span className="font-medium">默认权限档位</span>
            <SegmentedControl
              ariaLabel="自主程度权限档位"
              onChange={value => onChange({ ...draft, permissionTier: value })}
              options={[
                { value: 'strict', label: '严格' },
                { value: 'standard', label: '标准' },
                { value: 'full', label: '完全访问' },
              ]}
              value={draft.permissionTier ?? 'standard'}
            />
          </div>
          <p className="text-[12px] leading-[1.6] text-ink-2">
            严格：只读放行，写与网络都审批；标准：区内放行，越界审批；完全访问：显式风险披露后放行。
            收紧对下一次工具调用立即生效，放宽只影响后续运行。
          </p>
          <div className="switch-row bui flex items-center justify-between py-3">
            <span className="text-[13px] text-ink">自动审阅</span>
            <Switch
              checked={draft.autoReviewEnabled === true}
              label="自动审阅（自主程度）"
              onChange={checked =>
                onChange({ ...draft, autoReviewEnabled: checked })
              }
            />
          </div>
          <p className="text-[12px] leading-[1.6] text-ink-2">
            待审批操作先交给模型按你的原话初审：明确授权的放行，其余仍由你决定。
          </p>
          {onGoPrivacy && (
            <Button
              className="mt-2 h-8 px-3.5 text-[13px]"
              onClick={onGoPrivacy}
              size="xs"
              type="button"
              variant="secondary"
            >
              <ShieldCheck size={15} />
              前往隐私设置
            </Button>
          )}
          <p className="text-[12px] leading-[1.6] text-ink-2">
            与「隐私」页读写同一份服务端设置，修改后点击「保存更改」生效；单个事情可在执行设置里覆盖默认档位。
          </p>
        </div>
      )}
      <ResidencySettings
        residency={residency}
        residencyError={residencyError}
        onToggleResidency={onToggleResidency}
      />
    </div>
  )
}

function ResidencySettings({
  residency,
  residencyError,
  onToggleResidency,
}: {
  residency?: DesktopResidency
  residencyError?: string
  onToggleResidency?: (resident: boolean) => Promise<void>
}) {
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const state = residency
  async function toggle(resident: boolean) {
    if (!onToggleResidency) return
    setSaving(true)
    setError('')
    try {
      await onToggleResidency(resident)
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : '切换失败，原状态保持不变。',
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="setting-section py-[18px]">
      <h3 className="mt-4 mb-2.5 text-[14px]">后台运行</h3>
      {!state && (residencyError ?? '') === '' ? (
        <p className="my-3 text-[13px] text-ink-2">正在读取后台运行状态…</p>
      ) : state?.managed !== true ? (
        <p className="my-3 text-[13px] leading-[1.6] text-ink-2">
          {(residencyError ?? '') !== ''
            ? residencyError
            : (state?.diagnostics?.[0] ??
              '此实例不是由桌面 App 托管；后台运行由该实例的部署方式决定。')}
        </p>
      ) : state.resident === undefined ? (
        <p className="my-3 text-[13px] leading-[1.6] text-ink-2">
          {state.diagnostics?.[0] ?? '后台运行状态暂不可读。'}
        </p>
      ) : (
        <>
          <div className="switch-row bui flex items-center justify-between py-3">
            <span className="text-[13px] text-ink">关闭窗口后继续运行</span>
            <Switch
              checked={state.resident}
              disabled={saving}
              label="关闭窗口后继续运行"
              onChange={checked => void toggle(checked)}
            />
          </div>
          <p className="text-[12px] leading-[1.6] text-ink-2">
            {state.resident
              ? '关闭窗口只隐藏窗口，服务与定时自动化继续运行，登录本机时自动启动。'
              : '退出 App 即停止服务；定时自动化仅在 App 打开期间运行。'}
          </p>
        </>
      )}
      {error ? (
        <p
          className="mt-2 rounded-card bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_var(--red)]"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}

function BehaviorSettings({
  workRules,
  workRulesError,
  behaviorPreferences,
  behaviorPreferencesError,
  onOpenDrawer,
  onReloadWorkRules,
  onToggleWorkRule,
  onSaveBehavior,
}: {
  workRules?: WorkRuleRecord[]
  workRulesError?: string
  behaviorPreferences?: BehaviorPreferences
  behaviorPreferencesError?: string
  onOpenDrawer: (drawer: DrawerView) => void
  onReloadWorkRules?: () => void
  onToggleWorkRule?: (rule: WorkRuleRecord) => Promise<void>
  onSaveBehavior?: (customInstructions: string) => Promise<void>
}) {
  const [instructions, setInstructions] = useState('')
  const [savingInstructions, setSavingInstructions] = useState(false)
  const [togglingRuleId, setTogglingRuleId] = useState('')
  const [actionError, setActionError] = useState('')
  const [instructionsNotice, setInstructionsNotice] = useState('')
  const [rulePage, setRulePage] = useState(0)
  const rulePageCount = Math.max(
    1,
    Math.ceil((workRules ?? []).length / RULES_PAGE_SIZE),
  )
  const currentRulePage = Math.min(rulePage, rulePageCount - 1)
  const pagedWorkRules = (workRules ?? []).slice(
    currentRulePage * RULES_PAGE_SIZE,
    (currentRulePage + 1) * RULES_PAGE_SIZE,
  )
  useEffect(() => {
    if (!behaviorPreferences) return
    setInstructions(behaviorPreferences.customInstructions)
  }, [behaviorPreferences])
  const loading = !workRules && !workRulesError
  async function toggle(rule: WorkRuleRecord) {
    if (!onToggleWorkRule || togglingRuleId) return
    setTogglingRuleId(rule.id)
    setActionError('')
    try {
      await onToggleWorkRule(rule)
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : '更新规则失败，请重试。',
      )
    } finally {
      setTogglingRuleId('')
    }
  }
  async function saveInstructions() {
    if (!onSaveBehavior || !behaviorPreferences || savingInstructions) return
    setSavingInstructions(true)
    setActionError('')
    setInstructionsNotice('')
    try {
      await onSaveBehavior(instructions)
      setInstructionsNotice('自定义指令已保存，对后续执行生效。')
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : '保存自定义指令失败。',
      )
    } finally {
      setSavingInstructions(false)
    }
  }
  return (
    <div className="setting-section py-[18px]">
      <div className="my-3 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2">
        <CircleHelp size={16} />
        工作规则与自定义指令以持久偏好的形式提供给执行
        Agent，在每次执行中持续遵守；它们不授予新权限，高风险动作仍必须经过确认。
      </div>
      <h3 className="mt-4 mb-2.5 text-[14px]">基本行为</h3>
      <div className="compact-field-row grid min-h-[52px] items-center gap-3.5 border-b border-line py-2 [grid-template-columns:120px_minmax(0,1fr)] max-[820px]:items-start max-[820px]:[grid-template-columns:1fr] max-[820px]:py-3">
        <span className="font-medium">开始工作前</span>
        <Select defaultValue="always" disabled>
          <SelectTrigger
            aria-label="开始工作前"
            className="h-10 w-full rounded-control bg-field shadow-inset-field hover:bg-field"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="always">高风险动作始终确认</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-[12px] leading-[1.6] text-ink-2">
        「高风险动作始终确认」由服务端 Approval 强制保证，不能关闭。
      </p>
      <h3 className="mt-4 mb-2.5 text-[14px]">工作规则</h3>
      {workRulesError ? (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_var(--red)]"
          role="alert"
        >
          {workRulesError}
          {onReloadWorkRules && (
            <Button
              className="h-8 px-3.5 text-[13px]"
              onClick={onReloadWorkRules}
              type="button"

              size="xs"
              variant="secondary"
            >
              <RotateCw size={15} />
              重新读取
            </Button>
          )}
        </div>
      ) : loading ? (
        <p className="my-6 text-[13px] text-ink-2">正在读取工作规则…</p>
      ) : (
        <>
          <div className="rule-list overflow-hidden rounded-card shadow-hairline">
            <Button
              className="h-auto min-h-[42px] w-full justify-start gap-2.5 rounded-none border-b border-line bg-surface px-3 text-left font-normal disabled:opacity-100 disabled:text-ink-2"
              disabled
              size="sm"
              type="button"
              variant="quiet"
            >
              <LockKeyhole size={15} />
              <span className="flex-1 text-ink">高风险外部操作必须确认</span>
              <small className="text-[12px] text-ink-2">
                系统规则（已锁定）
              </small>
            </Button>
            {pagedWorkRules.map(rule => (
              <div
                className="rule-row flex items-center border-b border-line bg-surface last:border-b-0"
                key={rule.id}
              >
                <Button
                  className="h-auto min-h-[42px] min-w-0 flex-1 justify-start gap-2.5 rounded-none bg-surface px-3 text-left font-normal hover:bg-inset"
                  onClick={() =>
                    onOpenDrawer({
                      kind: 'rule',
                      title: rule.title,
                      rule,
                      ...(behaviorPreferences
                        ? { behavior: behaviorPreferences }
                        : {}),
                      ...(onReloadWorkRules
                        ? { onSaved: onReloadWorkRules }
                        : {}),
                    })
                  }
                  size="sm"
                  type="button"
                  variant="quiet"
                >
                  <span className="flex-1">{rule.title}</span>
                  <small className="text-[12px] text-ink-2">
                    {rule.enabled ? '全局 · 启用' : '全局 · 停用'}
                  </small>
                  <Pencil size={15} />
                </Button>
                <div className="rule-toggle flex items-center px-3">
                  <Switch
                    checked={rule.enabled}
                    disabled={togglingRuleId === rule.id}
                    label={`${rule.enabled ? '停用' : '启用'}规则：${rule.title}`}
                    onChange={() => void toggle(rule)}
                  />
                </div>
              </div>
            ))}
          </div>
          <RulePagination
            label="工作规则分页"
            onPageChange={setRulePage}
            page={rulePage}
            total={(workRules ?? []).length}
          />
          {(workRules ?? []).length === 0 && (
            <p className="text-[12px] leading-[1.6] text-ink-2">
              还没有自定义工作规则；添加后会注入每次执行。
            </p>
          )}
          <Button
            className="mt-2 h-8 px-3.5 text-[13px] text-accent-ink shadow-[0_0_0_1px_var(--accent)]"
            onClick={() =>
              onOpenDrawer({
                kind: 'rule',
                title: '添加规则',
                ...(onReloadWorkRules ? { onSaved: onReloadWorkRules } : {}),
              })
            }
            size="xs"
            type="button"
            variant="secondary"
          >
            <Plus size={16} />
            添加规则
          </Button>
        </>
      )}
      {actionError && (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_var(--red)]"
          role="alert"
        >
          {actionError}
        </div>
      )}
      <h3 className="mt-4 mb-2.5 text-[14px]">自定义指令</h3>
      {behaviorPreferencesError ? (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_var(--red)]"
          role="alert"
        >
          {behaviorPreferencesError}
          {onReloadWorkRules && (
            <Button
              className="h-8 px-3.5 text-[13px]"
              onClick={onReloadWorkRules}
              type="button"

              size="xs"
              variant="secondary"
            >
              <RotateCw size={15} />
              重新读取
            </Button>
          )}
        </div>
      ) : !behaviorPreferences ? (
        <p className="my-6 text-[13px] text-ink-2">正在读取自定义指令…</p>
      ) : (
        <>
          <FormField className="my-3.5" label="指令内容">
            <TextArea
              className="w-full resize-y"
              disabled={savingInstructions}
              onChange={event => setInstructions(event.target.value)}
              placeholder="例如：涉及产品设计时，优先给出具体界面方案；涉及发布操作时，先列出回滚路径。"
              rows={3}
              value={instructions}
            />
          </FormField>
          <div className="mt-2 flex items-center justify-between gap-3 [&>span]:text-[12px] [&>span]:text-ink-2">
            <span role="status">{instructionsNotice}</span>
            <Button
              className="h-8 px-3.5 text-[13px]"
              disabled={
                savingInstructions ||
                instructions.trim() === behaviorPreferences.customInstructions
              }
              onClick={() => void saveInstructions()}
              type="button"

              size="xs"
              variant="secondary"
            >
              {savingInstructions ? '保存中…' : '保存自定义指令'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function ModelServices({
  catalogFor,
  onCatalog,
  response,
  draft,
  providerDraft,
  selected,
  setSelected,
  setProviderDraft,
  onDiscoverModels,
  onTestModel,
  onOpenRouter,
  onOpenVoice,
}: {
  catalogFor: (provider: string) => ModelCatalogItem[]
  onCatalog: (provider: string, models: ModelCatalogItem[]) => void
  response: SettingsResponse
  draft: RuntimeSettings
  providerDraft?: ModelProviderDraft
  selected?: RuntimeSettings['modelProvider']
  setSelected: (provider: RuntimeSettings['modelProvider']) => void
  setProviderDraft: (draft: ModelProviderDraft) => void
  onDiscoverModels: SettingsPageProps['onDiscoverModels']
  onTestModel: SettingsPageProps['onTestModel']
  onOpenRouter: () => void
  onOpenVoice: () => void
}) {
  const providers = response.capabilities.providers
  const [query, setQuery] = useState('')
  const [modelQuery, setModelQuery] = useState('')
  const [modelPage, setModelPage] = useState(0)
  const [busy, setBusy] = useState<'test' | 'discover'>()
  const [status, setStatus] = useState('')
  const providerRequestRef = useRef(0)
  const active =
    providers.find(provider => provider.id === selected) ?? providers[0]
  const models = active ? catalogFor(active.id) : []
  const activeProviderDraft: ModelProviderDraft = {
    name: active?.name ?? '',
    protocol: active?.protocol ?? 'openai-chat',
    baseUrl: active?.baseUrl ?? '',
    apiKey: '',
    clearApiKey: false,
  }
  const probeModel =
    active?.id === draft.modelProvider
      ? draft.modelName.trim()
      : (active?.defaultModel.trim() ?? '')
  const canProbe = Boolean(probeModel)
  useEffect(() => {
    providerRequestRef.current += 1
    setBusy(undefined)
    setStatus('')
    setModelPage(0)
    return () => {
      providerRequestRef.current += 1
    }
  }, [selected, providerDraft, response])
  async function discover() {
    if (!active || !canProbe) return
    const requestId = providerRequestRef.current + 1
    providerRequestRef.current = requestId
    setBusy('discover')
    setStatus('')
    try {
      const result = await onDiscoverModels(
        active.id,
        probeModel,
        active.id === draft.modelProvider && providerDraft
          ? providerDraft
          : activeProviderDraft,
      )
      if (providerRequestRef.current !== requestId) return
      onCatalog(active.id, result)
      setModelPage(0)
      setStatus(`已读取 ${String(result.length)} 个模型`)
    } catch (caught) {
      if (providerRequestRef.current !== requestId) return
      setStatus(caught instanceof Error ? caught.message : '读取模型目录失败')
    } finally {
      if (providerRequestRef.current === requestId) setBusy(undefined)
    }
  }
  async function test() {
    if (!active || !canProbe) return
    const requestId = providerRequestRef.current + 1
    providerRequestRef.current = requestId
    setBusy('test')
    setStatus('')
    try {
      const result = await onTestModel(
        active.id,
        probeModel,
        active.id === draft.modelProvider && providerDraft
          ? providerDraft
          : activeProviderDraft,
      )
      if (providerRequestRef.current !== requestId) return
      setStatus(`连接正常 · ${String(result.latencyMs)} ms`)
    } catch (caught) {
      if (providerRequestRef.current !== requestId) return
      setStatus(caught instanceof Error ? caught.message : '连接测试失败')
    } finally {
      if (providerRequestRef.current === requestId) setBusy(undefined)
    }
  }
  const visibleModels = models.filter(model =>
    `${model.name} ${model.id}`
      .toLowerCase()
      .includes(modelQuery.toLowerCase()),
  )
  const pageSize = 30
  const pageCount = Math.max(1, Math.ceil(visibleModels.length / pageSize))
  const pageModels = visibleModels.slice(
    modelPage * pageSize,
    (modelPage + 1) * pageSize,
  )
  const rangeStart = visibleModels.length ? modelPage * pageSize + 1 : 0
  const rangeEnd = Math.min((modelPage + 1) * pageSize, visibleModels.length)
  const referencedModelId =
    active?.id === response.settings.modelProvider
      ? response.settings.modelName
      : undefined
  const executionReferenced = new Set(
    [
      draft.agentModelMode === 'override'
        ? `${draft.agentModelProvider}::${draft.agentModelName}`
        : '',
      ...Object.values(draft.executionPools ?? {}).map(
        pool => `${pool.provider}::${pool.model}`,
      ),
    ].filter(Boolean),
  )
  const executionReferencesModel = (model: ModelCatalogItem) =>
    executionReferenced.has(`${active?.name ?? ''}::${model.id}`) ||
    executionReferenced.has(`${active?.id ?? ''}::${model.id}`)
  return (
    <div className="settings-pane mx-auto max-w-[900px] px-9 pt-[34px] pb-10 max-[1120px]:px-6 max-[820px]:px-[18px] max-[820px]:pt-6 max-[820px]:pb-[34px]">
      <SettingsHeading
        title="模型服务"
        description="管理连接、凭证与模型目录；不决定哪些角色使用哪个模型。"
      />
      <div className="model-service-layout -mx-2.5 -mt-[22px] grid min-h-[610px] [grid-template-columns:220px_minmax(0,1fr)] max-[820px]:-mt-3 max-[820px]:mx-0 max-[820px]:block">
        <aside className="provider-list relative border-r border-line pt-[18px] pr-3.5 pb-[60px] max-[820px]:flex max-[820px]:gap-2 max-[820px]:overflow-x-auto max-[820px]:border-r-0 max-[820px]:border-b max-[820px]:py-3 max-[820px]:pr-0 max-[820px]:pb-[18px]">
          <label className="model-search bui flex h-10 items-center gap-2 rounded-control bg-field px-3 shadow-hairline transition-shadow duration-150 focus-within:bg-surface focus-within:shadow-[0_0_0_1px_var(--accent)]">
            <Search className="shrink-0 text-ink-3" size={16} />
            <input
              aria-label="搜索模型服务"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索模型服务"
              value={query}
            />
          </label>
          <small className="mx-1.5 mt-4 mb-1.5 block text-ink-2 max-[820px]:hidden">
            已添加
          </small>
          {providers
            .filter(provider =>
              provider.name.toLowerCase().includes(query.toLowerCase()),
            )
            .map(provider => (
              <Button
                aria-current={provider.id === active?.id ? 'true' : undefined}
                className="grid h-auto min-h-[54px] w-full [grid-template-columns:32px_1fr_auto] items-center gap-2 rounded-control p-[7px] text-left font-normal hover:bg-accent-tint aria-[current=true]:bg-accent-tint max-[820px]:w-[190px] max-[820px]:flex-none"
                key={provider.id}
                onClick={() => {
                  providerRequestRef.current += 1
                  setSelected(provider.id)
                  setModelPage(0)
                  setModelQuery('')
                  setStatus('')
                }}
                type="button"
              >
                <span className="provider-glyph flex size-[30px] items-center justify-center rounded-control shadow-hairline">
                  <Layers3 size={18} />
                </span>
                <span className="grid gap-[3px]">
                  <strong>{provider.name}</strong>
                  <small
                    className={`text-[10px] ${provider.available ? 'text-green-text' : 'text-ink-2'}`}
                  >
                    {provider.available
                      ? '已配置'
                      : (provider.reason ?? '未配置')}
                  </small>
                </span>
                <ChevronRight size={15} />
              </Button>
            ))}
          <Button
            className="add-provider absolute right-3.5 bottom-0 left-0 h-8 w-[calc(100%-14px)] px-3.5 text-[13px] text-accent-ink shadow-[0_0_0_1px_var(--accent)] max-[820px]:hidden"
            disabled
            size="xs"
            title="服务端尚未提供新增 Provider API"
            type="button"
            variant="secondary"
          >
            <Plus size={16} />
            添加模型服务
          </Button>
        </aside>
        {active && (
          <div className="provider-detail pt-[18px] pl-5 max-[820px]:pl-0 [&>header]:flex [&>header]:items-start [&>header]:justify-between max-[820px]:[&>header]:mt-4 [&_h4]:mt-[18px] [&_h4]:mb-1.5 [&_h4]:border-t [&_h4]:border-line [&_h4]:pt-3.5 [&_h4]:text-[14px] [&_dl]:m-0 [&_dl>div]:grid [&_dl>div]:min-h-[34px] [&_dl>div]:[grid-template-columns:100px_1fr] [&_dl>div]:py-[7px] [&_dt]:text-ink-2 [&_dd]:m-0">
            <header>
              <div>
                <h3 className="mr-2.5 inline text-[20px] tracking-[-0.02em]">
                  {active.name}
                </h3>
                <span
                  className={`health-badge rounded-chip bg-inset px-[7px] py-1 text-[10px] ${active.available ? 'text-green-text' : 'text-ink-2'}`}
                >
                  {status || (active.available ? '已配置' : '未连接')}
                </span>
              </div>
              <Button
                className="h-8 px-3.5 text-[13px]"
                disabled={Boolean(busy) || !canProbe}
                onClick={() => void test()}
                type="button"

                size="xs"
                variant="secondary"
              >
                {busy === 'test' ? '测试中…' : '测试连接'}
              </Button>
            </header>
            <h4>连接信息</h4>
            <dl>
              <div>
                <dt>协议</dt>
                <dd>{active.protocol}</dd>
              </div>
              <div>
                <dt>服务地址</dt>
                <dd>{active.baseUrl || '尚未填写'}</dd>
              </div>
              <div>
                <dt>API Key</dt>
                <dd>
                  {active.hasApiKey ? '已保存（读取时不回显）' : '未配置'}
                </dd>
              </div>
            </dl>
            {active.id === draft.modelProvider && providerDraft ? (
              <div className="provider-edit-fields">
                {active.id === 'custom' && (
                  <FormField
                    className="my-3.5"
                    htmlFor="provider-protocol"
                    label="接口协议"
                  >
                    <Select
                      onValueChange={value =>
                        setProviderDraft({
                          ...providerDraft,
                          protocol: value as ModelProviderDraft['protocol'],
                        })
                      }
                      value={providerDraft.protocol}
                    >
                      <SelectTrigger
                        className="h-10 w-full rounded-control bg-field shadow-inset-field hover:bg-field"
                        id="provider-protocol"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="openai-chat">
                          OpenAI Chat Completions
                        </SelectItem>
                        <SelectItem value="anthropic-messages">
                          Anthropic Messages
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>
                )}
                <FormField className="my-3.5" label="服务地址">
                  <TextInput
                    className="h-10 w-full"
                    onChange={event =>
                      setProviderDraft({
                        ...providerDraft,
                        baseUrl: event.target.value,
                      })
                    }
                    readOnly={active.id !== 'custom'}
                    value={providerDraft.baseUrl}
                  />
                </FormField>
                <FormField className="my-3.5" label="API Key">
                  <TextInput
                    autoComplete="off"
                    className="h-10 w-full"
                    onChange={event =>
                      setProviderDraft({
                        ...providerDraft,
                        apiKey: event.target.value,
                        clearApiKey: false,
                      })
                    }
                    placeholder={
                      active.hasApiKey
                        ? '已保存；填写新值可替换'
                        : '输入 API Key'
                    }
                    type="password"
                    value={providerDraft.apiKey}
                  />
                </FormField>
                {active.hasApiKey && (
                  <div className="switch-row bui flex items-center justify-between py-3">
                    <span className="text-[13px] text-ink">
                      清除已保存的 API Key
                    </span>
                    <Switch
                      checked={providerDraft.clearApiKey}
                      label="清除已保存的 API Key"
                      onChange={checked =>
                        setProviderDraft({
                          ...providerDraft,
                          clearApiKey: checked,
                          apiKey: '',
                        })
                      }
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="my-3 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2">
                <LockKeyhole size={16} />
                当前服务端只允许编辑事情归类正在使用的
                Provider；请先在“事情归类”中选用。
              </div>
            )}
            {!canProbe && (
              <div className="my-3 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2">
                <LockKeyhole size={16} />
                请先在“事情归类”中选用并填写模型，再测试连接或读取目录。
              </div>
            )}
            <h4>正在使用</h4>
            <dl>
              <div>
                <dt>事情归类</dt>
                <dd>
                  {active.id === response.settings.modelProvider
                    ? response.settings.modelName
                    : '未被事情归类使用'}
                  <Button
                    className="float-right h-6 px-1 text-[12px] font-normal text-accent-ink"
                    onClick={onOpenRouter}
                    size="xs"
                    type="button"
                    variant="quiet"
                  >
                    打开设置
                  </Button>
                </dd>
              </div>
              <div>
                <dt>输入改写</dt>
                <dd>
                  {response.settings.rewriteMode === 'disabled'
                    ? '未启用'
                    : response.rewrite?.mode === 'custom'
                      ? '未引用（使用独立服务）'
                      : active.id === response.settings.modelProvider
                        ? '跟随事情归类'
                        : '未引用'}
                  <Button
                    className="float-right h-6 px-1 text-[12px] font-normal text-accent-ink"
                    onClick={onOpenVoice}
                    size="xs"
                    type="button"
                    variant="quiet"
                  >
                    打开设置
                  </Button>
                </dd>
              </div>
            </dl>
            <h4>可用模型（{models.length}）</h4>
            <div className="model-catalog-toolbar mt-2 flex items-center gap-2.5 max-[820px]:flex-col max-[820px]:items-stretch">
              <Button
                className="h-8 px-3.5 text-[13px]"
                disabled={Boolean(busy) || !canProbe}
                onClick={() => void discover()}
                type="button"

                size="xs"
                variant="secondary"
              >
                {busy === 'discover' ? '读取中…' : '获取模型目录'}
              </Button>
              <label className="model-search bui flex h-10 min-w-0 flex-1 items-center gap-2 rounded-control bg-field px-3 shadow-hairline transition-shadow duration-150 focus-within:bg-surface focus-within:shadow-[0_0_0_1px_var(--accent)]">
                <Search className="shrink-0 text-ink-3" size={16} />
                <input
                  aria-label="按名称或模型 ID 搜索"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
                  onChange={event => {
                    setModelQuery(event.target.value)
                    setModelPage(0)
                  }}
                  placeholder="按名称或模型 ID 搜索"
                  value={modelQuery}
                />
              </label>
            </div>
            <div className="model-table mt-2 text-[12px] [&>div]:grid [&>div]:min-h-8 [&>div]:[grid-template-columns:1.4fr_0.8fr_0.7fr] [&>div]:gap-2 [&>div]:px-2.5 [&>div]:py-[7px] [&>div:first-child]:text-ink-2 [&>div.is-selected]:rounded-chip [&>div.is-selected]:bg-accent-tint">
              <div>
                <b>模型</b>
                <b>能力</b>
                <b>状态</b>
              </div>
              {pageModels.map(model => {
                const isRouterModel = model.id === referencedModelId
                const isExecutionModel = executionReferencesModel(model)
                return (
                  <div
                    className={
                      isRouterModel || isExecutionModel ? 'is-selected' : ''
                    }
                    key={model.id}
                  >
                    <span>{model.name}</span>
                    <span>{model.id}</span>
                    <span className="text-green-text">
                      <i className="mr-[5px] inline-block size-[7px] rounded-full bg-green" />
                      {isRouterModel
                        ? '当前归类模型'
                        : isExecutionModel
                          ? '执行引用'
                          : '已发现'}
                    </span>
                  </div>
                )
              })}
              {!visibleModels.length && (
                <p className="px-2.5 py-4 text-center text-ink-2">
                  点击“获取模型目录”读取服务端数据。
                </p>
              )}
            </div>
            {visibleModels.length > pageSize && (
              <div className="pagination bui mt-2.5 flex items-center gap-2">
                <span className="flex-1 text-[11px] text-ink-2">
                  {rangeStart}–{rangeEnd} / {visibleModels.length}
                </span>
                <Button
                  className="h-[30px] rounded-control px-3 text-[13px]"
                  disabled={modelPage === 0}
                  onClick={() => setModelPage(page => Math.max(0, page - 1))}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  上一页
                </Button>
                <Button
                  className="h-[30px] rounded-control px-3 text-[13px]"
                  disabled={modelPage >= pageCount - 1}
                  onClick={() =>
                    setModelPage(page => Math.min(pageCount - 1, page + 1))
                  }
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  下一页
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function RouterSettings({
  draft,
  response,
  agentModels,
  routingRules,
  routingRulesError,
  onOpenDrawer,
  onReloadRoutingRules,
  onToggleRoutingRule,
  onTestRouting,
  onChange,
}: {
  draft: RuntimeSettings
  response: SettingsResponse
  agentModels?: DshModelCatalog
  routingRules?: RoutingRuleRecord[]
  routingRulesError?: string
  onOpenDrawer: (drawer: DrawerView) => void
  onReloadRoutingRules?: () => void
  onToggleRoutingRule?: (rule: RoutingRuleRecord) => Promise<void>
  onTestRouting?: (text: string) => Promise<RoutingPreview>
  onChange: (settings: RuntimeSettings) => void
}) {
  const [manualModel, setManualModel] = useState(false)
  const [togglingRuleId, setTogglingRuleId] = useState('')
  const [rulePage, setRulePage] = useState(0)
  const rulePageCount = Math.max(
    1,
    Math.ceil((routingRules ?? []).length / RULES_PAGE_SIZE),
  )
  const currentRulePage = Math.min(rulePage, rulePageCount - 1)
  const pagedRoutingRules = (routingRules ?? []).slice(
    currentRulePage * RULES_PAGE_SIZE,
    (currentRulePage + 1) * RULES_PAGE_SIZE,
  )
  const [ruleActionError, setRuleActionError] = useState('')
  const [testText, setTestText] = useState('刚才那个方案再加上 Telegram')
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState('')
  const [testResult, setTestResult] = useState<RoutingPreview>()
  async function toggleRule(rule: RoutingRuleRecord) {
    if (!onToggleRoutingRule || togglingRuleId) return
    setTogglingRuleId(rule.id)
    setRuleActionError('')
    try {
      await onToggleRoutingRule(rule)
    } catch (caught) {
      setRuleActionError(
        caught instanceof Error ? caught.message : '更新规则失败，请重试。',
      )
    } finally {
      setTogglingRuleId('')
    }
  }
  async function runTest() {
    if (!onTestRouting || testing || !testText.trim()) return
    setTesting(true)
    setTestError('')
    setTestResult(undefined)
    try {
      setTestResult(await onTestRouting(testText.trim()))
    } catch (caught) {
      setTestError(
        caught instanceof Error ? caught.message : '测试归类失败，请重试。',
      )
    } finally {
      setTesting(false)
    }
  }
  const provider = response.capabilities.providers.find(
    item => item.id === draft.modelProvider,
  )
  const selectableProviders = response.capabilities.providers.filter(
    item => item.available || item.id === draft.modelProvider,
  )
  const providerAliases = new Set(
    [draft.modelProvider, provider?.name]
      .filter((alias): alias is string => Boolean(alias))
      .map(alias => alias.toLocaleLowerCase()),
  )
  const providerModels = (agentModels?.models ?? []).filter(model =>
    providerAliases.has(model.provider.toLocaleLowerCase()),
  )
  const selectedProviderModel = providerModels.find(
    model => model.id === draft.modelName,
  )
  return (
    <div className="settings-pane mx-auto max-w-[900px] px-9 pt-[34px] pb-10 max-[1120px]:px-6 max-[820px]:px-[18px] max-[820px]:pt-6 max-[820px]:pb-[34px] router-settings">
      <SettingsHeading
        title="事情归类"
        description="决定一条新消息是继续已有事情，还是开始一件新事情。"
      />
      <div className="compact-field-row grid min-h-[52px] items-center gap-3.5 border-b border-line py-2 [grid-template-columns:120px_minmax(0,1fr)] max-[820px]:items-start max-[820px]:[grid-template-columns:1fr] max-[820px]:py-3">
        <span className="font-medium">归类方式</span>
        <SegmentedControl
          ariaLabel="归类方式"
          className="bui justify-self-start"
          onChange={routerMode => onChange({ ...draft, routerMode })}
          options={[
            { value: 'model', label: '智能判断' },
            { value: 'rules', label: '确定性规则' },
          ]}
          value={draft.routerMode}
        />
      </div>
      <div className="settings-card my-3.5 rounded-card bg-surface p-[18px] shadow-card">
        <div className="card-title flex items-start gap-3 max-[520px]:grid max-[520px]:[grid-template-columns:20px_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:flex-1 [&>[role=combobox]]:max-[520px]:min-w-0 [&>[role=combobox]]:max-[520px]:max-w-full [&>[role=combobox]]:max-[520px]:justify-self-start [&>[role=combobox]]:max-[520px]:[grid-column:2]">
          <Zap size={20} />
          <div>
            <h3 className="mb-1 text-[13px]">即时应答</h3>
            <p className="text-ink-2">
              日常提问和闲聊直接在对话里回答，不创建正式事情；需要动手做事时仍会走完整接单流程。
            </p>
          </div>
        </div>
        <div className="switch-row bui flex items-center justify-between py-3">
          <span className="text-[13px] text-ink">启用即时应答</span>
          <Switch
            checked={draft.chatLaneEnabled === true}
            label="启用即时应答"
            onChange={checked =>
              onChange({ ...draft, chatLaneEnabled: checked })
            }
          />
        </div>
      </div>
      {draft.routerMode === 'model' && (
        <div className="compact-field-row grid min-h-[52px] items-center gap-3.5 border-b border-line py-2 [grid-template-columns:120px_minmax(0,1fr)] max-[820px]:items-start max-[820px]:[grid-template-columns:1fr] max-[820px]:py-3">
          <span className="font-medium">归类模型</span>
          <div className="router-model-fields grid min-w-0 items-center gap-2.5 [grid-template-columns:168px_minmax(0,1fr)_auto] max-[820px]:[grid-template-columns:1fr]">
            <Select
              value={draft.modelProvider}
              onValueChange={value => {
                const modelProvider = value as RuntimeSettings['modelProvider']
                const nextProvider = response.capabilities.providers.find(
                  item => item.id === modelProvider,
                )
                onChange({
                  ...draft,
                  modelProvider,
                  modelName: nextProvider?.defaultModel ?? '',
                })
              }}
            >
              <SelectTrigger
                aria-label="归类模型服务"
                className="h-10 w-full rounded-control bg-field shadow-inset-field hover:bg-field"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {selectableProviders.map(item => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.available ? item.name : `${item.name}（未配置）`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {manualModel ? (
              <TextInput
                aria-label="归类模型名称"
                className="h-10 w-full"
                onChange={event =>
                  onChange({ ...draft, modelName: event.target.value })
                }
                placeholder="输入模型 ID"
                value={draft.modelName}
              />
            ) : (
              <ModelPicker
                ariaLabel="归类模型名称"
                description={`${provider?.name ?? draft.modelProvider} 的完整模型目录`}
                footer="选择后仍需点击「保存更改」生效"
                models={providerModels}
                onSelect={(_, model) => {
                  if (!model) return
                  onChange({ ...draft, modelName: model.id })
                }}
                placeholder={draft.modelName || '选择模型'}
                placeholderDetail={
                  draft.modelName && !selectedProviderModel
                    ? `${provider?.name ?? draft.modelProvider} · 目录外模型`
                    : undefined
                }
                title="归类模型"
                value={
                  selectedProviderModel
                    ? modelSelectionKey(selectedProviderModel)
                    : ''
                }
              />
            )}
            <Button
              className="router-model-manual-toggle h-7 px-0.5 text-[12px] font-normal whitespace-nowrap text-accent-ink max-[820px]:justify-self-start"
              onClick={() => setManualModel(manual => !manual)}
              size="xs"
              type="button"
              variant="quiet"
            >
              {manualModel ? '从目录选择' : '手动输入模型 ID'}
            </Button>
          </div>
        </div>
      )}
      {draft.routerMode === 'model' && (
        <div className="compact-field-row grid min-h-[52px] items-center gap-3.5 border-b border-line py-2 [grid-template-columns:120px_minmax(0,1fr)] max-[820px]:items-start max-[820px]:[grid-template-columns:1fr] max-[820px]:py-3">
          <span className="font-medium">不确定时</span>
          <RadioGroup
            aria-label="不确定时"
            className="radio-row bui flex flex-wrap gap-x-4 gap-y-2"
            onValueChange={value =>
              onChange({
                ...draft,
                routingUncertainty: value as NonNullable<
                  RuntimeSettings['routingUncertainty']
                >,
              })
            }
            value={draft.routingUncertainty ?? 'new_task'}
          >
            {(
              [
                ['new_task', '开始新事情'],
                ['ask_first', '先问我'],
                ['continue_recent', '优先继续最近的事情'],
              ] as const
            ).map(([value, label]) => (
              <label
                className="flex min-h-8 cursor-pointer items-center gap-1.5 text-[13px] whitespace-nowrap text-ink"
                key={value}
              >
                <RadioItem aria-label={label} value={value} />
                {label}
              </label>
            ))}
          </RadioGroup>
        </div>
      )}
      <h3 className="mt-4 mb-2.5 text-[14px]">归类规则</h3>
      {draft.routerMode === 'rules' && (
        <div className="my-3 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2">
          <CircleHelp size={16} />
          当前为「确定性规则」模式：只认显式事情引用，自定义归类规则仅在「智能判断」模式下生效。
        </div>
      )}
      {routingRulesError ? (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_var(--red)]"
          role="alert"
        >
          {routingRulesError}
          {onReloadRoutingRules && (
            <Button
              className="h-8 px-3.5 text-[13px]"
              onClick={onReloadRoutingRules}
              type="button"

              size="xs"
              variant="secondary"
            >
              <RotateCw size={15} />
              重新读取
            </Button>
          )}
        </div>
      ) : !routingRules ? (
        <p className="my-6 text-[13px] text-ink-2">正在读取归类规则…</p>
      ) : (
        <>
          <div className="rule-list overflow-hidden rounded-card shadow-hairline">
            <Button
              className="h-auto min-h-[42px] w-full justify-start gap-2.5 rounded-none border-b border-line bg-surface px-3 text-left font-normal disabled:opacity-100 disabled:text-ink-2"
              disabled
              size="sm"
              type="button"
              variant="quiet"
            >
              <LockKeyhole size={15} />
              <span className="flex-1 text-ink">目标明显不同则开始新事情</span>
              <small className="text-[12px] text-ink-2">
                默认规则（已锁定）
              </small>
            </Button>
            <Button
              className="h-auto min-h-[42px] w-full justify-start gap-2.5 rounded-none border-b border-line bg-surface px-3 text-left font-normal disabled:opacity-100 disabled:text-ink-2"
              disabled
              size="sm"
              type="button"
              variant="quiet"
            >
              <LockKeyhole size={15} />
              <span className="flex-1 text-ink">已停止的事情不自动恢复</span>
              <small className="text-[12px] text-ink-2">
                系统规则（已锁定）
              </small>
            </Button>
            {pagedRoutingRules.map(rule => (
              <div
                className="rule-row flex items-center border-b border-line bg-surface last:border-b-0"
                key={rule.id}
              >
                <Button
                  className="h-auto min-h-[42px] min-w-0 flex-1 justify-start gap-2.5 rounded-none bg-surface px-3 text-left font-normal hover:bg-inset"
                  onClick={() =>
                    onOpenDrawer({
                      kind: 'routingRule',
                      title: rule.title,
                      rule,
                      ...(onReloadRoutingRules
                        ? { onSaved: onReloadRoutingRules }
                        : {}),
                    })
                  }
                  size="sm"
                  type="button"
                  variant="quiet"
                >
                  <span className="flex-1">{rule.title}</span>
                  <small className="text-[12px] text-ink-2">
                    {rule.enabled ? '归类 · 启用' : '归类 · 停用'}
                  </small>
                  <Pencil size={15} />
                </Button>
                <div className="rule-toggle flex items-center px-3">
                  <Switch
                    checked={rule.enabled}
                    disabled={togglingRuleId === rule.id}
                    label={`${rule.enabled ? '停用' : '启用'}归类规则：${rule.title}`}
                    onChange={() => void toggleRule(rule)}
                  />
                </div>
              </div>
            ))}
          </div>
          <RulePagination
            label="归类规则分页"
            onPageChange={setRulePage}
            page={rulePage}
            total={routingRules.length}
          />
          {routingRules.length === 0 && (
            <p className="text-[12px] leading-[1.6] text-ink-2">
              还没有自定义归类规则；添加后会作为归属偏好参与智能判断。
            </p>
          )}
          <Button
            className="mt-2 h-8 px-3.5 text-[13px] text-accent-ink shadow-[0_0_0_1px_var(--accent)]"
            onClick={() =>
              onOpenDrawer({
                kind: 'routingRule',
                title: '添加归类规则',
                ...(onReloadRoutingRules
                  ? { onSaved: onReloadRoutingRules }
                  : {}),
              })
            }
            size="xs"
            type="button"
            variant="secondary"
          >
            <Plus size={16} />
            添加规则
          </Button>
        </>
      )}
      {ruleActionError && (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_var(--red)]"
          role="alert"
        >
          {ruleActionError}
        </div>
      )}
      <h3 className="mt-4 mb-2.5 text-[14px]">测试归类</h3>
      <div className="test-row grid items-center gap-2.5 [grid-template-columns:minmax(0,1fr)_auto] max-[520px]:[grid-template-columns:1fr]">
        <TextInput
          aria-label="测试归类消息"
          className="h-10 w-full"
          onChange={event => setTestText(event.target.value)}
          value={testText}
        />
        <Button
          className="h-8 min-w-[72px] px-3.5 text-[13px] whitespace-nowrap max-[520px]:justify-self-start"
          disabled={!onTestRouting || testing || !testText.trim()}
          onClick={() => void runTest()}
          type="button"

          size="xs"
          variant="secondary"
        >
          {testing ? '测试中…' : '测试'}
        </Button>
      </div>
      <p className="text-[12px] leading-[1.6] text-ink-2">
        测试按当前已保存的归类方式、模型与规则预演归属，不会创建事情或发送通知；模型调用计入用量。
      </p>
      {testError && (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_var(--red)]"
          role="alert"
        >
          {testError}
        </div>
      )}
      {testResult && (
        <div
          className="settings-card my-3.5 rounded-card bg-surface p-[18px] shadow-card"
          role="status"
        >
          <div className="card-title flex items-start gap-3 max-[520px]:grid max-[520px]:[grid-template-columns:20px_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:flex-1 [&>[role=combobox]]:max-[520px]:min-w-0 [&>[role=combobox]]:max-[520px]:max-w-full [&>[role=combobox]]:max-[520px]:justify-self-start [&>[role=combobox]]:max-[520px]:[grid-column:2]">
            <Zap size={20} />
            <div>
              <h3 className="mb-1 text-[13px]">
                {routingPreviewLabel(testResult)}
              </h3>
              <p className="text-ink-2">{testResult.reason}</p>
            </div>
          </div>
          {testResult.question && <p>{testResult.question}</p>}
          {testResult.matchedRuleId && (
            <p className="text-[12px] leading-[1.6] text-ink-2">
              命中规则：
              {routingRules?.find(rule => rule.id === testResult.matchedRuleId)
                ?.title ?? testResult.matchedRuleId}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function routingPreviewLabel(preview: RoutingPreview): string {
  switch (preview.kind) {
    case 'create_task':
      return `开始新事情${preview.title ? `：${preview.title}` : ''}`
    case 'continue_task':
      return `继续事情${preview.taskTitle ? `：${preview.taskTitle}` : ''}`
    case 'steer_task':
      return `纠正事情${preview.taskTitle ? `：${preview.taskTitle}` : ''}`
    case 'cancel_task':
      return `停止事情${preview.taskTitle ? `：${preview.taskTitle}` : ''}`
    case 'reply':
      return '即时应答（不创建事情）'
    case 'clarify':
      return '先问你归属'
    default:
      return preview.kind
  }
}

function VoiceSettings({
  draft,
  speechDraft,
  rewriteDraft,
  providerDraft,
  onChange,
  onSpeechChange,
  onRewriteChange,
  onTestSpeech,
  onTestRewrite,
}: {
  draft: RuntimeSettings
  speechDraft: SpeechSettingsDraft
  rewriteDraft: RewriteSettingsDraft
  providerDraft: ModelProviderDraft
  onChange: (settings: RuntimeSettings) => void
  onSpeechChange: (draft: SpeechSettingsDraft) => void
  onRewriteChange: (draft: RewriteSettingsDraft) => void
  onTestSpeech: SettingsTestSpeech
  onTestRewrite: SettingsTestRewrite
}) {
  const [speechResult, setSpeechResult] = useState('')
  const [rewriteSample, setRewriteSample] = useState(
    '呃，帮我把明天上午的会议安排一下，然后提醒我带上材料。',
  )
  const [rewriteResult, setRewriteResult] = useState('')
  const [rewriteTesting, setRewriteTesting] = useState(false)
  const [rewriteError, setRewriteError] = useState('')
  const speechRequestRef = useRef(0)
  const rewriteRequestRef = useRef(0)
  useEffect(() => {
    speechRequestRef.current += 1
    setSpeechResult('')
  }, [
    speechDraft.apiKey,
    speechDraft.baseUrl,
    speechDraft.clearApiKey,
    speechDraft.hasApiKey,
    speechDraft.model,
    speechDraft.provider,
  ])
  useEffect(() => {
    rewriteRequestRef.current += 1
    setRewriteTesting(false)
    setRewriteResult('')
    setRewriteError('')
  }, [
    draft.modelName,
    draft.modelProvider,
    draft.rewriteMode,
    providerDraft.apiKey,
    providerDraft.baseUrl,
    providerDraft.clearApiKey,
    providerDraft.name,
    providerDraft.protocol,
    rewriteDraft.apiKey,
    rewriteDraft.baseUrl,
    rewriteDraft.clearApiKey,
    rewriteDraft.mode,
    rewriteDraft.model,
    rewriteDraft.protocol,
    rewriteSample,
  ])
  const dictation = useVoiceDictation({
    maximumSeconds: 20,
    transcribe: async audio => {
      const requestId = speechRequestRef.current + 1
      speechRequestRef.current = requestId
      const result = await onTestSpeech(audio, speechDraft)
      if (requestId === speechRequestRef.current)
        setSpeechResult(
          `${result.transcript.text} · ${String(result.latencyMs)} ms`,
        )
      return result.transcript
    },
  })
  async function testRewrite() {
    const requestId = rewriteRequestRef.current + 1
    rewriteRequestRef.current = requestId
    setRewriteTesting(true)
    setRewriteError('')
    setRewriteResult('')
    try {
      const result = await onTestRewrite(
        rewriteSample,
        rewriteDraft,
        draft,
        providerDraft,
      )
      if (requestId !== rewriteRequestRef.current) return
      setRewriteResult(`${result.rewritten} · ${String(result.latencyMs)} ms`)
    } catch (caught) {
      if (requestId !== rewriteRequestRef.current) return
      setRewriteError(caught instanceof Error ? caught.message : '改写测试失败')
    } finally {
      if (requestId === rewriteRequestRef.current) setRewriteTesting(false)
    }
  }
  return (
    <div className="settings-pane mx-auto max-w-[900px] px-9 pt-[34px] pb-10 max-[1120px]:px-6 max-[820px]:px-[18px] max-[820px]:pt-6 max-[820px]:pb-[34px]">
      <SettingsHeading
        title="语音与输入"
        description="配置听写、输入改写和发送前校对。"
      />
      <div className="settings-card my-3.5 rounded-card bg-surface p-[18px] shadow-card">
        <div className="card-title flex items-start gap-3 max-[520px]:grid max-[520px]:[grid-template-columns:20px_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:flex-1 [&>[role=combobox]]:max-[520px]:min-w-0 [&>[role=combobox]]:max-[520px]:max-w-full [&>[role=combobox]]:max-[520px]:justify-self-start [&>[role=combobox]]:max-[520px]:[grid-column:2]">
          <Mic size={20} />
          <div>
            <h3 className="mb-1 text-[13px]">语音听写</h3>
            <p className="text-ink-2">录音仅用于本次转写，默认不持久化。</p>
          </div>
          <Select
            onValueChange={value =>
              onSpeechChange({
                ...speechDraft,
                provider: value as SpeechSettingsDraft['provider'],
              })
            }
            value={speechDraft.provider}
          >
            <SelectTrigger
              aria-label="语音服务"
              className="h-9 max-w-full min-w-0 rounded-control bg-field shadow-inset-field hover:bg-field"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="disabled">关闭</SelectItem>
              <SelectItem value="openai-compatible">OpenAI 兼容</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {speechDraft.provider === 'openai-compatible' && (
          <>
            <FormField className="my-3.5" label="服务地址">
              <TextInput
                className="h-10 w-full"
                onChange={event =>
                  onSpeechChange({
                    ...speechDraft,
                    baseUrl: event.target.value,
                  })
                }
                value={speechDraft.baseUrl}
              />
            </FormField>
            <FormField className="my-3.5" label="模型">
              <TextInput
                className="h-10 w-full"
                onChange={event =>
                  onSpeechChange({ ...speechDraft, model: event.target.value })
                }
                value={speechDraft.model}
              />
            </FormField>
            <FormField className="my-3.5" label="API Key">
              <TextInput
                autoComplete="off"
                className="h-10 w-full"
                onChange={event =>
                  onSpeechChange({
                    ...speechDraft,
                    apiKey: event.target.value,
                    clearApiKey: false,
                  })
                }
                placeholder={
                  speechDraft.hasApiKey ? '已保存；填写新值可替换' : '可选'
                }
                type="password"
                value={speechDraft.apiKey}
              />
            </FormField>
            {speechDraft.hasApiKey && (
              <div className="switch-row bui flex items-center justify-between py-3">
                <span className="text-[13px] text-ink">
                  清除已保存的 API Key
                </span>
                <Switch
                  checked={speechDraft.clearApiKey}
                  label="清除已保存的 API Key"
                  onChange={checked =>
                    onSpeechChange({
                      ...speechDraft,
                      clearApiKey: checked,
                      apiKey: '',
                    })
                  }
                />
              </div>
            )}
            <Button
              className="h-8 px-3.5 text-[13px]"
              disabled={
                !speechDraft.baseUrl.trim() ||
                !speechDraft.model.trim() ||
                ['requesting', 'transcribing'].includes(dictation.state)
              }
              onClick={() => {
                if (dictation.state === 'idle') setSpeechResult('')
                dictation.toggle()
              }}
              type="button"

              size="xs"
              variant="secondary"
            >
              <Mic size={16} />
              {dictation.state === 'recording'
                ? '结束并识别'
                : dictation.state === 'transcribing'
                  ? '正在识别…'
                  : '录一段测试'}
            </Button>
            {speechResult && (
              <p
                className="mt-2 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2 text-[12px] text-accent-ink"
                role="status"
              >
                {speechResult}
              </p>
            )}
            {dictation.error && (
              <p
                className="mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
                role="alert"
              >
                {dictation.error}
              </p>
            )}
          </>
        )}
      </div>
      <div className="settings-card my-3.5 rounded-card bg-surface p-[18px] shadow-card">
        <div className="card-title flex items-start gap-3 max-[520px]:grid max-[520px]:[grid-template-columns:20px_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:flex-1 [&>[role=combobox]]:max-[520px]:min-w-0 [&>[role=combobox]]:max-[520px]:max-w-full [&>[role=combobox]]:max-[520px]:justify-self-start [&>[role=combobox]]:max-[520px]:[grid-column:2]">
          <Sparkles size={20} />
          <div>
            <h3 className="mb-1 text-[13px]">输入改写</h3>
            <p className="text-ink-2">发送前清理口头语，不改变原意。</p>
          </div>
        </div>
        <div className="switch-row bui flex items-center justify-between py-3">
          <span className="text-[13px] text-ink">启用轻量改写</span>
          <Switch
            checked={draft.rewriteMode === 'light'}
            label="启用轻量改写"
            onChange={checked =>
              onChange({
                ...draft,
                rewriteMode: checked ? 'light' : 'disabled',
              })
            }
          />
        </div>
        {draft.rewriteMode === 'light' && (
          <>
            <SegmentedControl
              ariaLabel="改写模式"
              className="bui"
              onChange={mode => onRewriteChange({ ...rewriteDraft, mode })}
              options={[
                { value: 'router', label: '跟随事情归类' },
                { value: 'custom', label: '独立服务' },
              ]}
              value={rewriteDraft.mode}
            />
            {rewriteDraft.mode === 'custom' && (
              <div className="provider-edit-fields">
                <FormField
                  className="my-3.5"
                  htmlFor="rewrite-protocol"
                  label="改写接口协议"
                >
                  <Select
                    onValueChange={value =>
                      onRewriteChange({
                        ...rewriteDraft,
                        protocol: value as RewriteSettingsDraft['protocol'],
                      })
                    }
                    value={rewriteDraft.protocol}
                  >
                    <SelectTrigger
                      className="h-10 w-full rounded-control bg-field shadow-inset-field hover:bg-field"
                      id="rewrite-protocol"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai-chat">
                        OpenAI Chat Completions
                      </SelectItem>
                      <SelectItem value="anthropic-messages">
                        Anthropic Messages
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField className="my-3.5" label="服务地址">
                  <TextInput
                    className="h-10 w-full"
                    onChange={event =>
                      onRewriteChange({
                        ...rewriteDraft,
                        baseUrl: event.target.value,
                      })
                    }
                    value={rewriteDraft.baseUrl}
                  />
                </FormField>
                <FormField className="my-3.5" label="模型">
                  <TextInput
                    className="h-10 w-full"
                    onChange={event =>
                      onRewriteChange({
                        ...rewriteDraft,
                        model: event.target.value,
                      })
                    }
                    value={rewriteDraft.model}
                  />
                </FormField>
                <FormField className="my-3.5" label="API Key">
                  <TextInput
                    autoComplete="off"
                    className="h-10 w-full"
                    onChange={event =>
                      onRewriteChange({
                        ...rewriteDraft,
                        apiKey: event.target.value,
                        clearApiKey: false,
                      })
                    }
                    placeholder={
                      rewriteDraft.hasApiKey ? '已保存；填写新值可替换' : '可选'
                    }
                    type="password"
                    value={rewriteDraft.apiKey}
                  />
                </FormField>
                {rewriteDraft.hasApiKey && (
                  <div className="switch-row bui flex items-center justify-between py-3">
                    <span className="text-[13px] text-ink">
                      清除改写服务 API Key
                    </span>
                    <Switch
                      checked={rewriteDraft.clearApiKey}
                      label="清除改写服务 API Key"
                      onChange={checked =>
                        onRewriteChange({
                          ...rewriteDraft,
                          clearApiKey: checked,
                          apiKey: '',
                        })
                      }
                    />
                  </div>
                )}
              </div>
            )}
            <FormField className="my-3.5" label="测试文本">
              <TextArea
                className="w-full resize-y"
                maxLength={4000}
                onChange={event => setRewriteSample(event.target.value)}
                rows={3}
                value={rewriteSample}
              />
            </FormField>
            <Button
              className="h-8 px-3.5 text-[13px]"
              disabled={rewriteTesting || !rewriteSample.trim()}
              onClick={() => void testRewrite()}
              type="button"

              size="xs"
              variant="secondary"
            >
              {rewriteTesting ? '测试中…' : '测试改写'}
            </Button>
            {rewriteResult && (
              <p
                className="mt-2 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2 text-[12px] text-accent-ink"
                role="status"
              >
                {rewriteResult}
              </p>
            )}
            {rewriteError && (
              <p
                className="mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
                role="alert"
              >
                {rewriteError}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ConnectionsSettings({
  error,
  nodes,
  onReload,
}: {
  error?: string
  nodes?: ExecutionNode[]
  onReload?: () => void
}) {
  return (
    <div className="settings-pane mx-auto max-w-[900px] px-9 pt-[34px] pb-10 max-[1120px]:px-6 max-[820px]:px-[18px] max-[820px]:pt-6 max-[820px]:pb-[34px]">
      <SettingsHeading
        title="能力与连接"
        description="查看已注册的执行节点与它们声明的能力。"
      />
      {error ? (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_var(--red)]"
          role="alert"
        >
          {error}
          {onReload && (
            <Button
              className="h-8 px-3.5 text-[13px]"
              onClick={onReload}
              type="button"

              size="xs"
              variant="secondary"
            >
              <RotateCw size={15} />
              重新读取
            </Button>
          )}
        </div>
      ) : !nodes ? (
        <p className="my-6 text-[13px] text-ink-2">正在读取执行节点…</p>
      ) : nodes.length ? (
        <div className="connection-grid grid grid-cols-2 gap-2.5 max-[520px]:grid-cols-1">
          {nodes.map(node => (
            <article
              className="grid items-center gap-2.5 rounded-card bg-surface p-3.5 shadow-card [grid-template-columns:38px_1fr_auto]"
              key={node.id}
            >
              <span className="flex size-9 items-center justify-center rounded-control bg-inset">
                <Network size={19} />
              </span>
              <div>
                <h3 className="text-[13px]">{node.label}</h3>
                <p className="mt-1 text-[11px] text-ink-2">
                  {node.capabilities.length
                    ? node.capabilities.join(' · ')
                    : '未声明能力'}
                </p>
                <p className="mt-1 text-[11px] text-ink-2">
                  最近心跳：{formatRelativeTime(node.lastHeartbeatAt)}
                </p>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="text-[12px] leading-[1.6] text-ink-2">
          还没有 Worker 注册为执行节点；控制面自身仍可执行事情。
        </p>
      )}
      <div className="my-3 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2">
        <LockKeyhole size={16} />
        这里只列出服务端已注册的执行节点；工具授权清单 API
        尚未提供，不代表当前已授权。
      </div>
    </div>
  )
}
function MemorySettings({
  error,
  memories,
  onOpenMemory,
}: {
  error?: string
  memories?: MemoryRecord[]
  onOpenMemory?: () => void
}) {
  const globalCount =
    memories?.filter(memory => memory.scope === 'global').length ?? 0
  const scopedCount = (memories?.length ?? 0) - globalCount
  return (
    <div className="settings-pane mx-auto max-w-[900px] px-9 pt-[34px] pb-10 max-[1120px]:px-6 max-[820px]:px-[18px] max-[820px]:pt-6 max-[820px]:pb-[34px]">
      <SettingsHeading
        title="记忆"
        description="管理 Pegas 可以长期记住的内容和作用范围。"
      />
      {error ? (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_var(--red)]"
          role="alert"
        >
          {error}
        </div>
      ) : !memories ? (
        <p className="my-6 text-[13px] text-ink-2">正在读取记忆…</p>
      ) : (
        <div className="settings-card my-3.5 rounded-card bg-surface p-[18px] shadow-card">
          <div className="card-title flex items-start gap-3 max-[520px]:grid max-[520px]:[grid-template-columns:20px_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:flex-1 [&>[role=combobox]]:max-[520px]:min-w-0 [&>[role=combobox]]:max-[520px]:max-w-full [&>[role=combobox]]:max-[520px]:justify-self-start [&>[role=combobox]]:max-[520px]:[grid-column:2]">
            <Database size={20} />
            <div>
              <h3 className="mb-1 text-[13px]">服务端记忆</h3>
              <p className="text-ink-2">
                全局 {globalCount} 条 · Worker/事情 {scopedCount} 条
              </p>
            </div>
          </div>
          <Button
            className="h-8 px-3.5 text-[13px]"
            onClick={onOpenMemory}
            type="button"

            size="xs"
            variant="secondary"
          >
            管理记忆
          </Button>
        </div>
      )}
      <div className="my-3 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2">
        <LockKeyhole size={16} />
        记忆的添加、修改与删除在“记忆”页完成；执行时只装载适用范围。
      </div>
    </div>
  )
}
function PrivacySettings({
  available,
  draft,
  onChange,
}: {
  available: boolean
  draft: RuntimeSettings
  onChange: (settings: RuntimeSettings) => void
}) {
  return (
    <div className="settings-pane mx-auto max-w-[900px] px-9 pt-[34px] pb-10 max-[1120px]:px-6 max-[820px]:px-[18px] max-[820px]:pt-6 max-[820px]:pb-[34px]">
      <SettingsHeading
        title="隐私"
        description="控制内容发往外部模型前的保护方式，以及 Pegas 执行动作的默认权限。"
      />
      <div className="settings-card my-3.5 rounded-card bg-surface p-[18px] shadow-card">
        <div className="card-title flex items-start gap-3 max-[520px]:grid max-[520px]:[grid-template-columns:20px_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:flex-1 [&>[role=combobox]]:max-[520px]:min-w-0 [&>[role=combobox]]:max-[520px]:max-w-full [&>[role=combobox]]:max-[520px]:justify-self-start [&>[role=combobox]]:max-[520px]:[grid-column:2]">
          <LockKeyhole size={20} />
          <div>
            <h3 className="mb-1 text-[13px]">默认权限档位</h3>
            <p className="text-ink-2">
              决定 Pegas 执行工具时哪些动作放行、哪些需要你的审批。
            </p>
          </div>
        </div>
        <FormField
          className="my-3.5"
          htmlFor="global-permission-tier"
          label="全局权限档位"
        >
          <Select
            onValueChange={value =>
              onChange({
                ...draft,
                permissionTier:
                  value === 'strict' || value === 'full' ? value : 'standard',
              })
            }
            value={draft.permissionTier ?? 'standard'}
          >
            <SelectTrigger
              aria-label="全局权限档位"
              className="h-10 w-full rounded-control bg-field shadow-inset-field hover:bg-field"
              id="global-permission-tier"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">
                标准 · 区内放行，越界审批
              </SelectItem>
              <SelectItem value="strict">
                严格 · 只读，写与网络都审批
              </SelectItem>
              <SelectItem value="full">完全访问 · 显式风险披露</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        <p className="text-[12px] leading-[1.6] text-ink-2">
          收紧对下一次工具调用立即生效；放宽只影响后续运行。单个事情可以在执行设置里覆盖此默认值。
        </p>
      </div>
      <div className="settings-card my-3.5 rounded-card bg-surface p-[18px] shadow-card">
        <div className="card-title flex items-start gap-3 max-[520px]:grid max-[520px]:[grid-template-columns:20px_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:flex-1 [&>[role=combobox]]:max-[520px]:min-w-0 [&>[role=combobox]]:max-[520px]:max-w-full [&>[role=combobox]]:max-[520px]:justify-self-start [&>[role=combobox]]:max-[520px]:[grid-column:2]">
          <ShieldCheck size={20} />
          <div>
            <h3 className="mb-1 text-[13px]">自动审阅</h3>
            <p className="text-ink-2">
              待审批操作先交给模型按你的原话初审：明确授权的放行，其余仍由你决定。
            </p>
          </div>
        </div>
        <div className="switch-row bui flex items-center justify-between py-3">
          <span className="text-[13px] text-ink">启用自动审阅</span>
          <Switch
            checked={draft.autoReviewEnabled === true}
            label="启用自动审阅"
            onChange={checked =>
              onChange({
                ...draft,
                autoReviewEnabled: checked,
              })
            }
          />
        </div>
        <p className="text-[12px] leading-[1.6] text-ink-2">
          只认你认证输入的原话；定时跟进等机器输入不构成新授权。审阅超时或失败一律回到人工审批，不可逆命令与控制面修改始终需要你确认。
        </p>
      </div>
      <div className="settings-card my-3.5 rounded-card bg-surface p-[18px] shadow-card">
        <div className="card-title flex items-start gap-3 max-[520px]:grid max-[520px]:[grid-template-columns:20px_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:flex-1 [&>[role=combobox]]:max-[520px]:min-w-0 [&>[role=combobox]]:max-[520px]:max-w-full [&>[role=combobox]]:max-[520px]:justify-self-start [&>[role=combobox]]:max-[520px]:[grid-column:2]">
          <Shield size={20} />
          <div>
            <h3 className="mb-1 text-[13px]">敏感信息遮罩</h3>
            <p className="text-ink-2">
              在可信边界外发送内容前识别并替换常见敏感字段。
            </p>
          </div>
        </div>
        <div className="switch-row bui flex items-center justify-between py-3">
          <span className="text-[13px] text-ink">启用遮罩</span>
          <Switch
            checked={draft.privacyMode === 'mask'}
            disabled={!available}
            label="启用遮罩"
            onChange={checked =>
              onChange({
                ...draft,
                privacyMode: checked ? 'mask' : 'disabled',
              })
            }
          />
        </div>
        {!available && (
          <p className="text-[12px] leading-[1.6] text-ink-2">
            服务端尚未配置隐私 HMAC key，暂时无法启用遮罩。
          </p>
        )}
      </div>
      <div className="my-3 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2">
        <LockKeyhole size={16} />
        模型服务密钥只写入服务端，读取设置时不会回显明文。
      </div>
    </div>
  )
}
function NotificationSettings({
  error,
  onReload,
  onSave,
  preferences,
}: {
  error?: string
  onReload?: () => void
  onSave?: (update: NotificationPreferencesUpdate) => Promise<void>
  preferences?: NotificationPreferences
}) {
  const [enabled, setEnabled] = useState(false)
  const [quietStart, setQuietStart] = useState('23:00')
  const [quietEnd, setQuietEnd] = useState('08:00')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{
    kind: 'success' | 'error'
    message: string
  }>()
  useEffect(() => {
    if (!preferences) return
    setEnabled(Boolean(preferences.quietStart && preferences.quietEnd))
    if (preferences.quietStart) setQuietStart(preferences.quietStart)
    if (preferences.quietEnd) setQuietEnd(preferences.quietEnd)
  }, [preferences])
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/
  const validTimes = timePattern.test(quietStart) && timePattern.test(quietEnd)
  async function save() {
    if (!preferences || !onSave || saving || (enabled && !validTimes)) return
    setSaving(true)
    setNotice(undefined)
    try {
      await onSave({
        expectedRevision: preferences.revision,
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
        ...(enabled ? { quietStart, quietEnd } : {}),
      })
      setNotice({ kind: 'success', message: '通知静默时段已保存' })
    } catch (caught) {
      setNotice({
        kind: 'error',
        message:
          caught instanceof Error ? caught.message : '保存失败，请重试。',
      })
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="settings-pane mx-auto max-w-[900px] px-9 pt-[34px] pb-10 max-[1120px]:px-6 max-[820px]:px-[18px] max-[820px]:pt-6 max-[820px]:pb-[34px]">
      <SettingsHeading
        title="通知"
        description="设置免打扰时段，让 Pegas 的通知避开你的休息时间。"
      />
      {error ? (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_var(--red)]"
          role="alert"
        >
          {error}
          {onReload && (
            <Button
              className="h-8 px-3.5 text-[13px]"
              onClick={onReload}
              type="button"

              size="xs"
              variant="secondary"
            >
              <RotateCw size={15} />
              重新读取
            </Button>
          )}
        </div>
      ) : !preferences ? (
        <p className="my-6 text-[13px] text-ink-2">正在读取通知偏好…</p>
      ) : (
        <>
          <div className="settings-card my-3.5 rounded-card bg-surface p-[18px] shadow-card">
            <div className="card-title flex items-start gap-3 max-[520px]:grid max-[520px]:[grid-template-columns:20px_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:flex-1 [&>[role=combobox]]:max-[520px]:min-w-0 [&>[role=combobox]]:max-[520px]:max-w-full [&>[role=combobox]]:max-[520px]:justify-self-start [&>[role=combobox]]:max-[520px]:[grid-column:2]">
              <Bell size={20} />
              <div>
                <h3 className="mb-1 text-[13px]">免打扰时段</h3>
                <p className="text-ink-2">
                  时段内产生的通知会保留在服务端，等时段结束后再投递，不会丢失。
                </p>
              </div>
            </div>
            <div className="switch-row bui flex items-center justify-between py-3">
              <span className="text-[13px] text-ink">启用免打扰</span>
              <Switch
                checked={enabled}
                disabled={saving}
                label="启用免打扰"
                onChange={next => {
                  setNotice(undefined)
                  setEnabled(next)
                }}
              />
            </div>
            {enabled && (
              <div className="quiet-hours-row grid grid-cols-2 gap-3">
                <FormField className="mt-2 mb-1" label="开始时间">
                  <TextInput
                    className="h-10 w-full"
                    disabled={saving}
                    onChange={event => {
                      setNotice(undefined)
                      setQuietStart(event.target.value)
                    }}
                    type="time"
                    value={quietStart}
                  />
                </FormField>
                <FormField className="mt-2 mb-1" label="结束时间">
                  <TextInput
                    className="h-10 w-full"
                    disabled={saving}
                    onChange={event => {
                      setNotice(undefined)
                      setQuietEnd(event.target.value)
                    }}
                    type="time"
                    value={quietEnd}
                  />
                </FormField>
              </div>
            )}
            {enabled && !validTimes && (
              <p className="text-[12px] leading-[1.6] text-ink-2">
                请填写完整的开始与结束时间（24 小时制）。
              </p>
            )}
            <p className="text-[12px] leading-[1.6] text-ink-2">
              时区按当前设备（UTC
              {formatUtcOffset(-new Date().getTimezoneOffset())}
              ）计算；保存时生效。
            </p>
          </div>
          <div className="settings-inline-actions mt-3.5 flex items-center justify-end gap-3">
            <span
              className={`flex-1 text-[12px] ${notice?.kind === 'error' ? 'text-red-text' : 'text-green-text'}`}
              role={notice?.kind === 'error' ? 'alert' : 'status'}
            >
              {notice?.message}
            </span>
            <Button
              className="h-9 px-4 text-[13px]"
              disabled={saving || (enabled && !validTimes)}
              onClick={() => void save()}
              type="button"

              size="sm"
              variant="primary"
            >
              {saving ? '保存中…' : '保存通知偏好'}
            </Button>
          </div>
          <div className="my-3 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2">
            <LockKeyhole size={16} />
            按通知类型分别开关的偏好 API 尚未提供；当前服务端只支持免打扰时段。
          </div>
        </>
      )}
    </div>
  )
}

function formatUtcOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-'
  const absolute = Math.abs(minutes)
  const hours = Math.floor(absolute / 60)
  const remainder = absolute % 60
  return `${sign}${String(hours)}${remainder ? `:${String(remainder).padStart(2, '0')}` : ''}`
}

interface ModelUsageRow {
  model: string
  runs: number
  tasks: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  durationMs?: number
}

function aggregateUsageByModel(
  records: readonly ModelUsageRecord[],
): ModelUsageRow[] {
  const byModel = new Map<
    string,
    { row: ModelUsageRow; taskIds: Set<string> }
  >()
  for (const record of records) {
    const model = record.modelRef ?? record.executor
    const entry = byModel.get(model) ?? {
      row: { model, runs: 0, tasks: 0 },
      taskIds: new Set<string>(),
    }
    entry.row.runs += 1
    entry.taskIds.add(record.taskId)
    entry.row.tasks = entry.taskIds.size
    entry.row.inputTokens = addOptional(
      entry.row.inputTokens,
      record.inputTokens,
    )
    entry.row.outputTokens = addOptional(
      entry.row.outputTokens,
      record.outputTokens,
    )
    entry.row.cacheReadTokens = addOptional(
      entry.row.cacheReadTokens,
      record.cacheReadTokens,
    )
    entry.row.durationMs = addOptional(entry.row.durationMs, record.durationMs)
    byModel.set(model, entry)
  }
  return [...byModel.values()]
    .map(entry => entry.row)
    .toSorted(
      (left, right) =>
        (right.inputTokens ?? 0) +
        (right.outputTokens ?? 0) -
        ((left.inputTokens ?? 0) + (left.outputTokens ?? 0)),
    )
}

function addOptional(
  current: number | undefined,
  value: number | undefined,
): number | undefined {
  if (value === undefined) return current
  return (current ?? 0) + value
}

function UsageSettings({
  usage,
  error,
  onRetry,
}: {
  usage?: ModelUsageReport
  error?: string
  onRetry: () => void
}) {
  const [dimension, setDimension] = useState<'run' | 'model'>('run')
  const summary = usage?.summary
  const hasTokenUsage = usage?.records.some(
    record =>
      record.inputTokens !== undefined || record.outputTokens !== undefined,
  )
  const hasCacheUsage = usage?.records.some(
    record => record.cacheReadTokens !== undefined,
  )
  const hasDuration = usage?.records.some(
    record => record.durationMs !== undefined,
  )
  const total = hasTokenUsage
    ? (summary?.inputTokens ?? 0) + (summary?.outputTokens ?? 0)
    : undefined
  const modelRows = aggregateUsageByModel(usage?.records ?? [])
  return (
    <div className="settings-pane mx-auto max-w-[900px] px-9 pt-[34px] pb-10 max-[1120px]:px-6 max-[820px]:px-[18px] max-[820px]:pt-6 max-[820px]:pb-[34px]">
      <SettingsHeading
        title="模型用量"
        description="按模型、事情和 Run 查看供应商真实上报的消耗。"
      />
      {error && (
        <div
          className="my-3 flex items-center justify-between gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2"
          role="alert"
        >
          <span>
            <CircleAlert size={16} />
            {error}
            {usage ? '；以下为上次成功读取的数据。' : ''}
          </span>
          <Button
            className="h-8 px-3.5 text-[13px]"
            onClick={onRetry}
            type="button"
            size="xs"
            variant="secondary"
          >
            重新读取
          </Button>
        </div>
      )}
      {!usage ? (
        <div className="my-6 text-[13px] text-ink-2">尚未取得用量数据。</div>
      ) : (
        <>
          <div className="usage-metrics grid grid-cols-4 gap-2.5 max-[820px]:grid-cols-2 max-[520px]:grid-cols-1">
            <article className="grid gap-[7px] rounded-card bg-surface p-[15px] shadow-card [&_small]:text-[11px] [&_small]:text-ink-2 [&_span]:text-[11px] [&_span]:text-ink-2 [&_strong]:text-[20px] [&_strong]:leading-[1.25] [&_strong]:tracking-[-0.02em]">
              <small>总 Token</small>
              <strong>{total?.toLocaleString('zh-CN') ?? '—'}</strong>
              <span>{hasTokenUsage ? '输入 + 输出' : '执行器未回报'}</span>
            </article>
            <article className="grid gap-[7px] rounded-card bg-surface p-[15px] shadow-card [&_small]:text-[11px] [&_small]:text-ink-2 [&_span]:text-[11px] [&_span]:text-ink-2 [&_strong]:text-[20px] [&_strong]:leading-[1.25] [&_strong]:tracking-[-0.02em]">
              <small>缓存读取</small>
              <strong>
                {hasCacheUsage
                  ? (summary?.cacheReadTokens ?? 0).toLocaleString('zh-CN')
                  : '—'}
              </strong>
              <span>{hasCacheUsage ? '供应商上报' : '执行器未回报'}</span>
            </article>
            <article className="grid gap-[7px] rounded-card bg-surface p-[15px] shadow-card [&_small]:text-[11px] [&_small]:text-ink-2 [&_span]:text-[11px] [&_span]:text-ink-2 [&_strong]:text-[20px] [&_strong]:leading-[1.25] [&_strong]:tracking-[-0.02em]">
              <small>运行时长</small>
              <strong>
                {hasDuration
                  ? `${String(Math.round((summary?.durationMs ?? 0) / 1000))}s`
                  : '—'}
              </strong>
              <span>{hasDuration ? 'Pegas 观测' : '执行器未回报'}</span>
            </article>
            <article className="grid gap-[7px] rounded-card bg-surface p-[15px] shadow-card [&_small]:text-[11px] [&_small]:text-ink-2 [&_span]:text-[11px] [&_span]:text-ink-2 [&_strong]:text-[20px] [&_strong]:leading-[1.25] [&_strong]:tracking-[-0.02em]">
              <small>费用</small>
              <strong>
                {summary?.costUsd === undefined
                  ? '—'
                  : `$${summary.costUsd.toFixed(3)}`}
              </strong>
              <span>
                {summary?.costUsd === undefined ? '未提供价格' : '供应商上报'}
              </span>
            </article>
          </div>
          <div
            className="mt-[18px] flex gap-1.5"
            role="group"
            aria-label="统计维度"
          >
            <Button
              aria-pressed={dimension === 'run'}
              className="h-8 rounded-control px-3 text-[12px] aria-pressed:bg-ink aria-pressed:text-canvas aria-pressed:shadow-none"
              onClick={() => setDimension('run')}
              size="xs"
              type="button"
              variant="secondary"
            >
              按 Run
            </Button>
            <Button
              aria-pressed={dimension === 'model'}
              className="h-8 rounded-control px-3 text-[12px] aria-pressed:bg-ink aria-pressed:text-canvas aria-pressed:shadow-none"
              onClick={() => setDimension('model')}
              size="xs"
              type="button"
              variant="secondary"
            >
              按模型
            </Button>
          </div>
          {dimension === 'run' ? (
            <div className="usage-table mt-[22px] text-[12px] max-[820px]:overflow-x-auto [&>div]:grid [&>div]:min-h-12 [&>div]:[grid-template-columns:2fr_repeat(4,1fr)] [&>div]:gap-2.5 [&>div]:border-b [&>div]:border-line [&>div]:p-2.5 max-[820px]:[&>div]:min-w-[620px] [&>div>span:first-child]:grid [&>div>span:first-child]:gap-[3px] [&_small]:text-ink-2">
              <div>
                <b>模型 / Run</b>
                <b>输入</b>
                <b>输出</b>
                <b>缓存</b>
                <b>时长</b>
              </div>
              {usage.records.map(record => (
                <div key={record.runId}>
                  <span>
                    {record.modelRef ?? record.executor}
                    <small>{`事情 ${record.taskId} · Run ${record.runId}`}</small>
                  </span>
                  <span>
                    {record.inputTokens?.toLocaleString('zh-CN') ?? '—'}
                  </span>
                  <span>
                    {record.outputTokens?.toLocaleString('zh-CN') ?? '—'}
                  </span>
                  <span>
                    {record.cacheReadTokens?.toLocaleString('zh-CN') ?? '—'}
                  </span>
                  <span>
                    {record.durationMs
                      ? `${String(Math.round(record.durationMs / 1000))}s`
                      : '—'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="usage-table mt-[22px] text-[12px] max-[820px]:overflow-x-auto [&>div]:grid [&>div]:min-h-12 [&>div]:[grid-template-columns:2fr_repeat(4,1fr)] [&>div]:gap-2.5 [&>div]:border-b [&>div]:border-line [&>div]:p-2.5 max-[820px]:[&>div]:min-w-[620px] [&>div>span:first-child]:grid [&>div>span:first-child]:gap-[3px] [&_small]:text-ink-2">
              <div>
                <b>模型</b>
                <b>输入</b>
                <b>输出</b>
                <b>缓存</b>
                <b>时长</b>
              </div>
              {modelRows.map(row => (
                <div key={row.model}>
                  <span>
                    {row.model}
                    <small>
                      {row.runs} 个 Run · {row.tasks} 个事情
                    </small>
                  </span>
                  <span>{row.inputTokens?.toLocaleString('zh-CN') ?? '—'}</span>
                  <span>
                    {row.outputTokens?.toLocaleString('zh-CN') ?? '—'}
                  </span>
                  <span>
                    {row.cacheReadTokens?.toLocaleString('zh-CN') ?? '—'}
                  </span>
                  <span>
                    {row.durationMs !== undefined
                      ? `${String(Math.round(row.durationMs / 1000))}s`
                      : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
          {usage.router && usage.router.summary.calls > 0 && (
            <>
              <SettingsHeading
                title="路由与改写用量"
                description="Router 与输入改写的模型调用消耗；token 仅在供应商上报时显示。"
              />
              <div className="usage-metrics grid grid-cols-4 gap-2.5 max-[820px]:grid-cols-2 max-[520px]:grid-cols-1">
                <article className="grid gap-[7px] rounded-card bg-surface p-[15px] shadow-card [&_small]:text-[11px] [&_small]:text-ink-2 [&_span]:text-[11px] [&_span]:text-ink-2 [&_strong]:text-[20px] [&_strong]:leading-[1.25] [&_strong]:tracking-[-0.02em]">
                  <small>调用次数</small>
                  <strong>
                    {usage.router.summary.calls.toLocaleString('zh-CN')}
                  </strong>
                  <span>
                    {`成功 ${String(usage.router.summary.okCalls)} · 失败 ${String(usage.router.summary.errorCalls)}`}
                  </span>
                </article>
                <article className="grid gap-[7px] rounded-card bg-surface p-[15px] shadow-card [&_small]:text-[11px] [&_small]:text-ink-2 [&_span]:text-[11px] [&_span]:text-ink-2 [&_strong]:text-[20px] [&_strong]:leading-[1.25] [&_strong]:tracking-[-0.02em]">
                  <small>上报 Token</small>
                  <strong>
                    {usage.router.summary.reportedCalls > 0
                      ? (
                          usage.router.summary.inputTokens +
                          usage.router.summary.outputTokens
                        ).toLocaleString('zh-CN')
                      : '—'}
                  </strong>
                  <span>
                    {usage.router.summary.reportedCalls > 0
                      ? '供应商上报'
                      : '供应商未回报'}
                  </span>
                </article>
                <article className="grid gap-[7px] rounded-card bg-surface p-[15px] shadow-card [&_small]:text-[11px] [&_small]:text-ink-2 [&_span]:text-[11px] [&_span]:text-ink-2 [&_strong]:text-[20px] [&_strong]:leading-[1.25] [&_strong]:tracking-[-0.02em]">
                  <small>调用时长</small>
                  <strong>
                    {`${String(Math.round(usage.router.summary.durationMs / 1000))}s`}
                  </strong>
                  <span>Pegas 观测</span>
                </article>
              </div>
              <div className="usage-table mt-[22px] text-[12px] max-[820px]:overflow-x-auto [&>div]:grid [&>div]:min-h-12 [&>div]:[grid-template-columns:2fr_repeat(4,1fr)] [&>div]:gap-2.5 [&>div]:border-b [&>div]:border-line [&>div]:p-2.5 max-[820px]:[&>div]:min-w-[620px] [&>div>span:first-child]:grid [&>div>span:first-child]:gap-[3px] [&_small]:text-ink-2">
                <div>
                  <b>模型 / 调用</b>
                  <b>输入</b>
                  <b>输出</b>
                  <b>结果</b>
                  <b>时长</b>
                </div>
                {usage.router.records.map(record => (
                  <div key={record.callId}>
                    <span>
                      {record.modelRef}
                      <small>
                        {record.component === 'router'
                          ? '路由'
                          : record.component === 'summary'
                            ? '思考摘要'
                            : record.component === 'memory'
                              ? '记忆沉淀'
                              : '改写'}
                        {record.eventId ? ` · 事件 ${record.eventId}` : ''}
                      </small>
                    </span>
                    <span>
                      {record.inputTokens?.toLocaleString('zh-CN') ?? '—'}
                    </span>
                    <span>
                      {record.outputTokens?.toLocaleString('zh-CN') ?? '—'}
                    </span>
                    <span>{record.outcome === 'ok' ? '成功' : '失败'}</span>
                    <span>{`${String(Math.round(record.durationMs / 1000))}s`}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

function recoveryIntegrityLabel(status: RecoveryStatus): string {
  if (status.integrity === 'ok') return '状态完好'
  if (status.integrity === 'degraded') return '降级运行'
  return '状态不可用'
}

function recoveryPhaseLabel(phase: NonNullable<RecoveryStatus['phase']>) {
  if (phase === 'stable') return '稳定'
  if (phase === 'verifying') return '验证中'
  return '已回滚'
}

function RecoverySettings({
  error,
  onReload,
  status,
}: {
  error?: string
  onReload?: () => void
  status?: RecoveryStatus
}) {
  return (
    <div className="settings-pane mx-auto max-w-[900px] px-9 pt-[34px] pb-10 max-[1120px]:px-6 max-[820px]:px-[18px] max-[820px]:pt-6 max-[820px]:pb-[34px]">
      <SettingsHeading
        title="数据与恢复"
        description="查看本机数据与独立恢复平面的真实状态。"
      />
      <div className="settings-card my-3.5 rounded-card bg-surface p-[18px] shadow-card">
        <div className="card-title flex items-start gap-3 max-[520px]:grid max-[520px]:[grid-template-columns:20px_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:flex-1 [&>[role=combobox]]:max-[520px]:min-w-0 [&>[role=combobox]]:max-[520px]:max-w-full [&>[role=combobox]]:max-[520px]:justify-self-start [&>[role=combobox]]:max-[520px]:[grid-column:2]">
          <Database size={20} />
          <div>
            <h3 className="mb-1 text-[13px]">本地数据库</h3>
            <p className="text-ink-2">
              Conversation、Task 与 Run 的服务端权威记录。
            </p>
          </div>
        </div>
        <p className="text-[12px] leading-[1.6] text-ink-2">
          在线备份目前通过服务端命令执行：<code>pnpm backup</code>；导出数据的
          HTTP API 尚未提供，这里不伪装成可点击操作。
        </p>
        <Button
          className="h-8 px-3.5 text-[13px]"
          disabled
          type="button"
          size="xs"
          variant="secondary"
        >
          导出数据（待服务端 API）
        </Button>
      </div>
      <div className="settings-card my-3.5 rounded-card bg-surface p-[18px] shadow-card">
        <div className="card-title flex items-start gap-3 max-[520px]:grid max-[520px]:[grid-template-columns:20px_minmax(0,1fr)] [&>div]:min-w-0 [&>div]:flex-1 [&>[role=combobox]]:max-[520px]:min-w-0 [&>[role=combobox]]:max-[520px]:max-w-full [&>[role=combobox]]:max-[520px]:justify-self-start [&>[role=combobox]]:max-[520px]:[grid-column:2]">
          <RotateCw size={20} />
          <div>
            <h3 className="mb-1 text-[13px]">恢复平面</h3>
            <p className="text-ink-2">
              独立 Supervisor 提供状态、重启与回滚生命线。
            </p>
          </div>
          {status && (
            <span
              className={`health-badge rounded-chip bg-inset px-[7px] py-1 text-[10px] ${status.integrity === 'ok' ? 'text-green-text' : 'text-ink-2'}`}
            >
              {recoveryIntegrityLabel(status)}
            </span>
          )}
        </div>
        {error ? (
          <div
            className="mb-4 flex items-center gap-2.5 rounded-card bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_var(--red)]"
            role="alert"
          >
            {error}
            {onReload && (
              <Button
                className="h-8 px-3.5 text-[13px]"
                onClick={onReload}
                type="button"

                size="xs"
                variant="secondary"
              >
                <RotateCw size={15} />
                重新读取
              </Button>
            )}
          </div>
        ) : !status ? (
          <p className="my-6 text-[13px] text-ink-2">正在读取恢复状态…</p>
        ) : (
          <>
            {status.active ? (
              <div className="metadata-list recovery-release-list">
                <dl>
                  <div>
                    <dt>当前版本</dt>
                    <dd>
                      {status.active.id}
                      {status.active.commit
                        ? ` · ${status.active.commit.slice(0, 8)}`
                        : ''}
                    </dd>
                  </div>
                  {status.phase && (
                    <div>
                      <dt>阶段</dt>
                      <dd>{recoveryPhaseLabel(status.phase)}</dd>
                    </div>
                  )}
                  {status.active.compatibility && (
                    <div>
                      <dt>兼容 schema</dt>
                      <dd>
                        v{String(status.active.compatibility.minimumSchema)}–v
                        {String(status.active.compatibility.maximumSchema)}
                      </dd>
                    </div>
                  )}
                  {status.updatedAt && (
                    <div>
                      <dt>最近更新</dt>
                      <dd>{formatRelativeTime(status.updatedAt)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>可回滚版本</dt>
                    <dd>
                      {status.previous
                        ? `${status.previous.id}${
                            status.previous.commit
                              ? ` · ${status.previous.commit.slice(0, 8)}`
                              : ''
                          }`
                        : '没有可回滚的上一个版本'}
                    </dd>
                  </div>
                  {status.integrity === 'degraded' && (
                    <div>
                      <dt>状态来源</dt>
                      <dd>last-known-good 备份（主状态文件损坏）</dd>
                    </div>
                  )}
                  {status.lastFailure && (
                    <div>
                      <dt>最近失败</dt>
                      <dd>{status.lastFailure}</dd>
                    </div>
                  )}
                </dl>
              </div>
            ) : (
              <p className="text-[12px] leading-[1.6] text-ink-2">
                恢复平面当前不可用；这不影响本机数据，只表示独立 Supervisor
                生命线暂时无法读取。
              </p>
            )}
            {status.diagnostics.length > 0 && (
              <ul className="recovery-diagnostics">
                {status.diagnostics.map(diagnostic => (
                  <li key={diagnostic}>{diagnostic}</li>
                ))}
              </ul>
            )}
            {onReload && (
              <Button
                className="h-8 px-3.5 text-[13px]"
                onClick={onReload}
                type="button"

                size="xs"
                variant="secondary"
              >
                <RotateCw size={15} />
                刷新恢复状态
              </Button>
            )}
          </>
        )}
      </div>
      <div className="my-3 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2">
        <LockKeyhole size={16} />
        这里只读展示恢复状态；重启与回滚仍需在服务端恢复平面执行，Web
        不提供破坏性操作入口。
      </div>
      <Button
        className="h-9 px-4 text-[13px]"
        disabled
        type="button"
        size="sm"
        variant="danger"
      >
        <Trash2 size={16} />
        清除本机数据（需专门审批设计）
      </Button>
    </div>
  )
}
function AboutSettings() {
  return (
    <div className="settings-pane about-pane mx-auto max-w-[900px] px-9 pt-[100px] pb-10 text-center max-[1120px]:px-6 max-[820px]:px-[18px] max-[820px]:pb-[34px]">
      <PegasMascot label="Pegas 形象" size={168} />
      <h2 className="mt-3 mb-[7px] text-[26px] leading-[1.2] tracking-[-0.03em]">
        Pegas
      </h2>
      <p className="text-ink-2">
        一个以对话为入口、以持久事情为核心的私人智能伙伴。
      </p>
      <dl className="mx-auto mt-10 max-w-[440px] border-t border-line [&>div]:flex [&>div]:justify-between [&>div]:border-b [&>div]:border-line [&>div]:px-1 [&>div]:py-[13px] [&_dt]:text-ink-2 [&_dd]:m-0">
        <div>
          <dt>版本</dt>
          <dd>0.0.1</dd>
        </div>
        <div>
          <dt>Web UI</dt>
          <dd>DESIGN-002</dd>
        </div>
        <div>
          <dt>更新通道</dt>
          <dd>本地开发</dd>
        </div>
      </dl>
    </div>
  )
}
