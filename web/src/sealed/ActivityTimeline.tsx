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
  LoaderCircle,
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
    case 'web':
      return groupIcon('web')
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
    case 'file_read':
    case 'search':
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
  const meta =
    semantic.kind === 'file_read'
      ? semantic.path
      : semantic.kind === 'search'
        ? `“${semantic.query}”${semantic.path ? ` · ${semantic.path}` : ''}`
        : (semantic.url ?? semantic.query ?? '')
  return (
    <div className="activity-card preview-card">
      <header className="activity-card-header">
        <span className="diff-path" title={meta}>
          {meta}
        </span>
        {semantic.kind === 'file_read' && semantic.lineCount !== undefined && (
          <span className="preview-meta">{String(semantic.lineCount)} 行</span>
        )}
        {preview && <CopyAction label="复制内容" text={preview} />}
      </header>
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
