import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import type { SubagentTranscript } from '../core/domain.js'
import type { RunActivityEntry } from '../core/domain.js'
import { buildToolSemantic } from '../activity/tool-semantics.js'

/**
 * Post-hoc reader for DSH child-session durable logs. The `--json` stream only
 * projects the root agent session, but every subagent session persists its own
 * full event log with a `parentSession` header. This module correlates those
 * logs to a Pegas Run through its executorRef and projects them into the same
 * typed transcript shape as `run_activity_entries`.
 *
 * Defensive by contract: unknown formats, torn frames and unreadable files
 * yield fewer entries, never an exception that could fail a Run.
 */

const MAX_SESSIONS = 16
const MAX_ENTRIES_PER_SESSION = 400
const MAX_DETAIL_CHARACTERS = 16_384
const MAX_LABEL_CHARACTERS = 120
const MAX_LOG_BYTES = 64 * 1024 * 1024

export interface DshSubagentReaderOptions {
  /** DSH session persistence root, e.g. `~/.dsh/sessions`. */
  sessionsRoot: string
  /** Restore PRIVACY-001 placeholders before entries leave the worker. */
  restore?: (text: string) => string
}

interface SessionHeader {
  id: string
  cwd?: string
  parentSession?: string
  origin?: string
  delegationDepth?: number
  createdAt?: number
  version?: number
}

interface LogRecord {
  type: string
  seq?: number
  time?: number
  surfaceOp?: string
  data?: Record<string, unknown>
}

/** Filesystem-safe project directory key, mirroring DSH's `projectKey`. */
export function dshProjectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * Read every subagent session whose parent chain roots at `rootSessionId`.
 * Only sessions under the run's workspace directory are considered; nested
 * delegations are included and ordered by creation time.
 */
export function readDshSubagentTranscripts(
  rootSessionId: string,
  workspace: string,
  options: DshSubagentReaderOptions,
): SubagentTranscript[] {
  const projectDirectory = join(options.sessionsRoot, dshProjectKey(workspace))
  const logs = listSessionLogs(projectDirectory)
  const parsed = logs
    .map(path => readSessionLog(path))
    .filter((log): log is ParsedSessionLog => log !== undefined)
  const byParent = new Map<string, ParsedSessionLog[]>()
  for (const log of parsed) {
    const parent = log.header.parentSession
    if (parent === undefined) continue
    const siblings = byParent.get(parent) ?? []
    siblings.push(log)
    byParent.set(parent, siblings)
  }
  const restore = options.restore ?? ((text: string) => text)
  const transcripts: SubagentTranscript[] = []
  const queue = [rootSessionId]
  const visited = new Set<string>()
  while (queue.length > 0 && transcripts.length < MAX_SESSIONS) {
    const parent = queue.shift()
    if (parent === undefined || visited.has(parent)) continue
    visited.add(parent)
    const children = (byParent.get(parent) ?? []).toSorted(
      (left, right) =>
        (left.header.createdAt ?? 0) - (right.header.createdAt ?? 0),
    )
    for (const child of children) {
      if (transcripts.length >= MAX_SESSIONS) break
      transcripts.push(projectTranscript(child, restore))
      queue.push(child.header.id)
    }
  }
  return transcripts
}

interface ParsedSessionLog {
  header: SessionHeader
  records: LogRecord[]
}

/** One durable tool result from the root session log, keyed by call id. */
export interface DshRootToolOutcome {
  callId: string
  status: 'completed' | 'error'
  result?: string
  meta?: unknown
}

/**
 * EXEC-006 P1a: the `--json` stream omits `tool/result.meta`, but the root
 * session persists the full durable log. This reads that log post-hoc and
 * returns faithful results + meta per call id so root activity rows can be
 * upgraded to structured semantics. Defensive: unknown formats, torn frames
 * and unreadable files yield fewer outcomes, never an exception.
 */
