import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { relative, resolve, sep } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const changedFrom = option('--changed-from')
const force = args.includes('--force')
if (!force && !changedFrom)
  throw new Error('--changed-from is required unless --force is used')
const externalServicePattern =
  /^(?:src\/(?:model|speech|notification)|services)\//u
if (
  !force &&
  !changedFiles(changedFrom).some(path => externalServicePattern.test(path))
) {
  console.log('Dependency canary skipped: no external-service files changed')
  process.exit(0)
}

const outputDirectory = resolve(
  repositoryRoot,
  option('--output') ?? 'output/feature-review/media',
)
const outputRelative = relative(repositoryRoot, outputDirectory)
if (
  outputRelative === '' ||
  outputRelative.startsWith('..') ||
  !outputRelative.split(sep).join('/').startsWith('output/feature-review/')
) {
  throw new Error(
    'Dependency canary output must stay under output/feature-review/',
  )
}
mkdirSync(outputDirectory, { recursive: true })

const dataDirectory = mkdtempSync(resolve(tmpdir(), 'pegas-canary-'))
const port = await availablePort()
const recoveryPort = await availablePort()
const deliveries = []
const webhookServer = createHttpServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  deliveries.push({
    idempotencyKey: request.headers['idempotency-key'],
    body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
  })
  response.writeHead(204).end()
})
await new Promise((resolveListen, rejectListen) => {
  webhookServer.once('error', rejectListen)
  webhookServer.listen(0, '127.0.0.1', resolveListen)
})
const webhookAddress = webhookServer.address()
if (!webhookAddress || typeof webhookAddress === 'string')
  throw new Error('Webhook receiver has no TCP address')
const environment = {
  ...process.env,
  PEGAS_API_HOST: '127.0.0.1',
  PEGAS_API_PORT: String(port),
  PEGAS_DATA_DIR: dataDirectory,
  PEGAS_EXECUTOR: 'echo',
  PEGAS_ROUTER: 'rules',
  PEGAS_SPEECH_PROVIDER: 'disabled',
  PEGAS_EVENT_POLL_MS: '25',
  PEGAS_RECOVERY_BASE_URL: `http://127.0.0.1:${String(recoveryPort)}`,
  PEGAS_PUSH_MODE: 'webhook',
  PEGAS_PUSH_WEBHOOK_URL: `http://127.0.0.1:${String(webhookAddress.port)}/push`,
  PEGAS_OUTBOX_POLL_MS: '25',
}
const children = [
  spawn(
    process.execPath,
    [resolve(repositoryRoot, 'dist/control-plane/main.js')],
    { cwd: repositoryRoot, env: environment, stdio: 'inherit' },
  ),
  spawn(process.execPath, [resolve(repositoryRoot, 'dist/worker/main.js')], {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
  }),
  spawn(
    process.execPath,
    [resolve(repositoryRoot, 'dist/notification/main.js')],
    { cwd: repositoryRoot, env: environment, stdio: 'inherit' },
  ),
]

try {
  await waitUntilReady(port)
  const enqueueResponse = await fetch(
    `http://127.0.0.1:${String(port)}/v1/outbox`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 'canary-user',
        channel: 'conversation',
        dedupeKey: 'dependency-canary-approval',
        payload: {
          type: 'approval.required',
          approvalId: 'dependency-canary-approval',
          summary: '发布前需要确认影响范围',
          prompt: 'canary-secret-prompt-body',
        },
      }),
    },
  )
  if (enqueueResponse.status !== 202)
    throw new Error(
      `Unable to enqueue canary approval (${String(enqueueResponse.status)})`,
    )
  const { message } = await enqueueResponse.json()
  const delivery = await waitForDelivery(message)
  const persisted = await waitForSentMessage(port, message.id)
  const payload = delivery.body.payload
  const expectedDeepLink = `/?view=outbox&outbox=${encodeURIComponent(message.id)}`
  const payloadText = JSON.stringify(delivery.body)
  const assertions = [
    {
      name: 'delivery-idempotency-key-matches-dedupe-key',
      passed: delivery.idempotencyKey === message.dedupeKey,
    },
    {
      name: 'delivery-id-matches-outbox-message-id',
      passed: delivery.body.id === message.id,
    },
    {
      name: 'approval-deep-link-points-at-outbox-message',
      passed: payload?.deepLink === expectedDeepLink,
    },
    {
      name: 'approval-prompt-withheld-from-external-channel',
      passed:
        !Object.hasOwn(payload ?? {}, 'prompt') &&
        !payloadText.includes('canary-secret-prompt-body'),
    },
    {
      name: 'outbox-message-marked-sent',
      passed: persisted.status === 'sent',
    },
    {
      name: 'in-app-payload-keeps-full-prompt',
      passed: persisted.payload?.prompt === 'canary-secret-prompt-body',
    },
  ]
  const failed = assertions.filter(assertion => !assertion.passed)
  const canary = {
    schemaVersion: 1,
    kind: 'notification-real-service-canary',
    transport: 'loopback-webhook',
    redaction: 'names-and-assertions-only',
    headCommit: headCommit(),
    generatedAt: new Date().toISOString(),
    deliveredPayloadFieldNames: Object.keys(payload ?? {}).sort(),
    assertions,
    status: failed.length === 0 ? 'passed' : 'failed',
  }
  const outputPath = resolve(
    outputDirectory,
    'notification-real-service-canary.json',
  )
  writeFileSync(outputPath, `${JSON.stringify(canary, null, 2)}\n`, {
    mode: 0o600,
  })
  if (failed.length > 0)
    throw new Error(
      `Notification canary failed: ${failed.map(assertion => assertion.name).join(', ')}`,
    )
  console.log(
    `Notification real-service canary passed in ${relative(repositoryRoot, outputPath)}`,
  )
} finally {
  for (const child of children) child.kill('SIGTERM')
  await Promise.race([
    Promise.all(children.map(child => waitForExit(child))),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 3000)),
  ])
  await new Promise(resolveClose => webhookServer.close(resolveClose))
  rmSync(dataDirectory, { recursive: true, force: true })
}

async function waitForDelivery(message) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const delivery = deliveries.find(
      item => item.idempotencyKey === message.dedupeKey,
    )
    if (delivery) return delivery
    await wait(50)
  }
  throw new Error(
    'Dispatcher did not deliver the canary approval to the webhook',
  )
}

async function waitForSentMessage(apiPort, messageId) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://127.0.0.1:${String(apiPort)}/v1/outbox?userId=canary-user`,
    )
    const body = await response.json()
    const persisted = body.messages?.find(item => item.id === messageId)
    if (persisted?.status === 'sent') return persisted
    await wait(50)
  }
  throw new Error('Canary approval was not marked sent in the outbox')
}

function changedFiles(base) {
  return execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMRT', `${base}...HEAD`],
    { cwd: repositoryRoot, encoding: 'utf8' },
  )
    .split(/\r?\n/u)
    .map(path => path.trim())
    .filter(Boolean)
}

function headCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim()
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

async function waitUntilReady(apiPort) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(apiPort)}/readyz`)
      if (response.ok) return
    } catch {
      // Control Plane is still starting.
    }
    await wait(50)
  }
  throw new Error(
    'Control plane did not become ready for the dependency canary',
  )
}

function wait(milliseconds) {
  return new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise(resolveExit => child.once('exit', resolveExit))
}
