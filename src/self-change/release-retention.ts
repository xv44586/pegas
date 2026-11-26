import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { acquireReleaseDirectoryLock } from './release-directory-lock.js'
import { readCandidateManifest } from '../supervisor/candidate-manifest.js'
import { ReleaseStateStore } from '../supervisor/release-state.js'

const exec = promisify(execFile)
interface Instance {
  statePath: string
  dataDirectory: string
}
interface HostProtection {
  unsupportedSupervisors?: number[]
  paths: string[]
  supervisorPids: number[]
}
export interface RetentionOptions {
  releaseRoot: string
  instances?: Instance[]
  dryRun?: boolean
  /** Deterministic host boundary for tests; production always inventories the OS. */
  inspectHost?: (knownPids: readonly number[]) => Promise<HostProtection>
}
interface Candidate {
  id: string
  root: string
  createdAt: string
  manifest: string
  manifestHash: string
}
export interface RetentionResult {
  status: 'completed' | 'dry-run' | 'skipped' | 'partial'
  kept: string[]
  planned: string[]
  deleted: string[]
  deletedDependencies: string[]
  reason?: string
}

/** Successful release housekeeping. Failure never turns a healthy release into a failed deploy. */
export async function pruneReleaseHistory(
  options: RetentionOptions,
): Promise<RetentionResult> {
  const result: RetentionResult = {
    status: 'skipped',
    kept: [],
    planned: [],
    deleted: [],
    deletedDependencies: [],
  }
  let unlock: (() => void) | undefined
  try {
    const root = realpathSync(options.releaseRoot)
    if (dirname(root) === root) throw new Error('Invalid release root')
    const candidateRoot = join(root, 'candidates'),
      dependencyRoot = join(root, 'dependencies')
    assertDirectory(candidateRoot)
    if (existsSync(dependencyRoot)) assertDirectory(dependencyRoot)
    unlock = acquireReleaseDirectoryLock(root)
    const instances = options.instances ?? defaultInstances(root)
    const inspectHost =
      options.inspectHost ??
      ((knownPids: readonly number[]) => inspectReleaseHost(root, knownPids))
    const snapshot = await protection(
      root,
      options.releaseRoot,
      instances,
      inspectHost,
    )
    const candidates: Candidate[] = []
    for (const entry of await readdir(candidateRoot)) {
      if (!entry.endsWith('.manifest.json')) continue
      const manifest = join(candidateRoot, entry)
      if (!lstatSync(manifest).isFile() || lstatSync(manifest).isSymbolicLink())
        throw new Error('Unsafe manifest: ' + entry)
      const parsed = readCandidateManifest(manifest)
      const { id, createdAt } = parsed.release
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) ||
        entry !== id + '.manifest.json' ||
        !Number.isFinite(Date.parse(createdAt))
      )
        throw new Error('Invalid release identity: ' + entry)
      const path = join(candidateRoot, id)
      if (!existsSync(path)) continue // A prior interrupted deletion can leave audit metadata.
      assertDirectory(path)
      if (realpathSync(parsed.release.root) !== realpathSync(path))
        throw new Error('Manifest root does not match: ' + id)
      candidates.push({
        id,
        root: path,
        createdAt,
        manifest,
        manifestHash: hash(readFileSync(manifest)),
      })
    }
    const kept = new Set(
      candidates
        .toSorted(
          (a, b) =>
            Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
            b.id.localeCompare(a.id),
        )
        .slice(0, 3)
        .map(c => c.id),
    )
    const dependencyKeep = new Set<string>()
    for (const path of snapshot.paths)
      addReferences(path, root, options.releaseRoot, kept, dependencyKeep)
    // Frozen retained trees can share dependencies with another release. Unfinished builds also count.
    const candidatesById = new Set(candidates.map(c => c.id))
    const scanned = new Set<string>()
    const pending: string[] = []
    for (const entry of await readdir(candidateRoot, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        (kept.has(entry.name) || !candidatesById.has(entry.name))
      )
        pending.push(join(candidateRoot, entry.name))
    }
    while (pending.length) {
      const path = pending.pop()
      if (!path || scanned.has(path)) continue
      scanned.add(path)
      for (const target of await linksIn(path))
        addReferences(target, root, options.releaseRoot, kept, dependencyKeep)
      for (const id of dependencyKeep) {
        const dep = join(dependencyRoot, id)
        if (existsSync(dep) && !scanned.has(dep)) pending.push(dep)
      }
      for (const id of kept) {
        const dir = join(candidateRoot, id)
        if (existsSync(dir) && !scanned.has(dir)) pending.push(dir)
      }
    }
    result.kept = [...kept].filter(id => candidatesById.has(id)).sort()
    const remove = candidates
      .filter(c => !kept.has(c.id))
      .sort((a, b) => a.id.localeCompare(b.id))
    result.planned = remove.map(c => c.id)
    if (options.dryRun) {
      result.status = 'dry-run'
      return result
    }
    for (const candidate of remove) {
      const current = await protection(
        root,
        options.releaseRoot,
        instances,
        inspectHost,
      )
      if (current.fingerprint !== snapshot.fingerprint)
        throw new Error('Release protection changed during cleanup')
      if (hash(readFileSync(candidate.manifest)) !== candidate.manifestHash)
        throw new Error('Manifest changed during cleanup')
      assertDirectory(candidate.root)
      const dependency = join(dependencyRoot, candidate.id)
      if (!dependencyKeep.has(candidate.id) && existsSync(dependency)) {
        assertDirectory(dependency)
        await removeFrozenTree(dependency)
        result.deletedDependencies.push(candidate.id)
      }
      await removeFrozenTree(candidate.root)
      result.deleted.push(candidate.id)
      // Known metadata only. Arbitrary files and user-created directories are never glob-deleted.
      for (const suffix of [
        '.json',
        '.review.json',
        '.reanchor.json',
        '.desktop-deployment.json',
        '.manifest.json',
      ]) {
        const path = join(candidateRoot, candidate.id + suffix)
        if (existsSync(path) && lstatSync(path).isFile()) await rm(path)
      }
    }
    result.status = 'completed'
  } catch (error) {
    result.status = result.deleted.length ? 'partial' : 'skipped'
    result.reason = error instanceof Error ? error.message : String(error)
  } finally {
    unlock?.()
  }
  return result
}

