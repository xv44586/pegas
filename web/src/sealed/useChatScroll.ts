import { useCallback, useEffect, useRef, useState } from 'react'

const PINNED_THRESHOLD_PX = 10
const FOLLOWING_THRESHOLD_PX = 96

interface ScrollAnchor {
  element: HTMLElement
  top: number
}

export interface ChatScrollState {
  scrollRef: React.RefObject<HTMLDivElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  hasNewReplies: boolean
  announcement: string
  onScroll: () => void
  jumpToBottom: () => void
  noteNewReply: (label: string) => void
  composerRef: React.RefObject<HTMLDivElement | null>
}

export function useChatScroll(): ChatScrollState {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const followingRef = useRef(true)
  const anchorRef = useRef<ScrollAnchor | undefined>(undefined)
  const [hasNewReplies, setHasNewReplies] = useState(false)
  const [announcement, setAnnouncement] = useState('')

  const distanceFromBottom = useCallback(() => {
    const area = scrollRef.current
    if (!area) return 0
    return area.scrollHeight - area.scrollTop - area.clientHeight
  }, [])

  const captureAnchor = useCallback(() => {
    const area = scrollRef.current
    const content = contentRef.current
    if (!area || !content) return
    const areaTop = area.getBoundingClientRect().top
    for (const child of content.children) {
      if (!(child instanceof HTMLElement)) continue
      const rect = child.getBoundingClientRect()
      if (rect.bottom > areaTop + 1) {
        anchorRef.current = { element: child, top: rect.top - areaTop }
        return
      }
    }
    anchorRef.current = undefined
  }, [])

  const restoreAnchor = useCallback(() => {
    const area = scrollRef.current
    const anchor = anchorRef.current
    if (!area?.isConnected || !anchor?.element.isConnected) return
    const areaTop = area.getBoundingClientRect().top
    const currentTop = anchor.element.getBoundingClientRect().top - areaTop
    const delta = currentTop - anchor.top
    if (Math.abs(delta) > 0.5) area.scrollTop += delta
  }, [])

  const onScroll = useCallback(() => {
    const distance = distanceFromBottom()
    pinnedRef.current = distance < PINNED_THRESHOLD_PX
    followingRef.current = distance <= FOLLOWING_THRESHOLD_PX
    if (followingRef.current) setHasNewReplies(false)
    captureAnchor()
  }, [captureAnchor, distanceFromBottom])

  const jumpToBottom = useCallback(() => {
    const area = scrollRef.current
    if (!area) return
    area.scrollTop = area.scrollHeight
    pinnedRef.current = true
    followingRef.current = true
    setHasNewReplies(false)
    captureAnchor()
  }, [captureAnchor])

  const noteNewReply = useCallback((label: string) => {
    setAnnouncement(label)
    if (!followingRef.current) setHasNewReplies(true)
  }, [])

  useEffect(() => {
    const area = scrollRef.current
    const content = contentRef.current
    if (!area || !content) return
    const apply = () => {
      if (pinnedRef.current) {
        area.scrollTop = area.scrollHeight
        return
      }
      restoreAnchor()
    }
    if (typeof ResizeObserver === 'undefined') {
      apply()
      return
    }
    const observer = new ResizeObserver(() => {
      apply()
    })
    observer.observe(area)
    observer.observe(content)
    if (composerRef.current) observer.observe(composerRef.current)
    return () => {
      observer.disconnect()
    }
  }, [restoreAnchor])

  return {
    scrollRef,
    contentRef,
    composerRef,
    hasNewReplies,
    announcement,
    onScroll,
    jumpToBottom,
    noteNewReply,
  }
}
