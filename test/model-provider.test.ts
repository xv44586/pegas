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
