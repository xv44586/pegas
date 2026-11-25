import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'

import { loadConfig } from '../core/config.js'
import type { InboxEvent } from '../core/domain.js'
import { tierSandbox } from '../approval/permission-profile.js'
import { ModelThinkingSummarizer } from '../activity/thinking-summary.js'
import { ConversationExecutor } from '../executor/conversation-executor.js'
import { DshCliExecutor } from '../executor/dsh-cli-executor.js'
import {
  readDshRootToolOutcomes,
  readDshSubagentTranscripts,
} from '../executor/dsh-subagent-transcript.js'
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
import { PegasDerivedMemoryService } from '../memory/derived-memory.js'
import { HindsightProvider } from '../memory/hindsight-provider.js'
import { LocalDerivedMemoryProvider } from '../memory/local-provider.js'
import { createLocalMemoryDistiller } from '../memory/local-distiller.js'
import { loadMemoryKey } from '../memory/memory-key.js'
import { MeteredJsonModelProvider } from '../model/metered-provider.js'
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
  backfillThinkingSummaries,
  executeClaimedRun,
  localControlPlaneBaseUrl,
  processNextEvent,
  processNextDerivedMemoryJob,
  processNextDerivedMemoryCurationJob,
  processNextDerivedMemoryCorrectionJob,
  synchronizeDerivedMemories,
  RoutingEventHandler,
  type RootToolOutcomeCollector,
  type SubagentTranscriptCollector,
  type ThinkingSummarizerFactory,
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
const store = new PegasStore(config.databasePath, {
  routingClarificationTtlMs: config.routingClarificationTtlMs,
  derivedMemoryEnabled: config.memoryProvider !== 'disabled',
  defaultWorkspaceRoot: config.workspaceRoot,
})
const lifecycle = { stopping: false }
const shutdown = new AbortController()
const modelCredentialVault = loadModelCredentialVault(
  config.modelCredentialKeyPath,
)
const derivedMemory = createDerivedMemoryService()

function createDerivedMemoryService(): PegasDerivedMemoryService | undefined {
  if (config.memoryProvider === 'disabled') return undefined
  if (config.memoryProvider === 'hindsight') {
    return new PegasDerivedMemoryService(
      new HindsightProvider({
        baseUrl: required(config.hindsightBaseUrl, 'PEGAS_HINDSIGHT_BASE_URL'),
        ...(config.hindsightApiKey ? { apiKey: config.hindsightApiKey } : {}),
        timeoutMs: config.hindsightTimeoutMs,
        shutdownSignal: shutdown.signal,
      }),
      {
        hmacKey: required(config.memoryHmacKey, 'PEGAS_MEMORY_HMAC_KEY'),
        globalPreferences: userId => store.workRuleContextForUser(userId),
      },
    )
  }
  const hmacKey = loadMemoryKey(config.memoryKeyPath, config.memoryHmacKey)
  return new PegasDerivedMemoryService(
    new LocalDerivedMemoryProvider(store, {
      hmacKey,
      distill: createLocalMemoryDistiller(memoryDistillProvider()),
    }),
    {
      hmacKey,
      providerName: 'local',
      globalPreferences: userId => store.workRuleContextForUser(userId),
    },
  )
}

/**
 * One bounded distillation call per retain job through the configured
 * control-plane model, metered as the `memory` component (USAGE-001 sibling
 * ledger). MODEL-001 retry/backoff applies inside the provider.
 */
function memoryDistillProvider(): MeteredJsonModelProvider {
  const lazy: JsonModelProvider = {
    name: 'configured-memory',
    generateJson: request =>
      createModelProvider(store.getRuntimeSettings()).generateJson(request),
    generateJsonWithUsage: async request => {
      const provider = createModelProvider(store.getRuntimeSettings())
      return provider.generateJsonWithUsage
        ? provider.generateJsonWithUsage(request)
        : { value: await provider.generateJson(request) }
    },
  }
  return new MeteredJsonModelProvider(lazy, store, 'memory', () => {
    const settings = store.getRuntimeSettings()
    return {
      userId: 'system:memory',
      modelRef: `${settings.modelProvider}/${settings.modelName}`,
    }
  })
}
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
mkdirSync(config.workspaceRoot, { recursive: true })
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
      compatibility: { minimumSchema: 1, maximumSchema: 55 },
      reviewer: 'pegas-self-change-gate',
      controlPlaneBaseUrl,
    })
  : undefined
