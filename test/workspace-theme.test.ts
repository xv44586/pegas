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

  it('keeps dictation errors in the composer flow instead of overlaying messages', () => {
    expect(workspaceTheme).toMatch(
      /\.dictation-error\s*\{[^}]*position:\s*static;[^}]*width:\s*100%;[^}]*overflow-wrap:\s*anywhere;/,
    )
    expect(workspaceTheme).not.toMatch(
      /\.dictation-error\s*\{[^}]*inset-block-end:\s*calc\(100% \+ 6px\)/,
    )
  })

  it('keeps Worker identity blue and encodes state with separate badges', () => {
    expect(workspaceTheme).toMatch(
      /\.pegas-agent-avatar\s*\{[^}]*--pegas-icon-background:\s*#4d6bfe;/,
    )
    expect(workspaceTheme).not.toMatch(
      /\.pegas-agent-avatar\.status-[\w-]+\s*\{[^}]*--pegas-icon-background:/,
    )
    for (const status of [
      'backlog',
      'unstarted',
      'started',
      'completed',
      'cancelled',
    ]) {
      expect(workspaceTheme).toContain(
        `.pegas-agent-avatar.status-${status} .pegas-agent-status`,
      )
    }
  })
})
