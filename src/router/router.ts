import type { InboxEvent, RoutingDecision, Task } from '../core/domain.js'
import type { JsonModelProvider } from '../model/provider.js'

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

export interface ModelTaskRouterOptions {
  provider: JsonModelProvider
  fallback?: TaskRouter
  maximumCandidateTasks?: number
}

/**
 * Uses a model only for ambiguous task ownership. Explicit references and
 * zero-task conversations stay deterministic, and every invalid model answer
 * falls back to the rule router instead of blocking the event stream.
 */
export class ModelTaskRouter implements TaskRouter {
  readonly #provider: JsonModelProvider
  readonly #fallback: TaskRouter
  readonly #maximumCandidateTasks: number

  constructor(options: ModelTaskRouterOptions) {
    this.#provider = options.provider
    this.#fallback = options.fallback ?? new RuleBasedTaskRouter()
    this.#maximumCandidateTasks = options.maximumCandidateTasks ?? 20
  }

  async route(
    event: InboxEvent,
    tasks: Task[],
  ): Promise<RoutingDecision | undefined> {
    if (event.type !== 'user.message') return undefined
    const payload = messagePayload(event.payload)
    if (payload.taskId) return this.#fallback.route(event, tasks)

    const candidates = tasks
      .filter(task => !['completed', 'cancelled'].includes(task.status))
      .slice(0, this.#maximumCandidateTasks)
    if (candidates.length === 0) return this.#fallback.route(event, tasks)

    try {
      const answer = await this.#provider.generateJson({
        system: routerSystemPrompt,
        input: JSON.stringify({
          message: payload.text,
          tasks: candidates.map(task => ({
            id: task.id,
            title: task.title,
            goal: task.goal,
            status: task.status,
            statusReason: task.statusReason ?? null,
          })),
        }),
      })
      return modelDecision(answer, payload.text, candidates)
    } catch {
      return this.#fallback.route(event, tasks)
    }
  }
}

const routerSystemPrompt = `You route one user message into durable personal-agent tasks.
Return one JSON object only.
If the message clearly continues exactly one listed task, return:
{"kind":"continue_task","taskId":"listed id","reason":"short reason"}
Otherwise return:
{"kind":"create_task","title":"concise title","goal":"complete user goal","reason":"short reason"}
Never invent a task id. Prefer create_task when uncertain or when the message introduces an independent idea.`

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

function modelDecision(
  value: unknown,
  input: string,
  candidates: Task[],
): RoutingDecision {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('Router model returned an invalid decision')
  }
  const reason = requiredString(value.reason, 'reason')
  if (value.kind === 'continue_task') {
    const taskId = requiredString(value.taskId, 'taskId')
    if (!candidates.some(task => task.id === taskId)) {
      throw new Error('Router model selected an unknown task')
    }
    return { kind: 'continue_task', taskId, input, reason }
  }
  if (value.kind === 'create_task') {
    const title = titleFromText(requiredString(value.title, 'title'))
    const goal = requiredString(value.goal, 'goal').slice(0, 4000)
    return { kind: 'create_task', title, goal, input, reason }
  }
  throw new Error('Router model returned an unsupported decision')
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Router model requires ${name}`)
  }
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
