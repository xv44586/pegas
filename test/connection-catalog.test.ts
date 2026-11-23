import { describe, expect, it, vi } from 'vitest'

import { ModelCredentialVault } from '../src/model/model-credential-vault.js'
import { discoverConnectionCatalogs } from '../src/settings/connection-catalog.js'
import type { ModelProviderConnection } from '../src/settings/runtime-settings.js'

const vault = new ModelCredentialVault(Buffer.alloc(32, 5))

function connection(
  overrides: Partial<ModelProviderConnection> = {},
): ModelProviderConnection {
  return {
    id: 'magpie',
    name: 'Magpie',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:3425/v1',
    updatedAt: '2026-11-23T00:00:00.000Z',
    ...overrides,
  }
}

describe('discoverConnectionCatalogs', () => {
  it('discovers every configured connection with decrypted credentials', async () => {
    const discover = vi.fn(({ baseUrl }: { baseUrl: string }) =>
      Promise.resolve(
        baseUrl.includes('3425')
          ? [
              { id: 'gateway/a', name: 'A' },
              { id: 'gateway/b', name: 'B' },
            ]
          : [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
      ),
    )
    const catalogs = await discoverConnectionCatalogs(
      [
        connection({ apiKeyCiphertext: vault.encrypt('magpie-key') }),
        connection({
          id: 'anthropic',
          name: 'Anthropic',
          protocol: 'anthropic-messages',
          baseUrl: 'https://api.anthropic.com',
        }),
      ],
      vault,
      { timeoutMs: 5_000, discover },
    )
    expect(catalogs).toEqual({
      magpie: [
        { id: 'gateway/a', name: 'A' },
        { id: 'gateway/b', name: 'B' },
      ],
      anthropic: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
    })
    expect(discover).toHaveBeenCalledWith({
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:3425/v1',
      apiKey: 'magpie-key',
      timeoutMs: 5_000,
    })
    expect(discover).toHaveBeenCalledWith({
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      timeoutMs: 5_000,
    })
  })

  it('keeps other catalogs when one connection fails or has corrupt credentials', async () => {
    const discover = vi.fn(({ baseUrl }: { baseUrl: string }) => {
      if (baseUrl.includes('broken'))
        return Promise.reject(new Error('offline'))
      return Promise.resolve([{ id: 'model-a', name: 'Model A' }])
    })
    const catalogs = await discoverConnectionCatalogs(
      [
        connection({ id: 'deepseek', baseUrl: 'http://broken.local/v1' }),
        connection({ apiKeyCiphertext: 'not-a-valid-ciphertext' }),
        connection({ id: 'ollama', baseUrl: 'http://ok.local/v1' }),
      ],
      vault,
      { timeoutMs: 1_000, discover },
    )
    expect(catalogs).toEqual({
      deepseek: [],
      magpie: [],
      ollama: [{ id: 'model-a', name: 'Model A' }],
    })
  })
})
