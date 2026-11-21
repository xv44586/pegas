import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const spriteModuleDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../web/src',
)

const tablerSourcePaths = {
  car: [
    'M5 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
    'M15 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
    'M5 17h-2v-6l2 -5h9l4 5h1a2 2 0 0 1 2 2v4h-2m-4 0h-6m-6 -6h15m-6 0v-5',
  ],
  camera: [
    'M5 7h1a2 2 0 0 0 2 -2a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2',
    'M9 13a3 3 0 1 0 6 0a3 3 0 0 0 -6 0',
  ],
  computer: [
    'M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10',
    'M7 20h10',
    'M9 16v4',
    'M15 16v4',
  ],
  phone: [
    'M6 5a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2v-14',
    'M11 4h2',
    'M12 17v.01',
  ],
} as const

async function readAsset(fileName: string) {
  return readFile(path.join(spriteModuleDirectory, fileName), 'utf8')
}

describe('worker icon assets adapt Tabler outline geometry', () => {
  it.each(Object.entries(tablerSourcePaths))(
    'renders %s from the unmodified Tabler source paths',
    async (name, sourcePaths) => {
      const [spriteModule, sprite] = await Promise.all([
        readAsset('agent-icon-sprite.ts'),
        readAsset('pegas-agents.svg'),
      ])

      for (const document of [spriteModule.replaceAll('\\"', '"'), sprite]) {
        expect(document).toContain(
          'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="translate(8 8) scale(2)"',
        )
        for (const pathData of sourcePaths) {
          expect(document).toContain(`<path d="${pathData}"/>`)
        }
      }
    },
  )

  it('keeps the Pegas bot identity on its own geometry', async () => {
    const bot = (await readAsset('agent-icon-sprite.ts')).replaceAll('\\"', '"')

    const botSymbol = bot.slice(
      bot.indexOf('id="pegas-agent-bot"'),
      bot.indexOf('</symbol>'),
    )
    expect(botSymbol).toContain('<path d="M32 18V11"/>')
    expect(botSymbol).toContain(
      '<rect x="17" y="18" width="30" height="27" rx="6"/>',
    )
    expect(botSymbol).not.toContain('translate(8 8) scale(2)')
  })
})
