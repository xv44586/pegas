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
  Play,
  RotateCw,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type {
  DurableAction,
  GoalContract,
  ReviewCriterionPreview,
  ReviewEvidencePreview,
  ReviewProjection,
  Run,
  TaskDelivery,
} from '../types'
import { PegasMascot } from './PegasMascot'
import {
  formatRelativeTime,
  runStatusLabel,
  statusLabel,
  textFromPayload,
  type DrawerView,
} from './types'

export function DetailDrawer({
  view,
  onClose,
  onChange,
  onOpenView,
  onRetry,
  onContinue,
  onStop,
  onDecideApproval,
  onReconcileAction,
}: {
  view: DrawerView
  onClose: () => void
  onChange: (view: DrawerView) => void
  onOpenView?: (view: DrawerView) => void
  onRetry: (run: Run) => Promise<void>
  onContinue?: (
    channel: Extract<DrawerView, { kind: 'task' }>['channel'],
  ) => void
  onStop?: (
    channel: Extract<DrawerView, { kind: 'task' }>['channel'],
  ) => Promise<void>
  onDecideApproval?: (
    approvalId: string,
    optionId: string,
    rationale?: string,
  ) => Promise<void>
  onReconcileAction?: (
    actionId: string,
    resolution: 'succeeded' | 'failed',
    note: string,
  ) => Promise<void>
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    closeRef.current?.focus()
    const containFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
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
    return () => document.removeEventListener('keydown', containFocus)
  }, [])
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={event => event.target === event.currentTarget && onClose()}
    >
      <aside
        aria-modal="true"
        aria-label={
          view.kind === 'task'
            ? '工作详情'
            : view.kind === 'message'
              ? '消息详情'
              : '详情'
        }
        className="detail-drawer"
        ref={drawerRef}
        role="dialog"
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
            delivery={view.delivery}
            deliveryError={view.deliveryError}
            onContinue={onContinue}
            onOpenEvidence={
              onOpenView
                ? evidence => onOpenView(evidencePreviewView(evidence))
                : undefined
            }
            onRetry={onRetry}
            onStop={onStop}
            run={view.run}
            runs={view.runs}
            timeline={view.timeline}
            timelineError={view.timelineError}
            usage={view.usage}
          />
        )}
        {view.kind === 'message' && <MessageDetail view={view} />}
        {view.kind === 'approval' && (
          <ApprovalDetail
            key={`${view.approval.id}:${view.approval.decision?.id ?? view.approval.status}`}
            onDecide={onDecideApproval}
            onReconcile={onReconcileAction}
            view={view}
          />
        )}
        {view.kind === 'reconciliation' && (
          <ReconciliationDetail
            key={`${view.action.id}:${view.action.reconciliation?.id ?? view.action.status}`}
            action={view.action}
            onReconcile={onReconcileAction}
          />
        )}
        {view.kind === 'review' && (
          <ReviewDetail
            goal={view.goal}
            onOpenEvidence={
              onOpenView
                ? evidence => onOpenView(evidencePreviewView(evidence))
                : undefined
            }
            onOpenTask={
              onOpenView
                ? () =>
                    onOpenView({
                      kind: 'task',
                      channel: view.channel,
                    })
                : undefined
            }
            review={view.review}
          />
        )}
        {view.kind === 'clarification' && (
          <ClarificationDetail
            onAnswer={
              onContinue
                ? () => {
                    onContinue(view.channel)
                    onClose()
                  }
                : undefined
            }
            onOpenTask={
              onOpenView
                ? () =>
                    onOpenView({
                      kind: 'task',
                      channel: view.channel,
                    })
                : undefined
            }
            questions={view.questions}
          />
        )}
        {view.kind === 'runtime' && <RuntimeDetail run={view.run} />}
        {view.kind === 'rule' && <RuleDetail title={view.title} />}
        {view.kind === 'preview' && (
          <PreviewDetail
            onBack={view.backLabel ? () => onChange(view) : undefined}
            view={view}
          />
        )}
      </aside>
    </div>
  )
}

function drawerEyebrow(view: DrawerView): string {
  if (view.kind === 'task') return '工作详情'
  if (view.kind === 'message') return '待你处理'
  if (view.kind === 'approval') return '需要确认'
  if (view.kind === 'reconciliation') return '需要核对'
  if (view.kind === 'review') return '交付审查'
  if (view.kind === 'clarification') return '需要补充'
  if (view.kind === 'runtime') return 'Pegas'
  if (view.kind === 'rule') return '行为与规则'
  return '内容预览'
}
function drawerTitle(view: DrawerView): string {
  if (view.kind === 'task') return view.channel.title
  if (view.kind === 'message') return 'Pegas 消息'
  if (view.kind === 'approval') return view.approval.prompt.summary
  if (view.kind === 'reconciliation') return '核对动作的真实结果'
  if (view.kind === 'review') return '按完成标准审查交付'
  if (view.kind === 'clarification') return view.channel.title
  if (view.kind === 'runtime') return '执行环境详情'
  if (view.kind === 'rule') return view.title
  return view.title
}

