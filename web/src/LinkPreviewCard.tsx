import { Globe, SquareArrowOutUpRight } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

import type { LinkPreview } from './types'

export type LinkPreviewLoader = (url: string) => Promise<LinkPreview>

export const LinkPreviewLoaderContext = createContext<
  LinkPreviewLoader | undefined
>(undefined)

const openDelayMs = 500
const prefetchDelayMs = 150
const closeDelayMs = 150
const readyCacheTtlMs = 5 * 60_000
const otherCacheTtlMs = 30_000
const maximumCacheEntries = 64
const cardWidth = 360

interface CacheEntry {
  value?: LinkPreview
  pending?: Promise<LinkPreview>
  expiresAt: number
}

const previewCache = new Map<string, CacheEntry>()

export function clearLinkPreviewCache(): void {
  previewCache.clear()
}

export function isPreviewableLink(href: string | undefined): href is string {
  if (!href || !URL.canParse(href)) return false
  const url = new URL(href)
  return (
    url.protocol === 'https:' && !url.username && !url.password && !url.port
  )
}

function loadPreview(
  loader: LinkPreviewLoader,
  href: string,
): Promise<LinkPreview> | LinkPreview | undefined {
  const cached = previewCache.get(href)
  if (cached) {
    if (cached.value && cached.expiresAt > Date.now()) return cached.value
    if (cached.pending) return cached.pending
    previewCache.delete(href)
  }
  const pending = loader(href)
    .catch((): LinkPreview => ({ status: 'unavailable' }))
    .then(value => {
      const entry = previewCache.get(href)
      if (entry?.pending === pending) {
        entry.value = value
        entry.pending = undefined
        entry.expiresAt =
          Date.now() +
          (value.status === 'ready' && value.image
            ? readyCacheTtlMs
            : otherCacheTtlMs)
      }
      return value
    })
  previewCache.set(href, { pending, expiresAt: 0 })
  while (previewCache.size > maximumCacheEntries) {
    const oldest = previewCache.keys().next().value
    if (oldest === undefined) break
    previewCache.delete(oldest)
  }
  return pending
}

interface CardPlacement {
  top: number
  left: number
}

function placeCard(anchor: HTMLElement): CardPlacement {
  const rect = anchor.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const width = Math.min(cardWidth, viewportWidth - 16)
  const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8))
  const estimatedHeight = 280
  const below = rect.bottom + 6
  const top =
    below + estimatedHeight > viewportHeight - 8 &&
    rect.top - estimatedHeight - 6 > 8
      ? Math.max(8, rect.top - estimatedHeight - 6)
      : below
  return { top, left }
}

