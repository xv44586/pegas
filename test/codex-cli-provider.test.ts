import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CodexCliProvider } from '../src/model/codex-cli-provider.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('CodexCliProvider', () => {
  it('uses an ephemeral read-only Codex process with structured output', async () => {
    const command = fakeCodex(`
const fs = require('node:fs')
const args = process.argv.slice(2)
const outputPath = args[args.indexOf('--output-last-message') + 1]
let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { prompt += chunk })
process.stdin.on('end', () => {
  fs.writeFileSync(outputPath, JSON.stringify({
    kind: 'create_task',
    title: args.includes('gpt-5.6-luna') ? 'Model selected' : 'Wrong model',
    goal: prompt.includes('Route this') ? 'Prompt received' : 'Missing prompt',
    reason: args.includes('--ephemeral') && args.includes('read-only')
      ? 'Isolated'
      : 'Not isolated'
  }))
})
`)
    const provider = new CodexCliProvider({ command })

    const answer = await provider.generateJson({
      system: 'Route this message.',
      input: '{"message":"Build it"}',
      schema: { type: 'object', additionalProperties: true },
    })

    expect(answer).toEqual({
      kind: 'create_task',
      title: 'Model selected',
      goal: 'Prompt received',
      reason: 'Isolated',
    })
  })
})

function fakeCodex(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-fake-codex-'))
  temporaryDirectories.push(directory)
  const command = join(directory, 'codex')
  writeFileSync(command, `#!/usr/bin/env node\n${body}`, { mode: 0o700 })
  chmodSync(command, 0o700)
  return command
}
