// SELF-001 end-to-end scenario smoke (MVP scenarios 5 and 6):
// an independently running Supervisor stages a verified immutable candidate,
// the candidate takes over the service, and a candidate that cannot start is
// rolled back automatically while the Recovery API stays online throughout.
//
// Requires `pnpm build` first. Run with: node scripts/smoke-self-change.mjs
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildSelfChangeCandidate } from '../dist/self-change/candidate-builder.js'

if (!existsSync(resolve('dist/supervisor/main.js')))
  throw new Error('Run pnpm build before the self-change smoke test')

const workspace = mkdtempSync(join(tmpdir(), 'pegas-self-smoke-'))
const apiPort = await availablePort()
const recoveryPort = await availablePort()
const apiToken = `self-smoke-${process.pid}`
const dataDirectory = join(workspace, 'data')
mkdirSync(dataDirectory, { recursive: true })

const supervisor = spawn(
  process.execPath,
  [resolve('dist/supervisor/main.js')],
  {
    env: {
      ...process.env,
      PEGAS_SUPERVISOR_STATE: join(workspace, 'supervisor.json'),
      PEGAS_DATA_DIR: dataDirectory,
      PEGAS_API_HOST: '127.0.0.1',
      PEGAS_API_PORT: String(apiPort),
      PEGAS_API_TOKEN: apiToken,
      PEGAS_RECOVERY_HOST: '127.0.0.1',
      PEGAS_RECOVERY_PORT: String(recoveryPort),
      PEGAS_RELEASE_ID: 'smoke-base',
      PEGAS_RELEASE_ROOT: resolve('.'),
      PEGAS_STARTUP_GRACE_MS: '20000',
      PEGAS_STABILIZATION_MS: '1500',
      PEGAS_EVENT_POLL_MS: '25',
      PEGAS_SCHEDULER_POLL_MS: '25',
      PEGAS_OUTBOX_POLL_MS: '25',
      PEGAS_EXECUTOR: 'echo',
      PEGAS_ROUTER: 'rules',
      PEGAS_PUSH_MODE: 'poll',
    },
    stdio: 'inherit',
  },
)

const recoveryBase = `http://127.0.0.1:${recoveryPort}`
const apiBase = `http://127.0.0.1:${apiPort}`
let recoverySeenOnline = false

// The candidate must come from a clean checkout at an exact commit. Clone the
// tracked tree into an isolated worktree, overlay the freshly built dist
// (build output is gitignored) and commit, so the smoke also works while the
// feature branch itself still has uncommitted work.
const candidateWorktree = join(workspace, 'candidate-worktree')
execFileSync(
  'git',
  ['worktree', 'add', '--detach', candidateWorktree, 'HEAD'],
  { stdio: 'inherit' },
)
cpSync(resolve('dist'), join(candidateWorktree, 'dist'), { recursive: true })
execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
  cwd: candidateWorktree,
  stdio: 'inherit',
})
execFileSync('git', ['add', '-A'], { cwd: candidateWorktree })
execFileSync(
  'git',
  ['commit', '--allow-empty', '-qm', 'self-change smoke candidate'],
  {
    cwd: candidateWorktree,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Pegas Smoke',
      GIT_AUTHOR_EMAIL: 'smoke@pegas.local',
      GIT_COMMITTER_NAME: 'Pegas Smoke',
      GIT_COMMITTER_EMAIL: 'smoke@pegas.local',
    },
  },
)

