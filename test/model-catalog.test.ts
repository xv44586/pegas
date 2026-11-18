import { describe, expect, it, vi } from 'vitest'

import {
  discoverModelCatalog,
  testModelConnection,
} from '../src/model/model-catalog.js'
import type { JsonModelRequest } from '../src/model/provider.js'

describe('model catalog operations', () => {
  it('loads and normalizes an OpenAI-compatible model list', async () => {
    const fetcher = vi.fn<(input: URL, init: RequestInit) => Promise<Response>>(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                { id: 'model-b' },
                { id: 'model-a', name: 'Model A' },
                { id: 'model-a' },
                { id: '' },
              ],
            }),
            { status: 200 },
          ),
        ),
    )

    await expect(
      discoverModelCatalog(
        {
          protocol: 'openai-chat',
          baseUrl: 'https://models.example/v1',
          apiKey: 'secret',
        },
        fetcher,
      ),
    ).resolves.toEqual([
      { id: 'model-b', name: 'model-b' },
      { id: 'model-a', name: 'Model A' },
    ])
    const [url, init] = fetcher.mock.calls[0] ?? []
    expect(url).toEqual(new URL('https://models.example/v1/models'))
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer secret',
    )
  })

  it('uses Anthropic model discovery headers and reports bounded failures', async () => {
    const fetcher = vi.fn<(input: URL, init: RequestInit) => Promise<Response>>(
      () => Promise.resolve(new Response('no access', { status: 401 })),
    )

    await expect(
      discoverModelCatalog(
        {
          protocol: 'anthropic-messages',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'secret',
        },
        fetcher,
      ),
    ).rejects.toThrow('模型目录返回 401: no access')
    const [url, init] = fetcher.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)
    expect(url).toEqual(new URL('https://api.anthropic.com/v1/models'))
    expect(headers.get('x-api-key')).toBe('secret')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
  })

  it('tests the exact selected model and returns elapsed time', async () => {
    const generateJson = vi.fn<(request: JsonModelRequest) => Promise<unknown>>(
      () => Promise.resolve({ ok: true }),
    )
    const provider = {
      name: 'test-provider',
      generateJson,
    }

    await expect(testModelConnection(provider, () => 125)).resolves.toEqual({
      ok: true,
      latencyMs: 0,
    })
    expect(generateJson.mock.calls[0]?.[0].input).toContain('connectivity')
  })
})
