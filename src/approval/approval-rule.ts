export interface ApprovalRule {
  id: string
  taskId: string
  tool: string
  category: string
  targets: string[]
  fingerprint: string
  status: 'active' | 'revoked'
  createdFromApprovalId: string
  createdFromDecisionId: string
  createdBy: string
  createdAt: string
  revokedAt?: string
  revokedBy?: string
}

export interface ApprovalRuleProjection {
  id: string
  tool: string
  category: string
  targets: string[]
  fingerprint: string
}

export interface ApprovalRuleRevocationDraft {
  commandId: string
}

export function parseApprovalRuleRevocation(
  value: unknown,
): ApprovalRuleRevocationDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('revocation must be an object')
  }
  const input = value as Record<string, unknown>
  const commandId = input.commandId
  if (typeof commandId !== 'string' || commandId.trim() === '') {
    throw new Error('commandId is required')
  }
  if (commandId.length > 200) {
    throw new Error('commandId must be at most 200 characters')
  }
  return { commandId }
}
