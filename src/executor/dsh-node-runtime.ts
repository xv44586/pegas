import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const unavailable =
  'DSH 需要独立 Node.js >=24.9.0；请重新构建或安装包含 DSH 运行时的 Pegas 版本（不能使用 Electron 代替）。'

function compatible(versions: { node?: string; electron?: string }): boolean {
  const [major = 0, minor = 0] = (versions.node ?? '').split('.').map(Number)
  return !versions.electron && (major > 24 || (major === 24 && minor >= 9))
}

/** The immutable release owns its Node binary. Development may use the
 * current standalone Node, but Electron must never become a DSH runtime. */
export function dshNodeRuntime(
  options: {
    bundledPath?: string
    execPath?: string
    versions?: { node?: string; electron?: string }
  } = {},
): string {
  const bundledPath =
    options.bundledPath ??
    fileURLToPath(
      new URL(
        `../runtime/${process.platform === 'win32' ? 'node.exe' : 'node'}`,
        import.meta.url,
      ),
    )
  if (existsSync(bundledPath)) {
    // Also reject a corrupt/mispackaged runtime before any task resources or
    // credentials are created. Do not inherit NODE_OPTIONS or preload hooks.
    const probe = spawnSync(
      bundledPath,
      [
        '-p',
        'JSON.stringify({node:process.versions.node,electron:process.versions.electron})',
      ],
      {
        env: { ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 4096,
      },
    )
    try {
      const versions: unknown = JSON.parse(probe.stdout)
      if (
        probe.status === 0 &&
        typeof versions === 'object' &&
        versions !== null &&
        'node' in versions &&
        typeof versions.node === 'string' &&
        !('electron' in versions) &&
        compatible({ node: versions.node })
      )
        return bundledPath
    } catch {
      /* Report a bounded actionable error instead of native stacks. */
    }
    throw new Error(unavailable)
  }
  if (compatible(options.versions ?? process.versions))
    return options.execPath ?? process.execPath
  throw new Error(unavailable)
}
