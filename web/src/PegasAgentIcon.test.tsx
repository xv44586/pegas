// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { PegasAgentIcon, PegasAgentSprite } from './PegasAgentIcon'
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
    expect(container.querySelector('.pegas-agent-glyph')).toBeTruthy()
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
        .querySelector('svg.pegas-agent-glyph')
        ?.getAttribute('aria-hidden'),
    ).toBe('true')

    rerender(<PegasAgentIcon iconId="bot" label="Pegas" />)
    const avatar = container.querySelector('.pegas-agent-avatar')
    expect(avatar?.getAttribute('role')).toBe('img')
    expect(avatar?.getAttribute('aria-label')).toBe('Pegas')
    expect(
      container.querySelector('svg.pegas-agent-glyph')?.getAttribute('role'),
    ).toBeNull()
  })

  it('inlines the sprite once so first paint never waits on a fetch', () => {
    const { container } = render(
      <>
        <PegasAgentSprite />
        <PegasAgentIcon iconId="bot" />
        <PegasAgentIcon iconId="car" />
        <PegasAgentIcon iconId="camera" />
      </>,
    )

    const sprites = container.querySelectorAll('.pegas-agent-sprite')
    expect(sprites.length).toBe(1)
    const sprite = sprites[0]
    for (const iconId of ['bot', 'car', 'camera', 'computer', 'phone']) {
      expect(sprite?.querySelector(`#pegas-agent-${iconId}`)).toBeTruthy()
    }
    const uses = [...container.querySelectorAll('use')]
    expect(uses.map(use => use.getAttribute('href'))).toEqual([
      '#pegas-agent-bot',
      '#pegas-agent-car',
      '#pegas-agent-camera',
    ])
    expect(uses.every(use => !use.getAttribute('href')?.includes('.svg'))).toBe(
      true,
    )
  })
})
