// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PegasApi } from '../api'
import type { Snapshot } from '../types'
import { AttentionPage, ConversationPage } from './MainPages'

afterEach(cleanup)

const emptySnapshot: Snapshot = {
  events: [],
  messages: [],
  runs: [],
  channels: [],
}

function renderWelcome(options?: {
  draft?: string
  sendMessage?: () => Promise<void>
}) {
  const api = {
    sendMessage: options?.sendMessage ?? vi.fn(() => Promise.resolve()),
    transcribeVoice: vi.fn(() => Promise.resolve('')),
  } as unknown as PegasApi
  return render(
    <ConversationPage
      actions={{
        onSearch: () => undefined,
        onToggleAppearance: () => undefined,
        isDark: false,
        onOpenDrawer: () => undefined,
      }}
      api={api}
      continuationChannel={undefined}
      draft={options?.draft ?? ''}
      models={[]}
      onAnswerClarification={() => undefined}
      onOpenAttention={() => Promise.resolve()}
      onSelectTask={() => undefined}
      onClearContinuation={() => undefined}
      onClearSourceContext={() => undefined}
      onConfigureVoice={() => undefined}
      onDraftChange={() => undefined}
      onSelectModel={() => Promise.resolve()}
      onSent={() => Promise.resolve()}
      snapshot={emptySnapshot}
      speechEnabled={false}
    />,
  )
}

describe('conversation welcome', () => {
  it('shows the Pegas mascot instead of a generic sparkle icon', () => {
    const { container } = renderWelcome()
    const welcome = container.querySelector('.conversation-welcome')
    expect(
      welcome?.querySelector('img.pegas-mascot')?.getAttribute('src'),
    ).toBe('/brand/pegas-home.svg')
    expect(welcome?.querySelector('svg')).toBeNull()
    expect(welcome?.textContent).toContain('今天想一起完成什么？')
  })

  it('shows the waiting pose while a message is being sent', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const { container } = renderWelcome({
      draft: '帮我整理下周计划',
      sendMessage: () => gate,
    })
    const sendButton = container.querySelector('button[aria-label="发送"]')
    expect(sendButton).toBeTruthy()
    fireEvent.click(sendButton as HTMLButtonElement)
    const working = await waitFor(() => {
      const element = container.querySelector('.composer-working')
      expect(element).toBeTruthy()
      return element
    })
    expect(
      working?.querySelector('img[data-pose="waiting"]')?.getAttribute('src'),
    ).toBe('/brand/pegas-home.svg')
    expect(working?.textContent).toContain('正在整理')
    release?.()
    await waitFor(() =>
      expect(container.querySelector('.composer-working')).toBeNull(),
    )
  })
})

describe('attention empty state', () => {
  it('celebrates with the mascot when nothing needs the user', () => {
    const { container } = render(
      <AttentionPage
        actions={{
          onSearch: () => undefined,
          onToggleAppearance: () => undefined,
          isDark: false,
          onOpenDrawer: () => undefined,
        }}
        onOpen={() => Promise.resolve()}
        snapshot={emptySnapshot}
      />,
    )
    const empty = container.querySelector('.empty-capability')
    expect(empty?.querySelector('img[data-pose="celebrate"]')).toBeTruthy()
    expect(empty?.textContent).toContain('现在没有待处理项')
  })
})
