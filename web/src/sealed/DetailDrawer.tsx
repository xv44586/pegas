import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Clock3,
  ExternalLink,
  FileText,
  Globe2,
  HardDrive,
  Image as ImageIcon,
  CircleQuestionMark,
  LockKeyhole,
  Network,
  Paperclip,
  Play,
  RotateCw,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { ApiError, type PegasApi } from '../api'
import { MarkdownMessage } from '../MarkdownMessage'
import type {
  ApprovalRule,
  ChannelEvidencePage,
  ChannelRelation,
  DurableAction,
  DshModelCatalog,
  ExecutionNode,
  GoalContract,
  OutboxMessage,
  ReviewCriterionPreview,
  ReviewEvidencePreview,
  ReviewProjection,
  ReviewPack,
  Run,
  RunActivityEntry,
  RunActivityReport,
  RunSubagentReport,
  SubagentTranscript,
  TaskDelivery,
  WorkerProfileResponse,
  PermissionTierChange,
} from '../types'
import { PegasMascot } from './PegasMascot'
import { ActivityTimeline, type ActivityDataAccess } from './ActivityTimeline'
import { isDelegationEntry } from './activityModel'
import {
  Button,
  buttonVariants,
  FormField,
  RadioGroup,
  RadioItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  TextArea,
  TextInput,
} from '@bui/index'
import { StateHeader, type FactTone } from './ConversationBui'
import { ModelPicker } from './ModelPicker'
import {
  formatRelativeTime,
  needsOutboxResolution,
  runStatusLabel,
  statusLabel,
  textFromPayload,
  type DrawerView,
} from './types'

