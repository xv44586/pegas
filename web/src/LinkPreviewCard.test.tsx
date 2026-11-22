// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearLinkPreviewCache,
  isPreviewableLink,
  LinkPreviewAnchor,
} from './LinkPreviewCard'
import { MarkdownMessage } from './MarkdownMessage'
import type { LinkPreview } from './types'

const readyPreview: LinkPreview = {
  status: 'ready',
  title: 'makecindy/cindy',
  description: '开源、开箱即用的 AI Agent。',
  image: {
    dataUrl: 'data:image/png;base64,aGVsbG8=',
    width: 1200,
    height: 600,
  },
}

beforeEach(() => {
  clearLinkPreviewCache()
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function hover(link: HTMLElement) {
  fireEvent.pointerEnter(link, { pointerType: 'mouse' })
}

function advance(ms: number) {
  return act(() => {
    vi.advanceTimersByTime(ms)
    return Promise.resolve()
  })
}

describe('CONV-005 link preview hover card', () => {
  it('opens after the hover delay and renders the OG card', async () => {
    const loader = vi.fn((url: string) =>
      Promise.resolve({
        ...readyPreview,
        title: url,
      }),
    )
    render(
      <LinkPreviewAnchor
        href="https://github.com/makecindy/cindy"
        loader={loader}
      >
        cindy
      </LinkPreviewAnchor>,
    )
    const link = screen.getByRole('link', { name: 'cindy' })
    expect(link).toHaveProperty('target', '_blank')
    hover(link)
    await advance(150)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('tooltip')).toBeNull()
    await advance(400)
    const card = screen.getByRole('tooltip')
    expect(card.textContent).toContain('github.com')
    expect(card.textContent).toContain('cindy')
    expect(card.textContent).toContain('开源、开箱即用的 AI Agent。')
    expect(card.querySelector('img.link-preview-hero')).not.toBeNull()
    expect(
      screen.getByRole('link', { name: '打开 github.com' }),
    ).toHaveProperty('href', 'https://github.com/makecindy/cindy')
    expect(link.getAttribute('aria-describedby')).toBe(card.id)
  })

  it('prefetches on interest but leaves before the open delay', async () => {
    const loader = vi.fn((url: string) =>
      Promise.resolve({
        ...readyPreview,
        title: url,
      }),
    )
    render(
      <LinkPreviewAnchor href="https://example.com/a" loader={loader}>
        a
      </LinkPreviewAnchor>,
    )
    const link = screen.getByRole('link', { name: 'a' })
    hover(link)
    await advance(200)
    fireEvent.pointerLeave(link, { pointerType: 'mouse' })
    await advance(1_000)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('closes on Escape and on pointer leave', async () => {
    const loader = vi.fn((url: string) =>
      Promise.resolve({
        ...readyPreview,
        title: url,
      }),
    )
    render(
      <LinkPreviewAnchor href="https://example.com/b" loader={loader}>
        b
      </LinkPreviewAnchor>,
    )
    const link = screen.getByRole('link', { name: 'b' })
    hover(link)
    await advance(600)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()

    hover(link)
    await advance(600)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.pointerLeave(link, { pointerType: 'mouse' })
    await advance(200)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('stays open while the pointer is inside the card', async () => {
    const loader = vi.fn((url: string) =>
      Promise.resolve({
        ...readyPreview,
        title: url,
      }),
    )
    render(
      <LinkPreviewAnchor href="https://example.com/c" loader={loader}>
        c
      </LinkPreviewAnchor>,
    )
    const link = screen.getByRole('link', { name: 'c' })
    hover(link)
    await advance(600)
    const card = screen.getByRole('tooltip')
    fireEvent.pointerLeave(link, { pointerType: 'mouse' })
    fireEvent.pointerEnter(card)
    await advance(400)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.pointerLeave(card)
    await advance(200)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens on keyboard focus and shows a header-only card when unavailable', async () => {
    const loader = vi.fn(() =>
      Promise.resolve({ status: 'unavailable' } as LinkPreview),
    )
    render(
      <LinkPreviewAnchor href="https://example.com/d" loader={loader}>
        d
      </LinkPreviewAnchor>,
    )
    const link = screen.getByRole('link', { name: 'd' })
    fireEvent.focus(link)
    await advance(600)
    const card = screen.getByRole('tooltip')
    expect(card.getAttribute('data-state')).toBe('pending')
    expect(card.textContent).toContain('example.com')
    expect(card.querySelector('.link-preview-body')).toBeNull()
  })

  it('toggles on touch without navigating on the first tap', async () => {
    const loader = vi.fn((url: string) =>
      Promise.resolve({
        ...readyPreview,
        title: url,
      }),
    )
    render(
      <LinkPreviewAnchor href="https://example.com/e" loader={loader}>
        e
      </LinkPreviewAnchor>,
    )
    const link = screen.getByRole('link', { name: 'e' })
    fireEvent.pointerUp(link, { pointerType: 'touch' })
    await advance(0)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.pointerUp(link, { pointerType: 'touch' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('caches previews across mounts and dedupes by url', async () => {
    const loader = vi.fn((url: string) =>
      Promise.resolve({
        ...readyPreview,
        title: url,
      }),
    )
    const first = render(
      <LinkPreviewAnchor href="https://example.com/f" loader={loader}>
        f
      </LinkPreviewAnchor>,
    )
    hover(screen.getByRole('link', { name: 'f' }))
    await advance(600)
    expect(loader).toHaveBeenCalledTimes(1)
    first.unmount()
    render(
      <LinkPreviewAnchor href="https://example.com/f" loader={loader}>
        f
      </LinkPreviewAnchor>,
    )
    hover(screen.getByRole('link', { name: 'f' }))
    await advance(600)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('tooltip').textContent).toContain(
      'https://example.com/f',
    )
  })

  it('never previews non-https links', () => {
    expect(isPreviewableLink('https://example.com/')).toBe(true)
    expect(isPreviewableLink('http://example.com/')).toBe(false)
    expect(isPreviewableLink('https://user:pass@example.com/')).toBe(false)
    expect(isPreviewableLink('https://example.com:8443/')).toBe(false)
    expect(isPreviewableLink(undefined)).toBe(false)
  })

  it('keeps the hover timer alive when the parent rerenders with a fresh loader', async () => {
    const loader = vi.fn((url: string) =>
      Promise.resolve({
        ...readyPreview,
        title: url,
      }),
    )
    const view = render(
      <LinkPreviewAnchor
        href="https://example.com/g"
        loader={() => loader('https://example.com/g')}
      >
        g
      </LinkPreviewAnchor>,
    )
    const link = screen.getByRole('link', { name: 'g' })
    hover(link)
    await advance(200)
    view.rerender(
      <LinkPreviewAnchor
        href="https://example.com/g"
        loader={() => loader('https://example.com/g')}
      >
        g
      </LinkPreviewAnchor>,
    )
    await advance(400)
    expect(screen.getByRole('tooltip')).toBeTruthy()
  })

  it('stays open when the card content itself scrolls', async () => {
    const loader = vi.fn((url: string) =>
      Promise.resolve({
        ...readyPreview,
        title: url,
      }),
    )
    render(
      <LinkPreviewAnchor href="https://example.com/h" loader={loader}>
        h
      </LinkPreviewAnchor>,
    )
    hover(screen.getByRole('link', { name: 'h' }))
    await advance(600)
    const card = screen.getByRole('tooltip')
    fireEvent.scroll(card.querySelector('.link-preview-body') ?? card)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.scroll(document.querySelector('.conversation-scroll') ?? window)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

describe('CONV-005 markdown link wiring', () => {
  it('renders bare urls as previewable links via remark-gfm autolinks', async () => {
    const loader = vi.fn((url: string) =>
      Promise.resolve({
        ...readyPreview,
        title: url,
      }),
    )
    render(
      <MarkdownMessage
        content="看看 https://github.com/makecindy/cindy 这个项目"
        linkPreviewLoader={loader}
      />,
    )
    const link = screen.getByRole('link', {
      name: 'https://github.com/makecindy/cindy',
    })
    hover(link)
    await advance(600)
    expect(loader).toHaveBeenCalledWith('https://github.com/makecindy/cindy')
    expect(screen.getByRole('tooltip').textContent).toContain('github.com')
  })

  it('keeps links as plain anchors without a loader', () => {
    render(<MarkdownMessage content="[docs](https://example.com/docs)" />)
    const link = screen.getByRole('link', { name: 'docs' })
    expect(link).toHaveProperty('href', 'https://example.com/docs')
    fireEvent.pointerEnter(link, { pointerType: 'mouse' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('survives markdown rerenders with a fresh loader identity', async () => {
    const loader = vi.fn((url: string) =>
      Promise.resolve({
        ...readyPreview,
        title: url,
      }),
    )
    const view = render(
      <MarkdownMessage
        content="见 https://example.com/stable"
        linkPreviewLoader={() => loader('https://example.com/stable')}
      />,
    )
    const link = screen.getByRole('link', {
      name: 'https://example.com/stable',
    })
    hover(link)
    await advance(200)
    view.rerender(
      <MarkdownMessage
        content="见 https://example.com/stable"
        linkPreviewLoader={() => loader('https://example.com/stable')}
      />,
    )
    await advance(400)
    expect(screen.getByRole('tooltip')).toBeTruthy()
  })
})
