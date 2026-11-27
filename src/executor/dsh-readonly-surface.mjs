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
  'read_task_state',
])

export const CONVERSATION_STATE_TOOL_NAMES = Object.freeze([
  'pegas_tasks',
  'pegas_memories',
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
 *     register: (definition: unknown) => unknown,
 *     guard: (guard: (execution: { name: string, arguments?: unknown }) =>
 *       { reason: string, info: { name: string, code: string } } | undefined) => void,
 *   },
 * }} ctx
 * @param {{ allow?: readonly string[], capability?: unknown,
 *   masker?: { mask: (text: string) => { text: string } } }} [config]
 */
export function apply(ctx, config = {}) {
  const capability = normalizeCapability(config.capability)
  const allowlist = new Set([
    ...(config.allow ?? READONLY_TOOL_NAMES),
    ...(capability ? CONVERSATION_STATE_TOOL_NAMES : []),
  ])
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
    if (capability) {
      for (const definition of conversationStateTools(capability, {
        ...(config.masker ? { masker: config.masker } : {}),
      })) {
        tools.register(definition)
      }
    }
  })
}

/**
 * @param {unknown} value
 * @returns {{ baseUrl: string, runId: string, claimToken: string,
 *   privacyMode: 'mask' | 'disabled' } | undefined}
 */
export function normalizeCapability(value) {
  if (value === null || typeof value !== 'object') return undefined
  const record = /** @type {Record<string, unknown>} */ (value)
  if (
    typeof record.baseUrl !== 'string' ||
    !record.baseUrl.startsWith('http') ||
    typeof record.runId !== 'string' ||
    !record.runId ||
    typeof record.claimToken !== 'string' ||
    !record.claimToken
  ) {
    return undefined
  }
  return {
    baseUrl: record.baseUrl,
    runId: record.runId,
    claimToken: record.claimToken,
    privacyMode: record.privacyMode === 'mask' ? 'mask' : 'disabled',
  }
}

const maximumProjectionBytes = 64 * 1024

/**
 * @typedef {{ baseUrl: string, runId: string, claimToken: string,
 *   privacyMode: 'mask' | 'disabled' }} StateCapability
 */

/**
 * Mask every string leaf of a parsed projection so nothing the server
 * returned crosses into the model transcript unmasked. Keys stay intact.
 * @param {unknown} value
 * @param {(text: string) => string} mask
 * @returns {unknown}
 */
export function maskProjectionStrings(value, mask) {
  if (typeof value === 'string') return mask(value)
  if (Array.isArray(value)) {
    return value.map(entry => maskProjectionStrings(entry, mask))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        maskProjectionStrings(entry, mask),
      ]),
    )
  }
  return value
}

/**
 * @param {{ baseUrl: string, runId: string, claimToken: string,
 *   privacyMode: 'mask' | 'disabled' }} capability
 * @param {{ masker?: { mask: (text: string) => { text: string } } }} [privacy]
 */
export function conversationStateTools(capability, privacy = {}) {
  /**
   * @param {'tasks' | 'memories'} resource
   * @param {AbortSignal} signal
   */
  const read = async (resource, signal) => {
    const url = `${capability.baseUrl}/v1/runs/${encodeURIComponent(
      capability.runId,
    )}/conversation-state/${resource}`
    const response = await fetch(url, {
      headers: { 'x-pegas-run-claim-token': capability.claimToken },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    })
    if (!response.ok) {
      throw new Error(
        `Pegas 状态读取失败（HTTP ${String(response.status)}）：${
          response.status === 403
            ? '当前会话的状态读取凭证无效或已过期'
            : '控制面暂时不可用，稍后再试'
        }`,
      )
    }
    const body = await response.text()
    if (Buffer.byteLength(body, 'utf8') > maximumProjectionBytes) {
      throw new Error('Pegas 状态投影超出大小上限，已截断拒绝')
    }
    if (capability.privacyMode === 'mask' && privacy.masker) {
      const masker = privacy.masker
      return JSON.stringify(
        maskProjectionStrings(JSON.parse(body), text => masker.mask(text).text),
      )
    }
    return body
  }
  const textOutput = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        json: {
          type: 'string',
          description: 'Authoritative JSON projection from the Pegas server.',
        },
      },
      required: ['json'],
    },
    /**
     * @param {unknown} _arguments
     * @param {{ json: string }} value
     */
    render: (_arguments, value) => [{ type: 'text', text: value.json }],
  }
  return [
    {
      name: 'pegas_tasks',
      description:
        '读取当前用户在 Pegas 中进行中/等待中的正式任务（事情）列表：标题、状态、等待用户回答的问题、最近交付与最近输入摘要。只读，无参数。回答"我的任务进展如何/哪些事在等我"这类问题时使用；数据是服务端权威事实，不要凭记忆编造。',
      parameters: {},
      output: textOutput,
      isConcurrencySafe: () => true,
      /**
       * @param {unknown} _arguments
       * @param {{ signal: AbortSignal }} exec
       */
      execute: async (_arguments, exec) => ({
        json: await read('tasks', exec.signal),
      }),
    },
    {
      name: 'pegas_memories',
      description:
        '读取当前用户在 Pegas 中保存的记忆条目（全局与任务级）：类别、内容与作用域。只读，无参数。prompt 注入的记忆之外需要核对更多记忆时使用；数据是服务端权威事实。',
      parameters: {},
      output: textOutput,
      isConcurrencySafe: () => true,
      /**
       * @param {unknown} _arguments
       * @param {{ signal: AbortSignal }} exec
       */
      execute: async (_arguments, exec) => ({
        json: await read('memories', exec.signal),
      }),
    },
  ]
}
