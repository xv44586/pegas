import { describe, expect, it } from 'vitest'

import {
  assertRuntimeSettingsAvailable,
  parseRuntimeSettingsUpdate,
} from '../src/settings/runtime-settings.js'

const defaults = {
  routerMode: 'model' as const,
  modelProvider: 'openai' as const,
  modelName: 'gpt-test',
  agentModelMode: 'profile' as const,
  agentModelProvider: '',
  agentModelName: '',
  privacyMode: 'disabled' as const,
  rewriteMode: 'disabled' as const,
}

describe('runtime settings validation', () => {
  it('rejects unavailable providers and privacy before persistence', () => {
    const capabilities = {
      providers: [
        {
          id: 'openai' as const,
          name: 'OpenAI',
          category: 'vendor' as const,
          protocol: 'openai-chat' as const,
          baseUrl: 'https://api.openai.com/v1',
          defaultModel: 'gpt-test',
          description: 'OpenAI test provider',
          requiresApiKey: true,
          hasApiKey: false,
          available: false,
          reason: 'Provider is not configured',
        },
      ],
      privacyAvailable: false,
    }

    expect(() =>
      parseRuntimeSettingsUpdate(
        {
          ...defaults,
          expectedRevision: 1,
        },
        capabilities,
      ),
    ).toThrow('Provider is not configured')
    expect(() =>
      assertRuntimeSettingsAvailable(
        { ...defaults, routerMode: 'rules', privacyMode: 'mask' },
        capabilities,
      ),
    ).toThrow('隐私 HMAC key')
  })

  it('accepts a complete selection when server capabilities are present', () => {
    const capabilities = {
      providers: [
        {
          id: 'openai' as const,
          name: 'OpenAI',
          category: 'vendor' as const,
          protocol: 'openai-chat' as const,
          baseUrl: 'https://api.openai.com/v1',
          defaultModel: 'gpt-test',
          description: 'OpenAI test provider',
          requiresApiKey: true,
          hasApiKey: false,
          available: false,
          reason: 'API key required',
        },
      ],
      privacyAvailable: true,
    }

    expect(
      parseRuntimeSettingsUpdate(
        {
          ...defaults,
          expectedRevision: 2,
          privacyMode: 'mask',
          rewriteMode: 'light',
          provider: { apiKey: 'new-secret' },
        },
        capabilities,
      ),
    ).toEqual({
      expectedRevision: 2,
      settings: { ...defaults, privacyMode: 'mask', rewriteMode: 'light' },
      provider: {
        id: 'openai',
        name: 'OpenAI',
        protocol: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'new-secret',
        clearApiKey: false,
      },
    })
  })

  it('accepts a named custom endpoint without returning or requiring a key', () => {
    const capabilities = {
      providers: [
        {
          id: 'custom' as const,
          name: '自定义',
          category: 'custom' as const,
          protocol: 'openai-chat' as const,
          baseUrl: '',
          defaultModel: '',
          description: 'Custom test provider',
          requiresApiKey: false,
          hasApiKey: false,
          available: false,
        },
      ],
      privacyAvailable: true,
    }

    expect(
      parseRuntimeSettingsUpdate(
        {
          ...defaults,
          expectedRevision: 3,
          routerMode: 'rules',
          modelProvider: 'custom',
          modelName: 'local-model',
          provider: {
            name: 'Home lab',
            protocol: 'openai-chat',
            baseUrl: 'http://192.168.1.20:8080/v1',
          },
        },
        capabilities,
      ),
    ).toMatchObject({
      provider: {
        id: 'custom',
        name: 'Home lab',
        protocol: 'openai-chat',
        baseUrl: 'http://192.168.1.20:8080/v1',
      },
    })
  })
})
