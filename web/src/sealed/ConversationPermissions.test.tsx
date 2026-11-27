// @vitest-environment jsdom
import '../test-env'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api'
import type { ApprovalRule, WorkChannel, WorkerProfileResponse } from '../types'
import { ConversationPermissions } from './ConversationPermissions'

type Api = ComponentProps<typeof ConversationPermissions>['api']
const channel: WorkChannel = {
  id: 'task-a',
  taskId: 'task-a',
  userId: 'owner',
  originEventId: 'event-a',
  title: '事情甲',
  goal: '完成事情甲',
  status: 'started',
  workerIconId: 'computer',
  canResume: false,
  canStop: true,
  latestActivityAt: '2026-11-27T08:00:00Z',
  createdAt: '2026-11-27T08:00:00Z',
  updatedAt: '2026-11-27T08:00:00Z',
}
const profile: WorkerProfileResponse['profile'] = {
  id: 'profile-a',
  taskId: channel.id,
  revision: 3,
  modelMode: 'override',
  modelProvider: 'custom',
  modelName: 'kept-model',
  effort: 'high',
  permissionMode: 'standard',
  createdAt: channel.createdAt,
  updatedAt: channel.updatedAt,
}
const response: WorkerProfileResponse = {
  profile,
  effective: {
    profile,
    source: 'task',
    modelMode: 'override',
    modelRef: 'custom/kept-model',
    permissionTier: 'standard',
    permissionSource: 'task',
  },
}
const taskRule: ApprovalRule = {
  id: 'rule-a',
  taskId: channel.id,
  kind: 'operation',
  tool: '*',
  category: 'task-tools',
  targets: [],
  fingerprint: 'f'.repeat(64),
  scope: 'exact',
  lifetime: 'task',
  status: 'active',
  createdFromApprovalId: 'approval-a',
  createdFromDecisionId: 'decision-a',
  createdBy: 'owner',
  createdAt: channel.createdAt,
}
const longRule: ApprovalRule = {
  ...taskRule,
  id: 'rule-long',
  tool: 'write',
  category: 'out-of-workspace-write',
  scope: 'user_directory',
  lifetime: 'user',
  targets: ['/shared/project'],
}
afterEach(cleanup)
function fixture(task: WorkChannel | null = channel) {
  const mocks = {
    workerProfile: vi.fn().mockResolvedValue(response),
    saveWorkerProfile: vi
      .fn()
      .mockImplementation(
        (_id: string, update: Parameters<Api['saveWorkerProfile']>[1]) =>
          Promise.resolve({
            ...response,
            profile: { ...profile, ...update, revision: 4 },
          }),
      ),
    approvalRules: vi.fn().mockResolvedValue([taskRule, longRule]),
    revokeApprovalRule: vi
      .fn()
      .mockResolvedValue({ ...taskRule, status: 'revoked' }),
    searchChannels: vi
      .fn()
      .mockResolvedValue({ channels: [channel], matches: [] }),
  }
  render(
    <ConversationPermissions
      api={mocks as unknown as Api}
      channel={task ?? undefined}
      channels={[channel]}
      onClose={vi.fn()}
    />,
  )
  return mocks
}
async function chooseTier(label: string) {
  fireEvent.click(await screen.findByLabelText('权限档位'))
  fireEvent.click(await screen.findByRole('option', { name: label }))
}

