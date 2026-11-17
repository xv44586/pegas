import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { OpenAiCompatibleProvider } from '../src/model/openai-compatible-provider.js'

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
