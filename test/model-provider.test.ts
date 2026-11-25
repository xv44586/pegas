import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { OpenAiCompatibleProvider } from '../src/model/openai-compatible-provider.js'
import { AnthropicProvider } from '../src/model/anthropic-provider.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('OpenAiCompatibleProvider', () => {
  it('sends an authenticated JSON completion request', async () => {
    let authorization: string | undefined
    let requestBody: unknown
    const server = createServer(async (request, response) => {
      authorization = request.headers.authorization
      const chunks: Buffer[] = []
      for await (const rawChunk of request) {
        const chunk: unknown = rawChunk
        if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
        else if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      }
      requestBody = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      ) as unknown
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { content: '{"kind":"create_task"}' } }],
        }),
      )
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const { port } = server.address() as AddressInfo
    const provider = new OpenAiCompatibleProvider({
      baseUrl: `http://127.0.0.1:${String(port)}/v1`,
      model: 'router-model',
      apiKey: 'secret',
    })

    await expect(
      provider.generateJson({ system: 'Route it', input: 'A new idea' }),
    ).resolves.toEqual({ kind: 'create_task' })
    expect(authorization).toBe('Bearer secret')
    expect(requestBody).toMatchObject({
      model: 'router-model',
      response_format: { type: 'json_object' },
    })
  })
})

describe('AnthropicProvider', () => {
  it('uses a forced tool result for schema-constrained JSON', async () => {
    let apiKey: string | undefined
    let anthropicVersion: string | undefined
    let requestBody: unknown
    const server = createServer(async (request, response) => {
      apiKey = request.headers['x-api-key'] as string | undefined
      anthropicVersion = request.headers['anthropic-version'] as
        string | undefined
      const chunks: Buffer[] = []
      for await (const rawChunk of request) {
        const chunk: unknown = rawChunk
        if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
        else if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      }
      requestBody = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      ) as unknown
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          content: [
            {
              type: 'tool_use',
              name: 'return_json',
              input: { kind: 'create_task' },
            },
          ],
        }),
      )
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () => new Promise<void>(resolve => server.close(() => resolve())),
    )
    const { port } = server.address() as AddressInfo
    const provider = new AnthropicProvider({
      baseUrl: `http://127.0.0.1:${String(port)}`,
      model: 'claude-test',
      apiKey: 'anthropic-secret',
    })

    await expect(
      provider.generateJson({
        system: 'Route it',
        input: 'A new idea',
        schema: {
          type: 'object',
          properties: { kind: { type: 'string' } },
          required: ['kind'],
        },
      }),
    ).resolves.toEqual({ kind: 'create_task' })
    expect(apiKey).toBe('anthropic-secret')
    expect(anthropicVersion).toBe('2023-06-01')
    expect(requestBody).toMatchObject({
      model: 'claude-test',
      tool_choice: { type: 'tool', name: 'return_json' },
      tools: [{ name: 'return_json' }],
    })
  })
})

interface RecordedAttempt {
  at: number
}

