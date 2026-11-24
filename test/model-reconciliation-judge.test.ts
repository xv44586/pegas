import { describe, expect, it } from 'vitest'

import {
  collectModelReconciliationEvidence,
  parseModelReconciliationVerdict,
} from '../src/observability/action-reconciliation.js'
import { createModelReconciliationJudge } from '../src/observability/model-reconciliation.js'
import type {
  JsonModelProvider,
  JsonModelRequest,
} from '../src/model/provider.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fakeProvider(
  respond: (request: JsonModelRequest) => Promise<unknown>,
  seen?: JsonModelRequest[],
): JsonModelProvider {
  return {
    name: 'fake',
    generateJson: request => {
      seen?.push(request)
      return respond(request)
    },
  }
}

describe('model reconciliation judge', () => {
  it('sends the policy plus full evidence and returns a strict verdict', async () => {
    const seen: JsonModelRequest[] = []
    const judge = createModelReconciliationJudge({
      provider: () =>
        fakeProvider(
          () =>
            Promise.resolve({
              resolution: 'succeeded',
              reason: '目标内容包含命令预期结果。',
            }),
          seen,
        ),
    })
    const verdict = await judge({
      goal: '把数据追加到 out.txt',
      command: "cat in.txt | sed 's/a/b/' >> out.txt",
      category: 'out-of-workspace-write',
      targets: [{ path: 'out.txt', exists: true, content: 'b\n' }],
    })
    expect(verdict).toEqual({
      resolution: 'succeeded',
      reason: '目标内容包含命令预期结果。',
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.system).toContain('inconclusive')
    expect(seen[0]?.system).toContain('绝不建议重新执行')
    const input = JSON.parse(seen[0]?.input ?? '{}') as { command?: string }
    expect(input.command).toContain('sed')
  })

  it('downgrades malformed model output to inconclusive instead of throwing success', async () => {
    const judge = createModelReconciliationJudge({
      provider: () =>
        fakeProvider(() => Promise.resolve({ resolution: 'succeeded' })),
    })
    const verdict = await judge({
      goal: '写入',
      command: 'cat a >> b',
      category: 'workspace-write',
      targets: [{ path: 'b', exists: true }],
    })
    expect(verdict.resolution).toBe('inconclusive')
  })

  it('propagates provider failures so the caller keeps the action unknown', async () => {
    const judge = createModelReconciliationJudge({
      provider: () =>
        fakeProvider(() => Promise.reject(new Error('provider down'))),
    })
    await expect(
      judge({
        goal: '写入',
        command: 'cat a >> b',
        category: 'workspace-write',
        targets: [{ path: 'b', exists: false }],
      }),
    ).rejects.toThrow('provider down')
  })
})

describe('evidence collection budget', () => {
  it('refuses oversized commands and oversized or binary targets', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pegas-judge-evidence-'))
    try {
      const small = join(directory, 'small.txt')
      writeFileSync(small, 'ok\n')
      const big = join(directory, 'big.bin')
      writeFileSync(big, Buffer.alloc(9_000, 1))
      expect(
        collectModelReconciliationEvidence({
          goal: 'g',
          command: 'x'.repeat(16_385),
          category: 'workspace-write',
          targets: [small],
        }),
      ).toBeUndefined()
      expect(
        collectModelReconciliationEvidence({
          goal: 'g',
          command: 'cat a >> b',
          category: 'workspace-write',
          targets: [big],
        }),
      ).toBeUndefined()
      const evidence = collectModelReconciliationEvidence({
        goal: 'g',
        command: 'cat a >> b',
        category: 'workspace-write',
        targets: [small, join(directory, 'missing.txt')],
      })
      expect(evidence?.targets).toEqual([
        expect.objectContaining({ path: small, exists: true, content: 'ok\n' }),
        { path: join(directory, 'missing.txt'), exists: false },
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('strict verdict parsing', () => {
  it('accepts only the three resolutions with a bounded non-empty reason', () => {
    expect(
      parseModelReconciliationVerdict({
        resolution: 'failed',
        reason: '目标不存在。',
      }),
    ).toEqual({ resolution: 'failed', reason: '目标不存在。' })
    expect(
      parseModelReconciliationVerdict({ resolution: 'ok', reason: 'x' }),
    ).toBeUndefined()
    expect(
      parseModelReconciliationVerdict({
        resolution: 'succeeded',
        reason: '  ',
      }),
    ).toBeUndefined()
    expect(
      parseModelReconciliationVerdict({
        resolution: 'succeeded',
        reason: 'x'.repeat(2_001),
      }),
    ).toBeUndefined()
    expect(parseModelReconciliationVerdict(null)).toBeUndefined()
    expect(parseModelReconciliationVerdict('succeeded')).toBeUndefined()
  })
})
