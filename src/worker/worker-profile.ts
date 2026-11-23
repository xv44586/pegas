import type { ExecutionContext } from '../core/domain.js'
import type { RuntimeSettingsSelection } from '../settings/runtime-settings-selection.js'
import {
  isPermissionTier,
  type PermissionTier,
} from '../approval/permission-profile.js'
import {
  globalDefaultPoolModel,
  resolveExecutionPool,
  type ExecutionPool,
  type PoolResolution,
} from './execution-pools.js'

type WorkerProfileModelMode = 'inherit' | 'override'

export interface WorkerProfile {
  id: string
  taskId: string
  revision: number
  modelMode: WorkerProfileModelMode
  modelProvider?: string
  modelName?: string
  pool?: ExecutionPool
  effort?: string
  permissionMode?: PermissionTier | 'inherit'
  createdAt: string
  updatedAt: string
}

export interface WorkerProfileUpdate {
  commandId: string
  expectedRevision: number
  modelMode: WorkerProfileModelMode
  modelProvider?: string
  modelName?: string
  pool?: ExecutionPool
  effort?: string
  permissionMode?: PermissionTier | 'inherit'
}

export interface EffectiveWorkerProfile {
  profile: WorkerProfile
  source: 'global' | 'task'
  modelMode: 'profile' | 'override'
  modelProvider?: string
  modelName?: string
  modelRef: string
  pool?: ExecutionPool
  effort?: string
  poolResolution?: PoolResolution
  permissionTier: PermissionTier
  permissionSource: 'global' | 'task'
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
  const poolValue = optionalString(input.pool, 'pool', 20)
  const allowedPools: readonly string[] = ['fast', 'balanced', 'deep']
  if (poolValue !== undefined && !allowedPools.includes(poolValue))
    throw new Error('pool must be fast, balanced or deep')
  const pool = poolValue as ExecutionPool | undefined
  const effort = optionalString(input.effort, 'effort', 20)
  if (modelMode === 'override' && pool)
    throw new Error('模型覆盖与执行池不能同时指定')
  let permissionMode: WorkerProfileUpdate['permissionMode']
  if (input.permissionMode !== undefined) {
    if (
      input.permissionMode !== 'inherit' &&
      !isPermissionTier(input.permissionMode)
    )
      throw new Error(
        'permissionMode must be inherit, strict, standard or full',
      )
    permissionMode = input.permissionMode
  }
  return {
    commandId,
    expectedRevision,
    modelMode,
    ...(modelProvider ? { modelProvider } : {}),
    ...(modelName ? { modelName } : {}),
    ...(pool ? { pool } : {}),
    ...(effort ? { effort } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  }
}

export function effectiveWorkerProfile(
  profile: WorkerProfile,
  settings: RuntimeSettingsSelection,
): EffectiveWorkerProfile {
  const permissionSource =
    profile.permissionMode && profile.permissionMode !== 'inherit'
      ? ('task' as const)
      : ('global' as const)
  const permissionTier: PermissionTier =
    permissionSource === 'task' && isPermissionTier(profile.permissionMode)
      ? profile.permissionMode
      : (settings.permissionTier ?? 'standard')
  const taskOverride = profile.modelMode === 'override'
  if (!taskOverride && profile.pool) {
    const resolution = resolveExecutionPool(
      profile.pool,
      settings.executionPools ?? {},
      globalDefaultPoolModel(settings),
    )
    if (!resolution.model) {
      throw new Error(
        resolution.downgradeReason ??
          `Execution pool ${profile.pool} cannot be resolved`,
      )
    }
    return {
      profile,
      source: 'task',
      modelMode: 'override',
      modelProvider: resolution.model.provider,
      modelName: resolution.model.model,
      modelRef: `${resolution.model.provider}/${resolution.model.model}`,
      pool: resolution.actual ?? profile.pool,
      ...(profile.effort ? { effort: profile.effort } : {}),
      poolResolution: resolution,
      permissionTier,
      permissionSource,
    }
  }
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
    ...(profile.effort ? { effort: profile.effort } : {}),
    modelRef:
      modelMode === 'override' && modelProvider && modelName
        ? `${modelProvider}/${modelName}`
        : 'profile',
    permissionTier,
    permissionSource,
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
    | 'permissionTier'
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
    ...(effective.pool ? { executionPool: effective.pool } : {}),
    ...(effective.profile.pool && effective.profile.pool !== effective.pool
      ? { requestedPool: effective.profile.pool }
      : {}),
    ...(effective.poolResolution?.downgradeReason
      ? { poolDowngradeReason: effective.poolResolution.downgradeReason }
      : {}),
    ...(effective.effort ? { reasoningEffort: effective.effort } : {}),
    settingsRevision,
    workerProfile: effective.profile.id,
    workerProfileRevision: effective.profile.revision,
    workerProfileSource: effective.source,
    permissionTier: effective.permissionTier,
  }
}

export function workerProfileFingerprint(
  update: Pick<
    WorkerProfileUpdate,
    | 'expectedRevision'
    | 'modelMode'
    | 'modelProvider'
    | 'modelName'
    | 'pool'
    | 'effort'
    | 'permissionMode'
  >,
): string {
  return JSON.stringify({
    expectedRevision: update.expectedRevision,
    modelMode: update.modelMode,
    modelProvider: update.modelProvider ?? '',
    modelName: update.modelName ?? '',
    pool: update.pool ?? '',
    effort: update.effort ?? '',
    permissionMode: update.permissionMode ?? 'inherit',
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
