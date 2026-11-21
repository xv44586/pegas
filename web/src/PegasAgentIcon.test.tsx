// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { PegasAgentIcon } from './PegasAgentIcon'
import type { TaskStatus } from './types'

afterEach(cleanup)

describe('PegasAgentIcon', () => {
  it.each<TaskStatus>([
    'backlog',
    'unstarted',
    'started',
    'completed',
    'cancelled',
  ])('exposes the %s state to the icon theme', status => {
    const { container } = render(
      <PegasAgentIcon iconId="computer" status={status} />,
    )

    expect(container.querySelector('.pegas-agent-avatar')?.classList).toContain(
      `status-${status}`,
    )
    expect(
      container
        .querySelector('.pegas-agent-status')
        ?.getAttribute('data-status'),
    ).toBe(status)
    expect(container.querySelector('img.pegas-agent-glyph')).toBeTruthy()
  })

  it('keeps decorative icons hidden and informative icons named', () => {
    const { container, rerender } = render(<PegasAgentIcon iconId="bot" />)
    expect(
      container
        .querySelector('.pegas-agent-avatar')
        ?.getAttribute('aria-hidden'),
    ).toBe('true')
    expect(
      container
        .querySelector('img.pegas-agent-glyph')
        ?.getAttribute('aria-hidden'),
    ).toBe('true')

    rerender(<PegasAgentIcon iconId="bot" label="Pegas" />)
    const avatar = container.querySelector('.pegas-agent-avatar')
    expect(avatar?.getAttribute('role')).toBe('img')
    expect(avatar?.getAttribute('aria-label')).toBe('Pegas')
    expect(
      container.querySelector('img.pegas-agent-glyph')?.getAttribute('role'),
    ).toBeNull()
  })

  it('renders each identity from its transparent illustration with a stable box', () => {
    const { container } = render(
      <>
        <PegasAgentIcon iconId="bot" />
        <PegasAgentIcon iconId="car" />
        <PegasAgentIcon iconId="camera" />
        <PegasAgentIcon iconId="computer" />
        <PegasAgentIcon iconId="phone" />
      </>,
    )

    const glyphs = [...container.querySelectorAll('img.pegas-agent-glyph')]
    expect(glyphs.map(glyph => glyph.getAttribute('src'))).toEqual([
      '/brand/agent-bot.webp',
      '/brand/agent-car.webp',
      '/brand/agent-camera.webp',
      '/brand/agent-computer.webp',
      '/brand/agent-phone.webp',
    ])
    for (const glyph of glyphs) {
      expect(glyph.getAttribute('width')).toBe('34')
      expect(glyph.getAttribute('height')).toBe('34')
      expect(glyph.getAttribute('alt')).toBe('')
    }
  })
})
