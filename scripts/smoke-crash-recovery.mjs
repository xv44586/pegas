// EXEC-003 / MVP scenario 2: kill the worker at three durable crash points
// (event claim, tool side effect, result write-back) and prove that a restarted
// worker neither loses the task nor repeats the external side effect.
//
// Requires `pnpm build` first. The fake DSH executor is a test double injected
// through PEGAS_DSH_COMMAND: it appends one marker per real side effect and
// SIGKILLs its worker (and itself) at the requested crash point. Recovery then
// goes through the real lease-expiry path, so each scenario waits out the
// production 30s Run lease; the whole smoke takes roughly two minutes.
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dataDirectory = mkdtempSync(join(tmpdir(), 'pegas-crash-'))
const effectsDirectory = join(dataDirectory, 'effects')
const markerDirectory = join(dataDirectory, 'markers')
const workspaceDirectory = join(dataDirectory, 'workspace')
for (const directory of [
  effectsDirectory,
  markerDirectory,
  workspaceDirectory,
]) {
  mkdirSync(directory, { recursive: true })
}
const fakeCommand = join(dataDirectory, 'fake-dsh.mjs')
writeFileSync(fakeCommand, fakeDshSource(), { mode: 0o755 })
const debugLog = join(dataDirectory, 'fake-dsh.log')

const port = await availablePort()
const apiToken = `crash-smoke-${String(process.pid)}`
const userId = 'crash-user'
const environment = {
  ...process.env,
  PEGAS_API_HOST: '127.0.0.1',
  PEGAS_API_PORT: String(port),
  PEGAS_API_TOKEN: apiToken,
  PEGAS_DATA_DIR: dataDirectory,
  PEGAS_EVENT_POLL_MS: '25',
  PEGAS_SCHEDULER_POLL_MS: '25',
  PEGAS_OUTBOX_POLL_MS: '25',
  PEGAS_EXECUTOR: 'dsh',
  PEGAS_DSH_COMMAND: fakeCommand,
  PEGAS_DSH_TIMEOUT_MS: '20000',
  PEGAS_MODEL_PROVIDER: 'magpie',
  PEGAS_MODEL_BASE_URL: 'http://127.0.0.1:3425/v1',
  PEGAS_ROUTER: 'rules',
  PEGAS_PRIVACY_MODE: 'disabled',
  PEGAS_WORKSPACE_ROOT: workspaceDirectory,
  PEGAS_PUSH_MODE: 'disabled',
  CRASH_EFFECTS_DIR: effectsDirectory,
  CRASH_MARKER_DIR: markerDirectory,
  CRASH_DEBUG_LOG: debugLog,
}

const controlPlane = spawn(
  process.execPath,
  [resolve('dist/control-plane/main.js')],
  { env: environment, stdio: 'inherit' },
)
const workers = []

