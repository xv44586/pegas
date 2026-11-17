import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/core/config.js'
import { ModelCredentialVault } from '../src/model/model-credential-vault.js'
import {
  createConfiguredModelProvider,
  initializeConfiguredModelProvider,
} from '../src/model/provider-factory.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

describe('configured model provider factory', () => {
  it('builds the protocol adapter selected by the stored connection', () => {
    const store = new PegasStore(':memory:')
    const vault = new ModelCredentialVault(Buffer.alloc(32, 7))
    store.initializeModelProviderConnection({
      id: 'custom',
      name: 'Private Anthropic gateway',
      protocol: 'anthropic-messages',
      baseUrl: 'https://models.example.com',
      apiKeyCiphertext: vault.encrypt('provider-secret'),
    })

    const provider = createConfiguredModelProvider(
      {
        revision: 1,
        routerMode: 'model',
        modelProvider: 'custom',
        modelName: 'private-sonnet',
        privacyMode: 'disabled',
        rewriteMode: 'disabled',
        updatedAt: '2026-11-17T00:00:00.000Z',
      },
      store,
      vault,
      1_000,
    )

    expect(provider.name).toBe('anthropic-messages')
    store.close()
  })

  it('encrypts an environment-provided credential during first-run initialization', () => {
    const store = new PegasStore(':memory:')
    const vault = new ModelCredentialVault(Buffer.alloc(32, 8))
    const config = loadConfig({
      PEGAS_MODEL_PROVIDER: 'deepseek',
      PEGAS_MODEL_API_KEY: 'environment-secret',
    })

    initializeConfiguredModelProvider(store, config, vault)

    const connection = store.getModelProviderConnection('deepseek')
    expect(connection?.apiKeyCiphertext).not.toBe('environment-secret')
    expect(vault.decrypt(connection?.apiKeyCiphertext ?? '')).toBe(
      'environment-secret',
    )
    store.close()
  })

  it('rejects a preset that requires a missing API key', () => {
    const store = new PegasStore(':memory:')
    const vault = new ModelCredentialVault(Buffer.alloc(32, 9))

    expect(() =>
      createConfiguredModelProvider(
        {
          revision: 1,
          routerMode: 'model',
          modelProvider: 'openai',
          modelName: 'gpt-5-mini',
          privacyMode: 'disabled',
          rewriteMode: 'disabled',
          updatedAt: '2026-11-17T00:00:00.000Z',
        },
        store,
        vault,
        1_000,
      ),
    ).toThrow('Missing API key for OpenAI')
    store.close()
  })
})
