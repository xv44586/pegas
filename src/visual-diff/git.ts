import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseVisualDiff, type VisualDiff } from './model.js'

const execute = promisify(execFile)

/** No shell, external diff drivers, textconv, hooks, optional locks or fsmonitor. */
async function git(directory: string, args: string[]): Promise<string> {
  const result = await execute(
    'git',
    [
      '--no-pager',
      '--literal-pathspecs',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.quotePath=false',
      '-C',
      directory,
      ...args,
    ],
    {
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
      },
    },
  )
  return result.stdout
}

export async function verifyVisualDiff(
  value: unknown,
  directory: string,
): Promise<VisualDiff> {
  const diff = parseVisualDiff(value)
  await git(directory, ['rev-parse', '--verify', `${diff.base}^{commit}`])
  await git(directory, ['rev-parse', '--verify', `${diff.head}^{commit}`])
  const changed = new Set(
    (
      await git(directory, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-only',
        '-z',
        '--no-renames',
        diff.base,
        diff.head,
        '--',
      ])
    )
      .split('\0')
      .filter(Boolean),
  )
  if (!changed.size) throw new Error('No changed files between revisions')
  const blobs = new Map<string, string[]>()
  const patches = new Map<string, string>()
  for (const node of diff.nodes) {
    let changedReference = false
    for (const source of node.sources) {
      const revision = source.side === 'base' ? diff.base : diff.head
      const key = `${revision}:${source.path}`
      let blob = blobs.get(key)
      if (!blob) {
        // cat-file rejects symlink blobs by mode checked through ls-tree.
        const entry = await git(directory, [
          'ls-tree',
          revision,
          '--',
          source.path,
        ])
        if (!/^100(644|755) blob [a-f0-9]{40}\t/u.test(entry))
          throw new Error('Visual diff source must be a regular Git file')
        blob = (await git(directory, ['cat-file', 'blob', key])).split('\n')
        if (blob.at(-1) === '') blob.pop()
        blobs.set(key, blob)
      }
      if (source.line > blob.length)
        throw new Error('Visual diff source line does not exist')
      if (!changed.has(source.path)) continue
      let patch = patches.get(source.path)
      if (patch === undefined) {
        patch = await git(directory, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--unified=0',
          diff.base,
          diff.head,
          '--',
          source.path,
        ])
        patches.set(source.path, patch)
      }
      for (const hunk of patch.matchAll(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu,
      )) {
        const start = Number(hunk[source.side === 'base' ? 1 : 3])
        const count = Number(hunk[source.side === 'base' ? 2 : 4] ?? 1)
        if (source.line >= start && source.line < start + count)
          changedReference = true
      }
    }
    if (node.change !== 'unchanged' && !changedReference)
      throw new Error('Changed node must cite a changed Git hunk')
  }
  for (const ignored of diff.ignored) {
    if (!changed.has(ignored.path))
      throw new Error('Ignored file is not part of the diff')
  }
  return diff
}
