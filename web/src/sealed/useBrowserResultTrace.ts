import { useEffect, type RefObject } from 'react'
import type { BrowserTraceReceipt } from '../../../src/observability/message-trace'
import type { PegasApi } from '../api'

interface ResultMessage {
  id: string
  role: 'user' | 'pegas'
  streaming: boolean
}

export function useBrowserResultTrace(
  api: PegasApi,
  messages: readonly ResultMessage[],
  content: RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    if (!messages.length || !content.current) return
    const tracked = messages.filter(
      message => message.role === 'pegas' && api.tracksResult(message.id),
    )
    if (!tracked.length) return
    const elements = new Map(
      Array.from(
        content.current.querySelectorAll<HTMLElement>('[data-result-trace]'),
        element => [element.dataset.resultTrace, element] as const,
      ),
    )
    const receipts: BrowserTraceReceipt[] = []
    const targets: HTMLElement[] = []
    for (const result of tracked) {
      const element = elements.get(result.id)
      if (!element) continue
      targets.push(element)
      receipts.push({ phase: 'rendered', messageId: result.id })
      if (!result.streaming)
        receipts.push({ phase: 'settled', messageId: result.id })
    }
    void api.recordTraceReceipts(receipts)

    if (!targets.length || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => {
      if (document.visibilityState !== 'visible') return
      for (const { target, isIntersecting } of entries) {
        if (
          !isIntersecting ||
          !(target instanceof HTMLElement) ||
          !target.dataset.resultTrace
        )
          continue
        void api.recordTraceReceipts([
          { phase: 'visible', messageId: target.dataset.resultTrace },
        ])
        observer.unobserve(target)
      }
    })
    const observe = () => {
      if (document.visibilityState !== 'visible') return
      observer.disconnect()
      for (const element of targets) observer.observe(element)
    }
    observe()
    document.addEventListener('visibilitychange', observe)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', observe)
    }
  }, [api, messages, content])
}
