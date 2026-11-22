import type {
  InboxEvent,
  RoutingCandidate,
  RoutingDecision,
  Task,
} from '../core/domain.js'
import type { ExplicitTaskResolver, TaskRouter } from '../router/router.js'
import type { InputRewriter } from './model-input-rewriter.js'

/** Builds an execution view without modifying the canonical Inbox Event. */
export class RewritingTaskRouter implements TaskRouter {
  readonly #router: TaskRouter
  readonly #rewriter: InputRewriter

  constructor(router: TaskRouter, rewriter: InputRewriter) {
    this.#router = router
    this.#rewriter = rewriter
  }

  async route(
    event: InboxEvent,
    tasks: RoutingCandidate[] | Task[],
    context: { resolveExplicitTask?: ExplicitTaskResolver } = {},
  ): Promise<RoutingDecision | undefined> {
    if (event.type !== 'user.message' || !isRecord(event.payload)) {
      return this.#router.route(event, tasks, context)
    }
    const text = event.payload.text
    if (typeof text !== 'string' || !text.trim()) {
      return this.#router.route(event, tasks, context)
    }
    const rewritten = await this.#rewriter.rewrite(text.trim())
    return this.#router.route(
      {
        ...event,
        payload: { ...event.payload, text: rewritten },
      },
      tasks,
      context,
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
