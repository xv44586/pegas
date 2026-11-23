import { createHash } from 'node:crypto'

import { classifyToolCall } from './policy-gate.mjs'

/** @typedef {{ baseUrl: string, runId: string, claimToken: string }} BridgeCapability */
/** @typedef {{ actionId: string, tool: string, argumentsHash: string }} ToolGrant */
/** @typedef {{ tool: string, argumentsHash: string, classification?: import('./policy-gate.d.ts').ToolCallClassification }} CapturedCall */
/** @typedef {{ callId?: string | number, name: string, arguments?: unknown, agent?: unknown }} ToolExecution */
/** @typedef {{ callId?: string | number, toolName: string, reason?: string, signal?: { aborted?: boolean } }} ApprovalRequest */
/** @typedef {{ kind: 'accept' | 'block' }} PostToolDecision */
/** @typedef {{ kind: 'allow' } | { kind: 'ask', reason: string } | { kind: 'deny', reason: string }} PreToolGate */

export const name = 'pegas-approval-bridge'
export const inject = ['tools']

/**
 * @param {{ on: (event: string, listener: (...args: never[]) => unknown) => void, tools?: { guard: (guard: (exec: ToolExecution) => { reason: string } | undefined) => unknown } }} ctx
 * @param {{ emit?: (event: Record<string, unknown>) => void, grant?: unknown, policy?: unknown }} [config]
 */
