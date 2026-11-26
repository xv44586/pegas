import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import {
  CircleHelp,
  FolderOpen,
  List,
  Paperclip,
  Plus,
  SlidersHorizontal,
  Square,
  WandSparkles,
} from 'lucide-react'
import {
  Button,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '@bui/index'
import type { WorkChannel } from '../types'

const commands = [
  {
    key: 'help',
    label: '命令帮助',
    description: '查看可用的基础命令',
    icon: CircleHelp,
  },
  {
    key: 'attach',
    label: '添加照片和文件',
    description: '最大 25MB，随下一条消息发送',
    icon: Paperclip,
  },
  {
    key: 'model',
    label: '选择模型',
    description: '选择已配置的执行模型',
    icon: SlidersHorizontal,
  },
  {
    key: 'auto',
    label: '恢复自动归属',
    description: '取消指定事情，保留当前草稿',
    icon: WandSparkles,
  },
  {
    key: 'stop',
    label: '停止当前事情',
    description: '确认后停止执行，保留历史',
    icon: Square,
  },
] as const

type Command = (typeof commands)[number]['key']
type MenuMode = 'actions' | 'commands' | 'tasks'
interface Row {
  key: string
  label: string
  description: string
  icon: typeof Plus
  shortcut?: string
  disabled?: boolean
  action: () => void
}

/** Product adapter for Prompt Bar interactions; all mutations reuse existing controls. */
export function useComposerMenu({
  draft,
  onDraftChange,
  inputRef,
  channels,
  disabled,
  canStop,
  hasModels,
  onAttach,
  onModel,
  onStop,
  onAuto,
  onTask,
  onError,
}: {
  draft: string
  onDraftChange: (draft: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  channels: WorkChannel[]
  disabled: boolean
  canStop: boolean
  hasModels: boolean
  onAttach: () => void
  onModel: () => void
  onStop: () => void
  onAuto: () => void
  onTask: (channel: WorkChannel) => void
  onError: (message: string) => void
}) {
  const id = useId()
  const composerAnchor = useRef({
    getBoundingClientRect: () =>
      inputRef.current?.form?.getBoundingClientRect() ?? new DOMRect(),
  })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const returnToInput = useRef(false)
  const dismissedOutside = useRef(false)
  const [mode, setMode] = useState<MenuMode | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [caret, setCaret] = useState(draft.length)
  const [active, setActive] = useState(0)
  const beforeCaret = draft.slice(0, caret)
  const atMatch = /(^|\s)@([^\s@]*)$/u.exec(beforeCaret)
  const slashMatch = /^\/([\w-]*)$/iu.exec(beforeCaret)
  const commandInput = /^\/([\w-]*)(?:\s+([\s\S]*))?$/iu.exec(draft.trim())
  const token =
    !dismissed && !disabled
      ? slashMatch && caret === draft.length
        ? { mode: 'commands' as const, query: slashMatch[1] ?? '', start: 0 }
        : atMatch
          ? {
              mode: 'tasks' as const,
              query: atMatch[2] ?? '',
              start: atMatch.index + (atMatch[1]?.length ?? 0),
            }
          : null
      : null
  const menuMode = mode ?? token?.mode
  const completion = mode === null && token !== null
  const query = completion ? token.query.toLocaleLowerCase() : ''
  const open = Boolean(menuMode) && !disabled

  useEffect(() => {
    if (mode && open)
      panelRef.current
        ?.querySelector<HTMLButtonElement>('[data-composer-option]')
        ?.focus()
  }, [mode, open])

  function close() {
    setMode(null)
    setDismissed(true)
  }
  function show(next: MenuMode) {
    setMode(next)
    setActive(0)
  }
  function restoreInput() {
    returnToInput.current = true
    inputRef.current?.focus()
  }
  function removeToken() {
    if (!completion) return
    onDraftChange(draft.slice(0, token.start) + draft.slice(caret))
    setCaret(token.start)
  }
  function execute(command: Command, consume = false) {
    if (disabled) return
    const unavailable =
      command === 'stop' && !canStop
        ? '当前没有可停止的事情。'
        : command === 'model' && !hasModels
          ? '尚无可用模型，请先在设置中配置模型服务。'
          : ''
    if (unavailable) {
      onError(unavailable)
      close()
      restoreInput()
      return
    }
    onError('')
    if (consume) onDraftChange('')
    close()
    restoreInput()
    if (command === 'help') show('commands')
    if (command === 'attach') onAttach()
    if (command === 'model') onModel()
    if (command === 'stop') onStop()
    if (command === 'auto') onAuto()
  }
  const commandRows: Row[] = commands.map(command => ({
    ...command,
    shortcut: `/${command.key}`,
    description:
      command.key === 'stop' && !canStop
        ? '当前没有可停止的事情'
        : command.key === 'model' && !hasModels
          ? '请先在设置中配置模型服务'
          : command.description,
    disabled:
      (command.key === 'stop' && !canStop) ||
      (command.key === 'model' && !hasModels),
    action: () => execute(command.key, completion),
  }))
  const rows: Row[] =
    menuMode === 'actions'
      ? [
          { ...commands[1], shortcut: '/attach', action: onAttachAndClose },
          {
            key: 'tasks',
            label: '选择已有事情',
            description: '让下一条消息继续这件事',
            icon: FolderOpen,
            shortcut: '@',
            action: () => show('tasks'),
          },
          {
            key: 'commands',
            label: '基础命令',
            description: '帮助、模型、自动归属与停止',
            icon: List,
            shortcut: '/',
            action: () => show('commands'),
          },
        ]
      : menuMode === 'tasks'
        ? channels
            .filter(
              channel =>
                channel.status !== 'cancelled' &&
                `${channel.title} ${channel.id}`
                  .toLocaleLowerCase()
                  .includes(query),
            )
            .map(channel => ({
              key: channel.id,
              label: channel.title,
              description:
                channel.status === 'completed'
                  ? '继续已交付的事情'
                  : '继续这件事',
              icon: FolderOpen,
              action: () => {
                removeToken()
                onTask(channel)
                close()
                restoreInput()
              },
            }))
        : commandRows.filter(
            row => row.key.startsWith(query) || row.label.includes(query),
          )
  const selected = Math.min(active, Math.max(0, rows.length - 1))
  function onAttachAndClose() {
    execute('attach')
  }
  function selectRow(index: number) {
    const row = rows[index]
    if (disabled || !row || row.disabled) return
    row.action()
  }
  function move(key: string, focus: boolean) {
    const next =
      key === 'Home'
        ? 0
        : key === 'End'
          ? rows.length - 1
          : (selected + (key === 'ArrowUp' ? -1 : 1) + rows.length) %
            rows.length
    setActive(Math.max(0, next))
    const row = panelRef.current?.querySelectorAll<HTMLButtonElement>(
      '[data-composer-option]',
    )[next]
    row?.scrollIntoView({ block: 'nearest' })
    if (focus) row?.focus()
  }
  function isComposing(event: KeyboardEvent) {
    return (
      event.nativeEvent.isComposing ||
      (event.nativeEvent as unknown as { keyCode?: number }).keyCode === 229
    )
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isComposing(event) || !open) return false
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault()
      move(event.key, false)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return true
    }
    if (event.key === 'Tab') {
      dismissedOutside.current = true
      close()
    }
    if (event.key === 'Enter' && !event.shiftKey && rows.length) {
      event.preventDefault()
      if (
        completion &&
        commandInput?.[1]?.toLowerCase() === rows[selected]?.key
      )
        consumeSubmit()
      else selectRow(selected)
      return true
    }
    return false
  }
  function consumeSubmit() {
    // Reserve command-shaped input; paths, URLs and slashes within prose remain ordinary text.
    const match = commandInput
    if (!match) return false
    const name = (match[1] ?? '').toLowerCase()
    const command = commands.find(item => item.key === name)
    if (!name && match[2])
      onError('请使用完整命令。输入 /help 查看可用命令；正文已保留。')
    else if (!name) execute('help', true)
    else if (!command) onError(`未知命令 /${name}。输入 /help 查看可用命令。`)
    else if (match[2])
      onError(`/${name} 不接受参数。请单独执行命令，正文可在操作后输入。`)
    else execute(command.key, true)
    return true
  }

  return {
    isCommand: commandInput !== null,
    onKeyDown,
    consumeSubmit,
    onInput(value: string, position: number) {
      onDraftChange(value)
      setCaret(position)
      setDismissed(false)
      setMode(null)
      setActive(0)
    },
    onSelect(position: number) {
      setCaret(position)
    },
    inputProps: {
      'aria-controls': completion && open ? id : undefined,
      'aria-haspopup': 'listbox' as const,
      'aria-autocomplete': 'list' as const,
      'aria-activedescendant':
        completion && open && rows.length
          ? `${id}-${String(selected)}`
          : undefined,
    },
    menu: (
      <Popover
        open={open}
        onOpenChange={next => {
          if (next) show('actions')
          else close()
        }}
      >
        <PopoverAnchor virtualRef={composerAnchor} />
        <PopoverTrigger asChild>
          <Button
            aria-label="添加内容"
            aria-haspopup="menu"
            className="composer-add-button size-10 rounded-full p-0 text-ink-3 hover:bg-hover hover:text-ink aria-expanded:bg-hover pointer-coarse:size-11"
            disabled={disabled}
            ref={triggerRef}
            size="sm"
            type="button"
            variant="quiet"
            onKeyDown={event => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                show('actions')
              }
            }}
          >
            <Plus size={22} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          collisionPadding={12}
          id={id}
          ref={panelRef}
          className="w-[320px] max-w-[calc(100vw-24px)] overflow-y-auto p-1.5 [max-height:min(360px,var(--radix-popover-content-available-height))]"
          role={completion ? 'listbox' : 'menu'}
          aria-label={
            menuMode === 'tasks'
              ? '选择已有事情'
              : menuMode === 'commands'
                ? '基础命令'
                : '添加内容'
          }
          onOpenAutoFocus={event => {
            event.preventDefault()
            if (!completion)
              panelRef.current
                ?.querySelector<HTMLButtonElement>('[data-composer-option]')
                ?.focus()
          }}
          onCloseAutoFocus={event => {
            event.preventDefault()
            if (dismissedOutside.current) {
              dismissedOutside.current = false
              returnToInput.current = false
              return
            }
            if (returnToInput.current || completion) inputRef.current?.focus()
            else triggerRef.current?.focus()
            returnToInput.current = false
          }}
          onInteractOutside={event => {
            if (completion && event.target === inputRef.current)
              event.preventDefault()
            else dismissedOutside.current = true
          }}
          onKeyDown={event => {
            if (isComposing(event)) return
            if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              move(event.key, true)
            }
            if (event.key === 'Tab') {
              dismissedOutside.current = true
              triggerRef.current?.focus()
              close()
            }
          }}
        >
          {rows.length ? (
            rows.map((row, index) => (
              <button
                key={row.key}
                id={`${id}-${String(index)}`}
                type="button"
                data-composer-option
                role={completion ? 'option' : 'menuitem'}
                aria-selected={completion ? index === selected : undefined}
                aria-disabled={row.disabled}
                tabIndex={!completion && index === selected ? 0 : -1}
                className={`flex min-h-12 w-full items-center gap-3 rounded-control px-3 py-2 text-left text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent aria-disabled:text-ink-2 ${index === selected ? 'bg-hover' : ''}`}
                onPointerMove={() => setActive(index)}
                onFocus={() => setActive(index)}
                onMouseDown={event => {
                  if (completion) event.preventDefault()
                }}
                onClick={() => selectRow(index)}
              >
                <row.icon
                  aria-hidden="true"
                  className="shrink-0 text-ink-2"
                  size={17}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {row.label}
                  </span>
                  <span className="block text-[12px] leading-relaxed text-ink-2">
                    {row.description}
                  </span>
                </span>
                {row.shortcut && (
                  <span className="shrink-0 text-[12px] text-ink-2">
                    {row.shortcut}
                  </span>
                )}
              </button>
            ))
          ) : (
            <p className="p-3 text-[13px] text-ink-2" role="status">
              {menuMode === 'tasks'
                ? '没有匹配的事情；可直接输入消息开始新事情。'
                : '没有匹配的命令，输入 /help 查看帮助。'}
            </p>
          )}
          <p className="px-3 pt-2 pb-1 text-[11px] text-ink-2">
            ↑ ↓ 选择 · Enter 确认 · Esc 关闭
          </p>
        </PopoverContent>
      </Popover>
    ),
  }
}
