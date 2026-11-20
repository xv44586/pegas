import type { ExecutionContext } from '../core/domain.js'
import type { RuntimeSettings } from '../settings/runtime-settings.js'

type WorkerProfileModelMode = 'inherit' | 'override'

export interface WorkerProfile {
  id: string
  taskId: string
  revision: number
  modelMode: WorkerProfileModelMode
  modelProvider?: string
  modelName?: string
  createdAt: string
  updatedAt: string
}

export interface WorkerProfileUpdate {
  commandId: string
  expectedRevision: number
  modelMode: WorkerProfileModelMode
  modelProvider?: string
  modelName?: string
}

export interface EffectiveWorkerProfile {
  profile: WorkerProfile
  source: 'global' | 'task'
  modelMode: 'profile' | 'override'
  modelProvider?: string
  modelName?: string
  modelRef: string
}

export function parseWorkerProfileUpdate(value: unknown): WorkerProfileUpdate {
  const input = record(value, 'Worker Profile update')
  const commandId = requiredString(input.commandId, 'commandId', 240)
  const expectedRevision = positiveInteger(
    input.expectedRevision,
    'expectedRevision',
  )
  const modelMode = requiredString(input.modelMode, 'modelMode', 20)
  if (modelMode !== 'inherit' && modelMode !== 'override')
    throw new Error('modelMode must be inherit or override')
  const modelProvider = optionalString(
    input.modelProvider,
    'modelProvider',
    160,
  )
  const modelName = optionalString(input.modelName, 'modelName', 240)
  if (modelMode === 'override' && (!modelProvider || !modelName))
    throw new Error('模型覆盖需要 provider 和 model')
  if (modelMode === 'inherit' && (modelProvider || modelName))
    throw new Error('继承全局设置时不能同时指定模型覆盖')
  return {
    commandId,
    expectedRevision,
    modelMode,
    ...(modelProvider ? { modelProvider } : {}),
    ...(modelName ? { modelName } : {}),
  }
}

export function effectiveWorkerProfile(
  profile: WorkerProfile,
  settings: RuntimeSettings,
): EffectiveWorkerProfile {
  const taskOverride = profile.modelMode === 'override'
  const modelMode = taskOverride ? 'override' : settings.agentModelMode
  const modelProvider = taskOverride
    ? profile.modelProvider
    : settings.agentModelProvider || undefined
  const modelName = taskOverride
    ? profile.modelName
    : settings.agentModelName || undefined
  return {
    profile,
    source: taskOverride ? 'task' : 'global',
    modelMode,
    ...(modelProvider ? { modelProvider } : {}),
    ...(modelName ? { modelName } : {}),
    modelRef:
      modelMode === 'override' && modelProvider && modelName
        ? `${modelProvider}/${modelName}`
        : 'profile',
  }
}

export function workerExecutionContext(
  effective: EffectiveWorkerProfile,
  base: Omit<
    ExecutionContext,
    | 'model'
    | 'modelMode'
    | 'modelProvider'
    | 'modelName'
    | 'settingsRevision'
    | 'workerProfile'
    | 'workerProfileRevision'
    | 'workerProfileSource'
  >,
  settingsRevision: number,
): ExecutionContext {
  return {
    ...base,
    model: effective.modelRef,
    modelMode: effective.modelMode,
    ...(effective.modelProvider
      ? { modelProvider: effective.modelProvider }
      : {}),
    ...(effective.modelName ? { modelName: effective.modelName } : {}),
    settingsRevision,
    workerProfile: effective.profile.id,
    workerProfileRevision: effective.profile.revision,
    workerProfileSource: effective.source,
  }
}

export function workerProfileFingerprint(
  update: Pick<
    WorkerProfileUpdate,
    'expectedRevision' | 'modelMode' | 'modelProvider' | 'modelName'
  >,
): string {
  return JSON.stringify({
    expectedRevision: update.expectedRevision,
    modelMode: update.modelMode,
    modelProvider: update.modelProvider ?? '',
    modelName: update.modelName ?? '',
  })
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${field} must be an object`)
  return value as Record<string, unknown>
}

function requiredString(
  value: unknown,
  field: string,
  maximum: number,
): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${field} is required`)
  const normalized = value.trim()
  if (normalized.length > maximum) throw new Error(`${field} is too long`)
  return normalized
}

function optionalString(
  value: unknown,
  field: string,
  maximum: number,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredString(value, field, maximum)
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error(`${field} must be a positive integer`)
  return Number(value)
}
