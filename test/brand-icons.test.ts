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

    const types = new Set<string>()
    let offset = 8
    while (offset < data.length) {
      const type = data.subarray(offset, offset + 4).toString('latin1')
      const length = data.readUInt32BE(offset + 4)
      expect(length).toBeGreaterThan(8)
      const payload = data.subarray(offset + 8, offset + length)
      expect(payload.subarray(1, 4).toString('latin1')).toBe('PNG')
      types.add(type)
      offset += length
    }
    for (const required of ['ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12'])
      expect(types.has(required)).toBe(true)
  })

  it('serves favicon fallbacks and touch icon from the web root', async () => {
    const html = await readFile(
      path.join(repositoryRoot, 'web/index.html'),
      'utf8',
    )
    expect(html).toContain('href="/favicon.svg"')
    expect(html).toContain('href="/favicon-32.png"')
    expect(html).toContain('href="/apple-touch-icon.png"')
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
    expect(svg).toContain('data:image/png;base64,')
    expect(svg).toContain('viewBox="0 0 1024 1024"')
  })

  it('manifest hashes match the committed artifacts without Pillow', async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(repositoryRoot, 'scripts/brand-icons-manifest.json'),
        'utf8',
      ),
    ) as Record<string, string>
    expect(Object.keys(manifest).length).toBe(5)
    for (const [relativePath, expectedHash] of Object.entries(manifest)) {
      const content = await readFile(path.join(repositoryRoot, relativePath))
      expect(createHash('sha256').update(content).digest('hex')).toBe(
        expectedHash,
      )
    }
  })
})
