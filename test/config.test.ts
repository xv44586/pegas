import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { defaultAgentWorkspace, loadConfig } from '../src/core/config.js'

const privacyHmacKey = ['privacy', 'test', 'key', 'value', '2026'].join('-')

describe('loadConfig', () => {
  it('uses safe local defaults', () => {
    expect(loadConfig({})).toMatchObject({
      apiHost: '127.0.0.1',
      apiPort: 4317,
      databasePath: resolve('data/pegas.sqlite'),
      executorMode: 'dsh',
      dshHome: resolve('data/dsh'),
      dshSessionsRoot: resolve('data/dsh/sessions'),
      dshProfile: 'headless',
      workspaceRoot: defaultAgentWorkspace(resolve('data')),
      modelName: 'discovery-api/deepseek-v4.1-flash-1017',
      modelProvider: 'magpie',
      pushMode: 'disabled',
      privacyMode: 'disabled',
      memoryProvider: 'local',
      rewriteMode: 'disabled',
      routerMode: 'model',
      schedulerPollMs: 500,
      speechBaseUrl: 'http://127.0.0.1:18081/v1',
      speechModel: 'Qwen/Qwen3-ASR-0.6B',
      speechProvider: 'openai-compatible',
      workerConcurrency: 2,
    })
  })

  it('loads an explicit Hindsight derived-memory provider', () => {
    expect(
      loadConfig({
        PEGAS_MEMORY_PROVIDER: 'hindsight',
        PEGAS_HINDSIGHT_BASE_URL: 'http://127.0.0.1:8888',
        PEGAS_HINDSIGHT_API_KEY: 'hsk_test',
        PEGAS_MEMORY_HMAC_KEY: 'pegas-test-hmac-key-0123456789abcdef',
        PEGAS_HINDSIGHT_TIMEOUT_MS: '2500',
      }),
    ).toMatchObject({
      memoryProvider: 'hindsight',
      hindsightBaseUrl: 'http://127.0.0.1:8888',
      hindsightApiKey: 'hsk_test',
      memoryHmacKey: 'pegas-test-hmac-key-0123456789abcdef',
      hindsightTimeoutMs: 2500,
    })
  })

  it('loads explicit model, executor, webhook, and workspace settings', () => {
    expect(
      loadConfig({
        PEGAS_API_HOST: 'localhost',
        PEGAS_API_PORT: '5000',
        PEGAS_DSH_ADD_DIRS: './one, ./two,',
        PEGAS_DSH_HOME: './isolated-dsh',
        PEGAS_EXECUTOR: 'echo',
        PEGAS_MODEL_BASE_URL: 'https://models.example/v1',
        PEGAS_MODEL_NAME: 'model-test',
        PEGAS_MODEL_PROVIDER: 'custom',
        PEGAS_PUSH_MODE: 'webhook',
        PEGAS_PUSH_WEBHOOK_URL: 'https://push.example/pegas',
        PEGAS_ROUTER: 'rules',
        PEGAS_PRIVACY_HMAC_KEY: privacyHmacKey,
        PEGAS_PRIVACY_MODE: 'mask',
        PEGAS_REWRITE_MODE: 'light',
        PEGAS_SPEECH_BASE_URL: 'http://127.0.0.1:18081/v1',
        PEGAS_SPEECH_MODEL: 'Qwen/Qwen3-ASR-1.7B',
        PEGAS_SPEECH_PROVIDER: 'openai-compatible',
        PEGAS_WORKER_CONCURRENCY: '4',
      }),
    ).toMatchObject({
      apiHost: 'localhost',
      apiPort: 5000,
      dshAdditionalDirectories: [resolve('./one'), resolve('./two')],
      dshHome: resolve('./isolated-dsh'),
      dshSessionsRoot: resolve('./isolated-dsh/sessions'),
      executorMode: 'echo',
      modelBaseUrl: 'https://models.example/v1',
      modelName: 'model-test',
      modelProvider: 'custom',
      pushMode: 'webhook',
      privacyHmacKey,
      privacyMode: 'mask',
      rewriteMode: 'light',
      pushWebhookUrl: 'https://push.example/pegas',
      routerMode: 'rules',
      speechBaseUrl: 'http://127.0.0.1:18081/v1',
      speechModel: 'Qwen/Qwen3-ASR-1.7B',
      speechProvider: 'openai-compatible',
      workerConcurrency: 4,
    })
  })

  it('keeps an explicit sessions root override independent of dshHome', () => {
    expect(
      loadConfig({
        PEGAS_DSH_HOME: './isolated-dsh',
        PEGAS_DSH_SESSIONS_ROOT: './legacy-sessions',
      }),
    ).toMatchObject({
      dshHome: resolve('./isolated-dsh'),
      dshSessionsRoot: resolve('./legacy-sessions'),
    })
  })

  it('follows a custom data directory when deriving the sessions root', () => {
    expect(loadConfig({ PEGAS_DATA_DIR: './custom-data' })).toMatchObject({
      dshHome: resolve('./custom-data/dsh'),
      dshSessionsRoot: resolve('./custom-data/dsh/sessions'),
    })
  })

  it('keeps the default agent workspace outside the checkout tree', () => {
    const workspace = loadConfig({}).workspaceRoot
    expect(workspace).toBe(defaultAgentWorkspace(resolve('data')))
    expect(workspace.startsWith(join(homedir(), '.pegas', 'workspaces'))).toBe(
      true,
    )
    expect(workspace.startsWith(resolve('data'))).toBe(false)
    expect(workspace.startsWith(process.cwd())).toBe(false)
  })

  it('derives a distinct default workspace per data directory', () => {
    const first = loadConfig({ PEGAS_DATA_DIR: './instance-a' }).workspaceRoot
    const second = loadConfig({ PEGAS_DATA_DIR: './instance-b' }).workspaceRoot
    expect(first).not.toBe(second)
    expect(first).toBe(defaultAgentWorkspace(resolve('./instance-a')))
    expect(second).toBe(defaultAgentWorkspace(resolve('./instance-b')))
  })

  it('keeps an explicit workspace override independent of the data directory', () => {
    expect(
      loadConfig({
        PEGAS_DATA_DIR: './custom-data',
        PEGAS_WORKSPACE_ROOT: './agent-work',
      }).workspaceRoot,
    ).toBe(resolve('./agent-work'))
  })

  it.each([
    [
      { PEGAS_API_HOST: '0.0.0.0' },
      'PEGAS_API_TOKEN is required when the API listens outside the loopback interface',
    ],
    [
      { PEGAS_MODEL_PROVIDER: 'unsupported' },
      'Unsupported PEGAS_MODEL_PROVIDER',
    ],
    [
      { PEGAS_PUSH_MODE: 'webhook' },
      'PEGAS_PUSH_WEBHOOK_URL is required when PEGAS_PUSH_MODE=webhook',
    ],
    [
      {
        PEGAS_SPEECH_PROVIDER: 'openai-compatible',
        PEGAS_SPEECH_BASE_URL: '',
      },
      'PEGAS_SPEECH_BASE_URL is required when PEGAS_SPEECH_PROVIDER=openai-compatible',
    ],
    [{ PEGAS_PRIVACY_MODE: 'unsupported' }, 'Unsupported PEGAS_PRIVACY_MODE'],
    [{ PEGAS_REWRITE_MODE: 'unsupported' }, 'Unsupported PEGAS_REWRITE_MODE'],
    [
      { PEGAS_MEMORY_PROVIDER: 'unsupported' },
      'Unsupported PEGAS_MEMORY_PROVIDER',
    ],
    [
      { PEGAS_MEMORY_PROVIDER: 'hindsight' },
      'PEGAS_HINDSIGHT_BASE_URL is required',
    ],
    [
      {
        PEGAS_MEMORY_PROVIDER: 'hindsight',
        PEGAS_HINDSIGHT_BASE_URL: 'http://127.0.0.1:8888',
      },
      'PEGAS_MEMORY_HMAC_KEY is required',
    ],
    [
      {
        PEGAS_MEMORY_PROVIDER: 'hindsight',
        PEGAS_HINDSIGHT_BASE_URL: 'http://127.0.0.1:8888',
        PEGAS_MEMORY_HMAC_KEY: 'pegas-test-hmac-key-0123456789abcdef',
      },
      'PEGAS_HINDSIGHT_API_KEY is required',
    ],
    [
      {
        PEGAS_MEMORY_PROVIDER: 'hindsight',
        PEGAS_HINDSIGHT_BASE_URL: 'http://127.0.0.1:8888',
        PEGAS_MEMORY_HMAC_KEY: 'short-key',
        PEGAS_HINDSIGHT_API_KEY: 'hsk_test',
      },
      'PEGAS_MEMORY_HMAC_KEY must contain at least 32 characters',
    ],
    [
      {
        PEGAS_MEMORY_PROVIDER: 'local',
        PEGAS_MEMORY_HMAC_KEY: 'short-key',
      },
      'PEGAS_MEMORY_HMAC_KEY must contain at least 32 characters',
    ],
    [{ PEGAS_API_PORT: '0' }, 'PEGAS_API_PORT must be a positive integer'],
  ])('rejects unsafe or invalid settings', (environment, message) => {
    expect(() => loadConfig(environment)).toThrow(message)
  })
})
