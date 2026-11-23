import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  resolve(import.meta.dirname, '..', 'web', 'src', 'sealed-ui.css'),
  'utf8',
)

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

describe('sealed UI quiet message identity (DESIGN-005)', () => {
  it('paints user bubbles from a neutral semantic surface token', () => {
    expect(blocksFor(':root').join('\n')).toContain(
      '--message-bubble: var(--surface);',
    )
    const background = declarationOf(
      '.message-row.is-user .message-content',
      'background',
    )
    expect(background).toBe('var(--message-bubble)')
    expect(background).not.toContain('accent')
  })

  it('keeps the bubble radius quiet with a tail corner', () => {
    expect(
      declarationOf('.message-row.is-user .message-content', 'border-radius'),
    ).toBe('18px 18px 6px 18px')
  })

  it('tints attachment metadata from muted ink instead of the canvas', () => {
    expect(declarationOf('.message-attachment', 'color')).toBe('var(--muted)')
  })

  it('keeps the user meta row always visible for status and retry', () => {
    expect(declarationOf('.message-row.is-user .message-meta', 'opacity')).toBe(
      '1',
    )
  })

  it('styles the icon status slot and derived trigger without text labels', () => {
    expect(declarationOf('.message-status-icon', 'color')).toBe('var(--muted)')
    expect(declarationOf('.message-status-icon.is-failed', 'color')).toBe(
      'var(--critical)',
    )
    expect(declarationOf('.message-derived-trigger', 'color')).toBe(
      'var(--accent-ink, var(--accent))',
    )
    expect(declarationOf('.message-derived-count', 'font-size')).toBe(
      'var(--text-tiny)',
    )
    expect(stylesheet).not.toContain('.message-delivery')
    expect(stylesheet).not.toContain('.is-derived-jump')
  })

  it('opens the multi-task menu below the trigger inside the scroll area', () => {
    expect(declarationOf('.message-derived-menu', 'top')).toBe(
      'calc(100% + 6px)',
    )
    expect(declarationOf('.message-derived-menu', 'position')).toBe('absolute')
    expect(declarationOf('.message-derived-menu button', 'font-size')).toBe(
      'var(--text-caption)',
    )
  })

  it('gives the conversation a compact single-line header without a tagline', () => {
    expect(
      declarationOf('.conversation-page .page-header', 'align-items'),
    ).toBe('center')
    expect(
      declarationOf('.conversation-page .page-header', 'border-bottom'),
    ).toBe('1px solid var(--line)')
    expect(
      declarationOf('.conversation-page .page-header h1', 'font-size'),
    ).toBe('var(--text-read)')
    expect(
      declarationOf('.conversation-page .page-header h1', 'font-weight'),
    ).toBe('500')
    expect(
      declarationOf('.conversation-page .page-header h1', 'letter-spacing'),
    ).toBe('0')
  })

  it('narrows the rail so the conversation keeps more width', () => {
    expect(declarationOf('.app-shell', 'grid-template-columns')).toBe(
      '232px minmax(0, 1fr)',
    )
  })

  it('converges the rail brand onto the read step at weight 500', () => {
    expect(declarationOf('.brand-lockup strong', 'font-size')).toBe(
      'var(--text-read)',
    )
    expect(declarationOf('.brand-lockup strong', 'font-weight')).toBe('500')
    expect(declarationOf('.brand-lockup strong', 'letter-spacing')).toBe('0')
    expect(declarationOf('.brand-lockup span', 'font-size')).toBe(
      'var(--text-tiny)',
    )
  })
})
