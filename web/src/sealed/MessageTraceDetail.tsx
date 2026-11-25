import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, RotateCw } from 'lucide-react'
import { Button } from '@bui/index'
import type {
  MessageTrace,
  TraceText,
} from '../../../src/observability/message-trace'
import type { PegasApi } from '../api'
import type { RunActivityReport, RunSubagentReport } from '../types'
import { ActivityTimeline } from './ActivityTimeline'

export function MessageTraceDetail({
  api,
  eventId,
  onBack,
}: {
  api: PegasApi | undefined
  eventId: string
  onBack: (() => void) | undefined
}) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ trace?: MessageTrace; error?: string }>(
    {},
  )
  useEffect(() => {
    if (!api) return
    let current = true
    void api.messageTrace(eventId).then(
      trace => {
        if (current) setState({ trace })
      },
      (error: unknown) => {
        if (current)
          setState({
            error: error instanceof Error ? error.message : '读取调用链失败。',
          })
      },
    )
    return () => {
      current = false
    }
  }, [api, eventId, revision])
  const trace = state.trace
  return (
    <div className="drawer-body stack">
      <div className="flex items-center justify-between gap-2">
        {onBack && (
          <Button size="sm" variant="ghost" type="button" onClick={onBack}>
            <ArrowLeft size={14} /> 返回事情详情
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          type="button"
          className="ml-auto"
          onClick={() => setRevision(value => value + 1)}
        >
          <RotateCw size={14} /> 刷新
        </Button>
      </div>
      {state.error && <p role="alert">{state.error}</p>}
      {api && !trace && !state.error && <p role="status">正在读取调用链…</p>}
      {api && trace && (
        <>
          <p className="break-all text-[12px] text-ink-2">
            源事件 {trace.rootEventId}
          </p>
          <TraceSection title="消息提交">
            {trace.events.map(event => (
              <TraceStep
                key={event.id}
                title={event.id === eventId ? '当前消息' : '同批消息'}
                at={event.at}
                status={statusLabel(event.status)}
              >
                <TraceValue label="输入" value={event.input} />
                <p>
                  发送用时{' '}
                  {event.submitMs === undefined
                    ? '未采集'
                    : formatDuration(event.submitMs)}
                </p>
                <TraceTime label="入队处理完成" value={event.processedAt} />
                {event.error && <TraceValue label="错误" value={event.error} />}
              </TraceStep>
            ))}
          </TraceSection>
          <TraceSection title="输入处理与归类">
            {trace.calls.map((call, index) => (
              <TraceStep
                key={`${call.at}:${String(index)}`}
                title={call.component === 'rewrite' ? '输入改写' : '模型归类'}
                at={call.at}
                status={`${statusLabel(call.outcome)} · ${formatDuration(call.durationMs)}`}
              >
                <p>{call.model}</p>
                <TraceValue label="消息输入" value={call.input} />
                {call.candidates && (
                  <p className="break-all">
                    候选事情 {call.candidates.join('、') || '无'}
                  </p>
                )}
                <TraceValue label="结构化输出" value={call.output} />
              </TraceStep>
            ))}
            {trace.decision ? (
              <TraceStep
                title={`归类决定 · ${statusLabel(trace.decision.kind)}`}
                at={trace.decision.at}
                status={
                  trace.calls.some(
                    call =>
                      call.component === 'router' && call.outcome !== 'ok',
                  ) &&
                  trace.calls.findLast(call => call.component === 'router')
                    ?.outcome !== 'ok'
                    ? '规则兜底'
                    : statusLabel(trace.decision.source ?? '')
                }
              >
                <TraceValue label="理由" value={trace.decision.reason} />
                {trace.decision.taskId && (
                  <p className="break-all">事情 {trace.decision.taskId}</p>
                )}
                {trace.decision.ruleId && (
                  <p className="break-all">命中规则 {trace.decision.ruleId}</p>
                )}
              </TraceStep>
            ) : (
              <p className="text-ink-2">暂无归类决定</p>
            )}
          </TraceSection>
          <TraceSection title="执行与审批">
            {trace.runs.map(run => (
              <TraceStep
                key={run.id}
                title={`执行 · ${run.executor}`}
                at={run.at}
                status={statusLabel(run.status)}
              >
                <p className="break-all">Run {run.id}</p>
                {run.model && <p>{run.model}</p>}
                {run.retryOf && (
                  <p className="break-all">重试自 {run.retryOf}</p>
                )}
                {run.resumedFrom && (
                  <p className="break-all">来源 Run {run.resumedFrom}</p>
                )}
                <p>尝试次数 {run.attempts}</p>
                {run.starts.map(start => (
                  <TraceTime
                    key={`${String(start.attempt)}:${start.phase}`}
                    label={`第 ${String(start.attempt)} 次${start.phase === 'report' ? '提交验收' : '开始执行'}`}
                    value={start.at}
                  />
                ))}
                {run.starts.length === 0 && (
                  <TraceTime label="开始执行" value={undefined} />
                )}
                <TraceTime label="最后更新" value={run.updatedAt} />
                <TraceValue label="执行输入" value={run.input} />
                <TraceValue label="执行输出" value={run.output} />
                {run.error && <TraceValue label="错误" value={run.error} />}
                {trace.actions
                  .filter(action => action.runId === run.id)
                  .map(action => (
                    <div className="rounded-card bg-inset p-2" key={action.id}>
                      <p>
                        {action.tool} · {statusLabel(action.status)}
                      </p>
                      <TraceTime label="动作更新" value={action.updatedAt} />
                      {action.reconciliation && (
                        <>
                          <TraceTime
                            label={`核对结果 · ${statusLabel(action.reconciliation.status)}`}
                            value={action.reconciliation.at}
                          />
                          {action.reconciliation.note && (
                            <TraceValue
                              label="核对依据"
                              value={action.reconciliation.note}
                            />
                          )}
                        </>
                      )}
                      {action.approval && (
                        <>
                          <p>审批 · {statusLabel(action.approval.status)}</p>
                          <TraceTime
                            label="审批决定"
                            value={action.approval.resolvedAt}
                          />
                        </>
                      )}
                    </div>
                  ))}
                {trace.policy
                  .filter(call => call.runId === run.id)
                  .map(call => (
                    <details key={call.callId}>
                      <summary>
                        {call.tool} · {statusLabel(call.decision)}
                      </summary>
                      <p className="break-all">
                        {call.callId} · {call.category}
                      </p>
                      <TraceTime label="策略判定" value={call.at} />
                      <TraceValue label="理由" value={call.reason} />
                    </details>
                  ))}
                <TraceRunActivity api={api} runId={run.id} />
              </TraceStep>
            ))}
            {!trace.runs.length && <p className="text-ink-2">暂无关联执行</p>}
          </TraceSection>
          <TraceSection title="结果与浏览器回执">
            {trace.results.map(result => (
              <TraceStep
                key={result.id}
                title={statusLabel(result.type ?? result.lane)}
                at={result.at}
                status={statusLabel(result.lane)}
              >
                <p className="break-all">消息 {result.id}</p>
                <TraceValue label="结果" value={result.output} />
                <TraceTime label="服务端最后更新" value={result.updatedAt} />
                <TraceTime label="浏览器取到" value={result.fetchedAt} />
                <TraceTime label="首次渲染" value={result.renderedAt} />
                <TraceTime label="最终内容渲染" value={result.settledAt} />
                <TraceTime label="首次进入视口" value={result.visibleAt} />
              </TraceStep>
            ))}
            {!trace.results.length && (
              <p className="text-ink-2">暂无对话结果</p>
            )}
          </TraceSection>
          {trace.truncated && (
            <p className="text-ink-2">记录超过上限，当前只显示部分阶段。</p>
          )}
        </>
      )}
    </div>
  )
}

function TraceRunActivity({ api, runId }: { api: PegasApi; runId: string }) {
  const [data, setData] = useState<{
    activity?: RunActivityReport
    children?: RunSubagentReport
    error?: string
  }>({})
  const [loading, setLoading] = useState(false)
  async function load() {
    setLoading(true)
    try {
      const [activity, children] = await Promise.all([
        api.runActivity(runId),
        api.runSubagents(runId),
      ])
      setData({ activity, children })
    } catch {
      setData({ error: '读取执行记录失败，可以重试。' })
    } finally {
      setLoading(false)
    }
  }
  const tools = data.activity?.entries.filter(
    entry => entry.kind !== 'thinking',
  )
  return (
    <div className="grid gap-2">
      <Button
        size="sm"
        variant="ghost"
        type="button"
        onClick={() => void load()}
        disabled={loading}
      >
        {loading
          ? '正在读取…'
          : data.activity
            ? '刷新执行记录'
            : '加载工具输入和输出'}
      </Button>
      {data.error && <p role="alert">{data.error}</p>}
      {tools?.length === 0 && <p>工具调用未采集或此轮未调用工具。</p>}
      {data.activity?.truncated && (
        <p>仅显示最近 {data.activity.entries.length} 条执行记录。</p>
      )}
      {tools && tools.length > 0 && (
        <ActivityTimeline
          entries={tools}
          dataAccess={{
            runId,
            loadOutputPage: (run, call, offset, until) =>
              api.runActivityOutputPage(run, call, offset, until),
            imageUrl: (run, call) => api.runActivityImageUrl(run, call),
            outputFileUrl: (run, call) =>
              api.runActivityOutputFileUrl(run, call),
          }}
        />
      )}
      {data.children?.subagents.map(child => (
        <details key={child.sessionId}>
          <summary>子 Agent {child.sessionId.slice(0, 8)}</summary>
          <ActivityTimeline
            entries={child.entries.filter(entry => entry.kind !== 'thinking')}
          />
        </details>
      ))}
    </div>
  )
}

function TraceSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section aria-label={title} className="grid gap-2 text-[13px]">
      <h3 className="font-medium">{title}</h3>
      {children}
    </section>
  )
}

