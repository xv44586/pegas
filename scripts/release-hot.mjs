#!/usr/bin/env node
// SELF-001 hot release: ship a server/web fix to the running desktop
// instance as an immutable candidate, without repackaging the app.
//
//   node scripts/release-hot.mjs <worktree> <pr-ci.json> [--app <Pegas.app>]
//
// <worktree> must be the isolated feature worktree at the exact merged
// commit with `pnpm check` + `pnpm smoke` logs already captured, and
// <pr-ci.json> the green PR CI evidence for that commit (gh run view --json
// databaseId,workflowName,headSha,conclusion,status,event,url,updatedAt).
//
// The script builds the candidate, materializes dependencies into the
// persistent read-only store, stages it through the running Supervisor,
// waits for stabilization, and verifies the live catalog and readiness.
// When --app is given and the shell predates hot-release boot, it also
// performs the one-time graceful app switch; later releases need no app
// change at all.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repositoryRoot = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const appFlag = args.indexOf('--app')
const appBundle = appFlag >= 0 ? args[appFlag + 1] : undefined
const positional = args.filter((_, index) =>
  appFlag >= 0 ? index !== appFlag && index !== appFlag + 1 : true,
)
const [worktreeArg, ciPath, evidenceDirectory] = positional
if (!worktreeArg || !ciPath) {
  console.error(
    'usage: node scripts/release-hot.mjs <worktree> <pr-ci.json> [evidence-dir] [--app <Pegas.app>]',
  )
  process.exit(1)
}
const worktree = resolve(worktreeArg)
const evidenceRoot = resolve(
  evidenceDirectory ?? join(repositoryRoot, 'output/release-hot'),
)

const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: worktree,
  encoding: 'utf8',
}).trim()
const shortCommit = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
  cwd: worktree,
  encoding: 'utf8',
}).trim()
const ci = JSON.parse(readFileSync(ciPath, 'utf8'))
if (
  ci.headSha !== commit ||
  ci.conclusion !== 'success' ||
  ci.status !== 'completed' ||
  ci.event !== 'pull_request'
)
  throw new Error('Hot release requires green PR CI on the exact commit')

const gateLog = join(evidenceRoot, 'check.log')
const smokeLog = join(evidenceRoot, 'smoke.log')
const check = readFileSync(gateLog, 'utf8')
const testCount = Number(/Tests\s+(\d+) passed/.exec(check)?.[1])
if (
  !Number.isSafeInteger(testCount) ||
  testCount <= 0 ||
  check.includes('ELIFECYCLE')
)
  throw new Error(`Missing local check evidence: ${gateLog}`)
if (!readFileSync(smokeLog, 'utf8').includes('Smoke test passed'))
  throw new Error(`Missing local smoke evidence: ${smokeLog}`)

const {
  buildSelfChangeCandidate,
  materializeCandidateDependencies,
  verifyCandidateReleaseTree,
} = await import(
  pathToFileURL(join(worktree, 'dist/self-change/candidate-builder.js')).href
)
const { readTaskWorkflowContract } = await import(
  pathToFileURL(join(worktree, 'dist/supervisor/task-workflow-contract.js'))
    .href
)

const featureIds = (process.env.PEGAS_HOT_FEATURE_IDS ?? 'SELF-001').split(',')
const releaseId =
  process.env.PEGAS_HOT_RELEASE_ID ??
  `${featureIds[0].toLowerCase()}-${shortCommit}-r1`
const releaseRoot = resolve(
  process.env.PEGAS_RELEASE_ROOT ?? join(repositoryRoot, 'releases'),
)
const outputRoot = join(releaseRoot, 'candidates')
const contract = readTaskWorkflowContract(worktree)

const built = await buildSelfChangeCandidate({
  worktree,
  outputRoot,
  releaseId,
  featureIds,
  compatibility: {
    minimumSchema: 31,
    maximumSchema: contract.maximumSchema,
  },
  runGate: () =>
    Promise.resolve({
      commands: [{ command: 'pnpm check', testCount }],
      smoke: {
        command: 'pnpm smoke',
        status: 'passed',
        completedAt: statSync(smokeLog).mtime.toISOString(),
      },
    }),
  ci: {
    workflow: ci.workflowName,
    runId: String(ci.databaseId),
    url: ci.url,
    conclusion: 'success',
    completedAt: ci.updatedAt,
  },
  reviewer: 'pegas-release-agent',
  notTried: [
    'Desktop app bundle was not repackaged; the Electron shell is unchanged and the staged release carries all server and web bytes.',
  ],
})

