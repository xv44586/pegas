import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  apply,
  CONVERSATION_STATE_TOOL_NAMES,
  conversationStateTools,
  maskProjectionStrings,
  normalizeCapability,
  READONLY_TOOL_NAMES,
  readonlyExecutor,
  surfaceDenial,
} from '../src/executor/dsh-readonly-surface.mjs'
import { DeterministicPrivacyMasker } from '../src/privacy/masker.js'

interface GuardDenial {
  reason: string
  info: { name: string; code: string }
}

type ToolGuard = (execution: {
  name: string
  arguments?: unknown
}) => GuardDenial | undefined

interface NativeExecutor {
  describe: (tools: readonly { name: string }[]) => Record<string, unknown>
  execute: (input: unknown) => Promise<unknown>
}

interface StateToolDefinition {
  name: string
  execute: (
    arguments_: unknown,
    exec: { signal: AbortSignal },
  ) => Promise<{ json: string }>
}

const capability = {
  baseUrl: 'http://127.0.0.1:4317',
  runId: 'run-chat',
  claimToken: 'claim-secret',
  privacyMode: 'disabled',
} as const

function surfaceContext(): {
  ctx: Parameters<typeof apply>[0]
  guards: ToolGuard[]
  native: NativeExecutor
  originalDescribe: NativeExecutor['describe']
  nativeBatches: unknown[]
  disposers: (() => void)[]
  registered: StateToolDefinition[]
} {
  const guards: ToolGuard[] = []
  const nativeBatches: unknown[] = []
  const disposers: (() => void)[] = []
  const registered: StateToolDefinition[] = []
  const native: NativeExecutor = {
    describe: tools => ({
      schemas: tools.map(tool => ({ name: tool.name })),
      knownNames: tools.map(tool => tool.name),
    }),
    execute: input => {
      nativeBatches.push(input)
      return Promise.resolve({
        results: [],
        additionalContexts: [],
        concluded: false,
      })
    },
  }
  const originalDescribe = native.describe
  const ctx = {
    inject: (_deps: string[], callback: (ctx: unknown) => void) => {
      callback(ctx)
    },
    effect: (execute: () => () => void) => {
      disposers.push(execute())
    },
    tools: {
      selectExecutor: () => native,
      register: (definition: unknown) => {
        registered.push(definition as StateToolDefinition)
      },
      guard: (guard: ToolGuard) => {
        guards.push(guard)
      },
    },
  }
  return {
    ctx,
    guards,
    native,
    originalDescribe,
    nativeBatches,
    disposers,
    registered,
  }
}

describe('DSH read-only tool surface plugin', () => {
  it('masks the native describe in place down to the read-only allowlist', () => {
    const harness = surfaceContext()
    apply(harness.ctx)
    const visible = [
      ...READONLY_TOOL_NAMES.map(name => ({ name })),
      { name: 'write' },
      { name: 'edit' },
      { name: 'apply_patch' },
      { name: 'bash' },
      { name: 'subagent' },
      { name: 'todo_write' },
    ]
    const described = harness.native.describe(visible) as {
      schemas: { name: string }[]
      knownNames: string[]
    }
    expect(described.schemas.map(schema => schema.name)).toEqual([
      ...READONLY_TOOL_NAMES,
    ])
    expect(described.knownNames).toEqual([...READONLY_TOOL_NAMES])
  })

  it('restores the original describe when the plugin disposes', () => {
    const harness = surfaceContext()
    apply(harness.ctx)
    expect(harness.native.describe).not.toBe(harness.originalDescribe)
    for (const dispose of harness.disposers) dispose()
    expect(harness.native.describe).toBe(harness.originalDescribe)
  })

  it('filters object-shaped knownNames entries as well', () => {
    const native: NativeExecutor = {
      describe: tools => ({
        schemas: tools,
        knownNames: tools.map(tool => ({ name: tool.name })),
      }),
      execute: () => Promise.resolve({}),
    }
    const projected = readonlyExecutor(new Set(['read']), native)
    const described = projected.describe([
      { name: 'read' },
      { name: 'bash' },
    ]) as { knownNames: { name: string }[] }
    expect(described.knownNames).toEqual([{ name: 'read' }])
  })

  it('denies every dispatch outside the allowlist before the tool body runs', () => {
    const harness = surfaceContext()
    apply(harness.ctx)
    expect(harness.guards).toHaveLength(1)
    const guard = harness.guards[0]
    if (!guard) throw new Error('Expected the surface guard')
    for (const name of ['write', 'edit', 'apply_patch', 'bash', 'subagent']) {
      const denial = guard({ name, arguments: {} })
      expect(denial?.info.code).toBe('PEGAS_READONLY_SURFACE_DENIED')
      expect(denial?.reason).toContain('PEGAS_SUGGEST_TASK_BEGIN')
    }
    for (const name of READONLY_TOOL_NAMES) {
      expect(guard({ name, arguments: {} })).toBeUndefined()
    }
  })

  it('allows reading the working directory but denies changing it', () => {
    const allowlist = new Set<string>(READONLY_TOOL_NAMES)
    expect(
      surfaceDenial({ name: 'working_directory', arguments: {} }, allowlist),
    ).toBeUndefined()
    const denial = surfaceDenial(
      { name: 'working_directory', arguments: { cd: '/etc' } },
      allowlist,
    )
    expect(denial?.info.code).toBe('PEGAS_READONLY_SURFACE_DENIED')
    expect(denial?.reason).toContain('不能 cd')
  })

  it('delegates batches to the untouched native execute', async () => {
    const harness = surfaceContext()
    const originalExecute = harness.native.execute
    apply(harness.ctx)
    expect(harness.native.execute).toBe(originalExecute)
    const batch = { calls: [], signal: new AbortController().signal }
    await harness.native.execute(batch)
    expect(harness.nativeBatches).toEqual([batch])
  })

  it('honours a configured allowlist override', () => {
    const harness = surfaceContext()
    apply(harness.ctx, { allow: ['read'] })
    const guard = harness.guards[0]
    if (!guard) throw new Error('Expected the surface guard')
    expect(guard({ name: 'read', arguments: {} })).toBeUndefined()
    expect(guard({ name: 'grep', arguments: {} })?.info.code).toBe(
      'PEGAS_READONLY_SURFACE_DENIED',
    )
    const described = harness.native.describe([
      { name: 'read' },
      { name: 'grep' },
    ]) as { schemas: { name: string }[] }
    expect(described.schemas).toEqual([{ name: 'read' }])
  })
})

