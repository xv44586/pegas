import { randomUUID } from 'node:crypto'

import { loadConfig } from '../core/config.js'
import { DshCliExecutor } from '../executor/dsh-cli-executor.js'
import { EchoExecutor } from '../executor/echo-executor.js'
import type { RunExecutor } from '../executor/executor.js'
import { CodexCliProvider } from '../model/codex-cli-provider.js'
import { OpenAiCompatibleProvider } from '../model/openai-compatible-provider.js'
import type { JsonModelProvider } from '../model/provider.js'
import { PrivacyMaskingExecutor } from '../privacy/executor.js'
import { DeterministicPrivacyMasker } from '../privacy/masker.js'
import { PrivacyMaskingProvider } from '../privacy/provider.js'
import {
  ModelTaskRouter,
  RuleBasedTaskRouter,
  type TaskRouter,
} from '../router/router.js'
import { PegasStore } from '../storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from './processor.js'

const config = loadConfig()
const store = new PegasStore(config.databasePath)
const workerId = `worker-${randomUUID()}`
const privacyMasker =
  config.privacyMode === 'mask'
    ? new DeterministicPrivacyMasker({
        hmacKey: required(config.privacyHmacKey, 'privacy HMAC key'),
      })
    : undefined
const baseExecutor: RunExecutor =
  config.executorMode === 'echo'
    ? new EchoExecutor()
    : new DshCliExecutor({
        command: config.dshCommand,
        profile: config.dshProfile,
        additionalDirectories: config.dshAdditionalDirectories,
        timeoutMs: config.dshTimeoutMs,
      })
const executor: RunExecutor = privacyMasker
  ? new PrivacyMaskingExecutor(baseExecutor, privacyMasker)
  : baseExecutor
const router: TaskRouter =
  config.routerMode === 'model'
    ? new ModelTaskRouter({
        provider: createModelProvider(),
      })
    : new RuleBasedTaskRouter()
const eventHandler = new RoutingEventHandler(router, executor.name)
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

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function createModelProvider(): JsonModelProvider {
  let provider: JsonModelProvider
  if (config.modelProvider === 'codex-cli') {
    provider = new CodexCliProvider({
      command: config.codexCommand,
      model: required(config.modelName, 'model name'),
      timeoutMs: config.modelTimeoutMs,
    })
  } else {
    provider = new OpenAiCompatibleProvider({
      baseUrl: required(config.modelBaseUrl, 'model base URL'),
      model: required(config.modelName, 'model name'),
      ...(config.modelApiKey ? { apiKey: config.modelApiKey } : {}),
      timeoutMs: config.modelTimeoutMs,
    })
  }
  return privacyMasker
    ? new PrivacyMaskingProvider(provider, privacyMasker)
    : provider
}
