import type {
  AskAnswer,
  AskQuestion,
  DiffHunk,
  SearchFileHits,
  TodoItem,
  ToolSemantic,
  WebSource,
} from '../core/domain.js'

const MAX_COMMAND_CHARACTERS = 4_000
const MAX_OUTPUT_CHARACTERS = 12_000
const MAX_PREVIEW_CHARACTERS = 4_000
const MAX_DIFF_LINES = 400
const MAX_WEB_SOURCES = 20
const MAX_WEB_QUERIES = 8
const MAX_AGENT_ENTRIES = 32
const MAX_AGENT_MESSAGE_CHARACTERS = 2_000
const MAX_SEARCH_FILES = 40
const MAX_SEARCH_MATCHES_PER_FILE = 20
const MAX_SEARCH_PATHS = 200
const MAX_SEARCH_LINE_CHARACTERS = 300
const MAX_TODO_ITEMS = 50
const MAX_TODO_CONTENT_CHARACTERS = 300
const MAX_ASK_QUESTIONS = 8
const MAX_ASK_OPTIONS = 8
const MAX_ASK_TEXT_CHARACTERS = 500
const MAX_DELIVERY_FILES = 8
const CONTEXT_LINES = 3
const RESULT_SEPARATOR = '\n[结果]\n'

interface ToolCallInput {
  tool: string
  input?: string
}

interface ToolOutcome {
  status: 'completed' | 'error'
  result?: string
  /** Structured `tool/result.meta` from the durable log, when available. */
  meta?: unknown
}

/**
 * Builds the bounded semantic projection stored next to the raw detail
 * string. Parsing is defensive: unknown shapes degrade to `{kind:'unknown'}`
 * so the UI can fall back to the raw transcript without inventing facts.
 */
export function buildToolSemantic(
  call: ToolCallInput,
  outcome?: ToolOutcome,
): ToolSemantic {
  const args = parseArguments(call.input)
  const result = outcome?.result
  switch (call.tool) {
    case 'bash':
    case 'shell':
    case 'exec_command':
      return shellSemantic(args, result, call.input)
    case 'read':
      return fileReadSemantic(args, result)
    case 'read_image':
      return imageSemantic(args, result)
    case 'present':
      return deliverySemantic(args, result)
    case 'edit':
    case 'write':
    case 'apply_patch':
      return fileEditSemantic(call.tool, args)
    case 'grep':
    case 'glob':
    case 'search':
      return searchSemantic(call.tool, args, result, outcome?.meta)
    case 'todo_write':
      return todoSemantic(args)
    case 'ask_user_question':
      return askUserSemantic(args, result)
    case 'web_fetch':
    case 'web_search':
    case 'web_run':
      return webSemantic(args, result, outcome?.meta)
    case 'wait_agent':
    case 'send_message':
    case 'list_agents':
    case 'interrupt_agent':
      return agentControlSemantic(call.tool, args, result)
    default:
      return { kind: 'unknown' }
  }
}

/** Splits the legacy merged detail string back into input and result. */
export function splitToolDetail(detail: string | undefined): {
  input?: string
  result?: string
} {
  if (detail === undefined) return {}
  const separator = detail.indexOf(RESULT_SEPARATOR)
  if (separator < 0) return { input: detail }
  return {
    input: detail.slice(0, separator),
    result: detail.slice(separator + RESULT_SEPARATOR.length),
  }
}

function parseArguments(input: string | undefined): Record<string, unknown> {
  if (!input?.trim()) return {}
  try {
    const parsed = JSON.parse(input) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Non-JSON input (legacy or truncated): keep empty, callers degrade.
  }
  return {}
}

/** Recovers the command from a clipped legacy JSON input, if possible. */
function commandFromClippedInput(
  input: string | undefined,
): string | undefined {
  if (input === undefined) return undefined
  const match = /"(?:command|cmd)"\s*:\s*"((?:[^"\\]|\\.)*)/u.exec(input)
  if (!match?.[1]) return undefined
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return match[1]
  }
}

