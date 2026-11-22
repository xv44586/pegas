import { describe, expect, it } from 'vitest'

import {
  apply,
  READONLY_TOOL_NAMES,
  readonlyExecutor,
  surfaceDenial,
} from '../src/executor/dsh-readonly-surface.mjs'

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

function surfaceContext(): {
  ctx: Parameters<typeof apply>[0]
  guards: ToolGuard[]
  native: NativeExecutor
  originalDescribe: NativeExecutor['describe']
  nativeBatches: unknown[]
  disposers: (() => void)[]
} {
  const guards: ToolGuard[] = []
  const nativeBatches: unknown[] = []
  const disposers: (() => void)[] = []
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
      guard: (guard: ToolGuard) => {
        guards.push(guard)
      },
    },
  }
  return { ctx, guards, native, originalDescribe, nativeBatches, disposers }
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