describe('conversation permission management', () => {
  it.each(['main', 'task'])(
    'closes an open full-access confirmation when the %s task ends',
    async scope => {
      const api = fixture(scope === 'task' ? channel : null)
      cleanup()
      const view = render(
        <ConversationPermissions
          api={api as unknown as Api}
          channel={scope === 'task' ? channel : undefined}
          channels={[channel]}
          onClose={vi.fn()}
        />,
      )
      if (scope === 'main')
        fireEvent.click(screen.getByRole('button', { name: channel.title }))
      await chooseTier('完全访问 · 显式风险披露')
      fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
      expect(
        screen.getByRole('button', { name: '我已了解，启用完全访问' }),
      ).toBeTruthy()
      const ended = { ...channel, status: 'completed' as const }
      view.rerender(
        <ConversationPermissions
          api={api as unknown as Api}
          channel={scope === 'task' ? ended : undefined}
          channels={[ended]}
          onClose={vi.fn()}
        />,
      )
      expect(
        screen.queryByRole('button', { name: '我已了解，启用完全访问' }),
      ).toBeNull()
      expect(screen.queryByRole('button', { name: '保存权限' })).toBeNull()
      expect(api.saveWorkerProfile).not.toHaveBeenCalled()
    },
  )
  it('saves only the permission change while preserving an explicit model and effort', async () => {
    const api = fixture()
    await chooseTier('严格 · 只读，写与网络都审批')
    fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
    await waitFor(() =>
      expect(api.saveWorkerProfile).toHaveBeenCalledWith(channel.id, {
        expectedRevision: 3,
        modelMode: 'override',
        modelProvider: 'custom',
        modelName: 'kept-model',
        pool: undefined,
        effort: 'high',
        permissionMode: 'strict',
      }),
    )
    expect(
      await screen.findByText(
        '权限已保存。收紧对下一次工具调用生效，放宽对后续运行生效。',
      ),
    ).toBeTruthy()
    expect(screen.queryByLabelText('执行模型')).toBeNull()
  })
  it('keeps full access behind an explicit in-product confirmation', async () => {
    const api = fixture()
    await chooseTier('完全访问 · 显式风险披露')
    fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
    expect(api.saveWorkerProfile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(api.saveWorkerProfile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
    fireEvent.click(
      screen.getByRole('button', { name: '我已了解，启用完全访问' }),
    )
    await waitFor(() =>
      expect(api.saveWorkerProfile).toHaveBeenCalledWith(
        channel.id,
        expect.objectContaining({ permissionMode: 'full' }),
      ),
    )
  })
  it('reloads a conflicting profile instead of overwriting a newer revision', async () => {
    const api = fixture()
    api.saveWorkerProfile.mockRejectedValueOnce(
      new ApiError(409, 'changed elsewhere'),
    )
    await chooseTier('严格 · 只读，写与网络都审批')
    api.workerProfile.mockResolvedValue({
      ...response,
      profile: { ...profile, revision: 6 },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
    expect(await screen.findByText(/保存冲突/)).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByLabelText('权限档位').textContent).toContain('标准'),
    )
    await chooseTier('严格 · 只读，写与网络都审批')
    fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
    await waitFor(() =>
      expect(api.saveWorkerProfile).toHaveBeenLastCalledWith(
        channel.id,
        expect.objectContaining({ expectedRevision: 6 }),
      ),
    )
  })
  it('retries a failed revoke and separates cross-task long-lived grants', async () => {
    const api = fixture()
    api.revokeApprovalRule.mockRejectedValueOnce(new Error('暂时无法撤销'))
    const button = (
      await screen.findAllByRole('button', { name: '撤销规则' })
    )[0]
    if (!button) throw new Error('Missing task grant revoke button')
    fireEvent.click(button)
    expect(await screen.findByText('暂时无法撤销')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '撤销规则' })).toHaveLength(2)
    fireEvent.click(button)
    expect(await screen.findByText(/已撤销/)).toBeTruthy()
    expect(api.revokeApprovalRule).toHaveBeenLastCalledWith(
      channel.id,
      taskRule.id,
    )
    fireEvent.click(screen.getByRole('button', { name: '长期授权' }))
    await waitFor(() =>
      expect(screen.queryByText('本事情内所有工具授权')).toBeNull(),
    )
    expect(await screen.findByText('/shared/project')).toBeTruthy()
    expect(api.approvalRules).toHaveBeenLastCalledWith(undefined)
  })
  it('finds a task outside the recent list and loads only that task profile', async () => {
    const api = fixture(null)
    fireEvent.change(screen.getByLabelText('查找事情'), {
      target: { value: '事情乙' },
    })
    api.searchChannels.mockResolvedValue({
      channels: [
        { ...channel, id: 'task-b', taskId: 'task-b', title: '事情乙' },
      ],
      matches: [],
    })
    fireEvent.click(screen.getByRole('button', { name: '查找' }))
    fireEvent.click(await screen.findByRole('button', { name: '事情乙' }))
    await waitFor(() =>
      expect(api.workerProfile).toHaveBeenLastCalledWith('task-b'),
    )
    expect(api.approvalRules).toHaveBeenLastCalledWith('task-b')
  })
  it.each(['cancelled', 'completed'] as const)(
    'keeps %s task settings read-only without hiding revocation',
    async status => {
      fixture({ ...channel, status })
      expect(
        await screen.findByText(
          '事情已结束，权限设置为只读；已有授权仍可撤销。',
        ),
      ).toBeTruthy()
      expect(screen.queryByRole('button', { name: '保存权限' })).toBeNull()
      expect(screen.getAllByRole('button', { name: '撤销规则' })).toHaveLength(
        2,
      )
    },
  )
})