export function defaultInstances(root: string, current?: Instance): Instance[] {
  const data = [
    join(dirname(root), 'data'),
    join(homedir(), 'Library/Application Support/Pegas/data'),
  ]
  const instances = data.map(dataDirectory => ({
    dataDirectory,
    statePath: join(dataDirectory, 'supervisor.json'),
  }))
  if (current) instances.push(current)
  return [
    ...new Map(instances.map(item => [resolve(item.statePath), item])).values(),
  ]
}

async function protection(
  root: string,
  originalRoot: string,
  instances: Instance[],
  inspect: (knownPids: readonly number[]) => Promise<HostProtection>,
) {
  const paths: string[] = [],
    facts: string[] = [],
    knownPids = new Set<number>()
  let count = 0
  for (const instance of instances) {
    const lock = join(instance.dataDirectory, 'supervisor.lock')
    if (!existsSync(instance.statePath)) {
      if (existsSync(lock) || existsSync(instance.statePath + '.last-good'))
        throw new Error('Missing Supervisor state: ' + instance.statePath)
      continue
    }
    for (const path of [
      instance.statePath,
      instance.statePath + '.last-good',
    ]) {
      if (!existsSync(path)) continue
      const state = new ReleaseStateStore(path).inspect()
      if (state.integrity !== 'ok' || !state.state)
        throw new Error('Untrusted Supervisor state: ' + path)
      if (path === instance.statePath && state.state.phase !== 'stable')
        throw new Error('Supervisor is not stable: ' + path)
      paths.push(state.state.active.root)
      if (state.state.previous) paths.push(state.state.previous.root)
      facts.push(hash(readFileSync(path)))
    }
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, 'utf8').trim())
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error('Invalid Supervisor lock')
      knownPids.add(pid)
      facts.push(String(pid))
    }
    count++
  }
  if (!count) throw new Error('No verified Supervisor state')
  const host = await inspect([...knownPids])
  if (host.unsupportedSupervisors?.length)
    throw new Error(
      'Supervisor needs release-directory lock support: ' +
        host.unsupportedSupervisors.join(', '),
    )
  for (const pid of host.supervisorPids)
    if (!knownPids.has(pid))
      throw new Error('Unknown Supervisor instance: ' + String(pid))
  paths.push(...host.paths)
  const refs = new Set<string>(),
    deps = new Set<string>()
  for (const path of paths) addReferences(path, root, originalRoot, refs, deps)
  return {
    paths,
    fingerprint: hash(
      JSON.stringify({ facts, refs: [...refs].sort(), deps: [...deps].sort() }),
    ),
  }
}

