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
    if (!decision) return
    const { task, run } = store.applyRoutingDecision(
      event,
      decision,
      this.#executorName,
    )
    store.enqueueOutbox({
      userId: event.userId,
      taskId: task.id,
      channel: 'conversation',
      dedupeKey: `run-started:${run.id}`,
      payload: {
        type:
          decision.kind === 'create_task' ? 'task.started' : 'task.continued',
        taskId: task.id,
        runId: run.id,
        text:
          decision.kind === 'create_task'
            ? `我已经把这件事整理为任务「${task.title}」，现在开始处理。`
            : `收到，我会把这条补充到任务「${task.title}」并继续处理。`,
      },
    })
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
