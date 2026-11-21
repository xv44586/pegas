import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'

import type { ReleaseStateStore } from './release-state.js'
import {
  RollbackCompatibilityError,
  RollbackUnavailableError,
} from './rollback-compatibility.js'

export interface RecoveryServerOptions {
  state: ReleaseStateStore
  token?: string
  onRollback(reason: string): Promise<void>
  onRestart(): Promise<void>
}

export function createRecoveryServer(options: RecoveryServerOptions): Server {
  let rollbackInFlight = false
  return createServer(async (request, response) => {
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
      if (rollbackInFlight) {
        response.writeHead(409, { 'content-type': 'application/json' })
        return response.end(
          JSON.stringify({
            error: 'rollback_in_progress',
            message: 'A rollback is already in progress',
          }),
        )
      }
      rollbackInFlight = true
      try {
        await options.onRollback(
          'Manual rollback requested through the recovery API',
        )
      } catch (error) {
        const unavailable = error instanceof RollbackUnavailableError
        const incompatible = error instanceof RollbackCompatibilityError
        response.writeHead(unavailable || incompatible ? 409 : 503, {
          'content-type': 'application/json',
        })
        return response.end(
          JSON.stringify({
            error: unavailable
              ? 'rollback_unavailable'
              : incompatible
                ? 'rollback_incompatible'
                : 'rollback_check_failed',
            message:
              unavailable || incompatible
                ? error.message
                : 'Rollback compatibility check failed',
          }),
        )
      } finally {
        rollbackInFlight = false
      }
      response.writeHead(202, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'rolling_back' }))
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