const runExecutor: RunExecutor = selfChangeExecutor
  ? new SelfChangeRoutingExecutor(store, executor, selfChangeExecutor)
  : executor
const conversationExecutor = new ConversationExecutor(executor)
const laneExecutor: RunExecutor = {
  name: runExecutor.name,
  execute: input =>
    input.executionContext?.protocol === 'conversation-v1'
      ? conversationExecutor.execute(input)
      : runExecutor.execute(input),
}
const collectSubagents: SubagentTranscriptCollector | undefined =
  config.executorMode === 'echo'
    ? undefined
    : input => {
        const settings = store.getRuntimeSettings()
        const masker =
          settings.privacyMode === 'mask' ? createPrivacyMasker() : undefined
        return readDshSubagentTranscripts(
          input.rootSessionId,
          input.workspace,
          {
            sessionsRoot: config.dshSessionsRoot,
            ...(masker ? { restore: text => masker.restore(text) } : {}),
          },
        )
      }
const collectRootOutcomes: RootToolOutcomeCollector | undefined =
  config.executorMode === 'echo'
    ? undefined
    : input => {
        const settings = store.getRuntimeSettings()
        const masker =
          settings.privacyMode === 'mask' ? createPrivacyMasker() : undefined
        return readDshRootToolOutcomes(input.rootSessionId, input.workspace, {
          sessionsRoot: config.dshSessionsRoot,
          ...(masker ? { restore: text => masker.restore(text) } : {}),
        })
      }
const settingsRouter = new SettingsAwareTaskRouter(store, createRouter)
const router: TaskRouter = settingsRouter
const lazySummaryProvider: JsonModelProvider = {
  name: 'configured-summary',
  generateJson: request =>
    createModelProvider(store.getRuntimeSettings()).generateJson(request),
  generateJsonWithUsage: async request => {
    const provider = createModelProvider(store.getRuntimeSettings())
    return provider.generateJsonWithUsage
      ? provider.generateJsonWithUsage(request)
      : { value: await provider.generateJson(request) }
  },
}
const createThinkingSummarizer: ThinkingSummarizerFactory = context =>
  new ModelThinkingSummarizer(
    new MeteredJsonModelProvider(lazySummaryProvider, store, 'summary', () => {
      const settings = store.getRuntimeSettings()
      return {
        userId: context.userId,
        eventId: `thinking:${context.runId}:${context.sessionId ?? 'root'}:${String(context.seq)}`,
        modelRef: `${settings.modelProvider}/${settings.modelName}`,
      }
    }),
  )
const eventHandler = new RoutingEventHandler(router, executor.name, task => {
  const settings = store.getRuntimeSettings()
  const tier = store.getEffectiveWorkerProfile(
    task.id,
    task.userId,
  ).permissionTier
  return store.resolveWorkerExecutionContext(task.id, task.userId, {
    executor: executor.name,
    executorProfile: config.dshProfile,
    workspace: config.workspaceRoot,
    nodeId: config.nodeId,
    permissions: JSON.stringify({
      mode: tierSandbox(tier).mode,
      approvalPolicy: 'ask',
      additionalDirectories: config.dshAdditionalDirectories,
      privacyMode: settings.privacyMode,
    }),
    protocol: config.executorMode === 'echo' ? 'echo-v1' : 'dsh-headless-v1',
  })
})
const activeRuns = new Set<Promise<void>>()
const activeChatRuns = new Set<Promise<void>>()
let activeMemoryJob: Promise<boolean> | undefined
let nextMemorySyncAt = 0

