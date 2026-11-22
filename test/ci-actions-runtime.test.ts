import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'),
  'utf8',
)

const node24MinimumMajors: Record<string, number> = {
  'actions/checkout': 7,
  'actions/setup-node': 7,
  'actions/upload-artifact': 7,
  'pnpm/action-setup': 6,
}

function usedMajor(action: string): number {
  const pattern = new RegExp(`uses:\\s*${action.replace('/', '\\/')}@v(\\d+)`)
  const match = pattern.exec(workflow)
  if (!match?.[1]) throw new Error(`Missing uses: ${action}@vN in ci.yml`)
  return Number.parseInt(match[1], 10)
}

describe('CI actions run on the node24 runtime (QUALITY-001)', () => {
  it.each(Object.entries(node24MinimumMajors))(
    'pins %s to at least v%i (node24)',
    (action, minimumMajor) => {
      expect(usedMajor(action)).toBeGreaterThanOrEqual(minimumMajor)
    },
  )

  it('keeps the immutable PR head ref and node 24 toolchain', () => {
    expect(workflow).toContain(
      'ref: ${{ github.event.pull_request.head.sha || github.sha }}',
    )
    expect(workflow).toContain('node-version: 24')
    expect(workflow).toContain('cache: pnpm')
  })
})
