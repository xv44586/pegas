import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * MEMORY-001 M3: one identity resolution chain shared by memory write and
 * recall. A workspace maps to a canonical project key so linked worktrees
 * and fresh clones of the same repository share memory, while the EXEC-008
 * default workspace (no real project) stays project-less and never creates
 * a fake project.
 *
 * Resolution order:
 * 1. git common dir (linked worktrees collapse to the main checkout), with
 *    a normalized `origin` remote URL taking priority as the stable key;
 * 2. without git, the realpath of the workspace directory;
 * 3. the configured default workspace root resolves to "no project".
 */
export interface ProjectIdentity {
  canonicalKey: string
  displayName: string
}

export function resolveProjectIdentity(
  workingDirectory: string,
  defaultWorkspaceRoot?: string,
): ProjectIdentity | undefined {
  const directory = realDirectory(workingDirectory)
  if (!directory) return undefined
  if (
    defaultWorkspaceRoot &&
    realDirectory(defaultWorkspaceRoot) === directory
  ) {
    return undefined
  }
  const commonDir = gitOutput(directory, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  if (commonDir) {
    const mainRoot = realDirectory(join(commonDir, '..')) ?? directory
    const remote = gitOutput(mainRoot, ['remote', 'get-url', 'origin'])
    const remoteKey = remote ? normalizeRemoteUrl(remote) : undefined
    if (remoteKey) {
      return {
        canonicalKey: `git:${remoteKey}`,
        displayName: remoteDisplayName(remoteKey) ?? baseName(mainRoot),
      }
    }
    return {
      canonicalKey: `path:${mainRoot}`,
      displayName: baseName(mainRoot),
    }
  }
  return { canonicalKey: `path:${directory}`, displayName: baseName(directory) }
}

/**
 * Normalize scp-style and URL-style git remotes to host/path without
 * credentials, `.git` suffix or trailing slashes, so https and ssh clones
 * of the same repository converge on one key.
 */
export function normalizeRemoteUrl(remote: string): string | undefined {
  const trimmed = remote.trim()
  if (!trimmed) return undefined
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(trimmed)
  const parsed = scp
    ? { host: scp[1] ?? '', path: scp[2] ?? '' }
    : parseUrlRemote(trimmed)
  if (!parsed) return undefined
  const { host, path } = parsed
  if (!host || !path) return undefined
  const normalizedPath = path
    .replace(/^\/+/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
  if (!normalizedPath) return undefined
  return `${host.toLowerCase()}/${normalizedPath}`
}

function parseUrlRemote(
  value: string,
): { host: string; path: string } | undefined {
  try {
    const url = new URL(value)
    if (!url.hostname) return undefined
    return { host: url.hostname, path: url.pathname }
  } catch {
    return undefined
  }
}

function remoteDisplayName(remoteKey: string): string | undefined {
  return remoteKey.split('/').filter(Boolean).at(-1)
}

function baseName(directory: string): string {
  return directory.split('/').filter(Boolean).at(-1) ?? directory
}

function realDirectory(directory: string): string | undefined {
  if (!isAbsolute(directory)) return undefined
  try {
    return realpathSync(resolve(directory))
  } catch {
    return undefined
  }
}

function gitOutput(cwd: string, arguments_: string[]): string | undefined {
  try {
    const output = execFileSync('git', arguments_, {
      cwd,
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim()
    return output || undefined
  } catch {
    return undefined
  }
}
