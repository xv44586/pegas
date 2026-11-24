interface ReviewEvidencePreview {
  evidenceId?: unknown
  kind?: unknown
  verification?: unknown
  sensitivity?: unknown
  contentHash?: unknown
  artifactRevision?: unknown
  viewport?: unknown
  timecode?: unknown
  limitations?: unknown
  artifact?: { name?: unknown; revision?: unknown }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function redactedEvidence(
  item: ReviewEvidencePreview,
): Record<string, unknown> {
  const sensitivity =
    typeof item.sensitivity === 'string' ? item.sensitivity : 'restricted'
  // `public`/`private` are the owner's normal working data and stay
  // previewable; every other label (including unknown ones) fails closed
  // as in-app-only.
  const restricted = sensitivity !== 'public' && sensitivity !== 'private'
  const artifactName =
    isRecord(item.artifact) && typeof item.artifact.name === 'string'
      ? item.artifact.name
      : undefined
  return {
    ...(typeof item.evidenceId === 'string'
      ? { evidenceId: item.evidenceId }
      : {}),
    ...(typeof item.kind === 'string' ? { kind: item.kind } : {}),
    ...(typeof item.verification === 'string'
      ? { verification: item.verification }
      : {}),
    sensitivity,
    redacted: restricted,
    ...(restricted
      ? {}
      : {
          ...(typeof item.contentHash === 'string'
            ? { contentHash: item.contentHash }
            : {}),
          ...(typeof item.artifactRevision === 'string'
            ? { artifactRevision: item.artifactRevision }
            : {}),
          ...(isRecord(item.viewport) ? { viewport: item.viewport } : {}),
          ...(typeof item.timecode === 'number'
            ? { timecode: item.timecode }
            : {}),
          ...(artifactName ? { artifactName } : {}),
          ...(Array.isArray(item.limitations)
            ? { limitations: item.limitations }
            : {}),
        }),
    ...(typeof item.evidenceId === 'string'
      ? {
          previewRef: `/v1/evidence/${encodeURIComponent(item.evidenceId)}/content`,
        }
      : {}),
  }
}

/**
 * Builds the bounded payload an external channel may receive. Only
 * `review.ready` carries evidence previews today; every other payload type
 * is already a redacted summary by production contract and passes through
 * unchanged. Canonical evidence bytes are never embedded; external
 * receivers get an authenticated in-app reference instead.
 */
export function externalDeliveryPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload
  if (payload.type === 'approval.required') {
    if (typeof payload.messageId !== 'string' || payload.messageId === '')
      return payload
    const rest = { ...payload }
    Reflect.deleteProperty(rest, 'prompt')
    return {
      ...rest,
      deepLink: `/?view=outbox&outbox=${encodeURIComponent(payload.messageId)}`,
    }
  }
  if (payload.type !== 'review.ready') return payload
  const review = payload.review
  if (!isRecord(review)) return payload
  const evidence = Array.isArray(review.evidence) ? review.evidence : []
  const projected = evidence.map(item =>
    redactedEvidence(isRecord(item) ? item : {}),
  )
  const redactedCount = projected.filter(item => item.redacted === true).length
  return {
    ...payload,
    review: {
      ...(typeof review.finalOutcome === 'string'
        ? { finalOutcome: review.finalOutcome }
        : {}),
      ...(typeof review.goalRevision === 'number'
        ? { goalRevision: review.goalRevision }
        : {}),
      ...(Array.isArray(review.criteria)
        ? {
            criteria: review.criteria.map(criterion =>
              isRecord(criterion)
                ? {
                    ...(typeof criterion.criterionId === 'string'
                      ? { criterionId: criterion.criterionId }
                      : {}),
                    ...(typeof criterion.completionStatus === 'string'
                      ? { completionStatus: criterion.completionStatus }
                      : {}),
                    ...(typeof criterion.evidenceCount === 'number'
                      ? { evidenceCount: criterion.evidenceCount }
                      : {}),
                    ...(redactedCount > 0
                      ? {}
                      : {
                          ...(typeof criterion.explanation === 'string'
                            ? { explanation: criterion.explanation }
                            : {}),
                          ...(Array.isArray(criterion.limitations)
                            ? { limitations: criterion.limitations }
                            : {}),
                        }),
                  }
                : {},
            ),
          }
        : {}),
      evidence: projected,
      ...(redactedCount > 0 ? { redactedEvidenceCount: redactedCount } : {}),
      ...(Array.isArray(review.remainingRisks)
        ? { remainingRisks: review.remainingRisks }
        : {}),
      ...(typeof review.auditLink === 'string'
        ? { auditLink: review.auditLink }
        : {}),
    },
  }
}
