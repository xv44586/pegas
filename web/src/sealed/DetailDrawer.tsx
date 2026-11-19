import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  Globe2,
  HardDrive,
  Image as ImageIcon,
  LockKeyhole,
  PauseCircle,
  Play,
  RotateCw,
  X,
} from 'lucide-react'
import { useEffect, useRef } from 'react'

import type { Run } from '../types'
import { formatRelativeTime, statusLabel, type DrawerView } from './types'

export function DetailDrawer({
  view,
  onClose,
  onRetry,
  onContinue,
}: {
  view: DrawerView
  onClose: () => void
  onChange: (view: DrawerView) => void
  onRetry: (run: Run) => Promise<void>
  onContinue?: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => closeRef.current?.focus(), [])
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={event => event.target === event.currentTarget && onClose()}
    >
      <aside
        aria-label={view.kind === 'task' ? '工作详情' : '详情'}
        className="detail-drawer"
      >
        <header className="drawer-header">
          <div>
            <small>{drawerEyebrow(view)}</small>
            <h2>{drawerTitle(view)}</h2>
          </div>
          <button
            aria-label="关闭详情"
            onClick={onClose}
            ref={closeRef}
            type="button"
          >
            <X size={20} />
          </button>
        </header>
        {view.kind === 'task' && (
          <TaskDetail
            channel={view.channel}
            onContinue={onContinue}
            onRetry={onRetry}
            run={view.run}
            usage={view.usage}
          />
        )}
        {view.kind === 'runtime' && <RuntimeDetail run={view.run} />}
        {view.kind === 'rule' && <RuleDetail title={view.title} />}
        {view.kind === 'preview' && <PreviewDetail view={view} />}
      </aside>
    </div>
  )
}

function drawerEyebrow(view: DrawerView): string {
  if (view.kind === 'task') return '工作详情'
  if (view.kind === 'runtime') return 'Pegas'
  if (view.kind === 'rule') return '行为与规则'
  return '内容预览'
}
function drawerTitle(view: DrawerView): string {
  if (view.kind === 'task') return view.channel.title
  if (view.kind === 'runtime') return '执行环境详情'
  if (view.kind === 'rule') return view.title
  return view.title
}

function TaskDetail({
  channel,
  run,
  usage,
  onRetry,
  onContinue,
}: {
  channel: Extract<DrawerView, { kind: 'task' }>['channel']
  run?: Run
  usage?: Extract<DrawerView, { kind: 'task' }>['usage']
  onRetry: (run: Run) => Promise<void>
  onContinue?: () => void
}) {
  const state = statusLabel(channel, run)
  return (
    <div className="drawer-body">
      <section className={`state-hero state-${state}`}>
        <span>{stateIcon(state)}</span>
        <div>
          <small>{state}</small>
          <h3>{stateHeadline(state)}</h3>
          <p>{stateDescription(state, run)}</p>
        </div>
      </section>
      {state === '失败' && (
        <section className="failure-card">
          <header>
            <AlertTriangle size={19} />
            <strong>执行已停止</strong>
          </header>
          <p>{run?.lastError ?? '服务端没有提供失败原因。'}</p>
          <small>重试会创建新的运行记录；既有记录会保留。</small>
        </section>
      )}
      <section className="detail-section">
        <h3>运行记录</h3>
        <ol className="progress-list">
          <li className="is-done">
            <CheckCircle2 size={14} />
            <span>
              <strong>事情已创建</strong>
              <small>{formatRelativeTime(channel.createdAt)}</small>
            </span>
          </li>
          {run ? (
            <li className={runProgressClass(state)}>
              {runProgressIcon(state)}
              <span>
                <strong>Run · {run.id.slice(0, 8)}</strong>
                <small>
                  {state} · {formatRelativeTime(run.updatedAt)}
                </small>
              </span>
            </li>
          ) : (
            <li>
              <Clock3 size={14} />
              <span>
                <strong>等待运行记录</strong>
                <small>服务端尚未返回 Run</small>
              </span>
            </li>
          )}
        </ol>
      </section>
      {usage && (
        <section className="detail-section metadata-list">
          <h3>本次用量</h3>
          <dl>
            <Meta label="Token" value={formatNumber(usage.totalTokens)} />
            <Meta label="耗时" value={formatDuration(usage.durationMs)} />
            <Meta label="费用" value={formatCost(usage.costUsd)} />
          </dl>
        </section>
      )}
      <section className="detail-section metadata-list">
        <h3>执行信息</h3>
        <dl>
          <Meta label="Executor" value={run?.executor} />
          <Meta label="模型" value={run?.executionContext?.model} />
          <Meta label="工作区" value={run?.executionContext?.workspace} />
          <Meta
            label="更新"
            value={formatRelativeTime(run?.updatedAt ?? channel.updatedAt)}
          />
        </dl>
      </section>
      <footer className="drawer-footer">
        {state === '失败' && run ? (
          <button
            className="primary-button"
            onClick={() => void onRetry(run)}
            type="button"
          >
            <RotateCw size={16} />
            重试
          </button>
        ) : state === '进行中' ? (
          <>
            <button
              className="secondary-button"
              disabled
              title="服务端暂停 API 尚未提供"
              type="button"
            >
              <PauseCircle size={16} />
              暂停
            </button>
            <button
              className="primary-button"
              disabled
              title="服务端纠正 API 尚未提供"
              type="button"
            >
              纠正方向
            </button>
          </>
        ) : state === '已完成' ? (
          <button className="primary-button" onClick={onContinue} type="button">
            继续追问
          </button>
        ) : (
          <span className="drawer-footnote">等待服务端返回下一步条件。</span>
        )}
      </footer>
    </div>
  )
}

