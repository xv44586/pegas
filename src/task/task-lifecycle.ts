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

export type TaskResumeSource = 'web' | 'mobile'

export function isTaskResumeSource(source: string): source is TaskResumeSource {
  return source === 'web' || source === 'mobile'
}

export interface TaskResumeSourcePolicy {
  source: TaskResumeSource
  enabled: boolean
  revision: number
}

export function revalidateMandate(
  mandate: Mandate,
  origin: InboxEvent,
  event: InboxEvent,
): boolean {
  return (
    event.type === 'user.message' &&
    event.authenticatedActor === 'human' &&
    isTaskResumeSource(event.source) &&
    origin.type === 'user.message' &&
    origin.authenticatedActor === 'human' &&
    isTaskResumeSource(origin.source) &&
    mandate.strength === 'explicit' &&
    mandate.policyVersion === mandatePolicyVersion &&
    mandate.basis.source === origin.source &&
    mandate.actor.source === origin.source &&
    mandate.basis.scope.conversation === origin.userId &&
    (mandate.basis.sender ?? origin.userId) === event.userId &&
    mandate.actor.id === event.userId &&
    origin.userId === event.userId
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
