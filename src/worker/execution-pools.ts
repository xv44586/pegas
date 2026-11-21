import type { RuntimeSettingsSelection } from '../settings/runtime-settings-selection.js'

export type ExecutionPool = 'fast' | 'balanced' | 'deep'

export interface ExecutionPoolModel {
  provider: string
  model: string
}

export type ExecutionPools = Partial<Record<ExecutionPool, ExecutionPoolModel>>

export interface PoolResolution {
  requested?: ExecutionPool
  actual?: ExecutionPool
  model?: ExecutionPoolModel
  /** Present when the requested pool degraded or was rejected. */
  downgradeReason?: string
}

/**
 * PLAN-001 decision 3: pools are user-configured and optional. Degradation
 * follows fast → balanced → global default and is always recorded, never
 * silent. A configured pool always wins over the global agent override;
 * without any pool configuration the existing single-model behavior holds.
 */
export function resolveExecutionPool(
  requested: ExecutionPool | undefined,
  pools: ExecutionPools,
  globalDefault: ExecutionPoolModel | undefined,
): PoolResolution {
  if (!requested) {
    return globalDefault ? { model: globalDefault } : {}
  }
  const chain: ExecutionPool[] =
    requested === 'fast'
      ? ['fast', 'balanced']
      : requested === 'balanced'
        ? ['balanced']
        : ['deep']
  for (const pool of chain) {
    const model = pools[pool]
    if (model) {
      return pool === requested
        ? { requested, actual: pool, model }
        : {
            requested,
            actual: pool,
            model,
            downgradeReason: `Pool ${requested} is not configured; fell back to ${pool}.`,
          }
    }
  }
  if (globalDefault) {
    return {
      requested,
      model: globalDefault,
      downgradeReason: `Pool ${requested} is not configured; fell back to the global default model.`,
    }
  }
  return {
    requested,
    downgradeReason: `Pool ${requested} is not configured and no global default model is available.`,
  }
}

export function parseExecutionPools(value: unknown): ExecutionPools {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('executionPools must be an object')
  const record = value as Record<string, unknown>
  const pools: ExecutionPools = {}
  for (const key of Object.keys(record)) {
    if (key !== 'fast' && key !== 'balanced' && key !== 'deep')
      throw new Error(`Unknown execution pool: ${key}`)
    const entry = record[key]
    if (entry === null || entry === undefined) continue
    if (typeof entry !== 'object' || Array.isArray(entry))
      throw new Error(`Execution pool ${key} must be an object or null`)
    const model = entry as Record<string, unknown>
    const provider = poolString(model.provider, `${key}.provider`)
    const name = poolString(model.model, `${key}.model`)
    pools[key] = { provider, model: name }
  }
  return pools
}

export function globalDefaultPoolModel(
  settings: Pick<
    RuntimeSettingsSelection,
    'agentModelMode' | 'agentModelProvider' | 'agentModelName'
  >,
): ExecutionPoolModel | undefined {
  return settings.agentModelMode === 'override' &&
    settings.agentModelProvider &&
    settings.agentModelName
    ? {
        provider: settings.agentModelProvider,
        model: settings.agentModelName,
      }
    : undefined
}

function poolString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 240)
    throw new Error(`executionPools.${field} must be a non-empty string`)
  return value.trim()
}
