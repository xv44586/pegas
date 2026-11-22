import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { TextDecoder as NodeTextDecoder } from 'node:util'

export interface LinkPreviewImage {
  dataUrl: string
  width: number
  height: number
}

export type LinkPreview =
  | { status: 'unavailable' }
  | {
      status: 'ready'
      title: string | null
      description: string | null
      image: LinkPreviewImage | null
    }

export type PreviewFetch = (url: string, init: RequestInit) => Promise<Response>

export type HostResolver = (hostname: string) => Promise<{ address: string }[]>

export interface LinkPreviewOptions {
  fetchImpl?: PreviewFetch
  resolveHost?: HostResolver
  allowPrivateTargets?: boolean
  timeoutMs?: number
  now?: () => number
}

const maximumUrlLength = 8_192
const maximumHtmlBytes = 1_048_576
const maximumImageBytes = 2_097_152
const maximumRedirects = 3
const maximumConcurrency = 4
const maximumQueueLength = 8
const maximumCacheEntries = 32
const maximumCacheBytes = 24 * 1_024 * 1_024
const readyWithImageTtlMs = 600_000
const otherTtlMs = 30_000
const defaultTimeoutMs = 8_000
const maximumTitleLength = 300
const maximumDescriptionLength = 1_000
const maximumImageSide = 8_192
const maximumImagePixels = 16_000_000

const unavailable: LinkPreview = { status: 'unavailable' }

export function normalizePreviewUrl(raw: string, base?: string): URL | null {
  if (raw.length > maximumUrlLength) return null
  let url: URL
  try {
    url = new URL(raw, base)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password || url.port) return null
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) return null
  } else if (
    !hostname.includes('.') ||
    /\.(?:localhost|local|internal|test)\.?$/i.test(hostname)
  ) {
    return null
  }
  url.hash = ''
  return url
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    const parts = address.split('.').map(Number)
    const [first = 0, second = 0, third = 0] = parts
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part)))
      return false
    if (first === 0 || first === 10 || first === 127) return false
    if (first === 100 && second >= 64 && second <= 127) return false
    if (first === 169 && second === 254) return false
    if (first === 172 && second >= 16 && second <= 31) return false
    if (first === 192 && second === 168) return false
    if (first === 192 && second === 0) return false
    if (first === 198 && (second === 18 || second === 19)) return false
    if (first === 198 && second === 51 && third === 100) return false
    if (first === 203 && second === 0 && third === 113) return false
    if (first >= 224) return false
    return true
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    if (normalized === '::' || normalized === '::1') return false
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)
    if (mapped?.[1]) return isPublicAddress(mapped[1])
    const firstGroup = Number.parseInt(normalized.split(':')[0] ?? '0', 16)
    if ((firstGroup & 0xfe00) === 0xfc00) return false
    if ((firstGroup & 0xffc0) === 0xfe80) return false
    if ((firstGroup & 0xff00) === 0xff00) return false
    if (normalized.startsWith('2001:db8')) return false
    return true
  }
  return false
}

interface ImageSize {
  width: number
  height: number
}

function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24) return null
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!signature.every((value, index) => bytes[index] === value)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function gifSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 10) return null
  const header = String.fromCharCode(...bytes.slice(0, 6))
  if (header !== 'GIF87a' && header !== 'GIF89a') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
}

function jpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1] ?? 0
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2
      continue
    }
    const length = (bytes[offset + 2] ?? 0) * 256 + (bytes[offset + 3] ?? 0)
    if (length < 2) return null
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      return {
        height: (bytes[offset + 5] ?? 0) * 256 + (bytes[offset + 6] ?? 0),
        width: (bytes[offset + 7] ?? 0) * 256 + (bytes[offset + 8] ?? 0),
      }
    }
    offset += 2 + length
  }
  return null
}

function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null
  const tag = (start: number, end: number): string =>
    String.fromCharCode(...bytes.slice(start, end))
  if (tag(0, 4) !== 'RIFF' || tag(8, 12) !== 'WEBP') return null
  const chunk = tag(12, 16)
  if (chunk === 'VP8X') {
    const width =
      1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16)
    const height =
      1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16)
    return { width, height }
  }
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
      return null
    return {
      width: ((bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8)) & 0x3fff,
      height: ((bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8)) & 0x3fff,
    }
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null
    const bits =
      (bytes[21] ?? 0) |
      ((bytes[22] ?? 0) << 8) |
      ((bytes[23] ?? 0) << 16) |
      ((bytes[24] ?? 0) << 24)
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    }
  }
  return null
}

