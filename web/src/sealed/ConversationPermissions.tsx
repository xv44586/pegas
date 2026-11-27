import { useEffect, useId, useState, type ComponentProps } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  TextInput,
} from '@bui/index'
import type { WorkChannel, WorkerProfileResponse } from '../types'
import { ApprovalRulesSection, WorkerProfileSection } from './DetailDrawer'
import type { ConversationPage } from './MainPages'

type Api = ComponentProps<typeof ConversationPage>['api']

export function ConversationPermissions({
  api,
  channel,
  channels,
  onClose,
}: {
  api: Api
  channel?: WorkChannel
  channels: WorkChannel[]
  onClose: () => void
}) {
  const id = useId()
  const [selected, setSelected] = useState(channel)
  const [scope, setScope] = useState(channel ? 'task' : 'choose')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(channels)
  const [cursor, setCursor] = useState<string>()
  const [searchError, setSearchError] = useState('')
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const selectedChannel =
    channel ?? channels.find(item => item.id === selected?.id) ?? selected
  async function search(nextCursor?: string) {
    if (searching) return
    setSearching(true)
    setSearchError('')
    try {
      const result = await api.searchChannels(query, {}, nextCursor)
      setResults(current =>
        nextCursor ? [...current, ...result.channels] : result.channels,
      )
      setCursor(result.nextCursor)
      setSearched(true)
    } catch (caught) {
      setSearchError(
        caught instanceof Error ? caught.message : '读取事情失败，请重试。',
      )
    } finally {
      setSearching(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="flex max-h-[85dvh] w-[min(620px,calc(100vw-24px))] flex-col overflow-hidden"
        closeLabel="关闭权限管理"
      >
        <DialogTitle className="shrink-0 pr-6">权限管理</DialogTitle>
        <DialogDescription className="shrink-0">
          {channel
            ? `当前事情：${channel.title}`
            : '选择要调整权限的事情，或管理跨事情生效的长期授权。'}
        </DialogDescription>
        <div
          className="my-4 flex shrink-0 flex-wrap gap-2"
          role="group"
          aria-label="权限范围"
        >
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-pressed={scope !== 'user'}
            className="aria-pressed:bg-accent-tint aria-pressed:text-accent-ink"
            onClick={() => setScope(selected ? 'task' : 'choose')}
          >
            {channel ? '当前事情' : '事情权限'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-pressed={scope === 'user'}
            className="aria-pressed:bg-accent-tint aria-pressed:text-accent-ink"
            onClick={() => setScope('user')}
          >
            长期授权
          </Button>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          {scope === 'user' ? (
            <ApprovalRulesSection api={api} lifetime="user" />
          ) : selectedChannel && scope === 'task' ? (
            <>
              {!channel && (
                <div className="mb-3 flex items-center justify-between gap-3">
                  <strong className="min-w-0 break-words">
                    {selectedChannel.title}
                  </strong>
                  <Button
                    type="button"
                    variant="quiet"
                    size="sm"
                    onClick={() => setScope('choose')}
                  >
                    更换事情
                  </Button>
                </div>
              )}
              <TaskPermissions
                key={`${selectedChannel.id}:${String(refresh)}`}
                api={api}
                channel={selectedChannel}
              />
              <Button
                type="button"
                variant="quiet"
                size="sm"
                onClick={() => setRefresh(value => value + 1)}
              >
                刷新权限与授权
              </Button>
            </>
          ) : (
            <div className="grid gap-3">
              <label htmlFor={id}>查找事情</label>
              <div className="flex gap-2">
                <TextInput
                  id={id}
                  value={query}
                  disabled={searching}
                  onChange={event => {
                    setQuery(event.target.value)
                    setCursor(undefined)
                  }}
                  onKeyDown={event => {
                    if (
                      event.key === 'Enter' &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault()
                      void search()
                    }
                  }}
                  placeholder="按标题或内容搜索"
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={searching}
                  onClick={() => void search()}
                >
                  {searching ? '查找中…' : '查找'}
                </Button>
              </div>
              {searchError && <p role="alert">{searchError}</p>}
              <p className="text-[12px] text-ink-2">
                {searched ? '搜索结果' : '最近事情；可搜索全部事情。'}
              </p>
              <ul className="grid gap-1">
                {results.map(item => (
                  <li key={item.id}>
                    <Button
                      type="button"
                      variant="quiet"
                      className="h-auto min-h-10 w-full justify-start whitespace-normal break-words text-left"
                      onClick={() => {
                        setSelected(item)
                        setScope('task')
                      }}
                    >
                      {item.title}
                    </Button>
                  </li>
                ))}
              </ul>
              {results.length === 0 && <p>没有找到事情。</p>}
              {cursor && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={searching}
                  onClick={() => void search(cursor)}
                >
                  更多事情
                </Button>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TaskPermissions({ api, channel }: { api: Api; channel: WorkChannel }) {
  const [profile, setProfile] = useState<WorkerProfileResponse>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    setError('')
    void api
      .workerProfile(channel.id)
      .then(value => {
        if (active) setProfile(value)
      })
      .catch((caught: unknown) => {
        if (active)
          setError(caught instanceof Error ? caught.message : '读取权限失败。')
      })
    return () => {
      active = false
    }
  }, [api, channel.id, retry])
  return (
    <>
      {error ? (
        <div role="alert" className="mb-3 text-red-text">
          {error}{' '}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setRetry(value => value + 1)}
          >
            重试读取权限
          </Button>
        </div>
      ) : !profile ? (
        <p>正在读取权限…</p>
      ) : (
        <WorkerProfileSection
          api={api}
          channel={channel}
          profile={profile}
          permissionsOnly
        />
      )}
      <ApprovalRulesSection api={api} channel={channel} />
      <p className="mt-3 text-[12px] leading-relaxed text-ink-2">
        新增工具、目录或命令授权，请在对应的工具审批中确认。本事情内所有工具授权会在完成或停止后失效，重开不继承。已开始的操作不会因撤销而自动中止。
      </p>
    </>
  )
}
