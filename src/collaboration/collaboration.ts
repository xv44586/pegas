import { createHash } from 'node:crypto'

import type { ExecutionContext } from '../core/domain.js'
import { decodeExecutionPermissions } from '../core/execution-permissions.js'
import type { ExecutionPermissions } from '../core/execution-permissions.js'

export type CollaborationKind =
  'delegate' | 'handoff' | 'context_note' | 'handback'

export type CollaborationStatus =
  'pending' | 'active' | 'returned' | 'completed' | 'failed' | 'cancelled'

interface CollaborationCommand {
  commandId: string
  kind: CollaborationKind
}

export type WorkerCollaborationRequest =
  | (CollaborationCommand & {
      kind: 'delegate'
      goal: string
      reason: string
      expectedOutput: string
      contextRefs: string[]
    })
  | (CollaborationCommand & {
      kind: 'handoff'
      goal: string
      reason: string
      contextRefs: string[]
    })
  | (CollaborationCommand & {
      kind: 'context_note'
      targetChannelId: string
      text: string
      sourceRefs: string[]
    })
  | (CollaborationCommand & {
      kind: 'handback'
      inputEventId: string
      reason: string
    })

export interface CollaborationResult {
  outcome: 'completed' | 'failed' | 'cancelled'
  summary: string
  targetRunId?: string
}

export interface ChannelRelation {
  id: string
  commandId: string
  userId: string
  kind: CollaborationKind
  status: CollaborationStatus
  sourceTaskId: string
  sourceRunId: string
  parentRelationId?: string
  rootRelationId: string
  depth: number
  targetTaskId?: string
  targetEventId?: string
  returnEventId?: string
  request: WorkerCollaborationRequest
  result?: CollaborationResult
  createdAt: string
  updatedAt: string
  settledAt?: string
}

const permissionRank: Record<ExecutionPermissions['mode'], number> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}

/**
 * A context note carries a sourced fact into an existing Task. It must keep the
 * target Task's model/profile while executing with authority no broader than
 * either the source Run or the target Run that would otherwise be created.
 */
export function intersectContextNoteAuthority(
  source: ExecutionContext,
  target: ExecutionContext,
  sourceRunId: string,
): ExecutionContext {
  if (
    source.executor !== target.executor ||
    source.protocol !== target.protocol ||
    source.workspace !== target.workspace ||
    source.executorProfile !== target.executorProfile ||
    (source.permissions === undefined) !== (target.permissions === undefined)
  ) {
    throw new Error('Collaboration execution context is incompatible')
  }
  const sourcePermissions = parseCollaborationPermissions(source.permissions)
  const targetPermissions = parseCollaborationPermissions(target.permissions)
  const permissions = intersectPermissions(sourcePermissions, targetPermissions)
  return {
    ...target,
    ...(permissions ? { permissions: JSON.stringify(permissions) } : {}),
    authoritySourceRunId: sourceRunId,
  }
}

function intersectPermissions(
  source: ExecutionPermissions | undefined,
  target: ExecutionPermissions | undefined,
): ExecutionPermissions | undefined {
  if (!source) return target
  if (!target) return source
  const sourceDirectories = new Set(source.additionalDirectories)
  return {
    mode:
      permissionRank[source.mode] <= permissionRank[target.mode]
        ? source.mode
        : target.mode,
    approvalPolicy:
      source.approvalPolicy === 'ask' || target.approvalPolicy === 'ask'
        ? 'ask'
        : 'never',
    additionalDirectories: target.additionalDirectories.filter(directory =>
      sourceDirectories.has(directory),
    ),
    privacyMode:
      source.privacyMode === 'mask' || target.privacyMode === 'mask'
        ? 'mask'
        : 'disabled',
  }
}

function parseCollaborationPermissions(
  value: string | undefined,
): ExecutionPermissions | undefined {
  if (value === undefined) return undefined
  try {
    return decodeExecutionPermissions(value)
  } catch {
    throw new Error('Collaboration execution permissions are malformed')
  }
}

export function parseWorkerCollaborationRequest(
  value: unknown,
): WorkerCollaborationRequest {
  const input = record(value, 'Collaboration request')
  const kind = enumValue(input.kind, 'kind', [
    'delegate',
    'handoff',
    'context_note',
    'handback',
  ] as const)
  const commandId = requiredString(input.commandId, 'commandId', 160)
  if (kind === 'delegate') {
    exactKeys(input, [
      'commandId',
      'kind',
      'goal',
      'reason',
      'expectedOutput',
      'contextRefs',
    ])
    return {
      commandId,
      kind,
      goal: requiredString(input.goal, 'goal', 4000),
      reason: requiredString(input.reason, 'reason', 2000),
      expectedOutput: requiredString(
        input.expectedOutput,
        'expectedOutput',
        2000,
      ),
      contextRefs: stringList(input.contextRefs, 'contextRefs'),
    }
  }
  if (kind === 'handoff') {
    exactKeys(input, ['commandId', 'kind', 'goal', 'reason', 'contextRefs'])
    return {
      commandId,
      kind,
      goal: requiredString(input.goal, 'goal', 4000),
      reason: requiredString(input.reason, 'reason', 2000),
      contextRefs: stringList(input.contextRefs, 'contextRefs'),
    }
  }
  if (kind === 'context_note') {
    exactKeys(input, [
      'commandId',
      'kind',
      'targetChannelId',
      'text',
      'sourceRefs',
    ])
    return {
      commandId,
      kind,
      targetChannelId: requiredString(
        input.targetChannelId,
        'targetChannelId',
        160,
      ),
      text: requiredString(input.text, 'text', 8000),
      sourceRefs: stringList(input.sourceRefs, 'sourceRefs'),
    }
  }
  exactKeys(input, ['commandId', 'kind', 'inputEventId', 'reason'])
  return {
    commandId,
    kind,
    inputEventId: requiredString(input.inputEventId, 'inputEventId', 160),
    reason: requiredString(input.reason, 'reason', 2000),
  }
}

export function collaborationRequestFingerprint(
  request: WorkerCollaborationRequest,
): string {
  return createHash('sha256').update(stableJson(request)).digest('hex')
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const extras = Object.keys(value).filter(key => !allowed.includes(key))
  if (extras.length > 0) {
    throw new Error(`Unknown collaboration field: ${extras.sort().join(', ')}`)
  }
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`)
  }
  const normalized = value.trim()
  if (normalized.length > maximum) {
    throw new Error(
      `${name} must contain at most ${String(maximum)} characters`,
    )
  }
  return normalized
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error(`${name} must be an array with at most 64 items`)
  }
  const result = value.map((item, index) =>
    requiredString(item, `${name}[${String(index)}]`, 240),
  )
  if (new Set(result).size !== result.length) {
    throw new Error(`${name} must not contain duplicates`)
  }
  return result
}

function enumValue<const T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    )
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
