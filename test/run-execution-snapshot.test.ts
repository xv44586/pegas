import { describe, expect, it } from 'vitest'

import type { ExecutionContext } from '../src/core/domain.js'
import {
  decodeDshExecutionSnapshot,
  dshExecutorOptionsFromSnapshot,
} from '../src/worker/run-execution-snapshot.js'

const defaults = {
  executorProfile: 'current-profile',
  workspace: '/current-workspace',
  permissionMode: 'workspace-write',
  approvalPolicy: 'never' as const,
  additionalDirectories: ['/current-extra'],
  privacyMode: 'disabled' as const,
}

const validContext: ExecutionContext = {
  executor: 'dsh-headless',
  executorProfile: 'isolated-profile',
  workspace: '/snapshot-workspace',
  model: 'provider/with/slash/model/with/slash',
  modelMode: 'override',
  modelProvider: 'provider/with/slash',
  modelName: 'model/with/slash',
  permissions: JSON.stringify({
    mode: 'read-only',
    approvalPolicy: 'ask',
    additionalDirectories: ['/snapshot-extra'],
    privacyMode: 'mask',
  }),
  protocol: 'dsh-headless-v1',
  settingsRevision: 3,
  workerProfile: 'worker-profile:task-1',
  workerProfileRevision: 4,
  workerProfileSource: 'task',
}

describe('versioned Run execution snapshots', () => {
  it('keeps bound-directory contract v3 permissions frozen and rejects malformed snapshots', () => {
    const context = {
      ...validContext,
      nodeId: 'selected-node',
      workspaceBinding: { revision: 1 },
    }
    expect(
      decodeDshExecutionSnapshot(
        { executionContractVersion: 3, executionContext: context },
        defaults,
      ),
    ).toMatchObject({
      workspace: '/snapshot-workspace',
      permissionMode: 'read-only',
      approvalPolicy: 'ask',
      additionalDirectories: ['/snapshot-extra'],
    })
    expect(() =>
      decodeDshExecutionSnapshot(
        {
          executionContractVersion: 3,
          executionContext: { ...context, permissions: '{}' },
        },
        defaults,
      ),
    ).toThrow(/execution contract/)
  })

  it('decodes every persisted DSH option without consulting current defaults', () => {
    expect(
      decodeDshExecutionSnapshot(
        { executionContractVersion: 2, executionContext: validContext },
        defaults,
      ),
    ).toEqual({
      executorProfile: 'isolated-profile',
      workspace: '/snapshot-workspace',
      permissionMode: 'read-only',
      approvalPolicy: 'ask',
      additionalDirectories: ['/snapshot-extra'],
      privacyMode: 'mask',
      agentModel: {
        provider: 'provider/with/slash',
        model: 'model/with/slash',
      },
    })
  })

  it('builds the exact production DSH adapter options from the snapshot', () => {
    expect(
      dshExecutorOptionsFromSnapshot(
        decodeDshExecutionSnapshot(
          { executionContractVersion: 2, executionContext: validContext },
          defaults,
        ),
        { command: '/opt/dsh', timeoutMs: 42_000 },
      ),
    ).toEqual({
      command: '/opt/dsh',
      timeoutMs: 42_000,
      profile: 'isolated-profile',
      permissionMode: 'read-only',
      approvalPolicy: 'ask',
      additionalDirectories: ['/snapshot-extra'],
      agentModel: {
        provider: 'provider/with/slash',
        model: 'model/with/slash',
      },
    })
  })

  it('accepts an isolated profile model without an override', () => {
    const context = {
      ...validContext,
      model: 'profile',
      modelMode: 'profile' as const,
    }
    delete context.modelProvider
    delete context.modelName
    expect(
      decodeDshExecutionSnapshot(
        { executionContractVersion: 2, executionContext: context },
        defaults,
      ),
    ).not.toHaveProperty('agentModel')
  })

  it.each([
    ['missing workspace', { workspace: undefined }],
    ['wrong executor', { executor: 'echo' }],
    ['wrong protocol', { protocol: 'future-v9' }],
    ['missing settings revision', { settingsRevision: undefined }],
    ['invalid profile revision', { workerProfileRevision: 0 }],
    ['invalid profile source', { workerProfileSource: 'channel' }],
    ['inconsistent model display', { model: 'different/model' }],
    ['missing structured model', { modelName: undefined }],
    ['malformed permissions', { permissions: '{' }],
    [
      'unknown approval policy',
      {
        permissions: JSON.stringify({
          mode: 'read-only',
          approvalPolicy: 'sometimes',
          additionalDirectories: [],
          privacyMode: 'disabled',
        }),
      },
    ],
    [
      'unknown permission field',
      {
        permissions: JSON.stringify({
          mode: 'read-only',
          approvalPolicy: 'ask',
          additionalDirectories: [],
          privacyMode: 'disabled',
          allowEverything: true,
        }),
      },
    ],
  ])('fails closed for %s', (_name, patch) => {
    expect(() =>
      decodeDshExecutionSnapshot(
        {
          executionContractVersion: 2,
          executionContext: { ...validContext, ...patch } as ExecutionContext,
        },
        defaults,
      ),
    ).toThrow(/execution contract v2/)
  })

  it('keeps explicit legacy compatibility isolated to contract v1', () => {
    expect(
      decodeDshExecutionSnapshot(
        {
          executionContractVersion: 1,
          executionContext: {
            executor: 'dsh-headless',
            permissions: '{malformed',
          },
        },
        defaults,
      ),
    ).toEqual(defaults)
    expect(
      decodeDshExecutionSnapshot(
        {
          executionContractVersion: 1,
          executionContext: {
            executor: 'dsh-headless',
            model: 'legacy-provider/legacy/model',
          },
        },
        defaults,
      ).agentModel,
    ).toEqual({ provider: 'legacy-provider', model: 'legacy/model' })
  })
})
