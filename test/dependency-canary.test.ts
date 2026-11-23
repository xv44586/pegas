import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const repositoryRoot = join(import.meta.dirname, '..')

describe('dependency canary collector', () => {
  const packageJson = JSON.parse(
    readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> }

  it('exposes a review:canary script backed by the collector', () => {
    expect(packageJson.scripts['review:canary']).toBe(
      'node scripts/capture-dependency-canary.mjs',
    )
  })

  it('collects redacted notification delivery canary in CI whenever external-service code changed', () => {
    const workflow = readFileSync(
      join(repositoryRoot, '.github', 'workflows', 'ci.yml'),
      'utf8',
    )

    expect(workflow).toContain(
      'git diff --quiet "origin/${{ github.base_ref }}...HEAD" -- src/model src/speech src/notification services',
    )
    expect(workflow).toContain(
      'pnpm review:canary -- --changed-from "origin/${{ github.base_ref }}"',
    )
  })

  it('runs the real dispatcher against a loopback webhook and writes a redacted approval deep-link canary', () => {
    const collector = readFileSync(
      join(repositoryRoot, 'scripts', 'capture-dependency-canary.mjs'),
      'utf8',
    )

    expect(collector).toContain('dist/notification/main.js')
    expect(collector).toContain("PEGAS_PUSH_MODE: 'webhook'")
    expect(collector).toContain('notification-real-service-canary.json')
    expect(collector).toContain('/?view=outbox&outbox=')
    expect(collector).toContain("redaction: 'names-and-assertions-only'")
    expect(collector).not.toContain('JSON.stringify(payload')
    expect(collector).toContain(
      'deliveredPayloadFieldNames: Object.keys(payload ?? {}).sort()',
    )
  })

  it('does not let the UI collector wipe an already collected canary artifact', () => {
    const uiCollector = readFileSync(
      join(repositoryRoot, 'scripts', 'capture-ui-review.mjs'),
      'utf8',
    )

    expect(uiCollector).not.toContain(
      'rmSync(outputDirectory, { recursive: true, force: true })',
    )
    expect(uiCollector).toContain(
      'readdirSync(outputDirectory, { withFileTypes: true })',
    )
  })
})
