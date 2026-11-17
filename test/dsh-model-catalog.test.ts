import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadDshModelCatalog } from '../src/executor/dsh-model-catalog.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('DSH model catalog', () => {
  it('returns the profile default and selectable provider/model pairs', async () => {
    const command = fakeDsh(`
process.stdout.write(\`- id: llm-pi-ai
  config:
    providers:
      magpie:
        models:
          - id: model-b
            name: Model B
          - id: model-a
            name: Model A
- id: agent-default-model
  config:
    provider: magpie
    model: model-a
\`)
`)

    await expect(
      loadDshModelCatalog({ command, profile: 'headless' }),
    ).resolves.toEqual({
      defaultProvider: 'magpie',
      defaultModel: 'model-a',
      models: [
        { provider: 'magpie', id: 'model-a', name: 'Model A' },
        { provider: 'magpie', id: 'model-b', name: 'Model B' },
      ],
    })
  })
})

function fakeDsh(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-fake-dsh-catalog-'))
  temporaryDirectories.push(directory)
  const command = join(directory, 'dsh')
  writeFileSync(command, `#!/usr/bin/env node\n${body}`, { mode: 0o700 })
  chmodSync(command, 0o700)
  return command
}
