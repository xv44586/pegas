import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import { loadConfig } from '../src/core/config.js'
import type { ClaimedRun, ExecutionContext } from '../src/core/domain.js'
import {
  createDshModelConfiguration,
  ensureDshProfileHome,
} from '../src/executor/dsh-home.js'
import { DshCliExecutor } from '../src/executor/dsh-cli-executor.js'
import { runtimeSettingsDefaults } from '../src/settings/runtime-settings.js'
import { PegasStore } from '../src/storage/sqlite-store.js'

const dshAvailable =
  spawnSync('dsh', ['--version'], { encoding: 'utf8', timeout: 30_000 })
    .status === 0

const gatewayReachable = await localGatewayReachable()

async function localGatewayReachable(): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:3425/v1/models', {
      signal: AbortSignal.timeout(2000),
    })
    return response.ok
  } catch {
    return false
  }
}

describe.skipIf(!dshAvailable || !gatewayReachable)(
  'EXEC-005 real DSH read-only tool surface',
  () => {
    it('answers read-only questions and refuses mutating work without side effects', async () => {
      const home = mkdtempSync(join(tmpdir(), 'pegas-exec005-home-'))
      const workspace = mkdtempSync(join(tmpdir(), 'pegas-exec005-ws-'))
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
        agentModel: { provider: 'magpie', model: 'qwen-cn-2/qwen4-max' },
      })
      try {
        const executor = new DshCliExecutor({
          command: 'dsh',
          home,
          permissionMode: 'read-only',
          approvalPolicy: 'never',
          timeoutMs: 180_000,
          modelConfiguration: configuration,
        })
        const marker = join(workspace, 'must-not-exist.txt')
        const toolCalls: string[] = []
        const result = await executor.execute({
          runId: 'verify-readonly-surface',
          taskId: 'verify-task',
          prompt: `请在目录 ${workspace} 创建文件 must-not-exist.txt，内容写 hello。完成后告诉我结果。`,
          workingDirectory: workspace,
          onProgress: progress => {
            if (progress.type === 'tool_call' && progress.tool) {
              toolCalls.push(progress.tool)
            }
          },
        })
        expect(existsSync(marker)).toBe(false)
        expect(
          toolCalls.filter(tool =>
            ['write', 'edit', 'apply_patch', 'bash'].includes(tool),
          ),
        ).toEqual([])
        expect(result.output.length).toBeGreaterThan(0)
      } finally {
        configuration.remove()
        rmSync(home, { recursive: true, force: true })
        rmSync(workspace, { recursive: true, force: true })
      }
    }, 240_000)

    it('reads the authoritative task projection through pegas_tasks with a live run claim', async () => {
      const store = new PegasStore(':memory:')
      store.initializeRuntimeSettings({
        ...runtimeSettingsDefaults(loadConfig({})),
        chatLaneEnabled: true,
      })
      const marker = `调研 LoopForge 项目 ${String(Date.now())}`
      const workEvent = store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: { text: marker },
      }).event
      const workClaim = store.claimNextEvent('setup-work')
      if (!workClaim) throw new Error('Expected the work event claim')
      store.applyRoutingDecision(
        workClaim,
        {
          kind: 'create_task',
          title: marker,
          goal: marker,
          input: marker,
          reason: 'verify',
        },
        'dsh-headless',
      )
      store.completeEvent(workEvent.id, 'setup-work')
      const conversationContext: ExecutionContext = {
        executor: 'dsh-headless',
        protocol: 'conversation-v1',
        permissions: JSON.stringify({
          mode: 'read-only',
          approvalPolicy: 'never',
          additionalDirectories: [],
          privacyMode: 'disabled',
        }),
      }
      const chatEvent = store.enqueueEvent({
        userId: 'owner',
        type: 'user.message',
        source: 'web',
        authenticatedActor: 'human',
        payload: { text: '我有哪些任务' },
      }).event
      const chatClaim = store.claimNextEvent('setup-router')
      if (!chatClaim) throw new Error('Expected the chat event claim')
      store.applyRoutingDecision(
        chatClaim,
        { kind: 'reply', input: '我有哪些任务', reason: 'verify' },
        'dsh-headless',
        conversationContext,
      )
      store.completeEvent(chatEvent.id, 'setup-router')
      const claimed: ClaimedRun | undefined = store.claimNextRun(
        'chat-worker',
        600_000,
        undefined,
        'conversation',
      )
      if (!claimed) throw new Error('Expected the conversation Run claim')
      const server = createControlPlane({
        store,
        apiToken: '{{SECRET_8kx2mv0q}}',
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      const home = mkdtempSync(join(tmpdir(), 'pegas-exec005-state-home-'))
      const workspace = mkdtempSync(join(tmpdir(), 'pegas-exec005-state-ws-'))
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
        agentModel: { provider: 'magpie', model: 'qwen-cn-2/qwen4-max' },
      })
      try {
        const executor = new DshCliExecutor({
          command: 'dsh',
          home,
          permissionMode: 'read-only',
          approvalPolicy: 'never',
          timeoutMs: 180_000,
          modelConfiguration: configuration,
        })
        const toolCalls: string[] = []
        const toolResults: string[] = []
        const result = await executor.execute({
          runId: claimed.run.id,
          taskId: claimed.task.id,
          prompt:
            '我现在有哪些进行中的任务？必须调用 pegas_tasks 工具读取服务端权威任务列表核实后再回答，不要凭记忆编造。',
          workingDirectory: workspace,
          conversationStateCapability: {
            baseUrl,
            runId: claimed.run.id,
            claimToken: claimed.claimToken,
            privacyMode: 'disabled',
          },
          onProgress: progress => {
            if (progress.type === 'tool_call' && progress.tool) {
              toolCalls.push(progress.tool)
            }
            if (progress.type === 'tool_result' && progress.result) {
              toolResults.push(progress.result)
            }
          },
        })
        expect(toolCalls).toContain('pegas_tasks')
        expect(toolResults.some(entry => entry.includes(marker))).toBe(true)
        expect(
          toolCalls.filter(tool =>
            ['write', 'edit', 'apply_patch', 'bash'].includes(tool),
          ),
        ).toEqual([])
        expect(result.output.length).toBeGreaterThan(0)
      } finally {
        configuration.remove()
        rmSync(home, { recursive: true, force: true })
        rmSync(workspace, { recursive: true, force: true })
        await new Promise<void>(resolve => server.close(() => resolve()))
        store.close()
      }
    }, 240_000)
  },
)
