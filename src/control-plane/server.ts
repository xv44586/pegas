import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { extname, resolve, sep } from 'node:path'

import type { NewInboxEvent } from '../core/domain.js'
import type { PegasStore } from '../storage/sqlite-store.js'

const maximumBodyBytes = 1024 * 1024

export interface ControlPlaneOptions {
  store: PegasStore
  apiToken?: string
  webRoot?: string
}

export function createControlPlane(options: ControlPlaneOptions): Server {
  return createServer(async (request, response) => {
    try {
      if (request.url === '/healthz' && request.method === 'GET') {
        return sendJson(response, 200, { status: 'ok' })
      }

      if (request.url === '/readyz' && request.method === 'GET') {
        return sendJson(response, options.store.ready() ? 200 : 503, {
          status: options.store.ready() ? 'ready' : 'not_ready',
        })
      }

      if (await tryServeWeb(request, response, options.webRoot)) return

      if (!isAuthorized(request, options.apiToken)) {
        return sendJson(response, 401, { error: 'unauthorized' })
      }

      if (request.url === '/v1/events' && request.method === 'POST') {
        const body = await readJson(request)
        const input = parseNewInboxEvent(body)
        const result = options.store.enqueueEvent(input)
        return sendJson(response, result.inserted ? 202 : 200, result)
      }

      if (request.url?.startsWith('/v1/events') && request.method === 'GET') {
        const url = new URL(request.url, 'http://localhost')
        const userId = url.searchParams.get('userId')
        if (!userId) throw new Error('userId is required')
        return sendJson(response, 200, {
          events: options.store.listEvents(userId),
        })
      }

      if (request.url?.startsWith('/v1/tasks') && request.method === 'GET') {
        const url = new URL(request.url, 'http://localhost')
        const userId = url.searchParams.get('userId') ?? undefined
        return sendJson(response, 200, {
          tasks: options.store.listTasks(userId),
        })
      }

      if (request.url?.startsWith('/v1/runs') && request.method === 'GET') {
        const url = new URL(request.url, 'http://localhost')
        const taskId = url.searchParams.get('taskId') ?? undefined
        return sendJson(response, 200, {
          runs: options.store.listRuns(taskId),
        })
      }

      if (request.url === '/v1/outbox' && request.method === 'POST') {
        const body = parseNewOutboxMessage(await readJson(request))
        const message = options.store.enqueueOutbox(body)
        return sendJson(response, 202, { message })
      }

      if (request.url?.startsWith('/v1/outbox') && request.method === 'GET') {
        const url = new URL(request.url, 'http://localhost')
        const userId = url.searchParams.get('userId')
        if (!userId) throw new Error('userId is required')
        return sendJson(response, 200, {
          messages: options.store.listOutbox(userId),
        })
      }

      return sendJson(response, 404, { error: 'not_found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return sendJson(response, 400, { error: 'bad_request', message })
    }
  })
}

function parseNewOutboxMessage(value: unknown): {
  userId: string
  taskId?: string
  channel: string
  dedupeKey: string
  payload: unknown
} {
  if (!isRecord(value)) throw new Error('Request body must be an object')
  if (!Object.hasOwn(value, 'payload')) throw new Error('payload is required')
  const taskId = optionalString(value.taskId, 'taskId')
  return {
    userId: requiredString(value.userId, 'userId'),
    ...(taskId ? { taskId } : {}),
    channel: optionalString(value.channel, 'channel') ?? 'conversation',
    dedupeKey: requiredString(value.dedupeKey, 'dedupeKey'),
    payload: value.payload,
  }
}

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

async function tryServeWeb(
  request: IncomingMessage,
  response: ServerResponse,
  webRoot?: string,
): Promise<boolean> {
  if (!webRoot || request.method !== 'GET' || !request.url) return false
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname.startsWith('/v1/')) return false

  const root = resolve(webRoot)
  const requested = resolve(root, `.${decodeURIComponent(url.pathname)}`)
  if (requested !== root && !requested.startsWith(`${root}${sep}`)) return false

  let file = requested
  if (url.pathname === '/' || !existsSync(file))
    file = resolve(root, 'index.html')
  if (!existsSync(file)) return false

  const body = await readFile(file)
  response.writeHead(200, {
    'cache-control':
      extname(file) === '.html'
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
    'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
  })
  response.end(body)
  return true
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > maximumBodyBytes) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) throw new Error('Request body is required')
  return JSON.parse(raw) as unknown
}

function parseNewInboxEvent(value: unknown): NewInboxEvent {
  if (!isRecord(value)) throw new Error('Request body must be an object')
  const userId = requiredString(value.userId, 'userId')
  const type = requiredString(value.type, 'type')
  const source = requiredString(value.source, 'source')
  const dedupeKey = optionalString(value.dedupeKey, 'dedupeKey')
  if (!Object.hasOwn(value, 'payload')) throw new Error('payload is required')
  return {
    userId,
    type,
    source,
    ...(dedupeKey ? { dedupeKey } : {}),
    payload: value.payload,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${field} is required`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, field)
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(body))
}
