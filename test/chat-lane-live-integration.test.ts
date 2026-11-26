import { liveModelName, requireLiveModelRuntime } from './support/live-model.js'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import { loadConfig } from '../src/core/config.js'
import { ConversationExecutor } from '../src/executor/conversation-executor.js'
import { DshCliExecutor } from '../src/executor/dsh-cli-executor.js'
import {
  createDshModelConfiguration,
  ensureDshProfileHome,
} from '../src/executor/dsh-home.js'
import { OpenAiCompatibleProvider } from '../src/model/openai-compatible-provider.js'
import { ModelTaskRouter } from '../src/router/router.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import {
  executeClaimedRun,
  processNextEvent,
  RoutingEventHandler,
} from '../src/worker/processor.js'

await requireLiveModelRuntime({ requireDsh: true })

describe('EXEC-005 real DSH conversation lane end to end', () => {
  it('routes an instant question through the real Router, streams the answer and resumes the rolling session', async () => {
    const store = new PegasStore(':memory:')
    store.initializeRuntimeSettings({
      ...runtimeSettingsDefaults(loadConfig({})),
      chatLaneEnabled: true,
    })
    const server = createControlPlane({
      store,
      apiToken: '{{SECRET_2zq9tx4r}}',
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const home = mkdtempSync(join(tmpdir(), 'pegas-chat-live-home-'))
    const workspace = mkdtempSync(join(tmpdir(), 'pegas-chat-live-ws-'))
    ensureDshProfileHome(home, 'headless')
    const configuration = createDshModelConfiguration({
      connections: [
        {
          id: 'magpie',
          name: 'magpie',
          protocol: 'openai-chat',
          baseUrl: 'http://127.0.0.1:3425/v1',
          apiKeyCiphertext: 'placeholder',
          updatedAt: new Date().toISOString(),
        },
      ],
      vault: { decrypt: () => 'placeholder-key' },
      agentModel: { provider: 'magpie', model: liveModelName() },
    })
    const router = new ModelTaskRouter({
      provider: new OpenAiCompatibleProvider({
        baseUrl: 'http://127.0.0.1:3425/v1',
        model: liveModelName(),
        apiKey: 'placeholder-key',
        timeoutMs: 60_000,
      }),
    })
    const executor = new ConversationExecutor(
      new DshCliExecutor({
        command: 'dsh',
        home,
        permissionMode: 'read-only',
        approvalPolicy: 'never',
        timeoutMs: 180_000,
        modelConfiguration: configuration,
      }),
    )
    try {
      const ask = async (text: string) => {
        store.enqueueEvent({
          userId: 'owner',
          type: 'user.message',
          source: 'web',
          authenticatedActor: 'human',
          payload: { text },
        })
        await processNextEvent(
          store,
          new RoutingEventHandler(router, 'dsh-headless'),
          'live-router',
        )
        const tasks = store.listTasks('owner')
        const latest = tasks.at(-1)
        if (latest?.kind !== 'conversation') {
          throw new Error(
            `Real Router classified as ${latest?.kind ?? 'none'}: ${JSON.stringify(
              store.listEvents('owner').map(event => ({
                status: event.status,
                lastError: event.lastError,
              })),
            )}`,
          )
        }
        const claimed = store.claimNextRun(
          'live-chat-worker',
          600_000,
          undefined,
          'conversation',
        )
        if (!claimed)
          throw new Error('Expected the real Router to mint a reply Run')
        await executeClaimedRun(
          store,
          executor,
          claimed,
          'live-chat-worker',
          workspace,
          new AbortController().signal,
          baseUrl,
        )
        const say = store
          .listOutbox('owner')
          .filter(
            message =>
              (message.payload as { type?: string }).type === 'agent.message' &&
              (message.payload as { runId?: string }).runId === claimed.run.id,
          )
        expect(say).toHaveLength(1)
        const payload = say[0]?.payload as {
          text: string
          streaming?: boolean
        }
        expect(payload.text.length).toBeGreaterThan(0)
        expect(payload.streaming).not.toBe(true)
        expect(say[0]?.projection).toMatchObject({
          lane: 'say',
          weight: 'inline',
        })
        const completed = store
          .listOutbox('owner')
          .find(
            message =>
              (message.payload as { type?: string }).type === 'run.completed' &&
              (message.payload as { runId?: string }).runId === claimed.run.id,
          )
        expect(completed?.projection).toMatchObject({ weight: 'silent' })
        expect((completed?.payload as { text?: string }).text).toBeUndefined()
        expect(store.findTask(claimed.task.id, 'owner')?.status).toBe(
          'completed',
        )
        return { claimed, answer: payload.text }
      }

      const first = await ask(
        '我最喜欢的数字是 42。它是质数吗？一句话回答，不要读任何文件。',
      )
      const sessionRef = store.conversationSessionRef('owner')
      expect(sessionRef).toBeTruthy()
      const second = await ask('我最喜欢的数字是多少？直接回答数字。')
      expect(second.answer).toContain('42')
      expect(store.conversationSessionRef('owner')).toBe(sessionRef)
      expect(second.claimed.task.id).not.toBe(first.claimed.task.id)
    } finally {
      configuration.remove()
      rmSync(home, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
    }
  }, 480_000)
})
