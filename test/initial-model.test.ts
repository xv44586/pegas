import { describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../src/core/config.js'
import { resolveInitialModelName } from '../src/settings/initial-model.js'

describe('initial model selection', () => {
  it('prefers the configured Magpie Router model over the first catalog item', async () => {
    const discover = vi.fn(() =>
      Promise.resolve([
        { id: 'group/free-small-models', name: 'Small model pool' },
        {
          id: 'discovery-api/deepseek-v4.1-flash-1017',
          name: 'DeepSeek V4.1 Flash 1017',
        },
      ]),
    )
    const config = loadConfig({})

    await expect(
      resolveInitialModelName(config, {
        hasRuntimeSettings: false,
        modelNameExplicit: false,
        discover,
      }),
    ).resolves.toBe('discovery-api/deepseek-v4.1-flash-1017')
    expect(discover).toHaveBeenCalledWith({
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:3425/v1',
      timeoutMs: 2_000,
    })
  })

  it('falls back to the first available Magpie model when the preferred model is absent', async () => {
    const discover = vi.fn(() =>
      Promise.resolve([
        { id: 'first-available', name: 'First available' },
        { id: 'second-available', name: 'Second available' },
      ]),
    )

    await expect(
      resolveInitialModelName(loadConfig({}), {
        hasRuntimeSettings: false,
        modelNameExplicit: false,
        discover,
      }),
    ).resolves.toBe('first-available')
  })

  it('preserves explicit, saved, and fallback model choices', async () => {
    const discover = vi.fn(() => Promise.reject(new Error('offline')))
    const config = loadConfig({})

    await expect(
      resolveInitialModelName(config, {
        hasRuntimeSettings: false,
        modelNameExplicit: true,
        discover,
      }),
    ).resolves.toBe('discovery-api/deepseek-v4.1-flash-1017')
    await expect(
      resolveInitialModelName(config, {
        hasRuntimeSettings: true,
        modelNameExplicit: false,
        discover,
      }),
    ).resolves.toBe('discovery-api/deepseek-v4.1-flash-1017')
    await expect(
      resolveInitialModelName(config, {
        hasRuntimeSettings: false,
        modelNameExplicit: false,
        discover,
      }),
    ).resolves.toBe('discovery-api/deepseek-v4.1-flash-1017')
  })
})
