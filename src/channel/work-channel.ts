import type { Task, TaskEnd, TaskStatus } from '../core/domain.js'

/**
 * User-facing projection of the authoritative Task lifecycle.
 *
 * The first version deliberately keeps channelId equal to taskId. Keeping both
 * fields in the API makes the projection boundary explicit without migrating
 * persisted Task/Run references.
 */
export interface WorkChannel {
  id: string
  taskId: string
  userId: string
  originEventId: string
  title: string
  goal: string
  status: TaskStatus
  statusReason?: string
  createdAt: string
  updatedAt: string
  latestActivityAt: string
  endedAt?: string
  ended?: TaskEnd
  endedKind?: TaskEnd['outcome']
  canResume: boolean
  canStop: boolean
}

export function projectWorkChannel(task: Task): WorkChannel {
  const ended = task.status === 'completed' || task.status === 'cancelled'
  return {
    id: task.id,
    taskId: task.id,
    userId: task.userId,
    originEventId: task.originEventId,
    title: task.title,
    goal: task.goal,
    status: task.status,
    ...(task.statusReason ? { statusReason: task.statusReason } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    latestActivityAt: task.updatedAt,
    ...(ended ? { endedAt: task.ended?.at ?? task.updatedAt } : {}),
    ...(task.ended ? { ended: task.ended, endedKind: task.ended.outcome } : {}),
    canResume: task.status === 'completed',
    canStop: ['backlog', 'unstarted', 'started'].includes(task.status),
  }
}
