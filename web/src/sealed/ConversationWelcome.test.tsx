// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PegasApi } from '../api'
import type { Snapshot } from '../types'
import { ConversationPage } from './MainPages'

afterEach(cleanup)

const emptySnapshot: Snapshot = {
  events: [],
  messages: [],
  runs: [],
  channels: [],
}

function renderWelcome() {
  const api = {
    sendMessage: vi.fn(() => Promise.resolve()),
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
      draft=""
      models={[]}
      onClearContinuation={() => undefined}
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
    expect(welcome?.querySelector('img.pegas-mascot')).toBeTruthy()
    expect(welcome?.querySelector('svg')).toBeNull()
    expect(welcome?.textContent).toContain('今天想一起完成什么？')
  })
})