export function readDshRootToolOutcomes(
  rootSessionId: string,
  workspace: string,
  options: DshSubagentReaderOptions,
): DshRootToolOutcome[] {
  const projectDirectory = join(options.sessionsRoot, dshProjectKey(workspace))
  const outcomes: DshRootToolOutcome[] = []
  for (const path of listSessionLogs(projectDirectory)) {
    const log = readSessionLog(path)
    if (log?.header.id !== rootSessionId) continue
    const restore = options.restore ?? ((text: string) => text)
    for (const record of log.records) {
      if (record.type !== 'tool/result') continue
      if (record.surfaceOp !== undefined && record.surfaceOp !== 'append') {
        continue
      }
      const data = record.data
      const message = data?.message
      if (!isRecord(message) || typeof message.toolCallId !== 'string') continue
      const result = Array.isArray(message.content)
        ? message.content
            .filter(
              (block): block is { type: string; text: string } =>
                isRecord(block) &&
                block.type === 'text' &&
                typeof block.text === 'string',
            )
            .map(block => block.text)
            .join('')
        : ''
      outcomes.push({
        callId: message.toolCallId,
        status: message.isError === true ? 'error' : 'completed',
        ...(result ? { result: restore(result) } : {}),
        ...(data?.meta !== undefined
          ? { meta: restoreMetaStrings(data.meta, restore) }
          : {}),
      })
    }
    break
  }
  return outcomes
}

function listSessionLogs(projectDirectory: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(projectDirectory)
  } catch {
    return []
  }
  const paths: string[] = []
  for (const entry of entries) {
    const directory = join(projectDirectory, entry)
    for (const filename of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
      const path = join(directory, filename)
      try {
        const stats = statSync(path)
        if (stats.isFile() && stats.size <= MAX_LOG_BYTES) paths.push(path)
      } catch {
        continue
      }
    }
  }
  return paths
}

function readSessionLog(path: string): ParsedSessionLog | undefined {
  let text: string
  try {
    const bytes = readFileSync(path)
    text = path.endsWith('.zstd')
      ? zstdDecompressSync(bytes).toString('utf8')
      : bytes.toString('utf8')
  } catch {
    return undefined
  }
  const records: LogRecord[] = []
  let header: SessionHeader | undefined
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let record: LogRecord
    try {
      const parsed = JSON.parse(line) as unknown
      if (!isRecord(parsed) || typeof parsed.type !== 'string') continue
      record = parsed as unknown as LogRecord
    } catch {
      // A torn final frame can cut the last line; keep everything before it.
      break
    }
    if (record.type === 'session' && header === undefined) {
      const candidate = record as unknown as SessionHeader
      if (typeof candidate.id !== 'string') return undefined
      if (candidate.version !== undefined && candidate.version !== 4) {
        return undefined
      }
      header = candidate
      continue
    }
    records.push(record)
  }
  if (!header) return undefined
  return { header, records }
}

