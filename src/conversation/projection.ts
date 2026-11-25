import type {
  ConversationAnchor,
  ConversationLane,
  ConversationProjection,
  ConversationWeight,
  OutboxMessage,
} from '../core/domain.js'

/**
 * CONV-006: deterministic, read-only conversation projection. The server
 * derives lane/anchor/weight for every fact that reaches the conversation
 * stream; clients render by these attributes instead of inferring shape
 * from payload text. Derivation never writes product state, never changes
 * which events enter the Outbox, and never travels to external channels.
 */

interface ConversationTaskFacts {
  id: string
  kind?: 'work' | 'conversation'
  originEventId?: string
}

export interface ConversationProjectionContext {
  task?: ConversationTaskFacts
  /** Origin event of the Run that produced this fact, when known. */
  runOriginEventId?: string
  /** Source of the Run's origin event (for example `automation`). */
  runOriginSource?: string
}

const DECIDE_TYPES = new Set([
  'approval.required',
  'approval.requested',
  'approval.pending',
  'input.required',
  'input.requested',
  'goal.clarification_required',
  'goal.clarification_wait',
  'goal.evidence_required',
  'goal.report_required',
  'run.blocked',
  'run.waiting',
  'action.outcome_unknown',
  'action.outcome_pending',
  'action.reconciliation_required',
])

const WORK_TYPES = new Set([
  'run.completed',
  'run.failed',
  'action.failed',
  'review.ready',
  'approval.resolved',
  'action.reconciled',
  'routing.clarification_expired',
  'collaboration.returned',
  'collaboration.completed',
  'collaboration.failed',
  'collaboration.delivery_failed',
])

const SILENT_TYPES = new Set(['run.progress', 'run.acknowledged'])

const SAY_TYPES = new Set(['agent.message'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function payloadType(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  return typeof payload.type === 'string' ? payload.type : undefined
}

/** The same eligibility and excerpt source are used by the composer and server. */
export function quotableAgentReply(
  message: Pick<OutboxMessage, 'taskId' | 'payload' | 'status' | 'projection'> &
    Partial<Pick<OutboxMessage, 'channel'>>,
): { taskId: string; text: string; runId?: string } | undefined {
  const { taskId, payload } = message
  if (
    !taskId ||
    (message.channel !== undefined && message.channel !== 'conversation') ||
    message.status === 'merged' ||
    message.projection?.weight === 'silent' ||
    !isRecord(payload) ||
    payload.streaming === true ||
    !['agent.message', 'run.completed', 'review.ready'].includes(
      payloadType(payload) ?? '',
    ) ||
    typeof payload.text !== 'string' ||
    !payload.text.trim()
  )
    return undefined
  return {
    taskId,
    text: payload.text.trim(),
    ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
  }
}

export function replyReference(
  payload: unknown,
): { id: string; mode: 'continue' | 'explain' } | undefined {
  if (!isRecord(payload)) return undefined
  if (!('replyToMessageId' in payload)) {
    if (payload.intent === 'explain')
      throw new Error('An explanation requires a reply reference')
    return undefined
  }
  if (
    typeof payload.replyToMessageId !== 'string' ||
    !payload.replyToMessageId.trim()
  )
    throw new Error('replyToMessageId must be a non-empty string')
  if (
    payload.taskId !== undefined ||
    payload.sourceTaskId !== undefined ||
    (payload.intent !== undefined && payload.intent !== 'explain')
  )
    throw new Error(
      'A reply reference cannot be combined with another message target or intent',
    )
  return {
    id: payload.replyToMessageId,
    mode: payload.intent === 'explain' ? 'explain' : 'continue',
  }
}

function payloadTaskId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  return typeof payload.taskId === 'string' && payload.taskId.trim()
    ? payload.taskId
    : undefined
}

function anchorFor(
  message: Pick<OutboxMessage, 'taskId' | 'payload'>,
  context: ConversationProjectionContext,
): ConversationAnchor | undefined {
  const taskId = message.taskId ?? payloadTaskId(message.payload)
  if (!taskId) return undefined
  const eventId =
    context.runOriginEventId ??
    (context.task?.id === taskId ? context.task.originEventId : undefined)
  return { taskId, ...(eventId ? { eventId } : {}) }
}

/**
 * Pure derivation: same message plus same authoritative facts always yield
 * the same projection. Unknown payload types fall back to the compatible
 * default (inline say for conversation Tasks, card work otherwise) so an
 * unrecognised fact never blocks delivery and never floods the stream.
 */
export function deriveConversationProjection(
  message: Pick<OutboxMessage, 'taskId' | 'payload'>,
  context: ConversationProjectionContext = {},
): ConversationProjection {
  const type = payloadType(message.payload)
  const anchor = anchorFor(message, context)
  let lane: ConversationLane
  let weight: ConversationWeight
  if (type && SILENT_TYPES.has(type)) {
    lane = 'work'
    weight = 'silent'
  } else if (
    (type === 'review.ready' &&
      isRecord(message.payload) &&
      message.payload.requiresAcceptance === true) ||
    (type && DECIDE_TYPES.has(type))
  ) {
    lane = 'decide'
    weight = 'card'
  } else if (type && WORK_TYPES.has(type)) {
    lane = 'work'
    weight =
      type === 'run.completed' &&
      (context.runOriginSource === 'automation' ||
        context.task?.kind === 'conversation')
        ? 'silent'
        : 'card'
  } else if (type && SAY_TYPES.has(type)) {
    lane = 'say'
    weight = 'inline'
  } else if (context.task?.kind === 'conversation') {
    lane = 'say'
    weight = 'inline'
  } else if (type === undefined && typeof message.payload === 'string') {
    lane = 'say'
    weight = 'inline'
  } else {
    lane = 'work'
    weight = 'card'
  }
  return { lane, weight, ...(anchor ? { anchor } : {}) }
}

export function withConversationProjection(
  message: OutboxMessage,
  context: ConversationProjectionContext = {},
): OutboxMessage {
  return {
    ...message,
    projection: deriveConversationProjection(message, context),
  }
}
