import type { ExecutionContext, InboxEvent, Mandate } from '../core/domain.js'

const mandatePolicyVersion = 'pegas-mandate-v1'

export function createMandate(
  event: InboxEvent,
  scope: string,
  via: Mandate['basis']['via'],
): Mandate {
  return {
    strength: 'explicit',
    policyVersion: mandatePolicyVersion,
    basis: {
      source: event.source,
      scope: { conversation: event.userId },
      via,
      sender: event.userId,
    },
    actor: { source: event.source, id: event.userId },
    scope,
  }
}

/**
 * TASK-002 starts with Pegas's current authenticated single-user boundary.
 * The immutable shape matches Super Agent so Source policies can replace
 * these explicit checks without changing persisted Mandates.
 */
export function revalidateMandate(
  mandate: Mandate,
  event: InboxEvent,
): boolean {
  return (
    event.type === 'user.message' &&
    mandate.strength === 'explicit' &&
    mandate.policyVersion === mandatePolicyVersion &&
    mandate.actor.id === event.userId
  )
}

export function sameExecutionContext(
  left: ExecutionContext,
  right: ExecutionContext,
): boolean {
  const leftRecord = left as unknown as Record<string, unknown>
  const rightRecord = right as unknown as Record<string, unknown>
  const keys = new Set([
    ...Object.keys(leftRecord),
    ...Object.keys(rightRecord),
  ])
  // The global revision also changes for settings used only outside execution.
  // The resolved model, workspace, permissions and profile still have to match.
  return [...keys].every(
    key => key === 'settingsRevision' || leftRecord[key] === rightRecord[key],
  )
}
