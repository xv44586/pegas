import {
  BookOpen,
  Check,
  ChevronDown,
  CircleHelp,
  Copy,
  FilePen,
  FileText,
  Globe,
  History,
  Image as ImageIcon,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  MessageSquarePlus,
  Minimize2,
  Network,
  PackageCheck,
  Search,
  SquareTerminal,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createContext, useContext } from 'react'

import { MarkdownMessage } from '../MarkdownMessage'
import type { RunActivityEntry, ToolSemantic } from '../types'
import {
  tokenizeCodeLine,
  tokenizeShell,
  type HighlightToken,
} from './activityHighlight'
import {
  batchRunningLabel,
  batchSummary,
  diffToText,
  groupActivityEntries,
  shellFooter,
  summarizeRunChanges,
  thinkingHeadline,
  toolHeadline,
  type ActivityGroupKind,
} from './activityModel'
import { formatRelativeTime } from './types'

/**
 * Per-Run data access for output paging and image thumbnails. Child
 * transcript rows carry session-local call ids, so their entries are served
 * without archive/thumbnail access — honestly metadata-only.
 */
export interface ActivityDataAccess {
  runId: string
  loadOutputPage: (
    runId: string,
    callId: string,
    offset: number,
  ) => Promise<{
    content: string
    offset: number
    totalCharacters: number
    archivedCharacters: number
    truncatedArchive: boolean
  }>
  imageUrl: (runId: string, callId: string) => string
}

const ActivityDataContext = createContext<ActivityDataAccess | undefined>(
  undefined,
)

