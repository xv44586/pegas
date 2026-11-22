import { randomUUID } from 'node:crypto'

import { loadConfig } from '../core/config.js'
import { DshCliExecutor } from '../executor/dsh-cli-executor.js'
import {
  createDshModelConfiguration,
  ensureDshProfileHome,
} from '../executor/dsh-home.js'
import { EchoExecutor } from '../executor/echo-executor.js'
import type {
  ExecutorInput,
  ExecutorResult,
  RunExecutor,
} from '../executor/executor.js'
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
import { createLogger } from '../observability/logger.js'
import { MetricsRegistry } from '../observability/metrics.js'
import { SelfChangeExecutor } from '../self-change/self-change-executor.js'
import { SelfChangeRoutingExecutor } from '../self-change/routing-executor.js'
import {
  executeClaimedRun,
  localControlPlaneBaseUrl,
  processNextEvent,
  RoutingEventHandler,
} from './processor.js'
import {
  decodeDshExecutionSnapshot,
  dshExecutorOptionsFromSnapshot,
} from './run-execution-snapshot.js'

const config = loadConfig()

class ManagedDshExecutor implements RunExecutor {
  readonly name: string
  readonly #inner: RunExecutor
  readonly #configuration: { remove: () => void }

  constructor(inner: RunExecutor, configuration: { remove: () => void }) {
    this.name = inner.name
    this.#inner = inner
    this.#configuration = configuration
  }

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    try {
      return await this.#inner.execute(input)
    } finally {
      this.#configuration.remove()
    }
  }
}

const logger = createLogger({ service: 'worker' })
const metrics = new MetricsRegistry()
const telemetry = { logger, metrics }
const controlPlaneBaseUrl = localControlPlaneBaseUrl(
  config.apiHost,
  config.apiPort,
)
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
if (config.executorMode !== 'echo') {
  ensureDshProfileHome(config.dshHome, config.dshProfile)
}
const workerId = `worker-${randomUUID()}`
const baseExecutor: RunExecutor =
  config.executorMode === 'echo'
    ? new EchoExecutor()
    : new DshCliExecutor({
        command: config.dshCommand,
        profile: config.dshProfile,
        home: config.dshHome,
        additionalDirectories: config.dshAdditionalDirectories,
        timeoutMs: config.dshTimeoutMs,
      })
const executor = new SettingsAwareExecutor(
  store,
  baseExecutor.name,
  createExecutor,
)
const selfChangeExecutor = config.selfChangeEnabled
  ? new SelfChangeExecutor({
      repositoryRoot: config.selfChangeRepositoryRoot,
      selfChangeRoot: config.selfChangeRoot,
      recoveryBaseUrl: config.recoveryBaseUrl,
      ...(config.recoveryToken ? { recoveryToken: config.recoveryToken } : {}),
      editor: executor,
      compatibility: { minimumSchema: 1, maximumSchema: 31 },
      reviewer: 'pegas-self-change-gate',
      controlPlaneBaseUrl,
    })
  : undefined
const runExecutor: RunExecutor = selfChangeExecutor
  ? new SelfChangeRoutingExecutor(store, executor, selfChangeExecutor)
  : executor
const router = new SettingsAwareTaskRouter(store, createRouter)
const eventHandler = new RoutingEventHandler(router, executor.name, task => {
  const settings = store.getRuntimeSettings()
  return store.resolveWorkerExecutionContext(task.id, task.userId, {
    executor: executor.name,
    executorProfile: config.dshProfile,
    workspace: config.workspaceRoot,
    nodeId: config.nodeId,
    permissions: JSON.stringify({
      mode: 'workspace-write',
      approvalPolicy: 'ask',
      additionalDirectories: config.dshAdditionalDirectories,
      privacyMode: settings.privacyMode,
    }),
    protocol: config.executorMode === 'echo' ? 'echo-v1' : 'dsh-headless-v1',
  })
})
const lifecycle = { stopping: false }
const shutdown = new AbortController()
const activeRuns = new Set<Promise<void>>()

const nodeCapabilities = [
  'dsh',
  ...(config.selfChangeEnabled ? ['self-change'] : []),
]
store.registerExecutionNode({
  id: config.nodeId,
  label: config.nodeLabel,
  capabilities: nodeCapabilities,
})
const nodeHeartbeat = setInterval(() => {
  try {
    store.registerExecutionNode({
      id: config.nodeId,
      label: config.nodeLabel,
      capabilities: nodeCapabilities,
    })
  } catch (error) {
    logger.error('node.heartbeat_failed', error, { nodeId: config.nodeId })
    metrics.increment('pegas_errors_total', {
      component: 'worker',
      kind: 'node_heartbeat',
    })
  }
}, 30_000)
nodeHeartbeat.unref()

process.on('SIGINT', requestStop)
process.on('SIGTERM', requestStop)

logger.info('service.started', {
  workerId,
  executor: baseExecutor.name,
  message: `Pegas worker ${workerId} started with ${baseExecutor.name}`,
})

while (!lifecycle.stopping) {
  const routed = await processNextEvent(
    store,
    eventHandler,
    workerId,
    telemetry,
  )

  // The signal callback may change stopping while a run is being awaited.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (!lifecycle.stopping && activeRuns.size < config.workerConcurrency) {
    const claimed = store.claimNextRun(workerId, 30_000, config.nodeId)
    if (!claimed) break
    const execution = executeClaimedRun(
      store,
      runExecutor,
      claimed,
      workerId,
      config.workspaceRoot,
      shutdown.signal,
      controlPlaneBaseUrl,
      telemetry,
    )
      .catch((error: unknown) => {
        logger.error('run.persistence_failed', error, {
          runId: claimed.run.id,
          workerId,
        })
        metrics.increment('pegas_errors_total', {
          component: 'worker',
          kind: 'run_persistence',
        })
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
  clearInterval(nodeHeartbeat)
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

function createExecutor(
  settings: RuntimeSettings,
  input?: ExecutorInput,
): RunExecutor {
  const defaults = {
    executorProfile: config.dshProfile,
    workspace: config.workspaceRoot,
    permissionMode: 'workspace-write',
    approvalPolicy: 'ask' as const,
    additionalDirectories: config.dshAdditionalDirectories,
    privacyMode: settings.privacyMode,
  }
  let privacyMode = settings.privacyMode
  let runtimeExecutor = baseExecutor
  if (config.executorMode !== 'echo') {
    const snapshot = decodeDshExecutionSnapshot(input ?? {}, defaults)
    privacyMode = snapshot.privacyMode
    const agentModel = snapshot.agentModel ?? {
      provider: settings.modelProvider,
      model: settings.modelName,
    }
    const modelConfiguration = createDshModelConfiguration({
      connections: store.listModelProviderConnections(),
      vault: modelCredentialVault,
      agentModel,
    })
    runtimeExecutor = new ManagedDshExecutor(
      new DshCliExecutor(
        dshExecutorOptionsFromSnapshot(snapshot, {
          command: config.dshCommand,
          timeoutMs: config.dshTimeoutMs,
          home: config.dshHome,
          modelConfiguration,
        }),
      ),
      modelConfiguration,
    )
  }
  if (privacyMode === 'disabled') return runtimeExecutor
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
