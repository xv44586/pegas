/**
 * EXEC-005 conversation-lane read-only tool surface. Two independent
 * enforcement layers on top of the DSH read-only sandbox:
 *
 * 1. Catalog masking: the native executor object stays registered (its
 *    identity keeps executor-owned prompt sections alive), but its
 *    `describe` is wrapped in place so the model-facing catalog only
 *    carries the read-only allowlist. `execute` is untouched: dispatch
 *    keeps the exact native pipeline, scoped child tools, and session
 *    logging semantics. The original describe is restored on disposal.
 * 2. Monotonic execution guards: any dispatch of a tool outside the
 *    allowlist is denied before its body runs, and `working_directory` may
 *    read the cwd but never change it. Guards cannot be turned back into
 *    permission by listener ordering.
 *
 * The overlay is inserted after the profile layer, so the native tool
 * executor may still be mounting when this plugin applies; the body waits
 * for the `tools` service through `ctx.inject` before mounting.
 */

export const name = 'pegas-readonly-surface'
export const inject = ['tools']

export const READONLY_TOOL_NAMES = Object.freeze([
  'read',
  'read_image',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
  'working_directory',
])

const denialReason =
  '此会话是只读即时应答车道：该工具不在只读工具面内，调用已被拒绝。不要重试或寻找绕行方式；如果请求需要写文件、执行命令、委派或外部副作用，请直接向用户说明，并按对话合同输出 PEGAS_SUGGEST_TASK_BEGIN/END 升级标记，把它交给完整任务处理。'

const cdDenialReason =
  '此会话是只读即时应答车道：working_directory 只能读取当前目录，不能 cd 切换。请用绝对路径读取目标位置；需要改变工作目录的工作请升级为完整任务。'

const denied = {
  name: 'PegasReadonlySurfaceError',
  code: 'PEGAS_READONLY_SURFACE_DENIED',
}

/**
 * @param {{ name: string, arguments?: unknown }} execution
 * @param {ReadonlySet<string>} allowlist
 */
export function surfaceDenial(execution, allowlist) {
  if (!allowlist.has(execution.name)) {
    return { reason: denialReason, info: denied }
  }
  if (execution.name === 'working_directory') {
    const arguments_ = execution.arguments
    if (
      arguments_ !== null &&
      typeof arguments_ === 'object' &&
      'cd' in arguments_ &&
      arguments_.cd !== undefined
    ) {
      return { reason: cdDenialReason, info: denied }
    }
  }
  return undefined
}

/**
 * @param {ReadonlySet<string>} allowlist
 * @param {{
 *   describe: (tools: readonly { name: string }[]) => Record<string, unknown>,
 *   execute: (input: unknown) => Promise<unknown>,
 * }} native
 */
export function readonlyExecutor(allowlist, native) {
  return {
    /**
     * @param {readonly { name: string }[]} visible
     */
    describe: visible => {
      const projected = native.describe(
        visible.filter(tool => allowlist.has(tool.name)),
      )
      const knownNames = projected.knownNames
      return Array.isArray(knownNames)
        ? {
            ...projected,
            knownNames: knownNames.filter((/** @type {unknown} */ entry) =>
              typeof entry === 'string'
                ? allowlist.has(entry)
                : entry !== null &&
                  typeof entry === 'object' &&
                  'name' in entry &&
                  typeof entry.name === 'string' &&
                  allowlist.has(entry.name),
            ),
          }
        : projected
    },
    /**
     * @param {unknown} input
     */
    execute: input => native.execute(input),
  }
}

/**
 * @param {{
 *   inject: (deps: string[], callback: (ctx: unknown) => void) => unknown,
 *   effect: (execute: () => () => void) => unknown,
 *   tools: {
 *     selectExecutor: (scope?: unknown) => {
 *       describe: (tools: readonly { name: string }[]) => Record<string, unknown>,
 *       execute: (input: unknown) => Promise<unknown>,
 *     },
 *     guard: (guard: (execution: { name: string, arguments?: unknown }) =>
 *       { reason: string, info: { name: string, code: string } } | undefined) => void,
 *   },
 * }} ctx
 * @param {{ allow?: readonly string[] }} [config]
 */
export function apply(ctx, config = {}) {
  const allowlist = new Set(config.allow ?? READONLY_TOOL_NAMES)
  ctx.inject(['tools'], () => {
    const tools = ctx.tools
    const native = tools.selectExecutor()
    const projected = readonlyExecutor(allowlist, {
      describe: native.describe.bind(native),
      execute: native.execute.bind(native),
    })
    const originalDescribe = native.describe
    native.describe = projected.describe
    ctx.effect(() => () => {
      native.describe = originalDescribe
    })
    tools.guard(execution => surfaceDenial(execution, allowlist))
  })
}
