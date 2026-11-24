import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const MAX_EFFECT_FILE_BYTES = 10 * 1024 * 1024

/**
 * EXEC-003: derive the intended final bytes of a file mutation before it
 * runs, so automatic reconciliation can verify landed content instead of
 * mere existence. The derivation mirrors the executor's own edit/patch
 * semantics (LF-normalized editing with line-ending restore); anything it
 * cannot statically replay returns undefined and stays on the conservative
 * existence-or-human path. No filesystem writes happen here.
 *
 * @param {{ name: string, arguments?: unknown }} execution
 * @param {{ workspaceRoot?: string }} context
 * @returns {{ contentHash?: string, targets?: Record<string, string>, absent?: string[] } | undefined}
 */
export function deriveWriteEffect(execution, context) {
  const arguments_ = record(execution.arguments)
  if (!arguments_) return undefined
  if (execution.name === 'write') {
    return typeof arguments_.content === 'string'
      ? { contentHash: hash(arguments_.content) }
      : undefined
  }
  if (execution.name === 'edit') {
    return deriveEditEffect(arguments_, context)
  }
  if (execution.name === 'apply_patch') {
    return derivePatchEffect(arguments_, context)
  }
  if (execution.name === 'bash') {
    return deriveBashEffect(arguments_, context)
  }
  return undefined
}

/**
 * @param {Record<string, unknown>} arguments_
 * @param {{ workspaceRoot?: string }} context
 * @returns {{ contentHash: string } | undefined}
 */
function deriveEditEffect(arguments_, context) {
  const target = targetPath(arguments_.file_path, context)
  if (target === undefined) return undefined
  if (
    typeof arguments_.old_string !== 'string' ||
    typeof arguments_.new_string !== 'string'
  )
    return undefined
  const original = readForEdit(target)
  if (!original) return undefined
  const oldNormalized = normalizeLf(arguments_.old_string)
  const newNormalized = normalizeLf(arguments_.new_string)
  if (oldNormalized.length === 0) return undefined
  const occurrences = countOccurrences(original.content, oldNormalized)
  if (occurrences === 0) return undefined
  if (arguments_.replace_all !== true && occurrences > 1) return undefined
  const edited = original.content.split(oldNormalized).join(newNormalized)
  return { contentHash: hash(restoreLineEndings(edited, original.crlf)) }
}

/**
 * @param {Record<string, unknown>} arguments_
 * @param {{ workspaceRoot?: string }} context
 * @returns {{ targets?: Record<string, string>, absent?: string[] } | undefined}
 */
function derivePatchEffect(arguments_, context) {
  const patch =
    typeof arguments_.input === 'string'
      ? arguments_.input
      : typeof arguments_.patch === 'string'
        ? arguments_.patch
        : undefined
  if (patch === undefined) return undefined
  const operations = parsePatch(patch)
  if (!operations || operations.length === 0) return undefined
  /** @type {Record<string, string>} */
  const targets = {}
  /** @type {string[]} */
  const absent = []
  /** @type {Set<string>} */
  const touched = new Set()
  /** @param {string} path */
  const claim = path => {
    if (touched.has(path)) return false
    touched.add(path)
    return true
  }
  for (const operation of operations) {
    const target = targetPath(operation.path, context)
    if (target === undefined || !claim(target)) return undefined
    if (operation.kind === 'delete') {
      absent.push(target)
      continue
    }
    if (operation.kind === 'add') {
      targets[target] = hash(operation.content)
      continue
    }
    const original = readForEdit(target)
    if (!original) return undefined
    if (operation.moveTo !== undefined) {
      const destination = targetPath(operation.moveTo, context)
      if (destination === undefined || !claim(destination)) return undefined
      const moved =
        operation.hunks.length === 0
          ? original.content
          : applyHunks(original.content, operation.hunks)
      if (moved === undefined) return undefined
      targets[destination] = hash(restoreLineEndings(moved, original.crlf))
      absent.push(target)
      continue
    }
    const applied = applyHunks(original.content, operation.hunks)
    if (applied === undefined) return undefined
    targets[target] = hash(restoreLineEndings(applied, original.crlf))
  }
  return {
    ...(Object.keys(targets).length > 0 ? { targets } : {}),
    ...(absent.length > 0 ? { absent } : {}),
  }
}

/**
 * Replay only the bash forms whose landed bytes are fully determined by
 * the command text: a single `echo`/`printf` with literal arguments and
 * one `>` or `>>` redirect. Pipelines, substitutions, compound commands
 * and any other write command stay unverifiable.
 *
 * @param {Record<string, unknown>} arguments_
 * @param {{ workspaceRoot?: string }} context
 * @returns {{ targets: Record<string, string> } | undefined}
 */
