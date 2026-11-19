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

  it('gives the Router model picker the full field width and its own scroll region', () => {
    expect(workspaceTheme).toMatch(
      /\.model-picker-panel\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*min-inline-size:\s*0;/,
    )
    expect(workspaceTheme).toMatch(
      /\.model-picker-list\s*\{[^}]*max-block-size:\s*min\([^;]+;[^}]*overflow-y:\s*auto;/,
    )
    expect(workspaceTheme).toMatch(
      /\.model-pagination\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between;/,
    )
    expect(workspaceTheme).toMatch(
      /\.model-picker-search input\s*\{[^}]*inline-size:\s*100%;[^}]*min-inline-size:\s*0;[^}]*padding-inline-start:\s*38px;/,
    )
  })

  it('keeps model feedback compact and attached to its controls', () => {
    expect(workspaceTheme).toMatch(
      /\.model-feedback\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*16px\s+minmax\(0,\s*1fr\);/,
    )
    expect(workspaceTheme).toMatch(
      /\.model-feedback strong\s*\{[^}]*font-size:\s*12px;[^}]*line-height:\s*16px;/,
    )
    expect(workspaceTheme).toMatch(
      /\.model-feedback span\s*\{[^}]*font-size:\s*11px;[^}]*line-height:\s*16px;/,
    )
  })

  it('reflows Channel navigation before its labels collide in a narrow sidebar', () => {
    expect(workspaceTheme).toMatch(
      /\.identity-rail\s*\{[^}]*container:\s*task-sidebar\s*\/\s*inline-size;/,
    )
    expect(workspaceTheme).toMatch(
      /@container\s+task-sidebar\s*\(inline-size\s*<\s*260px\)[\s\S]*?\.sidebar-section-nav\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/,
    )
  })

  it('stretches the desktop Channel list inside the sidebar rail', () => {
    const parityPass = workspaceTheme.slice(
      workspaceTheme.indexOf('/* CONV-002 DS Bot parity pass'),
    )
    expect(parityPass).toMatch(
      /\.identity-rail\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*stretch;/,
    )
    expect(parityPass).toMatch(
      /\.task-sidebar-list\s*\{[^}]*inline-size:\s*100%;/,
    )
  })
})