function stringField(
  args: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function clip(
  value: string,
  maximum: number,
): {
  text: string
  truncated: boolean
  omittedCharacters?: number
} {
  if (value.length <= maximum) return { text: value, truncated: false }
  const headLength = Math.ceil(maximum / 2)
  const tailLength = maximum - headLength
  const omittedCharacters = value.length - maximum
  return {
    text: `${value.slice(0, headLength)}\n… 已省略 ${String(omittedCharacters)} 字符 …\n${value.slice(value.length - tailLength)}`,
    truncated: true,
    omittedCharacters,
  }
}

interface SpillNotice {
  path?: string
  body: string
}

/** Absolute spill-file locators recorded in one persisted semantic. */
export function semanticSpillPaths(
  semantic: ToolSemantic | undefined,
): string[] {
  if (!semantic) return []
  const paths =
    semantic.kind === 'shell'
      ? [semantic.outputSpillPath, semantic.outputRawSpillPath]
      : 'previewSpillPath' in semantic
        ? [semantic.previewSpillPath, semantic.previewRawSpillPath]
        : []
  return paths.filter(
    (path): path is string => typeof path === 'string' && path.startsWith('/'),
  )
}

const BASH_SPILL_NOTICE = /\n\[output truncated; full output: ([^\]\n]+)\]\s*$/u
const POLICY_SPILL_NOTICE =
  /\n?\(Omitted [^()\n]*?Full formatted result stored at: ([^()\n]+?)\. (?:Use [^()\n]*)\)\s*$/u

/**
 * EXEC-006 round 18: recognizes the executor's persisted spill notices at
 * the very end of a result — the bash tail notice and the generic retention
 * notice. Real results chain both (retention wraps the bash render), so
 * notices are peeled outermost-first and every absolute locator is kept;
 * callers prefer the first path (the formatted full copy) and fall back to
 * the raw stream path. `(unavailable)` stays an honest truncation.
 */
function extractSpillNotices(result: string): SpillNotice[] {
  const notices: SpillNotice[] = []
  let body = result
  for (;;) {
    const match = POLICY_SPILL_NOTICE.exec(body) ?? BASH_SPILL_NOTICE.exec(body)
    if (!match?.[1]) break
    const locator = match[1].trim()
    body = body.slice(0, match.index).trimEnd()
    notices.push({
      body,
      ...(locator.startsWith('/') ? { path: locator } : {}),
    })
  }
  return notices
}

function previewFields(result: string | undefined): Partial<{
  preview: string
  previewTruncated: boolean
  previewOmittedCharacters: number
  previewSpillPath: string
  previewRawSpillPath: string
}> {
  if (result === undefined) return {}
  const notices = extractSpillNotices(result)
  const [spillPath, rawSpillPath] = spillLocatorPaths(notices)
  const preview = clip(notices.at(-1)?.body ?? result, MAX_PREVIEW_CHARACTERS)
  return {
    ...(preview.text ? { preview: preview.text } : {}),
    ...(preview.truncated ? { previewTruncated: true } : {}),
    ...(preview.omittedCharacters !== undefined
      ? { previewOmittedCharacters: preview.omittedCharacters }
      : {}),
    ...(spillPath ? { previewSpillPath: spillPath } : {}),
    ...(rawSpillPath ? { previewRawSpillPath: rawSpillPath } : {}),
  }
}

/** First two distinct absolute locators: formatted copy, then raw stream. */
function spillLocatorPaths(
  notices: SpillNotice[],
): [string | undefined, string | undefined] {
  const paths = [
    ...new Set(
      notices
        .map(notice => notice.path)
        .filter((path): path is string => path !== undefined),
    ),
  ]
  return [paths[0], paths[1]]
}

function shellSemantic(
  args: Record<string, unknown>,
  result: string | undefined,
  rawInput?: string,
): ToolSemantic {
  const command =
    stringField(args, 'command', 'cmd') ?? commandFromClippedInput(rawInput)
  if (command === undefined) return { kind: 'unknown' }
  const description = stringField(args, 'description')
  const notices = result === undefined ? [] : extractSpillNotices(result)
  const spill =
    result === undefined ? undefined : { body: notices.at(-1)?.body ?? result }
  const [spillPath, rawSpillPath] = spillLocatorPaths(notices)
  const output =
    spill === undefined ? undefined : clip(spill.body, MAX_OUTPUT_CHARACTERS)
  return {
    kind: 'shell',
    command: command.slice(0, MAX_COMMAND_CHARACTERS),
    ...(description ? { description: description.slice(0, 200) } : {}),
    ...(output
      ? {
          output: output.text,
          ...(output.truncated ? { outputTruncated: true } : {}),
          ...(output.omittedCharacters !== undefined
            ? { outputOmittedCharacters: output.omittedCharacters }
            : {}),
        }
      : {}),
    ...(spillPath ? { outputSpillPath: spillPath } : {}),
    ...(rawSpillPath ? { outputRawSpillPath: rawSpillPath } : {}),
  }
}

