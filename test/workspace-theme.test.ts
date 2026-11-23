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
      /\.app-shell\s*\{[^}]*grid-template-columns:\s*232px minmax\(0, 1fr\);[^}]*height:\s*100dvh;/,
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
    const detailDrawer = readFileSync(
      new URL('../web/src/sealed/DetailDrawer.tsx', import.meta.url),
      'utf8',
    )
    const modelPicker = readFileSync(
      new URL('../web/src/sealed/ModelPicker.tsx', import.meta.url),
      'utf8',
    )
    const onboarding = readFileSync(
      new URL('../web/src/sealed/Onboarding.tsx', import.meta.url),
      'utf8',
    )
    const app = readFileSync(
      new URL('../web/src/App.tsx', import.meta.url),
      'utf8',
    )
    const pageSizeMatches = [
      ...mainPages.matchAll(/const pageSize = (\d+)/g),
      ...settingsPage.matchAll(/const pageSize = (\d+)/g),
      ...modelPicker.matchAll(/export const MODEL_PICKER_PAGE_SIZE = (\d+)/g),
    ].map(match => match[1])
    expect(pageSizeMatches.length).toBeGreaterThanOrEqual(2)
    for (const size of pageSizeMatches) expect(size).toBe('30')
    expect(modelPicker).toContain('filteredModels.length > pageSize')
    expect(modelPicker).toContain('上一页')
    expect(modelPicker).toContain('下一页')
    for (const consumer of [
      mainPages,
      settingsPage,
      detailDrawer,
      onboarding,
    ]) {
      expect(consumer).toContain("from './ModelPicker'")
      expect(consumer).toContain('<ModelPicker')
    }
    const settingsModelSelects = [
      ...settingsPage.matchAll(/aria-label="([^"]*模型[^"]*)"/g),
    ].map(match => match[1])
    expect(settingsModelSelects).toContain('归类模型服务')
    expect(detailDrawer).not.toMatch(/<select[^>]*>\s*\{catalog\?\.models\.map/)
    expect(settingsPage).toContain('手动输入模型 ID')
    expect(settingsPage).toContain('visibleModels.length > pageSize')
    expect(app).toContain(
      'const availableAgentModels = agentModels?.models ?? []',
    )
    expect(uiReviewScript).toContain('assertPickerPagination')
    expect(uiReviewScript).toContain('PEGAS_MODEL_BASE_URL')
  })

  it('keeps the onboarding model picker unclipped and single-bordered', () => {
    expect(sealedUi).toMatch(
      /\.onboarding-dialog\s*\{(?![^}]*overflow:\s*hidden)[^}]*\}/,
    )
    expect(sealedUi).toMatch(
      /\.setup-form > label > input,\s*\.setup-form > \.field-label > input,\s*\.setup-form > label > select\s*\{/,
    )
    expect(sealedUi).not.toMatch(/\.setup-form input,/)
    const app = readFileSync(
      new URL('../web/src/App.tsx', import.meta.url),
      'utf8',
    )
    expect(app).toMatch(/<Onboarding[\s\S]*?catalog=\{agentModels\}/)
    expect(app).toMatch(/<Onboarding[\s\S]*?onSelectModel=\{selectAgentModel\}/)
    expect(uiReviewScript).toContain('onboarding model picker')
  })

  it('keeps picker trigger accessible names aligned with the glued visible lines', () => {
    const modelPicker = readFileSync(
      new URL('../web/src/sealed/ModelPicker.tsx', import.meta.url),
      'utf8',
    )
    expect(modelPicker).toContain(
      "aria-label={`${selection?.label ?? placeholder}${selection?.detail ?? ''}，${ariaLabel}`}",
    )
    const a11yScript = readFileSync(
      new URL('../scripts/a11y-review.mjs', import.meta.url),
      'utf8',
    )
    expect(a11yScript).toContain('onboarding-model-picker')
    expect(a11yScript).toContain('PEGAS_MODEL_BASE_URL')
  })

  it('stacks the composer trigger name and provider detail instead of gluing them inline', () => {
    expect(sealedUi).toMatch(
      /\.composer-model-button > span\s*\{[^}]*display:\s*grid;/,
    )
    expect(sealedUi).toMatch(
      /\.composer-model-button strong,\s*\.composer-model-button small\s*\{[^}]*text-overflow:\s*ellipsis;/,
    )
    expect(sealedUi).toMatch(
      /\.composer-model-button small\s*\{[^}]*color:\s*var\(--muted\);/,
    )
    const modelPicker = readFileSync(
      new URL('../web/src/sealed/ModelPicker.tsx', import.meta.url),
      'utf8',
    )
    expect(modelPicker).toContain(
      '<strong>{selection?.label ?? placeholder}</strong>',
    )
    expect(modelPicker).toContain(
      '<small>{selection?.detail ?? placeholderDetail}</small>',
    )
  })

  it('keeps search inputs on the single container-owned focus treatment', () => {
    expect(sealedUi).toMatch(
      /\.model-search\s*\{[^}]*border:\s*1px solid transparent;/,
    )
    expect(sealedUi).toMatch(
      /\.model-search:focus-within\s*\{[^}]*border-color:\s*var\(--accent\);/,
    )
    expect(sealedUi).toMatch(/\.model-search input\s*\{[^}]*border:\s*0;/)
    expect(sealedUi).toMatch(
      /\.model-search input:focus-visible\s*\{[^}]*outline:\s*none;/,
    )
    expect(sealedUi).toMatch(
      /\.model-search input::placeholder\s*\{[^}]*color:\s*var\(--muted\);/,
    )
    expect(sealedUi).not.toContain('.provider-list input')
    const settingsPage = readFileSync(
      new URL('../web/src/sealed/SettingsPage.tsx', import.meta.url),
      'utf8',
    )
    const searchLabels = [
      ...settingsPage.matchAll(
        /<label className="model-search">[\s\S]*?<\/label>/g,
      ),
    ]
    expect(searchLabels.length).toBeGreaterThanOrEqual(2)
  })
})