try {
  await waitFor(
    async () => {
      const status = await fetchStatus()
      return status?.active?.id === 'smoke-base'
    },
    20_000,
    'Supervisor did not register the base release',
  )
  await waitForRelease('smoke-base', 30_000)
  await verifyTaskLoop('candidate takeover base loop')

  // Scenario 5: build a verified candidate from the exact checkout and stage
  // it through the Recovery API; the candidate must take over the service.
  const good = await buildSelfChangeCandidate({
    worktree: candidateWorktree,
    outputRoot: join(workspace, 'candidates'),
    releaseId: 'smoke-good',
    featureIds: ['SELF-001'],
    compatibility: { minimumSchema: 1, maximumSchema: 25 },
    reviewer: 'self-change-smoke',
    runGate: () =>
      Promise.resolve({
        commands: [
          { command: 'node scripts/smoke-self-change.mjs', testCount: 0 },
        ],
        smoke: {
          command: 'node scripts/smoke-self-change.mjs',
          status: 'passed',
          completedAt: new Date().toISOString(),
        },
      }),
  })
  // The broken candidate is an honest immutable build of a bad commit: the
  // entrypoint fails at runtime (missing module) while every static check
  // still passes. Commit the breakage in the isolated worktree BEFORE
  // building, because tampering with a frozen tree after attestation is
  // rejected at staging time (covered separately by the unit tests).
  writeFileSync(
    join(candidateWorktree, 'dist/control-plane/main.js'),
    "import 'pegas-self-smoke-missing-runtime-module'\n",
  )
  // dist is gitignored; force-add the broken entrypoint so it becomes part of
  // the bad commit and the candidate copies it from the worktree.
  execFileSync('git', ['add', '-f', 'dist/control-plane/main.js'], {
    cwd: candidateWorktree,
  })
  execFileSync('git', ['commit', '-qm', 'broken control-plane entrypoint'], {
    cwd: candidateWorktree,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Pegas Smoke',
      GIT_AUTHOR_EMAIL: 'smoke@pegas.local',
      GIT_COMMITTER_NAME: 'Pegas Smoke',
      GIT_COMMITTER_EMAIL: 'smoke@pegas.local',
    },
  })
  const bad = await buildSelfChangeCandidate({
    worktree: candidateWorktree,
    outputRoot: join(workspace, 'candidates'),
    releaseId: 'smoke-bad',
    featureIds: ['SELF-001'],
    compatibility: { minimumSchema: 1, maximumSchema: 25 },
    reviewer: 'self-change-smoke',
    runGate: () =>
      Promise.resolve({
        commands: [
          { command: 'node scripts/smoke-self-change.mjs', testCount: 0 },
        ],
        smoke: {
          command: 'node scripts/smoke-self-change.mjs',
          status: 'passed',
          completedAt: new Date().toISOString(),
        },
      }),
  })
  // A real Recovery API stage must honor the same cleanup fence.
  const { acquireReleaseDirectoryLock } =
    await import('../dist/self-change/release-directory-lock.js')
  const releaseFence = acquireReleaseDirectoryLock(workspace)
  try {
    let rejected = false
    try {
      await stageCandidate(good)
    } catch (error) {
      if (!String(error).includes('maintenance')) throw error
      rejected = true
    }
    if (!rejected || (await fetchStatus())?.active?.id !== 'smoke-base')
      throw new Error('Staging bypassed release cleanup fence')
  } finally {
    releaseFence()
  }
  console.log(
    'Scenario 5 fence passed: cleanup lock rejects real staging without changing active release',
  )
  await stageCandidate(good)
  await waitForRelease('smoke-good', 60_000)
  const confirmed = await waitFor(
    async () => {
      const status = await fetchStatus()
      return status?.phase === 'stable' && status.active?.id === 'smoke-good'
        ? status
        : undefined
    },
    20_000,
    'Candidate did not pass stabilization',
  )
  if (confirmed.previous?.id !== 'smoke-base')
    throw new Error('Supervisor did not retain the previous release')
  await verifyTaskLoop('candidate takeover loop')
  console.log('Scenario 5 passed: candidate smoke-good took over the service')

  // Scenario 6: the runtime-broken candidate must be rolled back
  // automatically and the Recovery API must stay online throughout.
  await stageCandidate(bad)
  const rolledBack = await waitFor(
    async () => {
      const status = await fetchStatus()
      if (!status) throw new Error('Recovery API went offline during rollback')
      return status.phase === 'rolled_back' &&
        status.active?.id === 'smoke-good'
        ? status
        : undefined
    },
    60_000,
    'Supervisor did not roll back the failing candidate',
  )
  if (!rolledBack.lastFailure?.includes('smoke-bad'))
    throw new Error('Rollback did not record the failing candidate')
  await waitForRelease('smoke-good', 60_000)
  await verifyTaskLoop('post-rollback durable loop')
  if (!recoverySeenOnline) throw new Error('Recovery API was never observed')
  console.log(
    'Scenario 6 passed: failing candidate rolled back; Recovery API stayed online',
  )
  console.log('Self-change smoke test passed')
} finally {
  supervisor.kill('SIGTERM')
  await Promise.race([
    onceExit(supervisor),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 8000)),
  ])
  if (supervisor.exitCode === null) supervisor.kill('SIGKILL')
  execFileSync('git', ['worktree', 'remove', '--force', candidateWorktree], {
    stdio: 'inherit',
  })
  restoreWritable(workspace)
  rmSync(workspace, { recursive: true, force: true })
}

