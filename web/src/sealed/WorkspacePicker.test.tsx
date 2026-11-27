// @vitest-environment jsdom
import '../test-env'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspacePicker } from './WorkspacePicker'
import type { WorkspaceApi } from '../api'

afterEach(cleanup)

function fixture(taskId?: string) {
  const api: WorkspaceApi = {
    projects: vi.fn().mockResolvedValue([
      {
        id: 'a',
        name: 'Project A',
        nodeId: 'local',
        directory: '/projects/a',
      },
    ]),
    executionNodes: vi
      .fn()
      .mockResolvedValue([{ id: 'local', label: 'My computer' }]),
    createProject: vi.fn().mockResolvedValue({
      id: 'created',
      name: 'New',
      nodeId: 'local',
      directory: '/projects/new',
    }),
    taskProject: vi.fn().mockResolvedValue({
      projectId: 'a',
      workingDirectory: '/projects/a',
      nodeId: 'local',
      revision: 2,
    }),
    updateTaskProject: vi.fn().mockResolvedValue({
      projectId: 'a',
      workingDirectory: '/chosen/worktree',
      nodeId: 'local',
      revision: 3,
    }),
  }
  const onSelect = vi.fn()
  const onSaved = vi.fn().mockResolvedValue(undefined)
  render(
    <WorkspacePicker
      api={api}
      taskId={taskId}
      disabled={false}
      onSelect={onSelect}
      onSaved={onSaved}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /工作目录/ }))
  return { api, onSelect, onSaved }
}

it('applies a normal folder without creating a project and does not apply on selection change', async () => {
  const { api, onSelect } = fixture()
  await waitFor(() =>
    expect(screen.getByLabelText('位置').hasAttribute('disabled')).toBe(false),
  )
  fireEvent.keyDown(screen.getByLabelText('位置'), { key: 'ArrowDown' })
  fireEvent.click(
    await screen.findByRole('option', { name: '普通文件夹（无需创建项目）' }),
  )
  fireEvent.change(screen.getByLabelText('该电脑上的完整目录'), {
    target: { value: '/documents' },
  })
  expect(onSelect).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '应用目录' }))
  await waitFor(() =>
    expect(onSelect).toHaveBeenCalledWith({
      workspace: { directory: '/documents', nodeId: 'local' },
    }),
  )
  expect(api.createProject).not.toHaveBeenCalled()
})

it('saves an existing task directory with its current revision', async () => {
  const { api, onSelect, onSaved } = fixture('task-a')
  await screen.findByDisplayValue('/projects/a')
  fireEvent.change(screen.getByLabelText('该电脑上的完整目录'), {
    target: { value: '/chosen/worktree' },
  })
  fireEvent.click(screen.getByRole('button', { name: '应用目录' }))
  await waitFor(() =>
    expect(api.updateTaskProject).toHaveBeenCalledWith('task-a', {
      projectId: 'a',
      workingDirectory: '/chosen/worktree',
      nodeId: 'local',
      expectedRevision: 2,
    }),
  )
  expect(onSelect).not.toHaveBeenCalled()
  expect(onSaved).toHaveBeenCalled()
})

it('keeps the draft and reports a rejected directory change', async () => {
  const { api } = fixture('task-a')
  vi.mocked(api.updateTaskProject).mockRejectedValue(
    new Error('Execution is running'),
  )
  await screen.findByDisplayValue('/projects/a')
  fireEvent.change(screen.getByLabelText('该电脑上的完整目录'), {
    target: { value: '/photos' },
  })
  fireEvent.click(screen.getByRole('button', { name: '应用目录' }))
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Execution is running',
  )
  expect(
    screen.getByLabelText<HTMLInputElement>('该电脑上的完整目录').value,
  ).toBe('/photos')
})
