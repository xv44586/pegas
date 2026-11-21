// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { PegasMark } from './PegasMark'

afterEach(cleanup)

describe('PegasMark', () => {
  it('renders the mascot face tile instead of the old abstract swoosh', () => {
    const { container } = render(<PegasMark size={42} />)
    const svg = container.querySelector('svg.pegas-mark')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 64 64')
    expect(svg?.querySelector('rect[fill="currentColor"]')).toBeTruthy()
    expect(svg?.querySelector('rect[fill="#181818"]')).toBeTruthy()
    expect(svg?.querySelectorAll('circle[fill="#7defff"]').length).toBe(2)
    expect(svg?.innerHTML).not.toContain('M6.2 30.8')
  })
})