export function sniffImage(
  bytes: Uint8Array,
  mimeType: string,
): ImageSize | null {
  const size =
    mimeType === 'image/png'
      ? pngSize(bytes)
      : mimeType === 'image/jpeg'
        ? jpegSize(bytes)
        : mimeType === 'image/webp'
          ? webpSize(bytes)
          : mimeType === 'image/gif'
            ? gifSize(bytes)
            : null
  if (!size) return null
  if (
    size.width <= 0 ||
    size.height <= 0 ||
    size.width > maximumImageSide ||
    size.height > maximumImageSide ||
    size.width * size.height > maximumImagePixels
  )
    return null
  return size
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      safeCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      safeCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function safeCodePoint(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

export function parseHeadMetadata(html: string): {
  meta: Map<string, string>
  title: string | null
} {
  const meta = new Map<string, string>()
  const metaPattern = /<meta\s[^>]*>/gi
  for (const match of html.matchAll(metaPattern)) {
    const tag = match[0]
    const key =
      /\b(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag)
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(
      tag,
    )
    const name = (key?.[1] ?? key?.[2] ?? key?.[3] ?? '').toLowerCase().trim()
    const value = decodeEntities(
      content?.[1] ?? content?.[2] ?? content?.[3] ?? '',
    ).trim()
    if (name && value && !meta.has(name)) meta.set(name, value)
  }
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch?.[1]
    ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim()
    : ''
  return { meta, title: title || null }
}

function cleanText(
  value: string | null | undefined,
  limit: number,
): string | null {
  const cleaned = value?.replace(/\s+/g, ' ').trim().slice(0, limit) ?? ''
  return cleaned === '' ? null : cleaned
}

function bodyReader(
  response: Response,
): ReadableStreamDefaultReader<Uint8Array> | undefined {
  return response.body?.getReader() as
    ReadableStreamDefaultReader<Uint8Array> | undefined
}

async function readBodyLimited(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const reader = bodyReader(response)
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error('preview response too large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

async function readHtmlHead(
  response: Response,
  limit: number,
  decoder: NodeTextDecoder,
): Promise<string> {
  const reader = bodyReader(response)
  if (!reader) return ''
  const parts: string[] = []
  let carry = ''
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      const decoded = decoder.decode(value, { stream: true })
      const scanned = carry + decoded
      const closing = /<\/head\s*>/i.exec(scanned)
      if (closing) {
        parts.push(scanned.slice(0, closing.index + closing[0].length))
        return parts.join('')
      }
      if (total > limit) throw new Error('preview response too large')
      const nextCarry = decoded.slice(-8)
      parts.push(decoded.slice(0, decoded.length - nextCarry.length))
      carry = nextCarry
    }
    parts.push(carry)
    return parts.join('')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

interface CacheEntry {
  value: LinkPreview
  bytes: number
  expiresAt: number
}

export class LinkPreviewService {
  readonly #fetch: PreviewFetch
  readonly #resolveHost: HostResolver
  readonly #allowPrivateTargets: boolean
  readonly #timeoutMs: number
  readonly #now: () => number
  readonly #cache = new Map<string, CacheEntry>()
  readonly #inFlight = new Map<string, Promise<LinkPreview>>()
  readonly #controllers = new Set<AbortController>()
  readonly #queue: ((allowed: boolean) => void)[] = []
  #active = 0
  #cacheBytes = 0
  #disposed = false

  constructor(options: LinkPreviewOptions = {}) {
    this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.#resolveHost =
      options.resolveHost ?? (hostname => dnsLookup(hostname, { all: true }))
    this.#allowPrivateTargets = options.allowPrivateTargets ?? false
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs
    this.#now = options.now ?? Date.now
  }

  async get(rawUrl: string): Promise<LinkPreview> {
    const url = typeof rawUrl === 'string' ? normalizePreviewUrl(rawUrl) : null
    if (this.#disposed || !url) return unavailable
    const key = url.href
    const cached = this.#cache.get(key)
    if (cached) {
      this.#cache.delete(key)
      this.#cacheBytes -= cached.bytes
      if (cached.expiresAt > this.#now()) {
        this.#cache.set(key, cached)
        this.#cacheBytes += cached.bytes
        return cached.value
      }
    }
    const pending = this.#inFlight.get(key)
    if (pending) return pending
    if (
      this.#active >= maximumConcurrency &&
      this.#queue.length >= maximumQueueLength
    )
      return unavailable
    const task = this.#runQueued(url)
      .catch(() => unavailable)
      .then(value => {
        if (!this.#disposed) this.#store(key, value)
        return value
      })
      .finally(() => {
        this.#inFlight.delete(key)
      })
    this.#inFlight.set(key, task)
    return task
  }

  dispose(): void {
    this.#disposed = true
    for (const controller of this.#controllers) controller.abort()
    this.#controllers.clear()
    for (const resume of this.#queue.splice(0)) resume(false)
    this.#cache.clear()
    this.#cacheBytes = 0
  }

  #store(key: string, value: LinkPreview): void {
    const ttl =
      value.status === 'ready' && value.image ? readyWithImageTtlMs : otherTtlMs
    const bytes = 2 * JSON.stringify(value).length
    this.#cache.set(key, { value, bytes, expiresAt: this.#now() + ttl })
    this.#cacheBytes += bytes
    while (
      this.#cache.size > maximumCacheEntries ||
      this.#cacheBytes > maximumCacheBytes
    ) {
      const oldest = this.#cache.entries().next().value
      if (!oldest) break
      this.#cache.delete(oldest[0])
      this.#cacheBytes -= oldest[1].bytes
    }
  }

  async #runQueued(url: URL): Promise<LinkPreview> {
    if (this.#active >= maximumConcurrency) {
      const allowed = await new Promise<boolean>(resolve => {
        this.#queue.push(resolve)
      })
      if (!allowed || this.#disposed) return unavailable
    } else {
      this.#active += 1
    }
    const controller = new AbortController()
    this.#controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      return await this.#load(url, controller.signal)
    } finally {
      clearTimeout(timer)
      controller.abort()
      this.#controllers.delete(controller)
      const next = this.#queue.shift()
      if (next) next(true)
      else this.#active -= 1
    }
  }

  async #assertPublicHost(hostname: string): Promise<void> {
    if (this.#allowPrivateTargets) return
    const host = hostname.replace(/^\[|\]$/g, '')
    if (isIP(host)) {
      if (!isPublicAddress(host))
        throw new Error('preview destination is not public')
      return
    }
    const addresses = await this.#resolveHost(host)
    if (
      addresses.length === 0 ||
      !addresses.every(entry => isPublicAddress(entry.address))
    )
      throw new Error('preview destination is not public')
  }

  async #request(
    url: URL,
    signal: AbortSignal,
  ): Promise<{ url: URL; response: Response }> {
    let current = url
    for (let hop = 0; hop <= maximumRedirects; hop += 1) {
      signal.throwIfAborted()
      await this.#assertPublicHost(current.hostname)
      signal.throwIfAborted()
      const response = await this.#fetch(current.href, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        referrerPolicy: 'no-referrer',
        headers: { accept: '*/*', 'user-agent': 'Pegas-LinkPreview/1.0' },
        signal,
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        const next = location
          ? normalizePreviewUrl(location, current.href)
          : null
        if (!next) break
        current = next
        continue
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        break
      }
      return { url: current, response }
    }
    throw new Error('preview response unavailable')
  }

  async #loadImage(
    url: URL,
    signal: AbortSignal,
  ): Promise<LinkPreviewImage | null> {
    const { response } = await this.#request(url, signal)
    const mimeType = response.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase()
    if (
      !mimeType ||
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)
    ) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    const bytes = await readBodyLimited(response, maximumImageBytes)
    const size = sniffImage(bytes, mimeType)
    if (!size) return null
    return {
      dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
      width: size.width,
      height: size.height,
    }
  }

  async #load(url: URL, signal: AbortSignal): Promise<LinkPreview> {
    const { url: finalUrl, response } = await this.#request(url, signal)
    const contentType = response.headers.get('content-type')
    const mimeType = contentType?.split(';')[0]?.trim().toLowerCase()
    if (mimeType !== 'text/html' && mimeType !== 'application/xhtml+xml') {
      await response.body?.cancel().catch(() => undefined)
      return unavailable
    }
    const charset = /\bcharset\s*=\s*["']?([^\s;"']+)/i.exec(
      contentType ?? '',
    )?.[1]
    let decoder: NodeTextDecoder
    try {
      decoder = new NodeTextDecoder(charset)
    } catch {
      decoder = new NodeTextDecoder()
    }
    const head = await readHtmlHead(response, maximumHtmlBytes, decoder)
    const { meta, title } = parseHeadMetadata(head)
    const previewTitle = cleanText(
      meta.get('og:title') ?? meta.get('twitter:title') ?? title,
      maximumTitleLength,
    )
    const description = cleanText(
      meta.get('og:description') ??
        meta.get('twitter:description') ??
        meta.get('description'),
      maximumDescriptionLength,
    )
    const imageCandidate =
      meta.get('og:image:secure_url') ??
      meta.get('og:image') ??
      meta.get('og:image:url') ??
      meta.get('twitter:image') ??
      meta.get('twitter:image:src')
    const imageUrl = imageCandidate
      ? normalizePreviewUrl(imageCandidate, finalUrl.href)
      : null
    const image = imageUrl
      ? await this.#loadImage(imageUrl, signal).catch(() => null)
      : null
    if (!previewTitle && !description && !image) return unavailable
    return {
      status: 'ready',
      title: previewTitle,
      description,
      image,
    }
  }
}
