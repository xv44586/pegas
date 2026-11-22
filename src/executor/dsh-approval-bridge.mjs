import { createHash } from 'node:crypto'

/** @typedef {{ baseUrl: string, runId: string, claimToken: string }} BridgeCapability */
/** @typedef {{ actionId: string, tool: string, argumentsHash: string }} ToolGrant */
/** @typedef {{ tool: string, argumentsHash: string }} CapturedCall */
/** @typedef {{ callId?: string | number, name: string, arguments?: unknown }} ToolExecution */
/** @typedef {{ callId?: string | number, toolName: string, reason?: string, signal?: { aborted?: boolean } }} ApprovalRequest */
/** @typedef {{ kind: 'accept' | 'block' }} PostToolDecision */

export const name = 'pegas-approval-bridge'
export const inject = ['tools']

/**
 * @param {{ on: (event: string, listener: (...args: never[]) => unknown) => void }} ctx
 * @param {{ emit?: (event: Record<string, unknown>) => void, grant?: unknown }} [config]
 */
export function apply(ctx, config = {}) {
  const emit = typeof config.emit === 'function' ? config.emit : writeEvent
  const capability =
    process.env.PEGAS_APPROVAL_BRIDGE === '1'
      ? readCapability(process.env)
      : undefined
  const grant = normalizeGrant(config.grant ?? readGrant(process.env))
  /** @type {Map<string, CapturedCall>} */
  const toolCalls = new Map()
  /** @type {Map<string, string>} */
  const grantedCalls = new Map()
  let grantConsumed = false
  let parked = false

  ctx.on(
    'tools/pre-execute',
    /**
     * @param {ToolExecution} exec
     * @param {() => Promise<unknown>} next
     */
    (exec, next) => {
      if (exec.callId !== undefined) {
        toolCalls.set(String(exec.callId), {
          tool: exec.name,
          argumentsHash: stableHash(exec.arguments),
        })
      }
      return next()
    },
  )

  ctx.on(
    'approval/request',
    /**
     * @param {ApprovalRequest} request
     * @param {() => Promise<unknown>} next
     */
    async (request, next) => {
      if (request.signal?.aborted) return 'cancelled'
      const callKey =
        request.callId === undefined ? undefined : String(request.callId)
      const captured =
        callKey === undefined ? undefined : toolCalls.get(callKey)
      if (
        grant &&
        !grantConsumed &&
        callKey !== undefined &&
        captured?.tool === grant.tool &&
        captured.argumentsHash === grant.argumentsHash
      ) {
        grantConsumed = true
        grantedCalls.set(callKey, grant.actionId)
        return 'allowed-once'
      }
      if (!capability || callKey === undefined || parked) return next()
      parked = true
      const reason = request.reason ?? `工具 ${request.toolName} 请求越权执行`
      try {
        const pending = await createApproval(capability, {
          callKey,
          tool: request.toolName,
          reason,
          captured,
        })
        emit({
          type: 'approval_pending',
          callId: callKey,
          tool: request.toolName,
          actionId: pending.actionId,
          approvalId: pending.approvalId,
        })
      } catch (error) {
        emit({
          type: 'approval_bridge_error',
          stage: 'request',
          callId: callKey,
          message: errorMessage(error),
        })
      }
      return 'rejected'
    },
  )

  ctx.on(
    'tools/post-execute',
    /**
     * @param {ToolExecution} exec
     * @param {{ isError?: boolean }} result
     * @param {() => Promise<PostToolDecision>} next
     */
    async (exec, result, next) => {
      const decision = await next()
      const callKey =
        exec.callId === undefined ? undefined : String(exec.callId)
      const actionId =
        callKey === undefined ? undefined : grantedCalls.get(callKey)
      if (actionId !== undefined && callKey !== undefined && capability) {
        grantedCalls.delete(callKey)
        const failed = decision.kind === 'block' || result.isError === true
        try {
          await recordOutcome(capability, actionId, exec, failed)
        } catch (error) {
          emit({
            type: 'approval_bridge_error',
            stage: 'outcome',
            callId: callKey,
            actionId,
            message: errorMessage(error),
          })
        }
      }
      return decision
    },
  )
}

/** @param {Record<string, unknown>} event */
function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

/**
 * @param {NodeJS.ProcessEnv} environment
 * @returns {BridgeCapability | undefined}
 */
