import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DshCliExecutor } from '../src/executor/dsh-cli-executor.js'
import {
  createDshModelConfiguration,
  ensureDshProfileHome,
  modelKeyEnvironmentName,
} from '../src/executor/dsh-home.js'
import { ModelCredentialVault } from '../src/model/model-credential-vault.js'
import {
  modelProviderPresets,
  type ModelProviderId,
  type ModelProviderProtocol,
} from '../src/model/provider-catalog.js'
import type { ModelProviderConnection } from '../src/settings/runtime-settings.js'

const marker = 'pegas-anonymous'
const fixtureKey = 'fixture-provider-key'
const model = 'fixture-model'
const answer = 'PEGAS_DSH_AUTH_OK'
const vault = new ModelCredentialVault(Buffer.alloc(32, 7))

function connection(
  id: ModelProviderId,
  protocol: ModelProviderProtocol,
  baseUrl: string,
  key?: string,
): ModelProviderConnection {
  return {
    id,
    name: id,
    protocol,
    baseUrl,
    updatedAt: '2026-11-25T00:00:00Z',
    ...(key ? { apiKeyCiphertext: vault.encrypt(key) } : {}),
  }
}

function checkPatch() {
  const baseUrl = 'http://127.0.0.1:1/v1'
  for (const preset of modelProviderPresets) {
    for (const key of [undefined, fixtureKey]) {
      const configuration = createDshModelConfiguration({
        vault,
        connections: [connection(preset.id, preset.protocol, baseUrl, key)],
        agentModel: { provider: preset.id, model },
      })
      try {
        const patch = readFileSync(configuration.patchPath, 'utf8')
        const entries = JSON.parse(patch) as {
          config: { providers?: Record<string, { apiKeyEnv?: string }> }
        }[]
        const reference = entries[0]?.config.providers?.[preset.id]?.apiKeyEnv
        const expectedRef = modelKeyEnvironmentName(preset.id)
        assert.equal(
          reference,
          expectedRef,
          `${preset.id}: scoped DSH key reference`,
        )
        assert.equal(
          configuration.environment[expectedRef],
          key ?? (preset.requiresApiKey ? undefined : marker),
          `${preset.id}: DSH key policy`,
        )
        assert(!patch.includes(fixtureKey), `${preset.id}: key found in patch`)
      } finally {
        configuration.remove()
      }
    }
  }
  console.log(
    `DSH authentication lint passed for ${String(modelProviderPresets.length)} providers.`,
  )
}

async function checkDshRequests() {
  const version = spawnSync('dsh', ['--version'], { encoding: 'utf8' })
  assert.equal(
    version.status,
    0,
    'The real transport check requires dsh on PATH',
  )
  process.env.OPENAI_API_KEY = 'fixture-ambient-key'
  const requests: {
    path?: string
    authorization?: string
    apiKey?: string | string[]
  }[] = []
  const gateway = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push({
      path: pathname,
      authorization: request.headers.authorization,
      apiKey: request.headers['x-api-key'],
    })
    request.resume()
    request.on('end', () => {
      if (request.method === 'POST' && pathname === '/v1/messages') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const chunk of [
          {
            type: 'message_start',
            message: {
              id: 'fixture',
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: answer },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          { type: 'message_stop' },
        ])
          response.write(
            `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`,
          )
        response.end()
        return
      }
      if (request.method !== 'POST' || pathname !== '/v1/chat/completions') {
        response
          .writeHead(404)
          .end(
            `Unexpected fixture request: ${request.method ?? ''} ${pathname}`,
          )
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const choice of [
        {
          index: 0,
          delta: { role: 'assistant', content: answer },
          finish_reason: null,
        },
        { index: 0, delta: {}, finish_reason: 'stop' },
      ]) {
        const chunk = {
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [choice],
        }
        response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve))
  const workspace = mkdtempSync(join(tmpdir(), 'pegas-dsh-auth-'))
  try {
    const address = gateway.address()
    assert(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${String(address.port)}`
    const home = join(workspace, 'dsh')
    ensureDshProfileHome(home, 'headless')
    for (const { id, protocol, key, wireKey } of [
      {
        id: 'magpie',
        protocol: 'openai-chat',
        key: undefined,
        wireKey: marker,
      },
      {
        id: 'magpie',
        protocol: 'openai-chat',
        key: fixtureKey,
        wireKey: fixtureKey,
      },
      {
        id: 'custom',
        protocol: 'anthropic-messages',
        key: undefined,
        wireKey: marker,
      },
      {
        id: 'openai',
        protocol: 'openai-chat',
        key: undefined,
        wireKey: undefined,
      },
    ] as const) {
      const baseUrl =
        protocol === 'anthropic-messages' ? origin : `${origin}/v1`
      const configuration = createDshModelConfiguration({
        vault,
        connections: [connection(id, protocol, baseUrl, key)],
        agentModel: { provider: id, model },
      })
      try {
        requests.length = 0
        const execution = new DshCliExecutor({
          home,
          modelConfiguration: configuration,
          permissionMode: 'read-only',
          timeoutMs: 30_000,
        }).execute({
          runId: 'dsh-auth-check',
          taskId: 'dsh-auth-check',
          prompt: 'Return the fixture response.',
          workingDirectory: workspace,
        })
        if (wireKey) {
          assert.equal((await execution).output.trim(), answer)
          assert.deepEqual(requests, [
            protocol === 'anthropic-messages'
              ? {
                  path: '/v1/messages',
                  authorization: undefined,
                  apiKey: wireKey,
                }
              : {
                  path: '/v1/chat/completions',
                  authorization: `Bearer ${wireKey}`,
                  apiKey: undefined,
                },
          ])
        } else {
          await assert.rejects(
            execution,
            /no credential for provider route "openai"/i,
          )
          assert.equal(
            requests.length,
            0,
            'A missing required key must stop before transport',
          )
        }
      } finally {
        configuration.remove()
      }
    }
    console.log(
      `DSH ${version.stdout.trim()} passed 4 HTTP contract cases across OpenAI and Anthropic protocols.`,
    )
  } finally {
    gateway.close()
    rmSync(workspace, { recursive: true, force: true })
  }
}

checkPatch()
if (process.argv.includes('--live')) await checkDshRequests()
