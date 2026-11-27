import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface EvidenceOptions {
  workspace: string
  root: string
  runId: string
  attempt: string
  job: string
  sha: string
  steps: unknown
  now?: Date
}

export function archiveEvidence(options: EvidenceOptions): string {
  for (const value of [options.runId, options.attempt, options.job]) {
    if (!/^[a-zA-Z0-9_-]+$/.test(value))
      throw new Error('Unsafe evidence identity')
  }
  if (!/^[a-f0-9]{40}$/.test(options.sha))
    throw new Error('Evidence requires an exact commit SHA')
  const now = options.now ?? new Date()
  mkdirSync(options.root, { recursive: true, mode: 0o700 })
  const id = `ci-${options.runId}-${options.attempt}-${options.job}`
  const destination = join(options.root, id)
  // An already archived attempt is immutable. A rerun must use a new attempt.
  mkdirSync(destination, { mode: 0o700 })
  for (const name of ['feature-review', 'command-grants', 'nightly']) {
    const source = join(options.workspace, 'output', name)
    if (existsSync(source))
      cpSync(source, join(destination, name), {
        recursive: true,
        dereference: false,
      })
  }
  writeFileSync(
    join(destination, 'evidence.json'),
    JSON.stringify(
      {
        version: 1,
        id,
        sha: options.sha,
        host: hostname(),
        createdAt: now.toISOString(),
        steps: options.steps,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  const cutoff = now.getTime() - 7 * 24 * 60 * 60_000
  for (const entry of readdirSync(options.root, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith('ci-') ||
      entry.name === id
    )
      continue
    const directory = join(options.root, entry.name)
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, 'evidence.json'), 'utf8'),
      ) as { version: number; id: string; createdAt: string }
      if (
        manifest.version === 1 &&
        manifest.id === entry.name &&
        Date.parse(manifest.createdAt) < cutoff
      )
        rmSync(directory, { recursive: true, force: true })
    } catch {
      /* Incomplete and unknown directories are not retention candidates. */
    }
  }
  return destination
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const destination = archiveEvidence({
    workspace: process.cwd(),
    root: join(homedir(), '.local', 'state', 'pegas-ci', 'evidence'),
    runId: process.env.GITHUB_RUN_ID ?? '',
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? '',
    job: `${process.env.GITHUB_JOB ?? ''}-${process.env.PEGAS_CI_SUITE ?? 'checks'}`,
    sha: process.env.PEGAS_TESTED_SHA ?? process.env.GITHUB_SHA ?? '',
    steps: JSON.parse(process.env.PEGAS_CI_STEPS ?? '{}') as unknown,
  })
  const message = `Evidence retained for seven days on ${hostname()}: ${destination}\n`
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, message)
  console.log(message)
}
