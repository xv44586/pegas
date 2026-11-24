import {
  ArrowRight,
  Check,
  ChevronLeft,
  Link2,
  LockKeyhole,
  Mic,
  Server,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@bui/index'

import type {
  DshModelCatalog,
  DshModelCatalogItem,
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
  onComplete,
  onContinueSettings,
}: {
  response?: SettingsResponse
  catalog?: DshModelCatalog
  onSelectModel?: (model: DshModelCatalogItem) => Promise<void>
  onSaveConnection?: (
    baseUrl: string,
    apiKey: string,
    modelName: string,
  ) => Promise<void>
  onTestConnection?: (
    baseUrl: string,
    apiKey: string,
    modelName: string,
  ) => Promise<{ ok: true; latencyMs: number }>
  onComplete: () => void
  onContinueSettings: () => void
}) {
  const [step, setStep] = useState(0)
  const [connectionDraft, setConnectionDraft] = useState({
    baseUrl: '',
    apiKey: '',
    modelName: '',
  })
  const [connectionBusy, setConnectionBusy] = useState<'test' | 'save'>()
  const [connectionNotice, setConnectionNotice] = useState<{
    kind: 'success' | 'error'
    message: string
  }>()
  const dialogRef = useRef<HTMLElement>(null)
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
      description: '模型连接与角色绑定分开管理；凭证只保存在服务端。',
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
  const routerProvider = response?.capabilities.providers.find(
    provider => provider.id === response.settings.modelProvider,
  )
  const connectionConfigured =
    Boolean(routerProvider?.available) &&
    (catalog === undefined || models.length > 0)
  const connectionCustom = routerProvider?.id === 'custom'
  const effectiveBaseUrl = connectionCustom
    ? connectionDraft.baseUrl
    : (routerProvider?.baseUrl ?? '')
  const effectiveModelName =
    [
      connectionDraft.modelName.trim(),
      response?.settings.modelName ?? '',
      routerProvider?.defaultModel ?? '',
    ].find(candidate => candidate !== '') ?? ''
  const probeModelPlaceholder =
    [routerProvider?.defaultModel.trim() ?? ''].find(
      candidate => candidate !== '',
    ) ?? '用于测试连接的模型 ID'
  const connectionReady =
    Boolean(effectiveBaseUrl) &&
    Boolean(effectiveModelName) &&
    (Boolean(routerProvider?.hasApiKey) ||
      Boolean(connectionDraft.apiKey.trim()))
  useEffect(() => {
    if (!routerProvider) return
    setConnectionDraft(current => ({
      baseUrl: current.baseUrl || routerProvider.baseUrl,
      apiKey: current.apiKey,
      modelName: current.modelName,
    }))
  }, [routerProvider?.baseUrl])
  async function probeConnection(kind: 'test' | 'save') {
    if (
      connectionBusy ||
      !connectionReady ||
      !onSaveConnection ||
      !onTestConnection
    )
      return
    setConnectionBusy(kind)
    setConnectionNotice(undefined)
    try {
      if (kind === 'test') {
        const result = await onTestConnection(
          effectiveBaseUrl,
          connectionDraft.apiKey.trim(),
          effectiveModelName,
        )
        setConnectionNotice({
          kind: 'success',
          message: `连接正常 · ${String(result.latencyMs)} ms`,
        })
      } else {
        await onTestConnection(
          effectiveBaseUrl,
          connectionDraft.apiKey.trim(),
          effectiveModelName,
        )
        await onSaveConnection(
          effectiveBaseUrl,
          connectionDraft.apiKey.trim(),
          effectiveModelName,
        )
        setConnectionDraft(current => ({ ...current, apiKey: '' }))
        setConnectionNotice({ kind: 'success', message: '连接已保存' })
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
  const configuredProvider =
    response?.settings.agentModelMode === 'override'
      ? response.settings.agentModelProvider
      : catalog?.defaultProvider
  const configuredModelId =
    response?.settings.agentModelMode === 'override'
      ? response.settings.agentModelName
      : catalog?.defaultModel
  const configuredModel = configuredModelId
    ? (models.find(
        model =>
          model.id === configuredModelId &&
          (!configuredProvider || model.provider === configuredProvider),
      ) ?? models.find(model => model.id === configuredModelId))
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
        <div className="setup-body">
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
              {!connectionConfigured &&
                onSaveConnection &&
                onTestConnection && (
                  <div
                    className="setup-connection"
                    role="group"
                    aria-label="模型连接配置"
                  >
                    <p className="setup-connection-hint">
                      <LockKeyhole size={15} />
                      尚未配置模型连接。填写服务地址与 API Key
                      并保存后，即可选择默认模型；凭证只保存在服务端。
                    </p>
                    <label>
                      服务地址
                      <input
                        autoComplete="off"
                        onChange={event =>
                          setConnectionDraft(current => ({
                            ...current,
                            baseUrl: event.target.value,
                          }))
                        }
                        placeholder="https://gateway.example/v1"
                        readOnly={!connectionCustom}
                        value={effectiveBaseUrl}
                      />
                    </label>
                    <label>
                      API Key
                      <input
                        autoComplete="off"
                        onChange={event =>
                          setConnectionDraft(current => ({
                            ...current,
                            apiKey: event.target.value,
                          }))
                        }
                        placeholder={
                          routerProvider?.hasApiKey
                            ? '已保存；填写新值可替换'
                            : '输入 API Key'
                        }
                        type="password"
                        value={connectionDraft.apiKey}
                      />
                    </label>
                    <label>
                      探测模型
                      <input
                        autoComplete="off"
                        onChange={event =>
                          setConnectionDraft(current => ({
                            ...current,
                            modelName: event.target.value,
                          }))
                        }
                        placeholder={probeModelPlaceholder}
                        value={connectionDraft.modelName}
                      />
                    </label>
                    <div className="setup-connection-actions">
                      <Button
                        className="h-9 px-4 text-[13px]"
                        disabled={Boolean(connectionBusy) || !connectionReady}
                        onClick={() => void probeConnection('test')}
                        type="button"

                        size="sm"
                        variant="secondary"
                      >
                        {connectionBusy === 'test' ? '测试中…' : '测试连接'}
                      </Button>
                      <Button
                        className="h-9 px-4 text-[13px]"
                        disabled={Boolean(connectionBusy) || !connectionReady}
                        onClick={() => void probeConnection('save')}
                        type="button"

                        size="sm"
                        variant="primary"
                      >
                        {connectionBusy === 'save' ? '保存中…' : '保存连接'}
                      </Button>
                    </div>
                    {connectionNotice && (
                      <p
                        className={
                          connectionNotice.kind === 'error'
                            ? 'settings-error'
                            : 'setup-connection-ok'
                        }
                        role={
                          connectionNotice.kind === 'error' ? 'alert' : 'status'
                        }
                      >
                        {connectionNotice.message}
                      </p>
                    )}
                  </div>
                )}
              <label>
                模型服务
                <input
                  disabled
                  value={
                    configuredModel?.provider ??
                    response?.capabilities.providers.find(
                      provider =>
                        provider.id === response.settings.modelProvider,
                    )?.name ??
                    '尚未连接'
                  }
                />
              </label>
              <div className="field-label">
                <span>默认模型</span>
                {onSelectModel ? (
                  <ModelPicker
                    ariaLabel="默认模型"
                    footer="选择立即保存到服务端；模型变更只作用于新建执行会话"
                    models={models}
                    onSelect={(_, model) => {
                      if (model) return onSelectModel(model)
                    }}
                    placeholder={
                      configuredModelId ??
                      (models.length ? '选择模型' : '服务端未提供可选模型')
                    }
                    value={
                      configuredModel ? modelSelectionKey(configuredModel) : ''
                    }
                  />
                ) : (
                  <input disabled value={configuredModelId ?? '服务端未提供'} />
                )}
              </div>
              <small>
                默认模型来自模型服务的完整目录；连接与凭证仍在设置中管理。
              </small>
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
