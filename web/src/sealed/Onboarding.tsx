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
import { useState } from 'react'

import type { SettingsResponse } from '../types'
import { PegasMark } from './PegasMark'

export function Onboarding({
  response,
  onComplete,
  onContinueSettings,
}: {
  response?: SettingsResponse
  onComplete: () => void
  onContinueSettings: () => void
}) {
  const [step, setStep] = useState(0)
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
  return (
    <div className="onboarding-backdrop">
      <section
        aria-labelledby="setup-title"
        className="onboarding-dialog"
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
                外部高风险操作执行前会请求确认
              </span>
            </div>
          )}
          {step === 1 && (
            <div className="setup-form">
              <label>
                模型服务
                <input
                  disabled
                  value={
                    response?.capabilities.providers.find(
                      provider =>
                        provider.id === response.settings.modelProvider,
                    )?.name ?? '尚未连接'
                  }
                />
              </label>
              <label>
                默认模型
                <input
                  disabled
                  value={response?.settings.modelName ?? '服务端未提供'}
                />
              </label>
              <small>模型连接将在设置中完成并保存到服务端。</small>
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
            <button
              className="secondary-button"
              onClick={() => setStep(currentStep => currentStep - 1)}
              type="button"
            >
              <ChevronLeft size={16} />
              上一步
            </button>
          ) : (
            <button className="quiet-button" onClick={onComplete} type="button">
              稍后设置
            </button>
          )}
          {step === steps.length - 1 && (
            <button
              className="secondary-button"
              onClick={onContinueSettings}
              type="button"
            >
              继续设置
            </button>
          )}
          <button
            className="primary-button"
            onClick={() =>
              step === steps.length - 1
                ? onComplete()
                : setStep(currentStep => currentStep + 1)
            }
            type="button"
          >
            {step === steps.length - 1 ? '进入 Pegas' : '继续'}{' '}
            <ArrowRight size={16} />
          </button>
        </footer>
      </section>
    </div>
  )
}
