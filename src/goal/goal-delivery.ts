type CriterionCompletionStatus =
  'satisfied' | 'partial' | 'unverified' | 'failed'

type EvidenceVerificationResult = 'passed' | 'pending' | 'failed'

const MAX_GOAL_SOURCE_EVENTS = 200
const MAX_SUCCESS_CRITERIA = 100
const MAX_REPORT_EVIDENCE_REFS = 200

interface GoalSuccessCriterion {
  criterionId: string
  observableStatement: string
  required: boolean
  evidencePlanRef: string
}

interface GoalEvidencePlan {
  id: string
  criterionId: string
  acceptedKinds: string[]
  acceptedTrustClasses: string[]
  minimumCount: number
  presentation: string
}

interface GoalContextSource {
  sourceRef: string
  freshness: string
  authority: string
  conflictPriority: number
}

interface GoalAssumption {
  statement: string
  status: 'user_fact' | 'executor_inference' | 'unverified'
  sourceEventId?: string
}

interface GoalUnknown {
  question: string
  blocking: boolean
}

export interface GoalContractDraft {
  basedOnEventIds: string[]
  desiredOutcome: string
  beneficiaries: string[]
  successCriteria: GoalSuccessCriterion[]
  nonGoals: string[]
  constraints: string[]
  contextSources: GoalContextSource[]
  assumptions: GoalAssumption[]
  unknowns: GoalUnknown[]
  prerequisites: string[]
  permissionBoundary: Record<string, unknown>
  reviewCheckpoints: string[]
  requireAcceptance?: boolean
  evidencePlan: GoalEvidencePlan[]
  failureAndRecovery: string
  feedbackSignals: string[]
  triggerPolicy?: Record<string, unknown>
}

export interface GoalContract extends GoalContractDraft {
  id: string
  taskId: string
  revision: number
  commandId: string
  createdAt: string
}

type ArtifactKind =
  'file' | 'image' | 'video' | 'webpage' | 'document' | 'dataset' | 'other'

export interface ArtifactDraft {
  runId?: string
  name: string
  kind: ArtifactKind
  mimeType?: string
  uri?: string
  revision: string
  contentHash: string
  sizeBytes?: number
  metadata: Record<string, unknown>
  sensitivity: string
}

export interface TaskArtifact extends ArtifactDraft {
  id: string
  taskId: string
  commandId: string
  createdAt: string
}

export interface EvidenceVerification {
  method: string
  verifierIdentity: string
  verifierVersion: string
  result: EvidenceVerificationResult
  verifiedAt?: string
}

/**
 * Identity of an in-process trusted verifier. Only the Control Plane can
 * construct attestations under these identities; HTTP clients never supply
 * the verification object for a passed result.
 */
export const trustedVerifierIdentity = 'pegas-control-plane-verifier'
export const trustedVerifierVersion = 'v1'

export function isTrustedVerifier(identity: string): boolean {
  return identity === trustedVerifierIdentity
}

interface ObservationSnapshot {
  observedValue: unknown
  sourceObjectId: string
  sourceVersion?: string
  issuerIdentity: string
  observedAt: string
  snapshotHash: string
}

export interface EvidenceRefDraft {
  goalRevision: number
  criterionId: string
  kind: string
  artifactId?: string
  externalRef?: string
  producerIdentity: string
  captureMechanism: string
  trustClass: string
  observationSnapshot?: ObservationSnapshot
  verification: EvidenceVerification
  environment: Record<string, unknown>
  presentation: Record<string, unknown>
  sensitivity: string
  limitations: string[]
}

export type EvidenceClaimDraft = Omit<
  EvidenceRefDraft,
  'trustClass' | 'verification'
>

export interface EvidenceRef extends EvidenceRefDraft {
  id: string
  taskId: string
  runId: string
  commandId: string
  contentHash: string
  artifactRevision?: string
  capturedAt: string
}

type WorkerReportStatus =
  'started' | 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed'

export interface WorkerReportDraft {
  goalRevision: number
  reportSequence: number
  status: WorkerReportStatus
  evidenceRefIds: string[]
  summary: string
  limitations: string[]
  remainingRisks: string[]
  rollback?: Record<string, unknown>
}

export interface WorkerReport extends WorkerReportDraft {
  id: string
  taskId: string
  runId: string
  reporterIdentity: string
  reviewPackId?: string
  createdAt: string
}

export interface ReviewCriterion {
  criterionId: string
  completionStatus: CriterionCompletionStatus
  currentValidity: 'valid' | 'warning' | 'invalid' | 'unknown'
  evidenceRefs: string[]
  explanation: string
  limitations: string[]
}

