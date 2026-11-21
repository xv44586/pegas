// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { PegasMark } from './PegasMark'

afterEach(cleanup)

describe('PegasMark', () => {
  it('renders the transparent mascot illustration instead of the flat vector face', () => {
    const { container } = render(<PegasMark size={42} />)
    const mark = container.querySelector('img.pegas-mark')
    expect(mark?.getAttribute('src')).toBe('/brand/agent-bot.webp')
    expect(mark?.getAttribute('width')).toBe('42')
    expect(mark?.getAttribute('height')).toBe('42')
    expect(mark?.getAttribute('aria-hidden')).toBe('true')
    expect(mark?.getAttribute('alt')).toBe('')
    expect(container.querySelector('svg.pegas-mark')).toBeNull()
  })
})
