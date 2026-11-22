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

  it('dumps the isolated home with the managed patch and key environment', async () => {
    const command = fakeDsh(`
const fs = require('node:fs')
const patchIndex = process.argv.indexOf('--patch')
const patchPath = patchIndex >= 0 ? process.argv[patchIndex + 1] : undefined
const patch = patchPath ? JSON.parse(fs.readFileSync(patchPath, 'utf8')) : []
const defaultEntry = patch.find(entry => entry.id === 'agent-default-model')
process.stdout.write(\`- id: agent-default-model
  config:
    provider: \${defaultEntry.config.provider}
    model: \${defaultEntry.config.model}
- id: llm-pi-ai
  config:
    home: \${process.env.DSH_HOME}
    key: \${process.env.PEGAS_DSH_MODEL_KEY_MAGPIE}
    providers:
      magpie:
        models:
          - id: \${defaultEntry.config.model}
\`)
`)
    const directory = mkdtempSync(join(tmpdir(), 'pegas-catalog-patch-'))
    temporaryDirectories.push(directory)
    const patchPath = join(directory, 'model-configuration.json')
    writeFileSync(
      patchPath,
      JSON.stringify([
        {
          id: 'agent-default-model',
          config: { provider: 'magpie', model: 'gateway/model-a' },
        },
      ]),
    )

    await expect(
      loadDshModelCatalog({
        command,
        profile: 'headless',
        home: '/tmp/pegas-isolated-dsh-home',
        patchPath,
        environment: { PEGAS_DSH_MODEL_KEY_MAGPIE: 'managed-key' },
      }),
    ).resolves.toEqual({
      defaultProvider: 'magpie',
      defaultModel: 'gateway/model-a',
      models: [
        {
          provider: 'magpie',
          id: 'gateway/model-a',
          name: 'gateway/model-a',
        },
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
