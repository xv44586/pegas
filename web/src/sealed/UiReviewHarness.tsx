import type { Run, WorkChannel } from '../types'
import { DetailDrawer } from './DetailDrawer'
import type { DrawerView } from './types'

export type ReviewFixture =
  | 'task-completed'
  | 'task-running'
  | 'task-waiting'
  | 'task-failed'
  | 'preview-file'
  | 'preview-image'
  | 'preview-video'
  | 'preview-web'

const channel: WorkChannel = {
  id: 'review-task',
  taskId: 'review-task',
  userId: 'review',
  originEventId: 'review-event',
  title: '封板状态视觉校验',
  goal: '验证详情抽屉在每一种结构化状态下的视觉与响应式布局',
  status: 'started',
  workerIconId: 'computer',
  canResume: false,
  canStop: true,
  latestActivityAt: '2026-11-20T00:00:00.000Z',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:04:00.000Z',
}

function taskView(status: Run['status']): DrawerView {
  const run: Run = {
    id: `review-${status}`,
    taskId: channel.id,
    executor: 'review-fixture',
    status,
    input: channel.goal,
    output: status === 'completed' ? '结构化结果已由服务端返回。' : undefined,
    attempts: 1,
    lastError:
      status === 'failed' ? '服务端返回：候选运行未通过就绪检查。' : undefined,
    executionContext: {
      executor: 'review-fixture',
      model: 'deepseek-v4.1-flash',
      workerProfile: 'pegas',
      workerProfileRevision: 2,
      workerProfileSource: 'task',
      workspace: '/review/isolated-workspace',
    },
    createdAt: '2026-11-20T00:01:00.000Z',
    updatedAt: '2026-11-20T00:04:00.000Z',
  }
  return {
    kind: 'task',
    channel: {
      ...channel,
      status: status === 'completed' ? 'completed' : 'started',
    },
    run,
    usage:
      status === 'completed'
        ? { totalTokens: 12_480, durationMs: 96_000, costUsd: 0.0184 }
        : undefined,
  }
}

function fixtureView(fixture: ReviewFixture): DrawerView {
  if (fixture.startsWith('task-'))
    return taskView(fixture.slice(5) as Run['status'])
  const preview = fixture.slice(8) as 'file' | 'image' | 'video' | 'web'
  return {
    kind: 'preview',
    preview,
    title: {
      file: '执行方案.md',
      image: '流程预览.png',
      video: '发布流程演示.mp4',
      web: '安全发布与自动回滚',
    }[preview],
    description:
      '这是只读 UI review fixture，用于验证服务端产物元数据的封板布局。',
    mimeType: {
      file: 'text/markdown',
      image: 'image/png',
      video: 'video/mp4',
      web: 'text/html',
    }[preview],
    source: 'UI review harness',
  }
}

export function UiReviewHarness({ fixture }: { fixture: ReviewFixture }) {
  return (
    <main className="review-harness">
      <DetailDrawer
        onChange={() => undefined}
        onClose={() => undefined}
        onRetry={() => Promise.resolve()}
        view={fixtureView(fixture)}
      />
    </main>
  )
}