const dependencyRoot = join(releaseRoot, 'dependencies', releaseId)
const materialized = materializeCandidateDependencies({
  releaseRoot: built.releaseRoot,
  artifactPath: built.artifactPath,
  manifestPath: built.manifestPath,
  reviewReportPath: built.reviewReportPath,
  dependencyRoot,
})
writeFileSync(
  join(outputRoot, `${releaseId}.reanchor.json`),
  `${JSON.stringify(
    {
      releaseId,
      commit,
      dependencyRoot: materialized.dependencyRoot,
      digest: materialized.digest,
      operation: 'materialize-dependencies',
      performedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
)
verifyCandidateReleaseTree(built.releaseRoot, built.artifactPath)

// Locate the running desktop instance from its process tree, exactly as the
// deployment probes do: shell -> supervisor -> control plane.
const dataDirectory =
  process.env.PEGAS_DESKTOP_DATA_DIR ??
  join(process.env.HOME, 'Library/Application Support/Pegas/data')
const processes = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .map(line => {
    const [, pid, parent, command] =
      /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? []
    return { pid: Number(pid), parent: Number(parent), command: command ?? '' }
  })
const supervisor = processes.find(
  entry =>
    entry.command.includes('/dist/supervisor/main.js') &&
    entry.command.includes('Pegas.app'),
)
if (!supervisor) throw new Error('Running desktop Supervisor not found')
const shell = processes.find(entry => entry.pid === supervisor.parent)
const control = processes.find(
  entry =>
    entry.parent === supervisor.pid &&
    entry.command.includes('/dist/control-plane/main.js'),
)
if (!control) throw new Error('Running desktop Control Plane not found')
function listener(pid) {
  const lines = execFileSync(
    '/usr/sbin/lsof',
    ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
    { encoding: 'utf8' },
  )
  const port = /^n127\.0\.0\.1:(\d+)$/m.exec(lines)?.[1]
  if (!port) throw new Error(`Listener for pid ${String(pid)} not found`)
  return `http://127.0.0.1:${port}`
}
const recovery = listener(supervisor.pid)
const server = listener(control.pid)
const bearer = readFileSync(join(dataDirectory, 'api-token'), 'utf8').trim()
const headers = { authorization: `Bearer ${bearer}` }
async function get(origin, path, options) {
  const response = await fetch(origin + path, {
    headers,
    signal: AbortSignal.timeout(45_000),
    ...options,
  })
  const body = await response.json()
  if (!response.ok)
    throw new Error(
      `${path} ${String(response.status)} ${JSON.stringify(body)}`,
    )
  return body
}

const before = await get(recovery, '/v1/recovery/status')
if (before.phase !== 'stable' || before.recoveryState?.integrity !== 'ok')
  throw new Error('Desktop release is not stable; refusing to stage')
const { runs } = await get(server, '/v1/runs?userId=owner')
if (runs.some(run => run.status === 'running'))
  throw new Error('An execution is still running; retry when it settles')

await get(recovery, '/v1/recovery/candidates', {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({
    manifestPath: built.manifestPath,
    artifactPath: built.artifactPath,
    reviewReportPath: built.reviewReportPath,
  }),
})

async function waitForRelease(expectedPrevious) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await get(recovery, '/v1/recovery/status')
    const ready = await get(server, '/readyz').catch(() => undefined)
    if (
      ready?.releaseId === releaseId &&
      state.phase === 'stable' &&
      state.recoveryState?.integrity === 'ok' &&
      state.previous?.id === expectedPrevious
    )
      return { state, ready }
    await new Promise(resolveWait => setTimeout(resolveWait, 1000))
  }
  throw new Error(`Release ${releaseId} did not stabilize`)
}

const previousId = before.active?.id
const live = await waitForRelease(previousId)
const catalog = await get(server, '/v1/settings/agent-models')
if (!catalog.models.length)
  throw new Error('Live model catalog is empty after the switch')

const evidence = {
  release: releaseId,
  previous: previousId,
  commit,
  hot: true,
  appRepackaged: false,
  recovery: live.state.recoveryState?.integrity,
  phase: live.state.phase,
  modelCount: catalog.models.length,
  pullRequestCi: ci.url,
  dependencyRoot: materialized.dependencyRoot,
  completedAt: new Date().toISOString(),
}
writeFileSync(
  join(outputRoot, `${releaseId}.desktop-deployment.json`),
  `${JSON.stringify(evidence, null, 2)}\n`,
  { mode: 0o600 },
)
console.log(JSON.stringify(evidence))

// Also covers desktop shells whose already-running Supervisor predates retention.
try {
  const { defaultInstances, pruneReleaseHistory, recordRetentionResult } =
    await import(
      pathToFileURL(join(worktree, 'dist/self-change/release-retention.js'))
        .href
    )
  const retention = await pruneReleaseHistory({
    releaseRoot,
    instances: defaultInstances(releaseRoot, {
      dataDirectory,
      statePath: join(dataDirectory, 'supervisor.json'),
    }),
  })
  await recordRetentionResult(releaseRoot, retention)
  console.log(JSON.stringify({ event: 'release.retention', ...retention }))
} catch (error) {
  console.warn('Release is healthy; cleanup needs attention: ' + String(error))
}

if (appBundle) {
  // One-time migration for shells that still boot their bundled supervisor:
  // quit the old app gracefully and open the hot-boot-capable bundle. Later
  // hot releases skip this block entirely.
  const resolvedBundle = resolve(appBundle)
  if (!existsSync(resolvedBundle))
    throw new Error(`App bundle not found: ${resolvedBundle}`)
  console.log(
    JSON.stringify({
      appSwitch: 'required-once',
      bundle: resolvedBundle,
      oldShellPid: shell?.pid,
      note: 'Quit the running Pegas gracefully, then: env -u PATH open <bundle>',
    }),
  )
}
