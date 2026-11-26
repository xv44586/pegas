import {
  ArrowRight,
  Check,
  ChevronLeft,
  Link2,
  Mic,
  Server,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  Button,
  FormField,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TextInput,
} from '@bui/index'

import type {
  DshModelCatalog,
  DshModelCatalogItem,
  ModelProviderDraft,
  ModelCatalogItem,
  RuntimeSettings,
  SettingsResponse,
} from '../types'
import { ModelPicker, modelSelectionKey } from './ModelPicker'
import { PegasMark } from './PegasMark'

export function Onboarding({
  response,
  catalog,
  onSelectModel,
  onSaveConnection,
  onTestConnection,
  onTestModel,
  onReloadCatalog,
  onComplete,
  onContinueSettings,
}: {
  response?: SettingsResponse
  catalog?: DshModelCatalog
  onSelectModel?: (model: DshModelCatalogItem) => Promise<void>
  onSaveConnection?: (
    modelProvider: RuntimeSettings['modelProvider'],
    modelName: string,
    provider: ModelProviderDraft,
  ) => Promise<void>
  onTestConnection?: (
    modelProvider: RuntimeSettings['modelProvider'],
    provider: ModelProviderDraft,
  ) => Promise<ModelCatalogItem[]>
  onTestModel?: (
    modelProvider: RuntimeSettings['modelProvider'],
    modelName: string,
    provider: ModelProviderDraft,
  ) => Promise<{ ok: true; latencyMs: number }>
  onReloadCatalog?: () => void
  onComplete: () => void
  onContinueSettings: () => void
}) {
  const [step, setStep] = useState(0)
  const [editingConnection, setEditingConnection] = useState(false)
  const [connectionDraft, setConnectionDraft] = useState<{
    providerId?: string
    baseUrl?: string
    apiKey?: string
    protocol?: ModelProviderDraft['protocol']
  }>({})
  const [connectionBusy, setConnectionBusy] = useState<'test' | 'save'>()
  const [connectionNotice, setConnectionNotice] = useState<{
    kind: 'success' | 'error'
    message: string
  }>()
  const [discovered, setDiscovered] = useState<{
    signature: string
    models: DshModelCatalogItem[]
  }>()
  const [selectedDraftModel, setSelectedDraftModel] =
    useState<DshModelCatalogItem>()
  const [savedModel, setSavedModel] = useState<DshModelCatalogItem>()
  const dialogRef = useRef<HTMLElement>(null)
  const setupBodyRef = useRef<HTMLDivElement>(null)
  const primaryActionRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined
    primaryActionRef.current?.focus()
    const containFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const openPicker = document.querySelector('.model-picker-panel')
      if (openPicker) {
        const pickerFocusable = openPicker.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
        )
        if (!pickerFocusable.length) return
        const first = pickerFocusable[0]
        const last = pickerFocusable[pickerFocusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        } else if (
          document.activeElement instanceof HTMLElement &&
          !openPicker.contains(document.activeElement)
        ) {
          event.preventDefault()
          first?.focus()
        }
        return
      }
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', containFocus)
    return () => {
      document.removeEventListener('keydown', containFocus)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])
  const steps = [
    {
      title: '欢迎使用 Pegas',
      description: '把目标交给 Pegas。事情会被持续推进，并在需要你决定时回来。',
      icon: Sparkles,
    },
    {
      title: '连接模型服务',
      description: '选择供应商，测试连接后选择默认模型。凭证只保存在服务端。',
      icon: Link2,
    },
    {
      title: '准备执行环境',
      description: 'Pegas 使用隔离的 DSH profile，不读取你的个人默认环境。',
      icon: Server,
    },
    {
      title: '语音与完成确认',
      description: '语音是可选输入方式。你可以稍后在设置中配置或修改。',
      icon: Mic,
    },
  ] as const
  const current = steps[step] ?? steps[0]
  const Icon = current.icon
  const models = catalog?.models ?? []
  const providers = response?.capabilities.providers ?? []
  const routerProvider = providers.find(
    provider => provider.id === response?.settings.modelProvider,
  )
  const provider = connectionDraft.providerId
    ? providers.find(candidate => candidate.id === connectionDraft.providerId)
    : routerProvider
  const showConnection =
    editingConnection ||
    !routerProvider?.available ||
    (!models.length && !savedModel)
  const baseUrl = connectionDraft.baseUrl ?? provider?.baseUrl ?? ''
  const apiKey = connectionDraft.apiKey ?? ''
  const reuseKey =
    provider?.hasApiKey &&
    baseUrl.trim().replace(/\/+$/, '') === provider.baseUrl.replace(/\/+$/, '')

  const protocol = connectionDraft.protocol ?? provider?.protocol
  const signature = JSON.stringify([
    provider?.id,
    protocol,
    baseUrl,
    apiKey,
    reuseKey,
  ])
  const draftModels =
    discovered?.signature === signature ? discovered.models : []
  const draftModel = draftModels.find(
    model => model.id === selectedDraftModel?.id,
  )

  async function probeConnection(kind: 'test' | 'save') {
    if (connectionBusy || !provider || !onSaveConnection || !onTestConnection)
      return
    if (kind === 'save' && (!draftModel || !onTestModel)) {
      setConnectionNotice({
        kind: 'error',
        message: '请先测试连接并选择默认模型。',
      })
      return
    }
    const draft: ModelProviderDraft = {
      name: provider.name,
      protocol: protocol ?? provider.protocol,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      clearApiKey: provider.hasApiKey && !reuseKey && !apiKey.trim(),
    }
    // Pin the credential destination before any response can refresh capabilities.
    setConnectionDraft({ providerId: provider.id, baseUrl, apiKey, protocol })
    setEditingConnection(true)
    setConnectionBusy(kind)
    setConnectionNotice(undefined)
    try {
      if (kind === 'test') {
        setDiscovered(undefined)
        setSelectedDraftModel(undefined)
        const result = await onTestConnection(provider.id, draft)
        if (!result.length)
          throw new Error(
            '连接成功，但没有返回可用模型。请检查供应商、地址或 Key 权限后重试。',
          )
        setDiscovered({
          signature,
          models: result.map(model => ({ ...model, provider: provider.id })),
        })
        setConnectionNotice({
          kind: 'success',
          message: `连接正常 · 已获取 ${String(result.length)} 个模型，请选择默认模型。`,
        })
      } else if (draftModel && onTestModel) {
        await onTestModel(provider.id, draftModel.id, draft)
        await onSaveConnection(provider.id, draftModel.id, draft)
        setSavedModel(draftModel)
        setConnectionDraft({})
        setDiscovered(undefined)
        setSelectedDraftModel(undefined)
        setEditingConnection(false)
        setConnectionNotice({
          kind: 'success',
          message: '连接和默认模型已保存',
        })
      }
    } catch (caught) {
      setConnectionNotice({
        kind: 'error',
        message:
          caught instanceof Error ? caught.message : '连接失败，请重试。',
      })
    } finally {
      setConnectionBusy(undefined)
    }
  }

  function editConnection(next: typeof connectionDraft) {
    setEditingConnection(true)
    setConnectionDraft({
      providerId: provider?.id,
      baseUrl,
      apiKey,
      protocol,
      ...next,
    })
    setDiscovered(undefined)
    setSelectedDraftModel(undefined)
    setConnectionNotice(undefined)
  }

  const configuredProvider =
    response?.settings.agentModelMode === 'override'
      ? response.settings.agentModelProvider
      : (catalog?.defaultProvider ?? response?.settings.modelProvider)
  const configuredModelId =
    response?.settings.agentModelMode === 'override'
      ? response.settings.agentModelName
      : (catalog?.defaultModel ?? response?.settings.modelName)
  const configuredModel = configuredModelId
    ? (models.find(
        model =>
          model.id === configuredModelId &&
          (!configuredProvider || model.provider === configuredProvider),
      ) ??
      models.find(model => model.id === configuredModelId) ??
      (savedModel?.id === configuredModelId &&
      savedModel.provider === configuredProvider
        ? savedModel
        : undefined))
    : undefined
  return (
    <div className="onboarding-backdrop">
      <section
        aria-labelledby="setup-title"
        aria-modal="true"
        className="onboarding-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <PegasMark size={40} />
          <span>首次设置</span>
          <b>
            {step + 1} / {steps.length}
          </b>
        </header>
        <div className="setup-progress">
          {steps.map((_, index) => (
            <i className={index <= step ? 'is-active' : ''} key={index} />
          ))}
        </div>
        <div className="setup-body" ref={setupBodyRef}>
          <span className="setup-icon">
            <Icon size={27} />
          </span>
          <h1 id="setup-title">{current.title}</h1>
          <p>{current.description}</p>
          {step === 0 && (
            <div className="setup-points">
              <span>
                <Check size={16} />
                对话与事情状态由服务端安全保存
              </span>
              <span>
                <ShieldCheck size={16} />
                高风险 Action 会持久等待你的决定，再从恢复点继续
              </span>
            </div>
          )}
          {step === 1 && (
            <div className="setup-form">
              {provider &&
                onSaveConnection &&
                onTestConnection &&
                (showConnection ? (
                  <form
                    aria-label="模型连接配置"
                    className="setup-connection"
                    method="post"
                    onSubmit={event => {
                      event.preventDefault()
                      void probeConnection('test')
                    }}
                  >
                    {!draftModels.length &&
                      (!routerProvider?.available || !models.length) && (
                        <p className="setup-connection-hint">
                          {routerProvider?.available
                            ? '请选择供应商并测试连接，获取可选模型。'
                            : '尚未配置模型连接。请测试连接，再选择默认模型。'}
                        </p>
                      )}
                    <FormField htmlFor="setup-provider" label="供应商">
                      <Select
                        disabled={Boolean(connectionBusy)}
                        name="modelProvider"
                        onValueChange={providerId => {
                          setEditingConnection(true)
                          setConnectionDraft({ providerId })
                          setDiscovered(undefined)
                          setSelectedDraftModel(undefined)
                          setConnectionNotice(undefined)
                        }}
                        value={provider.id}
                      >
                        <SelectTrigger
                          className="h-10 w-full rounded-control bg-field shadow-inset-field hover:bg-field"
                          id="setup-provider"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="z-[90]">
                          {providers.map(item => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.id === 'custom'
                                ? `自定义 · ${item.protocol === 'openai-chat' ? 'OpenAI 兼容' : 'Anthropic Messages'}`
                                : item.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                    <FormField label="Base URL">
                      <TextInput
                        autoCapitalize="none"
                        autoComplete="off"
                        autoCorrect="off"
                        className="h-10 w-full"
                        disabled={Boolean(connectionBusy)}
                        name="baseUrl"
                        onChange={event =>
                          editConnection({
                            baseUrl: event.target.value,
                          })
                        }
                        placeholder="https://gateway.example/v1"
                        required
                        spellCheck={false}
                        type="url"
                        value={baseUrl}
                      />
                    </FormField>
                    <FormField label="API Key">
                      <TextInput
                        autoComplete="off"
                        className="h-10 w-full"
                        disabled={Boolean(connectionBusy)}
                        name="apiKey"
                        onChange={event =>
                          editConnection({
                            apiKey: event.target.value,
                          })
                        }
                        placeholder={
                          reuseKey ? '已保存，可输入新值替换' : '输入 API Key'
                        }
                        required={provider.requiresApiKey && !reuseKey}
                        type="password"
                        value={apiKey}
                      />
                    </FormField>
                    <div className="setup-connection-actions">
                      <Button
                        className="h-9 px-4 text-[13px]"
                        disabled={Boolean(connectionBusy)}
                        size="sm"
                        type="submit"
                        variant="secondary"
                      >
                        {connectionBusy === 'test' ? '测试中…' : '测试连接'}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] text-ink">
                      模型服务 · {routerProvider.name}
                    </span>
                    <Button
                      onClick={() => setEditingConnection(true)}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      更改模型连接
                    </Button>
                  </div>
                ))}
              {connectionNotice && (
                <p
                  className={
                    connectionNotice.kind === 'error'
                      ? 'settings-error rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]'
                      : 'setup-connection-ok'
                  }
                  role={connectionNotice.kind === 'error' ? 'alert' : 'status'}
                >
                  {connectionNotice.message}
                </p>
              )}
              <div className="grid gap-1.5" role="group" aria-label="默认模型">
                <span className="text-[13px] font-medium text-ink">
                  默认模型
                </span>
                <ModelPicker
                  ariaLabel="默认模型"
                  boundaryRef={setupBodyRef}
                  disabled={Boolean(connectionBusy)}
                  description={
                    showConnection
                      ? '当前连接返回的模型列表'
                      : '已配置模型服务的完整目录'
                  }
                  footer={
                    showConnection
                      ? '选好后保存连接和默认模型；保存前将验证模型可用性'
                      : '选择立即保存到服务端；模型变更只作用于新建执行会话'
                  }
                  models={
                    showConnection
                      ? draftModels
                      : models.length
                        ? models
                        : savedModel
                          ? [savedModel]
                          : []
                  }
                  onSelect={(_, model) => {
                    if (!model) return
                    if (showConnection) {
                      setSelectedDraftModel(model)
                      setConnectionNotice(undefined)
                    } else return onSelectModel?.(model)
                  }}
                  placeholder={
                    showConnection
                      ? draftModels.length
                        ? '选择默认模型'
                        : '请先测试连接，获取模型列表'
                      : (configuredModelId ?? '选择默认模型')
                  }
                  value={
                    showConnection
                      ? draftModel
                        ? modelSelectionKey(draftModel)
                        : ''
                      : configuredModel
                        ? modelSelectionKey(configuredModel)
                        : ''
                  }
                />
              </div>
              {showConnection && draftModels.length > 0 && (
                <Button
                  className="justify-self-end"
                  disabled={Boolean(connectionBusy)}
                  onClick={() => void probeConnection('save')}
                  size="sm"
                  type="button"
                  variant="primary"
                >
                  {connectionBusy === 'save' ? '保存中…' : '保存连接'}
                </Button>
              )}
              {!showConnection && !models.length && onReloadCatalog && (
                <Button
                  className="justify-self-start"
                  disabled={Boolean(connectionBusy)}
                  onClick={onReloadCatalog}
                  size="sm"
                  type="button"
                  variant="quiet"
                >
                  重新读取模型目录
                </Button>
              )}
            </div>
          )}
          {step === 2 && (
            <div className="runtime-choice">
              <Server size={20} />
              <div>
                <strong>隔离执行环境</strong>
                <small>具体运行时由服务端在执行时返回</small>
              </div>
              <span>待首次运行</span>
            </div>
          )}
          {step === 3 && (
            <div className="setup-points">
              <span>
                <Mic size={16} />
                可以先跳过语音配置
              </span>
              <span>
                <Check size={16} />
                完成后可以继续进入设置
              </span>
            </div>
          )}
        </div>
        <footer>
          {step > 0 ? (
            <Button
              className="h-9 px-4 text-[13px]"
              disabled={Boolean(connectionBusy)}
              onClick={() => setStep(currentStep => currentStep - 1)}
              type="button"

              size="sm"
              variant="secondary"
            >
              <ChevronLeft size={16} />
              上一步
            </Button>
          ) : (
            <Button
              className="h-9 px-4 text-[13px] text-ink-2"
              onClick={onComplete}
              type="button"
              size="sm"
              variant="quiet"
            >
              稍后设置
            </Button>
          )}
          {step === steps.length - 1 && (
            <Button
              className="h-9 px-4 text-[13px]"
              onClick={onContinueSettings}
              type="button"

              size="sm"
              variant="secondary"
            >
              继续设置
            </Button>
          )}
          <Button
            className="h-9 px-4 text-[13px]"
            disabled={
              Boolean(connectionBusy) ||
              (step === 1 && (showConnection || !configuredModel))
            }
            onClick={() =>
              step === steps.length - 1
                ? onComplete()
                : setStep(currentStep => currentStep + 1)
            }
            ref={primaryActionRef}
            type="button"

            size="sm"
            variant="primary"
          >
            {step === steps.length - 1 ? '进入 Pegas' : '继续'}{' '}
            <ArrowRight size={16} />
          </Button>
        </footer>
      </section>
    </div>
  )
}
