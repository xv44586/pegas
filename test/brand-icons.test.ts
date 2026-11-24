import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

describe('unified brand application icons', () => {
  it('packages the mascot tile into a valid multi-size icns', async () => {
    const data = await readFile(path.join(repositoryRoot, 'desktop/Pegas.icns'))
    expect(data.subarray(0, 4).toString('latin1')).toBe('icns')
    expect(data.readUInt32BE(4)).toBe(data.length)

    const sizes = new Set<number>()
    let offset = 8
    while (offset < data.length) {
      const length = data.readUInt32BE(offset + 4)
      expect(length).toBeGreaterThan(8)
      const payload = data.subarray(offset + 8, offset + length)
      expect(payload.subarray(1, 4).toString('latin1')).toBe('PNG')
      const width = payload.readUInt32BE(16)
      expect(payload.readUInt32BE(20)).toBe(width)
      sizes.add(width)
      offset += length
    }
    expect(offset).toBe(data.length)
    expect([...sizes].sort((a, b) => a - b)).toEqual([
      16, 32, 64, 128, 256, 512, 1024,
    ])
  })

  it('serves favicon fallbacks and touch icon from the web root', async () => {
    const html = await readFile(
      path.join(repositoryRoot, 'web/index.html'),
      'utf8',
    )
    expect(html).toContain('href="/favicon.svg?v=4"')
    expect(html).toContain('href="/favicon-32.png?v=4"')
    expect(html).toContain('href="/apple-touch-icon.png?v=4"')
    for (const file of [
      'favicon.svg',
      'favicon-32.png',
      'apple-touch-icon.png',
    ]) {
      const details = await readFile(
        path.join(repositoryRoot, 'web/public', file),
      )
      expect(details.length).toBeGreaterThan(100)
    }
  })

  it('keeps the desktop source icon self-contained on the brand tile', async () => {
    const svg = await readFile(
      path.join(repositoryRoot, 'desktop/icon.svg'),
      'utf8',
    )
    expect(svg).toContain('data:image/webp;base64,')
    expect(svg).toContain('viewBox="0 0 160 160"')
  })

  it('manifest hashes match the committed artifacts without Pillow', async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(repositoryRoot, 'scripts/brand-icons-manifest.json'),
        'utf8',
      ),
    ) as Record<string, string>
    expect(Object.keys(manifest).length).toBe(15)
    for (const source of [
      'desktop/icon.png',
      'desktop/icon.svg',
      'web/public/brand/pegas-mascot.png',
      'web/public/brand/pegas-home.svg',
      'web/public/brand/pegas-flight.svg',
      'web/public/brand/pegas-speaking.svg',
    ]) {
      expect(manifest[source]).toMatch(/^[0-9a-f]{64}$/)
    }
    for (const [relativePath, expectedHash] of Object.entries(manifest)) {
      const content = await readFile(path.join(repositoryRoot, relativePath))
      expect(createHash('sha256').update(content).digest('hex')).toBe(
        expectedHash,
      )
    }
  })
})