export function ActivityTimeline({
  entries,
  renderDelegation,
  dataAccess,
  onReviewJump,
}: {
  entries: readonly RunActivityEntry[]
  renderDelegation?: (entry: RunActivityEntry) => ReactNode
  dataAccess?: ActivityDataAccess
  onReviewJump?: () => void
}) {
  const units = groupActivityEntries(entries)
  const changes = summarizeRunChanges(entries)
  return (
    <ActivityDataContext.Provider value={dataAccess}>
      <ol className="activity-timeline" role="list">
        {changes && (
          <RunChangesCard changes={changes} onReviewJump={onReviewJump} />
        )}
        {units.map(unit =>
          unit.kind === 'batch' ? (
            <ActivityBatch
              entries={unit.entries}
              group={unit.group}
              key={unit.key}
            />
          ) : unit.kind === 'todo' ? (
            <TodoFoldUnit
              history={unit.history}
              key={unit.key}
              latest={unit.latest}
            />
          ) : unit.kind === 'thinking' ? (
            <ThinkingFoldUnit
              history={unit.history}
              key={unit.key}
              latest={unit.latest}
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
    </ActivityDataContext.Provider>
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
    case 'image':
      return <ImageIcon size={14} />
    case 'delivery':
      return <PackageCheck size={14} />
    case 'file_edit':
      return groupIcon('edit')
    case 'search':
      return groupIcon('search')
    case 'todo':
      return <ListChecks size={14} />
    case 'ask_user':
      return <CircleHelp size={14} />
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
    if (entry.meta) {
      const steered = entry.meta.kind === 'steered'
      const failed = entry.status === 'error'
      return (
        <li
          className={`activity-meta-row ${steered ? 'is-steered' : 'is-compaction'}${failed ? ' is-error' : ''}`}
        >
          <span className="activity-icon" aria-hidden="true">
            {steered ? (
              <MessageSquarePlus size={13} />
            ) : (
              <Minimize2 size={13} />
            )}
          </span>
          <span className="activity-label">
            {entry.label}
            {entry.meta.note && (
              <span className="activity-meta-note"> · {entry.meta.note}</span>
            )}
          </span>
          <small>{formatRelativeTime(entry.createdAt)}</small>
        </li>
      )
    }
    return null
  }
  if (entry.kind === 'thinking') {
    return <ThinkingRow entry={entry} />
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
    case 'ask_user':
      return <AskUserCard entry={entry} semantic={semantic} />
    case 'image':
      return <ImageCard entry={entry} semantic={semantic} />
    case 'delivery':
      return <DeliveryCard entry={entry} semantic={semantic} />
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
        <HighlightedText tokens={tokenizeShell(semantic.command)} />
      </pre>
      {output && (
        <pre className="shell-output" tabIndex={0}>
          {output}
        </pre>
      )}
      {semantic.outputTruncated && (
        <OutputPager entry={entry} initialLength={output.length} />
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

function HighlightedText({ tokens }: { tokens: HighlightToken[] }) {
  return (
    <>
      {tokens.map((token, index) =>
        token.kind ? (
          <span className={`hl-${token.kind}`} key={index}>
            {token.text}
          </span>
        ) : (
          <span key={index}>{token.text}</span>
        ),
      )}
    </>
  )
}

/**
 * EXEC-006 P1b: pages the archived full output beyond the inline clip.
 * Preview cards pass archiveOffset=1 because the archived result carries
 * one separator newline before the inline preview text.
 * The button only appears when the Run has an output archive endpoint; the
 * archive itself is capped and says so honestly.
 */
function OutputPager({
  entry,
  initialLength,
  archiveOffset = 0,
}: {
  entry: RunActivityEntry
  initialLength: number
  archiveOffset?: number
}) {
  const access = useContext(ActivityDataContext)
  const [pages, setPages] = useState<string[]>([])
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>(
    'idle',
  )
  const [archiveNote, setArchiveNote] = useState('')
  const offsetRef = useRef(initialLength + archiveOffset)
  if (!access || !entry.callId) {
    return <p className="activity-empty">内容过长，仅保留前段记录。</p>
  }
  const callId = entry.callId
  const loadMore = async () => {
    setState('loading')
    try {
      const page = await access.loadOutputPage(
        access.runId,
        callId,
        offsetRef.current,
      )
      if (page.content.length === 0) {
        setState('done')
        if (page.truncatedArchive)
          setArchiveNote(
            `完整输出 ${String(page.totalCharacters)} 字符，档案保留前 ${String(page.archivedCharacters)} 字符。`,
          )
        return
      }
      offsetRef.current = page.offset + page.content.length
      setPages(previous => [...previous, page.content])
      const exhausted = offsetRef.current >= page.archivedCharacters
      setState(exhausted ? 'done' : 'idle')
      if (exhausted && page.truncatedArchive)
        setArchiveNote(
          `完整输出 ${String(page.totalCharacters)} 字符，档案保留前 ${String(page.archivedCharacters)} 字符。`,
        )
    } catch {
      setState('error')
    }
  }
  return (
    <div className="output-pager">
      {pages.map((page, index) => (
        <pre className="shell-output" key={index} tabIndex={0}>
          {page}
        </pre>
      ))}
      <p className="activity-empty">
        输出过长，仅保留前段记录。
        {state !== 'done' && (
          <button
            className="inline-link"
            disabled={state === 'loading'}
            onClick={() => void loadMore()}
            type="button"
          >
            {state === 'loading' ? '读取中…' : '加载后续输出'}
          </button>
        )}
      </p>
      {state === 'error' && (
        <p className="activity-empty is-error" role="alert">
          后续输出读取失败，可重试。
          <button
            className="inline-link"
            onClick={() => void loadMore()}
            type="button"
          >
            重试
          </button>
        </p>
      )}
      {archiveNote && <p className="activity-empty">{archiveNote}</p>}
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
                    <span className="diff-text">
                      {line.text ? (
                        <HighlightedText tokens={tokenizeCodeLine(line.text)} />
                      ) : (
                        ' '
                      )}
                    </span>
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
        <OutputPager
          entry={entry}
          initialLength={preview?.length ?? 0}
          archiveOffset={1}
        />
      )}
    </div>
  )
}

function RunChangesCard({
  changes,
  onReviewJump,
}: {
  changes: NonNullable<ReturnType<typeof summarizeRunChanges>>
  onReviewJump?: () => void
}) {
  return (
    <li className="activity-tool activity-changes">
      <details>
        <summary>
          <span className="activity-icon" aria-hidden="true">
            <FilePen size={14} />
          </span>
          <span className="activity-label">
            <span className="activity-title">
              本次运行修改了 {String(changes.files.length)} 个文件
            </span>
            <span className="activity-diffstat">
              {' '}
              <b className="is-add">+{String(changes.additions)}</b>{' '}
              <b className="is-del">-{String(changes.deletions)}</b>
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className="activity-chevron"
            size={14}
          />
        </summary>
        <div className="activity-card changes-card">
          <header className="activity-card-header">
            <span>文件变更汇总</span>
            <span className="preview-meta">按记录的编辑尝试累计</span>
          </header>
          {onReviewJump && (
            <p className="changes-review-jump">
              <button
                className="inline-link"
                onClick={onReviewJump}
                type="button"
              >
                跳到交付评审 ↓
              </button>
            </p>
          )}
          <ol className="changes-files" role="list">
            {changes.files.map(file => (
              <li key={file.path}>
                <details>
                  <summary>
                    <span className="changes-path" title={file.path}>
                      {file.path}
                    </span>
                    <span className="activity-diffstat">
                      <b className="is-add">+{String(file.additions)}</b>{' '}
                      <b className="is-del">-{String(file.deletions)}</b>
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      className="activity-chevron"
                      size={13}
                    />
                  </summary>
                  <ol className="activity-batch-items" role="list">
                    {file.entries.map(entry => (
                      <ActivityEntryRow entry={entry} key={entry.seq} />
                    ))}
                  </ol>
                </details>
              </li>
            ))}
          </ol>
        </div>
      </details>
    </li>
  )
}

function ImageCard({
  entry,
  semantic,
}: {
  entry: RunActivityEntry
  semantic: Extract<ToolSemantic, { kind: 'image' }>
}) {
  const access = useContext(ActivityDataContext)
  const facts = [
    semantic.mediaType,
    semantic.width !== undefined && semantic.height !== undefined
      ? `${String(semantic.width)}×${String(semantic.height)} px`
      : undefined,
    semantic.bytes !== undefined ? formatBytes(semantic.bytes) : undefined,
  ].filter(Boolean)
  return (
    <div className="activity-card image-card">
      <header className="activity-card-header">
        <span className="diff-path" title={semantic.path}>
          {semantic.path}
        </span>
        <CopyAction label="复制路径" text={semantic.path} />
      </header>
      {access && entry.callId && entry.status !== 'started' && (
        <ImageThumb
          alt={semantic.path}
          src={access.imageUrl(access.runId, entry.callId)}
        />
      )}
      <div className="image-facts">
        <span aria-hidden="true" className="image-glyph">
          <ImageIcon size={22} />
        </span>
        <div>
          <p>{facts.length > 0 ? facts.join(' · ') : '图片元数据未留存。'}</p>
          {semantic.originalWidth !== undefined &&
            semantic.originalHeight !== undefined && (
              <small>
                由 {String(semantic.originalWidth)}×
                {String(semantic.originalHeight)} px 原图缩小
              </small>
            )}
          {!(access && entry.callId) && (
            <small>图片内容未随执行记录留存，此处仅展示元数据。</small>
          )}
        </div>
      </div>
      {entry.status === 'started' && <p className="activity-empty">读取中…</p>}
      {entry.status === 'error' && (
        <footer className="shell-footer is-error">
          <span>失败</span>
        </footer>
      )}
    </div>
  )
}

/** Loads the authorized thumbnail; missing files degrade to metadata only. */
function ImageThumb({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (failed)
    return (
      <p className="activity-empty">
        原文件已不可读（可能被移动或删除），仅展示元数据。
      </p>
    )
  return (
    <a
      className="image-thumb-link"
      href={src}
      rel="noreferrer"
      target="_blank"
      title="在新标签页查看原图"
    >
      <img
        alt={alt}
        className="image-thumb"
        loading="lazy"
        onError={() => setFailed(true)}
        src={src}
      />
    </a>
  )
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${String(bytes)} B`
}

function DeliveryCard({
  entry,
  semantic,
}: {
  entry: RunActivityEntry
  semantic: Extract<ToolSemantic, { kind: 'delivery' }>
}) {
  const copyText = semantic.files
    .map(file =>
      file.description ? `${file.path} — ${file.description}` : file.path,
    )
    .join('\n')
  return (
    <div className="activity-card delivery-card">
      <header className="activity-card-header">
        <span>交付物</span>
        <span className="preview-meta">
          {String(semantic.files.length)} 个文件
        </span>
        <CopyAction label="复制交付清单" text={copyText} />
      </header>
      <ol className="delivery-files" role="list">
        {semantic.files.map(file => (
          <li key={file.path}>
            <span className="delivery-path" title={file.path}>
              {file.path}
            </span>
            {file.description && <small>{file.description}</small>}
          </li>
        ))}
      </ol>
      {entry.status === 'error' && (
        <p className="activity-empty is-error">
          交付声明未成功，以下为尝试的文件。
        </p>
      )}
    </div>
  )
}

function TodoFoldUnit({
  latest,
  history,
}: {
  latest: RunActivityEntry
  history: RunActivityEntry[]
}) {
  if (history.length === 0) return <ToolEntryRow entry={latest} />
  const headline = toolHeadline(latest)
  return (
    <li className="activity-tool activity-todo-fold">
      <details>
        <summary>
          <span className="activity-icon" aria-hidden="true">
            <ListChecks size={14} />
          </span>
          <span className="activity-label">
            <span className="activity-title">{headline.title}</span>
            {headline.subject && (
              <span className="activity-subject"> {headline.subject}</span>
            )}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="activity-chevron"
            size={14}
          />
        </summary>
        <ToolResultBody entry={latest} />
        <details className="todo-history">
          <summary>
            <History aria-hidden="true" size={13} />
            <span>历史快照 · {String(history.length)} 次更早写入</span>
            <ChevronDown
              aria-hidden="true"
              className="activity-chevron"
              size={13}
            />
          </summary>
          <ol className="activity-batch-items" role="list">
            {history.map(entry => (
              <ActivityEntryRow entry={entry} key={entry.seq} />
            ))}
          </ol>
        </details>
      </details>
    </li>
  )
}

function ThinkingRow({ entry }: { entry: RunActivityEntry }) {
  const running = entry.status === 'started'
  return (
    <li className="activity-thinking">
      <details>
        <summary>
          <span className="activity-icon" aria-hidden="true">
            {running ? (
              <RunningIcon>
                <Lightbulb size={14} />
              </RunningIcon>
            ) : (
              <Lightbulb size={14} />
            )}
          </span>
          <span className="activity-label">
            <span className="activity-title">思考</span>
            <span className="activity-thinking-preview">
              {thinkingHeadline(entry)}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className="activity-chevron"
            size={14}
          />
        </summary>
        <div className="activity-prose activity-thinking-body">
          <MarkdownMessage content={entry.detail ?? entry.label} />
        </div>
      </details>
    </li>
  )
}

function ThinkingFoldUnit({
  latest,
  history,
}: {
  latest: RunActivityEntry
  history: RunActivityEntry[]
}) {
  return (
    <li className="activity-thinking activity-thinking-fold">
      <details>
        <summary>
          <span className="activity-icon" aria-hidden="true">
            <Lightbulb size={14} />
          </span>
          <span className="activity-label">
            <span className="activity-title">思考</span>
            <span className="activity-thinking-preview">
              {thinkingHeadline(latest)}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className="activity-chevron"
            size={14}
          />
        </summary>
        <div className="activity-prose activity-thinking-body">
          <MarkdownMessage content={latest.detail ?? latest.label} />
        </div>
        <details className="todo-history">
          <summary>
            <History aria-hidden="true" size={13} />
            <span>更早的思考 · {String(history.length)} 段</span>
            <ChevronDown
              aria-hidden="true"
              className="activity-chevron"
              size={13}
            />
          </summary>
          <ol className="activity-batch-items" role="list">
            {history.map(entry => (
              <ThinkingRow entry={entry} key={entry.seq} />
            ))}
          </ol>
        </details>
      </details>
    </li>
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

function AskUserCard({
  entry,
  semantic,
}: {
  entry: RunActivityEntry
  semantic: Extract<ToolSemantic, { kind: 'ask_user' }>
}) {
  const running = entry.status === 'started'
  const failed = entry.status === 'error'
  const answers = new Map(
    (semantic.answers ?? []).map(answer => [answer.id, answer]),
  )
  const copyText = semantic.questions
    .map(question => {
      const answer = answers.get(question.id)
      const reply = answer
        ? [...answer.selected, ...(answer.custom ? [answer.custom] : [])].join(
            '、',
          ) || '（已跳过）'
        : undefined
      return `${question.question}${reply ? `\n回答：${reply}` : ''}`
    })
    .join('\n\n')
  return (
    <div className="activity-card ask-card">
      <header className="activity-card-header">
        <span>向用户提问</span>
        <span className="preview-meta">
          {String(semantic.questions.length)} 个问题
        </span>
        <CopyAction label="复制问答" text={copyText} />
      </header>
      <div className="ask-questions">
        {semantic.questions.map(question => {
          const answer = answers.get(question.id)
          const skipped = answer?.selected.length === 0 && !answer.custom
          return (
            <section className="ask-question" key={question.id}>
              {question.header && <small>{question.header}</small>}
              <p className="ask-question-text">{question.question}</p>
              {question.options && question.options.length > 0 && (
                <ol className="ask-options" role="list">
                  {question.options.map(option => {
                    const selected = answer?.selected.includes(option.label)
                    return (
                      <li
                        className={selected ? 'is-selected' : undefined}
                        key={option.label}
                      >
                        <span aria-hidden="true" className="ask-option-marker">
                          {selected ? <Check size={12} /> : <span />}
                        </span>
                        <span className="ask-option-label">{option.label}</span>
                        {option.description && (
                          <small>{option.description}</small>
                        )}
                      </li>
                    )
                  })}
                </ol>
              )}
              {answer?.custom && (
                <p className="ask-custom">回答：{answer.custom}</p>
              )}
              {skipped && <p className="ask-skipped">已跳过这个问题</p>}
              {question.multiSelect && !answer && (
                <p className="ask-skipped">可多选</p>
              )}
            </section>
          )
        })}
      </div>
      {semantic.preview && (
        <pre className="preview-body" tabIndex={0}>
          {semantic.preview}
        </pre>
      )}
      {semantic.previewTruncated && (
        <p className="activity-empty">内容过长，仅保留前段预览。</p>
      )}
      {(running || semantic.pending === true || failed) && (
        <footer className={`shell-footer is-${failed ? 'error' : 'running'}`}>
          {!failed && (
            <LoaderCircle
              aria-hidden="true"
              className="activity-spinner"
              size={12}
            />
          )}
          <span>
            {failed
              ? '失败'
              : running
                ? '等待回答中'
                : '超时未答，问题仍可回答'}
          </span>
        </footer>
      )}
    </div>
  )
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
