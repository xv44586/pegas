import {
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
  Palette,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Volume2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type {
  DshModelCatalog,
  ModelCatalogItem,
  ModelProviderDraft,
  ModelUsageReport,
  RuntimeSettings,
  RewriteSettingsDraft,
  SettingsResponse,
  SpeechSettingsDraft,
} from '../types'
import { useVoiceDictation } from '../useVoiceDictation'
import { PegasMark } from './PegasMark'
import {
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
  onReloadUsage: () => void
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
  usage,
  usageError,
  agentModels,
  onSave,
  onOpenDrawer,
  onReloadUsage,
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
  const [speechDraft, setSpeechDraft] = useState<SpeechSettingsDraft>()
  const [rewriteDraft, setRewriteDraft] = useState<RewriteSettingsDraft>()
  useEffect(() => setSection(initialSection), [initialSection])
  useEffect(() => {
    setDraft(response?.settings)
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

  async function save() {
    if (!draft || !providerDraft || saving) return
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

  return (
    <div className="settings-page">
      <aside className="settings-nav" aria-label="设置分类">
        <div className="settings-nav-title">
          <h1>设置</h1>
          <button aria-label="返回 Pegas" onClick={onBack} type="button">
            返回
          </button>
        </div>
        {settingsSections.map(item => {
          const Icon = sectionIcons[item.id]
          return (
            <button
              className={section === item.id ? 'is-active' : ''}
              key={item.id}
              onClick={() => selectSection(item.id)}
              type="button"
            >
              <Icon size={17} />
              <span>{item.label}</span>
            </button>
          )
        })}
      </aside>
      <section className="settings-content">
        <div className="settings-scroll-region">
          <fieldset className="settings-fields" disabled={saving}>
            {section === 'appearance' ? (
              <AppearanceSettings
                onChange={onThemeChange}
                systemDark={systemDark}
                theme={theme}
              />
            ) : !draft || !response ? (
              <div className="settings-loading">正在读取设置…</div>
            ) : (
              <>
                {section === 'pegas' && (
                  <PegasSettings
                    agentModels={agentModels}
                    draft={draft}
                    onChange={setDraft}
                    onOpenDrawer={onOpenDrawer}
                  />
                )}
                {section === 'models' && (
                  <ModelServices
                    draft={draft}
                    onDiscoverModels={onDiscoverModels}
                    onOpenRouter={() => selectSection('router')}
                    onOpenVoice={() => selectSection('voice')}
                    onTestModel={onTestModel}
                    providerDraft={providerDraft}
                    response={response}
                    selected={modelServiceProvider}
                    setSelected={setModelServiceProvider}
                    setProviderDraft={setProviderDraft}
                  />
                )}
                {section === 'router' && (
                  <RouterSettings
                    draft={draft}
                    response={response}
                    onChange={next => {
                      if (next.modelProvider !== draft.modelProvider) {
                        const provider = response.capabilities.providers.find(
                          item => item.id === next.modelProvider,
                        )
                        if (provider)
                          setProviderDraft({
                            name: provider.name,
                            protocol: provider.protocol,
                            baseUrl: provider.baseUrl,
                            apiKey: '',
                            clearApiKey: false,
                          })
                      }
                      setDraft(next)
                    }}
                  />
                )}
                {section === 'voice' &&
                  speechDraft &&
                  rewriteDraft &&
                  providerDraft && (
                    <VoiceSettings
                      draft={draft}
                      onChange={setDraft}
                      onSpeechChange={setSpeechDraft}
                      onRewriteChange={setRewriteDraft}
                      onTestRewrite={onTestRewrite}
                      onTestSpeech={onTestSpeech}
                      providerDraft={providerDraft}
                      rewriteDraft={rewriteDraft}
                      speechDraft={speechDraft}
                    />
                  )}
                {section === 'connections' && <ConnectionsSettings />}
                {section === 'memory' && <MemorySettings />}
                {section === 'privacy' && (
                  <PrivacySettings
                    available={response.capabilities.privacyAvailable}
                    draft={draft}
                    onChange={setDraft}
                  />
                )}
                {section === 'notifications' && <NotificationSettings />}
                {section === 'usage' && (
                  <UsageSettings
                    error={usageError}
                    onRetry={onReloadUsage}
                    usage={usage}
                  />
                )}
                {section === 'recovery' && <RecoverySettings />}
                {section === 'about' && <AboutSettings />}
              </>
            )}
          </fieldset>
        </div>
        {draft &&
          providerDraft &&
          ['pegas', 'models', 'router', 'voice', 'privacy'].includes(section) &&
          (section !== 'models' ||
            modelServiceProvider === draft.modelProvider) && (
            <footer className="settings-footer">
              <span
                className={notice?.kind === 'error' ? 'is-error' : ''}
                role={notice?.kind === 'error' ? 'alert' : 'status'}
              >
                {notice?.message}
              </span>
              <button
                className="secondary-button"
                disabled={saving}
                onClick={() => {
                  setDraft(response?.settings)
                  setModelServiceProvider(response?.settings.modelProvider)
                  const savedProvider = response?.capabilities.providers.find(
                    provider => provider.id === response.settings.modelProvider,
                  )
                  if (savedProvider)
                    setProviderDraft({
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
              >
                取消
              </button>
              <button
                className="primary-button"
                disabled={saving}
                onClick={() => void save()}
                type="button"
              >
                {saving ? '保存中…' : '保存更改'}
              </button>
            </footer>
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
    <header className="settings-heading">
      <h2>{title}</h2>
      <p>{description}</p>
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
      id: 'warm',
      label: '暖纸',
      description: '柔和米白，适合长时间阅读。',
      icon: Sparkles,
    },
    {
      id: 'dark',
      label: '深色',
      description: '深色表面，适合低光环境。',
      icon: MoonStar,
    },
  ]
  return (
    <div className="settings-pane appearance-settings">
      <SettingsHeading
        title="外观"
        description="选择 Pegas 在这台设备上的显示方式。"
      />
      <fieldset>
        <legend>主题</legend>
        <div className="appearance-options">
          {choices.map(({ id, label, description, icon: Icon }) => (
            <label className={theme === id ? 'is-active' : ''} key={id}>
              <span
                aria-hidden="true"
                className={`appearance-preview is-${id}`}
              >
                <i />
                <i />
                <i />
              </span>
              <span className="appearance-option-copy">
                <span>
                  <Icon size={17} />
                  <strong>{label}</strong>
                </span>
                <small>{description}</small>
              </span>
              <input
                checked={theme === id}
                name="appearance-theme"
                onChange={() => onChange(id)}
                type="radio"
                value={id}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <div className="info-banner">
        <CircleHelp size={16} />
        更改会立即生效，并保存在当前设备。
      </div>
    </div>
  )
}

function PegasSettings({
  draft,
  agentModels,
  onChange,
  onOpenDrawer,
}: {
  draft: RuntimeSettings
  agentModels?: DshModelCatalog
  onChange: (settings: RuntimeSettings) => void
  onOpenDrawer: (drawer: DrawerView) => void
}) {
  const [tab, setTab] = useState<'model' | 'behavior' | 'autonomy'>('model')
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
  const selectedModelAvailable = agentModels?.models.some(
    model =>
      model.provider.toLocaleLowerCase() ===
        selectedProvider.toLocaleLowerCase() && model.id === selectedModel,
  )
  const availability = !agentModels
    ? { className: 'is-unknown', label: '目录未知' }
    : selectedModelAvailable
      ? { className: '', label: '可用' }
      : { className: 'is-unavailable', label: '未在模型目录中' }
  return (
    <div className="settings-pane pegas-settings">
      <div className="pegas-settings-title">
        <PegasMark size={44} />
        <SettingsHeading
          title="Pegas"
          description="设置你的个人执行伙伴如何工作和与你沟通。"
        />
      </div>
      <div className="setting-summary-row">
        <span>执行模型</span>
        <b>
          {selectedProvider && selectedModel
            ? `${selectedProvider} · ${selectedModel}`
            : '服务端未提供'}
        </b>
        <em className={availability.className}>
          <i />
          {availability.label}
        </em>
        <button
          className="secondary-button"
          onClick={() => setTab('model')}
          type="button"
        >
          更换模型
        </button>
      </div>
      <div className="setting-summary-row">
        <span>执行环境</span>
        <b>隔离执行环境</b>
        <em>
          <i />
          运行时快照
        </em>
        <button
          className="secondary-button"
          onClick={() => onOpenDrawer({ kind: 'runtime' })}
          type="button"
        >
          查看运行时
        </button>
      </div>
      <div className="info-banner">
        <CircleHelp size={16} />
        模型变更仅作用于新会话；已有会话继续使用创建时的模型。
      </div>
      <div className="settings-tabs" role="tablist">
        <button
          aria-selected={tab === 'model'}
          onClick={() => setTab('model')}
          role="tab"
          type="button"
        >
          执行模型
        </button>
        <button
          aria-selected={tab === 'behavior'}
          onClick={() => setTab('behavior')}
          role="tab"
          type="button"
        >
          行为与规则
        </button>
        <button
          aria-selected={tab === 'autonomy'}
          onClick={() => setTab('autonomy')}
          role="tab"
          type="button"
        >
          自主程度
        </button>
      </div>
      {tab === 'model' && (
        <div className="setting-section">
          <h3>新建执行会话</h3>
          <label className="field-label">
            模型
            <select
              value={selectedModelValue}
              onChange={event => {
                if (event.target.value === 'profile') {
                  onChange({
                    ...draft,
                    agentModelMode: 'profile',
                    agentModelProvider: '',
                    agentModelName: '',
                  })
                  return
                }
                const model = models.find(
                  item => `${item.provider}::${item.id}` === event.target.value,
                )
                if (!model) return
                onChange({
                  ...draft,
                  agentModelMode: 'override',
                  agentModelProvider: model.provider,
                  agentModelName: model.id,
                })
              }}
            >
              <option value="profile">
                隔离环境默认模型（Pegas 专属 profile）
              </option>
              {models.length ? (
                models.map(model => (
                  <option
                    key={`${model.provider}/${model.id}`}
                    value={`${model.provider}::${model.id}`}
                  >
                    {model.name} · {model.provider}
                  </option>
                ))
              ) : (
                <option value="">服务端未提供可选模型</option>
              )}
            </select>
          </label>
          <p className="field-hint">
            凭证由 Pegas 的模型服务或隔离的 DSH profile 提供，不读取个人默认
            profile。
          </p>
        </div>
      )}
      {tab === 'behavior' && (
        <div className="setting-section">
          <div className="info-banner">
            <LockKeyhole size={16} />
            规则服务尚未建立服务端事实来源；当前仅展示封板结构，不能保存。
          </div>
          <h3>基本行为</h3>
          <div className="compact-field-row">
            <span>默认语言</span>
            <select defaultValue="中文" disabled>
              <option>中文</option>
              <option>English</option>
            </select>
          </div>
          <div className="compact-field-row">
            <span>回复长度</span>
            <div className="segmented">
              <button disabled type="button">
                简洁
              </button>
              <button className="is-active" disabled type="button">
                适中
              </button>
              <button disabled type="button">
                详细
              </button>
            </div>
          </div>
          <div className="compact-field-row">
            <span>开始工作前</span>
            <select defaultValue="确认服务尚未接入" disabled>
              <option>确认服务尚未接入</option>
            </select>
          </div>
          <h3>工作规则</h3>
          <div className="rule-list">
            {[
              '重要外部操作确认规则（尚未接入）',
              '产品设计优先给出具体界面方案',
              '发布前先说明回滚路径',
            ].map(rule => (
              <button
                key={rule}
                onClick={() => onOpenDrawer({ kind: 'rule', title: rule })}
                type="button"
              >
                <span>{rule}</span>
                <small>全局</small>
                <Pencil size={15} />
                <i />
              </button>
            ))}
          </div>
          <button className="outline-action" disabled type="button">
            <Plus size={16} />
            添加规则
          </button>
          <label className="field-label">
            自定义指令
            <textarea
              disabled
              defaultValue="涉及产品设计时，优先给出具体界面方案；涉及发布操作时，先列出回滚路径。"
              rows={3}
            />
          </label>
        </div>
      )}
      {tab === 'autonomy' && (
        <div className="setting-section">
          <h3>自主程度</h3>
          <p className="setting-copy">
            Approval
            服务尚未建立服务端事实来源；当前界面不能保证外部发布、付款、删除或权限变更会被自动拦截。
          </p>
          <input
            aria-label="自主程度"
            defaultValue="62"
            disabled
            max="100"
            min="0"
            type="range"
          />
        </div>
      )}
    </div>
  )
}

function ModelServices({
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
  const [models, setModels] = useState<ModelCatalogItem[]>([])
  const [modelQuery, setModelQuery] = useState('')
  const [modelPage, setModelPage] = useState(0)
  const [busy, setBusy] = useState<'test' | 'discover'>()
  const [status, setStatus] = useState('')
  const providerRequestRef = useRef(0)
  const active =
    providers.find(provider => provider.id === selected) ?? providers[0]
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
      setModels(result)
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
  const pageSize = 25
  const pageCount = Math.max(1, Math.ceil(visibleModels.length / pageSize))
  const pageModels = visibleModels.slice(
    modelPage * pageSize,
    (modelPage + 1) * pageSize,
  )
  const rangeStart = visibleModels.length ? modelPage * pageSize + 1 : 0
  const rangeEnd = Math.min((modelPage + 1) * pageSize, visibleModels.length)
  return (
    <div className="settings-pane">
      <SettingsHeading
        title="模型服务"
        description="管理连接、凭证与模型目录；不决定哪些角色使用哪个模型。"
      />
      <div className="model-service-layout">
        <aside className="provider-list">
          <label>
            <Search size={16} />
            <input
              aria-label="搜索模型服务"
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索模型服务"
              value={query}
            />
          </label>
          <small>已添加</small>
          {providers
            .filter(provider =>
              provider.name.toLowerCase().includes(query.toLowerCase()),
            )
            .map(provider => (
              <button
                className={provider.id === active?.id ? 'is-active' : ''}
                key={provider.id}
                onClick={() => {
                  providerRequestRef.current += 1
                  setSelected(provider.id)
                  setModels([])
                  setModelPage(0)
                  setModelQuery('')
                  setStatus('')
                }}
                type="button"
              >
                <span className="provider-glyph">
                  <Layers3 size={18} />
                </span>
                <span>
                  <strong>{provider.name}</strong>
                  <small className={provider.available ? 'is-good' : ''}>
                    {provider.available
                      ? '连接正常'
                      : (provider.reason ?? '未配置')}
                  </small>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
          <button
            className="outline-action add-provider"
            disabled
            title="服务端尚未提供新增 Provider API"
            type="button"
          >
            <Plus size={16} />
            添加模型服务
          </button>
        </aside>
        {active && (
          <div className="provider-detail">
            <header>
              <div>
                <h3>{active.name}</h3>
                <span
                  className={
                    active.available ? 'health-badge is-good' : 'health-badge'
                  }
                >
                  {status || (active.available ? '已配置' : '未连接')}
                </span>
              </div>
              <button
                className="secondary-button"
                disabled={Boolean(busy) || !canProbe}
                onClick={() => void test()}
                type="button"
              >
                {busy === 'test' ? '测试中…' : '测试连接'}
              </button>
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
                  <label className="field-label">
                    接口协议
                    <select
                      onChange={event =>
                        setProviderDraft({
                          ...providerDraft,
                          protocol: event.target
                            .value as ModelProviderDraft['protocol'],
                        })
                      }
                      value={providerDraft.protocol}
                    >
                      <option value="openai-chat">
                        OpenAI Chat Completions
                      </option>
                      <option value="anthropic-messages">
                        Anthropic Messages
                      </option>
                    </select>
                  </label>
                )}
                <label className="field-label">
                  服务地址
                  <input
                    onChange={event =>
                      setProviderDraft({
                        ...providerDraft,
                        baseUrl: event.target.value,
                      })
                    }
                    readOnly={active.id !== 'custom'}
                    value={providerDraft.baseUrl}
                  />
                </label>
                <label className="field-label">
                  API Key
                  <input
                    autoComplete="off"
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
                </label>
                {active.hasApiKey && (
                  <label className="switch-row">
                    清除已保存的 API Key
                    <input
                      checked={providerDraft.clearApiKey}
                      onChange={event =>
                        setProviderDraft({
                          ...providerDraft,
                          clearApiKey: event.target.checked,
                          apiKey: '',
                        })
                      }
                      type="checkbox"
                    />
                  </label>
                )}
              </div>
            ) : (
              <div className="info-banner">
                <LockKeyhole size={16} />
                当前服务端只允许编辑事情归类正在使用的
                Provider；请先在“事情归类”中选用。
              </div>
            )}
            {!canProbe && (
              <div className="info-banner">
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
                  <button onClick={onOpenRouter} type="button">
                    打开设置
                  </button>
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
                  <button onClick={onOpenVoice} type="button">
                    打开设置
                  </button>
                </dd>
              </div>
            </dl>
            <h4>
              可用模型 <b>{models.length}</b>
            </h4>
            <button
              className="secondary-button"
              disabled={Boolean(busy) || !canProbe}
              onClick={() => void discover()}
              type="button"
            >
              {busy === 'discover' ? '读取中…' : '获取模型目录'}
            </button>
            <label className="model-search">
              <Search size={16} />
              <input
                onChange={event => {
                  setModelQuery(event.target.value)
                  setModelPage(0)
                }}
                placeholder="按名称或模型 ID 搜索"
                value={modelQuery}
              />
            </label>
            <div className="model-table">
              <div>
                <b>模型</b>
                <b>能力</b>
                <b>状态</b>
              </div>
              {pageModels.map(model => (
                <div key={model.id}>
                  <span>{model.name}</span>
                  <span>{model.id}</span>
                  <span className="is-good">
                    <i />
                    已发现
                  </span>
                </div>
              ))}
              {!visibleModels.length && (
                <p className="table-empty">
                  点击“获取模型目录”读取服务端数据。
                </p>
              )}
            </div>
            <div className="pagination">
              <span>
                {rangeStart}–{rangeEnd} / {visibleModels.length}
              </span>
              <button
                disabled={modelPage === 0}
                onClick={() => setModelPage(page => Math.max(0, page - 1))}
                type="button"
              >
                上一页
              </button>
              <button
                disabled={modelPage >= pageCount - 1}
                onClick={() =>
                  setModelPage(page => Math.min(pageCount - 1, page + 1))
                }
                type="button"
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function RouterSettings({
  draft,
  response,
  onChange,
}: {
  draft: RuntimeSettings
  response: SettingsResponse
  onChange: (settings: RuntimeSettings) => void
}) {
  return (
    <div className="settings-pane router-settings">
      <SettingsHeading
        title="事情归类"
        description="决定一条新消息是继续已有事情，还是开始一件新事情。"
      />
      <div className="compact-field-row">
        <span>归类方式</span>
        <div className="segmented">
          <button
            className={draft.routerMode === 'model' ? 'is-active' : ''}
            onClick={() => onChange({ ...draft, routerMode: 'model' })}
            type="button"
          >
            智能判断
          </button>
          <button
            className={draft.routerMode === 'rules' ? 'is-active' : ''}
            onClick={() => onChange({ ...draft, routerMode: 'rules' })}
            type="button"
          >
            确定性规则
          </button>
        </div>
      </div>
      <div className="compact-field-row">
        <span>归类模型</span>
        <select
          aria-label="归类模型服务"
          value={draft.modelProvider}
          onChange={event => {
            const modelProvider = event.target
              .value as RuntimeSettings['modelProvider']
            const provider = response.capabilities.providers.find(
              item => item.id === modelProvider,
            )
            onChange({
              ...draft,
              modelProvider,
              modelName: provider?.defaultModel ?? '',
            })
          }}
        >
          {response.capabilities.providers.map(provider => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>
        <input
          aria-label="归类模型名称"
          onChange={event =>
            onChange({ ...draft, modelName: event.target.value })
          }
          value={draft.modelName}
        />
      </div>
      <div className="compact-field-row">
        <span>不确定时</span>
        <div className="radio-row">
          <label>
            <input defaultChecked disabled name="uncertain" type="radio" />
            开始新事情
          </label>
          <label>
            <input disabled name="uncertain" type="radio" />
            先问我
          </label>
          <label>
            <input disabled name="uncertain" type="radio" />
            优先继续最近的事情
          </label>
        </div>
      </div>
      <h3>归类规则</h3>
      <div className="rule-list">
        <button disabled type="button">
          <LockKeyhole size={15} />
          <span>目标明显不同则开始新事情</span>
          <small>默认规则（已锁定）</small>
        </button>
        <button disabled type="button">
          <LockKeyhole size={15} />
          <span>已停止的事情不自动恢复</span>
          <small>系统规则（已锁定）</small>
        </button>
        <button disabled type="button">
          <span>遇到「继续」「刚才」时优先检查最近事情</span>
          <small>启用</small>
          <i />
        </button>
      </div>
      <button className="outline-action" disabled type="button">
        <Plus size={16} />
        添加规则
      </button>
      <h3>测试归类</h3>
      <div className="test-row">
        <input defaultValue="刚才那个方案再加上 Telegram" disabled />
        <button className="secondary-button" disabled type="button">
          测试
        </button>
      </div>
      <div className="info-banner">
        <LockKeyhole size={16} />
        归类测试 API 尚未提供，测试工具暂不可用。
      </div>
    </div>
  )
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
    <div className="settings-pane">
      <SettingsHeading
        title="语音与输入"
        description="配置听写、输入改写和发送前校对。"
      />
      <div className="settings-card">
        <div className="card-title">
          <Mic size={20} />
          <div>
            <h3>语音听写</h3>
            <p>录音仅用于本次转写，默认不持久化。</p>
          </div>
          <select
            aria-label="语音服务"
            onChange={event =>
              onSpeechChange({
                ...speechDraft,
                provider: event.target.value as SpeechSettingsDraft['provider'],
              })
            }
            value={speechDraft.provider}
          >
            <option value="disabled">关闭</option>
            <option value="openai-compatible">OpenAI 兼容</option>
          </select>
        </div>
        {speechDraft.provider === 'openai-compatible' && (
          <>
            <label className="field-label">
              服务地址
              <input
                onChange={event =>
                  onSpeechChange({
                    ...speechDraft,
                    baseUrl: event.target.value,
                  })
                }
                value={speechDraft.baseUrl}
              />
            </label>
            <label className="field-label">
              模型
              <input
                onChange={event =>
                  onSpeechChange({ ...speechDraft, model: event.target.value })
                }
                value={speechDraft.model}
              />
            </label>
            <label className="field-label">
              API Key
              <input
                autoComplete="off"
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
            </label>
            {speechDraft.hasApiKey && (
              <label className="switch-row">
                清除已保存的 API Key
                <input
                  checked={speechDraft.clearApiKey}
                  onChange={event =>
                    onSpeechChange({
                      ...speechDraft,
                      clearApiKey: event.target.checked,
                      apiKey: '',
                    })
                  }
                  type="checkbox"
                />
              </label>
            )}
            <button
              className="secondary-button"
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
            >
              <Mic size={16} />
              {dictation.state === 'recording'
                ? '结束并识别'
                : dictation.state === 'transcribing'
                  ? '正在识别…'
                  : '录一段测试'}
            </button>
            {speechResult && (
              <p className="test-result" role="status">
                {speechResult}
              </p>
            )}
            {dictation.error && (
              <p className="settings-error" role="alert">
                {dictation.error}
              </p>
            )}
          </>
        )}
      </div>
      <div className="settings-card">
        <div className="card-title">
          <Sparkles size={20} />
          <div>
            <h3>输入改写</h3>
            <p>发送前清理口头语，不改变原意。</p>
          </div>
        </div>
        <label className="switch-row">
          启用轻量改写
          <input
            checked={draft.rewriteMode === 'light'}
            onChange={event =>
              onChange({
                ...draft,
                rewriteMode: event.target.checked ? 'light' : 'disabled',
              })
            }
            type="checkbox"
          />
        </label>
        {draft.rewriteMode === 'light' && (
          <>
            <div className="segmented">
              <button
                className={rewriteDraft.mode === 'router' ? 'is-active' : ''}
                onClick={() =>
                  onRewriteChange({ ...rewriteDraft, mode: 'router' })
                }
                type="button"
              >
                跟随事情归类
              </button>
              <button
                className={rewriteDraft.mode === 'custom' ? 'is-active' : ''}
                onClick={() =>
                  onRewriteChange({ ...rewriteDraft, mode: 'custom' })
                }
                type="button"
              >
                独立服务
              </button>
            </div>
            {rewriteDraft.mode === 'custom' && (
              <div className="provider-edit-fields">
                <label className="field-label">
                  改写接口协议
                  <select
                    onChange={event =>
                      onRewriteChange({
                        ...rewriteDraft,
                        protocol: event.target
                          .value as RewriteSettingsDraft['protocol'],
                      })
                    }
                    value={rewriteDraft.protocol}
                  >
                    <option value="openai-chat">OpenAI Chat Completions</option>
                    <option value="anthropic-messages">
                      Anthropic Messages
                    </option>
                  </select>
                </label>
                <label className="field-label">
                  服务地址
                  <input
                    onChange={event =>
                      onRewriteChange({
                        ...rewriteDraft,
                        baseUrl: event.target.value,
                      })
                    }
                    value={rewriteDraft.baseUrl}
                  />
                </label>
                <label className="field-label">
                  模型
                  <input
                    onChange={event =>
                      onRewriteChange({
                        ...rewriteDraft,
                        model: event.target.value,
                      })
                    }
                    value={rewriteDraft.model}
                  />
                </label>
                <label className="field-label">
                  API Key
                  <input
                    autoComplete="off"
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
                </label>
                {rewriteDraft.hasApiKey && (
                  <label className="switch-row">
                    清除改写服务 API Key
                    <input
                      aria-label="清除改写服务 API Key"
                      checked={rewriteDraft.clearApiKey}
                      onChange={event =>
                        onRewriteChange({
                          ...rewriteDraft,
                          clearApiKey: event.target.checked,
                          apiKey: '',
                        })
                      }
                      type="checkbox"
                    />
                  </label>
                )}
              </div>
            )}
            <label className="field-label">
              测试文本
              <textarea
                maxLength={4000}
                onChange={event => setRewriteSample(event.target.value)}
                rows={3}
                value={rewriteSample}
              />
            </label>
            <button
              className="secondary-button"
              disabled={rewriteTesting || !rewriteSample.trim()}
              onClick={() => void testRewrite()}
              type="button"
            >
              {rewriteTesting ? '测试中…' : '测试改写'}
            </button>
            {rewriteResult && (
              <p className="test-result" role="status">
                {rewriteResult}
              </p>
            )}
            {rewriteError && (
              <p className="settings-error" role="alert">
                {rewriteError}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ConnectionsSettings() {
  return (
    <div className="settings-pane">
      <SettingsHeading
        title="能力与连接"
        description="查看 Pegas 可以访问的工具与外部服务。"
      />
      <div className="info-banner">
        <LockKeyhole size={16} />
        能力清单 API 尚未提供，以下为封板中的连接类型，不代表当前已授权。
      </div>
      <div className="connection-grid">
        {[
          ['本地文件', '状态未提供'],
          ['浏览器', '状态未提供'],
          ['GitHub', '状态未提供'],
          ['Telegram', '状态未提供'],
        ].map(([name, detail], index) => (
          <article key={name}>
            <span>
              <Link2 size={19} />
            </span>
            <div>
              <h3>{name}</h3>
              <p>{detail}</p>
            </div>
            <button className="secondary-button" disabled type="button">
              {index < 2 ? '管理' : '连接'}
            </button>
          </article>
        ))}
      </div>
    </div>
  )
}
function MemorySettings() {
  return (
    <div className="settings-pane">
      <SettingsHeading
        title="记忆"
        description="管理 Pegas 可以长期记住的内容和作用范围。"
      />
      <div className="unavailable-card">
        <Database size={25} />
        <h3>记忆服务尚未启用</h3>
        <p>服务端记忆模型完成后，这里会提供范围、来源和删除路径。</p>
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
    <div className="settings-pane">
      <SettingsHeading
        title="隐私"
        description="控制内容发往外部模型前的保护方式。"
      />
      <div className="settings-card">
        <div className="card-title">
          <Shield size={20} />
          <div>
            <h3>敏感信息遮罩</h3>
            <p>在可信边界外发送内容前识别并替换常见敏感字段。</p>
          </div>
        </div>
        <label className="switch-row">
          启用遮罩
          <input
            aria-label="启用遮罩"
            checked={draft.privacyMode === 'mask'}
            disabled={!available}
            onChange={event =>
              onChange({
                ...draft,
                privacyMode: event.target.checked ? 'mask' : 'disabled',
              })
            }
            type="checkbox"
          />
        </label>
        {!available && (
          <p className="settings-help">
            服务端尚未配置隐私 HMAC key，暂时无法启用遮罩。
          </p>
        )}
      </div>
      <div className="info-banner">
        <LockKeyhole size={16} />
        模型服务密钥只写入服务端，读取设置时不会回显明文。
      </div>
    </div>
  )
}
function NotificationSettings() {
  return (
    <div className="settings-pane">
      <SettingsHeading
        title="通知"
        description="选择哪些变化值得主动打扰你。"
      />
      <div className="info-banner">
        <LockKeyhole size={16} />
        通知偏好 API 尚未提供；当前仅展示封板结构。
      </div>
      {['事情完成', '需要确认', '执行失败', '长任务阶段性进展'].map(
        (label, index) => (
          <label className="switch-row bordered" key={label}>
            {label}
            <input defaultChecked={index < 3} disabled type="checkbox" />
          </label>
        ),
      )}
    </div>
  )
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
  return (
    <div className="settings-pane">
      <SettingsHeading
        title="模型用量"
        description="按模型、事情和 Run 查看供应商真实上报的消耗。"
      />
      {error && (
        <div className="info-banner usage-load-error" role="alert">
          <span>
            <CircleAlert size={16} />
            {error}
            {usage ? '；以下为上次成功读取的数据。' : ''}
          </span>
          <button className="secondary-button" onClick={onRetry} type="button">
            重新读取
          </button>
        </div>
      )}
      {!usage ? (
        <div className="settings-empty">尚未取得用量数据。</div>
      ) : (
        <>
          <div className="usage-metrics">
            <article>
              <small>总 Token</small>
              <strong>{total?.toLocaleString('zh-CN') ?? '—'}</strong>
              <span>{hasTokenUsage ? '输入 + 输出' : '执行器未回报'}</span>
            </article>
            <article>
              <small>缓存读取</small>
              <strong>
                {hasCacheUsage
                  ? (summary?.cacheReadTokens ?? 0).toLocaleString('zh-CN')
                  : '—'}
              </strong>
              <span>{hasCacheUsage ? '供应商上报' : '执行器未回报'}</span>
            </article>
            <article>
              <small>运行时长</small>
              <strong>
                {hasDuration
                  ? `${String(Math.round((summary?.durationMs ?? 0) / 1000))}s`
                  : '—'}
              </strong>
              <span>{hasDuration ? 'Pegas 观测' : '执行器未回报'}</span>
            </article>
            <article>
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
          <div className="usage-table">
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
        </>
      )}
    </div>
  )
}

function RecoverySettings() {
  return (
    <div className="settings-pane">
      <SettingsHeading
        title="数据与恢复"
        description="查看本机数据、导出和独立恢复入口。"
      />
      <div className="info-banner">
        <LockKeyhole size={16} />
        导出与恢复状态 API 尚未提供；当前操作不可用。
      </div>
      <div className="settings-card">
        <div className="card-title">
          <Database size={20} />
          <div>
            <h3>本地数据库</h3>
            <p>Conversation、Task 与 Run 的服务端权威记录。</p>
          </div>
          <span className="health-badge">状态未提供</span>
        </div>
        <button className="secondary-button" disabled type="button">
          导出数据
        </button>
      </div>
      <div className="settings-card">
        <div className="card-title">
          <RotateCw size={20} />
          <div>
            <h3>恢复平面</h3>
            <p>独立 Supervisor 提供状态、重启与回滚生命线。</p>
          </div>
        </div>
        <button className="secondary-button" disabled type="button">
          查看恢复状态
        </button>
      </div>
      <button className="danger-button" disabled type="button">
        <Trash2 size={16} />
        清除本机数据
      </button>
    </div>
  )
}
function AboutSettings() {
  return (
    <div className="settings-pane about-pane">
      <PegasMark size={58} />
      <h2>Pegas</h2>
      <p>一个以对话为入口、以持久事情为核心的私人智能伙伴。</p>
      <dl>
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