function Meta({ label, value }: { label: string; value?: string }) {
  const displayValue = value?.trim()
  return (
    <div>
      <dt>{label}</dt>
      <dd>{displayValue?.length ? displayValue : '服务端未提供'}</dd>
    </div>
  )
}
function formatNumber(value?: number) {
  return value === undefined
    ? undefined
    : new Intl.NumberFormat('zh-CN').format(value)
}
function formatDuration(value?: number) {
  return value === undefined
    ? undefined
    : `${String(Math.round(value / 1000))} 秒`
}
function formatCost(value?: number) {
  return value === undefined ? undefined : `$${value.toFixed(4)}`
}
function stateIcon(state: string) {
  if (state === '已完成') return <CheckCircle2 size={24} />
  if (state === '失败') return <AlertTriangle size={24} />
  if (state === '进行中') return <RotateCw size={24} />
  return <Clock3 size={24} />
}
function runProgressClass(state: string) {
  if (state === '已完成') return 'is-done'
  if (state === '失败') return 'is-failed'
  if (state === '进行中') return 'is-current'
  return 'is-waiting'
}
function runProgressIcon(state: string) {
  if (state === '已完成') return <CheckCircle2 size={14} />
  if (state === '失败') return <AlertTriangle size={14} />
  return <Clock3 size={14} />
}
function stateHeadline(state: string): string {
  if (state === '已完成') return '工作已完成'
  if (state === '失败') return '执行失败，记录已保留'
  if (state === '进行中') return 'Pegas 正在推进这件事'
  if (state === '已归档') return '这件事已归档'
  return '等待下一步条件'
}
function stateDescription(state: string, run?: Run): string {
  if (state === '已完成')
    return run?.output
      ? `${run.output.slice(0, 260)}${run.output.length > 260 ? '…' : ''}`
      : '服务端没有提供结果摘要。'
  if (state === '失败') return '查看服务端返回的原因后，可以创建一次重试。'
  if (state === '进行中') return '离开页面不会中断执行；状态由服务端持续保存。'
  if (state === '已归档') return '归档内容仍保留在服务端。'
  return '上下文已保存，服务端尚未返回可执行的下一步。'
}

function RuntimeDetail({ run }: { run?: Run }) {
  return (
    <div className="drawer-body">
      <section className="runtime-identity">
        <HardDrive size={23} />
        <div>
          <strong>{run?.executor ?? '执行环境'}</strong>
          <small>服务端运行快照</small>
        </div>
        <span>{run?.status ?? '暂无运行'}</span>
      </section>
      <section className="metadata-list">
        <dl>
          <Meta label="Executor" value={run?.executor} />
          <Meta
            label="Worker Profile"
            value={run?.executionContext?.workerProfile}
          />
          <Meta label="模型" value={run?.executionContext?.model} />
          <Meta label="工作区" value={run?.executionContext?.workspace} />
          <Meta label="Executor Ref" value={run?.executorRef} />
          <Meta label="Resume Ref" value={run?.resumeFromRef} />
        </dl>
      </section>
      <div className="info-banner">
        <LockKeyhole size={16} />
        这里只展示服务端已记录的执行快照；未返回的字段不会推断。
      </div>
    </div>
  )
}

function RuleDetail({ title }: { title: string }) {
  return (
    <div className="drawer-body">
      <div className="info-banner">
        <LockKeyhole size={16} />
        规则服务尚未提供服务端事实来源；此界面仅展示封板结构。
      </div>
      <label className="field-label">
        规则名称
        <input disabled value={title} />
      </label>
      <label className="field-label">
        规则内容
        <textarea disabled placeholder="服务端未提供" rows={7} />
      </label>
      <footer className="drawer-footer">
        <button className="primary-button" disabled type="button">
          保存规则
        </button>
      </footer>
    </div>
  )
}

function PreviewDetail({
  view,
}: {
  view: Extract<DrawerView, { kind: 'preview' }>
}) {
  const Icon =
    view.preview === 'image'
      ? ImageIcon
      : view.preview === 'web'
        ? Globe2
        : view.preview === 'video'
          ? Play
          : FileText
  return (
    <div className="drawer-body">
      <div className={`${view.preview}-preview preview-placeholder`}>
        <Icon size={48} />
        <h3>{view.title}</h3>
        <p>{view.description ?? '服务端没有提供可渲染的预览内容。'}</p>
      </div>
      <section className="metadata-list">
        <dl>
          <Meta label="类型" value={view.mimeType} />
          <Meta label="来源" value={view.source} />
        </dl>
      </section>
      {view.url && (
        <footer className="drawer-footer">
          <a
            className="primary-button"
            href={view.url}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink size={16} />
            打开来源
          </a>
        </footer>
      )}
    </div>
  )
}
