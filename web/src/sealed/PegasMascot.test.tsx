// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { PegasMascot } from './PegasMascot'

afterEach(cleanup)

describe('PegasMascot', () => {
  it('stays decorative without a label and named with one', () => {
    const { container, rerender } = render(<PegasMascot />)
    const image = container.querySelector('img.pegas-mascot')
    expect(image?.getAttribute('aria-hidden')).toBe('true')
    expect(image?.getAttribute('alt')).toBe('')

    rerender(<PegasMascot label="Pegas 形象" />)
    const named = container.querySelector('img.pegas-mascot')
    expect(named?.getAttribute('role')).toBe('img')
    expect(named?.getAttribute('aria-label')).toBe('Pegas 形象')
  })

  it('reserves layout space with the source aspect ratio', () => {
    const { container } = render(<PegasMascot size={160} />)
    const image = container.querySelector('img.pegas-mascot')
    expect(image?.getAttribute('width')).toBe('160')
    expect(image?.getAttribute('height')).toBe('112')
    expect(image?.getAttribute('src')).toBe('/brand/pegas-mascot.webp')
  })
})
