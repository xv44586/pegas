import { describe, expect, it, vi } from 'vitest'

import {
  LinkPreviewService,
  isPublicAddress,
  normalizePreviewUrl,
  parseHeadMetadata,
  sniffImage,
} from '../src/link-preview/link-preview.js'

const publicResolver = () => Promise.resolve([{ address: '93.184.216.34' }])

function pngBytes(width = 4, height = 2): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function htmlResponse(html: string, contentType = 'text/html; charset=utf-8') {
  return new Response(html, { headers: { 'content-type': contentType } })
}

function imageResponse(bytes: Uint8Array, contentType = 'image/png') {
  return new Response(Buffer.from(bytes), {
    headers: { 'content-type': contentType },
  })
}

const pageHtml = `<!doctype html><html><head>
<title>Fallback title</title>
<meta property="og:title" content="Example &amp; friends">
<meta property="og:description" content="A tidy   description.">
<meta property="og:image" content="/cover.png">
</head><body>ignored</body></html>`

function makeService(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  overrides: Partial<ConstructorParameters<typeof LinkPreviewService>[0]> = {},
) {
  return new LinkPreviewService({
    fetchImpl,
    resolveHost: publicResolver,
    ...overrides,
  })
}

describe('CONV-005 link preview url policy', () => {
  it('accepts public https urls and strips the fragment', () => {
    const url = normalizePreviewUrl('https://example.com/a?b=1#frag')
    expect(url?.href).toBe('https://example.com/a?b=1')
  })

  it('rejects non-https, credentialed, portful and local targets', () => {
    for (const target of [
      'http://example.com/',
      'ftp://example.com/',
      'https://user:pass@example.com/',
      'https://example.com:8443/',
      'https://localhost/',
      'https://printer.local/',
      'https://svc.internal/',
      'https://node.test/',
      'https://intranet/',
      'https://127.0.0.1/',
      'https://10.0.0.8/',
      'https://192.168.1.1/',
      'https://[::1]/',
      'not a url',
    ]) {
      expect(normalizePreviewUrl(target), target).toBeNull()
    }
  })

  it('classifies private and public addresses', () => {
    for (const address of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fc00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false)
    }
    for (const address of [
      '93.184.216.34',
      '8.8.8.8',
      '172.32.0.1',
      '2606:4700::1111',
      '::ffff:8.8.8.8',
    ]) {
      expect(isPublicAddress(address), address).toBe(true)
    }
  })
})

describe('CONV-005 head metadata parsing', () => {
  it('collects og/twitter meta with entity decoding and dedupe', () => {
    const { meta, title } = parseHeadMetadata(pageHtml)
    expect(meta.get('og:title')).toBe('Example & friends')
    expect(meta.get('og:image')).toBe('/cover.png')
    expect(title).toBe('Fallback title')
  })

  it('supports single-quoted and name-based tags', () => {
    const { meta } = parseHeadMetadata(
      `<meta name='twitter:image' content='https://cdn.example.com/i.png'>`,
    )
    expect(meta.get('twitter:image')).toBe('https://cdn.example.com/i.png')
  })
})

describe('CONV-005 image sniffing', () => {
  it('validates png signature and dimensions', () => {
    expect(sniffImage(pngBytes(4, 2), 'image/png')).toEqual({
      width: 4,
      height: 2,
    })
    expect(sniffImage(pngBytes(4, 2), 'image/jpeg')).toBeNull()
    expect(sniffImage(pngBytes(9000, 2), 'image/png')).toBeNull()
    expect(sniffImage(new Uint8Array(4), 'image/png')).toBeNull()
  })

  it('rejects unsupported mime types', () => {
    expect(sniffImage(pngBytes(), 'image/svg+xml')).toBeNull()
  })
})

