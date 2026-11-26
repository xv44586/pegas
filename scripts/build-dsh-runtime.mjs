import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

// Use the same pinned/setup Node that passed the build, never Electron or a
// machine-specific nvm symlink. dist is copied into both apps and Candidates.
const [major, minor] = process.versions.node.split('.').map(Number)
assert(
  !process.versions.electron && (major > 24 || (major === 24 && minor >= 9)),
  'Build DSH runtime with standalone Node >=24.9.0',
)
const license = readFileSync(
  join(dirname(dirname(process.execPath)), 'LICENSE'),
)
const destination = join('dist', 'runtime')
mkdirSync(destination, { recursive: true })
const executable = join(
  destination,
  process.platform === 'win32' ? 'node.exe' : 'node',
)
copyFileSync(process.execPath, executable)
chmodSync(executable, 0o755)
writeFileSync(join(destination, 'LICENSE.node'), license)
writeFileSync(
  join(destination, 'manifest.json'),
  `${JSON.stringify({ node: process.versions.node, platform: process.platform, arch: process.arch, sha256: createHash('sha256').update(readFileSync(executable)).digest('hex') }, null, 2)}\n`,
)
console.log(
  `Staged standalone Node ${process.versions.node} (${process.platform}/${process.arch}) for DSH`,
)
