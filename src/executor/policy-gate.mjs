import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** @typedef {import('./policy-gate.d.ts').PolicyRisk} PolicyRisk */
/** @typedef {import('./policy-gate.d.ts').PolicyCategory} PolicyCategory */
/** @typedef {import('./policy-gate.d.ts').PolicyRoots} PolicyRoots */
/** @typedef {import('./policy-gate.d.ts').ToolCallClassification} ToolCallClassification */

const READ_TOOLS = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
])
const WRITE_TOOLS = new Set(['write', 'edit'])

const FORCE_PUSH_PATTERN =
  /\bgit\s+push\b[^|;&]*\s(--force\b|--force-with-lease\b|-f\b)/
const SQL_DESTRUCTIVE_PATTERN =
  /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i
const DEVICE_DESTRUCTIVE_PATTERN =
  /\bmkfs(\.\w+)?\b|\bdd\b[^|;&]*\bof=\/dev\/|\bshred\b/

const EGRESS_PATTERNS = [
  /\bcurl\b[^|;&]*\s(-X\s*(POST|PUT|PATCH|DELETE)\b|--data(-\w+)?\b|-d\b|-F\b|--form\b|-T\b|--upload-file\b)/,
  /\bwget\b[^|;&]*\s--post-(data|file)\b/,
  /\b(scp|rsync)\b[^|;&]*\s[\w.@-]+:/,
  /\bsftp\b/,
  /\b(nc|ncat|netcat)\b/,
]

const INDIRECT_PATTERNS = [
  /\beval\b/,
  /\bbase64\b[^|;&]*\|\s*(sh|bash|zsh)\b/,
  /\|\s*(sh|bash|zsh)\b/,
  /\b(python3?|node|perl|ruby)\s+(-[a-z]*c|-[a-z]*e)\b/,
  /\b(sh|bash|zsh)\s+-c\b/,
  /\bxargs\b/,
]

const WRITE_COMMANDS = new Set([
  'rm',
  'mv',
  'cp',
  'tee',
  'touch',
  'mkdir',
  'rmdir',
  'ln',
  'install',
  'truncate',
  'chmod',
  'chown',
  'dd',
])

/**
 * @param {{ name: string, arguments?: unknown }} execution
 * @param {PolicyRoots} roots
 * @returns {ToolCallClassification}
 */
export function classifyToolCall(execution, roots) {
  const workspaceRoot = canonicalRoot(roots.workspaceRoot)
  const protectedRoots = (roots.protectedRoots ?? [])
    .map(root => canonicalRoot(root))
    .filter(root => root !== undefined)
  const protectedAliases = (roots.protectedRoots ?? [])
    .filter(root => typeof root === 'string' && root.length > 0)
    .map(root => resolve(root))
  const context = { workspaceRoot, protectedRoots, protectedAliases }
  if (READ_TOOLS.has(execution.name)) {
    return decision('read', 'low', 'allow', '只读操作，无副作用。', [])
  }
  if (WRITE_TOOLS.has(execution.name)) {
    return classifyWriteTool(execution, context)
  }
  if (execution.name === 'apply_patch') {
    return classifyApplyPatch(execution, context)
  }
  if (execution.name === 'bash') {
    return classifyBash(execution, context)
  }
  return unknownDecision(
    `无法静态判定工具 ${execution.name} 的实际效果，需要你确认。`,
  )
}

/**
 * @param {string | undefined} root
 * @returns {string | undefined}
 */
function canonicalRoot(root) {
  if (typeof root !== 'string' || root.length === 0) return undefined
  return canonicalize(resolve(root))
}

/**
 * @param {unknown} value
 * @param {{ workspaceRoot: string | undefined, protectedRoots: string[], protectedAliases: string[] }} context
 * @returns {string | undefined}
 */
function canonicalTarget(value, context) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const absolute = isAbsolute(value)
    ? value
    : context.workspaceRoot
      ? join(context.workspaceRoot, value)
      : resolve(value)
  return canonicalize(absolute)
}

/**
 * @param {string} absolute
 * @returns {string}
 */
function canonicalize(absolute) {
  let existing = absolute
  const pending = []
  for (;;) {
    try {
      const real = realpathSync(existing)
      return pending.length === 0 ? real : join(real, ...pending.reverse())
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return resolve(absolute)
      pending.push(basename(existing))
      existing = parent
    }
  }
}

/**
 * @param {string} target
 * @param {string | undefined} root
 * @returns {boolean}
 */
function isInside(target, root) {
  if (root === undefined) return false
  return target === root || target.startsWith(root + sep)
}