function fileReadSemantic(
  args: Record<string, unknown>,
  result: string | undefined,
): ToolSemantic {
  const path = stringField(args, 'file_path', 'path')
  if (path === undefined) return { kind: 'unknown' }
  const notices = result === undefined ? [] : extractSpillNotices(result)
  const [spillPath, rawSpillPath] = spillLocatorPaths(notices)
  const content = extractTaggedContent(notices.at(-1)?.body ?? result)
  const lineCount = content ? countNumberedLines(content) : undefined
  const preview =
    content === undefined ? undefined : clip(content, MAX_PREVIEW_CHARACTERS)
  return {
    kind: 'file_read',
    path,
    ...(lineCount !== undefined ? { lineCount } : {}),
    ...(preview
      ? {
          preview: preview.text,
          ...(preview.truncated ? { previewTruncated: true } : {}),
          ...(preview.omittedCharacters !== undefined
            ? { previewOmittedCharacters: preview.omittedCharacters }
            : {}),
        }
      : {}),
    ...(spillPath ? { previewSpillPath: spillPath } : {}),
    ...(rawSpillPath ? { previewRawSpillPath: rawSpillPath } : {}),
  }
}

function extractTaggedContent(result: string | undefined): string | undefined {
  if (result === undefined) return undefined
  const match = /<content>\n?([\s\S]*?)\n?<\/content>/u.exec(result)
  return match?.[1]
}

function countNumberedLines(content: string): number | undefined {
  let last: number | undefined
  for (const line of content.split('\n')) {
    const match = /^(\d+): /u.exec(line)
    if (match?.[1]) last = Number.parseInt(match[1], 10)
  }
  return last
}

function fileEditSemantic(
  tool: string,
  args: Record<string, unknown>,
): ToolSemantic {
  const path = stringField(args, 'file_path', 'path')
  if (tool === 'apply_patch') {
    const patch = stringField(args, 'input', 'patch')
    if (patch === undefined) return { kind: 'unknown' }
    return patchSemantic(patch)
  }
  if (path === undefined) return { kind: 'unknown' }
  if (tool === 'write') {
    const content = stringField(args, 'content')
    if (content === undefined) return { kind: 'unknown' }
    const lines = splitLines(content)
    const bounded = lines.slice(0, MAX_DIFF_LINES)
    return {
      kind: 'file_edit',
      path,
      mode: 'write',
      additions: lines.length,
      deletions: 0,
      hunks: [
        {
          newStart: 1,
          lines: bounded.map(text => ({ type: 'add' as const, text })),
        },
      ],
      ...(lines.length > bounded.length ? { diffTruncated: true } : {}),
    }
  }
  const oldText = stringField(args, 'old_string', 'l')
  const newText = stringField(args, 'new_string', 'content')
  if (oldText === undefined || newText === undefined) return { kind: 'unknown' }
  const { hunks, additions, deletions, truncated } = replacementDiff(
    splitLines(oldText),
    splitLines(newText),
  )
  return {
    kind: 'file_edit',
    path,
    mode: 'edit',
    additions,
    deletions,
    hunks,
    ...(truncated ? { diffTruncated: true } : {}),
  }
}

function splitLines(value: string): string[] {
  const lines = value.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Produces context hunks for an in-place replacement. The absolute file line
 * numbers are unknown from the tool arguments, so hunks carry relative line
 * numbers only and the UI must not present them as file positions.
 */
function replacementDiff(
  oldLines: string[],
  newLines: string[],
): {
  hunks: DiffHunk[]
  additions: number
  deletions: number
  truncated: boolean
} {
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix)
  const added = newLines.slice(prefix, newLines.length - suffix)
  const contextBefore = oldLines.slice(
    Math.max(0, prefix - CONTEXT_LINES),
    prefix,
  )
  const contextAfter = oldLines.slice(
    oldLines.length - suffix,
    oldLines.length - suffix + CONTEXT_LINES,
  )
  const lines: DiffHunk['lines'] = [
    ...contextBefore.map(text => ({ type: 'context' as const, text })),
    ...removed.map(text => ({ type: 'del' as const, text })),
    ...added.map(text => ({ type: 'add' as const, text })),
    ...contextAfter.map(text => ({ type: 'context' as const, text })),
  ]
  const truncated = lines.length > MAX_DIFF_LINES
  return {
    hunks: [{ lines: lines.slice(0, MAX_DIFF_LINES) }],
    additions: added.length,
    deletions: removed.length,
    truncated,
  }
}

