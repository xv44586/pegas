import type {
  InboxEvent,
  RoutingCandidate,
  RoutingDecision,
  Task,
} from '../core/domain.js'

/**
 * PLAN-001 decision 4: deterministic pre-routing by risk class. Control
 * commands bypass the model only on a unique exact title match and still go
 * through the same authenticated control-intent transaction. Greetings and
 * thanks use a conservative whole-message whitelist. Anything uncertain
 * returns undefined and reaches the model router unchanged.
 */
export function prefilterDecision(
  event: InboxEvent,
  candidates: RoutingCandidate[] | Task[],
  options: { chatLaneEnabled: boolean },
): RoutingDecision | undefined {
  if (event.type !== 'user.message') return undefined
  if (event.authenticatedActor !== 'human') return undefined
  if (event.source === 'collaboration' || event.source === 'automation')
    return undefined
  if (!isRecord(event.payload)) return undefined
  const rawText = event.payload.text
  if (typeof rawText !== 'string' || !rawText.trim()) return undefined
  if (event.payload.taskId !== undefined) return undefined
  if (event.payload.sourceTaskId !== undefined) return undefined
  const text = rawText.trim()

  const stopTarget = stopCommandTarget(text)
  if (stopTarget !== undefined) {
    const matches = candidates
      .map(candidate => ('task' in candidate ? candidate.task : candidate))
      .filter(
        task =>
          task.status === 'started' &&
          task.kind !== 'conversation' &&
          normalizeTitle(task.title) === normalizeTitle(stopTarget),
      )
    if (matches.length === 1 && matches[0]) {
      return {
        kind: 'cancel_task',
        taskId: matches[0].id,
        reason: 'Deterministic stop command matched exactly one started task.',
      }
    }
    return undefined
  }

  if (
    options.chatLaneEnabled &&
    greetingWhitelist.has(normalizeGreeting(text))
  ) {
    return {
      kind: 'reply',
      input: text,
      reason: 'Deterministic greeting/thanks whitelist match.',
    }
  }
  return undefined
}

function stopCommandTarget(text: string): string | undefined {
  const match = /^(?:停掉|停止|取消)\s*(.+)$/.exec(text)
  if (!match?.[1]) return undefined
  const target = match[1]
    .trim()
    .replace(/[。.!！?？]+$/, '')
    .trim()
  return target ? target : undefined
}

function normalizeTitle(value: string): string {
  return value.trim().replaceAll(/\s+/g, ' ').toLowerCase()
}

function normalizeGreeting(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[。.!！~～?？\s]+$/g, '')
}

const greetingWhitelist = new Set([
  '你好',
  '您好',
  '嗨',
  '哈喽',
  '哈啰',
  '早上好',
  '早安',
  '中午好',
  '下午好',
  '晚上好',
  '晚安',
  'hi',
  'hello',
  'hey',
  'morning',
  'good morning',
  'good afternoon',
  'good evening',
  'good night',
  '谢谢',
  '谢谢你',
  '谢谢啦',
  '多谢',
  '多谢了',
  '感谢',
  '辛苦了',
  '辛苦啦',
  'thanks',
  'thank you',
  'thx',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
