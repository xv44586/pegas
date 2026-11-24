import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const brandDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../web/public/brand',
)

function readSvg(name: string) {
  return readFile(path.join(brandDirectory, `pegas-${name}.svg`), 'utf8')
}

describe('Pegas mascot assets', () => {
  it.each(['home', 'flight', 'speaking'])(
    'ships %s on a self-contained square canvas using the same robot',
    async name => {
      const [svg, home] = await Promise.all([readSvg(name), readSvg('home')])
      expect(svg).toContain('viewBox="0 0 160 160"')
      expect(svg).toContain('data:image/webp;base64,')
      expect(svg).not.toMatch(/href="https?:|<script\b/u)
      const imageTag = /<image [^>]+\/>/u
      const embeddedRobot = imageTag.exec(svg)?.[0]
      expect(embeddedRobot).toBeDefined()
      expect(embeddedRobot).toBe(imageTag.exec(home)?.[0])
      expect(Buffer.byteLength(svg)).toBeLessThan(60_000)
    },
  )

  it.each(['flight', 'speaking'])(
    'gates the %s animation on the system motion preference',
    async name => {
      const svg = await readSvg(name)
      expect(svg).toContain('@media (prefers-reduced-motion: no-preference)')
      expect(svg).toContain('@keyframes')
    },
  )

  it('keeps the lossless PNG source for the identity thumbnail', async () => {
    const source = await readFile(path.join(brandDirectory, 'pegas-mascot.png'))
    expect(source.subarray(1, 4).toString('ascii')).toBe('PNG')
  })
})
