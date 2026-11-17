import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'

import type { ReleaseStateStore } from './release-state.js'

export interface RecoveryServerOptions {
  state: ReleaseStateStore
  token?: string
  onRollback(reason: string): Promise<void>
  onRestart(): Promise<void>
}

export function createRecoveryServer(options: RecoveryServerOptions): Server {
  return createServer((request, response) => {
    if (request.url === '/healthz' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ status: 'ok' }))
    }

    if (!isAuthorized(request, options.token)) {
      response.writeHead(401, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ error: 'unauthorized' }))
    }

    if (request.url === '/v1/recovery/status' && request.method === 'GET') {
      const inspection = options.state.inspect()
      response.writeHead(inspection.state ? 200 : 503, {
        'content-type': 'application/json',
      })
      return response.end(
        JSON.stringify({
          ...(inspection.state ?? {}),
          recoveryState: {
            integrity: inspection.integrity,
            source: inspection.source,
            diagnostics: inspection.diagnostics,
          },
        }),
      )
    }

    if (request.url === '/v1/recovery/restart' && request.method === 'POST') {
      response.writeHead(202, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'restarting' }))
      void options.onRestart().catch((error: unknown) => {
        console.error('Recovery restart failed', error)
      })
      return
    }

    if (request.url === '/v1/recovery/rollback' && request.method === 'POST') {
      response.writeHead(202, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'rolling_back' }))
      void options
        .onRollback('Manual rollback requested through the recovery API')
        .catch((error: unknown) => {
          console.error('Recovery rollback failed', error)
        })
      return
    }

    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not_found' }))
  })
}

function isAuthorized(
  request: IncomingMessage,
  expectedToken?: string,
): boolean {
  if (!expectedToken) return true
  const actual = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!actual) return false
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expectedToken)
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  )
}