function deriveBashEffect(arguments_, context) {
  const command = arguments_.command
  if (typeof command !== 'string') return undefined
  if (/[;|&`]|\$\(|\$\{|\n/.test(command)) return undefined
  const redirect = /(?<![>])>{1,2}(?![>])/.exec(command)
  if (!redirect) return undefined
  const operator = redirect[0]
  const head = command.slice(0, redirect.index).trim()
  const tail = command.slice(redirect.index + operator.length).trim()
  if (tail.length === 0 || tail.includes('<') || tail.includes('>'))
    return undefined
  const targetTokens = splitShellWords(tail)
  if (targetTokens?.length !== 1) return undefined
  const target = targetPath(targetTokens[0], context)
  if (target === undefined || target.startsWith('/dev/')) return undefined
  const words = splitShellWords(head)
  if (words === undefined || words.length < 2) return undefined
  const program = words[0]
  if (program !== 'echo' && program !== 'printf') return undefined
  const operands = words.slice(1)
  let body
  if (program === 'echo') {
    if (operands.some(word => word.startsWith('-'))) return undefined
    body = `${operands.join(' ')}\n`
  } else {
    if (operands.length !== 1) return undefined
    const format = operands[0]
    if (format === undefined || format.includes('%')) return undefined
    body = unescapePrintf(format)
    if (body === undefined) return undefined
  }
  if (operator === '>') {
    return { targets: { [target]: hash(body) } }
  }
  const original = readForEdit(target)
  const base =
    original === undefined
      ? ''
      : restoreLineEndings(original.content, original.crlf)
  if (original === undefined && !fileMissing(target)) return undefined
  return { targets: { [target]: hash(base + body) } }
}

/** @param {string} target */
function fileMissing(target) {
  try {
    statSync(target)
    return false
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
  }
}

/**
 * Split a shell fragment into literal words. Returns undefined when the
 * fragment contains anything beyond plain words and simple quoting.
 *
 * @param {string} fragment
 * @returns {string[] | undefined}
 */
function splitShellWords(fragment) {
  /** @type {string[]} */
  const words = []
  let current = ''
  let started = false
  let index = 0
  while (index < fragment.length) {
    const character = fragment[index]
    if (character === undefined) return undefined
    if (character === ' ' || character === '\t') {
      if (started) words.push(current)
      current = ''
      started = false
      index += 1
      continue
    }
    started = true
    if (character === "'") {
      const close = fragment.indexOf("'", index + 1)
      if (close === -1) return undefined
      current += fragment.slice(index + 1, close)
      index = close + 1
      continue
    }
    if (character === '"') {
      const close = fragment.indexOf('"', index + 1)
      if (close === -1) return undefined
      const inner = fragment.slice(index + 1, close)
      if (/[$`\\]/.test(inner)) return undefined
      current += inner
      index = close + 1
      continue
    }
    if (character === '\\') {
      if (index + 1 >= fragment.length) return undefined
      const escaped = fragment[index + 1]
      if (escaped === undefined) return undefined
      current += escaped
      index += 2
      continue
    }
    if (
      character === '$' ||
      character === '`' ||
      character === '*' ||
      character === '?'
    ) {
      return undefined
    }
    current += character
    index += 1
  }
  if (started) words.push(current)
  return words
}

/**
 * @param {string} format
 * @returns {string | undefined}
 */
function unescapePrintf(format) {
  let result = ''
  let index = 0
  while (index < format.length) {
    const character = format[index]
    if (character === undefined) return undefined
    if (character !== '\\') {
      result += character
      index += 1
      continue
    }
    const next = format[index + 1]
    if (next === undefined) return undefined
    /** @type {Record<string, string>} */
    const simple = {
      n: '\n',
      t: '\t',
      r: '\r',
      '\\': '\\',
      a: '\x07',
      b: '\b',
      f: '\f',
      v: '\v',
    }
    const replacement = simple[next]
    if (replacement !== undefined) {
      result += replacement
      index += 2
      continue
    }
    if (next === '0') {
      const octal = /^[0-7]{1,3}/.exec(format.slice(index + 2))
      const digits = octal ? octal[0] : ''
      result += String.fromCharCode(Number.parseInt(digits || '0', 8))
      index += 2 + digits.length
      continue
    }
    return undefined
  }
  return result
}

/**
 * @param {unknown} value
 * @param {{ workspaceRoot?: string }} context
 * @returns {string | undefined}
 */
