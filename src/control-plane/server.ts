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
import {
  parseRuntimeSettingsUpdate,
  type SettingsCapabilities,
} from '../settings/runtime-settings.js'
import type {
  SpeechRecognitionProvider,
  SpeechTranscript,
} from '../speech/provider.js'
import {
  SettingsRevisionConflictError,
  type PegasStore,
} from '../storage/sqlite-store.js'

const maximumBodyBytes = 1024 * 1024
const defaultMaximumAudioBytes = 25 * 1024 * 1024

export interface ControlPlaneOptions {
  store: PegasStore
  apiToken?: string
  webRoot?: string
  speechProvider?: SpeechRecognitionProvider
  maximumAudioBytes?: number
  settingsCapabilities?: SettingsCapabilities
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

      if (
        request.url?.startsWith('/v1/voice/transcriptions') &&
        request.method === 'POST'
      ) {
        return await acceptVoiceTranscription(request, response, options)
      }

      if (
        request.url?.startsWith('/v1/voice/messages') &&
        request.method === 'POST'
      ) {
        return await acceptVoiceMessage(request, response, options)
      }

      if (request.url === '/v1/settings' && request.method === 'GET') {
        if (!options.settingsCapabilities) {
          return sendJson(response, 503, { error: 'settings_unavailable' })
        }
        return sendJson(response, 200, {
          settings: options.store.getRuntimeSettings(),
          capabilities: options.settingsCapabilities,
        })
      }

      if (request.url === '/v1/settings' && request.method === 'PUT') {
        if (!options.settingsCapabilities) {
          return sendJson(response, 503, { error: 'settings_unavailable' })
        }
        const update = parseRuntimeSettingsUpdate(
          await readJson(request),
          options.settingsCapabilities,
        )
        try {
          const settings = options.store.updateRuntimeSettings(
            update.expectedRevision,
            update.settings,
          )
          return sendJson(response, 200, {
            settings,
            capabilities: options.settingsCapabilities,
          })
        } catch (error) {
          if (error instanceof SettingsRevisionConflictError) {
            return sendJson(response, 409, {
              error: 'settings_conflict',
              message: error.message,
            })
          }
          throw error
        }
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

async function acceptVoiceTranscription(
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlPlaneOptions,
): Promise<void> {
  const transcript = await transcribeVoiceRequest(request, response, options)
  if (!transcript) return
  return sendJson(response, 200, {
    transcript,
    provider: options.speechProvider?.name,
    model: options.speechProvider?.model,
  })
}

async function acceptVoiceMessage(
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlPlaneOptions,
): Promise<void> {
  const url = new URL(request.url ?? '', 'http://localhost')
  const userId = requiredQuery(url, 'userId')
  const source = optionalQuery(url, 'source') ?? 'web'
  const language = optionalQuery(url, 'language')
  const taskId = optionalQuery(url, 'taskId')
  const dedupeKey = headerValue(request, 'idempotency-key')?.trim()
  if (!dedupeKey) {
    return sendJson(response, 400, {
      error: 'bad_request',
      message: 'Idempotency-Key header is required',
    })
  }

  const transcript = await transcribeVoiceRequest(request, response, options)
  if (!transcript) return

  const result = options.store.enqueueEvent({
    userId,
    type: 'user.message',
    source,
    dedupeKey,
    payload: {
      text: transcript.text,
      inputMode: 'voice',
      ...(taskId ? { taskId } : {}),
      voice: {
        provider: options.speechProvider?.name,
        model: options.speechProvider?.model,
        ...(language ? { requestedLanguage: language } : {}),
        ...(transcript.language
          ? { detectedLanguage: transcript.language }
          : {}),
      },
    },
  })

  return sendJson(response, result.inserted ? 202 : 200, {
    ...result,
    transcript,
  })
}

async function transcribeVoiceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlPlaneOptions,
): Promise<SpeechTranscript | undefined> {
  if (!options.speechProvider) {
    sendJson(response, 503, {
      error: 'speech_unavailable',
      message: 'Speech recognition is not configured',
    })
    return undefined
  }

  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim()
  if (!contentType?.startsWith('audio/')) {
    sendJson(response, 415, {
      error: 'unsupported_media_type',
      message: 'Content-Type must be an audio media type',
    })
    return undefined
  }

  const audio = await readBytes(
    request,
    options.maximumAudioBytes ?? defaultMaximumAudioBytes,
  )
  if (audio.length === 0) {
    sendJson(response, 400, {
      error: 'bad_request',
      message: 'Audio body is required',
    })
    return undefined
  }

  const url = new URL(request.url ?? '', 'http://localhost')
  const language = optionalQuery(url, 'language')
  try {
    return await options.speechProvider.transcribe({
      audio,
      contentType,
      filename: `utterance.${audioExtension(contentType)}`,
      ...(language ? { language } : {}),
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Speech recognition failed'
    sendJson(response, 502, {
      error: 'speech_provider_failed',
      message,
    })
    return undefined
  }
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
  const raw = (await readBytes(request, maximumBodyBytes)).toString('utf8')
  if (!raw) throw new Error('Request body is required')
  return JSON.parse(raw) as unknown
}

async function readBytes(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Buffer> {
  const declaredLength = Number(request.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error('Request body is too large')
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > maximumBytes) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function requiredQuery(url: URL, name: string): string {
  const value = optionalQuery(url, name)
  if (!value) throw new Error(`${name} is required`)
  return value
}

function optionalQuery(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim()
  return value === '' ? undefined : value
}

function audioExtension(contentType: string): string {
  const extensions: Record<string, string> = {
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'audio/x-m4a': 'm4a',
    'audio/x-wav': 'wav',
  }
  return extensions[contentType] ?? 'audio'
}

function headerValue(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
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
