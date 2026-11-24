type ApprovalReviewDecision = 'allow' | 'deny' | 'failed'
type ApprovalReviewRisk = 'low' | 'medium' | 'high'

export interface ApprovalReview {
  id: string
  actionId: string
  taskId: string
  runId: string
  decision: ApprovalReviewDecision
  risk?: ApprovalReviewRisk
  reason?: string
  mandateChars?: number
  generation?: string
  createdAt: string
}

export interface ApprovalReviewDraft {
  decision: ApprovalReviewDecision
  risk?: ApprovalReviewRisk
  reason?: string
  mandateChars?: number
  generation?: string
}

interface ApprovalMandateInstruction {
  eventId: string
  text: string
  createdAt: string
}

export interface ApprovalMandateProjection {
  instructions: ApprovalMandateInstruction[]
  omitted: boolean
}

export function parseApprovalReviewDraft(value: unknown): ApprovalReviewDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('review must be an object')
  }
  const input = value as Record<string, unknown>
  const decision = input.decision
  if (decision !== 'allow' && decision !== 'deny' && decision !== 'failed') {
    throw new Error('review decision must be allow, deny or failed')
  }
  const risk = input.risk
  if (
    risk !== undefined &&
    risk !== 'low' &&
    risk !== 'medium' &&
    risk !== 'high'
  ) {
    throw new Error('review risk must be low, medium or high')
  }
  if (decision === 'allow' && risk !== 'low' && risk !== 'medium') {
    throw new Error('an allow review requires low or medium risk')
  }
  if (decision === 'deny' && risk !== 'medium' && risk !== 'high') {
    throw new Error('a deny review requires medium or high risk')
  }
  const reason = input.reason
  if (reason !== undefined) {
    if (typeof reason !== 'string' || reason.length > 2_000) {
      throw new Error('review reason must be a string of at most 2000 chars')
    }
    if (decision === 'allow') {
      throw new Error('an allow review carries no reason')
    }
  }
  const mandateChars = input.mandateChars
  if (
    mandateChars !== undefined &&
    (typeof mandateChars !== 'number' ||
      !Number.isSafeInteger(mandateChars) ||
      mandateChars < 0)
  ) {
    throw new Error('review mandateChars must be a non-negative integer')
  }
  const generation = input.generation
  if (
    generation !== undefined &&
    (typeof generation !== 'string' || generation.length > 64)
  ) {
    throw new Error('review generation must be a string of at most 64 chars')
  }
  return {
    decision,
    ...(risk === undefined ? {} : { risk }),
    ...(reason === undefined ? {} : { reason }),
    ...(mandateChars === undefined ? {} : { mandateChars }),
    ...(generation === undefined ? {} : { generation }),
  }
}
