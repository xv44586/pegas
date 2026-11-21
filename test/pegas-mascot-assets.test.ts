import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const brandDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../web/public/brand',
)

describe('pegas mascot assets', () => {
  it('ships the runtime webp with a bounded size', async () => {
    const assetPath = path.join(brandDirectory, 'pegas-mascot.webp')
    await expect(access(assetPath)).resolves.toBeUndefined()
    const details = await stat(assetPath)
    expect(details.size).toBeGreaterThan(10_000)
    expect(details.size).toBeLessThan(200_000)
  })

  it('keeps the lossless png master for future derivations', async () => {
    const assetPath = path.join(brandDirectory, 'pegas-mascot.png')
    await expect(access(assetPath)).resolves.toBeUndefined()
    const details = await stat(assetPath)
    expect(details.size).toBeGreaterThan(10_000)
  })

  it.each(['waiting', 'celebrate', 'blocked'])(
    'ships the %s pose webp with a bounded size',
    async pose => {
      const assetPath = path.join(brandDirectory, `pegas-mascot-${pose}.webp`)
      await expect(access(assetPath)).resolves.toBeUndefined()
      const details = await stat(assetPath)
      expect(details.size).toBeGreaterThan(10_000)
      expect(details.size).toBeLessThan(200_000)
    },
  )
})
