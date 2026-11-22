import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  resolve(import.meta.dirname, '..', 'web', 'src', 'sealed-ui.css'),
  'utf8',
)

function selectorsWithGridTemplateColumns(): string[] {
  const withoutComments = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors: string[] = []
  for (const match of withoutComments.matchAll(
    /([^{}]+)\{([^{}]*grid-template-columns[^{}]*)\}/g,
  )) {
    const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ')
    if (selector && !selector.startsWith('@')) selectors.push(selector)
  }
  return selectors
}

describe('EXEC-006 run transcript layout regression', () => {
  it('never lets the run-record timeline grid leak into nested transcript rows', () => {
    // The vertical-text bug: `.progress-list li` matched transcript rows inside
    // the expanded workflow, forcing them into the 22px icon column. Timeline
    // layout rules must stay scoped to direct children of the run list.
    const leaking = selectorsWithGridTemplateColumns().filter(selector =>
      selector
        .split(',')
        .some(
          part =>
            part.trim().startsWith('.progress-list') &&
            !part.includes('> li') &&
            !part.includes('>li'),
        ),
    )
    expect(leaking).toEqual([])
  })

  it('keeps the run-record timeline layout on direct children only', () => {
    expect(stylesheet).toContain('.progress-list > li {')
    expect(stylesheet).not.toMatch(/\.progress-list li\s*\{/)
    expect(stylesheet).not.toMatch(/\.progress-list li span\s*\{/)
  })
})
