type ExecutionPermissionMode =
  'read-only' | 'workspace-write' | 'danger-full-access'

export interface ExecutionPermissions {
  mode: ExecutionPermissionMode
  approvalPolicy: 'ask' | 'never'
  additionalDirectories: string[]
  privacyMode: 'mask' | 'disabled'
}

export type ExecutionPermissionsIssue =
  'missing' | 'malformed' | 'invalid' | 'unknown_fields' | 'incomplete'

export class ExecutionPermissionsDecodeError extends Error {
  readonly issue: ExecutionPermissionsIssue

  constructor(issue: ExecutionPermissionsIssue) {
    super(`Execution permissions are ${issue}`)
    this.issue = issue
  }
}

const modes = new Set<ExecutionPermissionMode>([
  'read-only',
  'workspace-write',
  'danger-full-access',
])

const keys = new Set([
  'mode',
  'approvalPolicy',
  'additionalDirectories',
  'privacyMode',
])

export function decodeExecutionPermissions(
  value: string | undefined,
): ExecutionPermissions {
  if (!value) throw new ExecutionPermissionsDecodeError('missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new ExecutionPermissionsDecodeError('malformed')
  }
  if (!isRecord(parsed)) throw new ExecutionPermissionsDecodeError('invalid')
  if (Object.keys(parsed).some(key => !keys.has(key))) {
    throw new ExecutionPermissionsDecodeError('unknown_fields')
  }
  const permissions = validatedFields(parsed)
  if (
    permissions.mode === undefined ||
    permissions.approvalPolicy === undefined ||
    permissions.additionalDirectories === undefined ||
    permissions.privacyMode === undefined
  ) {
    throw new ExecutionPermissionsDecodeError('incomplete')
  }
  return permissions as ExecutionPermissions
}

export function decodeLegacyExecutionPermissions(
  value: string | undefined,
): Partial<ExecutionPermissions> | undefined {
  if (!value) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  return validatedFields(parsed)
}

function validatedFields(
  parsed: Record<string, unknown>,
): Partial<ExecutionPermissions> {
  const mode =
    typeof parsed.mode === 'string' &&
    modes.has(parsed.mode as ExecutionPermissionMode)
      ? (parsed.mode as ExecutionPermissionMode)
      : undefined
  const approvalPolicy =
    parsed.approvalPolicy === 'ask' || parsed.approvalPolicy === 'never'
      ? parsed.approvalPolicy
      : undefined
  const additionalDirectories =
    Array.isArray(parsed.additionalDirectories) &&
    parsed.additionalDirectories.every(
      directory => typeof directory === 'string' && Boolean(directory.trim()),
    )
      ? (parsed.additionalDirectories as string[])
      : undefined
  const privacyMode =
    parsed.privacyMode === 'disabled' || parsed.privacyMode === 'mask'
      ? parsed.privacyMode
      : undefined
  return {
    ...(mode ? { mode } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(additionalDirectories ? { additionalDirectories } : {}),
    ...(privacyMode ? { privacyMode } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
