import { useId, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@bui/index'
import { formatRelativeTime } from './types'
import type {
  TaskSearchRecord,
  TaskActivitySearchSnapshot,
} from './taskActivitySearch'

/** Search the already-complete task projection, never the global snapshot. */
export function TaskHistorySearch({
  open,
  onOpenChange,
  messages,
  onSelect,
  onRestoreFocus,
  activity,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  messages: readonly TaskSearchRecord[]
  activity?: TaskActivitySearchSnapshot
  onSelect: (record: TaskSearchRecord) => void
  onRestoreFocus: () => void
}) {
  const inputId = useId()
  const [query, setQuery] = useState('')
  const selected = useRef<TaskSearchRecord | undefined>(undefined)
  const input = useRef<HTMLInputElement>(null)
  const normalized = query.trim().toLocaleLowerCase()
  const results = normalized
    ? [...messages, ...(activity?.entries ?? [])]
        .filter(message =>
          message.text.toLocaleLowerCase().includes(normalized),
        )
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
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
          const record = selected.current
          selected.current = undefined
          if (record) onSelect(record)
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
          搜索这件事的对话、工具调用、规划与中间结果，点击结果展开原记录。
          不含附件文件及工具独立归档全文。
        </DialogDescription>
        <label className="text-[13px] text-ink-2" htmlFor={inputId}>
          搜索当前事情的记录
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
            ? '输入关键词，查找当前事情的对话与执行记录。'
            : results.length
              ? `找到 ${String(results.length)} 条记录`
              : activity?.pending || activity?.failed
                ? '已读取内容中暂无匹配，执行记录尚未读全。'
                : activity?.truncated
                  ? '已留存内容中没有匹配的记录。'
                  : '当前事情中没有匹配的记录。'}
        </p>
        {activity?.pending && (
          <p className="text-[13px] text-ink-2">
            正在读取执行记录，搜索结果会继续更新。
          </p>
        )}
        {activity?.failed && (
          <div role="alert" className="text-[13px] text-ink-2">
            <p>部分执行记录读取失败，当前结果可能不完整。</p>
            <button
              type="button"
              className="min-h-9 text-accent-ink"
              disabled={activity.pending}
              onClick={activity.retry}
            >
              重试读取执行记录
            </button>
          </div>
        )}
        {activity?.truncated && (
          <p className="text-[13px] text-ink-2">
            部分子 Agent 源记录已截断，只搜索留存内容。
          </p>
        )}
        <ol
          role="list"
          aria-label="当前事情搜索结果"
          className="min-h-0 overflow-y-auto overscroll-contain"
        >
          {results.map(message => {
            const index = message.text.toLocaleLowerCase().indexOf(normalized)
            // Keep a hit's context within its source field/line, rather than
            // gluing tool metadata and unrelated result fields into a snippet.
            const start = Math.max(
              0,
              index - 35,
              message.text.lastIndexOf('\n', index - 1) + 1,
            )
            const nextLine = message.text.indexOf(
              '\n',
              index + normalized.length,
            )
            const end = Math.min(
              message.text.length,
              index + normalized.length + 65,
              nextLine < 0 ? message.text.length : nextLine,
            )
            const snippet = message.text.slice(start, end)
            return (
              <li
                key={`${message.role}:${message.id}`}
                className="border-b border-line last:border-0"
              >
                <button
                  type="button"
                  className="w-full rounded-control p-3 text-left hover:bg-hover"
                  aria-label={`${message.role === 'activity' ? '定位记录' : '定位消息'}：${snippet}`}
                  onClick={() => {
                    selected.current = message
                    onOpenChange(false)
                  }}
                >
                  <span className="mb-1 flex justify-between gap-3 text-[12px] text-ink-2">
                    <span>
                      {message.role === 'activity'
                        ? message.label
                        : message.role === 'user'
                          ? '你'
                          : 'Pegas'}
                    </span>
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