export function apply(ctx, config = {}) {
  const emit = typeof config.emit === 'function' ? config.emit : writeEvent
  const capability =
    process.env.PEGAS_APPROVAL_BRIDGE === '1'
      ? readCapability(process.env)
      : undefined
  const grant = normalizeGrant(config.grant ?? readGrant(process.env))
  const policy = normalizePolicy(config.policy)
  /** @type {Map<string, CapturedCall>} */
  const toolCalls = new Map()
  /** @type {Map<string, string>} */
  const grantedCalls = new Map()
  /** @type {Map<string, import('./policy-gate.d.ts').ToolCallClassification>} */
  const gateDecisions = new Map()
  /** @type {Map<string, { tier: string, generation: string, mismatch: boolean }>} */
  const gateTiers = new Map()
  let grantConsumed = false
  let parked = false

  const controlPlaneGuard =
    /** @param {ToolExecution} exec */
    exec => {
      const classification = classifyToolCall(exec, policy)
      if (classification.category === 'control-plane-mutation') {
        return {
          reason: classification.reason,
        }
      }
      return undefined
    }
  if (ctx.tools && typeof ctx.tools.guard === 'function') {
    ctx.tools.guard(controlPlaneGuard)
  }

  ctx.on(
    'tools/pre-execute',
    /**
     * @param {ToolExecution} exec
     * @param {() => Promise<PreToolGate>} next
     */
    async (exec, next) => {
      const callKey =
        exec.callId === undefined ? undefined : String(exec.callId)
      const tierState = capability
        ? await readTierState(capability)
        : {
            tier: /** @type {const} */ ('standard'),
            generation: '',
            mismatch: false,
          }
      const classification = classifyToolCall(exec, policy, tierState.tier)
      if (callKey !== undefined) {
        toolCalls.set(callKey, {
          tool: exec.name,
          argumentsHash: stableHash(exec.arguments),
          classification,
        })
        gateDecisions.set(callKey, classification)
        gateTiers.set(callKey, {
          tier: tierState.tier,
          generation: tierState.generation,
          mismatch: tierState.mismatch,
        })
      }
      if (capability && callKey !== undefined) {
        const granted =
          grant !== undefined &&
          !grantConsumed &&
          classification.category !== 'control-plane-mutation' &&
          exec.name === grant.tool &&
          stableHash(exec.arguments) === grant.argumentsHash
        if (granted) {
          grantConsumed = true
          grantedCalls.set(callKey, grant.actionId)
          return next()
        }
        if (classification.action === 'allow') {
          emit({
            type: 'policy_decision',
            callId: callKey,
            tool: exec.name,
            category: classification.category,
            risk: classification.risk,
            decision: 'allow',
            reason: classification.reason,
            tier: tierState.tier,
            generation: tierState.generation,
            mismatch: tierState.mismatch,
          })
          return next()
        }
        if (classification.action === 'deny') {
          emit({
            type: 'policy_decision',
            callId: callKey,
            tool: exec.name,
            category: classification.category,
            risk: classification.risk,
            decision: 'deny',
            reason: classification.reason,
            tier: tierState.tier,
            generation: tierState.generation,
            mismatch: tierState.mismatch,
          })
          return { kind: 'deny', reason: classification.reason }
        }
        emit({
          type: 'policy_decision',
          callId: callKey,
          tool: exec.name,
          category: classification.category,
          risk: classification.risk,
          decision: 'ask',
          reason: classification.reason,
          tier: tierState.tier,
          generation: tierState.generation,
          mismatch: tierState.mismatch,
        })
        if (exec.agent !== undefined) {
          return { kind: 'ask', reason: classification.reason }
        }
        try {
          const pending = await parkCall(
            capability,
            callKey,
            exec.name,
            classification,
            toolCalls.get(callKey),
            emit,
          )
          if (pending) parked = true
        } catch (error) {
          emit({
            type: 'approval_bridge_error',
            stage: 'request',
            callId: callKey,
            message: errorMessage(error),
          })
        }
        return { kind: 'deny', reason: classification.reason }
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
      const classification =
        callKey === undefined ? undefined : gateDecisions.get(callKey)
      if (classification?.category === 'control-plane-mutation') {
        if (!capability || callKey === undefined || parked) return 'rejected'
        parked = true
        try {
          const pending = await parkCall(
            capability,
            callKey,
            request.toolName,
            classification,
            captured,
            emit,
            gateTiers.get(callKey),
          )
          if (!pending) parked = false
        } catch (error) {
          emit({
            type: 'approval_bridge_error',
            stage: 'request',
            callId: callKey,
            message: errorMessage(error),
          })
        }
        return 'rejected'
      }
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
      if (callKey !== undefined && grantedCalls.has(callKey)) {
        return 'allowed-once'
      }
      if (!capability || callKey === undefined || parked) return next()
      parked = true
      const reason = request.reason ?? `工具 ${request.toolName} 请求越权执行`
      try {
        const pending = await parkCall(
          capability,
          callKey,
          request.toolName,
          classification?.action === 'ask'
            ? classification
            : escalateClassification(reason),
          captured,
          emit,
          gateTiers.get(callKey),
        )
        if (!pending) parked = false
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

/**
 * @param {string} reason
 * @returns {import('./policy-gate.d.ts').ToolCallClassification}
 */
function escalateClassification(reason) {
  return {
    category: 'out-of-workspace-write',
    risk: 'high',
    action: 'ask',
    reason,
    targets: [],
  }
}

/**
 * @param {BridgeCapability} capability
 * @param {string} callKey
 * @param {string} tool
 * @param {import('./policy-gate.d.ts').ToolCallClassification} classification
 * @param {CapturedCall | undefined} captured
 * @param {(event: Record<string, unknown>) => void} emit
 * @param {{ tier: string, generation: string, mismatch: boolean } | undefined} [tierState]
 * @returns {Promise<boolean>}
 */
async function parkCall(
  capability,
  callKey,
  tool,
  classification,
  captured,
  emit,
  tierState,
) {
  const pending = await createApproval(capability, {
    callKey,
    tool,
    classification,
    captured,
    tierState,
  })
  emit({
    type: 'approval_pending',
    callId: callKey,
    tool,
    actionId: pending.actionId,
    approvalId: pending.approvalId,
  })
  return true
}

/** @param {Record<string, unknown>} event */
function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

/**
 * @param {BridgeCapability} capability
 * @returns {Promise<{ tier: import('./policy-gate.d.ts').PolicyTier, generation: string, mismatch: boolean }>}
 */
async function readTierState(capability) {
  try {
    const response = await fetch(
      `${capability.baseUrl}/v1/runs/${capability.runId}/permissions`,
      {
        headers: { 'x-pegas-run-claim-token': capability.claimToken },
        signal: AbortSignal.timeout(3_000),
      },
    )
    if (!response.ok) throw new Error(`tier read ${String(response.status)}`)
    const projection = /** @type {Record<string, unknown>} */ (
      await response.json()
    )
    const tier = projection.effectiveTier
    if (tier !== 'strict' && tier !== 'standard' && tier !== 'full') {
      throw new Error('tier read returned an invalid tier')
    }
    return {
      tier,
      generation:
        typeof projection.generation === 'string' ? projection.generation : '',
      mismatch: projection.mismatch === true,
    }
  } catch {
    return { tier: 'strict', generation: '', mismatch: true }
  }
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
 * @param {unknown} value
 * @returns {import('./policy-gate.d.ts').PolicyRoots}
 */
function normalizePolicy(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  const record = /** @type {Record<string, unknown>} */ (value)
  const workspaceRoot =
    typeof record.workspaceRoot === 'string' ? record.workspaceRoot : undefined
  const protectedRoots = Array.isArray(record.protectedRoots)
    ? record.protectedRoots.filter(
        root => typeof root === 'string' && root.length > 0,
      )
    : []
  return {
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    protectedRoots,
  }
}

/**
 * @param {BridgeCapability} capability
 * @param {{ callKey: string, tool: string, classification: import('./policy-gate.d.ts').ToolCallClassification, captured?: CapturedCall, tierState?: { tier: string, generation: string, mismatch: boolean } }} input
 * @returns {Promise<{ actionId: string, approvalId: string }>}
 */
async function createApproval(capability, input) {
  const action = {
    kind: `dsh.tool.${input.tool}`,
    risk: input.classification.risk === 'critical' ? 'critical' : 'high',
    idempotencyKey: `dsh-tool:${capability.runId}:${input.callKey}`,
    request: {
      tool: input.tool,
      callId: input.callKey,
      reason: input.classification.reason,
      category: input.classification.category,
      targets: input.classification.targets,
      argumentsHash: input.captured?.argumentsHash ?? null,
      ...(input.tierState
        ? {
            tier: input.tierState.tier,
            tierGeneration: input.tierState.generation,
            tierMismatch: input.tierState.mismatch,
          }
        : {}),
    },
    recoveryPoint: { step: 'before_tool_call', callId: input.callKey },
    approval: {
      summary: approvalSummary(input.tool, input.classification),
      impact: input.classification.reason,
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
 * @param {string} tool
 * @param {import('./policy-gate.d.ts').ToolCallClassification} classification
 * @returns {string}
 */
function approvalSummary(tool, classification) {
  switch (classification.category) {
    case 'control-plane-mutation':
      return `确认工具 ${tool} 对 Pegas 控制面数据的修改`
    case 'destructive-command':
      return `确认不可逆命令（${tool}）执行一次`
    case 'network-egress':
      return `批准工具 ${tool} 向外部发送数据一次`
    case 'out-of-workspace-write':
      return `批准工具 ${tool} 写入工作区之外一次`
    default:
      return `批准工具 ${tool} 越权执行一次`
  }
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
