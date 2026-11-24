import { describe, expect, it, vi } from 'vitest'

import {
  opaqueKey,
  PegasDerivedMemoryService,
  type DerivedMemoryProvider,
} from '../src/memory/derived-memory.js'
import { HindsightProvider } from '../src/memory/hindsight-provider.js'

describe('derived memory', () => {
  it('derives stable opaque owner and workspace keys without exposing inputs', () => {
    const first = opaqueKey('owner', 'user@example.com', 'secret-key')
    expect(first).toBe(opaqueKey('owner', 'user@example.com', 'secret-key'))
    expect(first).not.toContain('user@example.com')
    expect(first).not.toBe(opaqueKey('owner', 'other', 'secret-key'))
    expect(first).not.toBe(opaqueKey('owner', 'user@example.com', 'other-key'))
  })

  it('enforces owner and execution-context isolation after provider recall', async () => {
    const provider = providerStub()
    const recall = vi.fn().mockResolvedValue([
      {
        id: 'global',
        text: '全局偏好',
        type: 'observation',
        tags: ['pegas:global'],
        metadata: {},
      },
      {
        id: 'wrong-context',
        text: '另一个工作区',
        type: 'world',
        tags: ['pegas:context:wrong'],
        metadata: {},
      },
      {
        id: 'invalidated',
        text: '已删除',
        type: 'experience',
        state: 'invalidated',
        tags: ['pegas:global'],
        metadata: {},
      },
    ])
    provider.recall = recall
    const service = new PegasDerivedMemoryService(provider, {
      hmacKey: 'test-key',
    })
    const memories = await service.recall({
      userId: 'owner',
      taskId: 'task-1',
      runId: 'run-1',
      query: '继续实现',
      workingDirectory: '/workspace/project',
    })

    expect(memories.entries.map(memory => memory.id)).toEqual(['global'])
    expect(memories.entries[0]).toMatchObject({
      origin: 'derived',
      provider: 'hindsight',
      scope: 'worker',
    })
    expect(memories.audit).toEqual(
      expect.arrayContaining([
        {
          memoryId: 'wrong-context',
          stage: 'filtered',
          reason: 'context_mismatch',
        },
        {
          memoryId: 'invalidated',
          stage: 'filtered',
          reason: 'invalidated',
        },
      ]),
    )
    expect(recall).toHaveBeenCalledWith(
      service.bankId('owner'),
      expect.objectContaining({
        tags: [
          'pegas:global',
          `pegas:context:${service.contextKey('/workspace/project')}`,
        ],
      }),
    )
  })

  it('uses the documented Hindsight contract and rejects weak recall results', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              id: 'strong',
              text: '使用 pnpm',
              type: 'world',
              reranker_score: 0.8,
              tags: ['pegas:global'],
              metadata: { task_id: 'task-1' },
            },
            {
              id: 'weak',
              text: '不相关',
              type: 'world',
              reranker_score: 0.01,
              tags: ['pegas:global'],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ operation_id: 'operation-1' }))
    const provider = new HindsightProvider({
      baseUrl: 'http://hindsight.local/',
      apiKey: 'api-key',
      fetch: request,
    })

    await expect(
      provider.recall('bank/1', {
        query: 'package manager',
        maxTokens: 1_600,
        tags: ['pegas:global'],
      }),
    ).resolves.toMatchObject([{ id: 'strong' }])
    await expect(
      provider.retain('bank/1', {
        operationId: '550e8400-e29b-41d4-a716-446655440000',
        documentId: 'run:1',
        content: 'evidence',
        context: 'Pegas work Run',
        tags: ['pegas:global'],
        metadata: { run_id: 'run-1' },
      }),
    ).resolves.toBe('operation-1')

    const [recallUrl, recallInit] = request.mock.calls[0] ?? []
    expect(recallUrl).toBe(
      'http://hindsight.local/v1/default/banks/bank%2F1/memories/recall',
    )
    expect(recallInit?.method).toBe('POST')
    expect(new Headers(recallInit?.headers).get('authorization')).toBe(
      'Bearer api-key',
    )
    if (typeof recallInit?.body !== 'string')
      throw new Error('Expected JSON request body')
    expect(JSON.parse(recallInit.body) as unknown).toMatchObject({
      tags_match: 'any',
      max_tokens: 1_600,
    })
    const [retainUrl, retainInit] = request.mock.calls[1] ?? []
    expect(retainUrl).toBe(
      'http://hindsight.local/v1/default/banks/bank%2F1/memories',
    )
    if (typeof retainInit?.body !== 'string')
      throw new Error('Expected retain JSON request body')
    expect(JSON.parse(retainInit.body) as unknown).toMatchObject({
      async: true,
      operation_id: '550e8400-e29b-41d4-a716-446655440000',
    })
  })

  it('enforces a local injection budget when the provider over-returns', async () => {
    const provider = providerStub()
    provider.recall = vi.fn().mockResolvedValue(
      Array.from({ length: 3 }, (_, index) => ({
        id: `memory-${String(index)}`,
        text: '长'.repeat(4_000),
        type: 'world',
        tags: ['pegas:global'],
        metadata: {},
      })),
    )
    const service = new PegasDerivedMemoryService(provider, {
      hmacKey: 'budget-key',
      maximumTokens: 100,
    })

    const result = await service.recall({
      userId: 'owner',
      taskId: 'task-1',
      runId: 'run-1',
      query: 'continue',
      workingDirectory: '/workspace',
    })

    expect(
      result.entries.reduce(
        (total, memory) => total + memory.content.length,
        0,
      ),
    ).toBeLessThanOrEqual(200)
    expect(result.entries).toHaveLength(1)
    expect(
      result.audit.filter(record => record.reason === 'budget'),
    ).toHaveLength(2)
  })

  it('paginates the complete valid bank when browsing derived memories', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          items: Array.from({ length: 100 }, (_, index) => ({
            id: `memory-${String(index)}`,
            text: `fact ${String(index)}`,
            fact_type: 'world',
            state: 'valid',
            tags: ['pegas:global'],
          })),
          total: 101,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: 'memory-100',
              text: 'last fact',
              fact_type: 'experience',
              state: 'valid',
              tags: ['pegas:global'],
            },
          ],
          total: 101,
        }),
      )
    const provider = new HindsightProvider({
      baseUrl: 'http://hindsight.local',
      fetch: request,
    })

    await expect(provider.list('bank')).resolves.toHaveLength(101)
    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('limit=100&offset=0&state=valid'),
      expect.any(Object),
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('limit=100&offset=100&state=valid'),
      expect.any(Object),
    )
  })

  it('retains a user correction with stable provenance', async () => {
    const retain = vi
      .fn<
        (
          bankId: string,
          input: Parameters<DerivedMemoryProvider['retain']>[1],
        ) => Promise<string>
      >()
      .mockResolvedValue('operation')
      .mockName('retain')
    const provider = { ...providerStub(), retain }
    const service = new PegasDerivedMemoryService(provider, {
      hmacKey: 'correction-key',
    })

    await expect(
      service.submitCorrection({
        id: 'correction-1',
        commandId: 'command-1',
        userId: 'owner',
        memoryId: 'old-fact',
        memoryType: 'world',
        replacementText: 'Use pnpm, not npm.',
        tags: ['pegas:global'],
        metadata: {},
        attempts: 1,
      }),
    ).resolves.toBe('operation')

    expect(retain).toHaveBeenCalledTimes(1)
    const [bankId, input] = retain.mock.calls[0] ?? []
    expect(bankId).toBe(service.bankId('owner'))
    expect(input).toMatchObject({
      operationId: 'correction-1',
      documentId: 'pegas:correction:correction-1',
      content: 'User correction:\nUse pnpm, not npm.',
      tags: ['pegas:global'],
      metadata: { correction_of: 'old-fact' },
    })
  })
})

function providerStub(): DerivedMemoryProvider {
  return {
    retain: vi.fn().mockResolvedValue('operation'),
    operationStatus: vi.fn().mockResolvedValue({ status: 'completed' }),
    recall: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockRejectedValue(new Error('not found')),
    invalidate: vi.fn().mockResolvedValue(undefined),
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