describe('conversation state tools', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('normalizes only complete http capabilities and defaults privacy to disabled', () => {
    expect(normalizeCapability(undefined)).toBeUndefined()
    expect(normalizeCapability(null)).toBeUndefined()
    expect(
      normalizeCapability({ ...capability, baseUrl: 'ftp://x' }),
    ).toBeUndefined()
    expect(normalizeCapability({ ...capability, runId: '' })).toBeUndefined()
    expect(
      normalizeCapability({ ...capability, claimToken: '' }),
    ).toBeUndefined()
    expect(
      normalizeCapability({ ...capability, privacyMode: 'weird' }),
    ).toEqual(capability)
    expect(normalizeCapability({ ...capability, privacyMode: 'mask' })).toEqual(
      { ...capability, privacyMode: 'mask' },
    )
  })

  it('registers the state tools and opens the guard only with a capability', () => {
    const plain = surfaceContext()
    apply(plain.ctx)
    expect(plain.registered).toHaveLength(0)
    const plainGuard = plain.guards[0]
    if (!plainGuard) throw new Error('Expected the surface guard')
    for (const name of CONVERSATION_STATE_TOOL_NAMES) {
      expect(plainGuard({ name, arguments: {} })?.info.code).toBe(
        'PEGAS_READONLY_SURFACE_DENIED',
      )
    }

    const wired = surfaceContext()
    apply(wired.ctx, { capability })
    expect(wired.registered.map(tool => tool.name)).toEqual([
      ...CONVERSATION_STATE_TOOL_NAMES,
    ])
    const wiredGuard = wired.guards[0]
    if (!wiredGuard) throw new Error('Expected the surface guard')
    for (const name of CONVERSATION_STATE_TOOL_NAMES) {
      expect(wiredGuard({ name, arguments: {} })).toBeUndefined()
    }
    expect(wiredGuard({ name: 'bash', arguments: {} })?.info.code).toBe(
      'PEGAS_READONLY_SURFACE_DENIED',
    )
  })

  it('ignores malformed capabilities instead of half-registering tools', () => {
    const harness = surfaceContext()
    apply(harness.ctx, { capability: { baseUrl: 'http://x' } })
    expect(harness.registered).toHaveLength(0)
    const guard = harness.guards[0]
    if (!guard) throw new Error('Expected the surface guard')
    expect(guard({ name: 'pegas_tasks', arguments: {} })?.info.code).toBe(
      'PEGAS_READONLY_SURFACE_DENIED',
    )
  })

  it('masks every string leaf of a projection while keeping keys and structure', () => {
    const masked = maskProjectionStrings(
      {
        tasks: [{ title: 'a', awaiting: null, count: 2 }],
        note: 'b',
      },
      text => `masked:${text}`,
    )
    expect(masked).toEqual({
      tasks: [{ title: 'masked:a', awaiting: null, count: 2 }],
      note: 'masked:b',
    })
  })

  it('reads the authoritative projection with the run claim header', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ tasks: [] }), { status: 200 }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const [tasks] = conversationStateTools(capability)
    if (!tasks) throw new Error('Expected the pegas_tasks definition')
    const result = await tasks.execute(
      {},
      { signal: new AbortController().signal },
    )
    expect(JSON.parse(result.json)).toEqual({ tasks: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0] as unknown as
      [string, { headers: Record<string, string> }] | undefined
    if (!call) throw new Error('Expected the fetch call')
    expect(call[0]).toBe(
      'http://127.0.0.1:4317/v1/runs/run-chat/conversation-state/tasks',
    )
    expect(call[1].headers['x-pegas-run-claim-token']).toBe('claim-secret')
  })

  it('masks projection secrets before they reach the transcript in mask mode', async () => {
    const masker = new DeterministicPrivacyMasker({
      hmacKey: 'test-hmac-key-0123456789',
    })
    const secret = 'sk-abcdef1234567890abcdef'
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ tasks: [{ title: `key ${secret}` }] }),
            {
              status: 200,
            },
          ),
        ),
      ),
    )
    const [tasks] = conversationStateTools(
      { ...capability, privacyMode: 'mask' },
      { masker },
    )
    if (!tasks) throw new Error('Expected the pegas_tasks definition')
    const result = await tasks.execute(
      {},
      { signal: new AbortController().signal },
    )
    expect(result.json).not.toContain(secret)
    expect(result.json).toContain('{{API_KEY_')
  })

  it('surfaces claim rejection and refuses oversized projections', async () => {
    const [tasks] = conversationStateTools(capability)
    if (!tasks) throw new Error('Expected the pegas_tasks definition')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('no', { status: 403 }))),
    )
    await expect(
      tasks.execute({}, { signal: new AbortController().signal }),
    ).rejects.toThrow('凭证无效或已过期')
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('x'.repeat(64 * 1024 + 1), { status: 200 }),
        ),
      ),
    )
    await expect(
      tasks.execute({}, { signal: new AbortController().signal }),
    ).rejects.toThrow('大小上限')
  })
})
