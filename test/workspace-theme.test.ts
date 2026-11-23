import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const sealedUi = readFileSync(
  new URL('../web/src/sealed-ui.css', import.meta.url),
  'utf8',
)
const mainEntry = readFileSync(
  new URL('../web/src/main.tsx', import.meta.url),
  'utf8',
)
const uiReviewScript = readFileSync(
  new URL('../scripts/capture-ui-review.mjs', import.meta.url),
  'utf8',
)

describe('sealed UI layout contracts', () => {
  it('uses the new single style entry and excludes the legacy themes', () => {
    expect(mainEntry).toContain("import './sealed-ui.css'")
    expect(mainEntry).not.toContain('workspace-theme.css')
    expect(mainEntry).not.toContain("'./styles.css'")
  })

  it('keeps UI review independent from a developer DSH installation', () => {
    expect(uiReviewScript).toContain('PEGAS_DSH_COMMAND')
    expect(uiReviewScript).toContain('ui-review-dsh')
  })

  it('keeps the desktop shell and mobile navigation geometries explicit', () => {
    expect(sealedUi).toMatch(
      /\.app-shell\s*\{[^}]*grid-template-columns:\s*286px minmax\(0, 1fr\);[^}]*height:\s*100dvh;/,
    )
    expect(sealedUi).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.mobile-nav\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(6, 1fr\);/,
    )
  })

  it('implements all four appearance choices with semantic tokens', () => {
    expect(sealedUi).toMatch(/:root\[data-theme=['"]warm['"]\]/)
    expect(sealedUi).toMatch(/:root\[data-theme=['"]dark['"]\]/)
    expect(sealedUi).toMatch(/:root\[data-theme=['"]system['"]\]/)
    expect(sealedUi).toMatch(/--canvas:\s*#fff;/)
    expect(sealedUi).toMatch(/background:\s*var\(--canvas\)/)
  })

  it('keeps dictation errors in composer flow', () => {
    expect(sealedUi).toMatch(
      /\.composer-error\s*\{[^}]*margin:\s*0 auto 8px;[^}]*max-width:\s*1040px;/,
    )
    expect(sealedUi).not.toMatch(
      /\.composer-error\s*\{[^}]*position:\s*absolute;/,
    )
  })

  it('makes detail drawers full height and responsive', () => {
    expect(sealedUi).toMatch(
      /\.detail-drawer\s*\{[^}]*height:\s*100dvh;[^}]*width:\s*560px;/,
    )
    expect(sealedUi).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.detail-drawer\s*\{[^}]*width:\s*100%;/,
    )
  })

  it('preserves visible keyboard focus and reduced motion', () => {
    expect(sealedUi).toContain('button:focus-visible')
    expect(sealedUi).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('keeps mobile search and settings save feedback visible', () => {
    expect(sealedUi).not.toMatch(
      /@media \(max-width: 520px\)[\s\S]*?\.page-toolbar button:first-child\s*\{[^}]*display:\s*none;/,
    )
    expect(sealedUi).not.toMatch(
      /@media \(max-width: 520px\)[\s\S]*?\.settings-footer\s*>\s*span\s*\{[^}]*display:\s*none;/,
    )
  })

  it('separates model provider and settings layouts', () => {
    expect(sealedUi).toMatch(
      /\.model-service-layout\s*\{[^}]*grid-template-columns:\s*220px minmax\(0, 1fr\);/,
    )
    expect(sealedUi).toContain('.router-settings')
    expect(sealedUi).toContain('.pegas-settings')
  })

  it('keeps every model-selection entry on the paginated shared catalog', () => {
    const mainPages = readFileSync(
      new URL('../web/src/sealed/MainPages.tsx', import.meta.url),
      'utf8',
    )
    const settingsPage = readFileSync(
      new URL('../web/src/sealed/SettingsPage.tsx', import.meta.url),
      'utf8',
    )
    const app = readFileSync(
      new URL('../web/src/App.tsx', import.meta.url),
      'utf8',
    )
    const pageSizeMatches = [
      ...mainPages.matchAll(/const pageSize = (\d+)/g),
      ...settingsPage.matchAll(/const pageSize = (\d+)/g),
    ].map(match => match[1])
    expect(pageSizeMatches.length).toBeGreaterThanOrEqual(2)
    for (const size of pageSizeMatches) expect(size).toBe('30')
    expect(mainPages).toContain('filteredModels.length > pageSize')
    expect(mainPages).toContain('上一页')
    expect(mainPages).toContain('下一页')
    expect(app).toContain(
      'const availableAgentModels = agentModels?.models ?? []',
    )
    expect(uiReviewScript).toContain('assertPickerPagination')
    expect(uiReviewScript).toContain('PEGAS_MODEL_BASE_URL')
  })
})
