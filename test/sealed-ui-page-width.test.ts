import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  resolve(import.meta.dirname, '..', 'web', 'src', 'sealed-ui.css'),
  'utf8',
)

function ruleBody(selector: string): string {
  const withoutComments = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '')
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(withoutComments)
  if (!match) throw new Error(`Missing rule for ${selector}`)
  return match[1] ?? ''
}

describe('standard page reading width', () => {
  it('caps page content at the shared 1040px column and centers it', () => {
    const body = ruleBody('.standard-page > :not(.page-header)')
    expect(body).toMatch(/max-width:\s*1040px/)
    expect(body).toMatch(/margin-left:\s*auto/)
    expect(body).toMatch(/margin-right:\s*auto/)
    expect(body).toMatch(/width:\s*calc\(100% - 84px\)/)
  })

  it('keeps the page header aligned with the capped content column', () => {
    const body = ruleBody('.page-header')
    expect(body).toMatch(/max-width:\s*1124px/)
    expect(body).toMatch(/margin-left:\s*auto/)
    expect(body).toMatch(/margin-right:\s*auto/)
    expect(body).toMatch(/width:\s*100%/)
  })

  it('keeps the mobile gutters at 20px within the same cap', () => {
    const withoutComments = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '')
    const mobileStart = withoutComments.indexOf('@media (max-width: 820px)')
    expect(mobileStart).toBeGreaterThan(-1)
    const mobile = withoutComments.slice(
      mobileStart,
      withoutComments.indexOf('@media (max-width: 520px)'),
    )
    const match = /\.standard-page > :not\(\.page-header\)\s*\{([^}]*)\}/.exec(
      mobile,
    )
    expect(match?.[1] ?? '').toMatch(/width:\s*calc\(100% - 40px\)/)
  })
})
