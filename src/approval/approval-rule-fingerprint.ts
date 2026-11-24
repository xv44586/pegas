import { createHash } from 'node:crypto'

import { approvalRuleTargets } from './approval.js'

export function approvalRuleFingerprint(input: {
  tool: string
  category: string
  targets: readonly string[]
}): string {
  return createHash('sha256')
    .update(JSON.stringify(approvalRuleTargets(input)))
    .digest('hex')
}

export function approvalRuleRevocationFingerprint(commandId: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ commandId, operation: 'revoke' }))
    .digest('hex')
}