describe('CONV-005 LinkPreviewService', () => {
  it('fetches OG metadata and inlines the image as a data url', async () => {
    const calls: string[] = []
    const service = makeService(url => {
      calls.push(url)
      return Promise.resolve(
        url.endsWith('/cover.png')
          ? imageResponse(pngBytes(4, 2))
          : htmlResponse(pageHtml),
      )
    })
    const preview = await service.get('https://example.com/post#section')
    expect(preview).toEqual({
      status: 'ready',
      title: 'Example & friends',
      description: 'A tidy description.',
      image: {
        dataUrl: `data:image/png;base64,${Buffer.from(pngBytes(4, 2)).toString('base64')}`,
        width: 4,
        height: 2,
      },
    })
    expect(calls).toEqual([
      'https://example.com/post',
      'https://example.com/cover.png',
    ])
    service.dispose()
  })

  it('falls back to twitter meta and <title> without an image', async () => {
    const service = makeService(() =>
      Promise.resolve(
        htmlResponse(
          `<head><title>  Plain   page </title><meta name="description" content="desc"></head>`,
        ),
      ),
    )
    expect(await service.get('https://example.com/')).toEqual({
      status: 'ready',
      title: 'Plain page',
      description: 'desc',
      image: null,
    })
    service.dispose()
  })

  it('returns unavailable for non-html responses', async () => {
    const service = makeService(() =>
      Promise.resolve(
        new Response('{}', {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    expect(await service.get('https://example.com/api')).toEqual({
      status: 'unavailable',
    })
    service.dispose()
  })

  it('returns unavailable when nothing usable is found', async () => {
    const service = makeService(() =>
      Promise.resolve(htmlResponse('<head></head>')),
    )
    expect(await service.get('https://example.com/empty')).toEqual({
      status: 'unavailable',
    })
    service.dispose()
  })

  it('keeps text preview when the image fails validation', async () => {
    const service = makeService(url =>
      Promise.resolve(
        url.endsWith('.png')
          ? imageResponse(new Uint8Array([1, 2, 3]))
          : htmlResponse(
              `<head><meta property="og:title" content="T"><meta property="og:image" content="https://example.com/x.png"></head>`,
            ),
      ),
    )
    const preview = await service.get('https://example.com/bad-image')
    expect(preview).toEqual({
      status: 'ready',
      title: 'T',
      description: null,
      image: null,
    })
    service.dispose()
  })

  it('follows manual redirects but refuses private destinations', async () => {
    const service = makeService(url => {
      if (url === 'https://example.com/start') {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://example.com/final' },
          }),
        )
      }
      return Promise.resolve(htmlResponse(pageHtml.replace('/cover.png', '')))
    })
    const preview = await service.get('https://example.com/start')
    expect(preview.status).toBe('ready')
    service.dispose()

    const evil = makeService(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'https://127.0.0.1/admin' },
        }),
      ),
    )
    expect(await evil.get('https://example.com/redirect')).toEqual({
      status: 'unavailable',
    })
    evil.dispose()
  })

  it('rejects hostnames resolving to private addresses', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(htmlResponse(pageHtml)))
    const service = makeService(fetchImpl, {
      resolveHost: () =>
        Promise.resolve([
          { address: '93.184.216.34' },
          { address: '10.0.0.1' },
        ]),
    })
    expect(await service.get('https://rebind.example.com/')).toEqual({
      status: 'unavailable',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    service.dispose()
  })

  it('caches ready previews and dedupes concurrent requests', async () => {
    let now = 1_000
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/cover.png')
          ? imageResponse(pngBytes())
          : htmlResponse(pageHtml),
      ),
    )
    const service = makeService(fetchImpl, { now: () => now })
    const [first, second] = await Promise.all([
      service.get('https://example.com/post'),
      service.get('https://example.com/post'),
    ])
    expect(first).toEqual(second)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await service.get('https://example.com/post')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    now += 600_001
    await service.get('https://example.com/post')
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    service.dispose()
  })

  it('caches unavailable results for a shorter ttl', async () => {
    let now = 1_000
    const fetchImpl = vi.fn(() =>
      Promise.resolve(htmlResponse('<head></head>')),
    )
    const service = makeService(fetchImpl, { now: () => now })
    await service.get('https://example.com/none')
    await service.get('https://example.com/none')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    now += 30_001
    await service.get('https://example.com/none')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('stops reading html at the closing head tag', async () => {
    const huge = 'x'.repeat(2 * 1_048_576)
    const service = makeService(() =>
      Promise.resolve(
        htmlResponse(`<head><title>Early</title></head><body>${huge}</body>`),
      ),
    )
    const preview = await service.get('https://example.com/big')
    expect(preview).toMatchObject({ status: 'ready', title: 'Early' })
    service.dispose()
  })

  it('returns unavailable when the html body exceeds the byte cap', async () => {
    const huge = 'x'.repeat(2 * 1_048_576)
    const service = makeService(() =>
      Promise.resolve(htmlResponse(`<head><title>${huge}`)),
    )
    expect(await service.get('https://example.com/huge')).toEqual({
      status: 'unavailable',
    })
    service.dispose()
  })

  it('aborts slow fetches after the timeout', async () => {
    const service = makeService(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          )
        }),
      { timeoutMs: 20 },
    )
    expect(await service.get('https://example.com/slow')).toEqual({
      status: 'unavailable',
    })
    service.dispose()
  })

  it('skips the dns guard only when private targets are explicitly allowed', async () => {
    const resolveHost = vi.fn(() => Promise.resolve([{ address: '127.0.0.1' }]))
    const service = makeService(
      () => Promise.resolve(htmlResponse('<head><title>local</title></head>')),
      { allowPrivateTargets: true, resolveHost },
    )
    expect(await service.get('https://internal.example.com/x')).toEqual({
      status: 'ready',
      title: 'local',
      description: null,
      image: null,
    })
    expect(resolveHost).not.toHaveBeenCalled()
    service.dispose()
  })
})