export function DetailDrawer({
  view,
  api,
  onClose,
  onChange,
  onOpenView,
  onLoadRunActivity,
  onLoadRunSubagents,
  onRetry,
  onContinue,
  onAnswerRouting,
  onCreateRelated,
  onStop,
  onDecideApproval,
  onReconcileAction,
  onResolveOutbox,
}: {
  view: DrawerView
  api?: PegasApi
  onClose: () => void
  onChange: (view: DrawerView) => void
  onOpenView?: (view: DrawerView) => void
  onLoadRunActivity?: (runId: string) => void
  onLoadRunSubagents?: (runId: string) => void
  onRetry: (run: Run) => Promise<void>
  onContinue?: (
    channel: Extract<DrawerView, { kind: 'task' }>['channel'],
  ) => void
  onAnswerRouting?: () => void
  onCreateRelated?: (
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
  onResolveOutbox?: (
    messageId: string,
    resolution: 'sent' | 'failed',
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
            api={api}
            activityByRun={view.activityByRun}
            activityErrorByRun={view.activityErrorByRun}
            automationActive={view.automationActive}
            channel={view.channel}
            collaborations={view.collaborations}
            collaborationsError={view.collaborationsError}
            delivery={view.delivery}
            deliveryError={view.deliveryError}
            onContinue={onContinue}
            onCreateRelated={onCreateRelated}
            onLoadRunActivity={onLoadRunActivity}
            onLoadRunSubagents={onLoadRunSubagents}
            onOpenEvidence={
              onOpenView
                ? evidence => onOpenView(evidencePreviewView(evidence))
                : undefined
            }
            onOpenTarget={
              api
                ? async targetTaskId => {
                    const timeline = await api.channelTimeline(targetTaskId)
                    if (!onOpenView)
                      throw new Error('当前界面不支持打开目标事情。')
                    onOpenView({
                      kind: 'task',
                      channel: timeline.channel,
                      timeline,
                    })
                  }
                : undefined
            }
            onOpenView={onOpenView}
            onRetry={onRetry}
            onStop={onStop}
            run={view.run}
            runs={view.runs}
            subagentsByRun={view.subagentsByRun}
            subagentErrorByRun={view.subagentErrorByRun}
            timeline={view.timeline}
            timelineError={view.timelineError}
            usage={view.usage}
            workerProfile={view.workerProfile}
            workerProfileError={view.workerProfileError}
          />
        )}
        {view.kind === 'message' && (
          <MessageDetail onResolve={onResolveOutbox} view={view} />
        )}
        {view.kind === 'routingClarification' && (
          <RoutingClarificationDetail
            onAnswer={
              onAnswerRouting
                ? () => {
                    onAnswerRouting()
                    onClose()
                  }
                : undefined
            }
            view={view}
          />
        )}
        {view.kind === 'approval' && (
          <ApprovalDetail
            key={`${view.approval.id}:${view.approval.decision?.id ?? view.approval.status}`}
            channel={view.channel}
            onDecide={onDecideApproval}
            onOpenTask={approvalTaskOpener(view.channel, onOpenView)}
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
        {view.kind === 'runtime' && (
          <RuntimeDetail
            nodes={view.nodes}
            nodesError={view.nodesError}
            run={view.run}
          />
        )}
        {view.kind === 'rule' && (
          <RuleDetail api={api} onClose={onClose} view={view} />
        )}
        {view.kind === 'routingRule' && (
          <RoutingRuleDetail api={api} onClose={onClose} view={view} />
        )}
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

interface RunProgressSummary {
  runId: string
  toolCalls: number
  steps: number
  recent: string[]
  at: string
}

function formatDurationMs(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60)
    return rest ? `${String(minutes)}m ${String(rest)}s` : `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  return `${String(hours)}h ${String(minutes % 60)}m`
}

function runProgressFromPayload(
  payload: unknown,
): Omit<RunProgressSummary, 'at'> | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const value = payload as Record<string, unknown>
  if (value.type !== 'run.progress' || typeof value.runId !== 'string')
    return undefined
  return {
    runId: value.runId,
    toolCalls: typeof value.toolCalls === 'number' ? value.toolCalls : 0,
    steps: typeof value.steps === 'number' ? value.steps : 0,
    recent: Array.isArray(value.recent)
      ? value.recent.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
  }
}

function drawerTitle(view: DrawerView): string {
  if (view.kind === 'task') return view.channel.title
  if (view.kind === 'message') return 'Pegas 消息'
  if (view.kind === 'approval') return view.approval.prompt.summary
  if (view.kind === 'reconciliation') return '核对动作的真实结果'
  if (view.kind === 'review') return '按完成标准审查交付'
  if (view.kind === 'clarification') return view.channel.title
  if (view.kind === 'routingClarification') return '确认消息归属'
  if (view.kind === 'runtime') return '执行环境详情'
  if (view.kind === 'rule') return view.title
  if (view.kind === 'routingRule') return view.title
  return view.title
}

function ApprovalDetail({
  view,
  onDecide,
  onReconcile,
  channel,
  onOpenTask,
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
  channel?: Extract<DrawerView, { kind: 'task' }>['channel']
  onOpenTask?: () => void
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
    <div className="drawer-body bui">
      <section className="approval-card mt-3.5 grid gap-2.5 rounded-card bg-surface p-4 shadow-card">
        <header className="flex items-center gap-2">
          {pending ? (
            <PegasMascot label="Pegas 等待你的决定" pose="blocked" size={40} />
          ) : (
            <ShieldCheck size={20} />
          )}
          <strong>{view.approval.prompt.summary}</strong>
        </header>
        {channel && (
          <p className="approval-source text-[13px] text-ink-2">
            {onOpenTask ? (
              <button
                className="approval-source-link text-left text-[13px] text-accent-ink hover:underline"
                onClick={onOpenTask}
                type="button"
              >
                来自事情：{channel.title}
              </button>
            ) : (
              <span>来自事情：{channel.title}</span>
            )}
          </p>
        )}
        <ApprovalOperationPreview action={view.action} />
        {view.action.review && (
          <p className="mt-2.5 text-[13px] text-ink-2">
            {approvalReviewLabel(view.action.review)}
          </p>
        )}
        <p className="mt-2.5 text-[13px] leading-[1.55] text-ink-2">
          需要你决定：{approvalReason(view)}
        </p>
        <dl className="approval-meta grid text-[13px]">
          <Meta label="状态" value={approvalStatus(view.approval.status)} />
          <Meta label="Action" value={actionStatus(view.action.status)} />
          <Meta label="Run" value={view.approval.requestRunId} />
        </dl>
        {view.action.result && (
          <pre className="approval-result mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-control bg-inset px-3 py-2.5 text-[12.5px] text-ink-2">
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
          <RadioGroup
            aria-label="你的决定"
            disabled={!pending || submitting}
            onValueChange={value => setSelected(value)}
            value={selected}
          >
            {view.approval.prompt.options.map(option => (
              <label
                className="approval-option mt-2.5 flex cursor-pointer items-start gap-3 rounded-card border border-line px-3.5 py-3 transition-colors duration-150 hover:bg-hover-2 has-[[data-state=checked]]:border-accent has-[[data-state=checked]]:bg-accent-tint"
                key={option.id}
              >
                <RadioItem
                  aria-label={option.label}
                  className="mt-[3px]"
                  value={option.id}
                />
                <span className="grid min-w-0 gap-[3px]">
                  <strong>
                    {option.label}
                    {option.id === view.approval.prompt.recommendedOptionId
                      ? ' · 建议'
                      : ''}
                  </strong>
                  {option.description && (
                    <small className="text-ink-3">{option.description}</small>
                  )}
                </span>
              </label>
            ))}
          </RadioGroup>
        </fieldset>
        <label className="approval-rationale mt-4 grid gap-2">
          <span className="text-ink-2">补充说明（可选）</span>
          <TextArea
            className="min-h-[88px] w-full resize-y"
            disabled={!pending || submitting}
            onChange={event => setRationale(event.target.value)}
            placeholder="告诉 Pegas 需要注意什么"
            value={rationale}
          />
        </label>
        {(error || view.decisionError) && (
          <p
            className="settings-error mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
            role="alert"
          >
            {error || view.decisionError}
          </p>
        )}
      </section>
      <footer className="drawer-footer">
        {pending && onDecide ? (
          <Button
            variant="accent"
            size="sm"
            disabled={submitting}
            onClick={() => void submitDecision()}
            type="button"
          >
            {submitting ? '正在提交…' : '提交决定'}
          </Button>
        ) : (
          <span className="drawer-footnote mt-2.5 block text-[12px] leading-[1.6] text-ink-2">
            {approvalFootnote(view.approval.status)}
          </span>
        )}
      </footer>
    </div>
  )
}

function approvalReason(
  view: Extract<DrawerView, { kind: 'approval' }>,
): string {
  const reason = view.action.request.reason
  return typeof reason === 'string' && reason.trim() !== ''
    ? reason
    : view.approval.prompt.impact
}

function approvalTaskOpener(
  channel: Extract<DrawerView, { kind: 'task' }>['channel'] | undefined,
  onOpenView?: (view: DrawerView) => void,
): (() => void) | undefined {
  if (!channel || !onOpenView) return undefined
  return () => onOpenView({ kind: 'task', channel })
}

function ApprovalOperationPreview({ action }: { action: DurableAction }) {
  const request = action.request
  const tool = typeof request.tool === 'string' ? request.tool : undefined
  const category =
    typeof request.category === 'string' ? request.category : undefined
  const targets = Array.isArray(request.targets)
    ? request.targets.filter(
        (target): target is string => typeof target === 'string',
      )
    : []
  const command =
    typeof request.command === 'string' ? request.command : undefined
  const egressPayload = approvalEgressPayload(request.egressPayload)
  const tier =
    request.tier === 'strict' ||
    request.tier === 'standard' ||
    request.tier === 'full'
      ? request.tier
      : undefined
  if (!tool && !category && targets.length === 0 && !command) return null
  return (
    <section aria-label="操作预览" className="approval-operation">
      {category && (
        <p className="approval-operation-category">
          {approvalCategoryLabel(category)} · {actionRiskLabel(action.risk)}
        </p>
      )}
      {tool && (
        <p className="approval-operation-tool">
          工具 <code>{tool}</code>
          {tier && <span> · {permissionTierLabel(tier)}档位</span>}
          {request.tierMismatch === true && (
            <span> · 档位读取异常，按严格处置</span>
          )}
        </p>
      )}
      {command && (
        <pre className="approval-command">
          <code>{command}</code>
        </pre>
      )}
      {targets.length > 0 && (
        <ul className="approval-targets">
          {targets.map(target => (
            <li key={target}>
              <code>{target}</code>
            </li>
          ))}
        </ul>
      )}
      {egressPayload && (
        <div aria-label="发送内容预览" className="grid gap-1.5">
          <p className="m-0 font-medium">发送内容预览</p>
          <ul className="m-0 grid list-none gap-2 p-0">
            {egressPayload.items.map((item, index) => (
              <li key={`${item.path}:${String(index)}`}>
                {item.path !== '' && (
                  <p className="m-0 mb-1">
                    <code className="font-mono text-[12px] wrap-anywhere">
                      {item.path}
                    </code>
                    {item.truncated === true && <span> · 已截断</span>}
                  </p>
                )}
                {item.content !== undefined && (
                  <pre className="approval-command">
                    <code>{item.content}</code>
                  </pre>
                )}
                {item.content === undefined && item.path === '' && (
                  <p className="m-0 text-[12px] text-ink-2">
                    {item.error ?? '未能读取发送内容。'}
                  </p>
                )}
                {item.content !== undefined &&
                  item.path === '' &&
                  item.truncated === true && (
                    <p className="m-0 text-[12px] text-ink-2">已截断</p>
                  )}
                {item.path !== '' && item.error !== undefined && (
                  <p className="m-0 text-[12px] text-ink-2">{item.error}</p>
                )}
              </li>
            ))}
          </ul>
          {egressPayload.omitted === true && (
            <p className="m-0 text-[12px] text-ink-2">
              发送内容项过多，仅预览前几项。
            </p>
          )}
        </div>
      )}
    </section>
  )
}

interface ApprovalEgressPayloadItem {
  path: string
  content?: string
  truncated?: boolean
  error?: string
}

function approvalEgressPayload(
  value: unknown,
): { items: ApprovalEgressPayloadItem[]; omitted?: boolean } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.items)) return undefined
  const items = record.items.flatMap(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      return []
    const entry = item as Record<string, unknown>
    return [
      {
        path: typeof entry.path === 'string' ? entry.path : '',
        ...(typeof entry.content === 'string'
          ? { content: entry.content }
          : {}),
        ...(entry.truncated === true ? { truncated: true } : {}),
        ...(typeof entry.error === 'string' ? { error: entry.error } : {}),
      },
    ]
  })
  if (items.length === 0) return undefined
  return {
    items,
    ...(record.omitted === true ? { omitted: true } : {}),
  }
}

function approvalCategoryLabel(category: string): string {
  switch (category) {
    case 'out-of-workspace-write':
      return '工作区外写入'
    case 'network-egress':
      return '对外网络发送'
    case 'destructive-command':
      return '不可逆命令'
    case 'control-plane-mutation':
      return 'Pegas 控制面修改'
    case 'workspace-write':
      return '工作区内写入'
    case 'read':
      return '只读操作'
    default:
      return '无法静态判定'
  }
}

function actionRiskLabel(risk: DurableAction['risk']): string {
  switch (risk) {
    case 'critical':
      return '严重风险'
    case 'high':
      return '高风险'
    case 'medium':
      return '中风险'
    default:
      return '低风险'
  }
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
    <div className="reconciliation-record mt-3 grid gap-[5px] rounded-control bg-inset px-3 py-2.5">
      <strong>
        人工核对：
        {action.reconciliation.resolution === 'succeeded'
          ? '确认已成功'
          : '确认已失败'}
      </strong>
      <p className="break-words text-[13px]">{action.reconciliation.note}</p>
      <small className="text-ink-3">
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
        <p className="reconciliation-hint mt-2 text-[13px] leading-[1.55] text-ink-2">
          这个动作的外部结果
          {action.status === 'unknown' ? '未知' : '被记录为失败'}
          。请先在外部系统核实真实结果，再选择结论；结论会永久记录并决定是否允许继续。
        </p>
        <RadioGroup
          aria-label="人工核对结论"
          disabled={submitting}
          onValueChange={value =>
            setResolution(value === 'succeeded' ? 'succeeded' : 'failed')
          }
          value={resolution}
        >
          <label className="approval-option mt-2.5 flex cursor-pointer items-start gap-3 rounded-card border border-line px-3.5 py-3 transition-colors duration-150 hover:bg-hover-2 has-[[data-state=checked]]:border-accent has-[[data-state=checked]]:bg-accent-tint">
            <RadioItem
              aria-label="确认已成功"
              className="mt-[3px]"
              value="succeeded"
            />
            <span className="grid min-w-0 gap-[3px]">
              <strong>确认已成功</strong>
              <small className="text-ink-3">
                外部副作用实际已发生，允许 Pegas 继续后续工作
              </small>
            </span>
          </label>
          <label className="approval-option mt-2.5 flex cursor-pointer items-start gap-3 rounded-card border border-line px-3.5 py-3 transition-colors duration-150 hover:bg-hover-2 has-[[data-state=checked]]:border-accent has-[[data-state=checked]]:bg-accent-tint">
            <RadioItem
              aria-label="确认已失败"
              className="mt-[3px]"
              value="failed"
            />
            <span className="grid min-w-0 gap-[3px]">
              <strong>确认已失败</strong>
              <small className="text-ink-3">
                外部副作用没有发生，保持失败事实并继续阻塞重试
              </small>
            </span>
          </label>
        </RadioGroup>
      </fieldset>
      <label className="approval-rationale mt-4 grid gap-2">
        <span className="text-ink-2">核对依据（必填）</span>
        <TextArea
          className="min-h-[88px] w-full resize-y"
          disabled={submitting}
          maxLength={2000}
          onChange={event => setNote(event.target.value)}
          placeholder="例如：已在银行 App 查到转账记录，金额与时间一致"
          value={note}
        />
      </label>
      {error && (
        <p
          className="settings-error mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
          role="alert"
        >
          {error}
        </p>
      )}
      <Button
        variant="accent"
        size="sm"
        disabled={submitting || !note.trim()}
        onClick={() => void submit()}
        type="button"
      >
        {submitting ? '正在提交…' : '提交核对结论'}
      </Button>
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
    <div className="drawer-body bui">
      <section className="approval-card mt-3.5 grid gap-2.5 rounded-card bg-surface p-4 shadow-card">
        <header className="flex items-center gap-2">
          <ShieldCheck size={20} />
          <strong>高风险动作需要人工核对</strong>
        </header>
        <p className="text-[13px] leading-[1.55] text-ink-2">
          Pegas 已记录这个动作的执行结果，但无法确定外部系统的真实状态。
          请核实后提交结论，Pegas 才会决定是否继续。
        </p>
        <dl className="approval-meta grid text-[13px]">
          <Meta label="动作类型" value={action.kind} />
          <Meta label="Action" value={actionStatus(action.status)} />
          <Meta label="Run" value={action.requestRunId} />
        </dl>
        <pre className="approval-result mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-control bg-inset px-3 py-2.5 text-[12.5px] text-ink-2">
          {JSON.stringify(action.request, null, 2)}
        </pre>
        {action.result && (
          <pre className="approval-result mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-control bg-inset px-3 py-2.5 text-[12.5px] text-ink-2">
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
          <span className="drawer-footnote mt-2.5 block text-[12px] leading-[1.6] text-ink-2">
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
  onResolve,
  view,
}: {
  onResolve?: (
    messageId: string,
    resolution: 'sent' | 'failed',
    note: string,
  ) => Promise<void>
  view: Extract<DrawerView, { kind: 'message' }>
}) {
  const text = textFromPayload(view.message.payload)
  const message = view.message
  const needsResolution = Boolean(onResolve) && needsOutboxResolution(message)
  const expiredInput =
    message.payload &&
    typeof message.payload === 'object' &&
    (message.payload as { type?: unknown }).type ===
      'routing.clarification_expired' &&
    typeof (message.payload as { input?: unknown }).input === 'string'
      ? (message.payload as { input: string }).input
      : undefined
  return (
    <div className="drawer-body bui">
      <section className="detail-section">
        <h3>消息内容</h3>
        <p>{text || '服务端没有提供消息正文。'}</p>
      </section>
      {expiredInput && (
        <section className="detail-section">
          <h3>原始消息</h3>
          <p>{expiredInput}</p>
        </section>
      )}
      <section className="detail-section metadata-list">
        <h3>消息信息</h3>
        <dl>
          <Meta label="来源" value="Pegas" />
          <Meta label="投递状态" value={outboxStatusLabel(message.status)} />
          <Meta
            label="创建时间"
            value={formatRelativeTime(message.createdAt)}
          />
          <Meta label="最近错误" value={message.lastError} />
        </dl>
      </section>
      {message.resolution && (
        <section className="detail-section">
          <h3>人工核对记录</h3>
          <div className="reconciliation-record mt-3 grid gap-[5px] rounded-control bg-inset px-3 py-2.5">
            <strong>
              {message.resolution.resolution === 'sent'
                ? '人工核对：确认已送达'
                : '人工核对：确认未送达'}
            </strong>
            <p className="break-words text-[13px]">{message.resolution.note}</p>
            <small className="text-ink-3">
              核对前状态：
              {message.resolution.previousStatus === 'unknown'
                ? '投递结果未知'
                : '投递失败'}{' '}
              · {formatRelativeTime(message.resolution.createdAt)}
            </small>
          </div>
        </section>
      )}
      {needsResolution && onResolve && (
        <OutboxResolutionForm message={message} onResolve={onResolve} />
      )}
      <div className="my-3 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2">
        <LockKeyhole size={16} />
        此消息没有关联事情；这里只展示服务端保存的原始消息。
      </div>
    </div>
  )
}

function outboxStatusLabel(status: OutboxMessage['status']): string {
  const labels: Record<OutboxMessage['status'], string> = {
    pending: '等待投递',
    sending: '正在投递',
    sent: '已送达',
    failed: '投递失败',
    unknown: '投递结果未知',
  }
  return labels[status]
}

function OutboxResolutionForm({
  message,
  onResolve,
}: {
  message: OutboxMessage
  onResolve: (
    messageId: string,
    resolution: 'sent' | 'failed',
    note: string,
  ) => Promise<void>
}) {
  const [resolution, setResolution] = useState<'sent' | 'failed'>('sent')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (submitting || !note.trim()) return
    setSubmitting(true)
    setError('')
    try {
      await onResolve(message.id, resolution, note.trim())
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
        <legend>核对真实投递结果</legend>
        <p className="reconciliation-hint mt-2 text-[13px] leading-[1.55] text-ink-2">
          这条通知
          {message.status === 'unknown' ? '的投递结果未知' : '被记录为投递失败'}
          。请在外部渠道（如邮件、IM）核实是否真的收到，再提交结论；结论会永久记录。
        </p>
        <RadioGroup
          aria-label="核对真实投递结果"
          disabled={submitting}
          onValueChange={value =>
            setResolution(value === 'sent' ? 'sent' : 'failed')
          }
          value={resolution}
        >
          <label className="approval-option mt-2.5 flex cursor-pointer items-start gap-3 rounded-card border border-line px-3.5 py-3 transition-colors duration-150 hover:bg-hover-2 has-[[data-state=checked]]:border-accent has-[[data-state=checked]]:bg-accent-tint">
            <RadioItem
              aria-label="确认已送达"
              className="mt-[3px]"
              value="sent"
            />
            <span className="grid min-w-0 gap-[3px]">
              <strong>确认已送达</strong>
              <small className="text-ink-3">外部渠道实际收到了这条通知</small>
            </span>
          </label>
          <label className="approval-option mt-2.5 flex cursor-pointer items-start gap-3 rounded-card border border-line px-3.5 py-3 transition-colors duration-150 hover:bg-hover-2 has-[[data-state=checked]]:border-accent has-[[data-state=checked]]:bg-accent-tint">
            <RadioItem
              aria-label="确认未送达"
              className="mt-[3px]"
              value="failed"
            />
            <span className="grid min-w-0 gap-[3px]">
              <strong>确认未送达</strong>
              <small className="text-ink-3">
                外部渠道没有收到，保留失败事实
              </small>
            </span>
          </label>
        </RadioGroup>
      </fieldset>
      <label className="approval-rationale mt-4 grid gap-2">
        <span className="text-ink-2">核对依据（必填）</span>
        <TextArea
          className="min-h-[88px] w-full resize-y"
          disabled={submitting}
          maxLength={2000}
          onChange={event => setNote(event.target.value)}
          placeholder="例如：已在邮箱收到这条通知，时间与内容一致"
          value={note}
        />
      </label>
      {error && (
        <p
          className="settings-error mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
          role="alert"
        >
          {error}
        </p>
      )}
      <Button
        variant="accent"
        size="sm"
        disabled={submitting || !note.trim()}
        onClick={() => void submit()}
        type="button"
      >
        {submitting ? '正在提交…' : '提交投递核对'}
      </Button>
    </section>
  )
}

function TaskDetail({
  api,
  activityByRun,
  activityErrorByRun,
  channel,
  collaborations,
  collaborationsError,
  delivery,
  deliveryError,
  automationActive,
  run,
  runs,
  subagentsByRun,
  subagentErrorByRun,
  timeline,
  timelineError,
  usage,
  workerProfile,
  workerProfileError,
  onOpenEvidence,
  onOpenTarget,
  onOpenView,
  onLoadRunActivity,
  onLoadRunSubagents,
  onRetry,
  onContinue,
  onCreateRelated,
  onStop,
}: {
  api?: PegasApi
  activityByRun?: Record<string, RunActivityReport>
  activityErrorByRun?: Record<string, string>
  automationActive?: boolean
  channel: Extract<DrawerView, { kind: 'task' }>['channel']
  collaborations?: ChannelRelation[]
  collaborationsError?: string
  delivery?: TaskDelivery
  deliveryError?: string
  run?: Run
  runs?: Run[]
  subagentsByRun?: Record<string, RunSubagentReport>
  subagentErrorByRun?: Record<string, string>
  timeline?: Extract<DrawerView, { kind: 'task' }>['timeline']
  timelineError?: string
  usage?: Extract<DrawerView, { kind: 'task' }>['usage']
  workerProfile?: WorkerProfileResponse
  workerProfileError?: string
  onOpenEvidence?: (evidence: ReviewEvidencePreview) => void
  onOpenTarget?: (targetTaskId: string) => Promise<void>
  onOpenView?: (view: DrawerView) => void
  onLoadRunActivity?: (runId: string) => void
  onLoadRunSubagents?: (runId: string) => void
  onRetry: (run: Run) => Promise<void>
  onContinue?: (
    channel: Extract<DrawerView, { kind: 'task' }>['channel'],
  ) => void
  onCreateRelated?: (
    channel: Extract<DrawerView, { kind: 'task' }>['channel'],
  ) => void
  onStop?: (
    channel: Extract<DrawerView, { kind: 'task' }>['channel'],
  ) => Promise<void>
}) {
  const baseState = statusLabel(channel, run)
  const state =
    automationActive && baseState === '已完成' ? '已安排' : baseState
  const runHistory = (runs ?? (run ? [run] : [])).toSorted(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  )
  const progressByRun = new Map<string, RunProgressSummary>()
  for (const message of timeline?.messages ?? []) {
    const progress = runProgressFromPayload(message.payload)
    if (!progress) continue
    const existing = progressByRun.get(progress.runId)
    if (!existing || Date.parse(message.createdAt) >= Date.parse(existing.at)) {
      progressByRun.set(progress.runId, {
        ...progress,
        at: message.createdAt,
      })
    }
  }
  const usageByRun = new Map(
    (usage?.records ?? []).map(record => [record.runId, record]),
  )
  const totalDurationMs = (usage?.records ?? []).reduce(
    (sum, record) => sum + (record.durationMs ?? 0),
    0,
  )
  const hasDuration = (usage?.records ?? []).some(
    record => record.durationMs !== undefined,
  )
  const liveRun = runHistory.findLast(historyRun =>
    ['queued', 'running', 'waiting'].includes(historyRun.status),
  )
  const liveProgress = liveRun ? progressByRun.get(liveRun.id) : undefined
  const liveDurationMs =
    liveRun?.status === 'running'
      ? Math.max(0, Date.now() - Date.parse(liveRun.createdAt))
      : undefined
  const completedOutputRun = runHistory.findLast(
    historyRun => historyRun.status === 'completed' && historyRun.output,
  )
  const completedOutput =
    state === '已完成' ? completedOutputRun?.output : undefined
  const timelineItems = [
    ...(timeline?.events.map(event => ({
      id: event.id,
      key: `event-${event.id}`,
      at: event.createdAt,
      role: '你',
      text: textFromPayload(event.payload),
      attachment: event.attachment,
      progressRunId: undefined as string | undefined,
    })) ?? []),
    ...(timeline?.messages.map(message => ({
      id: message.id,
      key: `message-${message.id}`,
      at: message.createdAt,
      role: 'Pegas',
      text: textFromPayload(message.payload),
      attachment: undefined,
      progressRunId: runProgressFromPayload(message.payload)?.runId,
    })) ?? []),
  ]
    .filter(item => item.text && !item.progressRunId)
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
  const deliveryRef = useRef<HTMLDivElement>(null)
  const hasDelivery = Boolean(
    delivery?.goal ?? delivery?.reviewPack ?? deliveryError,
  )
  const jumpToDelivery = hasDelivery
    ? () => {
        deliveryRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        })
      }
    : undefined
  const activityAccess = api
    ? (runId: string): ActivityDataAccess => ({
        runId,
        loadOutputPage: (targetRun, callId, offset, until) =>
          api.runActivityOutputPage(targetRun, callId, offset, until),
        imageUrl: (targetRun, callId) =>
          api.runActivityImageUrl(targetRun, callId),
        outputFileUrl: (targetRun, callId) =>
          api.runActivityOutputFileUrl(targetRun, callId),
      })
    : undefined

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
    <div className="drawer-body bui">
      <StateHeader label={state} tone={stateTone(state)}>
        <h3 className="m-0 text-[13px] font-medium text-ink">
          {stateHeadline(state)}
        </h3>
        {completedOutput ? (
          <div className="state-hero-markdown mt-1">
            <MarkdownMessage
              content={
                completedOutput.length > 600 && !summaryExpanded
                  ? `${completedOutput.slice(0, 600)}…`
                  : completedOutput
              }
            />
          </div>
        ) : (
          <p className="mt-1">{stateDescription(state, run)}</p>
        )}
        {completedOutput && completedOutput.length > 600 && (
          <button
            className="inline-link mt-2 inline-flex items-center gap-[5px] font-medium text-accent-ink"
            onClick={() => setSummaryExpanded(current => !current)}
            type="button"
          >
            {summaryExpanded ? '收起结果' : '展开完整结果'}
          </button>
        )}
      </StateHeader>
      {state === '失败' && (
        <section className="mt-3.5 rounded-card bg-surface p-3.5 shadow-card">
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-red-text">
            <AlertTriangle size={15} />
            执行已停止
          </p>
          <p className="mt-1.5 text-[13px] leading-[1.6] text-ink-2">
            {run?.lastError ?? '服务端没有提供失败原因。'}
          </p>
          <p className="mt-1 text-[12px] text-ink-3">
            重试会创建新的运行记录；既有记录会保留。
          </p>
          {retryError && (
            <p className="mt-1 text-[12px] text-red-text" role="alert">
              {retryError}
            </p>
          )}
        </section>
      )}
      <section className="detail-section">
        <div className="run-record-heading">
          <h3>运行记录</h3>
          <small className="run-duration-summary">
            {hasDuration
              ? `累计用时 ${formatDurationMs(totalDurationMs)}`
              : liveDurationMs !== undefined
                ? `本次已运行 ${formatDurationMs(liveDurationMs)}`
                : '用时待回报'}
            {liveProgress &&
              ` · 工具 ${String(liveProgress.toolCalls)} 次 · ${String(liveProgress.steps)} 步推理`}
          </small>
        </div>
        <ol className="progress-list">
          <li className="is-done">
            <CheckCircle2 size={14} />
            <span className="grid min-w-0 gap-[3px]">
              <strong>事情已创建</strong>
              <small>{formatRelativeTime(channel.createdAt)}</small>
            </span>
          </li>
          {runHistory.length ? (
            runHistory.map((historyRun, index) => {
              const historyState = runStatusLabel(historyRun)
              const progress = progressByRun.get(historyRun.id)
              const runUsage = usageByRun.get(historyRun.id)
              const activity = activityByRun?.[historyRun.id]
              const activityError = activityErrorByRun?.[historyRun.id]
              const subagents = subagentsByRun?.[historyRun.id]?.subagents
              const subagentError = subagentErrorByRun?.[historyRun.id]
              const runLabel =
                runHistory.length === 1
                  ? `Run · ${historyRun.id.slice(0, 8)}`
                  : `Run ${String(index + 1)} · ${historyRun.id.slice(0, 8)}`
              return (
                <li
                  className={runProgressClass(historyState)}
                  key={historyRun.id}
                >
                  {runProgressIcon(historyState)}
                  <span>
                    <strong>{runLabel}</strong>
                    <small>
                      {historyState} ·{' '}
                      {formatRelativeTime(historyRun.updatedAt)}
                      {runUsage?.durationMs !== undefined &&
                        ` · 用时 ${formatDurationMs(runUsage.durationMs)}`}
                    </small>
                    {runHistory.length > 1 && historyRun.lastError && (
                      <small>{historyRun.lastError}</small>
                    )}
                    {(progress ??
                      activity ??
                      activityError ??
                      onLoadRunActivity) && (
                      <details className="run-progress-details">
                        <summary
                          onClick={() => {
                            if (!activity && !activityError)
                              onLoadRunActivity?.(historyRun.id)
                          }}
                        >
                          工作流程记录
                          {progress &&
                            ` · 工具 ${String(progress.toolCalls)} 次 · ${String(progress.steps)} 步推理`}
                        </summary>
                        {activityError && (
                          <p
                            className="settings-error mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
                            role="alert"
                          >
                            {activityError}
                          </p>
                        )}
                        {!activity && !activityError && (
                          <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
                            正在读取完整执行记录。
                          </p>
                        )}
                        {activity?.entries.length === 0 && (
                          <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
                            这次运行没有留存执行记录（旧版本运行或直接应答）。
                          </p>
                        )}
                        {activity && activity.entries.length > 0 && (
                          <>
                            {activity.truncated && (
                              <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
                                记录过长，仅显示最近 {activity.entries.length}{' '}
                                条。
                              </p>
                            )}
                            <ActivityTimeline
                              entries={activity.entries}
                              dataAccess={activityAccess?.(historyRun.id)}
                              onReviewJump={jumpToDelivery}
                              renderDelegation={entry =>
                                isDelegationEntry(entry) ? (
                                  <SubagentCard
                                    delegation={parseDelegation(entry.detail)}
                                    entry={entry}
                                    runId={historyRun.id}
                                    subagents={subagents}
                                    subagentError={subagentError}
                                    onLoadSubagents={onLoadRunSubagents}
                                  />
                                ) : undefined
                              }
                            />
                          </>
                        )}
                        {subagentError && (
                          <p
                            className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-red-text"
                            role="alert"
                          >
                            子任务记录读取失败：{subagentError}
                          </p>
                        )}
                        {historyRun.output && (
                          <details className="run-final-output">
                            <summary>最终结果</summary>
                            <div className="transcript-markdown">
                              <MarkdownMessage content={historyRun.output} />
                            </div>
                          </details>
                        )}
                      </details>
                    )}
                  </span>
                </li>
              )
            })
          ) : (
            <li>
              <Clock3 size={14} />
              <span className="grid min-w-0 gap-[3px]">
                <strong>等待运行记录</strong>
                <small>服务端尚未返回 Run</small>
              </span>
            </li>
          )}
        </ol>
      </section>
      {(delivery?.goal ?? delivery?.reviewPack ?? deliveryError) && (
        <div className="delivery-anchor" ref={deliveryRef}>
          <DeliverySection
            api={api}
            channelId={channel.id}
            delivery={delivery}
            error={deliveryError}
            onOpenEvidence={onOpenEvidence}
          />
        </div>
      )}
      {(collaborations?.length ?? 0) > 0 || collaborationsError ? (
        <CollaborationSection
          collaborations={collaborations ?? []}
          error={collaborationsError}
          onOpenTarget={onOpenTarget}
        />
      ) : null}
      <section className="detail-section">
        <h3>Channel 时间线</h3>
        {timelineError ? (
          <p
            className="settings-error mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
            role="alert"
          >
            {timelineError}
          </p>
        ) : timelineItems.length ? (
          <ol className="drawer-timeline">
            {timelineItems.map(item => (
              <li key={item.key}>
                <strong>{item.role}</strong>
                <div className="timeline-markdown">
                  <MarkdownMessage
                    content={
                      item.text.length > 520 && !expandedTimeline.has(item.key)
                        ? `${item.text.slice(0, 520)}…`
                        : item.text
                    }
                  />
                </div>
                {item.attachment && api && (
                  <button
                    className="attachment-link"
                    onClick={() => {
                      const attachment = item.attachment
                      if (!onOpenView || !attachment) return
                      const mime = attachment.mediaType
                      onOpenView({
                        kind: 'preview',
                        preview: mime.startsWith('image/')
                          ? 'image'
                          : mime.startsWith('video/')
                            ? 'video'
                            : mime === 'text/html'
                              ? 'web'
                              : 'file',
                        title: attachment.fileName,
                        description: '随消息上传的附件，字节由服务端存证。',
                        mimeType: mime,
                        source: `你上传的附件 · ${formatRelativeTime(attachment.createdAt)}`,
                        contentUrl: api.eventAttachmentUrl(item.id),
                        backLabel: '返回工作详情',
                      })
                    }}
                    type="button"
                  >
                    <Paperclip size={14} />
                    {item.attachment.fileName}
                  </button>
                )}
                {item.text.length > 520 && (
                  <button
                    className="inline-link mt-2 inline-flex items-center gap-[5px] font-medium text-accent-ink"
                    onClick={() =>
                      setExpandedTimeline(current => {
                        const next = new Set(current)
                        if (next.has(item.key)) next.delete(item.key)
                        else next.add(item.key)
                        return next
                      })
                    }
                    type="button"
                  >
                    {expandedTimeline.has(item.key)
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
          <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
            正在读取这件事的完整时间线。
          </p>
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
      <WorkerProfileSection
        api={api}
        channel={channel}
        profile={workerProfile}
        profileError={workerProfileError}
      />
      <PermissionTierHistorySection api={api} channel={channel} />
      <ApprovalRulesSection api={api} channel={channel} />
      {confirmingStop && (
        <section
          aria-labelledby="stop-confirmation-title"
          className="stop-confirmation mt-3.5 rounded-card bg-red-tint p-4 shadow-hairline"
          role="alertdialog"
        >
          <header className="flex items-center gap-2 text-red-text">
            <AlertTriangle size={18} />
            <strong id="stop-confirmation-title">确定停止这件事？</strong>
          </header>
          <p className="mt-1.5 text-[13px] leading-[1.55] text-ink-2">
            停止后无法继续当前运行；历史记录会保留，你仍可重新发起事情。
          </p>
          {stopError && (
            <small className="mt-2 block text-red-text" role="alert">
              {stopError}
            </small>
          )}
          <div className="drawer-actions">
            <Button
              variant="secondary"
              size="sm"
              disabled={stopping}
              onClick={() => setConfirmingStop(false)}
              type="button"
            >
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={stopping}
              onClick={() => void stopChannel()}
              type="button"
            >
              {stopping ? '正在停止…' : '确认停止'}
            </Button>
          </div>
        </section>
      )}
      <footer className="drawer-footer">
        {state === '失败' && run && (
          <Button
            variant="secondary"
            size="sm"
            disabled={retrying}
            onClick={() => void retryRun()}
            type="button"
          >
            <RotateCw size={16} />
            {retrying ? '正在重试…' : '重试'}
          </Button>
        )}
        {channel.status !== 'cancelled' && onContinue && (
          <Button
            variant="accent"
            size="sm"
            onClick={() => onContinue(channel)}
            type="button"
          >
            继续追问
          </Button>
        )}
        {channel.canStop && onStop && (
          <Button
            variant="danger"
            size="sm"
            onClick={() => setConfirmingStop(true)}
            type="button"
          >
            停止事情
          </Button>
        )}
        {channel.status === 'cancelled' && (
          <span className="drawer-footnote mt-2.5 block text-[12px] leading-[1.6] text-ink-2">
            等待服务端返回下一步条件。
          </span>
        )}
        {(channel.status === 'cancelled' || channel.status === 'completed') &&
          onCreateRelated && (
            <Button
              variant="accent"
              size="sm"
              onClick={() => onCreateRelated(channel)}
              type="button"
            >
              新建相关事情
            </Button>
          )}
      </footer>
    </div>
  )
}

function Meta({ label, value }: { label: string; value?: string }) {
  const displayValue = value?.trim()
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 py-[5px]">
      <dt className="text-ink-2">{label}</dt>
      <dd className="break-words">
        {displayValue?.length ? displayValue : '服务端未提供'}
      </dd>
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
    return (
      <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
        本次交付没有可展示的证据。
      </p>
    )
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
  api,
  channelId,
  delivery,
  error,
  onOpenEvidence,
}: {
  api?: PegasApi
  channelId: string
  delivery?: TaskDelivery
  error?: string
  onOpenEvidence?: (evidence: ReviewEvidencePreview) => void
}) {
  const [historyOpen, setHistoryOpen] = useState(false)

  const [history, setHistory] = useState<{
    contracts: GoalContract[]
    reviewPacks: ReviewPack[]
  }>()
  const [historyError, setHistoryError] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyKey, setHistoryKey] = useState(channelId)
  const [expandedRevisions, setExpandedRevisions] = useState<Set<number>>(
    () => new Set(),
  )
  const [evidencePages, setEvidencePages] = useState<
    Record<number, ChannelEvidencePage>
  >({})
  const [evidenceErrors, setEvidenceErrors] = useState<Record<number, string>>(
    {},
  )
  const [evidenceBusy, setEvidenceBusy] = useState<Set<number>>(() => new Set())
  const [verifyingId, setVerifyingId] = useState('')
  const [verifyError, setVerifyError] = useState('')
  const [verifyNotice, setVerifyNotice] = useState('')
  useEffect(() => {
    if (historyKey === channelId) return
    setHistoryKey(channelId)
    setHistory(undefined)
    setHistoryError('')
    setHistoryLoading(false)
    setHistoryOpen(false)
    setExpandedRevisions(new Set())
    setEvidencePages({})
    setEvidenceErrors({})
    setEvidenceBusy(new Set())
  }, [channelId, historyKey])
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
  const pendingEvidence = (delivery?.evidence ?? []).filter(
    item => item.verification.result === 'pending',
  )
  async function toggleHistory() {
    if (!api) return
    if (historyOpen) {
      setHistoryOpen(false)
      return
    }
    setHistoryOpen(true)
    if (history || historyLoading) return
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const [contracts, reviewPacks] = await Promise.all([
        api.goalContracts(channelId),
        api.reviewPacks(channelId),
      ])
      setHistory({
        contracts: contracts.contracts,
        reviewPacks: reviewPacks.reviewPacks,
      })
    } catch (caught) {
      setHistoryError(
        caught instanceof Error ? caught.message : '读取历史修订失败。',
      )
    } finally {
      setHistoryLoading(false)
    }
  }
  async function verifyEvidence(evidenceId: string) {
    if (!api || verifyingId) return
    setVerifyingId(evidenceId)
    setVerifyError('')
    setVerifyNotice('')
    try {
      await api.verifyEvidence(evidenceId)
      setVerifyNotice('已提交可信验证；刷新事情详情可查看最新结论。')
    } catch (caught) {
      setVerifyError(
        caught instanceof Error ? caught.message : '提交可信验证失败。',
      )
    } finally {
      setVerifyingId('')
    }
  }
  function setRevisionBusy(revision: number, busy: boolean) {
    setEvidenceBusy(current => {
      const next = new Set(current)
      if (busy) next.add(revision)
      else next.delete(revision)
      return next
    })
  }
  async function loadRevisionEvidence(revision: number, cursor?: string) {
    if (!api || evidenceBusy.has(revision)) return
    setRevisionBusy(revision, true)
    setEvidenceErrors(current => ({ ...current, [revision]: '' }))
    try {
      const page = await api.taskEvidence(channelId, revision, cursor)
      setEvidencePages(current => {
        const previous = cursor ? current[revision] : undefined
        return {
          ...current,
          [revision]: {
            evidence: previous
              ? [
                  ...previous.evidence,
                  ...page.evidence.filter(
                    item =>
                      !previous.evidence.some(entry => entry.id === item.id),
                  ),
                ]
              : page.evidence,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          },
        }
      })
    } catch (caught) {
      setEvidenceErrors(current => ({
        ...current,
        [revision]:
          caught instanceof Error ? caught.message : '读取证据记录失败。',
      }))
    } finally {
      setRevisionBusy(revision, false)
    }
  }
  function toggleRevisionEvidence(revision: number) {
    if (expandedRevisions.has(revision)) {
      setExpandedRevisions(current => {
        const next = new Set(current)
        next.delete(revision)
        return next
      })
      return
    }
    setExpandedRevisions(current => new Set(current).add(revision))
    if (!evidencePages[revision]) void loadRevisionEvidence(revision)
  }
  return (
    <section className="detail-section">
      <h3>目标与交付</h3>
      {error && (
        <p
          className="settings-error mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
          role="alert"
        >
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
          <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
            还没有 Review Pack；执行完成后会按完成标准生成审查结论。
          </p>
        )
      )}
      <EvidenceGallery
        evidence={evidencePreviews}
        onOpenEvidence={onOpenEvidence}
      />
      {api && pendingEvidence.length > 0 && (
        <div className="evidence-verify">
          <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
            有 {String(pendingEvidence.length)} 条证据等待可信验证。
          </p>
          {pendingEvidence.map(item => (
            <Button
              variant="secondary"
              size="sm"
              disabled={Boolean(verifyingId)}
              key={item.id}
              onClick={() => void verifyEvidence(item.id)}
              type="button"
            >
              <ShieldCheck size={15} />
              {verifyingId === item.id
                ? '正在验证…'
                : `验证证据 ${item.id.slice(0, 8)}`}
            </Button>
          ))}
          {verifyError && (
            <p
              className="settings-error mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
              role="alert"
            >
              {verifyError}
            </p>
          )}
          {verifyNotice && (
            <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
              {verifyNotice}
            </p>
          )}
        </div>
      )}
      {api && (
        <button
          className="inline-link mt-2 inline-flex items-center gap-[5px] font-medium text-accent-ink"
          onClick={() => void toggleHistory()}
          type="button"
        >
          {historyOpen ? '收起历史修订' : '查看历史修订'}
        </button>
      )}
      {historyOpen && (
        <div className="delivery-history">
          {historyLoading && (
            <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
              正在读取历史修订。
            </p>
          )}
          {historyError && (
            <p
              className="settings-error mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
              role="alert"
            >
              {historyError}
            </p>
          )}
          {history && (
            <>
              <h4>目标修订</h4>
              {history.contracts.length ? (
                <ol className="history-list">
                  {history.contracts.map(contract => {
                    const revision = contract.revision
                    const expanded = expandedRevisions.has(revision)
                    const page = evidencePages[revision]
                    const evidenceError = evidenceErrors[revision]
                    const busy = evidenceBusy.has(revision)
                    return (
                      <li key={contract.id}>
                        <strong>
                          v{String(revision)}
                          {goal?.id === contract.id ? ' · 当前' : ''}
                        </strong>
                        <p>{contract.desiredOutcome}</p>
                        <small>{formatRelativeTime(contract.createdAt)}</small>
                        <button
                          className="inline-link mt-2 inline-flex items-center gap-[5px] font-medium text-accent-ink"
                          onClick={() => toggleRevisionEvidence(revision)}
                          type="button"
                        >
                          {expanded
                            ? `收起证据记录 v${String(revision)}`
                            : `查看证据记录 v${String(revision)}`}
                        </button>
                        {expanded && (
                          <div className="revision-evidence">
                            {busy && !page && (
                              <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
                                正在读取证据记录。
                              </p>
                            )}
                            {evidenceError && (
                              <p
                                className="settings-error mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
                                role="alert"
                              >
                                {evidenceError}
                                <button
                                  className="inline-link mt-2 inline-flex items-center gap-[5px] font-medium text-accent-ink"
                                  onClick={() =>
                                    void loadRevisionEvidence(revision)
                                  }
                                  type="button"
                                >
                                  重试
                                </button>
                              </p>
                            )}
                            {page && !evidenceError && (
                              <>
                                {page.evidence.length ? (
                                  <ul className="revision-evidence-list">
                                    {page.evidence.map(item => (
                                      <li key={item.id}>
                                        <strong>
                                          {item.kind} ·{' '}
                                          {verificationLabel(
                                            item.verification.result,
                                          )}
                                        </strong>
                                        <small>
                                          标准 {item.criterionId} · 敏感级{' '}
                                          {item.sensitivity} ·{' '}
                                          {formatRelativeTime(item.capturedAt)}
                                        </small>
                                        {item.limitations.length > 0 && (
                                          <small>
                                            局限：{item.limitations.join('；')}
                                          </small>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
                                    这个修订还没有证据记录。
                                  </p>
                                )}
                                {page.nextCursor && (
                                  <button
                                    className="inline-link mt-2 inline-flex items-center gap-[5px] font-medium text-accent-ink"
                                    disabled={busy}
                                    onClick={() => {
                                      const cursor = page.nextCursor
                                      if (cursor)
                                        void loadRevisionEvidence(
                                          revision,
                                          cursor,
                                        )
                                    }}
                                    type="button"
                                  >
                                    {busy ? '正在加载…' : '加载更多证据'}
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ol>
              ) : (
                <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
                  还没有目标修订记录。
                </p>
              )}
              <h4>Review Pack 历史</h4>
              {history.reviewPacks.length ? (
                <ol className="history-list">
                  {history.reviewPacks.map(reviewPack => (
                    <li key={reviewPack.id}>
                      <strong>
                        修订 {String(reviewPack.revision)} · 目标 v
                        {String(reviewPack.goalRevision)} ·{' '}
                        {outcomeLabel(reviewPack.finalOutcome)}
                      </strong>
                      <p>
                        按 {String(reviewPack.criteria.length)} 条完成标准审查
                        {reviewPack.remainingRisks.length > 0
                          ? `；剩余风险：${reviewPack.remainingRisks.join('；')}`
                          : ''}
                      </p>
                      <small>{formatRelativeTime(reviewPack.createdAt)}</small>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
                  还没有 Review Pack 历史。
                </p>
              )}
            </>
          )}
        </div>
      )}
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
    <div className="drawer-body bui">
      <StateHeader
        label={
          review.finalOutcome === 'completed'
            ? '已完成'
            : review.finalOutcome === 'partial'
              ? '待确认'
              : '失败'
        }
        tone={
          review.finalOutcome === 'completed'
            ? 'green'
            : review.finalOutcome === 'partial'
              ? 'orange'
              : 'red'
        }
      >
        <h3 className="m-0 text-[13px] font-medium text-ink">
          目标修订 v{String(review.goalRevision)} 的交付审查
        </h3>
        <p className="mt-1">
          {outcomeLabel(review.finalOutcome)}
          ：结论来自服务端 Review Pack，按完成标准与证据生成。
        </p>
      </StateHeader>
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
          <pre className="approval-result mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-control bg-inset px-3 py-2.5 text-[12.5px] text-ink-2">
            {JSON.stringify(review.rollback, null, 2)}
          </pre>
        </section>
      )}
      <footer className="drawer-footer">
        {onOpenTask && (
          <Button variant="accent" size="sm" onClick={onOpenTask} type="button">
            打开事情详情与审计时间线
          </Button>
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
    <div className="drawer-body bui">
      <section className="approval-card mt-3.5 grid gap-2.5 rounded-card bg-surface p-4 shadow-card">
        <header className="flex items-center gap-2">
          <ShieldCheck size={20} />
          <strong>Pegas 需要先确认这些问题</strong>
        </header>
        <p className="text-[13px] leading-[1.55] text-ink-2">
          这些信息会实质改变结果、权限或风险。回答后 Pegas
          会按当前目标修订继续执行，不会丢失已有进展。
        </p>
      </section>
      <section className="detail-section">
        <h3>待澄清问题</h3>
        <ol
          aria-label="待澄清问题"
          className="clarification-questions grid list-decimal gap-2 pl-[22px] text-[13px] leading-[1.6]"
        >
          {questions.map((question, index) => (
            <li key={`${String(index)}-${question}`}>{question}</li>
          ))}
        </ol>
      </section>
      <footer className="drawer-footer">
        {onAnswer && (
          <Button variant="accent" size="sm" onClick={onAnswer} type="button">
            去回答
          </Button>
        )}
        {onOpenTask && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onOpenTask}
            type="button"
          >
            查看事情详情
          </Button>
        )}
      </footer>
    </div>
  )
}

function RoutingClarificationDetail({
  view,
  onAnswer,
}: {
  view: Extract<DrawerView, { kind: 'routingClarification' }>
  onAnswer?: () => void
}) {
  return (
    <div className="drawer-body bui">
      <section className="approval-card mt-3.5 grid gap-2.5 rounded-card bg-surface p-4 shadow-card">
        <header className="flex items-center gap-2">
          <CircleQuestionMark size={20} />
          <strong>Pegas 需要先确认这条消息的归属</strong>
        </header>
        <p className="text-[13px] leading-[1.55] text-ink-2">
          这条消息还没有进入任何事情。回答后 Pegas
          会重新判断归属，不会丢失原始消息。
        </p>
      </section>
      <section className="detail-section">
        <h3>待确认问题</h3>
        <p>{view.question}</p>
      </section>
      {view.input && (
        <section className="detail-section">
          <h3>原始消息</h3>
          <p>{view.input}</p>
        </section>
      )}
      <footer className="drawer-footer">
        {onAnswer && (
          <Button variant="accent" size="sm" onClick={onAnswer} type="button">
            去回答
          </Button>
        )}
      </footer>
    </div>
  )
}

function CollaborationSection({
  collaborations,
  error,
  onOpenTarget,
}: {
  collaborations: ChannelRelation[]
  error?: string
  onOpenTarget?: (targetTaskId: string) => Promise<void>
}) {
  const [openingId, setOpeningId] = useState('')
  const [openError, setOpenError] = useState('')
  const relationKey = collaborations.map(relation => relation.id).join(',')
  useEffect(() => {
    setOpenError('')
    setOpeningId('')
  }, [relationKey])
  async function openTarget(targetTaskId: string) {
    if (!onOpenTarget || openingId) return
    setOpeningId(targetTaskId)
    setOpenError('')
    try {
      await onOpenTarget(targetTaskId)
    } catch (caught) {
      setOpenError(
        caught instanceof Error ? caught.message : '打开目标事情失败。',
      )
    } finally {
      setOpeningId('')
    }
  }
  const childrenByParent = new Map<string, ChannelRelation[]>()
  for (const relation of collaborations) {
    if (relation.parentRelationId) {
      const siblings = childrenByParent.get(relation.parentRelationId) ?? []
      siblings.push(relation)
      childrenByParent.set(relation.parentRelationId, siblings)
    }
  }
  function renderRelation(relation: ChannelRelation) {
    const children = childrenByParent.get(relation.id) ?? []
    return (
      <li key={relation.id}>
        <strong>
          {collaborationKindLabel(relation.kind)} ·{' '}
          {collaborationStatusLabel(relation.status)}
          {relation.depth > 0 ? ` · 第 ${String(relation.depth)} 层` : ''}
        </strong>
        <p>{collaborationRequestText(relation)}</p>
        {relation.result && (
          <small>
            结果：
            {relation.result.outcome === 'completed'
              ? '已完成'
              : relation.result.outcome === 'failed'
                ? '失败'
                : '已取消'}
            {relation.result.summary ? ` · ${relation.result.summary}` : ''}
          </small>
        )}
        {relation.targetTaskId && (
          <small>目标事情：{relation.targetTaskId.slice(0, 8)}</small>
        )}
        {relation.targetTaskId && onOpenTarget && (
          <button
            className="inline-link mt-2 inline-flex items-center gap-[5px] font-medium text-accent-ink"
            disabled={Boolean(openingId)}
            onClick={() => {
              const targetTaskId = relation.targetTaskId
              if (!targetTaskId) return
              void openTarget(targetTaskId)
            }}
            type="button"
          >
            {openingId === relation.targetTaskId ? '正在打开…' : '打开目标事情'}
          </button>
        )}
        <small>
          {formatRelativeTime(relation.settledAt ?? relation.updatedAt)}
        </small>
        {children.length > 0 && (
          <ol className="collaboration-list is-nested">
            {children.map(child => renderRelation(child))}
          </ol>
        )}
      </li>
    )
  }
  const relationIds = new Set(collaborations.map(relation => relation.id))
  const roots = collaborations.filter(
    relation =>
      !relation.parentRelationId || !relationIds.has(relation.parentRelationId),
  )
  return (
    <section className="detail-section">
      <h3>协作记录</h3>
      {error && (
        <p
          className="settings-error mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
          role="alert"
        >
          {error}
        </p>
      )}
      {openError && (
        <p
          className="settings-error mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
          role="alert"
        >
          {openError}
        </p>
      )}
      {collaborations.length > 0 && (
        <ol className="collaboration-list">
          {roots.map(relation => renderRelation(relation))}
        </ol>
      )}
    </section>
  )
}

function collaborationKindLabel(kind: ChannelRelation['kind']): string {
  const labels: Record<ChannelRelation['kind'], string> = {
    delegate: '委派',
    handoff: '交接',
    context_note: '上下文注记',
    handback: '交回',
  }
  return labels[kind]
}

function collaborationStatusLabel(status: ChannelRelation['status']): string {
  const labels: Record<ChannelRelation['status'], string> = {
    pending: '等待接收',
    active: '进行中',
    returned: '已交回',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }
  return labels[status]
}

function collaborationRequestText(relation: ChannelRelation): string {
  const request = relation.request
  if (request.kind === 'context_note') return request.text
  if (request.kind === 'handback') return request.reason
  return request.goal
}

function WorkerProfileSection({
  api,
  channel,
  profile,
  profileError,
}: {
  api?: PegasApi
  channel: Extract<DrawerView, { kind: 'task' }>['channel']
  profile?: WorkerProfileResponse
  profileError?: string
}) {
  const [response, setResponse] = useState<WorkerProfileResponse>()
  const [catalog, setCatalog] = useState<DshModelCatalog>()
  const [catalogError, setCatalogError] = useState('')
  const [modelMode, setModelMode] = useState<'inherit' | 'override'>('inherit')
  const [modelKey, setModelKey] = useState('')
  const [pool, setPool] = useState<'' | 'fast' | 'balanced' | 'deep'>('')
  const [effort, setEffort] = useState('')
  const [permissionMode, setPermissionMode] = useState<
    'inherit' | 'strict' | 'standard' | 'full'
  >('inherit')
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveNotice, setSaveNotice] = useState('')
  const [catalogLoading, setCatalogLoading] = useState(false)
  const current = response ?? profile
  const profileKey = current
    ? `${current.profile.id}:${String(current.profile.revision)}:${current.profile.modelMode}:${current.profile.modelProvider ?? ''}:${current.profile.modelName ?? ''}:${current.profile.pool ?? ''}:${current.profile.effort ?? ''}:${current.profile.permissionMode ?? 'inherit'}`
    : ''
  useEffect(() => {
    setResponse(undefined)
    setSaveError('')
    setSaveNotice('')
  }, [channel.id])
  useEffect(() => {
    if (!profileKey) return
    const [
      ,
      ,
      mode = 'inherit',
      provider = '',
      name = '',
      savedPool = '',
      savedEffort = '',
      savedPermission = 'inherit',
    ] = profileKey.split(':')
    setModelMode(mode === 'override' ? 'override' : 'inherit')
    setModelKey(
      mode === 'override' && provider && name ? `${provider}/${name}` : '',
    )
    setPool(
      savedPool === 'fast' || savedPool === 'balanced' || savedPool === 'deep'
        ? savedPool
        : '',
    )
    setEffort(savedEffort)
    setPermissionMode(
      savedPermission === 'strict' ||
        savedPermission === 'standard' ||
        savedPermission === 'full'
        ? savedPermission
        : 'inherit',
    )
  }, [profileKey])
  const readOnly = channel.status === 'cancelled'
  if (!current && !profileError) return null
  const selectedModel = catalog?.models.find(
    model => `${model.provider}/${model.id}` === modelKey,
  )
  async function loadCatalog() {
    if (!api) return
    setCatalogLoading(true)
    try {
      const loaded = await api.agentModels()
      setCatalog(loaded)
      setCatalogError('')
      setModelKey(
        currentKey =>
          currentKey || `${loaded.defaultProvider}/${loaded.defaultModel}`,
      )
    } catch (caught) {
      setCatalogError(
        caught instanceof Error ? caught.message : '读取执行模型目录失败。',
      )
    } finally {
      setCatalogLoading(false)
    }
  }
  async function openEditor(nextMode: 'inherit' | 'override') {
    setModelMode(nextMode)
    setSaveError('')
    setSaveNotice('')
    if (!api || nextMode !== 'override' || catalog) return
    await loadCatalog()
  }
  async function save(skipFullAccessConfirmation = false) {
    if (!api || !current || saving) return
    if (modelMode === 'override' && !selectedModel) {
      setSaveError('请选择一个目录中可用的执行模型。')
      return
    }
    if (
      permissionMode === 'full' &&
      current.profile.permissionMode !== 'full' &&
      !skipFullAccessConfirmation
    ) {
      setConfirmingFullAccess(true)
      return
    }
    setSaving(true)
    setSaveError('')
    setSaveNotice('')
    try {
      const saved = await api.saveWorkerProfile(channel.id, {
        expectedRevision: current.profile.revision,
        modelMode,
        ...(modelMode === 'override' && selectedModel
          ? {
              modelProvider: selectedModel.provider,
              modelName: selectedModel.id,
            }
          : {}),
        ...(modelMode === 'inherit' && pool ? { pool } : {}),
        ...(effort.trim() ? { effort: effort.trim() } : {}),
        permissionMode,
      })
      setResponse(saved)
      setSaveNotice('执行设置已保存，对后续运行生效。')
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setSaveError(
          '保存冲突：这条设置已在别处更新或事情已归档。正在读取最新设置。',
        )
        try {
          setResponse(await api.workerProfile(channel.id))
        } catch {
          setSaveError('保存冲突，且读取最新设置失败；请重新打开详情后重试。')
        }
      } else {
        setSaveError(
          caught instanceof Error ? caught.message : '保存执行设置失败。',
        )
      }
    } finally {
      setSaving(false)
    }
  }
  return (
    <section className="detail-section worker-profile-section">
      <h3>事情级执行设置</h3>
      {profileError && (
        <p
          className="settings-error mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
          role="alert"
        >
          {profileError}
        </p>
      )}
      {current && (
        <>
          <div className="metadata-list">
            <dl>
              <Meta label="生效模型" value={current.effective.modelRef} />
              <Meta
                label="设置来源"
                value={
                  current.effective.source === 'task'
                    ? '这件事情的覆盖设置'
                    : 'Pegas 全局设置'
                }
              />
              <Meta
                label="设置版本"
                value={`v${String(current.profile.revision)}`}
              />
              {current.effective.pool && (
                <Meta label="执行池" value={current.effective.pool} />
              )}
              {current.effective.effort && (
                <Meta label="推理档位" value={current.effective.effort} />
              )}
              <Meta
                label="权限档位"
                value={`${permissionTierLabel(current.effective.permissionTier)} · ${
                  current.effective.permissionSource === 'task'
                    ? '这件事情的覆盖设置'
                    : 'Pegas 全局设置'
                }`}
              />
            </dl>
          </div>
          {readOnly || !api ? (
            <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
              {readOnly
                ? '事情已归档，执行设置为只读。'
                : '当前为只读预览，无法修改执行设置。'}
            </p>
          ) : (
            <>
              <FormField
                className="my-3.5"
                htmlFor="task-model-mode"
                label="执行模型"
              >
                <Select
                  disabled={saving}
                  onValueChange={value =>
                    void openEditor(
                      value === 'override' ? 'override' : 'inherit',
                    )
                  }
                  value={modelMode}
                >
                  <SelectTrigger
                    className="h-10 w-full rounded-control bg-field shadow-inset-field hover:bg-field"
                    id="task-model-mode"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">跟随 Pegas 全局设置</SelectItem>
                    <SelectItem value="override">为这件事情指定模型</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              {modelMode === 'inherit' && (
                <FormField
                  className="my-3.5"
                  htmlFor="task-pool"
                  label="执行池"
                >
                  <Select
                    disabled={saving}
                    onValueChange={value =>
                      setPool(
                        value === 'fast' ||
                          value === 'balanced' ||
                          value === 'deep'
                          ? value
                          : '',
                      )
                    }
                    value={pool || 'default'}
                  >
                    <SelectTrigger
                      className="h-10 w-full rounded-control bg-field shadow-inset-field hover:bg-field"
                      id="task-pool"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">
                        不指定（全局默认）
                      </SelectItem>
                      <SelectItem value="fast">fast · 轻快省</SelectItem>
                      <SelectItem value="balanced">balanced · 均衡</SelectItem>
                      <SelectItem value="deep">deep · 深度</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
              )}
              <FormField
                className="my-3.5"
                htmlFor="task-effort"
                label="推理档位"
              >
                <Select
                  disabled={saving}
                  onValueChange={value =>
                    setEffort(value === 'default' ? '' : value)
                  }
                  value={effort || 'default'}
                >
                  <SelectTrigger
                    className="h-10 w-full rounded-control bg-field shadow-inset-field hover:bg-field"
                    id="task-effort"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">跟随模型默认</SelectItem>
                    <SelectItem value="low">low · 轻快</SelectItem>
                    <SelectItem value="medium">medium · 均衡</SelectItem>
                    <SelectItem value="high">high · 深入</SelectItem>
                    <SelectItem value="max">max · 全力</SelectItem>
                    {effort &&
                      !['low', 'medium', 'high', 'max'].includes(effort) && (
                        <SelectItem value={effort}>{effort}</SelectItem>
                      )}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField
                className="my-3.5"
                htmlFor="task-permission-tier"
                label="权限档位"
              >
                <Select
                  disabled={saving}
                  onValueChange={value =>
                    setPermissionMode(
                      value === 'strict' ||
                        value === 'standard' ||
                        value === 'full'
                        ? value
                        : 'inherit',
                    )
                  }
                  value={permissionMode}
                >
                  <SelectTrigger
                    className="h-10 w-full rounded-control bg-field shadow-inset-field hover:bg-field"
                    id="task-permission-tier"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">跟随 Pegas 全局设置</SelectItem>
                    <SelectItem value="standard">
                      标准 · 区内放行，越界审批
                    </SelectItem>
                    <SelectItem value="strict">
                      严格 · 只读，写与网络都审批
                    </SelectItem>
                    <SelectItem value="full">
                      完全访问 · 显式风险披露
                    </SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
                收紧对下一次工具调用立即生效；放宽只影响后续运行，不越过已排队运行的能力上限。
              </p>
              {modelMode === 'override' && (
                <div className="my-3.5 grid gap-1.5">
                  <span className="text-[13px] font-medium text-ink">
                    指定模型
                  </span>
                  <ModelPicker
                    ariaLabel="指定模型"
                    disabled={saving || !catalog}
                    footer="选择后仍需点击「保存执行设置」生效"
                    models={catalog?.models ?? []}
                    onSelect={(_, model) => {
                      if (model) setModelKey(`${model.provider}/${model.id}`)
                    }}
                    placeholder={catalog ? '选择模型' : '正在读取模型目录…'}
                    value={
                      selectedModel
                        ? `${selectedModel.provider}::${selectedModel.id}`
                        : ''
                    }
                  />
                </div>
              )}
              {catalogError && (
                <div
                  className="settings-error mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
                  role="alert"
                >
                  {catalogError}
                  <button
                    disabled={catalogLoading}
                    onClick={() => void loadCatalog()}
                    type="button"
                  >
                    {catalogLoading ? '重试中…' : '重试'}
                  </button>
                </div>
              )}
              {saveError && (
                <p
                  className="settings-error mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
                  role="alert"
                >
                  {saveError}
                </p>
              )}
              {saveNotice && (
                <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
                  {saveNotice}
                </p>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={
                  saving || (modelMode === 'override' && !selectedModel)
                }
                onClick={() => void save()}
                type="button"
              >
                {saving ? '正在保存…' : '保存执行设置'}
              </Button>
              <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
                只影响这件事情的后续运行；已完成的运行记录不会改写。
              </p>
            </>
          )}
        </>
      )}
      {confirmingFullAccess && (
        <div
          aria-labelledby="full-access-risk-title"
          aria-modal="true"
          className="stop-confirmation mt-3.5 rounded-card bg-red-tint p-4 shadow-hairline"
          role="dialog"
        >
          <header className="flex items-center gap-2 text-red-text">
            <AlertTriangle size={18} />
            <strong id="full-access-risk-title">确认完全访问风险</strong>
          </header>
          <p className="mt-1.5 text-[13px] leading-[1.55] text-ink-2">
            完全访问档位下，Pegas 不再拦截工作区之外的写入与命令副作用；
            高风险动作仍会请求你的审批，控制面自修改仍被强制拦截。
            请只在你信任这件事情的完整目标时启用。
          </p>
          <div className="stop-confirmation-actions mt-3 flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirmingFullAccess(false)}
              type="button"
            >
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setConfirmingFullAccess(false)
                void save(true)
              }}
              type="button"
            >
              我已了解，启用完全访问
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

function permissionTierLabel(tier?: 'strict' | 'standard' | 'full') {
  if (tier === 'strict') return '严格'
  if (tier === 'full') return '完全访问'
  return '标准'
}

function permissionChangeTierLabel(
  tier?: 'inherit' | 'strict' | 'standard' | 'full',
) {
  if (tier === 'inherit' || tier === undefined) return '跟随全局'
  return permissionTierLabel(tier)
}

function PermissionTierHistorySection({
  api,
  channel,
}: {
  api?: PegasApi
  channel: Extract<DrawerView, { kind: 'task' }>['channel']
}) {
  const [changes, setChanges] = useState<PermissionTierChange[]>()
  const [loadError, setLoadError] = useState('')
  useEffect(() => {
    setChanges(undefined)
    setLoadError('')
    if (!api) return
    let cancelled = false
    api
      .permissionTierChanges(channel.id)
      .then(loaded => {
        if (!cancelled) setChanges(loaded)
      })
      .catch((caught: unknown) => {
        if (!cancelled)
          setLoadError(
            caught instanceof Error ? caught.message : '权限变更记录读取失败。',
          )
      })
    return () => {
      cancelled = true
    }
  }, [api, channel.id])
  if (!api || (changes?.length === 0 && !loadError)) return null
  return (
    <section className="detail-section">
      <h3>权限变更记录</h3>
      {loadError ? (
        <p
          className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-red-text"
          role="alert"
        >
          {loadError}
        </p>
      ) : !changes ? (
        <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
          正在读取权限变更记录…
        </p>
      ) : (
        <ul className="permission-history-list">
          {changes.map(change => (
            <li className="permission-history-item" key={change.commandId}>
              <strong>
                {permissionChangeTierLabel(change.previousPermissionMode)} →{' '}
                {permissionChangeTierLabel(change.permissionMode)} · v
                {String(change.revision)}
              </strong>
              <small>{formatRelativeTime(change.createdAt)}</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ApprovalRulesSection({
  api,
  channel,
}: {
  api?: PegasApi
  channel: Extract<DrawerView, { kind: 'task' }>['channel']
}) {
  const [rules, setRules] = useState<ApprovalRule[]>()
  const [loadError, setLoadError] = useState('')
  const [revokingId, setRevokingId] = useState('')
  const [revokeError, setRevokeError] = useState('')
  useEffect(() => {
    setRules(undefined)
    setLoadError('')
    setRevokeError('')
    if (!api) return
    let cancelled = false
    api
      .approvalRules(channel.id)
      .then(loaded => {
        if (!cancelled) setRules(loaded)
      })
      .catch((caught: unknown) => {
        if (!cancelled)
          setLoadError(
            caught instanceof Error ? caught.message : '规则读取失败。',
          )
      })
    return () => {
      cancelled = true
    }
  }, [api, channel.id])
  if (!api) return null
  async function revoke(rule: ApprovalRule) {
    if (!api || revokingId) return
    setRevokingId(rule.id)
    setRevokeError('')
    try {
      const updated = await api.revokeApprovalRule(channel.id, rule.id)
      setRules(current =>
        current?.map(item => (item.id === updated.id ? updated : item)),
      )
    } catch (caught) {
      setRevokeError(
        caught instanceof Error ? caught.message : '撤销失败，请重试。',
      )
    } finally {
      setRevokingId('')
    }
  }
  return (
    <section className="detail-section">
      <h3>已批准规则</h3>
      {loadError ? (
        <p
          className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-red-text"
          role="alert"
        >
          {loadError}
        </p>
      ) : !rules ? (
        <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
          正在读取规则…
        </p>
      ) : rules.length === 0 ? (
        <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
          还没有持久规则。批准审批时选择「本事情内同类不再询问」会在这里生成可撤销的规则。
        </p>
      ) : (
        <ul className="approval-rule-list">
          {rules.map(rule => (
            <li className="approval-rule-item" key={rule.id}>
              <div>
                <strong>
                  {rule.tool} · {approvalRuleCategoryLabel(rule.category)}
                </strong>
                <small>{rule.targets.join('、')}</small>
                <small>
                  {rule.status === 'active'
                    ? `生效中 · ${formatRelativeTime(rule.createdAt)}批准`
                    : `已撤销${rule.revokedAt ? ` · ${formatRelativeTime(rule.revokedAt)}` : ''}`}
                </small>
              </div>
              {rule.status === 'active' && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={revokingId !== ''}
                  onClick={() => void revoke(rule)}
                  type="button"
                >
                  {revokingId === rule.id ? '撤销中…' : '撤销规则'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {revokeError && (
        <p
          className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-red-text"
          role="alert"
        >
          {revokeError}
        </p>
      )}
    </section>
  )
}

function approvalRuleCategoryLabel(category: string): string {
  if (category === 'out-of-workspace-write') return '工作区外写入'
  if (category === 'network-egress') return '对外网络发送'
  return category
}

function approvalReviewLabel(
  review: NonNullable<DurableAction['review']>,
): string {
  if (review.decision === 'allow') {
    return '自动审阅已按你的原话授权放行本次操作。'
  }
  if (review.decision === 'deny') {
    return review.reason
      ? `自动审阅未放行：${review.reason}`
      : '自动审阅未放行，需要你亲自决定。'
  }
  return '自动审阅未能给出结论，需要你亲自决定。'
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
function stateTone(state: string): FactTone {
  if (state === '已完成') return 'green'
  if (state === '已安排') return 'accent'
  if (state === '失败') return 'red'
  if (state === '进行中') return 'accent'
  if (state === '待确认') return 'orange'
  return 'neutral'
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
  if (state === '已安排') return '已安排，自动化仍会按周期推进'
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
  if (state === '已安排')
    return '这一轮运行已结束，但事情还挂着启用中的自动化；后续触发会继续在这里更新。'
  if (state === '失败') return '查看服务端返回的原因后，可以创建一次重试。'
  if (state === '进行中') return '离开页面不会中断执行；状态由服务端持续保存。'
  if (state === '已归档') return '归档内容仍保留在服务端。'
  return '上下文已保存，服务端尚未返回可执行的下一步。'
}

interface DelegationDetail {
  description?: string
  prompt?: string
  name?: string
  result?: string
}

function parseDelegation(detail: string | undefined): DelegationDetail {
  if (!detail) return {}
  const separator = detail.indexOf('\n[结果]\n')
  const inputText = separator >= 0 ? detail.slice(0, separator) : detail
  const result = separator >= 0 ? detail.slice(separator + 5) : undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(inputText)
  } catch {
    return { prompt: inputText, ...(result ? { result } : {}) }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { prompt: inputText, ...(result ? { result } : {}) }
  }
  const value = parsed as Record<string, unknown>
  return {
    ...(typeof value.description === 'string'
      ? { description: value.description }
      : {}),
    ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(result ? { result } : {}),
  }
}

function SubagentCard({
  delegation,
  entry,
  runId,
  subagents,
  subagentError,
  onLoadSubagents,
}: {
  delegation: DelegationDetail
  entry: RunActivityEntry
  runId?: string
  subagents?: SubagentTranscript[]
  subagentError?: string
  onLoadSubagents?: (runId: string) => void
}) {
  const children = matchDelegationChildren(delegation, subagents ?? [])
  return (
    <li className="transcript-subagent">
      <details>
        <summary>
          <Network size={13} />
          <span>
            子任务 · {delegation.description ?? delegation.name ?? '委派'}
            {entry.status === 'error' && (
              <em className="transcript-error">失败</em>
            )}
            {entry.status === 'started' && (
              <em className="transcript-pending">执行中</em>
            )}
          </span>
          <small>{formatRelativeTime(entry.createdAt)}</small>
        </summary>
        {delegation.prompt && (
          <details className="subagent-prompt">
            <summary>任务书</summary>
            <pre className="transcript-detail">{delegation.prompt}</pre>
          </details>
        )}
        {delegation.result && (
          <div className="transcript-markdown">
            <MarkdownMessage content={delegation.result} />
          </div>
        )}
        {subagentError && (
          <p
            className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-red-text"
            role="alert"
          >
            子任务执行记录读取失败：{subagentError}
          </p>
        )}
        {children.length > 0 ? (
          children.map(child => (
            <details className="subagent-transcript" key={child.sessionId}>
              <summary>
                子 agent 执行记录 · 工具{' '}
                {child.entries.filter(item => item.kind === 'tool_call').length}{' '}
                次{child.truncated && ' · 仅显示部分记录'}
              </summary>
              <ActivityTimeline entries={child.entries} />
            </details>
          ))
        ) : (
          <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
            {entry.status === 'started'
              ? '子 agent 运行中；执行记录会随运行持续留存，可稍后重新读取。'
              : '没有留存子 agent 执行记录（旧版本运行或日志不可读）。'}
            {runId && onLoadSubagents && (
              <button
                className="inline-link mt-2 inline-flex items-center gap-[5px] font-medium text-accent-ink"
                onClick={() => onLoadSubagents(runId)}
                type="button"
              >
                重新读取
              </button>
            )}
          </p>
        )}
      </details>
    </li>
  )
}

/**
 * Correlate one delegation tool-call with its child sessions. The child's
 * durable descriptor label mirrors the delegation `description`, and its
 * first user message mirrors the delegated `prompt`; either exact match is
 * authoritative. When no child carries correlation fields (older records),
 * fall back to showing every child rather than hiding real work.
 */
function matchDelegationChildren(
  delegation: DelegationDetail,
  subagents: SubagentTranscript[],
): SubagentTranscript[] {
  const matched = subagents.filter(child => {
    if (
      delegation.description &&
      child.label &&
      child.label === delegation.description
    ) {
      return true
    }
    if (delegation.prompt && child.prompt) {
      return (
        child.prompt === delegation.prompt ||
        child.prompt.startsWith(delegation.prompt) ||
        delegation.prompt.startsWith(child.prompt)
      )
    }
    return false
  })
  if (matched.length > 0) return matched
  const correlatable = subagents.some(
    child => child.label !== undefined || child.prompt !== undefined,
  )
  return correlatable ? [] : subagents
}

function RuntimeDetail({
  run,
  nodes,
  nodesError,
}: {
  run?: Run
  nodes?: ExecutionNode[]
  nodesError?: string
}) {
  return (
    <div className="drawer-body bui">
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
      <section className="detail-section">
        <h3>已注册执行节点</h3>
        {nodesError ? (
          <p
            className="settings-error mb-3 rounded-card bg-red-tint px-3 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_color-mix(in_srgb,var(--red)_22%,transparent)]"
            role="alert"
          >
            {nodesError}
          </p>
        ) : !nodes ? (
          <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
            正在读取执行节点。
          </p>
        ) : nodes.length ? (
          <ol className="execution-node-list">
            {nodes.map(node => (
              <li key={node.id}>
                <span>
                  <Network size={17} />
                </span>
                <div>
                  <strong>{node.label}</strong>
                  <small>
                    {node.capabilities.length
                      ? node.capabilities.join(' · ')
                      : '未声明能力'}
                  </small>
                  <small>
                    最近心跳：{formatRelativeTime(node.lastHeartbeatAt)}
                  </small>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="drawer-footnote mt-2.5 text-[12px] leading-[1.6] text-ink-2">
            还没有 Worker 注册为执行节点；控制面自身仍可执行事情。
          </p>
        )}
      </section>
      <div className="my-3 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2">
        <LockKeyhole size={16} />
        这里只展示服务端已记录的执行快照；未返回的字段不会推断。
      </div>
    </div>
  )
}

function RuleDetail({
  api,
  onClose,
  view,
}: {
  api?: PegasApi
  onClose: () => void
  view: Extract<DrawerView, { kind: 'rule' }>
}) {
  const editing = view.rule
  const [title, setTitle] = useState(editing?.title ?? '')
  const [content, setContent] = useState(editing?.content ?? '')
  const [enabled, setEnabled] = useState(editing?.enabled ?? true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState('')
  const valid = title.trim().length > 0 && content.trim().length > 0
  async function save() {
    if (!api || saving || !valid) return
    setSaving(true)
    setError('')
    try {
      const draft = {
        title: title.trim(),
        content: content.trim(),
        enabled,
      }
      if (editing) await api.updateWorkRule(editing.id, editing.revision, draft)
      else await api.createWorkRule(draft)
      view.onSaved?.()
      onClose()
      return
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409)
        setError(
          '保存冲突：这条规则已在别处更新或删除。请关闭后重新打开最新状态。',
        )
      else setError(caught instanceof Error ? caught.message : '保存规则失败。')
    } finally {
      setSaving(false)
    }
  }
  async function remove() {
    if (!api || !editing || deleting) return
    setDeleting(true)
    setError('')
    try {
      await api.deleteWorkRule(editing.id, editing.revision)
      view.onSaved?.()
      onClose()
      return
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409)
        setError('删除冲突：这条规则已在别处更新。请关闭后重新打开最新状态。')
      else setError(caught instanceof Error ? caught.message : '删除规则失败。')
    } finally {
      setDeleting(false)
    }
  }
  return (
    <div className="drawer-body bui">
      <div className="my-3 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2">
        <CircleHelp size={16} />
        规则以持久偏好的形式注入每次执行，不授予新权限，也不能绕过高风险动作确认。
      </div>
      {!api && (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_var(--red)]"
          role="alert"
        >
          未连接服务端，无法保存规则。
        </div>
      )}
      <FormField className="my-3.5" label="规则名称">
        <TextInput
          className="h-10 w-full"
          disabled={saving || deleting}
          onChange={event => setTitle(event.target.value)}
          placeholder="例如：发布前先说明回滚路径"
          value={title}
        />
      </FormField>
      <FormField className="my-3.5" label="规则内容">
        <TextArea
          className="w-full resize-y"
          disabled={saving || deleting}
          onChange={event => setContent(event.target.value)}
          placeholder="描述你希望执行 Agent 持续遵守的工作方式。"
          rows={7}
          value={content}
        />
      </FormField>
      <div className="switch-row bui flex items-center justify-between py-3">
        <span className="text-[13px] text-ink">启用这条规则</span>
        <Switch
          checked={enabled}
          disabled={saving || deleting}
          label="启用这条规则"
          onChange={setEnabled}
        />
      </div>
      {error && (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_var(--red)]"
          role="alert"
        >
          {error}
        </div>
      )}
      <footer className="drawer-footer">
        {editing &&
          (confirmDelete ? (
            <Button
              variant="danger"
              size="sm"
              disabled={deleting}
              onClick={() => void remove()}
              type="button"
            >
              {deleting ? '删除中…' : '确认删除'}
            </Button>
          ) : (
            <Button
              variant="quiet"
              size="sm"
              disabled={saving || deleting}
              onClick={() => setConfirmDelete(true)}
              type="button"
            >
              删除规则
            </Button>
          ))}
        <Button
          variant="accent"
          size="sm"
          disabled={!api || saving || deleting || !valid}
          onClick={() => void save()}
          type="button"
        >
          {saving ? '保存中…' : '保存规则'}
        </Button>
      </footer>
    </div>
  )
}

function RoutingRuleDetail({
  api,
  onClose,
  view,
}: {
  api?: PegasApi
  onClose: () => void
  view: Extract<DrawerView, { kind: 'routingRule' }>
}) {
  const editing = view.rule
  const [title, setTitle] = useState(editing?.title ?? '')
  const [content, setContent] = useState(editing?.content ?? '')
  const [enabled, setEnabled] = useState(editing?.enabled ?? true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState('')
  const valid = title.trim().length > 0 && content.trim().length > 0
  async function save() {
    if (!api || saving || !valid) return
    setSaving(true)
    setError('')
    try {
      const draft = {
        title: title.trim(),
        content: content.trim(),
        enabled,
      }
      if (editing)
        await api.updateRoutingRule(editing.id, editing.revision, draft)
      else await api.createRoutingRule(draft)
      view.onSaved?.()
      onClose()
      return
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409)
        setError(
          '保存冲突：这条规则已在别处更新或删除。请关闭后重新打开最新状态。',
        )
      else setError(caught instanceof Error ? caught.message : '保存规则失败。')
    } finally {
      setSaving(false)
    }
  }
  async function remove() {
    if (!api || !editing || deleting) return
    setDeleting(true)
    setError('')
    try {
      await api.deleteRoutingRule(editing.id, editing.revision)
      view.onSaved?.()
      onClose()
      return
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409)
        setError('删除冲突：这条规则已在别处更新。请关闭后重新打开最新状态。')
      else setError(caught instanceof Error ? caught.message : '删除规则失败。')
    } finally {
      setDeleting(false)
    }
  }
  return (
    <div className="drawer-body bui">
      <div className="my-3 flex items-center gap-2 rounded-control bg-accent-tint px-3 py-2.5 text-[12px] leading-[1.6] text-ink-2">
        <CircleHelp size={16} />
        归类规则只影响「消息进哪个事情」的判断偏好，不授予新权限；已停止的事情不会自动恢复，控制指令仍走确定性链路。规则仅在「智能判断」模式下生效。
      </div>
      {!api && (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_var(--red)]"
          role="alert"
        >
          未连接服务端，无法保存规则。
        </div>
      )}
      <FormField className="my-3.5" label="规则名称">
        <TextInput
          className="h-10 w-full"
          disabled={saving || deleting}
          onChange={event => setTitle(event.target.value)}
          placeholder="例如：提到 X 项目优先进 X 事情"
          value={title}
        />
      </FormField>
      <FormField className="my-3.5" label="规则内容">
        <TextArea
          className="w-full resize-y"
          disabled={saving || deleting}
          onChange={event => setContent(event.target.value)}
          placeholder="描述你希望消息归属遵循的偏好，例如某类消息优先进哪个事情。"
          rows={7}
          value={content}
        />
      </FormField>
      <div className="switch-row bui flex items-center justify-between py-3">
        <span className="text-[13px] text-ink">启用这条规则</span>
        <Switch
          checked={enabled}
          disabled={saving || deleting}
          label="启用这条规则"
          onChange={setEnabled}
        />
      </div>
      {error && (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-card bg-red-tint px-3.5 py-2.5 text-[13px] text-red-text shadow-[0_0_0_1px_var(--red)]"
          role="alert"
        >
          {error}
        </div>
      )}
      <footer className="drawer-footer">
        {editing &&
          (confirmDelete ? (
            <Button
              variant="danger"
              size="sm"
              disabled={deleting}
              onClick={() => void remove()}
              type="button"
            >
              {deleting ? '删除中…' : '确认删除'}
            </Button>
          ) : (
            <Button
              variant="quiet"
              size="sm"
              disabled={saving || deleting}
              onClick={() => setConfirmDelete(true)}
              type="button"
            >
              删除规则
            </Button>
          ))}
        <Button
          variant="accent"
          size="sm"
          disabled={!api || saving || deleting || !valid}
          onClick={() => void save()}
          type="button"
        >
          {saving ? '保存中…' : '保存规则'}
        </Button>
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
    <div className="drawer-body bui">
      {onBack && view.backLabel && (
        <button
          className="inline-link preview-back inline-flex items-center gap-[5px] font-medium text-accent-ink"
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
            className={buttonVariants({ variant: 'accent', size: 'sm' })}
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
