import { credentialFreeEnvironment } from './credential-boundary.mjs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from 'node:path'

/**
 * @typedef {{version: 1, executable: string, executableHash: string,
 * argv: string[], cwd: string, environmentHash: string, family: 'git-fetch',
 * repository: string, repositoryId: string, remote: string, remoteUrl: string,
 * configurationHash: string}} CommandSelector
 */

/** @param {string} value */
function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Literal argv only. No shell expansion, operators, assignments or redirections. @param {string} command */
function literalArgv(command) {
  if (!command || command.length > 16000 || /[\n\r\0$`\\]/.test(command))
    return undefined
  const parts = []
  let word = '',
    quote = '',
    started = false
  for (const character of command) {
    if (quote) {
      if (character === quote) quote = ''
      else word += character
    } else if (character === "'" || character === '"') {
      quote = character
      started = true
    } else if (/\s/.test(character)) {
      if (started) parts.push(word)
      word = ''
      started = false
    } else {
      if (/[|;&<>(){}]/.test(character)) return undefined
      word += character
      started = true
    }
  }
  if (quote) return undefined
  if (started) parts.push(word)
  return parts
}

/** Identify the executable/subcommand, never keywords in search text. @param {string} command */
export function isGitFetchCommand(command) {
  const words = literalArgv(command)
  // A literal Git invocation with dynamic/compound arguments cannot be
  // treated as a read merely because the persistent adapter cannot parse it.
  if (!words)
    return /^(?:env\s+(?:-u\s+\w+\s+)*)?(?:\/[\w./-]+\/)?git\s/.test(
      command.trim(),
    )
  if (words.at(0) === 'env') {
    words.shift()
    while (words[0] === '-u') {
      words.splice(0, 2)
    }
  }
  if (basename(words.shift() ?? '') !== 'git') return false
  while (words[0]) {
    if (['-C', '-c', '--git-dir', '--work-tree'].includes(words[0]))
      words.splice(0, 2)
    else if (words[0].startsWith('-')) words.shift()
    else break
  }
  return words[0] === 'fetch'
}

/** @param {string} program @param {NodeJS.ProcessEnv} environment @param {string} cwd */
function executablePath(program, environment, cwd) {
  const paths = isAbsolute(program)
    ? [program]
    : program.includes('/')
      ? []
      : (environment.PATH ?? '')
          .split(delimiter)
          .map(dir => resolve(cwd, dir, program))
  for (const path of paths) {
    try {
      accessSync(path, constants.X_OK)
      if (statSync(path).isFile()) return realpathSync(path)
    } catch {
      /* try next PATH entry */
    }
  }
  throw new Error('无法确认实际命令程序')
}

/** @param {string} path @param {readonly string[]} roots */
function protectedPath(path, roots) {
  return roots.some(root => {
    let canonical
    try {
      canonical = realpathSync(root)
    } catch {
      canonical = resolve(root)
    }
    return path === canonical || path.startsWith(canonical + sep)
  })
}

/**
 * Facts are recomputed at both execution hooks; never normalize away env effects.
 * Config output is only hashed, never persisted or rendered (it may contain secrets).
 * @param {string} command
 * @param {string} directory
 * @param {readonly string[]} [protectedRoots]
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {{selector?: CommandSelector, reason?: string}}
 */
export function commandAuthorization(
  command,
  directory,
  protectedRoots = [],
  environment = process.env,
) {
  try {
    environment = credentialFreeEnvironment(environment)
    const words = literalArgv(command)
    if (!words?.length)
      return { reason: '命令包含复合执行或动态展开，无法建立持久命令授权。' }
    if (
      Object.keys(environment).some(
        key =>
          /^(BASH_ENV|ENV|BASH_FUNC_|SHELLOPTS|BASHOPTS)/.test(key) &&
          environment[key],
      )
    )
      return { reason: 'Shell 启动环境包含额外脚本或函数，不能复用命令授权。' }
    const env = Object.fromEntries(
      Object.entries(environment).filter(
        ([key, value]) =>
          value !== undefined && !/KEY|PASSWORD|SECRET|TOKEN|^DSH_/i.test(key),
      ),
    )
    const shell = executablePath('bash', env, directory)
    if (
      !['/bin/bash', '/usr/bin/bash', '/opt/homebrew/bin/bash'].some(
        path => existsSync(path) && realpathSync(path) === shell,
      )
    )
      return { reason: 'Shell 程序不在已验证的工具链中。' }
    if (words.at(0) === 'env') {
      if (
        executablePath('env', env, directory) !== realpathSync('/usr/bin/env')
      )
        return { reason: 'env 包装程序不是已验证的系统程序。' }
      words.shift()
      while (words[0] === '-u') {
        words.shift()
        const key = words.shift()
        if (!key || !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key))
          return { reason: '环境包装超出支持范围，不能建立持久命令授权。' }
        Reflect.deleteProperty(env, key)
      }
    }
    const program = words.shift()
    if (!program) return { reason: '缺少实际程序。' }
    const executable = executablePath(program, env, directory)
    let cwd = realpathSync(directory)
    if (protectedPath(cwd, protectedRoots))
      return { reason: '命令涉及受保护目录。' }
    const git = executablePath('git', env, directory)
    if (executable !== git)
      return { reason: '此程序尚无可验证的持久授权适配器；仍可单次批准。' }
    if (
      !['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'].some(
        path => existsSync(path) && realpathSync(path) === executable,
      )
    )
      return { reason: 'Git 程序不在已验证的系统工具链中。' }
    while (words[0] === '-C') {
      words.shift()
      const target = words.shift()
      if (!target) return { reason: 'git -C 缺少目录。' }
      cwd = realpathSync(resolve(cwd, target))
    }
    if (protectedPath(cwd, protectedRoots))
      return { reason: '命令涉及受保护目录。' }
    const subcommand = words[0]
    if (subcommand !== 'fetch')
      return { reason: '此 Git 子命令不属于已支持的拉取授权范围。' }
    const args = words.slice(1)
    while (
      args[0] &&
      [
        '--quiet',
        '-q',
        '--verbose',
        '-v',
        '--progress',
        '--no-progress',
      ].includes(args[0])
    )
      args.shift()
    const remote = args.shift()
    if (
      !remote ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(remote) ||
      args.some(
        arg =>
          !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(arg) ||
          arg.includes('..') ||
          arg.endsWith('.lock'),
      )
    )
      return {
        reason:
          '只支持指定远端和普通分支/tag 的 fetch；危险选项或自定义 refspec 需单次确认。',
      }
    if (!env.GIT_CONFIG_COUNT) {
      for (const key of Object.keys(env))
        if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key))
          Reflect.deleteProperty(env, key)
    }
    const unsafeEnvironment = Object.keys(env).some(
      key =>
        /^(GIT_(ASKPASS|DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|SSH|SSH_COMMAND|SSH_VARIANT|EXEC_PATH|CONFIG|CONFIG_PARAMETERS)|SSH_ASKPASS|LD_PRELOAD|DYLD_.*)$/.test(
          key,
        ) && env[key],
    )
    if (unsafeEnvironment)
      return { reason: '执行环境包含改变 Git 行为的覆盖值，无法复用命令授权。' }
    /** @param {string[]} argv */
    const inspect = argv =>
      execFileSync(executable, ['-C', cwd, ...argv], {
        encoding: 'utf8',
        env,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    const common = realpathSync(
      resolve(cwd, inspect(['rev-parse', '--git-common-dir'])),
    )
    const repository = common.endsWith(sep + '.git') ? dirname(common) : common
    const hooks = resolve(cwd, inspect(['rev-parse', '--git-path', 'hooks']))
    if (
      existsSync(hooks) &&
      readdirSync(hooks).some(name => {
        if (name.endsWith('.sample')) return false
        try {
          accessSync(join(hooks, name), constants.X_OK)
          return statSync(join(hooks, name)).isFile()
        } catch {
          return false
        }
      })
    )
      return {
        reason: '仓库包含可执行 Git hook，需单次确认，不能复用普通拉取授权。',
      }
    if (
      protectedPath(common, protectedRoots) ||
      protectedPath(repository, protectedRoots)
    )
      return { reason: '仓库元数据涉及受保护目录。' }
    if (
      existsSync(join(common, 'modules')) ||
      existsSync(join(cwd, '.gitmodules')) ||
      existsSync(join(inspect(['rev-parse', '--show-toplevel']), '.gitmodules'))
    )
      return {
        reason: '含子模块的仓库需要逐项核对拉取目标，暂不支持持久 fetch 授权。',
      }
    const config = inspect(['config', '--null', '--list'])
    if (
      /(core\.(sshcommand|gitproxy|hookspath|askpass)|uploadpack\.packobjectshook|remote\.[^\n\0]+\.(uploadpack|vcs)|url\.[^\n\0]+\.(insteadof|pushinsteadof))\n/i.test(
        config,
      )
    )
      return { reason: 'Git 配置包含自定义执行或远端重写，需单次确认。' }
    const entries = config.split('\0').map(entry => {
      const boundary = entry.indexOf('\n')
      return boundary < 0
        ? [entry, '']
        : [entry.slice(0, boundary), entry.slice(boundary + 1)]
    })
    if (
      entries.some(
        ([key, value]) =>
          /^(?:fetch|remote\..+)\.(?:prune|prunetags)$/i.test(key ?? '') &&
          !/^(?:false|no|off|0)$/i.test(value ?? ''),
      )
    ) {
      return {
        reason:
          'Git 配置启用了清理引用或标签，需单次确认，不能复用普通 fetch 授权。',
      }
    }
    if (
      entries.some(
        ([key, value]) =>
          key === 'remote.' + remote + '.fetch' &&
          value !== '+refs/heads/*:refs/remotes/' + remote + '/*' &&
          value !== 'refs/heads/*:refs/remotes/' + remote + '/*',
      )
    ) {
      return { reason: '远端配置包含自定义 refspec，需单次确认。' }
    }
    const helpers = config
      .split('\0')
      .filter(entry => /^credential(?:\.[^\n]+)?\.helper\n/i.test(entry))
      .map(entry => entry.slice(entry.indexOf('\n') + 1))
    const ghHelpers = helpers.filter(helper =>
      /^(?:!gh|!?\/opt\/homebrew\/bin\/gh|!?\/usr\/local\/bin\/gh|!?\/usr\/bin\/gh) auth git-credential$/.test(
        helper,
      ),
    )
    if (
      helpers.some(
        helper =>
          helper !== '' &&
          helper !== 'osxkeychain' &&
          !ghHelpers.includes(helper),
      )
    )
      return {
        reason:
          'Git 凭证 helper 含自定义执行，需单次确认；目前支持系统 osxkeychain 与已验证的 gh 凭证命令。',
      }
    const execPath = realpathSync(inspect(['--exec-path']))
    const componentHashes = []
    for (const helper of ghHelpers) {
      const program = helper.replace(/^!/, '').split(' ')[0]
      if (!program) return { reason: '无法验证凭证命令。' }
      const binary = executablePath(program, env, cwd)
      if (
        !['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'].some(
          path => existsSync(path) && realpathSync(path) === binary,
        )
      )
        return { reason: '凭证程序不是已验证的 gh 安装。' }
      componentHashes.push([
        binary,
        hash(readFileSync(binary).toString('base64')),
      ])
    }
    for (const name of [
      'git-remote-http',
      'git-remote-https',
      'git-upload-pack',
      ...(helpers.includes('osxkeychain')
        ? ['git-credential-osxkeychain']
        : []),
    ]) {
      const component = realpathSync(join(execPath, name))
      if (!component.startsWith(resolve(execPath, '../..') + sep))
        return { reason: 'Git 执行组件不在已验证的安装目录中。' }
      componentHashes.push([
        component,
        hash(readFileSync(component).toString('base64')),
      ])
    }
    let remoteUrl = inspect(['remote', 'get-url', remote])
    if (!/^(https:\/\/|\/)/.test(remoteUrl) || /[\r\n\0]/.test(remoteUrl))
      return {
        reason:
          '目前持久拉取授权支持 HTTPS 和本地远端；SSH 的额外执行配置需单次核对。',
      }
    let localConfig = ''
    if (isAbsolute(remoteUrl)) {
      remoteUrl = realpathSync(remoteUrl)
      localConfig = inspect(['-C', remoteUrl, 'config', '--null', '--list'])
      if (/uploadpack\.packobjectshook\n/i.test(localConfig))
        return { reason: '本地远端包含自定义 pack 执行，需单次确认。' }
    }
    if (remoteUrl.includes('://')) {
      const url = new URL(remoteUrl)
      if (
        url.password ||
        (url.protocol === 'https:' && url.username) ||
        url.search ||
        url.hash
      )
        return { reason: '远端地址包含凭证或动态参数，不能作为公开授权范围。' }
    }
    // Hash relevant inherited environment, including credential/config locations; never expose values.
    const environmentHash = hash(
      createHash('sha256').update(readFileSync(shell)).digest('hex') +
        JSON.stringify(
          Object.keys(env)
            .filter(key =>
              /^(GIT_|GH_|SSH_|HOME$|XDG_|PATH$|.*PROXY$|.*proxy$)/.test(key),
            )
            .sort()
            .map(key => [key, env[key]]),
        ),
    )
    return {
      selector: {
        version: 1,
        executable,
        executableHash: createHash('sha256')
          .update(readFileSync(executable))
          .digest('hex'),
        argv: words,
        cwd,
        environmentHash,
        family: 'git-fetch',
        repository,
        repositoryId: common,
        remote,
        remoteUrl,
        configurationHash: hash(
          JSON.stringify([config, localConfig, componentHashes]),
        ),
      },
    }
  } catch {
    return {
      reason: '无法验证实际程序、工作目录或仓库配置；可单次批准后重试。',
    }
  }
}

/** @param {CommandSelector} selector @param {'exact'|'family'} precision */
export function commandFingerprint(selector, precision) {
  const { cwd, argv, ...common } = selector
  return hash(
    JSON.stringify({
      ...common,
      precision,
      ...(precision === 'exact' ? { cwd, argv } : {}),
    }),
  )
}

/** Validate persisted data without trusting client-supplied keys. @param {unknown} value @returns {value is CommandSelector} */
export function isCommandSelector(value) {
  if (!value || typeof value !== 'object') return false
  const v = /** @type {Record<string, unknown>} */ (value)
  return (
    v.version === 1 &&
    v.family === 'git-fetch' &&
    ['executable', 'cwd', 'repository', 'repositoryId'].every(
      k => typeof v[k] === 'string' && isAbsolute(v[k]),
    ) &&
    ['executableHash', 'environmentHash', 'configurationHash'].every(
      k => typeof v[k] === 'string' && /^[a-f0-9]{64}$/.test(v[k]),
    ) &&
    typeof v.remote === 'string' &&
    typeof v.remoteUrl === 'string' &&
    Array.isArray(v.argv) &&
    v.argv.every(a => typeof a === 'string') &&
    v.argv[0] === 'fetch'
  )
}