function patchSemantic(patch: string): ToolSemantic {
  const parsed = parseApplyPatch(patch)
  if (!parsed) return { kind: 'unknown' }
  return parsed
}

/** Parses the single-file update/add form of apply_patch; multi-file or
 * malformed patches degrade to unknown so nothing is fabricated. */
function parseApplyPatch(patch: string): ToolSemantic | undefined {
  const lines = patch.split('\n')
  if (lines[0]?.trim() !== '*** Begin Patch') return undefined
  const headers = lines.filter(line => line.startsWith('*** '))
  const fileHeaders = headers.filter(
    line =>
      line.startsWith('*** Update File: ') ||
      line.startsWith('*** Add File: ') ||
      line.startsWith('*** Delete File: '),
  )
  if (fileHeaders.length !== 1) return undefined
  const header = fileHeaders[0]
  if (!header) return undefined
  const mode = header.startsWith('*** Add File: ')
    ? 'write'
    : header.startsWith('*** Delete File: ')
      ? 'edit'
      : 'patch'
  const path = header.slice(header.indexOf(': ') + 2).trim()
  if (!path) return undefined
  const hunks: DiffHunk[] = []
  let current: DiffHunk | undefined
  let additions = 0
  let deletions = 0
  let total = 0
  let truncated = false
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const numbers = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line)
      current = {
        ...(numbers?.[1] ? { oldStart: Number.parseInt(numbers[1], 10) } : {}),
        ...(numbers?.[2] ? { newStart: Number.parseInt(numbers[2], 10) } : {}),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (!current) {
      if (mode === 'write' && line.startsWith('+')) {
        current = { newStart: 1, lines: [] }
        hunks.push(current)
      } else {
        continue
      }
    }
    if (line.startsWith('*** ')) continue
    const type = line.startsWith('+')
      ? ('add' as const)
      : line.startsWith('-')
        ? ('del' as const)
        : line.startsWith(' ')
          ? ('context' as const)
          : undefined
    if (!type) continue
    if (type === 'add') additions += 1
    if (type === 'del') deletions += 1
    total += 1
    if (total <= MAX_DIFF_LINES) {
      current.lines.push({ type, text: line.slice(1) })
    } else {
      truncated = true
    }
  }
  if (hunks.length === 0) return undefined
  return {
    kind: 'file_edit',
    path,
    mode,
    additions,
    deletions,
    hunks,
    ...(truncated ? { diffTruncated: true } : {}),
  }
}

function searchSemantic(
  tool: string,
  args: Record<string, unknown>,
  result: string | undefined,
  meta?: unknown,
): ToolSemantic {
  const query = stringField(args, 'pattern', 'query', 'glob')
  if (query === undefined) return { kind: 'unknown' }
  const path = stringField(args, 'path')
  const include = stringField(args, 'include')
  const structured =
    searchMetaStructure(meta) ??
    (tool === 'grep'
      ? grepResultSemantic(result)
      : tool === 'glob'
        ? globResultSemantic(result)
        : undefined)
  return {
    kind: 'search',
    query,
    ...(path ? { path } : {}),
    ...(include ? { include } : {}),
    ...structured,
    ...(structured ? {} : previewFields(result)),
  }
}

function webSemantic(
  args: Record<string, unknown>,
  result: string | undefined,
  meta?: unknown,
): ToolSemantic {
  const url = stringField(args, 'url')
  const query = stringField(args, 'query') ?? firstQuery(args.queries)
  const queries = queryList(args.queries)
  if (url === undefined && query === undefined) return { kind: 'unknown' }
  const metaRecord = isMetaRecord(meta) ? meta : undefined
  const metaStatus =
    typeof metaRecord?.statusCode === 'number' &&
    Number.isSafeInteger(metaRecord.statusCode)
      ? metaRecord.statusCode
      : undefined
  const statusCode =
    url !== undefined ? (metaStatus ?? fetchStatusCode(result)) : undefined
  const parsedSources =
    url === undefined
      ? (webMetaSources(metaRecord) ?? parseSearchSources(result))
      : undefined
  return {
    kind: 'web',
    ...(url ? { url } : {}),
    ...(query ? { query } : {}),
    ...(queries && queries.length > 1 ? { queries } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(parsedSources && parsedSources.sources.length > 0
      ? {
          sources: parsedSources.sources,
          ...(parsedSources.truncated ? { sourcesTruncated: true } : {}),
        }
      : {}),
    ...previewFields(result),
  }
}

function firstQuery(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const first: unknown = value[0]
  return typeof first === 'string' && first.trim() ? first : undefined
}

function queryList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const queries = value
    .filter(
      (item): item is string => typeof item === 'string' && item.trim() !== '',
    )
    .slice(0, MAX_WEB_QUERIES)
  return queries.length > 0 ? queries : undefined
}

