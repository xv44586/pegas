import { describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../src/core/config.js'
import { resolveInitialModelName } from '../src/settings/initial-model.js'

describe('initial model selection', () => {
  it('uses the first model returned by the default Magpie endpoint', async () => {
    const discover = vi.fn(() =>
      Promise.resolve([
        { id: 'first-available', name: 'First available' },
        { id: 'second-available', name: 'Second available' },
      ]),
    )
    const config = loadConfig({})

    await expect(
      resolveInitialModelName(config, {
        hasRuntimeSettings: false,
        modelNameExplicit: false,
        discover,
      }),
    ).resolves.toBe('first-available')
    expect(discover).toHaveBeenCalledWith({
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:3425/v1',
      timeoutMs: 2_000,
    })
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
    ).resolves.toBe('group/free-small-models')
    await expect(
      resolveInitialModelName(config, {
        hasRuntimeSettings: true,
        modelNameExplicit: false,
        discover,
      }),
    ).resolves.toBe('group/free-small-models')
    await expect(
      resolveInitialModelName(config, {
        hasRuntimeSettings: false,
        modelNameExplicit: false,
        discover,
      }),
    ).resolves.toBe('group/free-small-models')
  })
})
