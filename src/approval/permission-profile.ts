export type PermissionTier = 'strict' | 'standard' | 'full'

export interface TierSandbox {
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'ask'
}

export interface PermissionTierCombination {
  tier: PermissionTier
  clamped: boolean
  mismatch: boolean
}

const tierRanks: Record<PermissionTier, number> = {
  strict: 0,
  standard: 1,
  full: 2,
}

const tierSandboxes: Record<PermissionTier, TierSandbox> = {
  strict: { mode: 'read-only', approvalPolicy: 'ask' },
  standard: { mode: 'workspace-write', approvalPolicy: 'ask' },
  full: { mode: 'danger-full-access', approvalPolicy: 'ask' },
}

export function isPermissionTier(value: unknown): value is PermissionTier {
  return value === 'strict' || value === 'standard' || value === 'full'
}

export function permissionTierRank(tier: PermissionTier): number {
  return tierRanks[tier]
}

export function tierSandbox(tier: PermissionTier): TierSandbox {
  return tierSandboxes[tier]
}

export function combinePermissionTiers(input: {
  snapshotTier?: PermissionTier
  liveTier?: PermissionTier
  mismatch?: boolean
}): PermissionTierCombination {
  if (
    input.mismatch === true ||
    input.snapshotTier === undefined ||
    input.liveTier === undefined
  ) {
    return { tier: 'strict', clamped: false, mismatch: true }
  }
  if (
    permissionTierRank(input.liveTier) < permissionTierRank(input.snapshotTier)
  ) {
    return { tier: input.liveTier, clamped: false, mismatch: false }
  }
  return {
    tier: input.snapshotTier,
    clamped: input.liveTier !== input.snapshotTier,
    mismatch: false,
  }
}
