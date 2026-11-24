import { createHash } from 'node:crypto'

export type MemoryScope = 'global' | 'worker' | 'channel'

export type MemoryCategory =
  | 'preference'
  | 'fact'
  | 'context'
  | 'experience'
  | 'procedure'
  | 'sensitive_reference'

export type MemorySource =
  | { kind: 'user_confirmation' }
  | { kind: 'task' | 'run' | 'artifact'; id: string }

export interface MemoryDraft {
  scope: MemoryScope
  taskId?: string
  category: MemoryCategory
  content: string
  source: MemorySource
}

export interface MemoryRecord extends MemoryDraft {
  id: string
  userId: string
  revision: number
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
}

export interface MemoryCreateCommand {
  userId: string
  commandId: string
  memory: MemoryDraft
}

export interface MemoryUpdateCommand extends MemoryCreateCommand {
  expectedRevision: number
}

export interface MemoryDeleteCommand {
  userId: string
  commandId: string
  expectedRevision: number
}

export interface MemoryDeletion {
  id: string
  deleted: true
  deletedAt: string
}

export interface MemoryContextEntry {
  id: string
  scope: MemoryScope
  category: MemoryCategory
  content: string
  source: MemorySource
  origin?: 'explicit' | 'derived'
  provider?: 'hindsight'
  relevance?: number
}

export interface MemoryListOptions {
  scope?: MemoryScope
  taskId?: string
  category?: MemoryCategory
}

const scopes = new Set<MemoryScope>(['global', 'worker', 'channel'])
const categories = new Set<MemoryCategory>([
  'preference',
  'fact',
  'context',
  'experience',
  'procedure',
  'sensitive_reference',
])

export function parseMemoryCreate(value: unknown): MemoryCreateCommand {
  const input = record(value, 'Memory command')
  exactKeys(input, ['userId', 'commandId', 'memory'])
  return {
    userId: requiredString(input.userId, 'userId', 160),
    commandId: requiredString(input.commandId, 'commandId', 160),
    memory: parseMemoryDraft(input.memory),
  }
}

export function parseMemoryUpdate(value: unknown): MemoryUpdateCommand {
  const input = record(value, 'Memory update')
  exactKeys(input, ['userId', 'commandId', 'expectedRevision', 'memory'])
  return {
    userId: requiredString(input.userId, 'userId', 160),
    commandId: requiredString(input.commandId, 'commandId', 160),
    expectedRevision: positiveInteger(
      input.expectedRevision,
      'expectedRevision',
    ),
    memory: parseMemoryDraft(input.memory),
  }
}

export function parseMemoryDelete(value: unknown): MemoryDeleteCommand {
  const input = record(value, 'Memory delete')
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

export function parseMemoryDraft(value: unknown): MemoryDraft {
  const input = record(value, 'Memory')
  exactKeys(input, ['scope', 'taskId', 'category', 'content', 'source'])
  const scope = enumValue(input.scope, 'memory.scope', scopes)
  const taskId = optionalString(input.taskId, 'memory.taskId', 160)
  if (scope === 'global' && taskId)
    throw new Error('Global Memory cannot include taskId')
  if (scope !== 'global' && !taskId)
    throw new Error('Worker and Channel Memory require taskId')
  return {
    scope,
    ...(taskId ? { taskId } : {}),
    category: enumValue(input.category, 'memory.category', categories),
    content: requiredString(input.content, 'memory.content', 4000),
    source: parseSource(input.source),
  }
}

export function parseMemoryScope(value: string): MemoryScope {
  return enumValue(value, 'scope', scopes)
}

export function parseMemoryCategory(value: string): MemoryCategory {
  return enumValue(value, 'category', categories)
}

export function memoryFingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function toMemoryContext(memory: MemoryRecord): MemoryContextEntry {
  return {
    id: memory.id,
    scope: memory.scope,
    category: memory.category,
    content: memory.content,
    source: memory.source,
  }
}

function parseSource(value: unknown): MemorySource {
  const input = record(value, 'memory.source')
  const kind = requiredString(input.kind, 'memory.source.kind', 30)
  if (kind === 'user_confirmation') {
    exactKeys(input, ['kind'])
    return { kind }
  }
  if (kind === 'task' || kind === 'run' || kind === 'artifact') {
    exactKeys(input, ['kind', 'id'])
    return {
      kind,
      id: requiredString(input.id, 'memory.source.id', 160),
    }
  }
  throw new Error(
    'memory.source.kind must be user_confirmation, task, run or artifact',
  )
}

function enumValue<T extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlySet<T>,
): T {
  if (typeof value !== 'string' || !allowed.has(value as T))
    throw new Error(`${field} is invalid`)
  return value as T
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
