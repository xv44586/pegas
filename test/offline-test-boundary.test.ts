import { readFileSync } from 'node:fs'
import { matchesGlob } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import config from '../vitest.config.js'
import liveConfig from '../vitest.live.config.js'
import { createOfflineFetch } from './support/offline-fetch.js'

describe('default test cost boundary', () => {
  it.each([
    'test/policy-gate-integration.test.ts',
    'test/dsh-readonly-surface-integration.test.ts',
    'test/routing-rules-live-integration.test.ts',
    'test/chat-lane-live-integration.test.ts',
  ])('does not collect the paid model suite %s', file => {
    const included = config.test?.include?.some(pattern =>
      matchesGlob(file, pattern),
    )
    const excluded = config.test?.exclude?.some(pattern =>
      matchesGlob(file, pattern),
    )
    expect(Boolean(included && !excluded)).toBe(false)
    expect(liveConfig.test?.include).toContain(file)
  })
})

// All denied requests are rejected before the injected transport is reached.
describe('ordinary test network guard', () => {
  it.each([
    'http://127.0.0.1:3425/v1/chat/completions',
    'http://localhost:3425/v1/models',
    'http://[::1]:3425/v1/messages',
    'https://api.openai.com/v1/chat/completions',
    'http://host.docker.internal:3425/v1/chat/completions',
    'http://127.0.0.1/v1/models',
  ])('rejects %s without calling the transport', async url => {
    const transport = vi.fn<typeof fetch>()
    const guarded = createOfflineFetch(transport)
    await expect(guarded(url)).rejects.toThrow('Offline test blocked')
    expect(transport).not.toHaveBeenCalled()
  })

  it('keeps local fixture requests and prevents automatic redirect escape', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('fixture'))
    const guarded = createOfflineFetch(transport)
    const request = new Request('http://127.0.0.1:43210/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    })
    await expect(
      guarded(request, { redirect: 'follow' }),
    ).resolves.toBeInstanceOf(Response)
    expect(transport).toHaveBeenCalledWith(request, { redirect: 'error' })
    await guarded(new URL('http://localhost:43210/'), { redirect: 'manual' })
    expect(transport).toHaveBeenLastCalledWith(
      new URL('http://localhost:43210/'),
      { redirect: 'manual' },
    )
  })

  it('installs the guard even when a live opt-in leaks into ordinary tests', async () => {
    vi.stubEnv('PEGAS_LIVE_TESTS', '1')
    try {
      await expect(fetch('http://127.0.0.1:3425/v1/models')).rejects.toThrow(
        'Offline test blocked',
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('default smoke model boundary', () => {
  it('overrides inherited model-backed memory and rewrite settings', () => {
    const smoke = readFileSync(
      new URL('../scripts/smoke.mjs', import.meta.url),
      'utf8',
    )
    expect(smoke).toContain("PEGAS_MEMORY_PROVIDER: 'disabled'")
    expect(smoke).toContain("PEGAS_REWRITE_MODE: 'disabled'")
    expect(smoke).toContain('PEGAS_MODEL_BASE_URL:')
  })
})
