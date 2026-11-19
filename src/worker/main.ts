import { randomUUID } from 'node:crypto'

import { loadConfig } from '../core/config.js'
import { DshCliExecutor } from '../executor/dsh-cli-executor.js'
import { EchoExecutor } from '../executor/echo-executor.js'
import type { RunExecutor } from '../executor/executor.js'
import { loadModelCredentialVault } from '../model/model-credential-vault.js'
import {
  createConfiguredModelProvider,
  createRewriteModelProvider,
  initializeConfiguredModelProvider,
} from '../model/provider-factory.js'
import type { JsonModelProvider } from '../model/provider.js'
import { PrivacyMaskingExecutor } from '../privacy/executor.js'
import { DeterministicPrivacyMasker } from '../privacy/masker.js'
import { PrivacyMaskingProvider } from '../privacy/provider.js'
import { ModelInputRewriter } from '../rewrite/model-input-rewriter.js'
import { RewritingTaskRouter } from '../rewrite/rewriting-router.js'
import {
  ModelTaskRouter,
  RuleBasedTaskRouter,
  type TaskRouter,
} from '../router/router.js'
import {
  assertRuntimeSettingsAvailable,
  runtimeSettingsDefaults,
  settingsCapabilities,
  type RuntimeSettings,
} from '../settings/runtime-settings.js'
import {
  SettingsAwareExecutor,
  SettingsAwareTaskRouter,
} from '../settings/settings-aware-runtime.js'
import { PegasStore } from '../storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from './processor.js'

const config = loadConfig()
const store = new PegasStore(config.databasePath)
const modelCredentialVault = loadModelCredentialVault(
  config.modelCredentialKeyPath,
)
initializeConfiguredModelProvider(store, config, modelCredentialVault)
const defaults = runtimeSettingsDefaults(config)
if (!store.hasRuntimeSettings()) {
  assertRuntimeSettingsAvailable(
    defaults,
    settingsCapabilities(config, store.listModelProviderConnectionSummaries()),
  )
}
store.initializeRuntimeSettings(defaults)
const workerId = `worker-${randomUUID()}`
const baseExecutor: RunExecutor =
  config.executorMode === 'echo'
    ? new EchoExecutor()
    : new DshCliExecutor({
        command: config.dshCommand,
        profile: config.dshProfile,
        additionalDirectories: config.dshAdditionalDirectories,
        timeoutMs: config.dshTimeoutMs,
      })
const executor = new SettingsAwareExecutor(
  store,
  baseExecutor.name,
  createExecutor,
)
const router = new SettingsAwareTaskRouter(store, createRouter)
const eventHandler = new RoutingEventHandler(router, executor.name, () => {
  const settings = store.getRuntimeSettings()
  return {
    executor: executor.name,
    workspace: config.workspaceRoot,
    model:
      settings.agentModelMode === 'override'
        ? `${settings.agentModelProvider}/${settings.agentModelName}`
        : 'profile',
    permissions: JSON.stringify({
      mode: 'workspace-write',
      additionalDirectories: config.dshAdditionalDirectories,
      privacyMode: settings.privacyMode,
    }),
    protocol: 'dsh-headless-v1',
    settingsRevision: settings.revision,
  }
})
const lifecycle = { stopping: false }
const shutdown = new AbortController()
const activeRuns = new Set<Promise<void>>()

process.on('SIGINT', requestStop)
process.on('SIGTERM', requestStop)

console.log(`Pegas worker ${workerId} started with ${baseExecutor.name}`)

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

function createRouter(settings: RuntimeSettings): TaskRouter {
  let provider: JsonModelProvider | undefined
  const baseRouter: TaskRouter =
    settings.routerMode === 'model'
      ? new ModelTaskRouter({
          provider: (provider = createModelProvider(settings)),
        })
      : new RuleBasedTaskRouter()
  if (settings.rewriteMode === 'disabled') return baseRouter
  const rewriteConnection = store.getRewriteConnection()
  if (rewriteConnection.mode === 'custom') {
    const independent = createRewriteModelProvider(
      rewriteConnection,
      modelCredentialVault,
      config.modelTimeoutMs,
    )
    provider =
      settings.privacyMode === 'mask'
        ? new PrivacyMaskingProvider(independent, createPrivacyMasker())
        : independent
  } else {
    provider ??= createModelProvider(settings)
  }
  return new RewritingTaskRouter(baseRouter, new ModelInputRewriter(provider))
}

function createExecutor(settings: RuntimeSettings): RunExecutor {
  const runtimeExecutor =
    config.executorMode === 'echo'
      ? baseExecutor
      : new DshCliExecutor({
          command: config.dshCommand,
          profile: config.dshProfile,
          additionalDirectories: config.dshAdditionalDirectories,
          timeoutMs: config.dshTimeoutMs,
          ...(settings.agentModelMode === 'override'
            ? {
                agentModel: {
                  provider: settings.agentModelProvider,
                  model: settings.agentModelName,
                },
              }
            : {}),
        })
  if (settings.privacyMode === 'disabled') return runtimeExecutor
  return new PrivacyMaskingExecutor(runtimeExecutor, createPrivacyMasker())
}

function createModelProvider(settings: RuntimeSettings): JsonModelProvider {
  const provider = createConfiguredModelProvider(
    settings,
    store,
    modelCredentialVault,
    config.modelTimeoutMs,
  )
  return settings.privacyMode === 'mask'
    ? new PrivacyMaskingProvider(provider, createPrivacyMasker())
    : provider
}

function createPrivacyMasker(): DeterministicPrivacyMasker {
  return new DeterministicPrivacyMasker({
    hmacKey: required(config.privacyHmacKey, 'privacy HMAC key'),
  })
}
