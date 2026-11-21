import { describe, expect, it } from 'vitest'

import {
  collaborationRequestFingerprint,
  intersectContextNoteAuthority,
  parseWorkerCollaborationRequest,
} from '../src/collaboration/collaboration.js'

describe('worker collaboration requests', () => {
  it.each([
    {
      commandId: 'delegate-1',
      kind: 'delegate',
      goal: 'Research the API',
      reason: 'Independent work',
      expectedOutput: 'A concise report',
      contextRefs: ['event-1', 'run-1'],
    },
    {
      commandId: 'handoff-1',
      kind: 'handoff',
      goal: 'Own the remaining migration',
      reason: 'The target scope changed',
      contextRefs: [],
    },
    {
      commandId: 'note-1',
      kind: 'context_note',
      targetChannelId: 'task-2',
      text: 'The provider requires exact casing.',
      sourceRefs: ['evidence-1'],
    },
    {
      commandId: 'handback-1',
      kind: 'handback',
      inputEventId: 'event-1',
      reason: 'This input belongs to another goal.',
    },
  ])('parses $kind without adding hidden routing authority', request => {
    expect(parseWorkerCollaborationRequest(request)).toEqual(request)
  })

  it('rejects direct session, executor, and permission selection', () => {
    expect(() =>
      parseWorkerCollaborationRequest({
        commandId: 'delegate-unsafe',
        kind: 'delegate',
        goal: 'Do work',
        reason: 'Parallelize',
        expectedOutput: 'Result',
        contextRefs: [],
        targetExecutorSession: 'session-other',
      }),
    ).toThrow(/Unknown collaboration field/)
  })

  it('rejects duplicate and oversized reference lists', () => {
    expect(() =>
      parseWorkerCollaborationRequest({
        commandId: 'delegate-duplicate',
        kind: 'delegate',
        goal: 'Do work',
        reason: 'Parallelize',
        expectedOutput: 'Result',
        contextRefs: ['same', 'same'],
      }),
    ).toThrow(/must not contain duplicates/)
    expect(() =>
      parseWorkerCollaborationRequest({
        commandId: 'delegate-fanout',
        kind: 'delegate',
        goal: 'Do work',
        reason: 'Parallelize',
        expectedOutput: 'Result',
        contextRefs: Array.from({ length: 65 }, (_, index) => String(index)),
      }),
    ).toThrow(/at most 64/)
  })

  it('generates a stable command fingerprint that changes with payload', () => {
    const first = parseWorkerCollaborationRequest({
      commandId: 'delegate-stable',
      kind: 'delegate',
      goal: 'Do work',
      reason: 'Parallelize',
      expectedOutput: 'Result',
      contextRefs: ['run-1'],
    })
    const same = { ...first }
    const changed = { ...first, goal: 'Different work' }
    expect(collaborationRequestFingerprint(first)).toBe(
      collaborationRequestFingerprint(same),
    )
    expect(collaborationRequestFingerprint(changed)).not.toBe(
      collaborationRequestFingerprint(first),
    )
  })

  it.each([
    {
      name: 'workspace mismatch',
      source: context({ workspace: '/source' }),
      target: context({ workspace: '/target' }),
      message: 'incompatible',
    },
    {
      name: 'executor profile mismatch',
      source: context({ executorProfile: 'source-profile' }),
      target: context({ executorProfile: 'target-profile' }),
      message: 'incompatible',
    },
    {
      name: 'missing source workspace',
      source: context({ workspace: undefined }),
      target: context(),
      message: 'incompatible',
    },
    {
      name: 'missing target executor profile',
      source: context(),
      target: context({ executorProfile: undefined }),
      message: 'incompatible',
    },
    {
      name: 'missing source permissions',
      source: context({ permissions: undefined }),
      target: context(),
      message: 'incompatible',
    },
    {
      name: 'missing target permissions',
      source: context(),
      target: context({ permissions: undefined }),
      message: 'incompatible',
    },
    {
      name: 'malformed permission JSON',
      source: context({ permissions: '{' }),
      target: context(),
      message: 'malformed',
    },
    {
      name: 'unknown permission field',
      source: context({
        permissions: JSON.stringify({
          ...permissions(),
          hiddenAuthority: true,
        }),
      }),
      target: context(),
      message: 'malformed',
    },
    {
      name: 'incomplete permission object',
      source: context({
        permissions: JSON.stringify({ mode: 'read-only' }),
      }),
      target: context(),
      message: 'malformed',
    },
  ])('fails closed for context-note authority: $name', variant => {
    expect(() =>
      intersectContextNoteAuthority(
        variant.source,
        variant.target,
        'source-run',
      ),
    ).toThrow(variant.message)
  })
})

function context(
  overrides: Partial<{
    executor: string
    executorProfile: string
    workspace: string
    protocol: string
    permissions: string
  }> = {},
) {
  return {
    executor: 'test-executor',
    executorProfile: 'shared-profile',
    workspace: '/shared',
    protocol: 'shared-protocol',
    permissions: JSON.stringify(permissions()),
    ...overrides,
  }
}

function permissions() {
  return {
    mode: 'workspace-write',
    approvalPolicy: 'ask',
    additionalDirectories: ['/shared'],
    privacyMode: 'mask',
  }
}
