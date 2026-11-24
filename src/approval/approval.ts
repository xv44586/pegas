export type ActionRisk = 'low' | 'medium' | 'high' | 'critical'
type ActionStatus =
  | 'awaiting_approval'
  | 'authorized'
  | 'rejected'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'reconciled'

export const approvalStatuses = [
  'pending',
  'decision_recorded',
  'approved',
  'rejected',
  'revision_requested',
  'cancelled',
] as const
export type ApprovalStatus = (typeof approvalStatuses)[number]

const approvalDecisionKinds = [
  'approve',
  'approve_rule',
  'reject',
  'revise',
] as const
type ApprovalDecisionKind = (typeof approvalDecisionKinds)[number]

interface ApprovalOption {
  id: string
  label: string
  kind: ApprovalDecisionKind
  description?: string
}

export interface ApprovalPrompt {
  summary: string
  impact: string
  options: ApprovalOption[]
  recommendedOptionId: string
}

export interface ActionRequestDraft {
  kind: string
  risk: ActionRisk
  idempotencyKey: string
  request: Record<string, unknown>
  recoveryPoint: Record<string, unknown>
  approval: ApprovalPrompt
}

export interface ActionReconciliationDraft {
  commandId: string
  resolution: 'succeeded' | 'failed'
  note: string
}

export interface ActionReconciliation {
  id: string
  actionId: string
  commandId: string
  resolution: 'succeeded' | 'failed'
  note: string
  previousStatus: 'failed' | 'unknown'
  previousResult?: Record<string, unknown>
  reconciledBy: string
  automatic?: boolean
  createdAt: string
}

export interface DurableAction {
  id: string
  taskId: string
  requestRunId: string
  resumeRunId?: string
  kind: string
  risk: ActionRisk
  idempotencyKey: string
  status: ActionStatus
  request: Record<string, unknown>
  recoveryPoint: Record<string, unknown>
  result?: Record<string, unknown>
  reconciliation?: ActionReconciliation
  review?: import('./approval-review.js').ApprovalReview
  createdAt: string
  updatedAt: string
}

export interface ApprovalDecision {
  id: string
  approvalId: string
  eventId: string
  commandId: string
  userId: string
  optionId: string
  kind: ApprovalDecisionKind
  rationale?: string
  decidedAt: string
  appliedAt?: string
}

export interface Approval {
  id: string
  taskId: string
  actionId: string
  requestRunId: string
  status: ApprovalStatus
  prompt: ApprovalPrompt
  decision?: ApprovalDecision
  createdAt: string
  resolvedAt?: string
}

export interface ApprovalDecisionDraft {
  commandId: string
  optionId: string
  rationale?: string
}

export interface ActionOutcomeDraft {
  commandId: string
  status: 'succeeded' | 'failed' | 'unknown'
  result: Record<string, unknown>
}

const ruleEligibleCategories = [
  'out-of-workspace-write',
  'network-egress',
] as const

export function approvalRuleTargets(input: {
  tool: string
  category: string
  targets: readonly string[]
}): { tool: string; category: string; targets: string[] } {
  if (typeof input.tool !== 'string' || input.tool.trim() === '') {
    throw new Error('rule.tool is required')
  }
  if (
    !ruleEligibleCategories.includes(
      input.category as (typeof ruleEligibleCategories)[number],
    )
  ) {
    throw new Error('Action category does not accept persistent rules')
  }
  const targets = [...new Set(input.targets)]
    .filter(target => typeof target === 'string' && target.trim() !== '')
    .sort()
  if (targets.length === 0) {
    throw new Error('Persistent rules require at least one canonical target')
  }
  return { tool: input.tool, category: input.category, targets }
}

export function approvalRequired(risk: ActionRisk): boolean {
  return risk === 'high' || risk === 'critical'
}

