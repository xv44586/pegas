import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { resolve } from 'node:path'

// Real-process smoke for the host-level external healthcheck watchdog:
// healthy -> outage (latched offline alert) -> recovery alert -> SIGTERM.
const alerts = []
const alertServer = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  alerts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  response.writeHead(204).end()
})
await new Promise(done => alertServer.listen(0, '127.0.0.1', done))
const probeState = { status: 200 }
const probeServer = createServer((_request, response) => {
  response.writeHead(probeState.status).end('ok')
})
await new Promise(done => probeServer.listen(0, '127.0.0.1', done))

const watchdog = spawn(
  process.execPath,
  [resolve('dist/observability/healthcheck-main.js')],
  {
    env: {
      ...process.env,
      PEGAS_HEALTHCHECK_TARGETS: `probe=http://127.0.0.1:${probeServer.address().port}/healthz`,
      PEGAS_HEALTHCHECK_INTERVAL_MS: '50',
      PEGAS_HEALTHCHECK_FAILURE_THRESHOLD: '2',
      PEGAS_HEALTHCHECK_ALERT_WEBHOOK_URL: `http://127.0.0.1:${alertServer.address().port}/alert`,
    },
    stdio: 'inherit',
  },
)
const wait = ms => new Promise(done => setTimeout(done, ms))

try {
  await wait(300)
  if (alerts.length !== 0) throw new Error('Unexpected alert while healthy')
  probeState.status = 503
  await wait(400)
  if (alerts.length !== 1 || alerts[0].status !== 'offline')
    throw new Error('Expected exactly one latched offline alert')
  probeState.status = 200
  await wait(400)
  if (alerts.length !== 2 || alerts[1].status !== 'recovered')
    throw new Error('Expected exactly one recovery alert')
} finally {
  watchdog.kill('SIGTERM')
  await new Promise(done => watchdog.once('exit', done))
  alertServer.close()
  probeServer.close()
}
console.log('External healthcheck smoke passed (offline + recovered alerts)')
