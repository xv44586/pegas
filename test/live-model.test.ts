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
