import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const brandDirectory = path.join(repositoryRoot, 'web/public/brand')

const illustratedAgents = {
  bot: 'pegas-mascot.png',
  car: 'worker-car.png',
  camera: 'worker-camera.png',
  computer: 'worker-computer.png',
  phone: 'worker-phone.png',
} as const

function webpDimensions(data: Buffer) {
  expect(data.subarray(0, 4).toString('latin1')).toBe('RIFF')
  expect(data.subarray(8, 12).toString('latin1')).toBe('WEBP')
  const chunk = data.subarray(12, 16).toString('latin1')
  const declaredBytes = 8 + data.readUInt32LE(4)
  if (chunk === 'VP8X') {
    return {
      width: 1 + data.readUIntLE(24, 3),
      height: 1 + data.readUIntLE(27, 3),
      hasAlpha: (data.readUInt8(20) & 0x10) !== 0,
      declaredBytes,
    }
  }
  expect(chunk).toBe('VP8L')
  expect(data.readUInt8(20)).toBe(0x2f)
  const bits = data.readUInt32LE(21)
  return {
    width: 1 + (bits & 0x3fff),
    height: 1 + ((bits >> 14) & 0x3fff),
    hasAlpha: ((bits >> 28) & 1) === 1,
    declaredBytes,
  }
}

describe('illustrated agent identity assets', () => {
  it.each(Object.keys(illustratedAgents))(
    'ships %s as a 256px transparent lossless webp',
    async iconId => {
      const tilePath = path.join(brandDirectory, `agent-${iconId}.webp`)
      const data = await readFile(tilePath)
      const details = webpDimensions(data)
      expect(details.width).toBe(256)
      expect(details.height).toBe(256)
      expect(details.hasAlpha).toBe(true)
      expect(details.declaredBytes).toBe(data.length)
      expect(data.length).toBeGreaterThan(5_000)
      expect(data.length).toBeLessThan(120_000)
    },
  )

  it.each(Object.entries(illustratedAgents))(
    'keeps the %s png master for asset regeneration',
    async (_iconId, masterName) => {
      const details = await stat(path.join(brandDirectory, masterName))
      expect(details.size).toBeGreaterThan(10_000)
    },
  )

  it('derives every identity asset from the brand generator manifest', async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(repositoryRoot, 'scripts/brand-icons-manifest.json'),
        'utf8',
      ),
    ) as Record<string, string>
    for (const iconId of Object.keys(illustratedAgents)) {
      expect(manifest[`web/public/brand/agent-${iconId}.webp`]).toMatch(
        /^[0-9a-f]{64}$/,
      )
    }
  })
})