/** Reads the HTTP status from the faithful `Fetched <url> (HTTP N)` header. */
function fetchStatusCode(result: string | undefined): number | undefined {
  if (result === undefined) return undefined
  const match = /^Fetched \S+ \(HTTP (\d{3})\)/u.exec(result)
  if (!match?.[1]) return undefined
  const code = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(code) ? code : undefined
}

/**
 * Parses the DSH search render's `Sources:` markdown list. Only the faithful
 * `- [label](url)` lines are projected; the excerpt suffix is kept as a bounded
 * snippet. Structured `tool/result.meta` is not carried by the `--json` stream,
 * so this text route is the honest best-effort projection.
 */
function parseSearchSources(
  result: string | undefined,
): { sources: WebSource[]; truncated: boolean } | undefined {
  if (result === undefined) return undefined
  const section = /(?:^|\n)Sources:\n([\s\S]*?)(?:\n\n|$)/u.exec(result)
  if (!section?.[1]) return undefined
  const sources: WebSource[] = []
  let truncated = /\(Showing the first \d+ sources\./u.test(result)
  for (const line of section[1].split('\n')) {
    const match = /^- \[([^\]]*)\]\((\S+?)\)(?: — ([\s\S]*))?$/u.exec(line)
    if (!match?.[2]) continue
    if (sources.length >= MAX_WEB_SOURCES) {
      truncated = true
      break
    }
    const label = match[1] ?? ''
    const snippet = match[3]
    sources.push({
      url: match[2],
      ...(label && label !== match[2] ? { title: label.slice(0, 200) } : {}),
      ...(snippet ? { snippet: snippet.slice(0, 300) } : {}),
    })
  }
  return { sources, truncated }
}

function agentControlSemantic(
  tool: string,
  args: Record<string, unknown>,
  result: string | undefined,
): ToolSemantic {
  const agent = stringField(args, 'agent', 'target', 'name')
  const preview = previewFields(result)
  switch (tool) {
    case 'wait_agent': {
      const timeout = args.timeout_ms
      const timedOut = parseTimedOut(result)
      return {
        kind: 'agent_control',
        action: 'wait',
        ...(typeof timeout === 'number' && Number.isSafeInteger(timeout)
          ? { timeoutMs: timeout }
          : {}),
        ...(timedOut !== undefined ? { timedOut } : {}),
        ...preview,
      }
    }
    case 'send_message': {
      const message = stringField(args, 'message')
      if (agent === undefined && message === undefined)
        return { kind: 'unknown' }
      return {
        kind: 'agent_control',
        action: 'message',
        ...(agent ? { agent } : {}),
        ...(message
          ? { message: message.slice(0, MAX_AGENT_MESSAGE_CHARACTERS) }
          : {}),
        ...preview,
      }
    }
    case 'interrupt_agent':
      if (agent === undefined) return { kind: 'unknown' }
      return {
        kind: 'agent_control',
        action: 'interrupt',
        agent,
        ...preview,
      }
    default: {
      const agents = parseAgentList(result)
      return {
        kind: 'agent_control',
        action: 'list',
        ...(agents && agents.length > 0 ? { agents } : {}),
        ...preview,
      }
    }
  }
}

function parseTimedOut(result: string | undefined): boolean | undefined {
  if (result === undefined) return undefined
  try {
    const parsed = JSON.parse(result) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { timedOut?: unknown }).timedOut === 'boolean'
    )
      return (parsed as { timedOut: boolean }).timedOut
  } catch {
    return undefined
  }
  return undefined
}

/** Parses the faithful `name [status] — description` list render. */
function parseAgentList(
  result: string | undefined,
): { name: string; status: string; description?: string }[] | undefined {
  if (result === undefined) return undefined
  const agents: { name: string; status: string; description?: string }[] = []
  for (const line of result.split('\n')) {
    const match = /^(\S+) \[([a-z_]+)\](?: — (.*))?$/u.exec(line.trim())
    if (!match?.[1] || !match[2]) continue
    if (agents.length >= MAX_AGENT_ENTRIES) break
    agents.push({
      name: match[1].slice(0, 120),
      status: match[2],
      ...(match[3] ? { description: match[3].slice(0, 200) } : {}),
    })
  }
  return agents.length > 0 ? agents : undefined
}

