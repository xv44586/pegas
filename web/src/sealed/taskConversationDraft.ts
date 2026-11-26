import type { ComposerTarget } from './types'

type Reply = Extract<ComposerTarget, { kind: 'reply' }>
export interface TaskDraft {
  text: string
  quote?: Reply
}
export interface SendAttempt {
  text: string
  targetKey: string
  dedupeKey: string
}

function read(key: string): unknown {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') as unknown
  } catch {
    return undefined
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === undefined) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* Private browsing and storage quotas must not block conversation. */
  }
}
export function readTaskDraft(taskId: string): TaskDraft {
  const value = read(`pegas-task-draft:${taskId}`) as Partial<TaskDraft> | null
  if (!value || typeof value.text !== 'string') return { text: '' }
  const quote = value.quote
  return {
    text: value.text,
    ...(quote?.kind === 'reply' &&
    typeof quote.id === 'string' &&
    typeof quote.text === 'string'
      ? { quote }
      : {}),
  }
}
export function writeTaskDraft(taskId: string, draft: TaskDraft) {
  write(`pegas-task-draft:${taskId}`, draft)
}
export function readSendAttempt(taskId?: string): SendAttempt | undefined {
  if (!taskId) return undefined
  const value = read(`pegas-task-send:${taskId}`) as Partial<SendAttempt> | null
  return value &&
    typeof value.text === 'string' &&
    typeof value.targetKey === 'string' &&
    typeof value.dedupeKey === 'string'
    ? (value as SendAttempt)
    : undefined
}
export function writeSendAttempt(
  taskId: string | undefined,
  attempt?: SendAttempt,
) {
  if (taskId) write(`pegas-task-send:${taskId}`, attempt)
}

// File bytes stay in this tab's memory; session storage stores only text and targets.
interface AttachmentDraft {
  file: File
  eventId?: string
}
const attachments = new Map<string, AttachmentDraft>()
export function taskAttachment(taskId?: string) {
  return taskId ? attachments.get(taskId) : undefined
}
export function saveTaskAttachment(
  taskId: string | undefined,
  value?: AttachmentDraft,
) {
  if (!taskId) return
  if (value) attachments.set(taskId, value)
  else attachments.delete(taskId)
}
