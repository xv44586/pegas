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
  onStage?(input: {
    manifestPath: string
    artifactPath: string
    reviewReportPath: string
    migrationApproval?: { actionId: string; approvalId: string }
  }): Promise<void>
}

export class MigrationApprovalRequiredError extends Error {
  readonly versions: number[]

  constructor(versions: number[]) {
    super(
      `Destructive migrations require a dedicated approval: ${versions.join(', ')}`,
    )
    this.versions = versions
  }
}

export function createRecoveryServer(options: RecoveryServerOptions): Server {
  let rollbackInFlight = false
  let stageInFlight = false
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
        process.stdout.write(
          `${JSON.stringify({ ts: new Date().toISOString(), level: 'error', service: 'supervisor', event: 'recovery.restart_failed', error: { message: error instanceof Error ? error.message : String(error) } })}\n`,
        )
      })
      return
    }

    if (
      request.url === '/v1/recovery/candidates' &&
      request.method === 'POST'
    ) {
      if (!options.onStage) {
        response.writeHead(409, { 'content-type': 'application/json' })
        return response.end(
          JSON.stringify({
            error: 'staging_unavailable',
            message: 'This supervisor does not accept candidate staging',
          }),
        )
      }
      if (stageInFlight || rollbackInFlight) {
        response.writeHead(409, { 'content-type': 'application/json' })
        return response.end(
          JSON.stringify({
            error: 'transition_in_progress',
            message: 'Another lifecycle transition is already in progress',
          }),
        )
      }
      let body: unknown
      try {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk as string)
          size += buffer.length
          if (size > 64 * 1024) throw new Error('Request body is too large')
          chunks.push(buffer)
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        return response.end(JSON.stringify({ error: 'invalid_body' }))
      }
      const input = stageInput(body)
      if (!input) {
        response.writeHead(400, { 'content-type': 'application/json' })
        return response.end(
          JSON.stringify({
            error: 'invalid_candidate_request',
            message:
              'manifestPath, artifactPath and reviewReportPath are required absolute paths',
          }),
        )
      }
      stageInFlight = true
      try {
        await options.onStage(input)
      } catch (error) {
        if (error instanceof MigrationApprovalRequiredError) {
          response.writeHead(409, { 'content-type': 'application/json' })
          return response.end(
            JSON.stringify({
              error: 'migration_approval_required',
              versions: error.versions,
              message: error.message,
            }),
          )
        }
        response.writeHead(409, { 'content-type': 'application/json' })
        return response.end(
          JSON.stringify({
            error: 'candidate_rejected',
            message: error instanceof Error ? error.message : 'Staging failed',
          }),
        )
      } finally {
        stageInFlight = false
      }
      response.writeHead(202, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'verifying' }))
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

function stageInput(value: unknown):
  | {
      manifestPath: string
      artifactPath: string
      reviewReportPath: string
      migrationApproval?: { actionId: string; approvalId: string }
    }
  | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const record = value as Record<string, unknown>
  const paths = [
    record.manifestPath,
    record.artifactPath,
    record.reviewReportPath,
  ]
  if (
    paths.some(
      path => typeof path !== 'string' || !path.startsWith('/') || !path.trim(),
    )
  )
    return undefined
  let migrationApproval: { actionId: string; approvalId: string } | undefined
  if (record.migrationApproval !== undefined) {
    const grant = record.migrationApproval
    if (
      !grant ||
      typeof grant !== 'object' ||
      Array.isArray(grant) ||
      typeof (grant as Record<string, unknown>).actionId !== 'string' ||
      typeof (grant as Record<string, unknown>).approvalId !== 'string' ||
      !(grant as Record<string, unknown>).actionId ||
      !(grant as Record<string, unknown>).approvalId
    )
      return undefined
    migrationApproval = {
      actionId: (grant as Record<string, unknown>).actionId as string,
      approvalId: (grant as Record<string, unknown>).approvalId as string,
    }
  }
  return {
    manifestPath: record.manifestPath as string,
    artifactPath: record.artifactPath as string,
    reviewReportPath: record.reviewReportPath as string,
    ...(migrationApproval ? { migrationApproval } : {}),
  }
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
