import { useEffect, useState, type ComponentProps } from 'react'
import { Button, Tabs, TabsList, TabsTrigger, TabsContent } from '@bui/index'
import type {
  ChannelTimeline,
  Run,
  RunActivityReport,
  TaskDelivery,
  WorkerProfileResponse,
} from '../types'
import { ActivityTimeline } from './ActivityTimeline'
import {
  ApprovalRulesSection,
  DeliverySection,
  PermissionTierHistorySection,
  WorkerProfileSection,
  evidencePreviewView,
} from './DetailDrawer'
import type { ConversationPage } from './MainPages'
import {
  formatRelativeTime,
  latestRunForTask,
  runStatusLabel,
  statusLabel,
  type DrawerView,
} from './types'

type Api = ComponentProps<typeof ConversationPage>['api']

export function TaskInspector({
  api,
  timeline,
  tab,
  onTabChange,
  onOpenView,
}: {
  api: Api
  timeline: ChannelTimeline
  tab: string
  onTabChange: (tab: string) => void
  onOpenView: (view: DrawerView) => void
}) {
  const { channel, runs } = timeline
  const [delivery, setDelivery] = useState<TaskDelivery>()
  const [deliveryError, setDeliveryError] = useState('')
  const [profile, setProfile] = useState<WorkerProfileResponse>()
  const [profileError, setProfileError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    void api
      .taskDelivery(channel.id)
      .then(value => {
        if (active) {
          setDelivery(value)
          setDeliveryError('')
        }
      })
      .catch((error: unknown) => {
        if (active)
          setDeliveryError(
            error instanceof Error ? error.message : '无法读取交付。',
          )
      })
    return () => {
      active = false
    }
  }, [api, channel.id, channel.updatedAt, retry])
  useEffect(() => {
    if (tab !== 'settings') return
    let active = true
    void api
      .workerProfile(channel.id)
      .then(value => {
        if (active) {
          setProfile(value)
          setProfileError('')
        }
      })
      .catch((error: unknown) => {
        if (active)
          setProfileError(
            error instanceof Error ? error.message : '无法读取执行设置。',
          )
      })
    return () => {
      active = false
    }
  }, [api, channel.id, tab, retry])
  const goal = delivery?.goal
  const run = latestRunForTask(runs, channel.id)
  return (
    <Tabs
      value={tab}
      onValueChange={onTabChange}
      className="grid min-w-0 gap-5 text-[13px] leading-relaxed text-ink"
    >
      <TabsList aria-label="事情信息分类" className="w-full">
        <TabsTrigger className="text-ink-2" value="overview">
          概览
        </TabsTrigger>
        <TabsTrigger className="text-ink-2" value="delivery">
          交付
        </TabsTrigger>
        <TabsTrigger className="text-ink-2" value="execution">
          执行记录
        </TabsTrigger>
        <TabsTrigger className="text-ink-2" value="settings">
          设置
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="grid gap-5">
        <section>
          <h2 className="mb-2 font-medium">当前状态</h2>
          <p>
            {channel.status === 'cancelled'
              ? '已停止'
              : statusLabel(channel, run)}
          </p>
        </section>
        <section>
          <h2 className="mb-2 font-medium">{goal ? '目标' : '事情描述'}</h2>
          <p className="whitespace-pre-wrap break-words">
            {goal?.desiredOutcome ?? channel.goal}
          </p>
          {goal && (
            <p className="mt-2 text-[12px] text-ink-2">修订 v{goal.revision}</p>
          )}
        </section>
        {goal && goal.successCriteria.length > 0 && (
          <section>
            <h2 className="mb-2 font-medium">完成标准</h2>
            <ul className="list-disc space-y-2 pl-4">
              {goal.successCriteria.map(criterion => (
                <li key={criterion.criterionId}>
                  {criterion.observableStatement}
                </li>
              ))}
            </ul>
          </section>
        )}
        {goal && goal.nonGoals.length > 0 && (
          <section>
            <h2 className="mb-2 font-medium">不做的范围</h2>
            <ul className="list-disc space-y-2 pl-4">
              {goal.nonGoals.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </section>
        )}
        {deliveryError && (
          <div role="alert">
            <p>目标信息读取失败：{deliveryError}</p>
            <Button size="sm" onClick={() => setRetry(value => value + 1)}>
              重新读取目标
            </Button>
          </div>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[12px] text-ink-2">
          <dt>创建</dt>
          <dd>{formatRelativeTime(channel.createdAt)}</dd>
          <dt>最近活动</dt>
          <dd>{formatRelativeTime(channel.latestActivityAt)}</dd>
        </dl>
      </TabsContent>
      <TabsContent
        value="delivery"
        forceMount
        className="data-[state=inactive]:hidden"
      >
        {!delivery && !deliveryError && <p role="status">正在读取交付…</p>}
        <DeliverySection
          api={api}
          channelId={channel.id}
          delivery={delivery}
          error={deliveryError}
          onOpenEvidence={evidence => onOpenView(evidencePreviewView(evidence))}
        />
        {deliveryError && (
          <Button size="sm" onClick={() => setRetry(value => value + 1)}>
            重新读取交付
          </Button>
        )}
      </TabsContent>
      <TabsContent
        value="execution"
        forceMount
        className="grid gap-3 data-[state=inactive]:hidden"
      >
        {runs.length === 0 && <p className="text-ink-2">还没有执行记录。</p>}
        {runs
          .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
          .map(item => (
            <RunRecord key={item.id} api={api} run={item} />
          ))}
      </TabsContent>
      <TabsContent
        value="settings"
        forceMount
        className="data-[state=inactive]:hidden"
      >
        <WorkerProfileSection
          api={api}
          channel={channel}
          profile={profile}
          profileError={profileError}
        />
        {profileError && (
          <Button size="sm" onClick={() => setRetry(value => value + 1)}>
            重新读取执行设置
          </Button>
        )}
        <PermissionTierHistorySection api={api} channel={channel} />
        <ApprovalRulesSection api={api} channel={channel} />
      </TabsContent>
    </Tabs>
  )
}

function RunRecord({ api, run }: { api: Api; run: Run }) {
  const [open, setOpen] = useState(false)
  const [activity, setActivity] = useState<RunActivityReport>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!open) return
    let active = true
    void api
      .runActivity(run.id)
      .then(value => {
        if (value.runId !== run.id || value.taskId !== run.taskId)
          throw new Error('执行记录归属不匹配。')
        if (active) {
          setActivity(value)
          setError('')
        }
      })
      .catch((caught: unknown) => {
        if (active)
          setError(
            caught instanceof Error ? caught.message : '无法读取执行记录。',
          )
      })
    return () => {
      active = false
    }
  }, [api, open, run.id, run.taskId, run.updatedAt, retry])
  return (
    <details
      className="min-w-0 rounded-card bg-inset p-3"
      open={open}
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer">
        <strong>{runStatusLabel(run)}</strong>
        <span className="ml-2 text-[12px] text-ink-2">
          {formatRelativeTime(run.createdAt)}
        </span>
      </summary>
      {open && (
        <div className="mt-4 grid min-w-0 gap-3">
          <dl className="grid gap-1 break-all text-[12px] text-ink-2">
            <dt>执行</dt>
            <dd>{run.id}</dd>
            {run.executionContext?.model && (
              <>
                <dt>模型</dt>
                <dd>{run.executionContext.model}</dd>
              </>
            )}
            {run.executionContext?.workspace && (
              <>
                <dt>本次工作区</dt>
                <dd>{run.executionContext.workspace}</dd>
              </>
            )}
          </dl>
          {error && (
            <div role="alert">
              <p>{error}</p>
              <Button size="sm" onClick={() => setRetry(value => value + 1)}>
                重新读取执行记录
              </Button>
            </div>
          )}
          {!activity && !error && <p role="status">正在读取过程…</p>}
          {activity && (
            <>
              <ActivityTimeline
                entries={activity.entries}
                dataAccess={{
                  runId: run.id,
                  loadOutputPage: (id, call, offset, until) =>
                    api.runActivityOutputPage(id, call, offset, until),
                  imageUrl: (id, call) => api.runActivityImageUrl(id, call),
                  outputFileUrl: (id, call) =>
                    api.runActivityOutputFileUrl(id, call),
                }}
              />
              {activity.entries.length === 0 && <p>没有可展示的过程记录。</p>}
              {activity.truncated && (
                <p className="text-[12px] text-ink-2">
                  当前展示 {activity.entries.length} / {activity.totalEntries}{' '}
                  条记录，较早的过程未包含在本次返回中。
                </p>
              )}
            </>
          )}
        </div>
      )}
    </details>
  )
}
