import type { ClaimedRun, InboxEvent } from '../core/domain.js'
import type { RunExecutor } from '../executor/executor.js'
import type { TaskRouter } from '../router/router.js'
import type { PegasStore } from '../storage/sqlite-store.js'

export interface EventHandler {
  handle(event: InboxEvent, store: PegasStore): Promise<void>
}

export class RoutingEventHandler implements EventHandler {
  readonly #router: TaskRouter
  readonly #executorName: string

  constructor(router: TaskRouter, executorName: string) {
    this.#router = router
    this.#executorName = executorName
  }

  async handle(event: InboxEvent, store: PegasStore): Promise<void> {
    const decision = await this.#router.route(
      event,
      store.listTasks(event.userId),
    )
    if (decision)
      store.applyRoutingDecision(event, decision, this.#executorName)
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
  const leaseHeartbeat = setInterval(() => {
    try {
      store.renewRunLease(claimed.run.id, workerId)
    } catch (error) {
      console.error(`Failed to renew run ${claimed.run.id} lease`, error)
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
      signal,
    })
  } catch (error) {
    clearInterval(leaseHeartbeat)
    const message = error instanceof Error ? error.message : String(error)
    store.failRun(claimed.run.id, workerId, message)
    return
  }

  clearInterval(leaseHeartbeat)
  store.completeRun(claimed.run.id, workerId, result)
}