interface SearchStructure {
  shape: 'matches' | 'paths'
  total?: number
  resultTruncated?: boolean
  files?: SearchFileHits[]
  paths?: string[]
}

/**
 * Parses the faithful grep render: `Found N match(es)` (or `Found K of N
 * matches` when capped), then per-file groups of `Line N: text` rows. The
 * structured `tool/result.meta` does not ride the `--json` stream, so this
 * text route is the honest best-effort projection; unrecognized shapes keep
 * the preview fallback.
 */
function grepResultSemantic(
  result: string | undefined,
): SearchStructure | undefined {
  if (result === undefined) return undefined
  if (result.trim() === 'No matches found') {
    return { shape: 'matches', total: 0, files: [] }
  }
  const header = /^Found (\d+)(?: of (\d+))? match(?:es)?\b/u.exec(result)
  if (!header?.[1]) return undefined
  const kept = Number.parseInt(header[1], 10)
  const seen = header[2] ? Number.parseInt(header[2], 10) : kept
  const files: SearchFileHits[] = []
  let current: SearchFileHits | undefined
  let retained = 0
  let dropped = false
  for (const line of result.split('\n').slice(1)) {
    const match = /^Line (\d+): (.*)$/u.exec(line)
    if (match?.[1]) {
      if (!current) {
        dropped = true
        continue
      }
      retained += 1
      if (current.matches.length >= MAX_SEARCH_MATCHES_PER_FILE) {
        dropped = true
        continue
      }
      current.matches.push({
        line: Number.parseInt(match[1], 10),
        text: (match[2] ?? '').slice(0, MAX_SEARCH_LINE_CHARACTERS),
      })
      continue
    }
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('(')) continue
    if (files.length >= MAX_SEARCH_FILES) {
      dropped = true
      current = undefined
      continue
    }
    current = { path: trimmed, matches: [] }
    files.push(current)
  }
  const nonEmpty = files.filter(file => file.matches.length > 0)
  return {
    shape: 'matches',
    total: seen,
    ...(header[2] || dropped || retained < kept
      ? { resultTruncated: true }
      : {}),
    files: nonEmpty,
  }
}

/**
 * Parses the faithful glob render: one path per line, `No files found` when
 * empty, and a trailing `(Showing K of N paths…)` note when capped. Lines
 * that do not look like paths abort the projection so a foreign render keeps
 * the preview fallback instead of inventing structure.
 */
function globResultSemantic(
  result: string | undefined,
): SearchStructure | undefined {
  if (result === undefined) return undefined
  if (result.trim() === 'No files found') {
    return { shape: 'paths', total: 0, paths: [] }
  }
  const showing = /\(Showing (\d+) of (\d+) paths/u.exec(result)
  const paths: string[] = []
  let dropped = false
  for (const line of result.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('(')) continue
    if (/\s/u.test(trimmed)) return undefined
    if (paths.length >= MAX_SEARCH_PATHS) {
      dropped = true
      continue
    }
    paths.push(trimmed)
  }
  if (paths.length === 0) return undefined
  const total = showing?.[2] ? Number.parseInt(showing[2], 10) : paths.length
  const kept = showing?.[1] ? Number.parseInt(showing[1], 10) : paths.length
  return {
    shape: 'paths',
    total,
    ...(showing || dropped || paths.length < kept
      ? { resultTruncated: true }
      : {}),
    paths,
  }
}

/** Projects the whole-list todo_write snapshot; malformed lists degrade. */
function todoSemantic(args: Record<string, unknown>): ToolSemantic {
  const raw = args.todos
  if (!Array.isArray(raw)) return { kind: 'unknown' }
  const items: TodoItem[] = []
  let dropped = false
  for (const entry of raw) {
    if (items.length >= MAX_TODO_ITEMS) {
      dropped = true
      break
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      dropped = true
      continue
    }
    const record = entry as Record<string, unknown>
    const content = record.content
    const status = record.status
    if (
      typeof content !== 'string' ||
      !content.trim() ||
      (status !== 'pending' &&
        status !== 'in_progress' &&
        status !== 'completed')
    ) {
      dropped = true
      continue
    }
    items.push({
      content: content.trim().slice(0, MAX_TODO_CONTENT_CHARACTERS),
      status,
    })
  }
  if (items.length === 0) return { kind: 'unknown' }
  return {
    kind: 'todo',
    items,
    ...(dropped ? { itemsTruncated: true } : {}),
  }
}

