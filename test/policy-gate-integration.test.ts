import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import { loadConfig } from '../src/core/config.js'
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
  'APPROVAL-001 P1 real DSH policy gate',
  () => {
    it('allows an in-workspace write and parks an out-of-workspace write as a durable Approval', async () => {
      const home = mkdtempSync(join(tmpdir(), 'pegas-p1-home-'))
      const workspace = mkdtempSync(join(tmpdir(), 'pegas-p1-ws-'))
      const outside = mkdtempSync(join(tmpdir(), 'pegas-p1-outside-'))
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
      const store = new PegasStore(':memory:')
      store.initializeRuntimeSettings(runtimeSettingsDefaults(loadConfig({})))
      const server = createControlPlane({
        store,
        apiToken: 'bridge-test',
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      let leaseHeartbeat: ReturnType<typeof setInterval> | undefined
      try {
        const event = store.enqueueEvent({
          userId: 'owner',
          type: 'user.message',
          source: 'test',
          payload: { text: '写两个探针文件' },
        }).event
        const claimedEvent = store.claimNextEvent('setup-p1')
        if (!claimedEvent) throw new Error('Expected setup event claim')
        store.applyRoutingDecision(
          claimedEvent,
          {
            kind: 'create_task',
            title: '写两个探针文件',
            goal: '写两个探针文件',
            input: '写两个探针文件',
            reason: 'probe',
          },
          'dsh-headless',
          task =>
            store.resolveWorkerExecutionContext(task.id, 'owner', {
              executor: 'dsh-headless',
              protocol: 'dsh-headless-v1',
              workspace,
              permissions: JSON.stringify({
                mode: 'workspace-write',
                approvalPolicy: 'ask',
                additionalDirectories: [],
                privacyMode: 'disabled',
              }),
            }),
        )
        store.completeEvent(event.id, 'setup-p1')
        const claimed = store.claimNextRun('worker-p1')
        if (!claimed) throw new Error('Expected claimed Run')
        leaseHeartbeat = setInterval(() => {
          try {
            store.renewRunLease(claimed.run.id, 'worker-p1', 60_000)
          } catch {
            if (leaseHeartbeat) clearInterval(leaseHeartbeat)
          }
        }, 10_000)
        leaseHeartbeat.unref()

        const executor = new DshCliExecutor({
          command: 'dsh',
          home,
          permissionMode: 'workspace-write',
          approvalPolicy: 'ask',
          timeoutMs: 240_000,
          modelConfiguration: configuration,
        })
        const activities: string[] = []
        const auditDecisions: { callId: string; decision: string }[] = []
        const insideMarker = join(workspace, 'inside-ok.txt')
        const outsideMarker = join(outside, 'outside-no.txt')
        const result = await executor.execute({
          runId: claimed.run.id,
          taskId: claimed.task.id,
          prompt: [
            `第一步：用 write 工具在 ${insideMarker} 写入内容 ok。`,
            `第二步：用 write 工具在 ${outsideMarker} 写入内容 no。`,
            '两步都尝试后，汇报每一步的结果。不要使用 bash。',
          ].join('\n'),
          workingDirectory: workspace,
          actionCapability: { baseUrl, claimToken: claimed.claimToken },
          onProgress: progress => {
            if (progress.type === 'activity') activities.push(progress.label)
            if (progress.type === 'policy_decision')
              auditDecisions.push({
                callId: progress.callId,
                decision: progress.decision,
              })
          },
        })
        expect(existsSync(insideMarker)).toBe(true)
        expect(readFileSync(insideMarker, 'utf8')).toContain('ok')
        expect(existsSync(outsideMarker)).toBe(false)
        expect(result.approvalPending).toBeDefined()
        expect(result.approvalPending?.tool).toBe('write')
        expect(activities.some(label => label.includes('安全检查通过'))).toBe(
          true,
        )
        expect(auditDecisions.some(entry => entry.decision === 'allow')).toBe(
          true,
        )
        expect(auditDecisions.some(entry => entry.decision === 'ask')).toBe(
          true,
        )
        const approval = store.pageApprovals('owner', 10).items[0]
        if (!approval) throw new Error('Expected parked Approval')
        const action = store.getAction(approval.actionId, 'owner')
        expect(action).toMatchObject({
          kind: 'dsh.tool.write',
          risk: 'high',
          request: { category: 'out-of-workspace-write' },
        })
        const effect = action?.request.effect as
          { contentHash?: unknown } | undefined
        expect(effect?.contentHash).toMatch(/^[0-9a-f]{64}$/)
      } finally {
        if (leaseHeartbeat) clearInterval(leaseHeartbeat)
        configuration.remove()
        await new Promise<void>(resolve => server.close(() => resolve()))
        store.close()
        rmSync(home, { recursive: true, force: true })
        rmSync(workspace, { recursive: true, force: true })
        rmSync(outside, { recursive: true, force: true })
      }
    }, 300_000)

    it('auto-allows an explicitly authorized out-of-workspace write when auto review is enabled', async () => {
      const home = mkdtempSync(join(tmpdir(), 'pegas-p5-home-'))
      const workspace = mkdtempSync(join(tmpdir(), 'pegas-p5-ws-'))
      const outside = mkdtempSync(join(tmpdir(), 'pegas-p5-outside-'))
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
      const store = new PegasStore(':memory:')
      store.initializeRuntimeSettings(runtimeSettingsDefaults(loadConfig({})))
      const settings = store.getRuntimeSettings()
      store.updateRuntimeSettings(settings.revision, {
        ...settings,
        autoReviewEnabled: true,
      })
      const server = createControlPlane({
        store,
        apiToken: 'bridge-test',
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      let leaseHeartbeat: ReturnType<typeof setInterval> | undefined
      try {
        const outsideMarker = join(outside, 'authorized.txt')
        const mandate = `请把总结写到 ${outsideMarker}，内容为 authorized。这是我明确授权的唯一目标。`
        const event = store.enqueueEvent({
          userId: 'owner',
          type: 'user.message',
          source: 'test',
          authenticatedActor: 'human',
          payload: { text: mandate },
        }).event
        const claimedEvent = store.claimNextEvent('setup-p5')
        if (!claimedEvent) throw new Error('Expected setup event claim')
        store.applyRoutingDecision(
          claimedEvent,
          {
            kind: 'create_task',
            title: '写授权目标文件',
            goal: mandate,
            input: mandate,
            reason: 'probe',
          },
          'dsh-headless',
          task =>
            store.resolveWorkerExecutionContext(task.id, 'owner', {
              executor: 'dsh-headless',
              protocol: 'dsh-headless-v1',
              workspace,
              permissions: JSON.stringify({
                mode: 'workspace-write',
                approvalPolicy: 'ask',
                additionalDirectories: [],
                privacyMode: 'disabled',
              }),
            }),
        )
        store.completeEvent(event.id, 'setup-p5')
        const claimed = store.claimNextRun('worker-p5')
        if (!claimed) throw new Error('Expected claimed Run')
        leaseHeartbeat = setInterval(() => {
          try {
            store.renewRunLease(claimed.run.id, 'worker-p5', 60_000)
          } catch {
            if (leaseHeartbeat) clearInterval(leaseHeartbeat)
          }
        }, 10_000)
        leaseHeartbeat.unref()

        const executor = new DshCliExecutor({
          command: 'dsh',
          home,
          permissionMode: 'workspace-write',
          approvalPolicy: 'ask',
          timeoutMs: 240_000,
          modelConfiguration: configuration,
        })
        const activities: string[] = []
        const result = await executor.execute({
          runId: claimed.run.id,
          taskId: claimed.task.id,
          prompt: [
            `用 write 工具在 ${outsideMarker} 写入内容 authorized。`,
            '完成后汇报结果。不要使用 bash，不要写其他文件。',
          ].join('\n'),
          workingDirectory: workspace,
          actionCapability: { baseUrl, claimToken: claimed.claimToken },
          onProgress: progress => {
            if (progress.type === 'activity') activities.push(progress.label)
          },
        })
        expect(result.approvalPending).toBeUndefined()
        expect(existsSync(outsideMarker)).toBe(true)
        expect(readFileSync(outsideMarker, 'utf8')).toContain('authorized')
        expect(
          activities.some(label =>
            label.includes('自动审阅已按你的原话授权放行'),
          ),
        ).toBe(true)
        const actions = store.pageApprovals('owner', 10).items
        expect(actions).toHaveLength(1)
        const approval = actions[0]
        if (!approval) throw new Error('Expected reviewed Approval')
        expect(approval.status).toBe('approved')
        const action = store.getAction(approval.actionId, 'owner')
        expect(action).toMatchObject({
          kind: 'dsh.tool.write',
          status: 'succeeded',
          review: { decision: 'allow' },
        })
        const reviewedEffect = action?.request.effect as
          { contentHash?: unknown } | undefined
        expect(reviewedEffect?.contentHash).toMatch(/^[0-9a-f]{64}$/)
      } finally {
        if (leaseHeartbeat) clearInterval(leaseHeartbeat)
        configuration.remove()
        await new Promise<void>(resolve => server.close(() => resolve()))
        store.close()
        rmSync(home, { recursive: true, force: true })
        rmSync(workspace, { recursive: true, force: true })
        rmSync(outside, { recursive: true, force: true })
      }
    }, 300_000)
  },
)