export interface ReviewPack {
  id: string
  revision: number
  taskId: string
  runId: string
  goalRevision: number
  basisEventIds: string[]
  projectionAsOf: string
  finalOutcome: 'completed' | 'partial' | 'failed'
  criteria: ReviewCriterion[]
  sideEffects: Record<string, unknown>[]
  remainingRisks: string[]
  rollback?: Record<string, unknown>
  auditLink: string
  createdAt: string
}

export interface ReviewDecisionDraft {
  commandId: string
  decision: 'accept' | 'request_changes'
  note?: string
}

export interface ReviewDecision extends ReviewDecisionDraft {
  id: string
  reviewPackId: string
  taskId: string
  decidedAt: string
  nextEventId?: string
}

export class ReviewDecisionConflictError extends Error {}

export function parseReviewDecision(value: unknown): ReviewDecisionDraft {
  const input = record(value, 'Review decision')
  const commandId = nonempty(input.commandId, 'commandId')
  if (commandId.length > 240) throw new Error('commandId is too long')
  const decision = input.decision
  if (decision !== 'accept' && decision !== 'request_changes')
    throw new Error('A review decision must accept or request changes')
  const note =
    input.note === undefined ? undefined : nonempty(input.note, 'note')
  if (note && note.length > 4000) throw new Error('Review note is too long')
  if (decision === 'request_changes' && !note)
    throw new Error('Explain what needs to change')
  return { commandId, decision, ...(note ? { note } : {}) }
}

export function parseGoalContractDraft(value: unknown): GoalContractDraft {
  const input = record(value, 'Goal Contract')
  const successCriteria = array(input.successCriteria, 'successCriteria').map(
    (criterion, index) => {
      const item = record(criterion, `successCriteria[${String(index)}]`)
      return {
        criterionId: nonempty(item.criterionId, 'criterionId'),
        observableStatement: nonempty(
          item.observableStatement,
          'observableStatement',
        ),
        required: booleanValue(item.required, 'required'),
        evidencePlanRef: nonempty(item.evidencePlanRef, 'evidencePlanRef'),
      }
    },
  )
  if (successCriteria.length === 0)
    throw new Error('successCriteria must not be empty')
  if (successCriteria.length > MAX_SUCCESS_CRITERIA)
    throw new Error(
      `successCriteria must contain at most ${String(MAX_SUCCESS_CRITERIA)} items`,
    )
  unique(
    successCriteria.map(item => item.criterionId),
    'criterionId',
  )

  const evidencePlan = array(input.evidencePlan, 'evidencePlan').map(
    (plan, index) => {
      const item = record(plan, `evidencePlan[${String(index)}]`)
      const acceptedKinds = stringArray(item.acceptedKinds, 'acceptedKinds')
      const acceptedTrustClasses = stringArray(
        item.acceptedTrustClasses,
        'acceptedTrustClasses',
      )
      if (acceptedKinds.length === 0)
        throw new Error('acceptedKinds must not be empty')
      if (acceptedTrustClasses.length === 0)
        throw new Error('acceptedTrustClasses must not be empty')
      return {
        id: nonempty(item.id, 'evidencePlan.id'),
        criterionId: nonempty(item.criterionId, 'evidencePlan.criterionId'),
        acceptedKinds,
        acceptedTrustClasses,
        minimumCount: positiveInteger(item.minimumCount, 'minimumCount'),
        presentation: nonempty(item.presentation, 'presentation'),
      }
    },
  )
  unique(
    evidencePlan.map(item => item.id),
    'evidencePlan.id',
  )
  const planIds = new Set(evidencePlan.map(item => item.id))
  const criterionIds = new Set(successCriteria.map(item => item.criterionId))
  for (const criterion of successCriteria) {
    if (!planIds.has(criterion.evidencePlanRef))
      throw new Error(
        `Unknown evidence plan ${criterion.evidencePlanRef} for ${criterion.criterionId}`,
      )
    const referencedPlan = evidencePlan.find(
      plan => plan.id === criterion.evidencePlanRef,
    )
    if (referencedPlan?.criterionId !== criterion.criterionId)
      throw new Error(
        `Evidence plan ${criterion.evidencePlanRef} belongs to ${referencedPlan?.criterionId ?? 'another criterion'}, not ${criterion.criterionId}`,
      )
  }
  for (const plan of evidencePlan) {
    if (!criterionIds.has(plan.criterionId))
      throw new Error(`Unknown criterion ${plan.criterionId} in evidence plan`)
  }

  const basedOnEventIds = stringArray(input.basedOnEventIds, 'basedOnEventIds')
  if (basedOnEventIds.length === 0)
    throw new Error('basedOnEventIds must not be empty')
  if (basedOnEventIds.length > MAX_GOAL_SOURCE_EVENTS)
    throw new Error(
      `basedOnEventIds must contain at most ${String(MAX_GOAL_SOURCE_EVENTS)} items`,
    )
  unique(basedOnEventIds, 'basedOnEventIds')

  return {
    basedOnEventIds,
    desiredOutcome: nonempty(input.desiredOutcome, 'desiredOutcome'),
    beneficiaries: stringArray(input.beneficiaries, 'beneficiaries'),
    successCriteria,
    nonGoals: stringArray(input.nonGoals, 'nonGoals'),
    constraints: stringArray(input.constraints, 'constraints'),
    contextSources: array(input.contextSources, 'contextSources').map(
      (source, index) => {
        const item = record(source, `contextSources[${String(index)}]`)
        return {
          sourceRef: nonempty(item.sourceRef, 'sourceRef'),
          freshness: nonempty(item.freshness, 'freshness'),
          authority: nonempty(item.authority, 'authority'),
          conflictPriority: nonnegativeInteger(
            item.conflictPriority,
            'conflictPriority',
          ),
        }
      },
    ),
    assumptions: array(input.assumptions, 'assumptions').map(
      (assumption, index) => {
        const item = record(assumption, `assumptions[${String(index)}]`)
        const status = item.status
        if (
          status !== 'user_fact' &&
          status !== 'executor_inference' &&
          status !== 'unverified'
        )
          throw new Error('Invalid assumption status')
        return {
          statement: nonempty(item.statement, 'assumption.statement'),
          status,
          ...optionalString(item, 'sourceEventId'),
        }
      },
    ),
    unknowns: array(input.unknowns, 'unknowns').map((unknown, index) => {
      const item = record(unknown, `unknowns[${String(index)}]`)
      return {
        question: nonempty(item.question, 'unknown.question'),
        blocking: booleanValue(item.blocking, 'unknown.blocking'),
      }
    }),
    prerequisites: stringArray(input.prerequisites, 'prerequisites'),
    permissionBoundary: record(input.permissionBoundary, 'permissionBoundary'),
    ...(input.requireAcceptance === undefined
      ? {}
      : {
          requireAcceptance: booleanValue(
            input.requireAcceptance,
            'requireAcceptance',
          ),
        }),
    reviewCheckpoints: stringArray(
      input.reviewCheckpoints,
      'reviewCheckpoints',
    ),
    evidencePlan,
    failureAndRecovery: nonempty(
      input.failureAndRecovery,
      'failureAndRecovery',
    ),
    feedbackSignals: stringArray(input.feedbackSignals, 'feedbackSignals'),
    ...(input.triggerPolicy === undefined
      ? {}
      : { triggerPolicy: record(input.triggerPolicy, 'triggerPolicy') }),
  }
}