/**
 * Projects ask_user_question calls: the question batch from the arguments
 * and the answer batch (or the timed `pending` notice) from the JSON result.
 * A running call has no result yet; an unparsable result keeps the preview
 * fallback instead of inventing answers.
 */
function askUserSemantic(
  args: Record<string, unknown>,
  result: string | undefined,
): ToolSemantic {
  const questions = parseAskQuestions(args.questions)
  if (!questions) return { kind: 'unknown' }
  const outcome = parseAskOutcome(result)
  return {
    kind: 'ask_user',
    questions,
    ...(outcome && 'answers' in outcome ? { answers: outcome.answers } : {}),
    ...(outcome && 'pending' in outcome ? { pending: true } : {}),
    ...(outcome ? {} : previewFields(result)),
  }
}

function parseAskQuestions(raw: unknown): AskQuestion[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const questions: AskQuestion[] = []
  for (const entry of raw) {
    if (questions.length >= MAX_ASK_QUESTIONS) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const id = record.id
    const question = record.question
    if (
      typeof id !== 'string' ||
      !id.trim() ||
      typeof question !== 'string' ||
      !question.trim()
    ) {
      continue
    }
    const header = record.header
    const options = parseAskOptions(record.options)
    questions.push({
      id: id.slice(0, 120),
      question: question.trim().slice(0, MAX_ASK_TEXT_CHARACTERS),
      ...(typeof header === 'string' && header.trim()
        ? { header: header.trim().slice(0, 80) }
        : {}),
      ...(options ? { options } : {}),
      ...(record.multi_select === true ? { multiSelect: true } : {}),
    })
  }
  return questions.length > 0 ? questions : undefined
}

function parseAskOptions(
  raw: unknown,
): { label: string; description?: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const options: { label: string; description?: string }[] = []
  for (const entry of raw) {
    if (options.length >= MAX_ASK_OPTIONS) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const label = record.label
    if (typeof label !== 'string' || !label.trim()) continue
    const description = record.description
    options.push({
      label: label.trim().slice(0, 200),
      ...(typeof description === 'string' && description.trim()
        ? { description: description.trim().slice(0, MAX_ASK_TEXT_CHARACTERS) }
        : {}),
    })
  }
  return options.length > 0 ? options : undefined
}

function parseAskOutcome(
  result: string | undefined,
): { answers: AskAnswer[] } | { pending: true } | undefined {
  if (result === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(result) as unknown
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }
  const record = parsed as Record<string, unknown>
  if (record.pending === true) return { pending: true }
  if (!Array.isArray(record.answers)) return undefined
  const answers: AskAnswer[] = []
  for (const entry of record.answers) {
    if (answers.length >= MAX_ASK_QUESTIONS) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const answer = entry as Record<string, unknown>
    const id = answer.id
    if (typeof id !== 'string' || !id.trim()) continue
    const selected = Array.isArray(answer.selected)
      ? answer.selected
          .filter(
            (item): item is string =>
              typeof item === 'string' && item.trim() !== '',
          )
          .slice(0, MAX_ASK_OPTIONS)
          .map(item => item.slice(0, 200))
      : []
    const custom = answer.custom
    answers.push({
      id: id.slice(0, 120),
      selected,
      ...(typeof custom === 'string' && custom.trim()
        ? { custom: custom.trim().slice(0, MAX_ASK_TEXT_CHARACTERS) }
        : {}),
    })
  }
  return { answers }
}

function isMetaRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Reads the structured grep/glob `tool/result.meta` from the durable log.
 * This is the faithful route (the `--json` stream drops meta); malformed
 * shapes return undefined so the render-text parsers stay the fallback.
 */
