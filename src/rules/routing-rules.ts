import { createHash } from 'node:crypto'

export interface RoutingRuleDraft {
  title: string
  content: string
  enabled: boolean
}

export interface RoutingRuleRecord extends RoutingRuleDraft {
  id: string
  userId: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface RoutingRuleCreateCommand {
  userId: string
  commandId: string
  rule: RoutingRuleDraft
}

export interface RoutingRuleUpdateCommand extends RoutingRuleCreateCommand {
  expectedRevision: number
}

export interface RoutingRuleDeleteCommand {
  userId: string
  commandId: string
  expectedRevision: number
}

export interface RoutingRuleDeletion {
  id: string
  deleted: true
  deletedAt: string
}

export interface RoutingRuleContext {
  rules: readonly { id: string; title: string; content: string }[]
}

export function parseRoutingRuleCreate(
  value: unknown,
): RoutingRuleCreateCommand {
  const input = record(value, 'Routing rule command')
  exactKeys(input, ['userId', 'commandId', 'rule'])
  return {
    userId: requiredString(input.userId, 'userId', 160),
    commandId: requiredString(input.commandId, 'commandId', 160),
    rule: parseRoutingRuleDraft(input.rule),
  }
}

export function parseRoutingRuleUpdate(
  value: unknown,
): RoutingRuleUpdateCommand {
  const input = record(value, 'Routing rule update')
  exactKeys(input, ['userId', 'commandId', 'expectedRevision', 'rule'])
  return {
    userId: requiredString(input.userId, 'userId', 160),
    commandId: requiredString(input.commandId, 'commandId', 160),
    expectedRevision: positiveInteger(
      input.expectedRevision,
      'expectedRevision',
    ),
    rule: parseRoutingRuleDraft(input.rule),
  }
}

export function parseRoutingRuleDelete(
  value: unknown,
): RoutingRuleDeleteCommand {
  const input = record(value, 'Routing rule delete')
  exactKeys(input, ['userId', 'commandId', 'expectedRevision'])
  return {
    userId: requiredString(input.userId, 'userId', 160),
    commandId: requiredString(input.commandId, 'commandId', 160),
    expectedRevision: positiveInteger(
      input.expectedRevision,
      'expectedRevision',
    ),
  }
}

export function parseRoutingRuleDraft(value: unknown): RoutingRuleDraft {
  const input = record(value, 'Routing rule')
  exactKeys(input, ['title', 'content', 'enabled'])
  if (typeof input.enabled !== 'boolean')
    throw new Error('rule.enabled must be a boolean')
  return {
    title: requiredString(input.title, 'rule.title', 120),
    content: requiredString(input.content, 'rule.content', 2000),
    enabled: input.enabled,
  }
}

export function routingRuleFingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${field} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
): void {
  const allowed = new Set(keys)
  const unexpected = Object.keys(input).find(key => !allowed.has(key))
  if (unexpected) throw new Error(`Unexpected field: ${unexpected}`)
}

function requiredString(
  value: unknown,
  field: string,
  maximum: number,
): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${field} is required`)
  const normalized = value.trim()
  if (Array.from(normalized).length > maximum)
    throw new Error(`${field} is too long`)
  return normalized
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error(`${field} must be a positive integer`)
  return Number(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const recordValue = value as Record<string, unknown>
    return `{${Object.keys(recordValue)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(recordValue[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
