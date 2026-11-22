import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  resolve(import.meta.dirname, '..', 'web', 'src', 'sealed-ui.css'),
  'utf8',
)

const allowedFontSizes = new Set([
  'var(--text-micro)',
  'var(--text-tiny)',
  'var(--text-small)',
  'var(--text-caption)',
  'var(--text-body)',
  'var(--text-read)',
  'var(--text-title)',
  'var(--text-display)',
  'inherit',
  '0.92em',
])

const allowedFontWeights = new Set(['400', '500', 'inherit'])

function declarations(property: string): string[] {
  const pattern = new RegExp(`${property}:\\s*([^;]+);`, 'g')
  return [...stylesheet.matchAll(pattern)].map(match => (match[1] ?? '').trim())
}

function blocksFor(selector: string): string[] {
  const withoutComments = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '')
  const bodies: string[] = []
  let buffer = ''
  let depth = 0
  let selectorAtDepthZero = ''
  let bodyStart = 0
  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index]
    if (character === '{') {
      if (depth === 0) {
        selectorAtDepthZero = buffer.trim()
        bodyStart = index + 1
      }
      depth += 1
      buffer = ''
      continue
    }
    if (character === '}') {
      depth -= 1
      if (depth === 0 && !selectorAtDepthZero.startsWith('@')) {
        const selectors = selectorAtDepthZero
          .split(',')
          .map(part => part.trim().replace(/\s+/g, ' '))
        if (selectors.includes(selector))
          bodies.push(withoutComments.slice(bodyStart, index))
      }
      buffer = ''
      continue
    }
    if (depth === 0 && character !== undefined) buffer += character
  }
  if (bodies.length === 0) throw new Error(`Missing CSS block: ${selector}`)
  return bodies
}

function declarationOf(selector: string, property: string): string {
  const pattern = new RegExp(`${property}:\\s*([^;]+);`, 'g')
  let found: string | undefined
  for (const body of blocksFor(selector)) {
    for (const match of body.matchAll(pattern)) found = (match[1] ?? '').trim()
  }
  if (found === undefined)
    throw new Error(`Missing ${property} in: ${selector}`)
  return found
}

function fontSizeOf(selector: string): string {
  return declarationOf(selector, 'font-size')
}

describe('sealed UI typography scale (DESIGN-004)', () => {
  it('defines the eight-step font size scale as tokens', () => {
    const root = blocksFor(':root').join('\n')
    const scale: Record<string, string> = {
      '--text-micro': '10px',
      '--text-tiny': '11px',
      '--text-small': '12px',
      '--text-caption': '13px',
      '--text-body': '14px',
      '--text-read': '16px',
      '--text-title': '20px',
      '--text-display': '26px',
    }
    for (const [token, value] of Object.entries(scale)) {
      expect(root).toContain(`${token}: ${value};`)
    }
  })

  it('only references scale tokens for font-size', () => {
    const offenders = declarations('font-size').filter(
      value => !allowedFontSizes.has(value),
    )
    expect(offenders).toEqual([])
  })

  it('keeps every explicit font weight within 400/500', () => {
    const offenders = declarations('font-weight').filter(
      value => !allowedFontWeights.has(value),
    )
    expect(offenders).toEqual([])
  })

  it('resets heading elements to weight 500', () => {
    const headingReset = /h1,\s*h2,\s*h3,\s*h4\s*\{([^}]+)\}/.exec(stylesheet)
    expect(headingReset?.[1]).toContain('font-weight: 500;')
  })

  it('keeps section titles larger than card titles', () => {
    expect(fontSizeOf('.detail-section h3')).toBe('var(--text-body)')
    expect(fontSizeOf('.criteria-list strong')).toBe('var(--text-caption)')
    expect(fontSizeOf('.evidence-copy strong')).toBe('var(--text-caption)')
    expect(fontSizeOf('.link-preview-lines h3')).toBe('var(--text-caption)')
  })

  it('keeps card body one step below outside body copy', () => {
    expect(fontSizeOf('body')).toBe('var(--text-body)')
    expect(fontSizeOf('.link-preview-card')).toBe('var(--text-caption)')
    expect(fontSizeOf('.attention-preview')).toBe('var(--text-caption)')
    expect(fontSizeOf('.criteria-list p')).toBe('var(--text-caption)')
    expect(fontSizeOf('.approval-card p')).toBe('var(--text-caption)')
  })

  it('keeps button text one step below adjacent body copy', () => {
    expect(declarationOf('.secondary-button', 'font-size')).toBe(
      'var(--text-caption)',
    )
    expect(fontSizeOf('.composer-queue li')).toBe('var(--text-caption)')
    expect(fontSizeOf('.composer-queue button')).toBe('var(--text-small)')
    expect(fontSizeOf('.composer-context')).toBe('var(--text-caption)')
    expect(declarationOf('.composer-context button', 'font-size')).toBe(
      'var(--text-small)',
    )
  })

  it('unifies page-level display titles on one step', () => {
    for (const selector of [
      '.page-header h1',
      '.conversation-welcome h2',
      '.about-pane h2',
      '.setup-body h1',
      '.access-page h1',
      '.settings-heading h2',
    ]) {
      expect(fontSizeOf(selector), selector).toBe('var(--text-display)')
    }
  })

  it('balances heading line breaks', () => {
    const headingReset = /h1,\s*h2,\s*h3,\s*h4\s*\{([^}]+)\}/.exec(stylesheet)
    expect(headingReset?.[1]).toContain('text-wrap: balance;')
  })

  it('gives display and title steps compact line heights', () => {
    for (const selector of [
      '.page-header h1',
      '.conversation-welcome h2',
      '.about-pane h2',
      '.setup-body h1',
      '.access-page h1',
      '.settings-heading h2',
    ]) {
      expect(declarationOf(selector, 'line-height'), selector).toBe('1.2')
    }
    for (const selector of [
      '.drawer-header h2',
      '.empty-capability h2',
      '.settings-nav-title h1',
      '.usage-metrics strong',
    ]) {
      expect(declarationOf(selector, 'line-height'), selector).toBe('1.25')
    }
  })

  it('maps tracking to font size steps consistently', () => {
    for (const selector of [
      '.page-header h1',
      '.conversation-welcome h2',
      '.about-pane h2',
      '.setup-body h1',
      '.access-page h1',
      '.settings-heading h2',
    ]) {
      expect(declarationOf(selector, 'letter-spacing'), selector).toBe(
        '-0.03em',
      )
    }
    for (const selector of [
      '.drawer-header h2',
      '.empty-capability h2',
      '.settings-nav-title h1',
      '.provider-detail > header h3',
    ]) {
      expect(declarationOf(selector, 'letter-spacing'), selector).toBe(
        '-0.02em',
      )
    }
  })

  it('drops the dead serif file-preview block', () => {
    expect(stylesheet).not.toContain('.file-preview')
    expect(stylesheet).not.toContain('ui-serif')
  })

  it('removes decorative count and position pills', () => {
    expect(stylesheet).not.toContain('.provider-detail h4 b')
    expect(stylesheet).not.toContain('.composer-queue-position')
  })

  it('removes the drawer eyebrow and redundant state-hero status label', () => {
    expect(stylesheet).not.toContain('.drawer-header small')
    expect(stylesheet).not.toContain('.state-hero small')
  })
})
