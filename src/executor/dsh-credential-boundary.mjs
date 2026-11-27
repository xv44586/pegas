import {
  credentialDenial,
  credentialFreeEnvironment,
  credentialProcessArgv,
  hostCredentialRoots,
  isCredentialEnvironment,
  isCredentialPath,
} from './credential-boundary.mjs'

export const name = 'pegas-credential-boundary'
export const inject = ['tools']

/** @typedef {(...args: unknown[]) => unknown} Method */
/** @typedef {{ [key:string]: Method }} Service */
/** @typedef {{ argv: string[], env?: NodeJS.ProcessEnv, [key:string]: unknown }} SpawnSpec */

/** @typedef {{ subprocess: Service, fs: Service, effect: (effect: () => () => void) => void }} RuntimeContext */

/**
 * Mount the denial first. Missing/changed providers never leave tools running
 * without the boundary while Cordis waits for their dependencies.
 * @param {{ tools: { guard: (guard: () => { reason: string } | undefined) => void }, inject: (deps: string[], callback: (ctx: RuntimeContext) => void) => unknown }} ctx
 * @param {{ credentialRoots?: string[], protectedRoots?: string[], readableFiles?: string[] }} [config]
 */
export function apply(ctx, config = {}) {
  let ready = false
  ctx.tools.guard(() =>
    ready ? undefined : { reason: '宿主凭据隔离尚未就绪，拒绝执行工具。' },
  )
  ctx.inject(['subprocess', 'fs'], runtime => {
    install(runtime, config)
    ready = true
    runtime.effect(() => () => {
      ready = false
    })
  })
}

/** @param {RuntimeContext} ctx @param {{ credentialRoots?: string[], protectedRoots?: string[], readableFiles?: string[] }} config */
function install(ctx, config) {
  const roots = config.credentialRoots ?? hostCredentialRoots()
  // General tools must neither mutate the approval database nor read its
  // owner bearer. Trusted service/plugin code still uses its bounded APIs.
  const protectedRoots = config.protectedRoots ?? []
  const readableFiles = config.readableFiles ?? []
  /** @param {Service} service @param {string} key @param {(original: Method) => Method} wrap */
  const replace = (service, key, wrap) => {
    const original = service[key]
    if (typeof original !== 'function')
      throw new Error(`Credential boundary requires ${key}`)
    service[key] = wrap(original)
    ctx.effect(() => () => {
      service[key] = original
    })
  }
  for (const key of ['spawn', 'spawnTerminal']) {
    replace(
      ctx.subprocess,
      key,
      original =>
        /** @this {Service} */
        function (...args) {
          const spec = /** @type {SpawnSpec | undefined} */ (args[0])
          if (
            !spec ||
            !Array.isArray(spec.argv) ||
            !spec.argv.every(value => typeof value === 'string')
          )
            throw new Error('Invalid credential-boundary process request')
          const env = {
            ...credentialFreeEnvironment(spec.env ?? {}),
          }
          for (const name of new Set([
            ...Object.keys(process.env),
            ...Object.keys(env),
          ])) {
            if (isCredentialEnvironment(name) && !(name in env))
              env[name] = undefined
          }
          return original.call(
            this,
            {
              ...spec,
              env,
              argv: credentialProcessArgv(
                spec.argv,
                [...roots, ...protectedRoots],
                process.platform,
                readableFiles,
              ),
            },
            ...args.slice(1),
          )
        },
    )
  }
  for (const key of [
    'readText',
    'streamText',
    'readBytes',
    'readByteRange',
    'listDir',
    'writeText',
    'editText',
    'patchText',
    'deleteFile',
    'moveFile',
  ]) {
    replace(
      ctx.fs,
      key,
      original =>
        /** @this {Service} */
        function (...args) {
          for (const target of args.slice(0, key === 'moveFile' ? 2 : 1)) {
            const path = ctx.fs.processPath?.(target)
            if (typeof path !== 'string' || isCredentialPath(path, roots))
              throw new Error(credentialDenial)
            if (
              isCredentialPath(path, protectedRoots) &&
              (![
                'readText',
                'readBytes',
                'readByteRange',
                'streamText',
              ].includes(key) ||
                !isCredentialPath(path, readableFiles))
            )
              throw new Error(
                '禁止通用工具读取或修改控制面数据；事情授权不包含此系统边界，请使用已注册的只读状态工具。',
              )
          }
          return original.apply(this, args)
        },
    )
  }
}
