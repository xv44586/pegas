import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type SetStateAction,
} from 'react'
import { Button, Dialog, DialogContent, DialogTitle } from '@bui/index'
import type { ChannelTimeline } from '../types'
import { ConversationPage } from './MainPages'
import { TaskInspector } from './TaskInspector'
import { type ComposerTarget } from './types'
import { readTaskDraft, writeTaskDraft } from './taskConversationDraft'

type ConversationProps = ComponentProps<typeof ConversationPage>
type Props = Pick<
  ConversationProps,
  | 'api'
  | 'actions'
  | 'models'
  | 'onOpenAttention'
  | 'speechEnabled'
  | 'onConfigureVoice'
> & { taskId: string }

/** The server timeline owns membership. A task page never falls back to global chat. */
export function TaskConversationPage({ taskId, ...props }: Props) {
  const { api } = props
  const [timeline, setTimeline] = useState<ChannelTimeline>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const draftRef = useRef(readTaskDraft(taskId))
  const [draft, setDraftState] = useState(draftRef.current.text)
  const [quote, setQuoteState] = useState(draftRef.current.quote)
  function setDraft(update: SetStateAction<string>) {
    const text =
      typeof update === 'function' ? update(draftRef.current.text) : update
    draftRef.current = { ...draftRef.current, text }
    writeTaskDraft(taskId, draftRef.current)
    setDraftState(text)
  }
  function setQuote(
    next: Extract<ComposerTarget, { kind: 'reply' }> | undefined,
  ) {
    draftRef.current = { ...draftRef.current, quote: next }
    writeTaskDraft(taskId, draftRef.current)
    setQuoteState(next)
  }
  const [tab, setTab] = useState('overview')
  const [detailsOpen, setDetailsOpen] = useState(
    () => window.innerWidth >= 1200,
  )
  const [wide, setWide] = useState(() => window.innerWidth >= 1200)
  const controller = useRef<AbortController | undefined>(undefined)
  const request = useRef(0)
  const mounted = useRef(true)
  const refresh = useCallback(async () => {
    if (!mounted.current) return
    const id = ++request.current
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    try {
      const next = await api.completeChannelTimeline(taskId, abort.signal)
      if (id !== request.current || abort.signal.aborted) return
      setTimeline(next)
      setError('')
    } catch (caught) {
      if (id !== request.current || abort.signal.aborted) return
      setError(caught instanceof Error ? caught.message : '无法读取事情历史。')
    } finally {
      if (id === request.current && !abort.signal.aborted) {
        setLoading(false)
        controller.current = undefined
      }
    }
  }, [api, taskId])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => {
      if (!controller.current || controller.current.signal.aborted)
        void refresh()
    }, 5000)
    return () => {
      mounted.current = false
      ++request.current
      controller.current?.abort()
      window.clearInterval(timer)
    }
  }, [refresh])
  useEffect(() => {
    const resize = () => setWide(window.innerWidth >= 1200)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    if (timeline) document.title = `${timeline.channel.title} · Pegas`
  }, [timeline])

  const inspector = timeline && (
    <TaskInspector
      api={api}
      timeline={timeline}
      tab={tab}
      onTabChange={setTab}
      onOpenView={view => {
        if (!wide) {
          setDetailsOpen(false)
          document.querySelector<HTMLButtonElement>('[data-task-info]')?.focus()
        }
        props.actions.onOpenDrawer(view)
      }}
    />
  )
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      data-task-page={taskId}
    >
      {error && (
        <div className="connection-banner" role="alert">
          <span>
            {timeline
              ? '历史更新失败，当前显示上次读取的内容。'
              : '事情历史尚未完整读取。'}{' '}
            {error}
          </span>
          <Button size="sm" onClick={() => void refresh()}>
            重新读取事情历史
          </Button>
        </div>
      )}
      {!timeline ? (
        <div className="p-8 text-ink-2" role="status">
          {loading ? '正在读取完整事情历史…' : '暂时无法打开这件事。请重试。'}
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="min-w-0 flex-1">
            <ConversationPage
              {...props}
              snapshot={{
                ...timeline,
                channels: [timeline.channel],
                channelTimeline: timeline,
              }}
              target={quote ?? { kind: 'task', channel: timeline.channel }}
              onTargetChange={target => {
                if (target.kind === 'reply') setQuote(target)
              }}
              onClearTarget={() => setQuote(undefined)}
              draft={draft}
              onDraftChange={setDraft}
              onSent={refresh}
              onAnswerClarification={() =>
                document
                  .querySelector<HTMLTextAreaElement>('#pegas-message')
                  ?.focus()
              }
              onSelectModel={() => {
                setTab('settings')
                setDetailsOpen(true)
                return Promise.resolve()
              }}
              taskScope={{
                channel: timeline.channel,
                onDetails: () => setDetailsOpen(value => !value),
                onSettings: () => {
                  setTab('settings')
                  setDetailsOpen(true)
                },
              }}
            />
          </div>
          {wide && detailsOpen && (
            <aside
              aria-label="事情信息"
              className="bui w-[360px] shrink-0 overflow-y-auto border-l border-line bg-surface p-4"
            >
              {inspector}
            </aside>
          )}
          {!wide && (
            <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
              <DialogContent
                aria-describedby={undefined}
                className="max-h-[85dvh] overflow-y-auto"
              >
                <DialogTitle className="mb-5 pr-8">事情信息</DialogTitle>
                {inspector}
              </DialogContent>
            </Dialog>
          )}
        </div>
      )}
    </div>
  )
}
