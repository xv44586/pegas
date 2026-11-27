import { lstatSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function runtimePrivateRoot(): string {
  const root = join(
    tmpdir(),
    `pegas-runtime-private-${String(process.getuid?.() ?? 'local')}`,
  )
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const stat = lstatSync(root)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error(
      'Runtime private root is not owned and private; refusing unconfined capabilities',
    )
  return root
}