function targetPath(value, context) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const absolute = isAbsolute(value)
    ? value
    : context.workspaceRoot
      ? join(context.workspaceRoot, value)
      : resolve(value)
  try {
    return realpathSync(absolute)
  } catch {
    try {
      return join(
        realpathSync(dirname(absolute)),
        absolute.slice(dirname(absolute).length + 1),
      )
    } catch {
      return resolve(absolute)
    }
  }
}

/**
 * @param {string} target
 * @returns {{ content: string, crlf: boolean } | undefined}
 */
function readForEdit(target) {
  try {
    const info = statSync(target)
    if (!info.isFile() || info.size >= MAX_EFFECT_FILE_BYTES) return undefined
    const buffer = readFileSync(target)
    if (buffer.includes(0)) return undefined
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return { content: normalizeLf(raw), crlf: detectCrlf(raw) }
  } catch {
    return undefined
  }
}

/** @param {string} content */
function normalizeLf(content) {
  return content.replaceAll('\r\n', '\n')
}

/** @param {string} raw */
function detectCrlf(raw) {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  return crlfCount > sample.split('\n').length - 1 - crlfCount
}

/**
 * @param {string} content
 * @param {boolean} crlf
 */
function restoreLineEndings(content, crlf) {
  return crlf ? normalizeLf(content).split('\n').join('\r\n') : content
}

/**
 * @param {string} content
 * @param {string} needle
 */
function countOccurrences(content, needle) {
  let count = 0
  let index = 0
  for (;;) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/** @param {string} content */
function hash(content) {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function record(value) {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return /** @type {Record<string, unknown>} */ (value)
  }
  return undefined
}

/**
 * @typedef {{ kind: 'add', path: string, content: string }
 *   | { kind: 'delete', path: string }
 *   | { kind: 'update', path: string, moveTo?: string, hunks: PatchHunk[] }} PatchOperation
 */
/** @typedef {{ context?: string, oldLines: string[], newLines: string[], endOfFile: boolean }} PatchHunk */

/**
 * Parse the Codex-style patch envelope. Returns undefined for any syntax
 * this parser does not fully understand, so callers fail closed.
 *
 * @param {string} patch
 * @returns {PatchOperation[] | undefined}
 */
function parsePatch(patch) {
  const lines = patch.replaceAll('\r\n', '\n').split('\n')
  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift()
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop()
  if (lines.length < 2) return undefined
  if (lines[0]?.trim() !== '*** Begin Patch') return undefined
  if (lines.at(-1)?.trim() !== '*** End Patch') return undefined
  /** @type {PatchOperation[]} */
  const operations = []
  let ended = false
  for (const line of lines.slice(1, -1)) {
    if (ended) {
      if (line.trim() !== '') return undefined
      continue
    }
    const header = line.trimEnd()
    if (header === '*** End Patch') {
      ended = true
      continue
    }
    if (header.startsWith('*** Add File: ')) {
      operations.push({
        kind: 'add',
        path: header.slice('*** Add File: '.length),
        content: '',
      })
      continue
    }
    if (header.startsWith('*** Delete File: ')) {
      operations.push({
        kind: 'delete',
        path: header.slice('*** Delete File: '.length),
      })
      continue
    }
    if (header.startsWith('*** Update File: ')) {
      operations.push({
        kind: 'update',
        path: header.slice('*** Update File: '.length),
        hunks: [],
      })
      continue
    }
    const operation = operations.at(-1)
    if (!operation) return undefined
    if (operation.kind === 'add') {
      if (!line.startsWith('+')) return undefined
      operation.content += `${line.slice(1)}\n`
      continue
    }
    if (operation.kind !== 'update') return undefined
    if (!readUpdateLine(operation, line)) return undefined
  }
  for (const operation of operations) {
    if (operation.kind !== 'update') continue
    if (operation.hunks.length === 0) return undefined
    for (const hunk of operation.hunks) {
      if (hunk.oldLines.length === 0 && hunk.newLines.length === 0)
        return undefined
    }
  }
  return operations
}

/**
 * @param {{ kind: 'update', path: string, moveTo?: string, hunks: PatchHunk[] }} operation
 * @param {string} line
 * @returns {boolean}
 */
function readUpdateLine(operation, line) {
  const text = line.trimEnd()
  const previous = operation.hunks.at(-1)
  if (previous?.endOfFile) {
    if (text === '') return true
    return text === '@@' || text.startsWith('@@ ')
      ? pushHunk(operation, text)
      : false
  }
  if (
    previous === undefined &&
    operation.moveTo === undefined &&
    text.startsWith('*** Move to: ')
  ) {
    operation.moveTo = text.slice('*** Move to: '.length)
    return true
  }
  if (text === '@@' || text.startsWith('@@ ')) {
    return pushHunk(operation, text)
  }
  if (text === '*** End of File') {
    if (previous) previous.endOfFile = true
    return true
  }
  const prefix = line[0]
  if (line !== '' && prefix !== ' ' && prefix !== '+' && prefix !== '-')
    return false
  const hunk =
    previous ??
    (operation.hunks.push({ oldLines: [], newLines: [], endOfFile: false }),
    operation.hunks.at(-1))
  if (!hunk) return false
  const content = line.slice(1)
  if (prefix === '+') hunk.newLines.push(content)
  else if (prefix === '-') hunk.oldLines.push(content)
  else {
    hunk.oldLines.push(content)
    hunk.newLines.push(content)
  }
  return true
}

/**
 * @param {{ hunks: PatchHunk[] }} operation
 * @param {string} text
 */
function pushHunk(operation, text) {
  const previous = operation.hunks.at(-1)
  if (previous?.oldLines.length === 0 && previous.newLines.length === 0)
    return false
  operation.hunks.push({
    ...(text.startsWith('@@ ') ? { context: text.slice(3) } : {}),
    oldLines: [],
    newLines: [],
    endOfFile: false,
  })
  return true
}

const WHITE_SPACE = /\p{White_Space}/u

/**
 * @param {string} value
 * @param {boolean} leading
 */
function trimWhitespace(value, leading) {
  let start = 0
  let end = value.length
  if (leading)
    while (start < end && WHITE_SPACE.test(value.charAt(start))) start++
  while (end > start && WHITE_SPACE.test(value.charAt(end - 1))) end--
  return value.slice(start, end)
}

/** @param {string} value */
function normalizePunctuation(value) {
  return trimWhitespace(value, true)
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/[\u2018-\u201B]/gu, "'")
    .replace(/[\u201C-\u201F]/gu, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, ' ')
}

