import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createDshModelConfiguration,
  ensureDshProfileHome,
} from '../src/executor/dsh-home.js'
import { DshCliExecutor } from '../src/executor/dsh-cli-executor.js'

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
  },
)
