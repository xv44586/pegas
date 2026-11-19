import type {
  ClaimedRun,
  ExecutionContext,
  InboxEvent,
} from '../core/domain.js'
import type { RunExecutor } from '../executor/executor.js'
import type { TaskRouter } from '../router/router.js'
import type { PegasStore } from '../storage/sqlite-store.js'

export interface EventHandler {
  handle(event: InboxEvent, store: PegasStore): Promise<void>
}

export class RoutingEventHandler implements EventHandler {
  readonly #router: TaskRouter
  readonly #executorName: string
  readonly #executionContext: () => ExecutionContext

  constructor(
    router: TaskRouter,
    executorName: string,
    executionContext: () => ExecutionContext = () => ({
      executor: executorName,
    }),
  ) {
    this.#router = router
    this.#executorName = executorName
    this.#executionContext = executionContext
  }

  async handle(event: InboxEvent, store: PegasStore): Promise<void> {
    const decision = await this.#router.route(
      event,
      store.listTasks(event.userId),
    )
    if (!decision) return
    store.applyRoutingDecision(
      event,
      decision,
      this.#executorName,
      this.#executionContext(),
    )
  }
}

export async function processNextEvent(
  store: PegasStore,
  handler: EventHandler,
  workerId: string,
): Promise<boolean> {
  const event = store.claimNextEvent(workerId)
  if (!event) return false

  try {
    await handler.handle(event, store)
    store.completeEvent(event.id, workerId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    store.failEvent(event.id, workerId, message)
  }
  return true
}

export async function executeClaimedRun(
  store: PegasStore,
  executor: RunExecutor,
  claimed: ClaimedRun,
  workerId: string,
  workingDirectory: string,
  signal: AbortSignal,
): Promise<void> {
  const runAbort = new AbortController()
  const abortRun = () => runAbort.abort(signal.reason)
  if (signal.aborted) abortRun()
  else signal.addEventListener('abort', abortRun, { once: true })
  const leaseHeartbeat = setInterval(() => {
    try {
      store.renewRunLease(claimed.run.id, workerId)
    } catch (error) {
      console.error(`Failed to renew run ${claimed.run.id} lease`, error)
      runAbort.abort(error)
    }
  }, 10_000)
  leaseHeartbeat.unref()

  let result
  try {
    result = await executor.execute({
      runId: claimed.run.id,
      taskId: claimed.task.id,
      prompt: claimed.run.input,
      workingDirectory,
      ...(claimed.run.executorRef || claimed.run.resumeFromRef
        ? {
            resumeSessionId:
              claimed.run.executorRef ?? claimed.run.resumeFromRef,
          }
        : {}),
      onExecutorRef: executorRef => {
        store.recordExecutorRef(claimed.run.id, workerId, executorRef)
      },
      onProgress: event => {
        if (!store.ownsRun(claimed.run.id, workerId)) return
        store.enqueueOutbox({
          userId: claimed.task.userId,
          taskId: claimed.task.id,
          channel: 'conversation',
          dedupeKey: `run-acknowledged:${claimed.run.id}`,
          payload: {
            type: 'run.acknowledged',
            taskId: claimed.task.id,
            runId: claimed.run.id,
            text: event.text,
          },
        })
      },
      signal: runAbort.signal,
    })
  } catch (error) {
    clearInterval(leaseHeartbeat)
    signal.removeEventListener('abort', abortRun)
    // A Worker Runtime is replaceable. Preserve its durable Run and lease so
    // another runtime can recover it through the existing lease-expiry path.
    if (signal.aborted) return
    if (!store.ownsRun(claimed.run.id, workerId)) return
    const message = error instanceof Error ? error.message : String(error)
    store.failRun(claimed.run.id, workerId, message)
    return
  }

  clearInterval(leaseHeartbeat)
  signal.removeEventListener('abort', abortRun)
  if (!store.ownsRun(claimed.run.id, workerId)) return
  store.completeRun(claimed.run.id, workerId, result)
}
