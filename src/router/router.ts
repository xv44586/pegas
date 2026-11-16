import type { InboxEvent, RoutingDecision, Task } from '../core/domain.js'

export interface TaskRouter {
  route(event: InboxEvent, tasks: Task[]): Promise<RoutingDecision | undefined>
}

/**
 * Deterministic first-pass routing. Explicit task references are honored and
 * every other user message becomes a new task. A model router can replace this
 * without changing the durable decision contract.
 */
export class RuleBasedTaskRouter implements TaskRouter {
  route(
    event: InboxEvent,
    tasks: Task[],
  ): Promise<RoutingDecision | undefined> {
    if (event.type !== 'user.message') return Promise.resolve(undefined)
    const payload = messagePayload(event.payload)
    const explicitTask = payload.taskId
      ? tasks.find(task => task.id === payload.taskId)
      : undefined

    if (payload.taskId && !explicitTask) {
      throw new Error(
        `Task ${payload.taskId} does not exist for user ${event.userId}`,
      )
    }

    if (explicitTask) {
      return Promise.resolve({
        kind: 'continue_task',
        taskId: explicitTask.id,
        input: payload.text,
        reason: 'The message explicitly references an existing task.',
      })
    }

    return Promise.resolve({
      kind: 'create_task',
      title: titleFromText(payload.text),
      goal: payload.text,
      input: payload.text,
      reason: 'No existing task was explicitly referenced.',
    })
  }
}

interface MessagePayload {
  text: string
  taskId?: string
}

function messagePayload(value: unknown): MessagePayload {
  if (
    !isRecord(value) ||
    typeof value.text !== 'string' ||
    !value.text.trim()
  ) {
    throw new Error('user.message payload requires non-empty text')
  }
  const taskId = value.taskId
  if (taskId !== undefined && (typeof taskId !== 'string' || !taskId.trim())) {
    throw new Error('taskId must be a non-empty string')
  }
  return {
    text: value.text.trim(),
    ...(typeof taskId === 'string' ? { taskId } : {}),
  }
}

function titleFromText(text: string): string {
  return text.trim().replaceAll(/\s+/g, ' ').slice(0, 120)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