function ApprovalDetail({
  view,
  onDecide,
  onReconcile,
}: {
  view: Extract<DrawerView, { kind: 'approval' }>
  onDecide?: (
    approvalId: string,
    optionId: string,
    rationale?: string,
  ) => Promise<void>
  onReconcile?: (
    actionId: string,
    resolution: 'succeeded' | 'failed',
    note: string,
  ) => Promise<void>
}) {
  const pending = view.approval.status === 'pending'
  const [selected, setSelected] = useState(
    pending
      ? view.approval.prompt.recommendedOptionId
      : (view.approval.decision?.optionId ??
          view.approval.prompt.recommendedOptionId),
  )
  const [rationale, setRationale] = useState(
    pending ? '' : (view.approval.decision?.rationale ?? ''),
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const needsReconciliation =
    Boolean(onReconcile) &&
    !view.action.reconciliation &&
    (view.action.status === 'unknown' || view.action.status === 'failed')

  async function submitDecision() {
    if (!onDecide || !pending || submitting) return
    setSubmitting(true)
    setError('')
    try {
      await onDecide(view.approval.id, selected, rationale)
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : '提交决定失败，请重试。',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="drawer-body">
      <section className="approval-card">
        <header>
          {pending ? (
            <PegasMascot label="Pegas 等待你的决定" pose="blocked" size={40} />
          ) : (
            <ShieldCheck size={20} />
          )}
          <strong>{view.approval.prompt.summary}</strong>
        </header>
        <p>{view.approval.prompt.impact}</p>
        <dl>
          <Meta label="状态" value={approvalStatus(view.approval.status)} />
          <Meta label="Action" value={actionStatus(view.action.status)} />
          <Meta label="Run" value={view.approval.requestRunId} />
        </dl>
        {view.action.result && (
          <pre className="approval-result">
            {JSON.stringify(view.action.result, null, 2)}
          </pre>
        )}
        <ReconciliationRecord action={view.action} />
      </section>
      {needsReconciliation && onReconcile && (
        <ReconciliationForm action={view.action} onReconcile={onReconcile} />
      )}
      <section className="detail-section">
        <fieldset className="approval-options">
          <legend>你的决定</legend>
          {view.approval.prompt.options.map(option => (
            <label className="approval-option" key={option.id}>
              <input
                checked={selected === option.id}
                disabled={!pending || submitting}
                name={`approval-${view.approval.id}`}
                onChange={() => setSelected(option.id)}
                type="radio"
              />
              <span>
                <strong>
                  {option.label}
                  {option.id === view.approval.prompt.recommendedOptionId
                    ? ' · 建议'
                    : ''}
                </strong>
                {option.description && <small>{option.description}</small>}
              </span>
            </label>
          ))}
        </fieldset>
        <label className="approval-rationale">
          <span>补充说明（可选）</span>
          <textarea
            disabled={!pending || submitting}
            onChange={event => setRationale(event.target.value)}
            placeholder="告诉 Pegas 需要注意什么"
            value={rationale}
          />
        </label>
        {(error || view.decisionError) && (
          <p className="settings-error" role="alert">
            {error || view.decisionError}
          </p>
        )}
      </section>
      <footer className="drawer-footer">
        {pending && onDecide ? (
          <button
            className="primary-button"
            disabled={submitting}
            onClick={() => void submitDecision()}
            type="button"
          >
            {submitting ? '正在提交…' : '提交决定'}
          </button>
        ) : (
          <span className="drawer-footnote">
            {approvalFootnote(view.approval.status)}
          </span>
        )}
      </footer>
    </div>
  )
}

function approvalFootnote(
  status: Extract<DrawerView, { kind: 'approval' }>['approval']['status'],
): string {
  if (status === 'cancelled') return '此请求已取消，不会继续执行。'
  if (status === 'rejected') return '已拒绝执行此动作。'
  if (status === 'revision_requested') return '已要求修改，Pegas 会重新规划。'
  if (status === 'approved') return '决定已保存，Pegas 会从持久恢复点继续。'
  return '决定已记录，正在恢复执行状态。'
}

function ReconciliationRecord({ action }: { action: DurableAction }) {
  if (!action.reconciliation) return null
  return (
    <div className="reconciliation-record">
      <strong>
        人工核对：
        {action.reconciliation.resolution === 'succeeded'
          ? '确认已成功'
          : '确认已失败'}
      </strong>
      <p>{action.reconciliation.note}</p>
      <small>
        核对前状态：
        {action.reconciliation.previousStatus === 'unknown'
          ? '结果未知'
          : '执行失败'}
      </small>
    </div>
  )
}

function ReconciliationForm({
  action,
  onReconcile,
}: {
  action: DurableAction
  onReconcile: (
    actionId: string,
    resolution: 'succeeded' | 'failed',
    note: string,
  ) => Promise<void>
}) {
  const [resolution, setResolution] = useState<'succeeded' | 'failed'>(
    'succeeded',
  )
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (submitting || !note.trim()) return
    setSubmitting(true)
    setError('')
    try {
      await onReconcile(action.id, resolution, note.trim())
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : '提交核对结论失败，请重试。',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="detail-section">
      <fieldset className="approval-options">
        <legend>人工核对结论</legend>
        <p className="reconciliation-hint">
          这个动作的外部结果
          {action.status === 'unknown' ? '未知' : '被记录为失败'}
          。请先在外部系统核实真实结果，再选择结论；结论会永久记录并决定是否允许继续。
        </p>
        <label className="approval-option">
          <input
            checked={resolution === 'succeeded'}
            disabled={submitting}
            name={`reconcile-${action.id}`}
            onChange={() => setResolution('succeeded')}
            type="radio"
          />
          <span>
            <strong>确认已成功</strong>
            <small>外部副作用实际已发生，允许 Pegas 继续后续工作</small>
          </span>
        </label>
        <label className="approval-option">
          <input
            checked={resolution === 'failed'}
            disabled={submitting}
            name={`reconcile-${action.id}`}
            onChange={() => setResolution('failed')}
            type="radio"
          />
          <span>
            <strong>确认已失败</strong>
            <small>外部副作用没有发生，保持失败事实并继续阻塞重试</small>
          </span>
        </label>
      </fieldset>
      <label className="approval-rationale">
        <span>核对依据（必填）</span>
        <textarea
          disabled={submitting}
          maxLength={2000}
          onChange={event => setNote(event.target.value)}
          placeholder="例如：已在银行 App 查到转账记录，金额与时间一致"
          value={note}
        />
      </label>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="primary-button"
        disabled={submitting || !note.trim()}
        onClick={() => void submit()}
        type="button"
      >
        {submitting ? '正在提交…' : '提交核对结论'}
      </button>
    </section>
  )
}

function ReconciliationDetail({
  action,
  onReconcile,
}: {
  action: DurableAction
  onReconcile?: (
    actionId: string,
    resolution: 'succeeded' | 'failed',
    note: string,
  ) => Promise<void>
}) {
  const needsReconciliation =
    Boolean(onReconcile) &&
    !action.reconciliation &&
    (action.status === 'unknown' || action.status === 'failed')
  return (
    <div className="drawer-body">
      <section className="approval-card">
        <header>
          <ShieldCheck size={20} />
          <strong>高风险动作需要人工核对</strong>
        </header>
        <p>
          Pegas 已记录这个动作的执行结果，但无法确定外部系统的真实状态。
          请核实后提交结论，Pegas 才会决定是否继续。
        </p>
        <dl>
          <Meta label="动作类型" value={action.kind} />
          <Meta label="Action" value={actionStatus(action.status)} />
          <Meta label="Run" value={action.requestRunId} />
        </dl>
        <pre className="approval-result">
          {JSON.stringify(action.request, null, 2)}
        </pre>
        {action.result && (
          <pre className="approval-result">
            {JSON.stringify(action.result, null, 2)}
          </pre>
        )}
        <ReconciliationRecord action={action} />
      </section>
      {needsReconciliation && onReconcile && (
        <ReconciliationForm action={action} onReconcile={onReconcile} />
      )}
      {!needsReconciliation && !action.reconciliation && (
        <footer className="drawer-footer">
          <span className="drawer-footnote">
            当前状态无需人工核对；如有疑问请查看事情详情。
          </span>
        </footer>
      )}
    </div>
  )
}

function actionStatus(status: DurableAction['status']): string {
  const labels = {
    awaiting_approval: '等待授权',
    authorized: '已授权，等待结果',
    rejected: '未授权',
    succeeded: '执行成功',
    failed: '执行失败',
    unknown: '结果未知，需核对',
    reconciled: '已人工核对',
  } satisfies Record<DurableAction['status'], string>
  return labels[status]
}

function approvalStatus(
  status: Extract<DrawerView, { kind: 'approval' }>['approval']['status'],
) {
  const labels: Record<typeof status, string> = {
    pending: '等待决定',
    decision_recorded: '决定已记录',
    approved: '已批准',
    rejected: '已拒绝',
    revision_requested: '需要修改',
    cancelled: '已取消',
  }
  return labels[status]
}

function MessageDetail({
  view,
}: {
  view: Extract<DrawerView, { kind: 'message' }>
}) {
  const text = textFromPayload(view.message.payload)
  return (
    <div className="drawer-body">
      <section className="detail-section">
        <h3>消息内容</h3>
        <p>{text || '服务端没有提供消息正文。'}</p>
      </section>
      <section className="detail-section metadata-list">
        <h3>消息信息</h3>
        <dl>
          <Meta label="来源" value="Pegas" />
          <Meta label="投递状态" value={view.message.status} />
          <Meta
            label="创建时间"
            value={formatRelativeTime(view.message.createdAt)}
          />
        </dl>
      </section>
      <div className="info-banner">
        <LockKeyhole size={16} />
        此消息没有关联事情；这里只展示服务端保存的原始消息。
      </div>
    </div>
  )
}

function TaskDetail({
  channel,
  delivery,
  deliveryError,
  run,
  runs,
  timeline,
  timelineError,
  usage,
  onOpenEvidence,
  onRetry,
  onContinue,
  onStop,
}: {
  channel: Extract<DrawerView, { kind: 'task' }>['channel']
  delivery?: TaskDelivery
  deliveryError?: string
  run?: Run
  runs?: Run[]
  timeline?: Extract<DrawerView, { kind: 'task' }>['timeline']
  timelineError?: string
  usage?: Extract<DrawerView, { kind: 'task' }>['usage']
  onOpenEvidence?: (evidence: ReviewEvidencePreview) => void
  onRetry: (run: Run) => Promise<void>
  onContinue?: (
    channel: Extract<DrawerView, { kind: 'task' }>['channel'],
  ) => void
  onStop?: (
    channel: Extract<DrawerView, { kind: 'task' }>['channel'],
  ) => Promise<void>
}) {
  const state = statusLabel(channel, run)
  const runHistory = (runs ?? (run ? [run] : [])).toSorted(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  )
  const timelineItems = [
    ...(timeline?.events.map(event => ({
      id: `event-${event.id}`,
      at: event.createdAt,
      role: '你',
      text: textFromPayload(event.payload),
    })) ?? []),
    ...(timeline?.messages.map(message => ({
      id: `message-${message.id}`,
      at: message.createdAt,
      role: 'Pegas',
      text: textFromPayload(message.payload),
    })) ?? []),
  ]
    .filter(item => item.text)
    .toSorted((left, right) => Date.parse(left.at) - Date.parse(right.at))
  const [confirmingStop, setConfirmingStop] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState('')
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  const [expandedTimeline, setExpandedTimeline] = useState<Set<string>>(
    () => new Set(),
  )

  async function retryRun() {
    if (!run || retrying) return
    setRetrying(true)
    setRetryError('')
    try {
      await onRetry(run)
    } catch (caught) {
      setRetryError(
        caught instanceof Error ? caught.message : '重试失败，请稍后再试。',
      )
    } finally {
      setRetrying(false)
    }
  }

  async function stopChannel() {
    if (!onStop || stopping) return
    setStopping(true)
    setStopError('')
    try {
      await onStop(channel)
      setConfirmingStop(false)
    } catch (caught) {
      setStopError(
        caught instanceof Error ? caught.message : '停止失败，请稍后重试。',
      )
    } finally {
      setStopping(false)
    }
  }

  return (
    <div className="drawer-body">
      <section className={`state-hero state-${state}`}>
        <span>{stateIcon(state)}</span>
        <div>
          <small>{state}</small>
          <h3>{stateHeadline(state)}</h3>
          <p>
            {state === '已完成' && run?.output
              ? summaryExpanded
                ? run.output
                : stateDescription(state, run)
              : stateDescription(state, run)}
          </p>
          {state === '已完成' && run?.output && run.output.length > 260 && (
            <button
              className="inline-link"
              onClick={() => setSummaryExpanded(current => !current)}
              type="button"
            >
              {summaryExpanded ? '收起结果' : '展开完整结果'}
            </button>
          )}
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
          {retryError && <small role="alert">{retryError}</small>}
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
          {runHistory.length ? (
            runHistory.map((historyRun, index) => {
              const historyState = runStatusLabel(historyRun)
              return (
                <li
                  className={runProgressClass(historyState)}
                  key={historyRun.id}
                >
                  {runProgressIcon(historyState)}
                  <span>
                    <strong>
                      {runHistory.length === 1
                        ? `Run · ${historyRun.id.slice(0, 8)}`
                        : `Run ${String(index + 1)} · ${historyRun.id.slice(0, 8)}`}
                    </strong>
                    <small>
                      {historyState} ·{' '}
                      {formatRelativeTime(historyRun.updatedAt)}
                    </small>
                    {runHistory.length > 1 && historyRun.lastError && (
                      <small>{historyRun.lastError}</small>
                    )}
                  </span>
                </li>
              )
            })
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
      {(delivery?.goal ?? delivery?.reviewPack ?? deliveryError) && (
        <DeliverySection
          delivery={delivery}
          error={deliveryError}
          onOpenEvidence={onOpenEvidence}
        />
      )}
      <section className="detail-section">
        <h3>Channel 时间线</h3>
        {timelineError ? (
          <p className="settings-error" role="alert">
            {timelineError}
          </p>
        ) : timelineItems.length ? (
          <ol className="drawer-timeline">
            {timelineItems.map(item => (
              <li key={item.id}>
                <strong>{item.role}</strong>
                <p>
                  {item.text.length > 520 && !expandedTimeline.has(item.id)
                    ? `${item.text.slice(0, 520)}…`
                    : item.text}
                </p>
                {item.text.length > 520 && (
                  <button
                    className="inline-link"
                    onClick={() =>
                      setExpandedTimeline(current => {
                        const next = new Set(current)
                        if (next.has(item.id)) next.delete(item.id)
                        else next.add(item.id)
                        return next
                      })
                    }
                    type="button"
                  >
                    {expandedTimeline.has(item.id)
                      ? '收起'
                      : item.role === '你'
                        ? '展开完整消息'
                        : '展开完整回复'}
                  </button>
                )}
                <small>{formatRelativeTime(item.at)}</small>
              </li>
            ))}
          </ol>
        ) : (
          <p className="drawer-footnote">正在读取这件事的完整时间线。</p>
        )}
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
          <ExecutionProfileMeta run={run} />
          <Meta label="工作区" value={run?.executionContext?.workspace} />
          <Meta
            label="更新"
            value={formatRelativeTime(run?.updatedAt ?? channel.updatedAt)}
          />
        </dl>
      </section>
      {confirmingStop && (
        <section
          aria-labelledby="stop-confirmation-title"
          className="stop-confirmation"
          role="alertdialog"
        >
          <header>
            <AlertTriangle size={18} />
            <strong id="stop-confirmation-title">确定停止这件事？</strong>
          </header>
          <p>停止后无法继续当前运行；历史记录会保留，你仍可重新发起事情。</p>
          {stopError && <small role="alert">{stopError}</small>}
          <div className="drawer-actions">
            <button
              className="secondary-button"
              disabled={stopping}
              onClick={() => setConfirmingStop(false)}
              type="button"
            >
              取消
            </button>
            <button
              className="danger-button"
              disabled={stopping}
              onClick={() => void stopChannel()}
              type="button"
            >
              {stopping ? '正在停止…' : '确认停止'}
            </button>
          </div>
        </section>
      )}
      <footer className="drawer-footer">
        {state === '失败' && run && (
          <button
            className="secondary-button"
            disabled={retrying}
            onClick={() => void retryRun()}
            type="button"
          >
            <RotateCw size={16} />
            {retrying ? '正在重试…' : '重试'}
          </button>
        )}
        {channel.status !== 'cancelled' && onContinue && (
          <button
            className="primary-button"
            onClick={() => onContinue(channel)}
            type="button"
          >
            继续追问
          </button>
        )}
        {channel.canStop && onStop && (
          <button
            className="danger-button"
            onClick={() => setConfirmingStop(true)}
            type="button"
          >
            停止事情
          </button>
        )}
        {channel.status === 'cancelled' && (
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

function evidencePreviewView(
  evidence: ReviewEvidencePreview,
): Extract<DrawerView, { kind: 'preview' }> {
  const mime = evidence.artifact?.mimeType ?? ''
  const preview =
    evidence.kind === 'screenshot' ||
    evidence.kind === 'render' ||
    evidence.kind === 'keyframe' ||
    mime.startsWith('image/')
      ? 'image'
      : evidence.kind === 'video' || mime.startsWith('video/')
        ? 'video'
        : evidence.kind === 'webpage' || mime === 'text/html'
          ? 'web'
          : 'file'
  return {
    kind: 'preview',
    preview,
    title: evidence.artifact?.name ?? `证据 ${evidence.evidenceId.slice(0, 8)}`,
    description: evidence.limitations.join('；') || undefined,
    mimeType: mime || undefined,
    source: `验证：${verificationLabel(evidence.verification)} · 敏感级：${evidence.sensitivity}`,
    url: evidence.artifact?.uri,
    backLabel: '返回交付审查',
    contentUrl: evidence.hasContent
      ? `/v1/evidence/${encodeURIComponent(evidence.evidenceId)}/content?userId=owner`
      : undefined,
  }
}

function verificationLabel(result: ReviewEvidencePreview['verification']) {
  if (result === 'passed') return '已通过'
  if (result === 'failed') return '未通过'
  return '待验证'
}

function completionLabel(
  status: ReviewCriterionPreview['completionStatus'],
): string {
  if (status === 'satisfied') return '已满足'
  if (status === 'partial') return '部分满足'
  if (status === 'failed') return '未满足'
  return '未验证'
}

function outcomeLabel(outcome: ReviewProjection['finalOutcome']): string {
  if (outcome === 'completed') return '目标已完成'
  if (outcome === 'partial') return '部分完成'
  return '未达成'
}

function EvidenceGallery({
  evidence,
  onOpenEvidence,
}: {
  evidence: ReviewEvidencePreview[]
  onOpenEvidence?: (evidence: ReviewEvidencePreview) => void
}) {
  if (!evidence.length)
    return <p className="drawer-footnote">本次交付没有可展示的证据。</p>
  return (
    <ul aria-label="证据画廊" className="evidence-gallery">
      {evidence.map(item => (
        <li key={item.evidenceId}>
          <button
            className="evidence-card"
            onClick={() => onOpenEvidence?.(item)}
            type="button"
          >
            <span className={`evidence-thumb is-${item.verification}`}>
              {item.hasContent &&
              (item.kind === 'screenshot' ||
                item.kind === 'render' ||
                item.kind === 'keyframe' ||
                item.artifact?.mimeType?.startsWith('image/')) ? (
                <EvidenceThumb
                  alt={item.artifact?.name ?? '证据缩略图'}
                  url={`/v1/evidence/${encodeURIComponent(item.evidenceId)}/content?userId=owner`}
                />
              ) : item.artifact?.mimeType?.startsWith('video/') ||
                item.kind === 'video' ? (
                <Play size={26} />
              ) : (
                <FileText size={26} />
              )}
            </span>
            <span className="evidence-copy">
              <strong>
                {item.artifact?.name ?? `证据 ${item.evidenceId.slice(0, 8)}`}
              </strong>
              <small>
                {verificationLabel(item.verification)}
                {item.viewport
                  ? ` · ${String(item.viewport.width)}×${String(item.viewport.height)}`
                  : ''}
                {typeof item.timecode === 'number'
                  ? ` · ${String(item.timecode)}s`
                  : ''}
              </small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function CriteriaList({
  criteria,
  statements,
}: {
  criteria: ReviewCriterionPreview[]
  statements?: Map<string, string>
}) {
  return (
    <ol aria-label="完成标准" className="criteria-list">
      {criteria.map(criterion => (
        <li key={criterion.criterionId}>
          <span className={`criteria-status is-${criterion.completionStatus}`}>
            {completionLabel(criterion.completionStatus)}
          </span>
          <div>
            <strong>
              {statements?.get(criterion.criterionId) ?? criterion.criterionId}
            </strong>
            <p>{criterion.explanation}</p>
            {criterion.limitations.length > 0 && (
              <small>局限：{criterion.limitations.join('；')}</small>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

function DeliverySection({
  delivery,
  error,
  onOpenEvidence,
}: {
  delivery?: TaskDelivery
  error?: string
  onOpenEvidence?: (evidence: ReviewEvidencePreview) => void
}) {
  const goal = delivery?.goal
  const pack = delivery?.reviewPack
  const statements = new Map(
    goal?.successCriteria.map(criterion => [
      criterion.criterionId,
      criterion.observableStatement,
    ]) ?? [],
  )
  const artifactsById = new Map(
    delivery?.artifacts.map(artifact => [artifact.id, artifact]) ?? [],
  )
  const evidencePreviews: ReviewEvidencePreview[] = (
    delivery?.evidence ?? []
  ).map(item => {
    const artifact = item.artifactId
      ? artifactsById.get(item.artifactId)
      : undefined
    return {
      evidenceId: item.id,
      criterionId: item.criterionId,
      kind: item.kind,
      verification: item.verification.result,
      sensitivity: item.sensitivity,
      capturedAt: item.capturedAt,
      contentHash: '',
      hasContent: Boolean(artifact),
      ...(artifact
        ? {
            artifact: {
              id: artifact.id,
              name: artifact.name,
              kind: artifact.kind,
              revision: artifact.revision,
              ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
              ...(artifact.uri ? { uri: artifact.uri } : {}),
            },
          }
        : {}),
      presentation: item.presentation,
      limitations: item.limitations,
    }
  })
  const criteria: ReviewCriterionPreview[] =
    pack?.criteria.map(criterion => ({
      criterionId: criterion.criterionId,
      completionStatus: criterion.completionStatus,
      explanation: criterion.explanation,
      limitations: criterion.limitations,
      evidenceCount: criterion.evidenceRefs.length,
    })) ?? []
  return (
    <section className="detail-section">
      <h3>目标与交付</h3>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {goal && (
        <div className="goal-summary">
          <small>目标修订 v{String(goal.revision)}</small>
          <p>{goal.desiredOutcome}</p>
          {goal.nonGoals.length > 0 && (
            <small>不做：{goal.nonGoals.join('；')}</small>
          )}
        </div>
      )}
      {pack ? (
        <>
          <p className={`review-outcome is-${pack.finalOutcome}`}>
            {outcomeLabel(pack.finalOutcome)} · 按 {String(criteria.length)}{' '}
            条完成标准审查
          </p>
          <CriteriaList criteria={criteria} statements={statements} />
          {pack.remainingRisks.length > 0 && (
            <p className="review-risks">
              剩余风险：{pack.remainingRisks.join('；')}
            </p>
          )}
        </>
      ) : (
        goal && (
          <p className="drawer-footnote">
            还没有 Review Pack；执行完成后会按完成标准生成审查结论。
          </p>
        )
      )}
      <EvidenceGallery
        evidence={evidencePreviews}
        onOpenEvidence={onOpenEvidence}
      />
    </section>
  )
}

function ReviewDetail({
  review,
  goal,
  onOpenEvidence,
  onOpenTask,
}: {
  review: ReviewProjection
  goal?: GoalContract
  onOpenEvidence?: (evidence: ReviewEvidencePreview) => void
  onOpenTask?: () => void
}) {
  const statements = new Map(
    goal?.successCriteria.map(criterion => [
      criterion.criterionId,
      criterion.observableStatement,
    ]) ?? [],
  )
  return (
    <div className="drawer-body">
      <section
        className={`state-hero state-${review.finalOutcome === 'completed' ? '已完成' : review.finalOutcome === 'partial' ? '待确认' : '失败'}`}
      >
        <span>
          {review.finalOutcome === 'completed' ? (
            <CheckCircle2 size={22} />
          ) : (
            <AlertTriangle size={22} />
          )}
        </span>
        <div>
          <small>{outcomeLabel(review.finalOutcome)}</small>
          <h3>目标修订 v{String(review.goalRevision)} 的交付审查</h3>
          <p>结论来自服务端 Review Pack，按完成标准与证据生成。</p>
        </div>
      </section>
      <section className="detail-section">
        <h3>完成标准</h3>
        <CriteriaList criteria={review.criteria} statements={statements} />
      </section>
      <section className="detail-section">
        <h3>证据画廊</h3>
        <EvidenceGallery
          evidence={review.evidence}
          onOpenEvidence={onOpenEvidence}
        />
      </section>
      {review.remainingRisks.length > 0 && (
        <section className="detail-section">
          <h3>剩余风险</h3>
          <p className="review-risks">{review.remainingRisks.join('；')}</p>
        </section>
      )}
      {review.rollback && (
        <section className="detail-section">
          <h3>回滚说明</h3>
          <pre className="approval-result">
            {JSON.stringify(review.rollback, null, 2)}
          </pre>
        </section>
      )}
      <footer className="drawer-footer">
        {onOpenTask && (
          <button className="primary-button" onClick={onOpenTask} type="button">
            打开事情详情与审计时间线
          </button>
        )}
      </footer>
    </div>
  )
}

function ClarificationDetail({
  questions,
  onAnswer,
  onOpenTask,
}: {
  questions: string[]
  onAnswer?: () => void
  onOpenTask?: () => void
}) {
  return (
    <div className="drawer-body">
      <section className="approval-card">
        <header>
          <ShieldCheck size={20} />
          <strong>Pegas 需要先确认这些问题</strong>
        </header>
        <p>
          这些信息会实质改变结果、权限或风险。回答后 Pegas
          会按当前目标修订继续执行，不会丢失已有进展。
        </p>
      </section>
      <section className="detail-section">
        <h3>待澄清问题</h3>
        <ol aria-label="待澄清问题" className="clarification-questions">
          {questions.map((question, index) => (
            <li key={`${String(index)}-${question}`}>{question}</li>
          ))}
        </ol>
      </section>
      <footer className="drawer-footer">
        {onAnswer && (
          <button className="primary-button" onClick={onAnswer} type="button">
            去回答
          </button>
        )}
        {onOpenTask && (
          <button
            className="secondary-button"
            onClick={onOpenTask}
            type="button"
          >
            查看事情详情
          </button>
        )}
      </footer>
    </div>
  )
}

function ExecutionProfileMeta({ run }: { run?: Run }) {
  const source = workerProfileSourceLabel(
    run?.executionContext?.workerProfileSource,
  )
  const revision = run?.executionContext?.workerProfileRevision
  const value = [
    source,
    revision === undefined ? undefined : `版本 ${String(revision)}`,
  ]
    .filter(Boolean)
    .join(' · ')
  return <Meta label="事情级执行设置" value={value || undefined} />
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
function workerProfileSourceLabel(source?: 'global' | 'task') {
  if (source === 'global') return 'Pegas 全局设置'
  if (source === 'task') return '这件事情'
  return undefined
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
          <ExecutionProfileMeta run={run} />
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

function useEvidenceContentUrl(rawContentUrl?: string): {
  contentUrl?: string
  contentError: string
  loadingContent: boolean
} {
  const [contentUrl, setContentUrl] = useState<string>()
  const [contentError, setContentError] = useState('')
  const [loadingContent, setLoadingContent] = useState(false)
  const needsFetch = Boolean(
    rawContentUrl && sessionStorage.getItem('pegas-token'),
  )
  useEffect(() => {
    if (!rawContentUrl) return
    if (!needsFetch) {
      setContentUrl(rawContentUrl)
      return
    }
    let cancelled = false
    let objectUrl: string | undefined
    setLoadingContent(true)
    setContentError('')
    fetch(rawContentUrl, {
      headers: {
        authorization: `Bearer ${sessionStorage.getItem('pegas-token') ?? ''}`,
      },
    })
      .then(async response => {
        if (!response.ok) throw new Error('预览内容读取失败。')
        return response.blob()
      })
      .then(blob => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setContentUrl(objectUrl)
        setLoadingContent(false)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        setContentError(
          caught instanceof Error ? caught.message : '预览内容读取失败。',
        )
        setLoadingContent(false)
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [rawContentUrl, needsFetch])
  return { contentUrl, contentError, loadingContent }
}

function EvidenceThumb({ alt, url }: { alt: string; url: string }) {
  const { contentUrl, contentError } = useEvidenceContentUrl(url)
  if (contentError || !contentUrl) return <ImageIcon size={26} />
  return <img alt={alt} loading="lazy" src={contentUrl} />
}

function PreviewDetail({
  onBack,
  view,
}: {
  onBack?: () => void
  view: Extract<DrawerView, { kind: 'preview' }>
}) {
  const { contentUrl, contentError, loadingContent } = useEvidenceContentUrl(
    view.contentUrl,
  )
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
      {onBack && view.backLabel && (
        <button
          className="inline-link preview-back"
          onClick={onBack}
          type="button"
        >
          {view.backLabel}
        </button>
      )}
      {loadingContent ? (
        <div className={`${view.preview}-preview preview-placeholder`}>
          <Icon size={48} />
          <h3>{view.title}</h3>
          <p>正在读取已存证的预览内容…</p>
        </div>
      ) : contentError ? (
        <div className={`${view.preview}-preview preview-placeholder`}>
          <Icon size={48} />
          <h3>{view.title}</h3>
          <p role="alert">{contentError}</p>
        </div>
      ) : contentUrl && view.preview === 'image' ? (
        <figure className="evidence-preview">
          <img alt={view.title} src={contentUrl} />
          <figcaption>{view.title}</figcaption>
        </figure>
      ) : contentUrl && view.preview === 'video' ? (
        <figure className="evidence-preview">
          <video controls preload="metadata" src={contentUrl} />
          <figcaption>{view.title}</figcaption>
        </figure>
      ) : (
        <div className={`${view.preview}-preview preview-placeholder`}>
          <Icon size={48} />
          <h3>{view.title}</h3>
          <p>{view.description ?? '服务端没有提供可渲染的预览内容。'}</p>
        </div>
      )}
      <section className="metadata-list">
        <dl>
          <Meta label="类型" value={view.mimeType} />
          <Meta label="来源" value={view.source} />
        </dl>
      </section>
      {(view.url ?? contentUrl) && (
        <footer className="drawer-footer">
          <a
            className="primary-button"
            href={view.url ?? contentUrl}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink size={16} />
            {view.url ? '打开来源' : '打开原始内容'}
          </a>
        </footer>
      )}
    </div>
  )
}
