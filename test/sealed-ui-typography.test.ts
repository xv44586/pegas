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
    expect(fontSizeOf('.criteria-list p')).toBe('var(--text-caption)')
    const attentionSource = readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        'web',
        'src',
        'sealed',
        'MainPages.tsx',
      ),
      'utf8',
    )
    expect(attentionSource).toContain(
      'attention-preview line-clamp-1 m-0 text-[13px] leading-normal text-ink-2',
    )
    expect(stylesheet).not.toContain('.attention-preview {')
    const detailDrawer = readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        'web',
        'src',
        'sealed',
        'DetailDrawer.tsx',
      ),
      'utf8',
    )
    expect(detailDrawer).toContain('text-[13px] leading-[1.55] text-ink-2')
    expect(stylesheet).not.toContain('.approval-card p')
  })

  it('keeps button text one step below adjacent body copy', () => {
    const button = readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        'web',
        'src',
        'bui',
        'components',
        'atoms',
        'Button.tsx',
      ),
      'utf8',
    )
    expect(button).toContain("sm: 'h-[27px] px-3 text-[13px]")
    expect(stylesheet).not.toContain('.secondary-button')
    expect(stylesheet).not.toContain('.primary-button')
    const mainPages = readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        'web',
        'src',
        'sealed',
        'MainPages.tsx',
      ),
      'utf8',
    )
    expect(mainPages).toContain(
      'flex min-h-9 items-center gap-2 rounded-card bg-surface px-2 py-1 text-[13px] shadow-hairline',
    )
    expect(mainPages).toContain(
      'composer-context mx-auto mb-2 flex min-h-[38px] w-full max-w-[1040px] items-center justify-between gap-3 rounded-card bg-accent-tint px-3 py-1.5 text-[13px] text-ink-2',
    )
    expect(stylesheet).not.toContain('.composer-queue li')
    expect(stylesheet).not.toContain('.composer-context {')
  })

  it('unifies page-level display titles on one step', () => {
    for (const selector of [
      '.page-header h1',
      '.conversation-welcome h2',
      '.setup-body h1',
      '.access-page h1',
    ]) {
      expect(fontSizeOf(selector), selector).toBe('var(--text-display)')
    }
    const settingsPage = readFileSync(
      new URL('../web/src/sealed/SettingsPage.tsx', import.meta.url),
      'utf8',
    )
    const displayHeadings = [
      ...settingsPage.matchAll(/<h2 className="([^"]*)"/g),
    ].map(match => match[1])
    expect(displayHeadings.length).toBeGreaterThanOrEqual(2)
    for (const className of displayHeadings)
      expect(className).toContain('text-[26px]')
    expect(stylesheet).not.toContain('.settings-heading h2')
    expect(stylesheet).not.toContain('.about-pane h2')
  })

  it('balances heading line breaks', () => {
    const headingReset = /h1,\s*h2,\s*h3,\s*h4\s*\{([^}]+)\}/.exec(stylesheet)
    expect(headingReset?.[1]).toContain('text-wrap: balance;')
  })

  it('gives display and title steps compact line heights', () => {
    for (const selector of [
      '.page-header h1',
      '.conversation-welcome h2',
      '.setup-body h1',
      '.access-page h1',
    ]) {
      expect(declarationOf(selector, 'line-height'), selector).toBe('1.2')
    }
    for (const selector of ['.drawer-header h2', '.empty-capability h2']) {
      expect(declarationOf(selector, 'line-height'), selector).toBe('1.25')
    }
    const settingsPage = readFileSync(
      new URL('../web/src/sealed/SettingsPage.tsx', import.meta.url),
      'utf8',
    )
    for (const className of [
      ...settingsPage.matchAll(/<h2 className="([^"]*)"/g),
    ].map(match => match[1]))
      expect(className).toContain('leading-[1.2]')
    expect(settingsPage).toMatch(
      /<h1 className="[^"]*text-\[20px\][^"]*leading-\[1\.25\]/,
    )
    expect(settingsPage).toContain('[&_strong]:leading-[1.25]')
    expect(stylesheet).not.toContain('.settings-nav-title h1')
    expect(stylesheet).not.toContain('.usage-metrics strong')
  })

  it('maps tracking to font size steps consistently', () => {
    for (const selector of [
      '.page-header h1',
      '.conversation-welcome h2',
      '.setup-body h1',
      '.access-page h1',
    ]) {
      expect(declarationOf(selector, 'letter-spacing'), selector).toBe(
        '-0.03em',
      )
    }
    for (const selector of ['.drawer-header h2', '.empty-capability h2']) {
      expect(declarationOf(selector, 'letter-spacing'), selector).toBe(
        '-0.02em',
      )
    }
    const settingsPage = readFileSync(
      new URL('../web/src/sealed/SettingsPage.tsx', import.meta.url),
      'utf8',
    )
    for (const className of [
      ...settingsPage.matchAll(/<h2 className="([^"]*)"/g),
    ].map(match => match[1]))
      expect(className).toContain('tracking-[-0.03em]')
    expect(settingsPage).toMatch(/<h1 className="[^"]*tracking-\[-0\.02em\]/)
    expect(settingsPage).toMatch(
      /<h3 className="[^"]*text-\[20px\][^"]*tracking-\[-0\.02em\]/,
    )
    expect(stylesheet).not.toContain('.provider-detail > header h3')
  })

  it('drops the dead serif file-preview block', () => {
    expect(stylesheet).not.toContain('.file-preview')
    expect(stylesheet).not.toContain('ui-serif')
  })

  it('removes decorative count and position pills', () => {
    expect(stylesheet).not.toContain('.provider-detail h4 b')
    expect(stylesheet).not.toContain('.composer-queue-position')
  })

  it('removes the drawer eyebrow and the tinted state-hero block', () => {
    expect(stylesheet).not.toContain('.drawer-header small')
    expect(stylesheet).not.toContain('.state-hero ')
    expect(stylesheet).not.toContain('.state-失败')
    expect(stylesheet).not.toContain('.state-待确认')
    expect(stylesheet).not.toContain('.state-已完成 {')
  })

  it('keeps markdown headings at the surrounding card scale', () => {
    for (const selector of [
      '.message-markdown h1',
      '.message-markdown h2',
      '.message-markdown h3',
      '.message-markdown h4',
    ]) {
      expect(fontSizeOf(selector), selector).toBe('inherit')
    }
  })

  it('lets the drawer summary column shrink so wide code blocks scroll inside the card', () => {
    const conversationBui = readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        'web',
        'src',
        'sealed',
        'ConversationBui.tsx',
      ),
      'utf8',
    )
    expect(conversationBui).toContain('bui-state-header')
    expect(declarationOf('.message-markdown', 'min-width')).toBe('0')
    expect(declarationOf('.message-markdown pre', 'max-width')).toBe('100%')
    expect(declarationOf('.message-markdown table', 'overflow-x')).toBe('auto')
  })

  it('caps drawer grid tracks so long timeline lines cannot widen the panel', () => {
    for (const selector of [
      '.drawer-timeline',
      '.activity-timeline',
      '.activity-batch-items',
    ]) {
      expect(declarationOf(selector, 'grid-template-columns'), selector).toBe(
        'minmax(0, 1fr)',
      )
    }
    expect(declarationOf('.drawer-timeline li', 'min-width')).toBe('0')
  })
})
