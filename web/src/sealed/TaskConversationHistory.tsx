import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Button } from '@bui/index'
import type { PegasApi } from '../api'
import type {
  Run,
  RunActivityEntry,
  RunActivityReport,
  RunSubagentReport,
  SubagentTranscript,
} from '../types'
import { ActivityTimeline } from './ActivityTimeline'
import {
  activitySearchId,
  activitySearchRecord,
  type TaskActivitySearchSnapshot,
  type TaskSearchRecord,
} from './taskActivitySearch'
import { formatRelativeTime, runStatusLabel } from './types'

interface RecordState {
  activity?: RunActivityReport
  children?: RunSubagentReport
  error?: string
  childrenError?: string
  loading?: boolean
  version?: string
}
interface Message {
  id: string
  at: string
  role?: 'user' | 'pegas'
}

/** Complete histories are loaded with bounded concurrency; drafts and messages never depend on them. */
function useActivityRecords(api: PegasApi, taskId: string, inputRuns: Run[]) {
  const serialized = JSON.stringify(
    inputRuns.filter(run => run.taskId === taskId),
  )
  const runs = useMemo(() => JSON.parse(serialized) as Run[], [serialized])
  const cache = useRef<Partial<Record<string, RecordState>>>({})
  const [records, setRecords] = useState(cache.current)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = (id: string, patch: Partial<RecordState>) => {
      if (abort.signal.aborted) return
      cache.current = {
        ...cache.current,
        [id]: { ...cache.current[id], ...patch },
      }
      setRecords(cache.current)
    }
    async function load() {
      const queue = runs.filter(
        run =>
          run.status === 'running' ||
          cache.current[run.id]?.version !== run.updatedAt,
      )
      await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, async () => {
          while (queue.length && !abort.signal.aborted) {
            const run = queue.shift()
            if (!run) return
            update(run.id, { loading: true })
            const [activity, children] = await Promise.allSettled([
              api
                .completeRunActivity(run.id, taskId, abort.signal)
                .then(value => {
                  update(run.id, { activity: value, error: undefined })
                  return value
                })
                .catch((error: unknown) => {
                  update(run.id, {
                    error:
                      error instanceof Error
                        ? error.message
                        : '无法读取执行记录。',
                  })
                  throw error
                }),
              api
                .runSubagents(run.id, abort.signal)
                .then(report => {
                  if (report.runId !== run.id || report.taskId !== taskId)
                    throw new Error('子 Agent 记录归属不匹配。')
                  update(run.id, { children: report, childrenError: undefined })
                  return report
                })
                .catch((error: unknown) => {
                  update(run.id, {
                    childrenError: '子 Agent 记录读取失败，请重试。',
                  })
                  throw error
                }),
            ])
            update(run.id, {
              loading: false,
              // Failed reads stay retryable. Successful settled runs are reused across polls.
              version:
                activity.status === 'fulfilled' &&
                children.status === 'fulfilled'
                  ? run.updatedAt
                  : undefined,
            })
          }
        }),
      )
      if (!abort.signal.aborted && runs.some(run => run.status === 'running'))
        timer = setTimeout(() => void load(), 5000)
    }
    void load()
    return () => {
      abort.abort()
      clearTimeout(timer)
    }
  }, [api, taskId, runs, retry])
  const retryRecords = useCallback(() => setRetry(value => value + 1), [])
  return { runs, records, retry: retryRecords }
}

type Item<T> =
  | { kind: 'message'; at: string; key: string; message: T }
  | { kind: 'run'; at: string; key: string; run: Run }
  | {
      kind: 'activity'
      at: string
      key: string
      run: Run
      entry: RunActivityEntry
    }
  | {
      kind: 'child'
      at: string
      key: string
      run: Run
      child: SubagentTranscript
    }

