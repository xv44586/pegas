import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createControlPlane } from '../src/control-plane/server.js'
import {
  createDshModelConfiguration,
  ensureDshProfileHome,
} from '../src/executor/dsh-home.js'
import { DshCliExecutor } from '../src/executor/dsh-cli-executor.js'
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
      const server = createControlPlane({
        store,
        apiToken: 'bridge-test',
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
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
          { executor: 'dsh-headless' },
        )
        store.completeEvent(event.id, 'setup-p1')
        const claimed = store.claimNextRun('worker-p1')
        if (!claimed) throw new Error('Expected claimed Run')

        const executor = new DshCliExecutor({
          command: 'dsh',
          home,
          permissionMode: 'workspace-write',
          approvalPolicy: 'ask',
          timeoutMs: 240_000,
          modelConfiguration: configuration,
        })
        const activities: string[] = []
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
        const approval = store.pageApprovals('owner', 10).items[0]
        if (!approval) throw new Error('Expected parked Approval')
        const action = store.getAction(approval.actionId, 'owner')
        expect(action).toMatchObject({
          kind: 'dsh.tool.write',
          risk: 'high',
          request: { category: 'out-of-workspace-write' },
        })
      } finally {
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