async function stageCandidate(built) {
  const response = await fetch(`${recoveryBase}/v1/recovery/candidates`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      manifestPath: built.manifestPath,
      artifactPath: built.artifactPath,
      reviewReportPath: built.reviewReportPath,
    }),
  })
  if (response.status !== 202)
    throw new Error(
      `Staging ${built.manifest.release.id} failed: ${response.status} ${await response.text()}`,
    )
}

async function fetchStatus() {
  try {
    const response = await fetch(`${recoveryBase}/v1/recovery/status`, {
      headers: { authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return undefined
    recoverySeenOnline = true
    return await response.json()
  } catch {
    return undefined
  }
}

async function waitForRelease(releaseId, timeoutMs) {
  await waitFor(
    async () => {
      try {
        const response = await fetch(`${apiBase}/readyz`, {
          signal: AbortSignal.timeout(2000),
        })
        if (!response.ok) return undefined
        const body = await response.json()
        return body.releaseId === releaseId ? body : undefined
      } catch {
        return undefined
      }
    },
    timeoutMs,
    `Release ${releaseId} did not become ready`,
  )
}

async function verifyTaskLoop(text) {
  const eventResponse = await fetch(`${apiBase}/v1/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      userId: 'self-smoke-user',
      type: 'user.message',
      source: 'web',
      dedupeKey: `self-smoke-${text.replaceAll(' ', '-')}`,
      payload: { text },
    }),
  })
  if (eventResponse.status !== 202)
    throw new Error(`Event intake failed with ${eventResponse.status}`)
  const run = await waitFor(
    async () => {
      const tasksResponse = await fetch(
        `${apiBase}/v1/tasks?userId=self-smoke-user`,
        { headers: { authorization: `Bearer ${apiToken}` } },
      )
      if (!tasksResponse.ok) return undefined
      const tasks = (await tasksResponse.json()).tasks ?? []
      const task = tasks.find(entry => entry.title === text)
      if (!task) return undefined
      const runsResponse = await fetch(
        `${apiBase}/v1/runs?userId=self-smoke-user&taskId=${encodeURIComponent(task.id)}`,
        { headers: { authorization: `Bearer ${apiToken}` } },
      )
      if (!runsResponse.ok) return undefined
      const runs = (await runsResponse.json()).runs ?? []
      return runs.find(entry => entry.status === 'completed')
    },
    30_000,
    `Durable task loop did not complete for "${text}"`,
  )
  if (run.output !== text)
    throw new Error('Completed run output did not round-trip')
}

async function waitFor(probe, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  throw new Error(message)
}

function onceExit(child) {
  return new Promise(resolveExit => {
    if (child.exitCode !== null) return resolveExit()
    child.once('exit', () => resolveExit())
  })
}

function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string')
        return rejectPort(new Error('No TCP address'))
      server.close(() => resolvePort(address.port))
    })
  })
}

function restoreWritable(directory) {
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(path)
      else chmodSync(path, statSync(path).mode | 0o200)
    }
  }
  if (existsSync(directory)) walk(directory)
}
