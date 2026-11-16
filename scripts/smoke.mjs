import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dataDirectory = mkdtempSync(join(tmpdir(), 'pegas-smoke-'))
const port = await availablePort()
const apiToken = `smoke-${process.pid}`
const environment = {
  ...process.env,
  PEGAS_API_HOST: '127.0.0.1',
  PEGAS_API_PORT: String(port),
  PEGAS_API_TOKEN: apiToken,
  PEGAS_DATA_DIR: dataDirectory,
  PEGAS_EVENT_POLL_MS: '25',
  PEGAS_EXECUTOR: 'echo',
}
const children = [
  spawn(process.execPath, [resolve('dist/control-plane/main.js')], {
    env: environment,
    stdio: 'inherit',
  }),
  spawn(process.execPath, [resolve('dist/worker/main.js')], {
    env: environment,
    stdio: 'inherit',
  }),
]

try {
  await waitUntilReady(port)
  const webResponse = await fetch(`http://127.0.0.1:${port}/`)
  const webDocument = await webResponse.text()
  if (!webResponse.ok || !webDocument.includes('<title>Pegas</title>'))
    throw new Error('Control plane did not serve the Pegas web client')
  const eventResponse = await fetch(`http://127.0.0.1:${port}/v1/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      userId: 'smoke-user',
      type: 'user.message',
      source: 'smoke',
      dedupeKey: 'smoke-message-1',
      payload: { text: 'Verify the durable task loop' },
    }),
  })
  if (eventResponse.status !== 202)
    throw new Error(`Unexpected event status ${eventResponse.status}`)

  const task = await waitForTask(port)
  if (task.title !== 'Verify the durable task loop')
    throw new Error('Task title did not round-trip')
  const run = await waitForCompletedRun(port, task.id)
  if (run.output !== 'Verify the durable task loop')
    throw new Error('Run output did not round-trip')
  const message = await waitForOutbox(port)
  if (message.payload?.type !== 'run.completed')
    throw new Error('Completion was not persisted to the outbox')
  console.log(`Smoke test passed with task ${task.id} and run ${run.id}`)
} finally {
  for (const child of children) child.kill('SIGTERM')
  await Promise.race([
    Promise.all(children.map(child => waitForExit(child))),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 3000)),
  ])
  rmSync(dataDirectory, { recursive: true, force: true })
}

async function waitUntilReady(apiPort) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/readyz`)
      if (response.ok) return
    } catch {
      // The process is still starting.
    }
    await wait(50)
  }
  throw new Error('Control plane did not become ready')
}

async function waitForTask(apiPort) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://127.0.0.1:${apiPort}/v1/tasks?userId=smoke-user`,
      {
        headers: { authorization: `Bearer ${apiToken}` },
      },
    )
    const body = await response.json()
    if (body.tasks?.[0]) return body.tasks[0]
    await wait(50)
  }
  throw new Error('Worker did not create a task')
}

async function waitForCompletedRun(apiPort, taskId) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://127.0.0.1:${apiPort}/v1/runs?taskId=${encodeURIComponent(taskId)}`,
      {
        headers: { authorization: `Bearer ${apiToken}` },
      },
    )
    const body = await response.json()
    const completed = body.runs?.find(run => run.status === 'completed')
    if (completed) return completed
    await wait(50)
  }
  throw new Error('Worker did not complete a run')
}

async function waitForOutbox(apiPort) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://127.0.0.1:${apiPort}/v1/outbox?userId=smoke-user`,
      {
        headers: { authorization: `Bearer ${apiToken}` },
      },
    )
    const body = await response.json()
    if (body.messages?.[0]) return body.messages[0]
    await wait(50)
  }
  throw new Error('Worker did not persist an outbox message')
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string')
        return reject(new Error('No TCP address'))
      server.close(() => resolvePort(address.port))
    })
  })
}

function wait(milliseconds) {
  return new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise(resolveExit => child.once('exit', resolveExit))
}
