// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App, formatRelativeTime } from './App'

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('Pegas web app', () => {
  it('presents conversation as the primary entry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input
        if (path.startsWith('/v1/events'))
          return Promise.resolve(Response.json({ events: [] }))
        if (path.startsWith('/v1/tasks'))
          return Promise.resolve(Response.json({ tasks: [] }))
        if (path.startsWith('/v1/runs'))
          return Promise.resolve(Response.json({ runs: [] }))
        return Promise.resolve(Response.json({ messages: [] }))
      }),
    )

    render(<App />)

    expect(
      await screen.findByRole('heading', { name: '和 Pegas 说点什么' }),
    ).toBeTruthy()
    expect(screen.getByLabelText('告诉 Pegas 你想完成什么')).toBeTruthy()
    expect(
      screen.getByRole('complementary', { name: '任务工作台' }),
    ).toBeTruthy()
  })

  it('formats recent updates in conversational language', () => {
    const now = new Date('2026-11-16T10:00:00.000Z').getTime()
    expect(formatRelativeTime('2026-11-16T09:58:00.000Z', now)).toBe('2分钟前')
  })
})