try {
  await waitUntil(() => ready(port), 8000, 'control plane did not become ready')
  startWorker()

  // Crash point 1: the worker dies mid-execution right after claiming the
  // event's Run, before any side effect. The event itself may already be
  // routed; the restarted worker must recover the Run through lease expiry
  // and finish the task without losing or duplicating it.
  await postEvent('crash-event-claim', '在事件领取后崩溃 [crash:event-claim]')
  await waitUntil(
    () => markerExists('event-claim'),
    10000,
    'worker did not reach the event-claim crash point',
  )
  await restartWorkerAfterCrash()
  const firstTask = await waitForTask('在事件领取后崩溃 [crash:event-claim]')
  const firstRuns = await waitForSettledRuns(firstTask.id, 1)
  assertSingleCompletion(firstRuns, 'event-claim')
  if (effectCount(firstTask.id) !== 1)
    throw new Error('event-claim crash lost or repeated the side effect')
  await waitForEventStatus('crash-event-claim', 'processed')

  // Crash point 2: the worker dies after the tool side effect but before the
  // result is written back. Recovery must resume the persisted DSH session
  // and must not repeat the side effect.
  await postEvent('crash-tool-call', '在工具调用后崩溃 [crash:tool-call]')
  const secondTask = await waitForTask('在工具调用后崩溃 [crash:tool-call]')
  await waitUntil(
    () => markerExists(`tool-${secondTask.id}`),
    10000,
    'worker did not reach the tool-call crash point',
  )
  await restartWorkerAfterCrash()
  const secondRuns = await waitForSettledRuns(secondTask.id, 2)
  assertSingleCompletion(secondRuns, 'tool-call')
  const failed = secondRuns.filter(run => run.status === 'failed')
  const completed = secondRuns.filter(run => run.status === 'completed')
  if (failed.length !== 1 || failed[0].lastError !== 'lease_expired')
    throw new Error(
      'tool-call crash did not settle the old Run as lease_expired',
    )
  if (completed[0].retryOfRunId !== failed[0].id)
    throw new Error('retry Run is not linked to the crashed Run')
  if (!completed[0].resumeFromRef)
    throw new Error('retry Run did not resume the persisted session')
  if (effectCount(secondTask.id) !== 1)
    throw new Error('tool-call crash repeated the external side effect')
  if (!resumeMarkerExists(secondTask.id))
    throw new Error('retry did not resume with the recorded session id')

  // Crash point 3: the worker dies after the final result event but before
  // the completion write-back. Recovery must re-enter through the saved
  // session without a second side effect and complete exactly once.
  await postEvent(
    'crash-write-back',
    '在结果写回前崩溃 [crash:result-write-back]',
  )
  const thirdTask = await waitForTask(
    '在结果写回前崩溃 [crash:result-write-back]',
  )
  await waitUntil(
    () => markerExists(`write-${thirdTask.id}`),
    10000,
    'worker did not reach the result-write-back crash point',
  )
  await restartWorkerAfterCrash()
  const thirdRuns = await waitForSettledRuns(thirdTask.id, 2)
  assertSingleCompletion(thirdRuns, 'result-write-back')
  if (effectCount(thirdTask.id) !== 1)
    throw new Error('write-back crash repeated the external side effect')
  const outbox = await getJson(`/v1/outbox?userId=${userId}`)
  const completionMessages = (outbox.messages ?? []).filter(
    message =>
      message.taskId === thirdTask.id &&
      message.payload?.type === 'run.completed',
  )
  if (completionMessages.length !== 1)
    throw new Error('write-back crash duplicated the completion notification')
  await waitForEventStatus('crash-tool-call', 'processed')
  await waitForEventStatus('crash-write-back', 'processed')

  console.log(
    `Crash-recovery smoke passed: event-claim=${firstTask.id} tool-call=${secondTask.id} write-back=${thirdTask.id}`,
  )
} catch (error) {
  if (existsSync(debugLog))
    console.error('--- fake DSH log ---\n' + readFileSync(debugLog, 'utf8'))
  throw error
} finally {
  for (const child of [...workers, controlPlane]) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM')
  }
  await Promise.race([
    Promise.all([...workers, controlPlane].map(child => waitForExit(child))),
    wait(3000),
  ])
  for (const child of [...workers, controlPlane]) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  }
  rmSync(dataDirectory, { recursive: true, force: true })
}

function startWorker() {
  const logFd = openSync(
    join(dataDirectory, `worker-${String(workers.length + 1)}.log`),
    'a',
  )
  const child = spawn(process.execPath, [resolve('dist/worker/main.js')], {
    env: environment,
    stdio: ['ignore', logFd, logFd],
    detached: true,
  })
  closeSync(logFd)
  workers.push(child)
  return child
}

async function restartWorkerAfterCrash() {
  const crashed = workers[workers.length - 1]
  await waitUntil(
    () => crashed.exitCode !== null || crashed.signalCode !== null,
    15000,
    'crash marker written but the worker never died',
  )
  startWorker()
}

function assertSingleCompletion(runs, scenario) {
  const completed = runs.filter(run => run.status === 'completed')
  const failed = runs.filter(run => run.status === 'failed')
  if (
    completed.length !== 1 ||
    runs.length !== completed.length + failed.length ||
    failed.some(run => run.lastError !== 'lease_expired')
  )
    throw new Error(`${scenario} crash did not complete the task exactly once`)
}

async function postEvent(dedupeKey, text) {
  const response = await fetch(`http://127.0.0.1:${String(port)}/v1/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      userId,
      type: 'user.message',
      source: 'web',
      dedupeKey,
      payload: { text },
    }),
  })
  if (response.status !== 202)
    throw new Error(`event ${dedupeKey} returned ${String(response.status)}`)
}

async function getJson(path) {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    headers: { authorization: `Bearer ${apiToken}` },
  })
  if (!response.ok)
    throw new Error(`${path} returned ${String(response.status)}`)
  return response.json()
}

async function ready(apiPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${String(apiPort)}/readyz`)
    return response.ok
  } catch {
    return false
  }
}

async function waitForTask(title) {
  let found
  await waitUntil(
    async () => {
      const body = await getJson(`/v1/tasks?userId=${userId}`)
      found = (body.tasks ?? []).find(task => task.title === title)
      return found !== undefined
    },
    15000,
    `task "${title}" was not created after recovery`,
  )
  return found
}