export function parseActionRequestDraft(value: unknown): ActionRequestDraft {
  const input = record(value, 'action')
  const risk = requiredString(input.risk, 'action.risk')
  if (!isActionRisk(risk)) throw new Error('action.risk is invalid')
  if (!approvalRequired(risk)) {
    throw new Error(
      'Approval is only required for high or critical risk actions',
    )
  }
  return {
    kind: requiredString(input.kind, 'action.kind'),
    risk,
    idempotencyKey: requiredString(
      input.idempotencyKey,
      'action.idempotencyKey',
    ),
    request: record(input.request, 'action.request'),
    recoveryPoint: record(input.recoveryPoint, 'action.recoveryPoint'),
    approval: parseApprovalPrompt(input.approval),
  }
}

export function parseApprovalDecisionDraft(
  value: unknown,
): ApprovalDecisionDraft {
  const input = record(value, 'decision')
  return {
    commandId: requiredString(input.commandId, 'commandId'),
    optionId: requiredString(input.optionId, 'optionId'),
    ...(input.rationale === undefined
      ? {}
      : { rationale: requiredString(input.rationale, 'rationale') }),
  }
}

export function parseActionOutcomeDraft(value: unknown): ActionOutcomeDraft {
  const input = record(value, 'outcome')
  const status = requiredString(input.status, 'status')
  if (status !== 'succeeded' && status !== 'failed' && status !== 'unknown') {
    throw new Error('status must be succeeded, failed, or unknown')
  }
  return {
    commandId: requiredString(input.commandId, 'commandId'),
    status,
    result: record(input.result, 'result'),
  }
}

export function parseActionReconciliationDraft(
  value: unknown,
): ActionReconciliationDraft {
  const input = record(value, 'reconciliation')
  const resolution = requiredString(input.resolution, 'resolution')
  if (resolution !== 'succeeded' && resolution !== 'failed') {
    throw new Error('resolution must be succeeded or failed')
  }
  const note = requiredString(input.note, 'note').trim()
  if (note.length > 2000) {
    throw new Error('note must be at most 2000 characters')
  }
  return {
    commandId: requiredString(input.commandId, 'commandId'),
    resolution,
    note,
  }
}

function parseApprovalPrompt(value: unknown): ApprovalPrompt {
  const input = record(value, 'action.approval')
  if (!Array.isArray(input.options) || input.options.length < 2) {
    throw new Error('action.approval.options must contain at least two options')
  }
  const options = input.options.map((value, index) => {
    const option = record(value, `action.approval.options[${String(index)}]`)
    const kind = requiredString(
      option.kind,
      `action.approval.options[${String(index)}].kind`,
    )
    const decisionKind = approvalDecisionKinds.find(value => value === kind)
    if (!decisionKind) {
      throw new Error('Approval option kind is invalid')
    }
    return {
      id: requiredString(
        option.id,
        `action.approval.options[${String(index)}].id`,
      ),
      label: requiredString(
        option.label,
        `action.approval.options[${String(index)}].label`,
      ),
      kind: decisionKind,
      ...(option.description === undefined
        ? {}
        : {
            description: requiredString(
              option.description,
              `action.approval.options[${String(index)}].description`,
            ),
          }),
    }
  })
  if (new Set(options.map(option => option.id)).size !== options.length) {
    throw new Error('Approval option IDs must be unique')
  }
  const recommendedOptionId = requiredString(
    input.recommendedOptionId,
    'action.approval.recommendedOptionId',
  )
  if (!options.some(option => option.id === recommendedOptionId)) {
    throw new Error('Recommended option must reference an approval option')
  }
  if (!options.some(option => option.kind === 'approve')) {
    throw new Error('Approval options must include an approve option')
  }
  if (!options.some(option => option.kind === 'reject')) {
    throw new Error('Approval options must include a reject option')
  }
  return {
    summary: requiredString(input.summary, 'action.approval.summary'),
    impact: requiredString(input.impact, 'action.approval.impact'),
    options,
    recommendedOptionId,
  }
}

function isActionRisk(value: string): value is ActionRisk {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'critical'
  )
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`)
  }
  return value
}