/**
 * @param {PolicyCategory} category
 * @param {PolicyRisk} risk
 * @param {'allow' | 'ask' | 'deny'} action
 * @param {string} reason
 * @param {string[]} targets
 * @returns {ToolCallClassification}
 */
function decision(category, risk, action, reason, targets) {
  return { category, risk, action, reason, targets }
}

/**
 * @param {string} reason
 * @returns {ToolCallClassification}
 */
function unknownDecision(reason) {
  return decision('unknown', 'high', 'ask', reason, [])
}

/**
 * @param {string[]} targets
 * @param {{ workspaceRoot: string | undefined, protectedRoots: string[], protectedAliases: string[] }} context
 * @param {string} summary
 * @returns {ToolCallClassification}
 */
function judgeWriteTargets(targets, context, summary) {
  const protectedTargets = targets.filter(target =>
    context.protectedRoots.some(root => isInside(target, root)),
  )
  if (protectedTargets.length > 0) {
    return decision(
      'control-plane-mutation',
      'critical',
      'deny',
      `${summary} 涉及 Pegas 控制面数据（${protectedTargets.join('、')}），任何档位都必须由你显式确认，本次调用已被拦截。`,
      protectedTargets,
    )
  }
  if (context.workspaceRoot === undefined) {
    return unknownDecision('缺少工作区边界信息，无法判定写入范围，需要你确认。')
  }
  const outsideTargets = targets.filter(
    target => !isInside(target, context.workspaceRoot),
  )
  if (outsideTargets.length > 0) {
    return decision(
      'out-of-workspace-write',
      'high',
      'ask',
      `${summary} 将写入工作区之外（${outsideTargets.join('、')}）。`,
      outsideTargets,
    )
  }
  return decision(
    'workspace-write',
    'low',
    'allow',
    `${summary} 位于工作区内。`,
    targets,
  )
}

/**
 * @param {{ name: string, arguments?: unknown }} execution
 * @param {{ workspaceRoot: string | undefined, protectedRoots: string[], protectedAliases: string[] }} context
 * @returns {ToolCallClassification}
 */
function classifyWriteTool(execution, context) {
  const arguments_ = record(execution.arguments)
  const target = canonicalTarget(arguments_?.file_path, context)
  if (target === undefined) {
    return unknownDecision(
      `工具 ${execution.name} 缺少可判定的目标路径，需要你确认。`,
    )
  }
  return judgeWriteTargets([target], context, `工具 ${execution.name}`)
}

/**
 * @param {{ name: string, arguments?: unknown }} execution
 * @param {{ workspaceRoot: string | undefined, protectedRoots: string[], protectedAliases: string[] }} context
 * @returns {ToolCallClassification}
 */
function classifyApplyPatch(execution, context) {
  const arguments_ = record(execution.arguments)
  const patch = arguments_?.patch
  if (typeof patch !== 'string') {
    return unknownDecision('apply_patch 缺少补丁内容，需要你确认。')
  }
  const paths = []
  for (const line of patch.split('\n')) {
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    const path = match?.[1] ?? move?.[1]
    if (path !== undefined) {
      const target = canonicalTarget(path.trim(), context)
      if (target === undefined) {
        return unknownDecision('apply_patch 含无法判定的目标路径，需要你确认。')
      }
      paths.push(target)
    }
  }
  if (paths.length === 0) {
    return unknownDecision('apply_patch 内容无法解析出目标路径，需要你确认。')
  }
  return judgeWriteTargets(paths, context, '补丁 apply_patch')
}

/**
 * @param {{ name: string, arguments?: unknown }} execution
 * @param {{ workspaceRoot: string | undefined, protectedRoots: string[], protectedAliases: string[] }} context
 * @returns {ToolCallClassification}
 */
