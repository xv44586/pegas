// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownMessage } from './MarkdownMessage'
import { isVisualDiffUrl } from './VisualDiffImage'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})
const path = '/v1/runs/run-1/visual-diff?userId=owner'

function stubUrls() {
  const create = vi.fn(() => 'blob:visual-diff')
  const revoke = vi.fn()
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, {
      createObjectURL: create,
      revokeObjectURL: revoke,
    }),
  )
  return { create, revoke }
}

describe('NOTIFY-007 authenticated SVG report preview', () => {
  it('uses authenticated image isolation and provides the actual SVG download', async () => {
    const urls = stubUrls()
    sessionStorage.setItem('pegas-token', 'test-token')
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response('<svg/>', {
          headers: { 'content-type': 'image/svg+xml' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetch)
    const { unmount, container } = render(
      <MarkdownMessage content={`正文\n\n![代码变更流程图](${path})`} />,
    )
    expect(
      await screen.findByRole('img', { name: '代码变更流程图' }),
    ).toHaveProperty('src', 'blob:visual-diff')
    expect(fetch).toHaveBeenCalledWith(
      path,
      expect.objectContaining({
        headers: {
          'x-pegas-local-web': '1',
          authorization: 'Bearer test-token',
        },
      }),
    )
    expect(
      screen
        .getByRole('link', { name: '下载动态 SVG' })
        .getAttribute('download'),
    ).toBe('pegas-visual-diff.svg')
    expect(container.querySelector('object, iframe, svg')).toBeNull()
    unmount()
    expect(urls.revoke).toHaveBeenCalledWith('blob:visual-diff')
  })

  it('preserves prose and retries a failed or wrong-content response', async () => {
    stubUrls()
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad', { status: 403 }))
      .mockResolvedValueOnce(
        new Response('html', { headers: { 'content-type': 'text/html' } }),
      )
      .mockResolvedValue(
        new Response('<svg/>', {
          headers: { 'content-type': 'image/svg+xml' },
        }),
      )
    vi.stubGlobal('fetch', fetch)
    render(<MarkdownMessage content={`文字结果\n\n![变更图](${path})`} />)
    expect(await screen.findByText(/文字汇报不受影响/)).toBeTruthy()
    expect(screen.getByText('文字结果')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试流程图' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    fireEvent.click(await screen.findByRole('button', { name: '重试流程图' }))
    expect(await screen.findByRole('img', { name: '变更图' })).toBeTruthy()
  })

  it('does not send credentials to arbitrary image URLs or obsolete content after unmount', async () => {
    const urls = stubUrls()
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response('<svg/>', {
          headers: { 'content-type': 'image/svg+xml' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetch)
    for (const src of [
      'https://evil.test/v1/runs/r/visual-diff?userId=owner',
      '//evil.test/a',
      '/v1/runs/r/visual-diff?userId=owner&extra=x',
    ])
      expect(isVisualDiffUrl(src)).toBe(false)
    const external = render(
      <MarkdownMessage content="![ordinary](https://example.com/a.png)" />,
    )
    expect(fetch).not.toHaveBeenCalled()
    external.unmount()
    const view = render(<MarkdownMessage content={`![变更图](${path})`} />)
    view.unmount()
    await Promise.resolve()
    await Promise.resolve()
    expect(urls.create).not.toHaveBeenCalled()
  })
})
