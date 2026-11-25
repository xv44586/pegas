import { describe, expect, it, vi } from 'vitest'

import type { ExecutorInput, RunExecutor } from '../src/executor/executor.js'
import type {
  JsonModelProvider,
  JsonModelRequest,
} from '../src/model/provider.js'
import { PrivacyMaskingExecutor } from '../src/privacy/executor.js'
import {
  DeterministicPrivacyMasker,
  type TextPrivacyMasker,
} from '../src/privacy/masker.js'
import { PrivacyMaskingProvider } from '../src/privacy/provider.js'

const hmacKey = ['privacy', 'test', 'key', 'value', '2026'].join('-')

describe('privacy egress boundaries', () => {
  it('masks provider requests and restores nested JSON responses', async () => {
    const email = ['owner', 'pegas.dev'].join('@')
    let observed: JsonModelRequest | undefined
    const provider: JsonModelProvider = {
      name: 'stub-model',
      generateJson(request) {
        observed = request
        return Promise.resolve({
          reason: `Matched ${request.input}`,
          nested: [request.system],
        })
      },
    }
    const wrapped = new PrivacyMaskingProvider(
      provider,
      new DeterministicPrivacyMasker({ hmacKey }),
    )

    const response = await wrapped.generateJson({
      system: `Route messages for ${email}`,
      input: `Email ${email}`,
    })

    expect(observed?.system).not.toContain(email)
    expect(observed?.input).not.toContain(email)
    expect(response).toEqual({
      reason: `Matched Email ${email}`,
      nested: [`Route messages for ${email}`],
    })
  })

  it('masks Executor prompts and restores progress and final output', async () => {
    const password = ['run', 'local', 'only', 'value'].join('-')
    let observedPrompt = ''
    const executor: RunExecutor = {
      name: 'stub-executor',
      execute(input) {
        observedPrompt = input.prompt
        input.onProgress?.({
          type: 'acknowledgement',
          text: `Working on ${input.prompt}`,
        })
        return Promise.resolve({
          executorRef: 'executor-1',
          output: `Finished ${input.prompt}`,
        })
      },
    }
    const wrapped = new PrivacyMaskingExecutor(
      executor,
      new DeterministicPrivacyMasker({ hmacKey }),
    )
    const progress = vi.fn()

    const result = await wrapped.execute({
      runId: 'run-1',
      taskId: 'task-1',
      prompt: `password=${password}`,
      workingDirectory: process.cwd(),
      onProgress: progress,
    })

    expect(observedPrompt).not.toContain(password)
    expect(progress).toHaveBeenCalledWith({
      type: 'acknowledgement',
      text: `Working on password=${password}`,
    })
    expect(result.output).toBe(`Finished password=${password}`)
  })

  it('fails closed before invoking a provider when masking fails', async () => {
    const generateJson = vi.fn(() => Promise.resolve({}))
    const provider: JsonModelProvider = {
      name: 'stub-model',
      generateJson,
    }
    const brokenMasker: TextPrivacyMasker = {
      mask() {
        throw new Error('masker unavailable')
      },
      restore(text) {
        return text
      },
    }
    const wrapped = new PrivacyMaskingProvider(provider, brokenMasker)

    await expect(
      wrapped.generateJson({ system: 'system', input: 'input' }),
    ).rejects.toThrow('masker unavailable')
    expect(generateJson).not.toHaveBeenCalled()
  })

  it('masks injected memories and work rules before they reach the Executor', async () => {
    const password = 'local-only-{{SECRET_2j5t7l3t}}'
    let observed: ExecutorInput | undefined
    const executor: RunExecutor = {
      name: 'stub-executor',
      execute(input) {
        observed = input
        return Promise.resolve({ executorRef: 'ref', output: 'done' })
      },
    }
    const wrapped = new PrivacyMaskingExecutor(
      executor,
      new DeterministicPrivacyMasker({ hmacKey }),
    )

    await wrapped.execute({
      runId: 'run-1',
      taskId: 'task-1',
      prompt: 'continue the work',
      workingDirectory: process.cwd(),
      memories: [
        {
          id: 'memory-1',
          scope: 'global',
          category: 'fact',
          content: `部署口令 password=${password}`,
          source: { kind: 'user_confirmation' },
        },
      ],
      workRules: {
        rules: [
          {
            title: '连接约定',
            content: `使用 password=${password} 连接`,
          },
        ],
        customInstructions: `secret=${password}`,
      },
    })

    expect(observed?.memories?.[0]?.content).not.toContain(password)
    expect(observed?.workRules?.rules[0]?.content).not.toContain(password)
    expect(observed?.workRules?.customInstructions).not.toContain(password)
    expect(observed?.memories?.[0]?.id).toBe('memory-1')
  })

  it('preserves Executor metadata and optional callbacks', async () => {
    let observed: ExecutorInput | undefined
    const executor: RunExecutor = {
      name: 'stub-executor',
      execute(input) {
        observed = input
        return Promise.resolve({ executorRef: 'ref', output: 'done' })
      },
    }
    const wrapped = new PrivacyMaskingExecutor(
      executor,
      new DeterministicPrivacyMasker({ hmacKey }),
    )

    await wrapped.execute({
      runId: 'run-1',
      taskId: 'task-1',
      prompt: 'ordinary input',
      workingDirectory: '/workspace',
      resumeSessionId: 'session-1',
    })

    expect(wrapped.name).toBe('stub-executor')
    expect(observed).toMatchObject({
      runId: 'run-1',
      taskId: 'task-1',
      prompt: 'ordinary input',
      workingDirectory: '/workspace',
      resumeSessionId: 'session-1',
    })
  })
})
