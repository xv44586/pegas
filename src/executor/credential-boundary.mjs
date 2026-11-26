import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

export const credentialDenial =
  '禁止通用工具读取或使用宿主账号凭据。命令、目录和完全访问批准不包含账号授权；此执行器尚无独立账号授权通道；需要账号的操作请在受信任环境完成，不能改从钥匙串、Git helper 或其他本机登录提取凭据。'

const credentialEnvironment =
  /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|COOKIE/i
const accountEnvironment =
  /^(GH_|GITHUB_|GIT_|SSH_|GPG_|GNUPG|AWS_|AZURE_|GOOGLE_APPLICATION_|CLOUDSDK_|DBUS_|XDG_RUNTIME_DIR$|BASH_ENV$|BASH_FUNC_|SHELLOPTS$|BASHOPTS$|ENV$|ZDOTDIR$|NODE_OPTIONS$|DYLD_|LD_PRELOAD$)/i

/** @param {string} key */
export function isCredentialEnvironment(key) {
  return credentialEnvironment.test(key) || accountEnvironment.test(key)
}

/** Shared by the host validator, Executor and tool processes. Disabling global
 * Git config avoids fatal reads of the protected host .gitconfig; deleting
 * these overrides inside a command still cannot remove the OS boundary.
 * @param {NodeJS.ProcessEnv} source
 * @returns {NodeJS.ProcessEnv}
 */
export function credentialFreeEnvironment(source) {
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(([key]) => !isCredentialEnvironment(key)),
    ),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
}

/** @param {NodeJS.ProcessEnv} [environment] */
export function hostCredentialRoots(environment = process.env) {
  const home = environment.HOME ?? homedir()
  const roots = [
    '.config',
    '.ssh',
    '.gnupg',
    '.aws',
    '.azure',
    '.kube',
    '.docker',
    '.git-credentials',
    '.gitconfig',
    '.netrc',
    '.npmrc',
    '.pypirc',
    '.codex',
    '.claude',
    '.dsh',
    '.local/share/keyrings',
    '.bash_profile',
    '.bashrc',
    '.profile',
    '.zshenv',
    '.zshrc',
    'Library/Keychains',
    'Library/Cookies',
    'Library/Safari',
    'Library/Application Support/Google/Chrome',
    'Library/Application Support/Microsoft Edge',
    'Library/Application Support/Firefox',
    'Library/Application Support/BraveSoftware',
  ].map(path => join(home, path))
  for (const key of [
    'GH_CONFIG_DIR',
    'GIT_CONFIG_GLOBAL',
    'AWS_SHARED_CREDENTIALS_FILE',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'SSH_AUTH_SOCK',
    'XDG_CONFIG_HOME',
    'XDG_RUNTIME_DIR',
  ]) {
    const path = environment[key]
    if (path && path !== '/dev/null' && isAbsolute(path)) roots.push(path)
  }
  if (process.platform === 'linux' && process.getuid)
    roots.push(`/run/user/${String(process.getuid())}`)
  return [...new Set(roots)]
}

/** @param {string} path @returns {string} */
function canonical(path) {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path
      ? path
      : join(canonical(parent), path.slice(parent.length))
  }
}

/** @param {string} path @param {readonly string[]} roots */
export function isCredentialPath(path, roots) {
  const target = canonical(resolve(path))
  return roots.some(root => {
    const protectedPath = canonical(resolve(root))
    return target === protectedPath || target.startsWith(protectedPath + sep)
  })
}

/** Static explanation only; opaque commands are confined at the process seam.
 * @param {{name:string, arguments?:unknown}} execution
 * @param {import('./policy-gate.d.ts').PolicyRoots} roots
 */
export function credentialAccess(execution, roots) {
  const args = execution.arguments
  if (!args || typeof args !== 'object') return false
  const values = /** @type {Record<string, unknown>} */ (args)
  const protectedRoots = roots.credentialRoots ?? hostCredentialRoots()
  const cwd =
    typeof values.workdir === 'string'
      ? resolve(
          roots.currentDirectory ?? roots.workspaceRoot ?? process.cwd(),
          values.workdir,
        )
      : (roots.currentDirectory ?? roots.workspaceRoot ?? process.cwd())
  for (const key of ['file_path', 'path', 'directory', 'cwd', 'workdir']) {
    const value = values[key]
    if (
      typeof value === 'string' &&
      isCredentialPath(resolve(cwd, value), protectedRoots)
    )
      return true
  }
  if (execution.name !== 'bash' || typeof values.command !== 'string')
    return false
  // No attempt to parse arbitrary shell syntax: the mandatory OS boundary also
  // covers scripts, computed paths and helpers hidden behind ordinary commands.
  return /\bgit\s+(?:[^;|\n]*\s)?credential(?:-[\w-]+)?\s+(?:fill|get|store|approve|reject)\b|\bsecurity\s+(?:find-|dump-|export|unlock-)|\bgh\s+auth\s+(?:token|login|refresh|switch)\b|\b(?:GH_TOKEN|GITHUB_TOKEN|SSH_AUTH_SOCK)\s*=/.test(
    values.command,
  )
}

/** @param {string} value */
function sbpl(value) {
  return JSON.stringify(value)
}

/** Every spawned process, including full-access calls, gets the same boundary.
 * Existing Seatbelt profiles are extended (macOS cannot nest sandbox-exec).
 * @param {readonly string[]} argv
 * @param {readonly string[]} roots
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
export function credentialProcessArgv(
  argv,
  roots,
  platform = process.platform,
) {
  const paths = [
    ...new Set(
      roots.flatMap(root => [resolve(root), canonical(resolve(root))]),
    ),
  ]
  if (platform === 'darwin') {
    const restrictions = [
      ...paths.map(
        path => `(deny file-read* file-write* (subpath ${sbpl(path)}))`,
      ),
      '(deny mach-lookup)',
      '(deny job-creation)',
      '(deny appleevent-send)',
      '(deny network-outbound (remote unix-socket))',
      '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
      '(allow mach-lookup (global-name "com.apple.SystemConfiguration.configd"))',
      '(deny process-info* (target others))',
    ].join(' ')
    if (argv[0] === '/usr/bin/sandbox-exec' || argv[0] === 'sandbox-exec') {
      if (argv[1] !== '-p' || !argv[2])
        throw new Error(
          'Unsupported sandbox profile; credential boundary cannot be enforced',
        )
      return [
        '/usr/bin/sandbox-exec',
        '-p',
        `${argv[2]} ${restrictions}`,
        ...argv.slice(3),
      ]
    }
    return [
      '/usr/bin/sandbox-exec',
      '-p',
      `(version 1)(allow default) ${restrictions}`,
      ...argv,
    ]
  }
  if (platform === 'linux') {
    // Mask both logical paths and symlink destinations. No ambient agent or
    // session-bus socket remains accessible via the conventional runtime dir.
    const masks = paths
      .filter(path => existsSync(path))
      .flatMap(path =>
        statSync(path).isDirectory()
          ? ['--tmpfs', path]
          : ['--ro-bind', '/dev/null', path],
      )
    return [
      '/usr/bin/bwrap',
      '--die-with-parent',
      '--unshare-pid',
      '--unshare-ipc',
      '--bind',
      '/',
      '/',
      '--dev-bind',
      '/dev',
      '/dev',
      '--proc',
      '/proc',
      ...masks,
      '--',
      ...argv,
    ]
  }
  throw new Error(
    `Host credential isolation is unavailable on ${platform}; refusing unconfined tool execution`,
  )
}
