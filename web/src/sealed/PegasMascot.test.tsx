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

  it('reserves a square layout for the welcome art', () => {
    const { container } = render(<PegasMascot size={160} />)
    const image = container.querySelector('img.pegas-mascot')
    expect(image?.getAttribute('width')).toBe('160')
    expect(image?.getAttribute('height')).toBe('160')
    expect(image?.getAttribute('src')).toBe('/brand/pegas-home.svg')
  })

  it.each([
    ['waiting', 'pegas-home.svg'],
    ['celebrate', 'pegas-home.svg'],
    ['blocked', 'pegas-home.svg'],
    ['working', 'pegas-flight.svg'],
    ['speaking', 'pegas-speaking.svg'],
  ] as const)('serves the %s pose on the same canvas', (pose, file) => {
    const { container } = render(<PegasMascot pose={pose} size={96} />)
    const image = container.querySelector('img.pegas-mascot')
    expect(image?.getAttribute('src')).toBe(`/brand/${file}`)
    expect(image?.getAttribute('data-pose')).toBe(pose)
    expect(image?.getAttribute('width')).toBe('96')
    expect(image?.getAttribute('height')).toBe('96')
  })

  it.each(['working', 'speaking'] as const)(
    'selects a still image for the %s pose under reduced motion',
    pose => {
      const { container } = render(<PegasMascot pose={pose} />)
      const source = container.querySelector('picture > source')
      expect(source?.getAttribute('media')).toBe(
        '(prefers-reduced-motion: reduce)',
      )
      expect(source?.getAttribute('srcset')).toBe('/brand/pegas-home.svg')
    },
  )
})
