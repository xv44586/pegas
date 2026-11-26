import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { defaultMagpieRouterModel } from '../src/core/model-defaults.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('live model gate configuration', () => {
  it('shares the product default across every live integration suite', async () => {
    vi.stubEnv('PEGAS_LIVE_MODEL', '')
    const { liveModelName } = await import('./support/live-model.js')
    expect(liveModelName()).toBe(defaultMagpieRouterModel)
    for (const name of [
      'policy-gate-integration',
      'dsh-readonly-surface-integration',
      'routing-rules-live-integration',
      'chat-lane-live-integration',
    ]) {
      const source = readFileSync(
        new URL(`./${name}.test.ts`, import.meta.url),
        'utf8',
      )
      expect(source).toContain('liveModelName()')
      expect(source).not.toContain('qwen-cn-2/qwen4-max')
    }
  })
  it('honors an explicit model without silently substituting another provider', async () => {
    vi.stubEnv('PEGAS_LIVE_MODEL', ' unavailable-provider/model ')
    const { liveModelName } = await import('./support/live-model.js')
    expect(liveModelName()).toBe('unavailable-provider/model')
  })
})

describe('live model opt-in and prerequisites', () => {
  it.each(['unset', '', '0', 'true'])(
    'refuses opt-in %s before any probe or child process',
    async optIn => {
      const { requireLiveModelRuntime } =
        await import('./support/live-model.js')
      const fetcher = vi.fn<typeof fetch>()
      const checkDsh = vi.fn<() => boolean>()
      await expect(
        requireLiveModelRuntime({
          environment: optIn === 'unset' ? {} : { PEGAS_LIVE_TESTS: optIn },
          requireDsh: true,
          fetcher,
          checkDsh,
        }),
      ).rejects.toThrow('pnpm test:live')
      expect(fetcher).not.toHaveBeenCalled()
      expect(checkDsh).not.toHaveBeenCalled()
    },
  )

  it('fails explicitly when DSH is missing without reaching the gateway', async () => {
    const { requireLiveModelRuntime } = await import('./support/live-model.js')
    const fetcher = vi.fn<typeof fetch>()
    await expect(
      requireLiveModelRuntime({
        environment: { PEGAS_LIVE_TESTS: '1' },
        requireDsh: true,
        fetcher,
        checkDsh: () => false,
      }),
    ).rejects.toThrow('require dsh')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not skip a requested live run on gateway or credential failure', async () => {
    const { requireLiveModelRuntime } = await import('./support/live-model.js')
    const environment = { PEGAS_LIVE_TESTS: '1' }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 401 }))
    await expect(
      requireLiveModelRuntime({ environment, fetcher }),
    ).rejects.toThrow('401')
    fetcher.mockRejectedValue(new Error('gateway offline'))
    await expect(
      requireLiveModelRuntime({ environment, fetcher }),
    ).rejects.toThrow('gateway offline')
  })

  it('accepts explicit opt-in and available dependencies', async () => {
    const { requireLiveModelRuntime } = await import('./support/live-model.js')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
    const checkDsh = vi.fn(() => true)
    await expect(
      requireLiveModelRuntime({
        environment: { PEGAS_LIVE_TESTS: '1' },
        requireDsh: true,
        fetcher,
        checkDsh,
      }),
    ).resolves.toBeUndefined()
    expect(checkDsh).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
