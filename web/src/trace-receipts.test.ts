import { afterEach, expect, it, vi } from 'vitest'
import { PegasApi } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('does not replay acknowledged browser receipts across unchanged large snapshots', async () => {
  const sent: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((_: string, options: RequestInit) => {
      if (typeof options.body !== 'string')
        throw new Error('Receipt request must send a JSON string')
      const { receipts } = JSON.parse(options.body) as {
        receipts: { messageId: string }[]
      }
      sent.push(...receipts.map(receipt => receipt.messageId))
      return Promise.resolve(
        Response.json({ recorded: receipts.map(() => true) }),
      )
    }),
  )
  const api = new PegasApi('owner')
  const receipts = Array.from({ length: 2_001 }, (_, index) => ({
    phase: 'fetched' as const,
    messageId: `result-${String(index)}`,
  }))
  await api.recordTraceReceipts(receipts)
  expect(sent).toHaveLength(2_001)
  await api.recordTraceReceipts(receipts)
  await api.recordTraceReceipts([
    ...receipts,
    { phase: 'fetched', messageId: 'new-result' },
  ])
  expect(sent).toHaveLength(2_002)
  expect(sent.at(-1)).toBe('new-result')
})
