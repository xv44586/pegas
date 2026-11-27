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
 * @param {{ credentialRoots?: string[] }} [config]
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

/** @param {RuntimeContext} ctx @param {{ credentialRoots?: string[] }} config */
function install(ctx, config) {
  const roots = config.credentialRoots ?? hostCredentialRoots()
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
            { ...spec, env, argv: credentialProcessArgv(spec.argv, roots) },
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
          }
          return original.apply(this, args)
        },
    )
  }
}
