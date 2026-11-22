import {
  BookOpen,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Copy,
  FilePen,
  FileText,
  Globe,
  ListChecks,
  LoaderCircle,
  Network,
  Search,
  SquareTerminal,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { MarkdownMessage } from '../MarkdownMessage'
import type { RunActivityEntry, ToolSemantic } from '../types'
import {
  batchRunningLabel,
  batchSummary,
  diffToText,
  groupActivityEntries,
  shellFooter,
  toolHeadline,
  type ActivityGroupKind,
} from './activityModel'
import { formatRelativeTime } from './types'

export function ActivityTimeline({
  entries,
  renderDelegation,
}: {
  entries: readonly RunActivityEntry[]
  renderDelegation?: (entry: RunActivityEntry) => ReactNode
}) {
  const units = groupActivityEntries(entries)
  return (
    <ol className="activity-timeline" role="list">
      {units.map(unit =>
        unit.kind === 'batch' ? (
          <ActivityBatch
            entries={unit.entries}
            group={unit.group}
            key={unit.key}
          />
        ) : (
          <ActivityEntryRow
            entry={unit.entry}
            key={unit.key}
            renderDelegation={renderDelegation}
          />
        ),
      )}
    </ol>
  )
}

function groupIcon(group: ActivityGroupKind, size = 14) {
  switch (group) {
    case 'command':
      return <SquareTerminal size={size} />
    case 'read':
      return <BookOpen size={size} />
    case 'edit':
      return <FilePen size={size} />
    case 'search':
      return <Search size={size} />
    case 'web':
      return <Globe size={size} />
    case 'agent':
      return <Network size={size} />
  }
}

function entryIcon(entry: RunActivityEntry) {
  const semantic = entry.semantic
  if (!semantic) return <FileText size={14} />
  switch (semantic.kind) {
    case 'shell':
      return groupIcon('command')
    case 'file_read':
      return groupIcon('read')
    case 'file_edit':
      return groupIcon('edit')
    case 'search':
      return groupIcon('search')
    case 'todo':
      return <ListChecks size={14} />
    case 'web':
      return groupIcon('web')
    case 'agent_control':
      return groupIcon('agent')
    case 'unknown':
      return <FileText size={14} />
  }
}

function RunningIcon({ children }: { children: ReactNode }) {
  return (
    <span className="activity-running">
      {children}
      <LoaderCircle aria-hidden="true" className="activity-spinner" size={9} />
    </span>
  )
}

function ActivityBatch({
  group,
  entries,
}: {
  group: ActivityGroupKind
  entries: RunActivityEntry[]
}) {
  const running = entries.some(entry => entry.status === 'started')
  const failed = entries.filter(entry => entry.status === 'error').length
  return (
    <li className="activity-batch">
      <details>
        <summary>
          <span className="activity-icon" aria-hidden="true">
            {running ? (
              <RunningIcon>{groupIcon(group)}</RunningIcon>
            ) : (
              groupIcon(group)
            )}
          </span>
          <span className="activity-label">
            {running
              ? batchRunningLabel(group)
              : batchSummary(group, entries.length)}
            {failed > 0 && (
              <em className="activity-error"> · {String(failed)} 条失败</em>
            )}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="activity-chevron"
            size={14}
          />
        </summary>
        <ol className="activity-batch-items" role="list">
          {entries.map(entry => (
            <ActivityEntryRow entry={entry} key={entry.seq} />
          ))}
        </ol>
      </details>
    </li>
  )
}

function ActivityEntryRow({
  entry,
  renderDelegation,
}: {
  entry: RunActivityEntry
  renderDelegation?: (entry: RunActivityEntry) => ReactNode
}) {
  if (entry.kind === 'step') {
    return (
      <li className="activity-step">
        <span className="activity-icon" aria-hidden="true">
          <Clock3 size={13} />
        </span>
        <span className="activity-label">{entry.label}</span>
        <small>{formatRelativeTime(entry.createdAt)}</small>
      </li>
    )
  }
  if (entry.kind === 'thinking') {
    return (
      <li className="activity-thinking">
        <details>
          <summary>
            <span className="activity-icon" aria-hidden="true">
              <CircleHelp size={14} />
            </span>
            <span className="activity-label">推理</span>
            <ChevronDown
              aria-hidden="true"
              className="activity-chevron"
              size={14}
            />
          </summary>
          <div className="activity-prose">
            <MarkdownMessage content={entry.detail ?? entry.label} />
          </div>
        </details>
      </li>
    )
  }
  if (entry.kind === 'text') {
    return (
      <li className="activity-message">
        <div className="activity-prose">
          <MarkdownMessage content={entry.detail ?? entry.label} />
        </div>
        <small>{formatRelativeTime(entry.createdAt)}</small>
      </li>
    )
  }
  if (renderDelegation) {
    const delegated = renderDelegation(entry)
    if (delegated) return <>{delegated}</>
  }
  return <ToolEntryRow entry={entry} />
}

function ToolEntryRow({ entry }: { entry: RunActivityEntry }) {
  const headline = toolHeadline(entry)
  const running = entry.status === 'started'
  const failed = entry.status === 'error'
  return (
    <li className="activity-tool">
      <details>
        <summary>
          <span className="activity-icon" aria-hidden="true">
            {running ? (
              <RunningIcon>{entryIcon(entry)}</RunningIcon>
            ) : (
              entryIcon(entry)
            )}
          </span>
          <span className="activity-label">
            <span className="activity-title">{headline.title}</span>
            {headline.subject && headline.additions === undefined && (
              <span className="activity-subject"> {headline.subject}</span>
            )}
            {headline.additions !== undefined && (
              <span className="activity-diffstat">
                {' '}
                <b className="is-add">+{String(headline.additions)}</b>{' '}
                <b className="is-del">-{String(headline.deletions ?? 0)}</b>
              </span>
            )}
            {headline.subject && headline.additions !== undefined && (
              <span className="activity-subject"> {headline.subject}</span>
            )}
            {failed && <em className="activity-error">失败</em>}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="activity-chevron"
            size={14}
          />
        </summary>
        <ToolResultBody entry={entry} />
      </details>
    </li>
  )
}

function ToolResultBody({ entry }: { entry: RunActivityEntry }) {
  const semantic = entry.semantic
  if (!semantic || semantic.kind === 'unknown') {
    return entry.detail ? (
      <pre className="activity-raw" tabIndex={0}>
        {entry.detail}
      </pre>
    ) : (
      <p className="activity-empty">没有留存参数或输出。</p>
    )
  }
  switch (semantic.kind) {
    case 'shell':
      return <ShellCard entry={entry} semantic={semantic} />
    case 'file_edit':
      return <DiffCard entry={entry} semantic={semantic} />
    case 'agent_control':
      return <AgentControlCard entry={entry} semantic={semantic} />
    case 'todo':
      return <TodoCard entry={entry} semantic={semantic} />
    case 'search':
      return semantic.shape ? (
        <SearchCard entry={entry} semantic={semantic} />
      ) : (
        <PreviewCard entry={entry} semantic={semantic} />
      )
    case 'file_read':
    case 'web':
      return <PreviewCard entry={entry} semantic={semantic} />
  }
}

function CopyAction({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  async function copy() {
    window.clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
    timer.current = window.setTimeout(() => setState('idle'), 2000)
  }
  return (
    <span className="activity-copy">
      <button
        aria-label={state === 'copied' ? '已复制' : label}
        data-copied={state === 'copied' ? '' : undefined}
        data-failed={state === 'failed' ? '' : undefined}
        onClick={() => void copy()}
        type="button"
      >
        {state === 'copied' ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <span className="activity-copy-tip" role="status">
        {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : ''}
      </span>
    </span>
  )
}

function ShellCard({
  entry,
  semantic,
}: {
  entry: RunActivityEntry
  semantic: Extract<ToolSemantic, { kind: 'shell' }>
}) {
  const footer = shellFooter(entry)
  const output = semantic.output ?? ''
  return (
    <div className="activity-card shell-card">
      <header className="activity-card-header">
        <span>Shell</span>
        <CopyAction
          label="复制命令与输出"
          text={output ? `$ ${semantic.command}\n${output}` : semantic.command}
        />
      </header>
      <pre className="shell-command" tabIndex={0}>
        <span aria-hidden="true" className="shell-prompt">
          ${' '}
        </span>
        {semantic.command}
      </pre>
      {output && (
        <pre className="shell-output" tabIndex={0}>
          {output}
        </pre>
      )}
      {semantic.outputTruncated && (
        <p className="activity-empty">输出过长，仅保留前段记录。</p>
      )}
      <footer className={`shell-footer is-${footer.tone}`}>
        {footer.tone === 'ok' && <Check aria-hidden="true" size={13} />}
        {footer.tone === 'running' && (
          <LoaderCircle
            aria-hidden="true"
            className="activity-spinner"
            size={12}
          />
        )}
        <span>{footer.label}</span>
      </footer>
    </div>
  )
}

function DiffCard({
  entry,
  semantic,
}: {
  entry: RunActivityEntry
  semantic: Extract<ToolSemantic, { kind: 'file_edit' }>
}) {
  let oldLine = 0
  let newLine = 0
  return (
    <div className="activity-card diff-card">
      <header className="activity-card-header">
        <span className="diff-path" title={semantic.path}>
          {semantic.path}
        </span>
        <span className="activity-diffstat">
          <b className="is-add">+{String(semantic.additions)}</b>{' '}
          <b className="is-del">-{String(semantic.deletions)}</b>
        </span>
        <CopyAction label="复制 diff" text={diffToText(semantic)} />
      </header>
      {entry.status === 'started' && (
        <p className="activity-empty">编辑进行中，以下为计划变更。</p>
      )}
      {entry.status === 'error' && (
        <p className="activity-empty is-error">
          编辑未成功，以下为尝试的变更。
        </p>
      )}
      <div className="diff-body">
        {semantic.hunks.map((hunk, hunkIndex) => {
          oldLine = hunk.oldStart ?? oldLine
          newLine = hunk.newStart ?? newLine
          const numbered =
            hunk.oldStart !== undefined || hunk.newStart !== undefined
          return (
            <div className="diff-hunk" key={hunkIndex}>
              {hunk.oldStart !== undefined && (
                <div className="diff-hunk-header">
                  @@ -{String(hunk.oldStart)} +
                  {String(hunk.newStart ?? hunk.oldStart)} @@
                </div>
              )}
              {hunk.lines.map((line, lineIndex) => {
                const oldNumber =
                  numbered && line.type !== 'add' ? (oldLine += 1) : undefined
                const newNumber =
                  numbered && line.type !== 'del' ? (newLine += 1) : undefined
                return (
                  <div className={`diff-line is-${line.type}`} key={lineIndex}>
                    <span aria-hidden="true" className="diff-gutter">
                      {oldNumber !== undefined ? String(oldNumber) : ''}
                    </span>
                    <span aria-hidden="true" className="diff-gutter">
                      {newNumber !== undefined ? String(newNumber) : ''}
                    </span>
                    <span aria-hidden="true" className="diff-marker">
                      {line.type === 'add'
                        ? '+'
                        : line.type === 'del'
                          ? '-'
                          : ' '}
                    </span>
                    <span className="diff-text">{line.text || ' '}</span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      {semantic.diffTruncated && (
        <p className="activity-empty">变更过长，仅保留前段 diff。</p>
      )}
    </div>
  )
}

function PreviewCard({
  entry,
  semantic,
}: {
  entry: RunActivityEntry
  semantic: Extract<ToolSemantic, { kind: 'file_read' | 'search' | 'web' }>
}) {
  const preview = semantic.preview
  const web = semantic.kind === 'web' ? semantic : undefined
  const sources = web?.sources
  const meta =
    semantic.kind === 'file_read'
      ? semantic.path
      : semantic.kind === 'search'
        ? `“${semantic.query}”${semantic.path ? ` · ${semantic.path}` : ''}`
        : (web?.url ??
          (web?.queries && web.queries.length > 0
            ? web.queries.join('、')
            : (web?.query ?? '')))
  return (
    <div className="activity-card preview-card">
      <header className="activity-card-header">
        <span className="diff-path" title={meta}>
          {meta}
        </span>
        {web?.statusCode !== undefined && (
          <span
            className={`preview-meta http-status ${web.statusCode < 400 ? 'is-ok' : 'is-error'}`}
          >
            HTTP {String(web.statusCode)}
          </span>
        )}
        {semantic.kind === 'file_read' && semantic.lineCount !== undefined && (
          <span className="preview-meta">{String(semantic.lineCount)} 行</span>
        )}
        {preview && <CopyAction label="复制内容" text={preview} />}
      </header>
      {sources && sources.length > 0 && (
        <ol className="web-sources" role="list">
          {sources.map((source, index) => (
            <li key={`${source.url}-${String(index)}`}>
              <a
                href={source.url}
                rel="noreferrer noopener"
                target="_blank"
                title={source.url}
              >
                {source.title ?? source.url}
              </a>
              {source.snippet && <small>{source.snippet}</small>}
            </li>
          ))}
        </ol>
      )}
      {web?.sourcesTruncated && (
        <p className="activity-empty">来源过多，仅保留前段引用。</p>
      )}
      {preview ? (
        <pre className="preview-body" tabIndex={0}>
          {preview}
        </pre>
      ) : (
        <p className="activity-empty">
          {entry.status === 'started' ? '读取中…' : '没有留存内容预览。'}
        </p>
      )}
      {semantic.previewTruncated && (
        <p className="activity-empty">内容过长，仅保留前段预览。</p>
      )}
    </div>
  )
}

function TodoCard({
  entry,
  semantic,
}: {
  entry: RunActivityEntry
  semantic: Extract<ToolSemantic, { kind: 'todo' }>
}) {
  const completed = semantic.items.filter(
    item => item.status === 'completed',
  ).length
  const copyText = semantic.items
    .map(item => `${todoMarker(item.status)} ${item.content}`)
    .join('\n')
  return (
    <div className="activity-card todo-card">
      <header className="activity-card-header">
        <span>任务清单</span>
        <span className="preview-meta">
          {String(completed)}/{String(semantic.items.length)} 已完成
        </span>
        <CopyAction label="复制清单" text={copyText} />
      </header>
      {entry.status === 'error' && (
        <p className="activity-empty is-error">
          清单未写入成功，以下为尝试的快照。
        </p>
      )}
      <ol className="todo-list" role="list">
        {semantic.items.map((item, index) => (
          <li className={`is-${item.status}`} key={index}>
            <span aria-hidden="true" className="todo-marker">
              {item.status === 'completed' ? (
                <Check size={13} />
              ) : item.status === 'in_progress' ? (
                <LoaderCircle className="activity-spinner" size={13} />
              ) : (
                <span className="todo-dot" />
              )}
            </span>
            <span className="todo-content">{item.content}</span>
            <em className="todo-status">{todoStatusLabel(item.status)}</em>
          </li>
        ))}
      </ol>
      {semantic.itemsTruncated && (
        <p className="activity-empty">清单过长或含无效项，仅保留有效前段。</p>
      )}
    </div>
  )
}

function todoMarker(status: 'pending' | 'in_progress' | 'completed'): string {
  return status === 'completed'
    ? '[x]'
    : status === 'in_progress'
      ? '[~]'
      : '[ ]'
}

function todoStatusLabel(
  status: 'pending' | 'in_progress' | 'completed',
): string {
  return status === 'completed'
    ? '已完成'
    : status === 'in_progress'
      ? '进行中'
      : '待办'
}

function SearchCard({
  entry,
  semantic,
}: {
  entry: RunActivityEntry
  semantic: Extract<ToolSemantic, { kind: 'search' }>
}) {
  const running = entry.status === 'started'
  const failed = entry.status === 'error'
  const files = semantic.files
  const paths = semantic.paths
  const copyText =
    semantic.shape === 'paths'
      ? (paths ?? []).join('\n')
      : (files ?? [])
          .map(file =>
            [
              file.path,
              ...file.matches.map(
                match => `Line ${String(match.line)}: ${match.text}`,
              ),
            ].join('\n'),
          )
          .join('\n\n')
  const meta = `“${semantic.query}”${semantic.path ? ` · ${semantic.path}` : ''}${semantic.include ? ` (${semantic.include})` : ''}`
  return (
    <div className="activity-card search-card">
      <header className="activity-card-header">
        <span className="diff-path" title={meta}>
          {meta}
        </span>
        {semantic.total !== undefined && (
          <span className="preview-meta">
            {String(semantic.total)}{' '}
            {semantic.shape === 'paths' ? '个文件' : '处命中'}
          </span>
        )}
        {copyText && <CopyAction label="复制结果" text={copyText} />}
      </header>
      {files && files.length > 0 && (
        <div className="search-files">
          {files.map(file => (
            <section className="search-file" key={file.path}>
              <header title={file.path}>{file.path}</header>
              <ol role="list">
                {file.matches.map((match, index) => (
                  <li key={index}>
                    <span aria-hidden="true" className="search-line-number">
                      {String(match.line)}
                    </span>
                    <span className="search-line-text">{match.text}</span>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
      {paths && paths.length > 0 && (
        <ol className="search-paths" role="list">
          {paths.map(path => (
            <li key={path} title={path}>
              {path}
            </li>
          ))}
        </ol>
      )}
      {semantic.resultTruncated && (
        <p className="activity-empty">结果过多，仅保留前段命中。</p>
      )}
      {!running &&
        !failed &&
        (files ?? paths) &&
        (files?.length ?? 0) === 0 &&
        (paths?.length ?? 0) === 0 && (
          <p className="activity-empty">
            {semantic.shape === 'paths'
              ? '没有匹配该模式的文件。'
              : '没有命中任何行。'}
          </p>
        )}
      {running && (
        <p className="activity-empty">搜索进行中，命中会随结果留存。</p>
      )}
      {failed && (
        <footer className="shell-footer is-error">
          <span>失败</span>
        </footer>
      )}
    </div>
  )
}

function AgentControlCard({
  entry,
  semantic,
}: {
  entry: RunActivityEntry
  semantic: Extract<ToolSemantic, { kind: 'agent_control' }>
}) {
  const running = entry.status === 'started'
  const failed = entry.status === 'error'
  const status =
    semantic.action === 'wait'
      ? running
        ? { label: '等待中', tone: 'running' }
        : semantic.timedOut === true
          ? { label: '等待超时', tone: 'error' }
          : semantic.timedOut === false
            ? { label: '收到新消息', tone: 'ok' }
            : undefined
      : undefined
  return (
    <div className="activity-card agent-card">
      <header className="activity-card-header">
        <span>
          {semantic.action === 'wait'
            ? '等待子 agent'
            : semantic.action === 'message'
              ? `发给 ${semantic.agent ?? '子 agent'}`
              : semantic.action === 'interrupt'
                ? `请求停止 ${semantic.agent ?? '子 agent'}`
                : '子 agent 列表'}
        </span>
        {semantic.timeoutMs !== undefined && (
          <span className="preview-meta">
            上限 {String(Math.round(semantic.timeoutMs / 1000))}s
          </span>
        )}
        {semantic.message && (
          <CopyAction label="复制消息" text={semantic.message} />
        )}
      </header>
      {semantic.message && <p className="agent-message">{semantic.message}</p>}
      {semantic.agents && semantic.agents.length > 0 && (
        <ol className="agent-list" role="list">
          {semantic.agents.map(agent => (
            <li key={agent.name}>
              <span
                aria-hidden="true"
                className={`agent-status is-${agent.status}`}
              />
              <strong>{agent.name}</strong>
              <em>{agent.status}</em>
              {agent.description && <small>{agent.description}</small>}
            </li>
          ))}
        </ol>
      )}
      {!semantic.message && !semantic.agents && semantic.preview && (
        <pre className="preview-body" tabIndex={0}>
          {semantic.preview}
        </pre>
      )}
      {!semantic.message &&
        !semantic.agents &&
        !semantic.preview &&
        semantic.action !== 'wait' && (
          <p className="activity-empty">
            {running ? '执行中…' : '没有留存内容。'}
          </p>
        )}
      {(status ?? failed) && (
        <footer
          className={`shell-footer is-${failed ? 'error' : (status?.tone ?? 'ok')}`}
        >
          {!failed && status?.tone === 'ok' && (
            <Check aria-hidden="true" size={13} />
          )}
          {!failed && status?.tone === 'running' && (
            <LoaderCircle
              aria-hidden="true"
              className="activity-spinner"
              size={12}
            />
          )}
          <span>{failed ? '失败' : status?.label}</span>
        </footer>
      )}
    </div>
  )
}
