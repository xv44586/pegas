// @vitest-environment jsdom

import '../test-env'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InlineReply } from './InlineReply'

afterEach(cleanup)

const base = {
  items: ['分析收入'],
  taskTitle: '季度报告',
  excerpt: '本季度收入增长',
}

describe('reply-local submission recovery', () => {
  it('blocks rapid clicks and accepted duplicates even when refreshing fails', async () => {
    let accept: (() => void) | undefined
    const send = vi.fn(
      () =>
        new Promise<void>(resolve => {
          accept = resolve
        }),
    )
    const refresh = vi.fn().mockRejectedValue(new Error('offline'))
    render(<InlineReply {...base} onSend={send} onRefresh={refresh} />)
    const candidate = screen.getByRole('button', { name: '分析收入' })
    fireEvent.click(candidate)
    fireEvent.click(candidate)
    expect(send).toHaveBeenCalledTimes(1)
    await act(async () => {
      accept?.()
      await Promise.resolve()
    })
    expect(
      await screen.findByText('已发送，列表刷新暂时失败，请稍后刷新。'),
    ).toBeTruthy()
    fireEvent.click(candidate)
    expect(send).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '重试发送' })).toBeNull()
  })

  it('keeps custom drafts and retries the original request key after failure', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined)
    render(
      <InlineReply
        {...base}
        onSend={send}
        onRefresh={() => Promise.resolve()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '快速回复' }))
    const editor = screen.getByRole('textbox', { name: '回复内容' })
    fireEvent.change(editor, { target: { value: '解释复购率' } })
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 })
    expect(send).not.toHaveBeenCalled()
    fireEvent.keyDown(editor, { key: 'Enter' })
    await screen.findByText('offline')
    expect(editor).toHaveProperty('value', '解释复购率')
    fireEvent.click(screen.getByRole('button', { name: '重试发送' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1])
    await waitFor(() => expect(editor).toHaveProperty('value', ''))
  })

  it('preserves separate reply drafts across polling and suggestion sends', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const props = { ...base, onSend: send, onRefresh: () => Promise.resolve() }
    const { rerender } = render(<InlineReply {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '快速回复' }))
    const editor = screen.getByRole('textbox', { name: '回复内容' })
    fireEvent.change(editor, { target: { value: '还没写完' } })
    rerender(<InlineReply {...props} items={[...base.items]} />)
    fireEvent.click(screen.getByRole('button', { name: '分析收入' }))
    await screen.findByText('已发送到对应事情')
    expect(editor).toHaveProperty('value', '还没写完')
  })
  it('keeps a local draft visible but disables submission when its task stops', () => {
    const send = vi.fn()
    const props = { ...base, onSend: send, onRefresh: () => Promise.resolve() }
    const { rerender } = render(<InlineReply {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '快速回复' }))
    const editor = screen.getByRole('textbox', { name: '回复内容' })
    fireEvent.change(editor, { target: { value: '保留这条追问' } })
    rerender(<InlineReply {...props} disabledReason="事情已停止" />)
    expect(editor).toHaveProperty('value', '保留这条追问')
    expect(editor).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '分析收入' }))
    fireEvent.click(screen.getByRole('button', { name: '发送回复' }))
    expect(send).not.toHaveBeenCalled()
  })
})