function searchMetaStructure(meta: unknown): SearchStructure | undefined {
  if (!isMetaRecord(meta)) return undefined
  const total =
    typeof meta.total === 'number' && Number.isSafeInteger(meta.total)
      ? meta.total
      : undefined
  const truncated = meta.truncated === true
  if (meta.shape === 'matches' && Array.isArray(meta.files)) {
    const files: SearchFileHits[] = []
    let dropped = false
    for (const entry of meta.files) {
      if (files.length >= MAX_SEARCH_FILES) {
        dropped = true
        break
      }
      if (!isMetaRecord(entry) || typeof entry.path !== 'string') continue
      const matches: { line: number; text: string }[] = []
      if (Array.isArray(entry.matches)) {
        for (const match of entry.matches) {
          if (matches.length >= MAX_SEARCH_MATCHES_PER_FILE) {
            dropped = true
            break
          }
          if (
            !isMetaRecord(match) ||
            typeof match.lineNumber !== 'number' ||
            typeof match.line !== 'string'
          ) {
            continue
          }
          matches.push({
            line: match.lineNumber,
            text: match.line.slice(0, MAX_SEARCH_LINE_CHARACTERS),
          })
        }
      }
      files.push({ path: entry.path, matches })
    }
    return {
      shape: 'matches',
      ...(total !== undefined ? { total } : {}),
      ...(truncated || dropped ? { resultTruncated: true } : {}),
      files,
    }
  }
  if (meta.shape === 'paths' && Array.isArray(meta.paths)) {
    const paths: string[] = []
    let dropped = false
    for (const entry of meta.paths) {
      if (typeof entry !== 'string') continue
      if (paths.length >= MAX_SEARCH_PATHS) {
        dropped = true
        break
      }
      paths.push(entry)
    }
    return {
      shape: 'paths',
      ...(total !== undefined ? { total } : {}),
      ...(truncated || dropped ? { resultTruncated: true } : {}),
      paths,
    }
  }
  return undefined
}

/** Reads the structured web_search sources from the durable-log meta. */
function webMetaSources(
  meta: Record<string, unknown> | undefined,
): { sources: WebSource[]; truncated?: boolean } | undefined {
  if (!meta || !Array.isArray(meta.sources)) return undefined
  const sources: WebSource[] = []
  for (const entry of meta.sources) {
    if (sources.length >= MAX_WEB_SOURCES) break
    if (!isMetaRecord(entry) || typeof entry.url !== 'string') continue
    const title = entry.title
    const snippet = entry.snippet
    sources.push({
      url: entry.url,
      ...(typeof title === 'string' && title && title !== entry.url
        ? { title }
        : {}),
      ...(typeof snippet === 'string' && snippet ? { snippet } : {}),
    })
  }
  if (sources.length === 0) return undefined
  return {
    sources,
    ...(meta.truncated === true ? { truncated: true } : {}),
  }
}

/**
 * Projects read_image calls from the faithful envelope
 * `<path>…</path><type>image</type><content>media, WxH px, N bytes…</content>`.
 * The image bytes never ride the transcript; only honest metadata is kept.
 */
function imageSemantic(
  args: Record<string, unknown>,
  result: string | undefined,
): ToolSemantic {
  const path =
    stringField(args, 'file_path', 'path') ??
    (result === undefined
      ? undefined
      : /<path>([^<]+)<\/path>/u.exec(result)?.[1])
  if (path === undefined) return { kind: 'unknown' }
  const content =
    result === undefined
      ? undefined
      : /<content>\s*([\s\S]*?)\s*<\/content>/u.exec(result)?.[1]
  const facts =
    content === undefined
      ? undefined
      : /^(image\/[a-z+]+) image, (\d+)x(\d+) px, (\d+) bytes/u.exec(content)
  const original =
    content === undefined
      ? undefined
      : /downscaled from (\d+)x(\d+) px/u.exec(content)
  return {
    kind: 'image',
    path,
    ...(facts?.[1] ? { mediaType: facts[1] } : {}),
    ...(facts?.[2] && facts[3]
      ? {
          width: Number.parseInt(facts[2], 10),
          height: Number.parseInt(facts[3], 10),
        }
      : {}),
    ...(facts?.[4] ? { bytes: Number.parseInt(facts[4], 10) } : {}),
    ...(original?.[1] && original[2]
      ? {
          originalWidth: Number.parseInt(original[1], 10),
          originalHeight: Number.parseInt(original[2], 10),
        }
      : {}),
  }
}

/** Projects present calls into the declared deliverable file list. */
function deliverySemantic(
  args: Record<string, unknown>,
  result: string | undefined,
): ToolSemantic {
  const raw = args.files
  const files: { path: string; description?: string }[] = []
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (files.length >= MAX_DELIVERY_FILES) break
      if (!isMetaRecord(entry) || typeof entry.path !== 'string') continue
      if (!entry.path.trim()) continue
      const description = entry.description
      files.push({
        path: entry.path,
        ...(typeof description === 'string' && description.trim()
          ? { description: description.trim().slice(0, 300) }
          : {}),
      })
    }
  }
  if (files.length === 0) return { kind: 'unknown' }
  return {
    kind: 'delivery',
    files,
    ...previewFields(result),
  }
}