async function waitForSettledRuns(taskId, minimumRuns) {
  let runs = []
  await waitUntil(
    async () => {
      const body = await getJson(
        `/v1/runs?userId=${userId}&taskId=${encodeURIComponent(taskId)}`,
      )
      runs = body.runs ?? []
      return (
        runs.length >= minimumRuns &&
        runs.some(run => run.status === 'completed') &&
        runs.every(run =>
          ['completed', 'failed', 'cancelled'].includes(run.status),
        )
      )
    },
    60000,
    `task ${taskId} did not settle after recovery`,
  )
  return runs
}

async function waitForEventStatus(dedupeKey, status) {
  await waitUntil(
    async () => {
      const body = await getJson(`/v1/events?userId=${userId}`)
      const event = (body.events ?? []).find(
        candidate => candidate.dedupeKey === dedupeKey,
      )
      return event?.status === status
    },
    15000,
    `event ${dedupeKey} did not reach ${status}`,
  )
}

function markerExists(name) {
  return existsSync(join(markerDirectory, name))
}

function resumeMarkerExists(taskId) {
  return readdirSync(markerDirectory).some(
    name =>
      name.startsWith('resume-') &&
      readFileSync(join(markerDirectory, name), 'utf8').trim() === taskId,
  )
}

function effectCount(taskId) {
  const effectPath = join(effectsDirectory, taskId)
  if (!existsSync(effectPath)) return 0
  return readFileSync(effectPath, 'utf8')
    .split('\n')
    .filter(line => line === 'effect').length
}

async function waitUntil(probe, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return
    await wait(50)
  }
  throw new Error(message)
}

function wait(ms) {
  return new Promise(resolveWait => setTimeout(resolveWait, ms))
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve()
  return new Promise(resolveExit => child.once('exit', resolveExit))
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  await new Promise(resolveClose => server.close(resolveClose))
  if (!address || typeof address === 'string')
    throw new Error('no TCP port available')
  return address.port
}

function fakeDshSource() {
  return `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const effectsDirectory = process.env.CRASH_EFFECTS_DIR
const markerDirectory = process.env.CRASH_MARKER_DIR
const debugLog = process.env.CRASH_DEBUG_LOG
const taskId = process.env.PEGAS_TASK_ID
const arguments_ = process.argv.slice(2)
const sessionIndex = arguments_.indexOf('--session-id')
const resumeSessionId = sessionIndex >= 0 ? arguments_[sessionIndex + 1] : undefined
let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
// The adapter closes stdin immediately; give it a moment to drain the
// session event before this test double hard-crashes the worker.
await new Promise(resolveSleep => setTimeout(resolveSleep, 400))
appendFileSync(debugLog, JSON.stringify({ taskId, resumeSessionId }) + '\\n')

function crash(marker) {
  writeFileSync(join(markerDirectory, marker), taskId ?? 'unknown')
  // Hard-kill the worker and then this child, leaving the durable lease to
  // expire exactly like a real machine crash.
  try {
    process.kill(process.ppid, 'SIGKILL')
  } catch (error) {
    appendFileSync(debugLog, 'parent-kill-failed: ' + String(error) + '\\n')
  }
  process.kill(process.pid, 'SIGKILL')
}

if (!taskId) throw new Error('missing PEGAS_TASK_ID capability')

if (resumeSessionId) {
  writeFileSync(join(markerDirectory, 'resume-' + resumeSessionId), taskId)
  console.log(JSON.stringify({
    type: 'final',
    sessionId: resumeSessionId,
    text: 'resumed-after-crash:' + taskId,
    reason: { kind: 'completed' },
  }))
  process.exit(0)
}

const sessionId = 'session-' + taskId
console.log(JSON.stringify({ type: 'session', sessionId }))

const crashPoint = /\\[crash:([a-z-]+)\\]/.exec(input)?.[1]
// Crash markers are per scenario, so each crash triggers exactly once even
// if a retried execution reaches the same crash point again.
if (
  crashPoint === 'event-claim' &&
  !existsSync(join(markerDirectory, 'event-claim'))
)
  crash('event-claim')

// The single external side effect. A wrong recovery implementation would
// append a second line and fail the harness effect-count assertion.
appendFileSync(join(effectsDirectory, taskId), 'effect\\n')

if (
  crashPoint === 'tool-call' &&
  !existsSync(join(markerDirectory, 'tool-' + taskId))
)
  crash('tool-' + taskId)

if (
  crashPoint === 'result-write-back' &&
  !existsSync(join(markerDirectory, 'write-' + taskId))
)
  crash('write-' + taskId)

console.log(JSON.stringify({
  type: 'final',
  sessionId,
  text: 'done:' + taskId,
  reason: { kind: 'completed' },
}))
`
}