function projectTranscript(
  log: ParsedSessionLog,
  restore: (text: string) => string,
): SubagentTranscript {
  const entries: RunActivityEntry[] = []
  const toolIndexByCallId = new Map<string, number>()
  let seq = 0
  let totalEntries = 0
  let delegationLabel: string | undefined
  let delegationPrompt: string | undefined
  const push = (
    entry: Omit<RunActivityEntry, 'seq' | 'createdAt' | 'updatedAt'>,
    at: number | undefined,
  ) => {
    totalEntries += 1
    if (entries.length >= MAX_ENTRIES_PER_SESSION) return
    seq += 1
    const timestamp = new Date(at ?? log.header.createdAt ?? 0).toISOString()
    entries.push({ ...entry, seq, createdAt: timestamp, updatedAt: timestamp })
  }
  for (const record of log.records) {
    const data = record.data
    if (!data) continue
    if (record.type === 'subagent/descriptor') {
      if (typeof data.label === 'string' && data.label.trim()) {
        delegationLabel = restore(data.label).slice(0, MAX_LABEL_CHARACTERS)
      }
      continue
    }
    if (record.type === 'user/message') {
      if (delegationPrompt === undefined && Array.isArray(data.content)) {
        const text = data.content
          .filter(
            (block): block is { type: string; text: string } =>
              isRecord(block) &&
              block.type === 'text' &&
              typeof block.text === 'string',
          )
          .map(block => block.text)
          .join('')
        if (text.trim()) {
          delegationPrompt = restore(text).slice(0, MAX_DETAIL_CHARACTERS)
        }
      }
      continue
    }
    if (record.type === 'assistant/message') {
      const message = data.message
      if (!isRecord(message) || !Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (!isRecord(block) || typeof block.text !== 'string') continue
        const text = restore(block.text).slice(0, MAX_DETAIL_CHARACTERS)
        if (block.type === 'reasoning') {
          push(
            {
              kind: 'thinking',
              label: summarize(text),
              detail: text,
            },
            record.time,
          )
        } else if (block.type === 'text' && text.trim()) {
          push(
            { kind: 'text', label: summarize(text), detail: text },
            record.time,
          )
        }
      }
      continue
    }
    if (record.type === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : undefined
      const tool =
        typeof data.name === 'string' ? restore(data.name) : '未知工具'
      const input =
        typeof data.arguments === 'string'
          ? restore(data.arguments).slice(0, MAX_DETAIL_CHARACTERS)
          : undefined
      push(
        {
          kind: 'tool_call',
          status: 'started',
          ...(callId ? { callId } : {}),
          tool,
          label: tool,
          ...(input !== undefined ? { detail: input } : {}),
          semantic: buildToolSemantic({
            tool,
            ...(input !== undefined ? { input } : {}),
          }),
        },
        record.time,
      )
      if (callId) toolIndexByCallId.set(callId, entries.length - 1)
      continue
    }
    if (record.type === 'tool/result') {
      if (record.surfaceOp !== undefined && record.surfaceOp !== 'append') {
        continue
      }
      const message = data.message
      if (!isRecord(message) || typeof message.toolCallId !== 'string') continue
      const result = Array.isArray(message.content)
        ? message.content
            .filter(
              (block): block is { type: string; text: string } =>
                isRecord(block) &&
                block.type === 'text' &&
                typeof block.text === 'string',
            )
            .map(block => block.text)
            .join('')
        : ''
      const status = message.isError === true ? 'error' : 'completed'
      const index = toolIndexByCallId.get(message.toolCallId)
      const target = index !== undefined ? entries[index] : undefined
      if (target) {
        target.status = status
        const restoredResult = result ? restore(result) : undefined
        target.detail = [
          target.detail ?? '',
          restoredResult ? `\n[结果]\n${restoredResult}` : '',
        ]
          .join('')
          .slice(0, MAX_DETAIL_CHARACTERS)
        target.semantic = buildToolSemantic(
          {
            tool: target.tool ?? '',
            input: target.detail.split('\n[结果]\n')[0],
          },
          {
            status,
            ...(restoredResult !== undefined ? { result: restoredResult } : {}),
            ...(data.meta !== undefined
              ? { meta: restoreMetaStrings(data.meta, restore) }
              : {}),
          },
        )
        if (record.time !== undefined) {
          target.updatedAt = new Date(record.time).toISOString()
        }
      }
      continue
    }
    if (record.type === 'compaction/end') {
      const failed = data.error !== undefined
      push(
        {
          kind: 'step',
          status: failed ? 'error' : 'completed',
          label: failed ? '上下文压缩失败' : '上下文已压缩',
          meta: {
            kind: 'compaction',
            ...(typeof data.sourceCommandId === 'string'
              ? { note: '手动触发' }
              : { note: '自动触发' }),
          },
        },
        record.time,
      )
      continue
    }
    if (record.type === 'step/end') {
      const step = typeof data.step === 'number' ? data.step : undefined
      push(
        {
          kind: 'step',
          status: 'completed',
          ...(step !== undefined ? { step } : {}),
          label: `第 ${String(step ?? '?')} 步完成`,
        },
        record.time,
      )
    }
  }
  return {
    sessionId: log.header.id,
    parentSessionId: log.header.parentSession ?? '',
    delegationDepth: log.header.delegationDepth ?? 1,
    ...(delegationLabel !== undefined ? { label: delegationLabel } : {}),
    ...(delegationPrompt !== undefined ? { prompt: delegationPrompt } : {}),
    createdAt: new Date(log.header.createdAt ?? 0).toISOString(),
    entries,
    totalEntries,
    truncated: totalEntries > entries.length,
  }
}

function summarize(text: string): string {
  return text.replaceAll(/\s+/g, ' ').slice(0, MAX_LABEL_CHARACTERS)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Restores PRIVACY-001 placeholders inside the opaque result meta before it
 * feeds the semantic projection. Bounded recursion keeps a hostile or torn
 * meta payload from exhausting the worker; unknown shapes pass through.
 */
function restoreMetaStrings(
  value: unknown,
  restore: (text: string) => string,
  depth = 0,
): unknown {
  if (depth > 6) return undefined
  if (typeof value === 'string') return restore(value)
  if (Array.isArray(value)) {
    return value
      .slice(0, 400)
      .map(item => restoreMetaStrings(item, restore, depth + 1))
  }
  if (isRecord(value)) {
    const restored: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      const projected = restoreMetaStrings(item, restore, depth + 1)
      if (projected !== undefined) restored[key] = projected
    }
    return restored
  }
  return value
}