function classifyBash(execution, context) {
  const arguments_ = record(execution.arguments)
  const command = arguments_?.command
  if (typeof command !== 'string' || command.trim().length === 0) {
    return unknownDecision('bash 缺少可判定的命令内容，需要你确认。')
  }
  const writeTargets = bashWriteTargets(command, context)
  const protectedTargets = writeTargets.filter(target =>
    context.protectedRoots.some(root => isInside(target, root)),
  )
  if (protectedTargets.length > 0) {
    return decision(
      'control-plane-mutation',
      'critical',
      'deny',
      `命令试图修改 Pegas 控制面数据（${protectedTargets.join('、')}），任何档位都必须由你显式确认，本次调用已被拦截。`,
      protectedTargets,
    )
  }
  const protectedMentioned = [
    ...context.protectedRoots,
    ...context.protectedAliases,
  ].some(root => command.includes(root))
  if (protectedMentioned && hasWriteShape(command)) {
    return unknownDecision(
      '命令涉及 Pegas 控制面目录且无法静态判定写入范围，需要你确认。',
    )
  }
  if (INDIRECT_PATTERNS.some(pattern => pattern.test(command))) {
    return unknownDecision(
      `命令包含间接执行或解释器调用，无法静态判定实际效果：${command}`,
    )
  }
  const destructive = classifyDestructive(command, context)
  if (destructive !== undefined) {
    return destructive
  }
  if (EGRESS_PATTERNS.some(pattern => pattern.test(command))) {
    return decision(
      'network-egress',
      'high',
      'ask',
      `命令会向外部发送数据：${command}`,
      [],
    )
  }
  return decision(
    'read',
    'low',
    'allow',
    '命令未命中越界写、外部发送或不可逆模式，交由沙箱边界执行。',
    [],
  )
}

/**
 * @param {string} command
 * @param {{ workspaceRoot: string | undefined, protectedRoots: string[], protectedAliases: string[] }} context
 * @returns {ToolCallClassification | undefined}
 */
function classifyDestructive(command, context) {
  if (
    FORCE_PUSH_PATTERN.test(command) ||
    SQL_DESTRUCTIVE_PATTERN.test(command) ||
    DEVICE_DESTRUCTIVE_PATTERN.test(command)
  ) {
    return decision(
      'destructive-command',
      'critical',
      'ask',
      `命令命中不可逆操作模式：${command}`,
      [],
    )
  }
  const recursiveRemove = /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\b/.exec(
    command,
  )
  if (recursiveRemove) {
    const operands = command
      .slice(recursiveRemove.index + recursiveRemove[0].length)
      .split(/[;|&]/)[0]
      ?.split(/\s+/)
      .filter(token => token.length > 0 && !token.startsWith('-'))
      .map(token => unquote(token))
    const targets = (operands ?? [])
      .map(operand => canonicalTarget(operand, context))
      .filter(target => target !== undefined)
    const outside = targets.filter(
      target =>
        context.workspaceRoot === undefined ||
        !isInside(target, context.workspaceRoot),
    )
    if (outside.length > 0 || targets.length === 0) {
      return decision(
        'destructive-command',
        'critical',
        'ask',
        `命令包含工作区外的递归删除：${command}`,
        outside,
      )
    }
  }
  return undefined
}

/**
 * @param {string} command
 * @returns {boolean}
 */
function hasWriteShape(command) {
  if (/(^|[^>])>{1,2}/.test(command)) return true
  const tokens = command.split(/[\s;|&]+/).filter(token => token.length > 0)
  return tokens.some(token => WRITE_COMMANDS.has(token))
}

/**
 * @param {string} command
 * @param {{ workspaceRoot: string | undefined, protectedRoots: string[], protectedAliases: string[] }} context
 * @returns {string[]}
 */
function bashRedirectTargets(command, context) {
  const targets = []
  const pattern = />{1,2}\s*([^\s;|&<>]+)/g
  for (;;) {
    const match = pattern.exec(command)
    if (!match) break
    const raw = match[1]
    if (raw === undefined || raw.startsWith('/dev/')) continue
    const target = canonicalTarget(unquote(raw), context)
    if (target !== undefined) targets.push(target)
  }
  return targets
}

/**
 * @param {string} command
 * @param {{ workspaceRoot: string | undefined, protectedRoots: string[], protectedAliases: string[] }} context
 * @returns {string[]}
 */
function bashWriteTargets(command, context) {
  const targets = [...bashRedirectTargets(command, context)]
  const segments = command.split(/[;|&]+/)
  for (const segment of segments) {
    const tokens = segment
      .trim()
      .split(/\s+/)
      .filter(token => token.length > 0)
      .map(token => unquote(token))
    const head = tokens[0]
    if (head === undefined || !WRITE_COMMANDS.has(head)) continue
    const operands = tokens
      .slice(1)
      .filter(token => !token.startsWith('-') && !token.includes('='))
    const candidates =
      head === 'cp' || head === 'mv' || head === 'ln'
        ? operands.slice(-1)
        : operands
    for (const candidate of candidates) {
      const target = canonicalTarget(candidate, context)
      if (target !== undefined) targets.push(target)
    }
  }
  return targets
}

/**
 * @param {string} token
 * @returns {string}
 */
function unquote(token) {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1)
  }
  return token
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function record(value) {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return /** @type {Record<string, unknown>} */ (value)
  }
  return undefined
}
