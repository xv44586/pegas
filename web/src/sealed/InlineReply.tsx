import { useId, useRef, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import { Button, FollowUpList, TextArea } from '@bui/index'

/** One reply owns its target, draft, request and retry key throughout polling. */
export function InlineReply({
  items,
  taskTitle,
  excerpt,
  disabledReason,
  onSend,
  onRefresh,
}: {
  items: readonly string[]
  taskTitle?: string
  excerpt: string
  disabledReason?: string
  onSend: (text: string, dedupeKey: string) => Promise<void>
  onRefresh: () => Promise<void>
}) {
  const id = useId()
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const busyRef = useRef(false)
  const composingRef = useRef(false)
  const attemptRef = useRef<{ text: string; dedupeKey: string } | undefined>(
    undefined,
  )
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [sentItems, setSentItems] = useState<string[]>([])
  const context = taskTitle ? `发送到「${taskTitle}」` : '回复这条消息'

  async function send(text: string, candidate = false) {
    text = text.trim()
    if (
      !text ||
      disabledReason ||
      busyRef.current ||
      (candidate && sentItems.includes(text))
    )
      return
    busyRef.current = true
    setPending(true)
    setError('')
    setNotice('')
    const attempt =
      attemptRef.current?.text === text
        ? attemptRef.current
        : { text, dedupeKey: crypto.randomUUID() }
    attemptRef.current = attempt
    try {
      await onSend(text, attempt.dedupeKey)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '发送失败，请重试。')
      setExpanded(true)
      setPending(false)
      busyRef.current = false
      return
    }
    attemptRef.current = undefined
    setSentItems(current => [...current, text])
    if (!candidate)
      setDraft(current => (current.trim() === text ? '' : current))
    setNotice('已发送到对应事情')
    try {
      await onRefresh()
    } catch {
      setNotice('已发送，列表刷新暂时失败，请稍后刷新。')
    } finally {
      setPending(false)
      busyRef.current = false
    }
  }

  return (
    <div className="bui mt-2 w-full max-w-[560px] min-w-0" data-inline-reply="">
      {items.length > 0 && (
        <FollowUpList
          items={items}
          sentItems={sentItems}
          disabledReason={disabledReason ?? (pending ? '正在发送…' : undefined)}
          onSelect={text => void send(text, true)}
        />
      )}
      <Button
        type="button"
        size="sm"
        variant="quiet"
        className="sr-only focus:not-sr-only focus:mt-1"
        aria-controls={id}
        onClick={() => {
          setExpanded(true)
          // Opening by click/tap is an intentional focus change; hover never steals focus.
          requestAnimationFrame(() => editorRef.current?.focus())
        }}
      >
        快速回复
      </Button>
      <form
        id={id}
        aria-label={context}
        className={`${expanded || draft || error || pending ? 'grid' : 'hidden group-hover/reply:grid group-focus-within/reply:grid [@media(hover:none)]:grid'} mt-2 gap-2`}
        onSubmit={event => {
          event.preventDefault()
          void send(draft)
        }}
      >
        <label className="visually-hidden" htmlFor={`${id}-input`}>
          回复内容
        </label>
        <span id={`${id}-context`} className="visually-hidden">
          {context}，回复：{excerpt.slice(0, 120)}
        </span>
        <div className="relative">
          <TextArea
            id={`${id}-input`}
            ref={editorRef}
            aria-describedby={`${id}-context`}
            rows={1}
            className="block min-h-12 w-full resize-none pr-14"
            enterKeyHint="send"
            value={draft}
            disabled={pending || Boolean(disabledReason)}
            placeholder="继续追问…"
            onChange={event => setDraft(event.target.value)}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={() => {
              composingRef.current = false
            }}
            onKeyDown={event => {
              // Safari can end composition before its confirming keydown.
              const legacyKeyCode = (
                event.nativeEvent as unknown as { keyCode?: number }
              ).keyCode
              if (
                event.key !== 'Enter' ||
                event.shiftKey ||
                composingRef.current ||
                event.nativeEvent.isComposing ||
                legacyKeyCode === 229
              )
                return
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }}
          />
          <Button
            type="submit"
            size="sm"
            className="absolute right-0.5 top-0.5 h-11 w-11 p-0"
            aria-label="发送回复"
            disabled={pending || Boolean(disabledReason) || !draft.trim()}
          >
            <ArrowUp size={15} aria-hidden="true" />
          </Button>
        </div>
        {disabledReason && (
          <p className="text-[12px] text-ink-2">{disabledReason}</p>
        )}
        {error && (
          <div role="alert" className="grid gap-1 text-[13px] text-ink">
            <p>{error}</p>
            <p className="break-words">未发送：{attemptRef.current?.text}</p>
            <Button
              type="button"
              size="sm"
              disabled={pending || Boolean(disabledReason)}
              onClick={() => {
                const attempt = attemptRef.current
                if (attempt)
                  void send(attempt.text, items.includes(attempt.text))
              }}
            >
              重试发送
            </Button>
          </div>
        )}
      </form>
      {notice && (
        <p
          role="status"
          className={
            notice === '已发送到对应事情'
              ? 'visually-hidden'
              : 'mt-1 text-[12px] text-ink-2'
          }
        >
          {notice}
        </p>
      )}
    </div>
  )
}