export function LinkPreviewAnchor({
  href,
  loader,
  children,
}: {
  href: string
  loader?: LinkPreviewLoader
  children: ReactNode
}) {
  const anchorRef = useRef<HTMLAnchorElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<LinkPreview>()
  const [placement, setPlacement] = useState<CardPlacement>()
  const [failedImage, setFailedImage] = useState<string>()
  const cardId = useId()
  const contextLoader = useContext(LinkPreviewLoaderContext)
  const activeLoader = loader ?? contextLoader
  const previewable = Boolean(activeLoader) && isPreviewableLink(href)
  const loaderRef = useRef(activeLoader)
  loaderRef.current = activeLoader

  const timersRef = useRef({
    open: undefined as ReturnType<typeof setTimeout> | undefined,
    prefetch: undefined as ReturnType<typeof setTimeout> | undefined,
    close: undefined as ReturnType<typeof setTimeout> | undefined,
  })
  const cancelTimers = useCallback(() => {
    const timers = timersRef.current
    clearTimeout(timers.open)
    clearTimeout(timers.prefetch)
    clearTimeout(timers.close)
  }, [])

  const close = useCallback(() => {
    cancelTimers()
    setOpen(false)
    setPlacement(undefined)
  }, [cancelTimers])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      clearTimeout(timers.open)
      clearTimeout(timers.prefetch)
      clearTimeout(timers.close)
    }
  }, [])

  const requestPreview = useCallback(() => {
    const activeLoader = loaderRef.current
    if (!activeLoader || !isPreviewableLink(href)) return
    const result = loadPreview(activeLoader, href)
    if (!result) return
    if (result instanceof Promise) {
      void result.then(value => {
        setPreview(current => (current === value ? current : value))
      })
    } else {
      setPreview(result)
    }
  }, [href])

  const show = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    setPlacement(placeCard(anchor))
    setOpen(true)
    requestPreview()
  }, [requestPreview])

  const scheduleOpen = useCallback(
    (delay: number) => {
      if (!previewable) return
      const timers = timersRef.current
      clearTimeout(timers.close)
      clearTimeout(timers.prefetch)
      timers.prefetch = setTimeout(requestPreview, prefetchDelayMs)
      clearTimeout(timers.open)
      timers.open = setTimeout(show, delay)
    },
    [previewable, requestPreview, show],
  )

  const scheduleClose = useCallback(() => {
    const timers = timersRef.current
    clearTimeout(timers.open)
    clearTimeout(timers.close)
    timers.close = setTimeout(close, closeDelayMs)
  }, [close])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const onScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Node && cardRef.current?.contains(target)) return
      close()
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open, close])

  const hostname = URL.canParse(href) ? new URL(href).hostname : href
  const image =
    preview?.status === 'ready' && preview.image?.dataUrl !== failedImage
      ? preview.image
      : null
  const compactImage = image !== null && image.width / image.height < 1.2
  const hasBody =
    preview?.status === 'ready' &&
    Boolean(preview.title ?? preview.description ?? image)

  return (
    <>
      <a
        aria-describedby={open ? cardId : undefined}
        href={href}
        onBlur={event => {
          if (!cardRef.current?.contains(event.relatedTarget)) scheduleClose()
        }}
        onClick={() => close()}
        onFocus={() => scheduleOpen(openDelayMs)}
        onPointerEnter={event => {
          if (event.pointerType === 'touch') return
          scheduleOpen(openDelayMs)
        }}
        onPointerLeave={event => {
          if (event.pointerType === 'touch') return
          scheduleClose()
        }}
        onPointerUp={event => {
          if (event.pointerType !== 'touch') return
          event.preventDefault()
          if (open) close()
          else show()
        }}
        ref={anchorRef}
        rel="noreferrer noopener"
        target="_blank"
      >
        {children}
      </a>
      {open &&
        placement &&
        createPortal(
          <div
            className="link-preview-card"
            data-state={hasBody ? 'ready' : 'pending'}
            id={cardId}
            onBlur={event => {
              if (
                !event.currentTarget.contains(event.relatedTarget) &&
                event.relatedTarget !== anchorRef.current
              )
                scheduleClose()
            }}
            onPointerEnter={() => clearTimeout(timersRef.current.close)}
            onPointerLeave={scheduleClose}
            ref={cardRef}
            role="tooltip"
            style={{
              top: placement.top,
              left: placement.left,
              maxWidth: `min(${String(cardWidth)}px, calc(100vw - 16px))`,
            }}
          >
            <div className="link-preview-head">
              <Globe aria-hidden size={15} />
              <span className="link-preview-host">{hostname}</span>
              <a
                aria-label={`打开 ${hostname}`}
                className="link-preview-open"
                href={href}
                rel="noreferrer noopener"
                target="_blank"
              >
                打开
                <SquareArrowOutUpRight aria-hidden size={13} />
              </a>
            </div>
            {preview?.status === 'ready' && hasBody && (
              <div className="link-preview-body">
                {image && !compactImage && (
                  <img
                    alt=""
                    className="link-preview-hero"
                    draggable={false}
                    height={image.height}
                    onError={() => setFailedImage(image.dataUrl)}
                    src={image.dataUrl}
                    width={image.width}
                  />
                )}
                {(preview.title ?? preview.description ?? compactImage) && (
                  <div className="link-preview-text">
                    {image && compactImage && (
                      <img
                        alt=""
                        className="link-preview-thumb"
                        draggable={false}
                        height={image.height}
                        onError={() => setFailedImage(image.dataUrl)}
                        src={image.dataUrl}
                        width={image.width}
                      />
                    )}
                    <div className="link-preview-lines">
                      {preview.title && <h3>{preview.title}</h3>}
                      {preview.description && <p>{preview.description}</p>}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
