import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/core/config.js'

const privacyHmacKey = ['privacy', 'test', 'key', 'value', '2026'].join('-')

describe('loadConfig', () => {
  it('uses safe local defaults', () => {
    expect(loadConfig({})).toMatchObject({
      apiHost: '127.0.0.1',
      apiPort: 4317,
      databasePath: resolve('data/pegas.sqlite'),
      executorMode: 'dsh',
      modelName: 'group/free-small-models',
      modelProvider: 'magpie',
      pushMode: 'disabled',
      privacyMode: 'disabled',
      rewriteMode: 'disabled',
      routerMode: 'rules',
      speechBaseUrl: 'http://127.0.0.1:18081/v1',
      speechModel: 'Qwen/Qwen3-ASR-0.6B',
      speechProvider: 'openai-compatible',
      workerConcurrency: 2,
    })
  })

  it('loads explicit model, executor, webhook, and workspace settings', () => {
    expect(
      loadConfig({
        PEGAS_API_HOST: 'localhost',
        PEGAS_API_PORT: '5000',
        PEGAS_DSH_ADD_DIRS: './one, ./two,',
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
    [{ PEGAS_API_PORT: '0' }, 'PEGAS_API_PORT must be a positive integer'],
  ])('rejects unsafe or invalid settings', (environment, message) => {
    expect(() => loadConfig(environment)).toThrow(message)
  })
})
