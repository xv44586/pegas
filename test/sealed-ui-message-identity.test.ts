import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  resolve(import.meta.dirname, '..', 'web', 'src', 'sealed-ui.css'),
  'utf8',
)
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
const mainPages = readFileSync(
  resolve(import.meta.dirname, '..', 'web', 'src', 'sealed', 'MainPages.tsx'),
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

  it('styles the icon status slot and derived trigger from BUI utilities', () => {
    expect(conversationBui).toContain('h-[22px]')
    expect(conversationBui).toContain(
      "accent\n          ? 'text-accent-ink hover:bg-accent-tint'\n          : 'text-ink-3 hover:bg-hover-2 hover:text-ink'",
    )
    expect(mainPages).toContain(
      'message-status-icon is-failed inline-flex h-[22px] w-5 items-center justify-center text-red-text',
    )
    expect(mainPages).toContain(
      'message-derived-count text-[11px] font-medium leading-none',
    )
    expect(stylesheet).not.toContain('.message-status-icon')
    expect(stylesheet).not.toContain('.message-derived-trigger')
    expect(stylesheet).not.toContain('.message-action')
    expect(stylesheet).not.toContain('.message-delivery')
    expect(stylesheet).not.toContain('.is-derived-jump')
  })

  it('opens the multi-task menu below the trigger inside the scroll area', () => {
    expect(mainPages).toContain(
      'message-derived-menu bui absolute right-0 top-[calc(100%+6px)] z-20 flex min-w-[250px] flex-col rounded-card bg-surface p-1 shadow-overlay',
    )
    expect(mainPages).toContain(
      'rounded-control px-2.5 py-2 text-left text-[13px] text-ink',
    )
    expect(stylesheet).not.toContain('.message-derived-menu')
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

  it('sizes the rail to the BUI sidebar and follows its collapsed width', () => {
    expect(declarationOf('.app-shell', 'grid-template-columns')).toBe(
      '224px minmax(0, 1fr)',
    )
    expect(
      declarationOf(
        ".app-shell:has([data-sidebar-collapsed='true'])",
        'grid-template-columns',
      ),
    ).toBe('52px minmax(0, 1fr)')
    expect(declarationOf('.primary-rail', 'padding')).toBe('10px 0 12px')
    expect(declarationOf('.primary-rail', 'overflow')).toBe('hidden')
    expect(stylesheet).not.toContain('.primary-nav')
    expect(stylesheet).not.toContain('.recent-work')
    expect(stylesheet).not.toContain('.rail-settings')
    expect(stylesheet).not.toMatch(/\.nav-item\b/)
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
