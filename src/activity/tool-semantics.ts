import type { DiffHunk, ToolSemantic } from '../core/domain.js'

const MAX_COMMAND_CHARACTERS = 4_000
const MAX_OUTPUT_CHARACTERS = 12_000
const MAX_PREVIEW_CHARACTERS = 4_000
const MAX_DIFF_LINES = 400
const CONTEXT_LINES = 3
const RESULT_SEPARATOR = '\n[结果]\n'

interface ToolCallInput {
  tool: string
  input?: string
}

interface ToolOutcome {
  status: 'completed' | 'error'
  result?: string
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
    case 'edit':
    case 'write':
    case 'apply_patch':
      return fileEditSemantic(call.tool, args)
    case 'grep':
    case 'glob':
    case 'search':
      return searchSemantic(args, result)
    case 'web_fetch':
    case 'web_search':
    case 'web_run':
      return webSemantic(args, result)
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
} {
  return value.length > maximum
    ? { text: value.slice(0, maximum), truncated: true }
    : { text: value, truncated: false }
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
  const output =
    result === undefined ? undefined : clip(result, MAX_OUTPUT_CHARACTERS)
  return {
    kind: 'shell',
    command: command.slice(0, MAX_COMMAND_CHARACTERS),
    ...(description ? { description: description.slice(0, 200) } : {}),
    ...(output
      ? {
          output: output.text,
          ...(output.truncated ? { outputTruncated: true } : {}),
        }
      : {}),
  }
}

function fileReadSemantic(
  args: Record<string, unknown>,
  result: string | undefined,
): ToolSemantic {
  const path = stringField(args, 'file_path', 'path')
  if (path === undefined) return { kind: 'unknown' }
  const content = extractTaggedContent(result)
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
        }
      : {}),
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
  args: Record<string, unknown>,
  result: string | undefined,
): ToolSemantic {
  const query = stringField(args, 'pattern', 'query', 'glob')
  if (query === undefined) return { kind: 'unknown' }
  const path = stringField(args, 'path', 'include')
  const preview =
    result === undefined ? undefined : clip(result, MAX_PREVIEW_CHARACTERS)
  return {
    kind: 'search',
    query,
    ...(path ? { path } : {}),
    ...(preview
      ? {
          preview: preview.text,
          ...(preview.truncated ? { previewTruncated: true } : {}),
        }
      : {}),
  }
}

function webSemantic(
  args: Record<string, unknown>,
  result: string | undefined,
): ToolSemantic {
  const url = stringField(args, 'url')
  const query = stringField(args, 'query')
  if (url === undefined && query === undefined) return { kind: 'unknown' }
  const preview =
    result === undefined ? undefined : clip(result, MAX_PREVIEW_CHARACTERS)
  return {
    kind: 'web',
    ...(url ? { url } : {}),
    ...(query ? { query } : {}),
    ...(preview
      ? {
          preview: preview.text,
          ...(preview.truncated ? { previewTruncated: true } : {}),
        }
      : {}),
  }
}