async function startFlakyServer(
  responses: {
    status: number
    retryAfter?: string
    body?: string
  }[],
): Promise<{ baseUrl: string; attempts: RecordedAttempt[] }> {
  const attempts: RecordedAttempt[] = []
  const server = createServer((request, response) => {
    request.resume()
    const index = Math.min(attempts.length, responses.length - 1)
    attempts.push({ at: Date.now() })
    const next = responses[index] ?? { status: 500 }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (next.retryAfter !== undefined) headers['retry-after'] = next.retryAfter
    response.writeHead(next.status, headers)
    response.end(
      next.body ??
        JSON.stringify({
          choices: [{ message: { content: '{"kind":"create_task"}' } }],
        }),
    )
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () => new Promise<void>(resolve => server.close(() => resolve())),
  )
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${String(port)}/v1`, attempts }
}

const instantSleep = () => Promise.resolve()
const noJitter = { random: () => 1, sleep: instantSleep }

describe('model rate-limit retry (MODEL-001)', () => {
  it('retries a 429 and succeeds on the next attempt', async () => {
    const { baseUrl, attempts } = await startFlakyServer([
      { status: 429, body: 'slow down' },
      { status: 200 },
    ])
    const provider = new OpenAiCompatibleProvider({
      baseUrl,
      model: 'router-model',
      retry: noJitter,
    })
    await expect(
      provider.generateJson({ system: 'Route it', input: 'A new idea' }),
    ).resolves.toEqual({ kind: 'create_task' })
    expect(attempts).toHaveLength(2)
  })

  it('honors Retry-After seconds as the minimum backoff', async () => {
    const { baseUrl, attempts } = await startFlakyServer([
      { status: 429, retryAfter: '2' },
      { status: 200 },
    ])
    const delays: number[] = []
    const provider = new OpenAiCompatibleProvider({
      baseUrl,
      model: 'router-model',
      retry: {
        random: () => 1,
        sleep: ms => {
          delays.push(ms)
          return Promise.resolve()
        },
      },
    })
    await provider.generateJson({ system: 's', input: 'i' })
    expect(attempts).toHaveLength(2)
    expect(delays).toEqual([2000])
  })

  it('fails with the last status after the retry budget is exhausted', async () => {
    const { baseUrl, attempts } = await startFlakyServer([{ status: 429 }])
    const provider = new OpenAiCompatibleProvider({
      baseUrl,
      model: 'router-model',
      retry: { ...noJitter, maxAttempts: 3 },
    })
    await expect(
      provider.generateJson({ system: 's', input: 'i' }),
    ).rejects.toThrow('Model provider returned 429')
    expect(attempts).toHaveLength(3)
  })

  it('retries transient 5xx failures', async () => {
    const { baseUrl, attempts } = await startFlakyServer([
      { status: 503 },
      { status: 200 },
    ])
    const provider = new OpenAiCompatibleProvider({
      baseUrl,
      model: 'router-model',
      retry: noJitter,
    })
    await expect(
      provider.generateJson({ system: 's', input: 'i' }),
    ).resolves.toEqual({ kind: 'create_task' })
    expect(attempts).toHaveLength(2)
  })

  it('does not retry non-rate-limit client errors', async () => {
    const { baseUrl, attempts } = await startFlakyServer([
      { status: 401, body: 'bad key' },
    ])
    const provider = new OpenAiCompatibleProvider({
      baseUrl,
      model: 'router-model',
      retry: noJitter,
    })
    await expect(
      provider.generateJson({ system: 's', input: 'i' }),
    ).rejects.toThrow('Model provider returned 401')
    expect(attempts).toHaveLength(1)
  })

  it('stops retrying when the caller cancels during backoff', async () => {
    const { baseUrl, attempts } = await startFlakyServer([{ status: 429 }])
    const controller = new AbortController()
    const provider = new OpenAiCompatibleProvider({
      baseUrl,
      model: 'router-model',
      retry: {
        random: () => 1,
        sleep: () => {
          controller.abort(new Error('caller cancelled'))
          return Promise.resolve()
        },
      },
    })
    await expect(
      provider.generateJson({
        system: 's',
        input: 'i',
        signal: controller.signal,
      }),
    ).rejects.toThrow('caller cancelled')
    expect(attempts).toHaveLength(1)
  })

  it('retries Anthropic 429 responses with the same policy', async () => {
    const { baseUrl, attempts } = await startFlakyServer([
      { status: 429 },
      {
        status: 200,
        body: JSON.stringify({
          content: [
            {
              type: 'tool_use',
              name: 'return_json',
              input: { kind: 'create_task' },
            },
          ],
        }),
      },
    ])
    const provider = new AnthropicProvider({
      baseUrl,
      model: 'claude-test',
      retry: noJitter,
    })
    await expect(
      provider.generateJson({ system: 's', input: 'i' }),
    ).resolves.toEqual({ kind: 'create_task' })
    expect(attempts).toHaveLength(2)
  })
})