const MATCH_PASSES = [
  /** @param {string} value */ value => value,
  /** @param {string} value */ value => trimWhitespace(value, false),
  /** @param {string} value */ value => trimWhitespace(value, true),
  normalizePunctuation,
]

/**
 * @param {string[]} lines
 * @param {string[]} pattern
 * @param {number} start
 * @param {boolean} endOfFile
 * @returns {number | undefined}
 */
function seekSequence(lines, pattern, start, endOfFile) {
  if (pattern.length === 0) return start
  if (pattern.length > lines.length) return undefined
  const last = lines.length - pattern.length
  const first = endOfFile ? last : start
  for (const normalize of MATCH_PASSES) {
    const expected = pattern.map(normalize)
    for (let index = first; index <= last; index++) {
      if (
        expected.every(
          (line, offset) => normalize(lines[index + offset] ?? '') === line,
        )
      )
        return index
    }
  }
  return undefined
}

/**
 * Replay parsed hunks over LF-normalized text following the executor's
 * seek semantics; a failed match returns undefined instead of partial text.
 *
 * @param {string} before
 * @param {PatchHunk[]} hunks
 * @returns {string | undefined}
 */
function applyHunks(before, hunks) {
  const original = before.split('\n')
  if (original.at(-1) === '') original.pop()
  /** @type {{ start: number, oldLength: number, newLines: string[] }[]} */
  const replacements = []
  let lineIndex = 0
  for (const hunk of hunks) {
    if (hunk.context !== undefined) {
      const found = seekSequence(original, [hunk.context], lineIndex, false)
      if (found === undefined) return undefined
      lineIndex = found + 1
    }
    if (hunk.oldLines.length === 0) {
      const start =
        original.at(-1) === '' ? original.length - 1 : original.length
      replacements.push({ start, oldLength: 0, newLines: hunk.newLines })
      continue
    }
    let pattern = hunk.oldLines
    let newLines = hunk.newLines
    let found = seekSequence(original, pattern, lineIndex, hunk.endOfFile)
    if (found === undefined && pattern.at(-1) === '') {
      pattern = pattern.slice(0, -1)
      if (newLines.at(-1) === '') newLines = newLines.slice(0, -1)
      found = seekSequence(original, pattern, lineIndex, hunk.endOfFile)
    }
    if (found === undefined) return undefined
    replacements.push({ start: found, oldLength: pattern.length, newLines })
    lineIndex = found + pattern.length
  }
  replacements.sort((left, right) => left.start - right.start)
  let lines = original
  for (const replacement of replacements.reverse()) {
    lines = [
      ...lines.slice(0, replacement.start),
      ...replacement.newLines,
      ...lines.slice(replacement.start + replacement.oldLength),
    ]
  }
  if (lines.at(-1) !== '') lines.push('')
  return lines.join('\n')
}
