import { createHash } from 'node:crypto'

export type AutomationStatus = 'active' | 'paused' | 'completed' | 'cancelled'

export type AutomationSchedule =
  | { kind: 'once'; at: string }
  | { kind: 'interval'; everySeconds: number; startsAt?: string }

export type AutomationTarget =
  { kind: 'new_task' } | { kind: 'existing_task'; taskId: string }

export interface AutomationDraft {
  title: string
  prompt: string
  schedule: AutomationSchedule
  target: AutomationTarget
}

export interface Automation {
  id: string
  userId: string
  revision: number
  title: string
  prompt: string
  schedule: AutomationSchedule
  target: AutomationTarget
  status: AutomationStatus
  nextFireAt?: string
  lastFiredAt?: string
  createdAt: string
  updatedAt: string
}

export type AutomationInvocationStatus =
  'pending' | 'processing' | 'dispatched' | 'failed'

export interface AutomationInvocation {
  id: string
  automationId: string
  userId: string
  scheduledFor: string
  eventId: string
  status: AutomationInvocationStatus
  attempts: number
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface AutomationCreateCommand {
  userId: string
  commandId: string
  automation: AutomationDraft
}

export interface AutomationUpdateCommand extends AutomationCreateCommand {
  expectedRevision: number
}

export interface AutomationStatusCommand {
  userId: string
  commandId: string
  expectedRevision: number
}

const minimumIntervalSeconds = 60
const maximumIntervalSeconds = 366 * 24 * 60 * 60

export function parseAutomationCreate(value: unknown): AutomationCreateCommand {
  const input = record(value, 'Automation command')
  exactKeys(input, ['userId', 'commandId', 'automation'])
  return {
    userId: requiredString(input.userId, 'userId', 160),
    commandId: requiredString(input.commandId, 'commandId', 160),
    automation: parseAutomationDraft(input.automation),
  }
}

export function parseAutomationUpdate(value: unknown): AutomationUpdateCommand {
  const input = record(value, 'Automation update')
  exactKeys(input, ['userId', 'commandId', 'expectedRevision', 'automation'])
  return {
    userId: requiredString(input.userId, 'userId', 160),
    commandId: requiredString(input.commandId, 'commandId', 160),
    expectedRevision: positiveInteger(
      input.expectedRevision,
      'expectedRevision',
    ),
    automation: parseAutomationDraft(input.automation),
  }
}

export function parseAutomationStatusCommand(
  value: unknown,
): AutomationStatusCommand {
  const input = record(value, 'Automation command')
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

export function parseAutomationDraft(value: unknown): AutomationDraft {
  const input = record(value, 'Automation')
  exactKeys(input, ['title', 'prompt', 'schedule', 'target'])
  return {
    title: requiredString(input.title, 'title', 120),
    prompt: requiredString(input.prompt, 'prompt', 8000),
    schedule: parseSchedule(input.schedule),
    target: parseTarget(input.target),
  }
}

export function automationFingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function firstAutomaticFireAt(
  schedule: AutomationSchedule,
  now: Date,
): string {
  if (schedule.kind === 'once') return schedule.at
  if (schedule.startsAt) return schedule.startsAt
  return new Date(now.getTime() + schedule.everySeconds * 1000).toISOString()
}

export function resumedFireAt(schedule: AutomationSchedule, now: Date): string {
  if (schedule.kind === 'once') {
    return Date.parse(schedule.at) <= now.getTime()
      ? now.toISOString()
      : schedule.at
  }
  return new Date(now.getTime() + schedule.everySeconds * 1000).toISOString()
}

export function nextIntervalFireAt(
  schedule: Extract<AutomationSchedule, { kind: 'interval' }>,
  scheduledFor: string,
  now: Date,
): string {
  const intervalMs = schedule.everySeconds * 1000
  let next = Date.parse(scheduledFor) + intervalMs
  while (next <= now.getTime()) next += intervalMs
  return new Date(next).toISOString()
}

function parseSchedule(value: unknown): AutomationSchedule {
  const input = record(value, 'schedule')
  const kind = requiredString(input.kind, 'schedule.kind', 20)
  if (kind === 'once') {
    exactKeys(input, ['kind', 'at'])
    return { kind, at: isoTimestamp(input.at, 'schedule.at') }
  }
  if (kind === 'interval') {
    exactKeys(input, ['kind', 'everySeconds', 'startsAt'])
    const everySeconds = boundedInteger(
      input.everySeconds,
      'schedule.everySeconds',
      minimumIntervalSeconds,
      maximumIntervalSeconds,
    )
    return {
      kind,
      everySeconds,
      ...(input.startsAt === undefined
        ? {}
        : { startsAt: isoTimestamp(input.startsAt, 'schedule.startsAt') }),
    }
  }
  throw new Error('schedule.kind must be once or interval')
}

function parseTarget(value: unknown): AutomationTarget {
  const input = record(value, 'target')
  const kind = requiredString(input.kind, 'target.kind', 30)
  if (kind === 'new_task') {
    exactKeys(input, ['kind'])
    return { kind }
  }
  if (kind === 'existing_task') {
    exactKeys(input, ['kind', 'taskId'])
    return {
      kind,
      taskId: requiredString(input.taskId, 'target.taskId', 160),
    }
  }
  throw new Error('target.kind must be new_task or existing_task')
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

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${field} is required`)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error(`${field} is invalid`)
  return new Date(milliseconds).toISOString()
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error(`${field} must be a positive integer`)
  return Number(value)
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    throw new Error(
      `${field} must be an integer between ${String(minimum)} and ${String(maximum)}`,
    )
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
