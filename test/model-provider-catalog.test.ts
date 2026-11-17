import { describe, expect, it } from 'vitest'

import {
  modelProviderPreset,
  modelProviderPresets,
} from '../src/model/provider-catalog.js'

describe('model provider catalog', () => {
  it('offers common vendors, gateways, local servers, and a custom entry without Codex', () => {
    const ids = modelProviderPresets.map(provider => provider.id)

    expect(ids).toEqual(
      expect.arrayContaining([
        'openai',
        'anthropic',
        'google',
        'deepseek',
        'xai',
        'moonshot',
        'zhipu',
        'minimax',
        'qwen',
        'openrouter',
        'groq',
        'mistral',
        'siliconflow',
        'ollama',
        'lmstudio',
        'custom',
      ]),
    )
    expect(ids).not.toContain('codex-cli')
    expect(modelProviderPreset('anthropic')).toMatchObject({
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
    })
    expect(modelProviderPreset('ollama')).toMatchObject({
      category: 'local',
      requiresApiKey: false,
    })
  })
})