export function parseArtifactDraft(value: unknown): ArtifactDraft {
  const input = record(value, 'Artifact')
  const kind = input.kind
  if (
    kind !== 'file' &&
    kind !== 'image' &&
    kind !== 'video' &&
    kind !== 'webpage' &&
    kind !== 'document' &&
    kind !== 'dataset' &&
    kind !== 'other'
  )
    throw new Error('Invalid artifact kind')
  return {
    ...optionalString(input, 'runId'),
    name: nonempty(input.name, 'artifact.name'),
    kind,
    ...optionalString(input, 'mimeType'),
    ...optionalString(input, 'uri'),
    revision: nonempty(input.revision, 'artifact.revision'),
    contentHash: sha256(input.contentHash, 'artifact.contentHash'),
    ...(input.sizeBytes === undefined
      ? {}
      : { sizeBytes: nonnegativeInteger(input.sizeBytes, 'sizeBytes') }),
    metadata: record(input.metadata, 'artifact.metadata'),
    sensitivity: nonempty(input.sensitivity, 'artifact.sensitivity'),
  }
}

export function parseEvidenceRefDraft(value: unknown): EvidenceRefDraft {
  const input = record(value, 'EvidenceRef')
  const claim = parseEvidenceClaimInput(input)
  const verificationInput = record(input.verification, 'verification')
  const result = verificationInput.result
  if (result !== 'passed' && result !== 'pending' && result !== 'failed')
    throw new Error('Invalid verification result')
  const verifiedAt = optionalNonemptyString(verificationInput.verifiedAt)
  if (result !== 'pending' && !verifiedAt)
    throw new Error('verification.verifiedAt is required for a final result')
  return {
    ...claim,
    trustClass: nonempty(input.trustClass, 'trustClass'),
    verification: {
      method: nonempty(verificationInput.method, 'verification.method'),
      verifierIdentity: nonempty(
        verificationInput.verifierIdentity,
        'verification.verifierIdentity',
      ),
      verifierVersion: nonempty(
        verificationInput.verifierVersion,
        'verification.verifierVersion',
      ),
      result,
      ...(verifiedAt
        ? { verifiedAt: isoDate(verifiedAt, 'verification.verifiedAt') }
        : {}),
    },
  }
}

