import { randomUUID } from 'node:crypto'

import { loadConfig } from '../core/config.js'
import { DshCliExecutor } from '../executor/dsh-cli-executor.js'
import { EchoExecutor } from '../executor/echo-executor.js'
import type { RunExecutor } from '../executor/executor.js'
import { RuleBasedTaskRouter } from '../router/router.js'
import { PegasStore } from '../storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from './processor.js'

const config = loadConfig()
const store = new PegasStore(config.databasePath)
const workerId = `worker-${randomUUID()}`
const executor: RunExecutor =
  config.executorMode === 'echo'
    ? new EchoExecutor()
    : new DshCliExecutor({ command: config.dshCommand })
const eventHandler = new RoutingEventHandler(
  new RuleBasedTaskRouter(),
  executor.name,
)
const lifecycle = { stopping: false }
const shutdown = new AbortController()
const activeRuns = new Set<Promise<void>>()

process.on('SIGINT', requestStop)
process.on('SIGTERM', requestStop)

console.log(`Pegas worker ${workerId} started with ${executor.name}`)

while (!lifecycle.stopping) {
  const routed = await processNextEvent(store, eventHandler, workerId)

  // The signal callback may change stopping while a run is being awaited.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (!lifecycle.stopping && activeRuns.size < config.workerConcurrency) {
    const claimed = store.claimNextRun(workerId)
    if (!claimed) break
    const execution = executeClaimedRun(
      store,
      executor,
      claimed,
      workerId,
      config.workspaceRoot,
      shutdown.signal,
    )
      .catch((error: unknown) => {
        console.error(`Run ${claimed.run.id} persistence failed`, error)
      })
      .finally(() => activeRuns.delete(execution))
    activeRuns.add(execution)
  }

  if (!routed) await wait(config.eventPollMs)
}

await Promise.allSettled(activeRuns)
store.close()

function requestStop(): void {
  lifecycle.stopping = true
  shutdown.abort()
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