function TraceStep({
  title,
  at,
  status,
  children,
}: {
  title: string
  at: string
  status: string
  children: ReactNode
}) {
  return (
    <details className="rounded-card border border-line p-2">
      <summary className="cursor-pointer">
        <strong className="font-medium">{title}</strong>{' '}
        <span className="text-ink-2">
          {status} · <time dateTime={at}>{formatTime(at)}</time>
        </span>
      </summary>
      <div className="mt-2 grid gap-2 text-ink-2">{children}</div>
    </details>
  )
}

function TraceValue({
  label,
  value,
}: {
  label: string
  value: TraceText | undefined
}) {
  return (
    <div>
      <p className="font-medium">{label}</p>
      {value?.text !== undefined && (
        <pre className="mt-1 whitespace-pre-wrap break-all rounded-card bg-inset p-2 text-[12px]">
          {value.text}
        </pre>
      )}
      {value?.truncated && (
        <p>内容已截断，原始长度 {value.characters} 字符。</p>
      )}
      {!value && <p>未采集</p>}
    </div>
  )
}

function TraceTime({
  label,
  value,
}: {
  label: string
  value: string | undefined
}) {
  return (
    <p>
      {label}{' '}
      {value ? <time dateTime={value}>{formatTime(value)}</time> : '未采集'}
    </p>
  )
}

function formatTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    hour12: false,
    fractionalSecondDigits: 3,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatDuration(value: number) {
  return value < 1000 ? `${String(value)} ms` : `${(value / 1000).toFixed(2)} s`
}

const labels: Record<string, string> = {
  pending: '待处理',
  processing: '处理中',
  processed: '已处理',
  queued: '排队中',
  running: '执行中',
  waiting: '等待中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  succeeded: '已成功',
  unknown: '待核对',
  awaiting_approval: '待审批',
  authorized: '已授权',
  approved: '已批准',
  rejected: '已拒绝',
  revised: '待修订',
  allow: '放行',
  ask: '等待授权',
  deny: '拒绝',
  ok: '成功',
  provider_error: '模型调用失败',
  invalid_response: '模型返回无效',
  create_task: '新建事情',
  continue_task: '继续事情',
  steer_task: '调整执行',
  cancel_task: '停止事情',
  reply: '直接应答',
  clarify: '待澄清',
  prompt: '模型归类',
  deterministic: '确定性规则',
  say: '正文',
  work: '事情卡片',
  decide: '行动卡片',
  'agent.message': '回复',
  'run.completed': '完成卡片',
  'run.failed': '失败卡片',
  'approval.requested': '审批请求',
}

function statusLabel(value: string) {
  return labels[value] ?? value
}
