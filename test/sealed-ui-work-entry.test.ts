import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  resolve(import.meta.dirname, '..', 'web', 'src', 'sealed-ui.css'),
  'utf8',
)
const mainPages = readFileSync(
  resolve(import.meta.dirname, '..', 'web', 'src', 'sealed', 'MainPages.tsx'),
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

describe('sealed UI unified work entry (DESIGN-008)', () => {
  it('renders the work entry as the same quiet icon slot as the derived trigger', () => {
    expect(conversationBui).toContain('className="message-work-entry"')
    expect(conversationBui).toContain(
      'inline-flex h-[22px] items-center justify-center gap-[3px] rounded-[7px] px-1',
    )
    expect(conversationBui).toContain("'text-accent-ink hover:bg-accent-tint'")
    expect(stylesheet).not.toContain('.message-work-entry {')
  })

  it('keeps the meta row visible whenever a work entry lives there', () => {
    expect(
      declarationOf('.message-row.has-work-entry .message-meta', 'opacity'),
    ).toBe('1')
  })

  it('keeps always-visible meta text on the contrast-safe muted token', () => {
    expect(declarationOf('.message-meta', 'color')).toBe('var(--muted)')
  })

  it('converges fact-card body line height onto the card-body contract', () => {
    expect(mainPages).toContain(
      'fact-card-body mt-2 grid min-w-0 justify-items-start gap-1 text-[13px] leading-[1.6] text-ink-2',
    )
    expect(stylesheet).not.toContain('.fact-card {')
    expect(mainPages).toContain(
      'mt-3.5 grid w-full max-w-[560px] min-w-0 gap-2.5 rounded-card bg-surface p-3.5 shadow-card',
    )
  })

  it('caps markdown emphasis at weight 500 across chat and cards', () => {
    expect(declarationOf('.message-markdown strong', 'font-weight')).toBe('500')
    expect(declarationOf('.message-markdown b', 'font-weight')).toBe('500')
  })

  it('never renders the legacy big blue say link or the in-card work button', () => {
    expect(mainPages).not.toContain('查看工作详情 <ArrowRight')
    expect(mainPages).not.toContain(
      "{message.review ? '审查交付' : '查看工作详情'}",
    )
    expect(mainPages).not.toContain('查看进展')
  })

  it('separates the origin anchor icon from the work-entry link icon', () => {
    expect(mainPages).toContain('<ArrowUpToLine size={14} />')
    const originBlock = mainPages.slice(
      mainPages.indexOf('aria-label="回到发起消息"'),
      mainPages.indexOf('fact-card-body'),
    )
    expect(originBlock).toContain('ArrowUpToLine')
    expect(originBlock).not.toContain('Link2')
  })
})
