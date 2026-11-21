import type { ExecutionContext, Run } from '../core/domain.js'
import {
  decodeExecutionPermissions,
  decodeLegacyExecutionPermissions,
  ExecutionPermissionsDecodeError,
  type ExecutionPermissions,
} from '../core/execution-permissions.js'
import type { DshCliExecutorOptions } from '../executor/dsh-cli-executor.js'
import type { ExecutorInput } from '../executor/executor.js'
import type { RuntimeSettings } from '../settings/runtime-settings.js'

export interface DshExecutionDefaults {
  executorProfile: string
  workspace: string
  permissionMode: string
  approvalPolicy: 'ask' | 'never'
  additionalDirectories: string[]
  privacyMode: RuntimeSettings['privacyMode']
}

export interface DshExecutionSnapshot extends DshExecutionDefaults {
  agentModel?: { provider: string; model: string }
  reasoningEffort?: string
}

export function dshExecutorOptionsFromSnapshot(
  snapshot: DshExecutionSnapshot,
  runtime: Pick<DshCliExecutorOptions, 'command' | 'timeoutMs'>,
): DshCliExecutorOptions {
  return {
    ...runtime,
    profile: snapshot.executorProfile,
    permissionMode: snapshot.permissionMode,
    approvalPolicy: snapshot.approvalPolicy,
    additionalDirectories: snapshot.additionalDirectories,
    ...(snapshot.agentModel ? { agentModel: snapshot.agentModel } : {}),
    ...(snapshot.reasoningEffort
      ? { reasoningEffort: snapshot.reasoningEffort }
      : {}),
  }
}

export function decodeDshExecutionSnapshot(
  input: Pick<ExecutorInput, 'executionContractVersion' | 'executionContext'>,
  defaults: DshExecutionDefaults,
): DshExecutionSnapshot {
  if (input.executionContractVersion === 2) {
    return decodeVersion2(input.executionContext)
  }
  return decodeLegacy(input.executionContext, defaults)
}

export function runExecutionWorkspace(run: Run, fallback: string): string {
  if (run.executionContractVersion !== 2) {
    return run.executionContext.workspace ?? fallback
  }
  return decodeVersion2(run.executionContext).workspace
}

function decodeVersion2(
  context: ExecutionContext | undefined,
): DshExecutionSnapshot {
  if (!context) throw new Error('Run execution contract v2 is missing')
  if (context.executor !== 'dsh-headless')
    throw new Error('Run execution contract v2 has an invalid executor')
  if (context.protocol !== 'dsh-headless-v1')
    throw new Error('Run execution contract v2 has an invalid protocol')
  const executorProfile = requiredString(
    context.executorProfile,
    'executor profile',
  )
  const workspace = requiredString(context.workspace, 'workspace')
  positiveInteger(context.settingsRevision, 'settings revision')
  requiredString(context.workerProfile, 'worker profile')
  positiveInteger(context.workerProfileRevision, 'worker profile revision')
  if (
    context.workerProfileSource !== 'global' &&
    context.workerProfileSource !== 'task'
  )
    throw new Error('Run execution contract v2 has an invalid profile source')

  let agentModel: DshExecutionSnapshot['agentModel']
  if (context.modelMode === 'profile') {
    if (
      context.model !== 'profile' ||
      context.modelProvider !== undefined ||
      context.modelName !== undefined
    )
      throw new Error('Run execution contract v2 has an invalid profile model')
  } else if (context.modelMode === 'override') {
    const provider = requiredString(context.modelProvider, 'model provider')
    const model = requiredString(context.modelName, 'model name')
    if (context.model !== `${provider}/${model}`)
      throw new Error('Run execution contract v2 has an inconsistent model')
    agentModel = { provider, model }
  } else {
    throw new Error('Run execution contract v2 has an invalid model mode')
  }

  const permissions = parsePermissions(context.permissions, true)
  const reasoningEffort =
    context.reasoningEffort && agentModel ? context.reasoningEffort : undefined
  return {
    executorProfile,
    workspace,
    permissionMode: permissions.mode,
    approvalPolicy: permissions.approvalPolicy,
    additionalDirectories: permissions.additionalDirectories,
    privacyMode: permissions.privacyMode,
    ...(agentModel ? { agentModel } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }
}

function decodeLegacy(
  context: ExecutionContext | undefined,
  defaults: DshExecutionDefaults,
): DshExecutionSnapshot {
  const permissions = parsePermissions(context?.permissions, false)
  const agentModel =
    context?.modelMode === 'override' &&
    context.modelProvider &&
    context.modelName
      ? { provider: context.modelProvider, model: context.modelName }
      : legacyModelOverride(context?.model)
  return {
    executorProfile:
      nonBlankString(context?.executorProfile) ?? defaults.executorProfile,
    workspace: nonBlankString(context?.workspace) ?? defaults.workspace,
    permissionMode: permissions?.mode ?? defaults.permissionMode,
    approvalPolicy: permissions?.approvalPolicy ?? defaults.approvalPolicy,
    additionalDirectories:
      permissions?.additionalDirectories ?? defaults.additionalDirectories,
    privacyMode: permissions?.privacyMode ?? defaults.privacyMode,
    ...(agentModel ? { agentModel } : {}),
    ...(context?.reasoningEffort && agentModel
      ? { reasoningEffort: context.reasoningEffort }
      : {}),
  }
}

function nonBlankString(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  return normalized
}

function legacyModelOverride(
  modelRef: string | undefined,
): { provider: string; model: string } | undefined {
  if (!modelRef || modelRef === 'profile') return undefined
  const separator = modelRef.indexOf('/')
  if (separator <= 0 || separator === modelRef.length - 1) return undefined
  return {
    provider: modelRef.slice(0, separator),
    model: modelRef.slice(separator + 1),
  }
}

function parsePermissions(
  value: string | undefined,
  strict: true,
): ExecutionPermissions
function parsePermissions(
  value: string | undefined,
  strict: false,
): Partial<ExecutionPermissions> | undefined
function parsePermissions(
  value: string | undefined,
  strict: boolean,
): ExecutionPermissions | Partial<ExecutionPermissions> | undefined {
  if (!strict) return decodeLegacyExecutionPermissions(value)
  try {
    return decodeExecutionPermissions(value)
  } catch (error) {
    if (!(error instanceof ExecutionPermissionsDecodeError)) throw error
    const message =
      error.issue === 'missing'
        ? 'Run execution contract v2 has no permissions'
        : error.issue === 'malformed'
          ? 'Run execution contract v2 permissions are malformed'
          : error.issue === 'invalid'
            ? 'Run execution contract v2 permissions are invalid'
            : error.issue === 'unknown_fields'
              ? 'Run execution contract v2 permissions contain unknown fields'
              : 'Run execution contract v2 permissions are incomplete'
    throw new Error(message, { cause: error })
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Run execution contract v2 has no ${field}`)
  return value.trim()
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0)
    throw new Error(`Run execution contract v2 has an invalid ${field}`)
  return Number(value)
}