const nodeCapabilities = [
  'dsh',
  ...(config.selfChangeEnabled ? ['self-change'] : []),
  ...(derivedMemory ? ['hindsight-memory'] : []),
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

if (config.executorMode !== 'echo') {
  void backfillThinkingSummaries(
    store,
    createThinkingSummarizer,
    telemetry,
    collectRootOutcomes,
  ).catch((error: unknown) => {
    logger.warn('run.thinking_summary_backfill_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

while (!lifecycle.stopping) {
  const routed = await processNextEvent(
    store,
    eventHandler,
    workerId,
    telemetry,
    { collectWindowMs: config.routeCollectWindowMs },
  )

  if (derivedMemory && !activeMemoryJob) {
    const processing = (async () => {
      const corrected = await processNextDerivedMemoryCorrectionJob(
        store,
        derivedMemory,
        `${workerId}:memory`,
        telemetry,
      )
      if (corrected) return true
      const curated = await processNextDerivedMemoryCurationJob(
        store,
        derivedMemory,
        `${workerId}:memory`,
        telemetry,
      )
      if (curated) return true
      const retained = await processNextDerivedMemoryJob(
        store,
        derivedMemory,
        `${workerId}:memory`,
        telemetry,
      )
      if (retained) return true
      if (Date.now() < nextMemorySyncAt) return false
      nextMemorySyncAt = Date.now() + config.memorySyncMs
      await synchronizeDerivedMemories(store, derivedMemory, telemetry)
      return false
    })()
      .catch((error: unknown) => {
        logger.error('memory.job_persistence_failed', error, { workerId })
        metrics.increment('pegas_errors_total', {
          component: 'memory',
          kind: 'job_persistence',
        })
        return false
      })
      .finally(() => {
        if (activeMemoryJob === processing) activeMemoryJob = undefined
      })
    activeMemoryJob = processing
  }

  // The signal callback may change stopping while a run is being awaited.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (!lifecycle.stopping && activeRuns.size < config.workerConcurrency) {
    const claimed = store.claimNextRun(workerId, 30_000, config.nodeId, 'work')
    if (!claimed) break
    const execution = executeClaimedRun(
      store,
      laneExecutor,
      claimed,
      workerId,
      config.workspaceRoot,
      shutdown.signal,
      controlPlaneBaseUrl,
      telemetry,
      collectSubagents,
      createThinkingSummarizer,
      collectRootOutcomes,
      derivedMemory,
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

  // EXEC-005: the chat lane has its own concurrency budget so heavy Runs
  // never starve instant replies, and chat never consumes heavy Run slots.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (!lifecycle.stopping && activeChatRuns.size < config.chatConcurrency) {
    const claimed = store.claimNextRun(
      workerId,
      30_000,
      config.nodeId,
      'conversation',
    )
    if (!claimed) break
    const execution = executeClaimedRun(
      store,
      laneExecutor,
      claimed,
      workerId,
      config.workspaceRoot,
      shutdown.signal,
      controlPlaneBaseUrl,
      telemetry,
      collectSubagents,
      createThinkingSummarizer,
      collectRootOutcomes,
    )
      .catch((error: unknown) => {
        logger.error('conversation.persistence_failed', error, {
          runId: claimed.run.id,
          workerId,
        })
        metrics.increment('pegas_errors_total', {
          component: 'worker',
          kind: 'conversation_persistence',
        })
      })
      .finally(() => activeChatRuns.delete(execution))
    activeChatRuns.add(execution)
  }

  if (!routed) await wait(config.eventPollMs)
}

await Promise.allSettled([
  ...activeRuns,
  ...activeChatRuns,
  ...(activeMemoryJob ? [activeMemoryJob] : []),
])
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

function createRouter(
  settings: RuntimeSettings,
  event: InboxEvent,
): TaskRouter {
  const baseRouter: TaskRouter =
    settings.routerMode === 'model'
      ? new ModelTaskRouter({
          provider: metered(createModelProvider(settings), 'router'),
          routingRules: store.routingRuleContextForUser(event.userId),
          uncertainty: settings.routingUncertainty ?? 'new_task',
        })
      : new RuleBasedTaskRouter()
  if (settings.rewriteMode === 'disabled') return baseRouter
  const rewriteConnection = store.getRewriteConnection()
  const rewriteProvider: JsonModelProvider =
    rewriteConnection.mode === 'custom'
      ? withPrivacy(
          createRewriteModelProvider(
            rewriteConnection,
            modelCredentialVault,
            config.modelTimeoutMs,
          ),
          settings,
        )
      : createModelProvider(settings)
  return new RewritingTaskRouter(
    baseRouter,
    new ModelInputRewriter(metered(rewriteProvider, 'rewrite')),
  )
}

function withPrivacy(
  provider: JsonModelProvider,
  settings: RuntimeSettings,
): JsonModelProvider {
  return settings.privacyMode === 'mask'
    ? new PrivacyMaskingProvider(provider, createPrivacyMasker())
    : provider
}

function metered(
  provider: JsonModelProvider,
  component: 'router' | 'rewrite',
): JsonModelProvider {
  return new MeteredJsonModelProvider(provider, store, component, () =>
    settingsRouter.meteringContext(),
  )
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
          policyProtectedRoots: [config.dataDir],
          ...(privacyMode === 'mask'
            ? { privacyMasker: createPrivacyMasker() }
            : {}),
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