function addReferences(
  text: string,
  root: string,
  original: string,
  candidates: Set<string>,
  dependencies: Set<string>,
) {
  for (const base of new Set([root, resolve(original)]))
    for (const [folder, set] of [
      ['candidates', candidates],
      ['dependencies', dependencies],
    ] as const) {
      const prefix = join(base, folder) + sep
      let start = text.indexOf(prefix)
      while (start >= 0) {
        const id = /^[a-zA-Z0-9][a-zA-Z0-9._-]*/.exec(
          text.slice(start + prefix.length),
        )?.[0]
        if (id) set.add(id)
        start = text.indexOf(prefix, start + prefix.length)
      }
    }
}
async function linksIn(root: string): Promise<string[]> {
  const paths: string[] = []
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isSymbolicLink()) paths.push(...linkReferences(child))
      else if (entry.isDirectory()) await walk(child)
    }
  }
  if (lstatSync(root).isSymbolicLink()) paths.push(...linkReferences(root))
  else await walk(root)
  return paths
}
/** Keep every intermediate path, including symlinks in parent components. */
function linkReferences(path: string): string[] {
  const paths: string[] = []
  let parts = path.split(sep),
    prefix: string = sep,
    hops = 0
  while (parts.length) {
    const part = parts.shift()
    if (!part || part === '.') continue
    if (part === '..') {
      prefix = dirname(prefix)
      continue
    }
    const child = join(prefix, part)
    // Record traversed directories before applying any later '..'.
    paths.push(child)
    if (lstatSync(child).isSymbolicLink()) {
      if (++hops > 40) throw new Error('Too many symlink hops: ' + path)
      const target = readlinkSync(child)
      if (target.startsWith(sep)) prefix = sep
      parts = [...target.split(sep), ...parts]
    } else prefix = child
  }
  return paths
}

/** Includes linked launch definitions; unreadable definitions fail closed. */
export async function readStartupReferences(
  directories: readonly string[],
): Promise<string[]> {
  const paths: string[] = []
  for (const directory of directories) {
    if (!existsSync(directory)) continue
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        (entry.name.endsWith('.plist') || entry.name.endsWith('.service'))
      ) {
        const path = join(directory, entry.name)
        paths.push(...linkReferences(path), await readFile(path, 'utf8'))
      }
  }
  return paths
}

async function removeFrozenTree(root: string): Promise<void> {
  const unlock = async (path: string): Promise<void> => {
    await chmod(path, 0o700)
    for (const entry of await readdir(path, { withFileTypes: true }))
      if (entry.isDirectory()) await unlock(join(path, entry.name))
  }
  await unlock(root)
  await rm(root, { recursive: true })
}
function assertDirectory(path: string) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('Unsafe release directory: ' + path)
}
function hash(bytes: string | Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}
/** OS inventory is intentionally fail-closed; unsupported hosts keep all releases. */
export async function inspectReleaseHost(
  root: string,
  knownPids: readonly number[],
  platform: NodeJS.Platform = process.platform,
): Promise<HostProtection> {
  // systemd effective units/drop-ins need a complete inventory before enabling Linux.
  if (platform !== 'darwin')
    throw new Error('Release retention host inventory unsupported')
  const options = {
    encoding: 'utf8' as const,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  }
  const { stdout: ps } = await exec(
    '/bin/ps',
    ['-axo', 'pid=,command='],
    options,
  )
  const { stdout: open } = await exec('/usr/sbin/lsof', ['-nP', '-Fn'], options)
  const paths = [
    ps,
    open,
    ...(await readStartupReferences([
      join(homedir(), 'Library/LaunchAgents'),
      '/Library/LaunchAgents',
      '/Library/LaunchDaemons',
    ])),
  ]
  return { paths, ...supervisorProcessProtection(ps, root, knownPids) }
}

/** Validate every registered PID, including bundled/foreign bootstrap paths. */
export function supervisorProcessProtection(
  listing: string,
  root: string,
  knownPids: readonly number[],
): Pick<HostProtection, 'supervisorPids' | 'unsupportedSupervisors'> {
  const commands = new Map(
    listing.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line)
      return match ? [[Number(match[1]), match[2] ?? ''] as const] : []
    }),
  )
  const supervisorPids = [...commands]
    .filter(([, command]) => command.includes('/dist/supervisor/main.js'))
    .map(([pid]) => pid)
  const unsupportedSupervisors = [
    ...new Set([...knownPids, ...supervisorPids]),
  ].filter(pid => {
    const command = commands.get(pid) ?? ''
    if (!command.includes('/dist/supervisor/main.js')) return true
    const refs = new Set<string>(),
      deps = new Set<string>()
    addReferences(command, root, root, refs, deps)
    return ![...refs].some(
      id =>
        command.includes(
          join(root, 'candidates', id, 'dist/supervisor/main.js'),
        ) &&
        existsSync(
          join(
            root,
            'candidates',
            id,
            'dist/self-change/release-directory-lock.js',
          ),
        ),
    )
  })
  return { supervisorPids, unsupportedSupervisors }
}

export async function recordRetentionResult(
  root: string,
  result: RetentionResult,
): Promise<void> {
  const path = join(root, 'retention-last.json'),
    temporary = path + '.' + randomUUID()
  await mkdir(root, { recursive: true })
  try {
    await writeFile(
      temporary,
      JSON.stringify(
        { ...result, completedAt: new Date().toISOString() },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    )
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
