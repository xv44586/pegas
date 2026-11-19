import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const workspaceTheme = readFileSync(
  new URL('../web/src/workspace-theme.css', import.meta.url),
  'utf8',
)

describe('workspace layout contracts', () => {
  it('anchors the empty-state header to the workspace panel', () => {
    expect(workspaceTheme).toMatch(
      /\.workspace-empty\s*\{\s*position:\s*relative;/,
    )
    expect(workspaceTheme).toMatch(
      /\.workspace-empty\s*>\s*header\s*\{[^}]*inset-inline:\s*0;[^}]*width:\s*100%;/,
    )
  })

  it('right-aligns the compact workspace instead of inheriting a left inset', () => {
    expect(workspaceTheme).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.workspace-panel\s*\{[^}]*inset-inline-start:\s*auto;[^}]*inset-inline-end:\s*0;/,
    )
  })
})
