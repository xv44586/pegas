import { useId, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@bui/index'
import { formatRelativeTime } from './types'

interface SearchMessage {
  id: string
  text: string
  role: 'user' | 'pegas'
  at: string
}

/** Search the already-complete task projection, never the global snapshot. */
export function TaskHistorySearch({
  open,
  onOpenChange,
  messages,
  onSelect,
  onRestoreFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  messages: readonly SearchMessage[]
  onSelect: (id: string) => void
  onRestoreFocus: () => void
}) {
  const inputId = useId()
  const [query, setQuery] = useState('')
  const selected = useRef<string | undefined>(undefined)
  const input = useRef<HTMLInputElement>(null)
  const normalized = query.trim().toLocaleLowerCase()
  const results = normalized
    ? messages
        .filter(message =>
          message.text.toLocaleLowerCase().includes(normalized),
        )
        .toReversed()
    : []
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85dvh] min-w-0 flex-col gap-3"
        closeLabel="关闭事情搜索"
        onOpenAutoFocus={event => {
          event.preventDefault()
          input.current?.focus()
        }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          const id = selected.current
          selected.current = undefined
          if (id) onSelect(id)
          else onRestoreFocus()
        }}
        onKeyDown={event => {
          // Keep the app's global search shortcut from stacking another modal.
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === 'k'
          ) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
      >
        <DialogTitle className="pr-10">搜索当前事情</DialogTitle>
        <DialogDescription className="mt-0">
          搜索这件事的用户输入和 Agent 回复，点击结果定位原消息。
        </DialogDescription>
        <label className="text-[13px] text-ink-2" htmlFor={inputId}>
          搜索当前事情的对话
        </label>
        <input
          id={inputId}
          ref={input}
          type="search"
          className="h-11 w-full shrink-0 rounded-control border border-line bg-field px-3 text-[15px] text-ink"
          placeholder="输入关键词"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <p role="status" className="text-[13px] text-ink-2">
          {!normalized
            ? '输入关键词，查找当前事情的历史消息。'
            : results.length
              ? `找到 ${String(results.length)} 条消息`
              : '当前事情中没有匹配的消息。'}
        </p>
        <ol
          role="list"
          aria-label="当前事情搜索结果"
          className="min-h-0 overflow-y-auto overscroll-contain"
        >
          {results.map(message => {
            const index = message.text.toLocaleLowerCase().indexOf(normalized)
            const start = Math.max(0, index - 35)
            const end = Math.min(
              message.text.length,
              index + normalized.length + 65,
            )
            const snippet = message.text.slice(start, end)
            return (
              <li
                key={message.id}
                className="border-b border-line last:border-0"
              >
                <button
                  type="button"
                  className="w-full rounded-control p-3 text-left hover:bg-hover"
                  aria-label={`定位消息：${snippet}`}
                  onClick={() => {
                    selected.current = message.id
                    onOpenChange(false)
                  }}
                >
                  <span className="mb-1 flex justify-between gap-3 text-[12px] text-ink-2">
                    <span>{message.role === 'user' ? '你' : 'Pegas'}</span>
                    <time dateTime={message.at}>
                      {formatRelativeTime(message.at)}
                    </time>
                  </span>
                  <span className="block break-words text-[14px] text-ink">
                    {start > 0 && '…'}
                    {message.text.slice(start, index)}
                    <mark>
                      {message.text.slice(index, index + normalized.length)}
                    </mark>
                    {message.text.slice(index + normalized.length, end)}
                    {end < message.text.length && '…'}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      </DialogContent>
    </Dialog>
  )
}