function readCapability(environment) {
  const baseUrl = environment.PEGAS_CONTROL_PLANE_URL
  const runId = environment.PEGAS_RUN_ID
  const claimToken = environment.PEGAS_RUN_CLAIM_TOKEN
  if (!baseUrl || !runId || !claimToken) return undefined
  return { baseUrl, runId, claimToken }
}

/**
 * @param {NodeJS.ProcessEnv} environment
 * @returns {unknown}
 */
function readGrant(environment) {
  const raw = environment.PEGAS_TOOL_APPROVAL_GRANT
  if (!raw) return undefined
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(raw)
    return parsed
  } catch {
    return undefined
  }
}

/**
 * @param {unknown} value
 * @returns {ToolGrant | undefined}
 */
function normalizeGrant(value) {
  if (
    value &&
    typeof value === 'object' &&
    'actionId' in value &&
    'tool' in value &&
    'argumentsHash' in value &&
    typeof value.actionId === 'string' &&
    typeof value.tool === 'string' &&
    typeof value.argumentsHash === 'string'
  ) {
    return {
      actionId: value.actionId,
      tool: value.tool,
      argumentsHash: value.argumentsHash,
    }
  }
  return undefined
}

/**
 * @param {BridgeCapability} capability
 * @param {{ callKey: string, tool: string, reason: string, captured?: CapturedCall }} input
 * @returns {Promise<{ actionId: string, approvalId: string }>}
 */
async function createApproval(capability, input) {
  const action = {
    kind: `dsh.tool.${input.tool}`,
    risk: 'high',
    idempotencyKey: `dsh-tool:${capability.runId}:${input.callKey}`,
    request: {
      tool: input.tool,
      callId: input.callKey,
      reason: input.reason,
      argumentsHash: input.captured?.argumentsHash ?? null,
    },
    recoveryPoint: { step: 'before_tool_call', callId: input.callKey },
    approval: {
      summary: `批准工具 ${input.tool} 越权执行一次`,
      impact: input.reason,
      recommendedOptionId: 'approve',
      options: [
        { id: 'approve', label: '批准执行一次', kind: 'approve' },
        { id: 'reject', label: '不执行', kind: 'reject' },
      ],
    },
  }
  const response = await post(
    capability,
    `/v1/runs/${capability.runId}/approvals`,
    { action },
  )
  if (
    !response ||
    typeof response !== 'object' ||
    !('action' in response) ||
    !('approval' in response) ||
    !isRecordOrAbsent(response.action) ||
    !isRecordOrAbsent(response.approval)
  ) {
    throw new Error('approval API response is missing identifiers')
  }
  const actionId = response.action?.id
  const approvalId = response.approval?.id
  if (typeof actionId !== 'string' || typeof approvalId !== 'string') {
    throw new Error('approval API response is missing identifiers')
  }
  return { actionId, approvalId }
}

/**
 * @param {BridgeCapability} capability
 * @param {string} actionId
 * @param {{ name: string, callId?: string | number }} exec
 * @param {boolean} failed
 */
async function recordOutcome(capability, actionId, exec, failed) {
  await post(capability, `/v1/actions/${actionId}/outcomes`, {
    commandId: `dsh-tool-outcome:${actionId}`,
    status: failed ? 'failed' : 'succeeded',
    result: {
      tool: exec.name,
      callId: String(exec.callId),
      summary: failed
        ? '批准的工具调用执行失败。'
        : '批准的工具调用已执行一次。',
    },
  })
}

/**
 * @param {BridgeCapability} capability
 * @param {string} path
 * @param {unknown} payload
 * @returns {Promise<unknown>}
 */
async function post(capability, path, payload) {
  const body = JSON.stringify(payload)
  /** @type {unknown} */
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${capability.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pegas-run-claim-token': capability.claimToken,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        throw new Error(`Pegas API returned ${String(response.status)}`)
      }
      /** @type {unknown} */
      const parsed = await response.json()
      return parsed
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** @param {unknown} value */
function stableHash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    /** @type {Record<string, unknown>} */
    const record = { ...value }
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  /** @type {unknown} */
  const text = JSON.stringify(value)
  return typeof text === 'string' ? text : 'null'
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown> | undefined}
 */
function isRecordOrAbsent(value) {
  return (
    value === undefined ||
    (typeof value === 'object' && value !== null && !Array.isArray(value))
  )
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
