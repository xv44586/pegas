import type {
  ClaimedRun,
  ExecutionContext,
  InboxEvent,
} from '../core/domain.js'
import type { RunExecutor } from '../executor/executor.js'
import type { TaskRouter } from '../router/router.js'
import {
  TaskActionBlockedError,
  type PegasStore,
} from '../storage/sqlite-store.js'

export interface EventHandler {
  handle(event: InboxEvent, store: PegasStore): Promise<void>
}

export function localControlPlaneBaseUrl(host: string, port: number): string {
  if (host === '0.0.0.0') return `http://127.0.0.1:${String(port)}`
  if (host === '::') return `http://[::1]:${String(port)}`
  if (host === '127.0.0.1' || host === 'localhost')
    return `http://${host}:${String(port)}`
  if (host === '::1') return `http://[::1]:${String(port)}`
  throw new Error(
    'Run claim capability requires a loopback transport; bind PEGAS_API_HOST to a loopback or wildcard address',
  )
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
    if (event.type === 'approval.decided') {
      store.applyApprovalDecision(event)
      return
    }
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
    if (error instanceof TaskActionBlockedError) {
      store.parkEventForBlockedAction(event.id, workerId, error.taskId)
      return true
    }
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
  controlPlaneBaseUrl: string,
): Promise<void> {
  if (claimed.phase === 'report') {
    const goalRevision = claimed.run.goalRevision
    if (goalRevision === undefined) return
    const reports = store.listWorkerReports(claimed.run.id, claimed.task.userId)
    const reportSequence =
      reports.reduce(
        (maximum, report) => Math.max(maximum, report.reportSequence),
        -1,
      ) + 1
    const evidenceRefIds = store
      .listEvidenceRefs(claimed.task.id, claimed.task.userId, goalRevision)
      .filter(evidence => evidence.runId === claimed.run.id)
      .map(evidence => evidence.id)
    store.submitWorkerReport(claimed.run.id, claimed.task.userId, workerId, {
      goalRevision,
      reportSequence,
      status: 'ready',
      evidenceRefIds,
      summary: claimed.run.output ?? 'Evidence review resumed.',
      limitations: [],
      remainingRisks:
        evidenceRefIds.length === 0
          ? ['Required evidence has not been captured yet.']
          : [],
    })
    return
  }
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
      actionCapability: {
        baseUrl: controlPlaneBaseUrl,
        claimToken: claimed.claimToken,
      },
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
  const persistedRun = store
    .listRuns(claimed.task.id)
    .find(run => run.id === claimed.run.id)
  if (
    persistedRun?.goalRevision !== undefined &&
    persistedRun.status === 'waiting' &&
    persistedRun.claimedBy === workerId
  ) {
    const evidenceRefIds = store
      .listEvidenceRefs(
        claimed.task.id,
        claimed.task.userId,
        persistedRun.goalRevision,
      )
      .filter(evidence => evidence.runId === claimed.run.id)
      .map(evidence => evidence.id)
    store.submitWorkerReport(claimed.run.id, claimed.task.userId, workerId, {
      goalRevision: persistedRun.goalRevision,
      reportSequence: 0,
      status: 'ready',
      evidenceRefIds,
      summary: result.output,
      limitations:
        evidenceRefIds.length === 0
          ? ['No structured evidence references were produced.']
          : [],
      remainingRisks: [
        ...(evidenceRefIds.length === 0
          ? [
              'The Goal remains open until required evidence is captured and verified.',
            ]
          : []),
      ],
    })
  }
}