export function TaskConversationHistory<T extends Message>({
  api,
  taskId,
  runs: inputRuns,
  messages,
  renderMessage,
  onSearchSnapshot,
}: {
  api: PegasApi
  taskId: string
  runs: Run[]
  messages: T[]
  onSearchSnapshot?: (snapshot: TaskActivitySearchSnapshot) => void
  renderMessage: (
    message: T,
    grouped: boolean,
    continuation: boolean,
  ) => ReactNode
}) {
  const { runs, records, retry } = useActivityRecords(api, taskId, inputRuns)
  useEffect(() => {
    if (!onSearchSnapshot) return
    const entries: TaskSearchRecord[] = []
    let pending = false
    let failed = false
    let truncated = false
    for (const run of runs) {
      const record = records[run.id]
      pending ||=
        Boolean(record?.loading) ||
        (!record?.activity && !record?.error) ||
        (!record.children && !record.childrenError)
      failed ||= Boolean(record?.error ?? record?.childrenError)
      for (const entry of record?.activity?.entries ?? [])
        entries.push(activitySearchRecord(run.id, entry))
      for (const child of record?.children?.subagents ?? []) {
        truncated ||= child.truncated
        entries.push({
          id: activitySearchId(run.id, undefined, child.sessionId),
          role: 'activity',
          label: '子 Agent 任务',
          at: child.createdAt,
          text: [child.label, child.prompt].filter(Boolean).join('\n'),
        })
        for (const entry of child.entries)
          entries.push(activitySearchRecord(run.id, entry, child.sessionId))
      }
    }
    onSearchSnapshot({ taskId, entries, pending, failed, truncated, retry })
  }, [runs, records, taskId, retry, onSearchSnapshot])
  const items: Item<T>[] = messages.map(message => ({
    kind: 'message',
    at: message.at,
    key: message.id,
    message,
  }))
  for (const run of runs) {
    items.push({ kind: 'run', at: run.createdAt, key: `run-${run.id}`, run })
    for (const entry of records[run.id]?.activity?.entries ?? [])
      items.push({
        kind: 'activity',
        at: entry.createdAt,
        key: `${run.id}-${String(entry.seq)}`,
        run,
        entry,
      })
    for (const child of records[run.id]?.children?.subagents ?? [])
      items.push({
        kind: 'child',
        at: child.createdAt,
        key: `${run.id}-${child.sessionId}`,
        run,
        child,
      })
  }
  const order = (item: Item<T>) =>
    item.kind === 'message'
      ? item.message.role === 'user'
        ? 0
        : 4
      : item.kind === 'run'
        ? 1
        : item.kind === 'activity'
          ? 2
          : 3
  items.sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || order(a) - order(b),
  )
  // Adjacent activity rows retain the existing semantic renderers and expandable raw output.
  const blocks: (
    | Exclude<Item<T>, { kind: 'activity' }>
    | { kind: 'activity'; key: string; run: Run; entries: RunActivityEntry[] }
  )[] = []
  for (const item of items) {
    const last = blocks.at(-1)
    if (item.kind !== 'activity') blocks.push(item)
    else if (last?.kind === 'activity' && last.run.id === item.run.id)
      last.entries.push(item.entry)
    else
      blocks.push({
        kind: 'activity',
        key: item.key,
        run: item.run,
        entries: [item.entry],
      })
  }
  return (
    <>
      {blocks.map(block => {
        if (block.kind === 'message')
          return (
            <Fragment key={block.key}>
              {renderMessage(block.message, false, false)}
            </Fragment>
          )
        if (block.kind === 'activity')
          return (
            <div
              key={block.key}
              data-run-activity={block.run.id}
              className="task-inline-activity bui min-w-0 py-2"
            >
              <ActivityTimeline
                chronological
                entryAnchor={entry => activitySearchId(block.run.id, entry.seq)}
                entries={block.entries}
                dataAccess={{
                  runId: block.run.id,
                  loadOutputPage: (id, call, offset, until) =>
                    api.runActivityOutputPage(id, call, offset, until),
                  imageUrl: (id, call) => api.runActivityImageUrl(id, call),
                  outputFileUrl: (id, call) =>
                    api.runActivityOutputFileUrl(id, call),
                }}
              />
            </div>
          )
        if (block.kind === 'child')
          return (
            <details
              key={block.key}
              data-activity-id={activitySearchId(
                block.run.id,
                undefined,
                block.child.sessionId,
              )}
              tabIndex={-1}
              className="task-inline-activity bui min-w-0 rounded-card bg-inset p-3"
            >
              <summary className="cursor-pointer">
                子 Agent ·{' '}
                {block.child.label ?? block.child.sessionId.slice(0, 8)}
              </summary>
              {block.child.prompt && (
                <p className="my-2 whitespace-pre-wrap break-words">
                  {block.child.prompt}
                </p>
              )}
              <ActivityTimeline
                entries={block.child.entries}
                chronological
                entryAnchor={entry =>
                  activitySearchId(
                    block.run.id,
                    entry.seq,
                    block.child.sessionId,
                  )
                }
              />
              {block.child.truncated && (
                <p>
                  子 Agent 已保存 {block.child.entries.length} /{' '}
                  {block.child.totalEntries} 条记录，源记录已截断。
                </p>
              )}
            </details>
          )
        const record = records[block.run.id]
        return (
          <section
            key={block.key}
            aria-label={`执行过程 ${String(runs.indexOf(block.run) + 1)}`}
            className="bui grid min-w-0 gap-2 py-3 text-[13px] text-ink-2"
          >
            <h2 className="font-medium">
              执行过程 · {runStatusLabel(block.run)}{' '}
              <time dateTime={block.run.createdAt}>
                {formatRelativeTime(block.run.createdAt)}
              </time>
            </h2>
            {block.run.retryOfRunId && <p>接续此前执行</p>}
            {!record?.activity && !record?.error && (
              <p role="status">正在读取完整执行记录…</p>
            )}
            {record?.activity?.entries.length === 0 && (
              <p>这次执行没有留存过程记录（旧版本运行或直接应答）。</p>
            )}
            {(record?.error ?? record?.childrenError) && (
              <div role="alert">
                {record.error && <p>执行记录未完整读取。{record.error}</p>}
                {record.childrenError && <p>{record.childrenError}</p>}
                <Button size="sm" disabled={record.loading} onClick={retry}>
                  重新读取本轮过程
                </Button>
              </div>
            )}
          </section>
        )
      })}
    </>
  )
}