export function parseEvidenceClaimDraft(value: unknown): EvidenceClaimDraft {
  const input = record(value, 'Evidence claim')
  if ('trustClass' in input || 'verification' in input)
    throw new Error('Evidence verification is issued by the server')
  return parseEvidenceClaimInput(input)
}

export function parseWorkerReportDraft(value: unknown): WorkerReportDraft {
  const input = record(value, 'Worker Report')
  const status = input.status
  if (
    status !== 'started' &&
    status !== 'progress' &&
    status !== 'waiting' &&
    status !== 'ready' &&
    status !== 'blocked' &&
    status !== 'failed'
  )
    throw new Error('Invalid Worker Report status')
  const evidenceRefIds = stringArray(input.evidenceRefIds, 'evidenceRefIds')
  if (evidenceRefIds.length > MAX_REPORT_EVIDENCE_REFS)
    throw new Error(
      `evidenceRefIds must contain at most ${String(MAX_REPORT_EVIDENCE_REFS)} items`,
    )
  unique(evidenceRefIds, 'evidenceRefIds')
  return {
    goalRevision: positiveInteger(input.goalRevision, 'goalRevision'),
    reportSequence: nonnegativeInteger(input.reportSequence, 'reportSequence'),
    status,
    evidenceRefIds,
    summary: nonempty(input.summary, 'summary'),
    limitations: stringArray(input.limitations, 'limitations'),
    remainingRisks: stringArray(input.remainingRisks, 'remainingRisks'),
    ...(input.rollback === undefined
      ? {}
      : { rollback: record(input.rollback, 'rollback') }),
  }
}

function parseEvidenceClaimInput(
  input: Record<string, unknown>,
): EvidenceClaimDraft {
  const observationSnapshot =
    input.observationSnapshot === undefined
      ? undefined
      : parseObservationSnapshot(input.observationSnapshot)
  const artifactId = optionalNonemptyString(input.artifactId)
  if (!artifactId && !observationSnapshot)
    throw new Error(
      'Evidence requires an artifactId or immutable observationSnapshot',
    )
  return {
    goalRevision: positiveInteger(input.goalRevision, 'goalRevision'),
    criterionId: nonempty(input.criterionId, 'criterionId'),
    kind: nonempty(input.kind, 'kind'),
    ...(artifactId ? { artifactId } : {}),
    ...optionalString(input, 'externalRef'),
    producerIdentity: nonempty(input.producerIdentity, 'producerIdentity'),
    captureMechanism: nonempty(input.captureMechanism, 'captureMechanism'),
    ...(observationSnapshot ? { observationSnapshot } : {}),
    environment: record(input.environment, 'environment'),
    presentation: record(input.presentation, 'presentation'),
    sensitivity: nonempty(input.sensitivity, 'sensitivity'),
    limitations: stringArray(input.limitations, 'limitations'),
  }
}

function parseObservationSnapshot(value: unknown): ObservationSnapshot {
  const input = record(value, 'observationSnapshot')
  if (!('observedValue' in input))
    throw new Error('observationSnapshot.observedValue is required')
  return {
    observedValue: input.observedValue,
    sourceObjectId: nonempty(input.sourceObjectId, 'sourceObjectId'),
    ...optionalString(input, 'sourceVersion'),
    issuerIdentity: nonempty(input.issuerIdentity, 'issuerIdentity'),
    observedAt: isoDate(input.observedAt, 'observedAt'),
    snapshotHash: sha256(input.snapshotHash, 'snapshotHash'),
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function nonempty(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${name} is required`)
  return value.trim()
}

function optionalNonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const candidate = optionalNonemptyString(value[key])
  return candidate ? { [key]: candidate } : {}
}

function stringArray(value: unknown, name: string): string[] {
  return array(value, name).map((item, index) =>
    nonempty(item, `${name}[${String(index)}]`),
  )
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`)
  return value
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`)
  return value
}

function isoDate(value: unknown, name: string): string {
  const candidate = nonempty(value, name)
  if (Number.isNaN(Date.parse(candidate))) throw new Error(`${name} is invalid`)
  return new Date(candidate).toISOString()
}

function sha256(value: unknown, name: string): string {
  const candidate = nonempty(value, name).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(candidate))
    throw new Error(`${name} must be a SHA-256 digest`)
  return candidate
}

function unique(values: string[], name: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`${name} values must be unique`)
}
