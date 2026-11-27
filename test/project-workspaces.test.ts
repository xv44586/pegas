import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { createControlPlane } from '../src/control-plane/server.js'
import { PegasStore } from '../src/storage/sqlite-store.js'
import { validateProjectWorkspace } from '../src/project/project-workspaces.js'
import type { InboxEvent, ExecutionContext } from '../src/core/domain.js'
import { sameExecutionContext } from '../src/task/task-lifecycle.js'
import { prefilterDecision } from '../src/router/prefilter.js'
import { DshCliExecutor } from '../src/executor/dsh-cli-executor.js'
import { assertRollbackCompatible } from '../src/supervisor/rollback-compatibility.js'
import { SelfChangeRoutingExecutor } from '../src/self-change/routing-executor.js'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pegas-project-')))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const store = new PegasStore(join(root, 'store.sqlite'))
  cleanup.push(() => store.close())
  store.registerExecutionNode({ id: 'local', label: 'Local' })
  const server = createControlPlane({ store })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () => new Promise<void>(resolve => server.close(() => resolve())),
  )
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const request = (path: string, body?: unknown, method = 'POST') =>
    fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const directory = join(root, 'project-a')
  mkdirSync(directory)
  const project = {
    id: 'project-a',
    userId: 'owner',
    name: 'Project A',
    nodeId: 'local',
    directory,
  }
  return { store, request, project, root }
}

it('registers an explicit project and snapshots its directory instead of the generic workspace', async () => {
  const { store, request, project } = await fixture()
  expect((await request('/v1/projects', project)).status).toBe(201)
  const response = await request('/v1/events', {
    userId: 'owner',
    source: 'web',
    type: 'user.message',
    payload: { text: 'Read project rules', projectId: project.id },
  })
  expect(response.status).toBe(202)
  const { event } = (await response.json()) as { event: InboxEvent }
  const { task, run } = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: 'Read rules',
      goal: 'Read rules',
      input: 'Read rules',
      reason: 'Explicit project',
    },
    'echo',
    { executor: 'echo', workspace: '/generic' },
  )
  expect(task).toMatchObject({
    projectId: project.id,
    workingDirectory: project.directory,
  })
  expect(run.executionContext).toMatchObject({
    workspace: project.directory,
    nodeId: 'local',
    project: { id: project.id },
  })
  expect(run.executionContractVersion).toBe(3)
  expect(store.claimNextRun('wrong-node', 30000, 'elsewhere')).toBeUndefined()
  expect(store.claimNextRun('right-node', 30000, 'local')?.run.id).toBe(run.id)
})

it('does not silently accept an unknown or foreign project in human input', async () => {
  const { request, project } = await fixture()
  await request('/v1/projects', project)
  for (const [userId, projectId] of [
    ['owner', 'missing'],
    ['other', project.id],
  ]) {
    expect(
      (
        await request('/v1/events', {
          userId,
          source: 'web',
          type: 'user.message',
          payload: { text: 'Change files', projectId },
        })
      ).status,
    ).toBe(400)
  }
})

it('supports ordinary document/photo folders without a project, Git or rules file', async () => {
  const { request, store, root } = await fixture()
  const directory = join(root, '照片')
  mkdirSync(directory)
  const response = await request('/v1/events', {
    userId: 'owner',
    source: 'web',
    type: 'user.message',
    payload: {
      text: '按日期整理照片',
      workspace: { directory, nodeId: 'local' },
    },
  })
  expect(response.status).toBe(202)
  const { event } = (await response.json()) as { event: InboxEvent }
  const decision = prefilterDecision(event, [], { chatLaneEnabled: true })
  if (!decision) throw new Error('Missing explicit directory routing')
  const { task, run } = store.applyRoutingDecision(event, decision, 'echo', {
    executor: 'echo',
    workspace: '/generic',
  })
  expect(task.projectId).toBeUndefined()
  expect(task.workingDirectory).toBe(directory)
  expect(run.executionContext).toMatchObject({
    workspace: directory,
    nodeId: 'local',
    workspaceBinding: { revision: 1 },
  })
  expect(run.executionContext.project).toBeUndefined()
  expect(run.executionContractVersion).toBe(3)
  expect(() => validateProjectWorkspace(run.executionContext)).not.toThrow()
  expect(store.listProjects('owner')).toEqual([])
  expect(store.claimNextEvent('old-worker', 30000, 4)).toBeUndefined()
})

it('keeps unbound ordinary conversation on the configured default workspace', async () => {
  const { store } = await fixture()
  const event = store.enqueueEvent({
    userId: 'owner',
    source: 'web',
    type: 'user.message',
    authenticatedActor: 'human',
    payload: { text: 'Discuss a plan' },
  }).event
  const { task, run } = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: 'Plan',
      goal: 'Plan',
      input: 'Plan',
      reason: 'New task',
    },
    'echo',
    { executor: 'echo', workspace: '/generic' },
  )
  expect(task.projectId).toBeUndefined()
  expect(task.workingDirectory).toBeUndefined()
  expect(run.executionContext.workspace).toBe('/generic')
  expect(run.executionContractVersion).toBe(1)
})

it('does not impose the self-change worktree workflow on an explicitly bound Pegas project', async () => {
  const { store, project } = await fixture()
  store.createProject(project)
  const event = store.enqueueEvent({
    userId: 'owner',
    source: 'web',
    type: 'user.message',
    authenticatedActor: 'human',
    payload: { text: 'Change this project', projectId: project.id },
  }).event
  const { task, run } = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: 'Change',
      goal: 'Change',
      input: 'Change',
      reason: 'Explicit project',
      targetResource: 'pegas_repository',
    },
    'echo',
    { executor: 'echo' },
  )
  const execute = vi.fn(() =>
    Promise.resolve({ executorRef: 'user-session', output: 'User workflow' }),
  )
  const selfChange = vi.fn(() =>
    Promise.resolve({ executorRef: 'self-session', output: 'Forced worktree' }),
  )
  const executor = new SelfChangeRoutingExecutor(
    store,
    { name: 'echo', execute },
    { name: 'self-change', execute: selfChange },
  )
  await executor.execute({
    taskId: task.id,
    runId: run.id,
    prompt: 'Change',
    workingDirectory: project.directory,
  })
  expect(execute).toHaveBeenCalledOnce()
  expect(selfChange).not.toHaveBeenCalled()
})

it('does not turn machine-supplied directory metadata into user authorization', async () => {
  const { store, project } = await fixture()
  store.createProject(project)
  for (const selection of [
    { projectId: project.id },
    { workspace: { directory: project.directory, nodeId: 'local' } },
  ]) {
    expect(() =>
      store.enqueueEvent({
        userId: 'owner',
        source: 'automation',
        type: 'user.message',
        payload: { text: 'Read files', ...selection },
      }),
    ).toThrow(/human/)
  }
})

it('makes project registration replayable without overwriting a different identity', async () => {
  const { request, project } = await fixture()
  expect((await request('/v1/projects', project)).status).toBe(201)
  expect((await request('/v1/projects', project)).status).toBe(200)
  expect(
    (await request('/v1/projects', { ...project, name: 'Different' })).status,
  ).toBe(400)
  expect(
    (await request('/v1/projects', { ...project, userId: 'other' })).status,
  ).toBe(400)
  expect(
    (await request('/v1/projects', { ...project, id: 'duplicate' })).status,
  ).toBe(400)
  expect(await (await request('/v1/projects?userId=other')).json()).toEqual({
    projects: [],
  })
})

it.each([
  { directory: 'relative', nodeId: 'local' },
  { directory: '/known/../other', nodeId: 'local' },
  { directory: '/unknown', nodeId: 'missing' },
])('rejects invalid explicit directory selection %j', async workspace => {
  const { request } = await fixture()
  expect(
    (
      await request('/v1/events', {
        userId: 'owner',
        source: 'web',
        type: 'user.message',
        payload: { text: 'Read files', workspace },
      })
    ).status,
  ).toBe(400)
})

it('persists user-selected task directories, rejects busy changes and rolls sessions on a change', async () => {
  const { store, request, project, root } = await fixture()
  await request('/v1/projects', project)
  const event = store.enqueueEvent({
    userId: 'owner',
    source: 'web',
    type: 'user.message',
    authenticatedActor: 'human',
    payload: { text: 'Work', projectId: project.id },
  }).event
  const first = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: 'Work',
      goal: 'Work',
      input: 'Work',
      reason: 'Project',
    },
    'echo',
    { executor: 'echo' },
  )
  const chosen = join(root, 'user-selected-worktree')
  mkdirSync(chosen)
  const url = `/v1/tasks/${first.task.id}/project?userId=owner`
  const update = {
    projectId: project.id,
    workingDirectory: chosen,
    expectedRevision: 1,
  }
  expect((await request(url, update, 'PUT')).status).toBe(400)
  const claimed = store.claimNextRun('worker', 30000, 'local')
  if (!claimed) throw new Error('Missing claim')
  store.completeRun(claimed.run.id, 'worker', {
    executorRef: 'old-session',
    output: 'Done',
  })
  expect((await request(url, update, 'PUT')).status).toBe(200)
  expect((await request(url, update, 'PUT')).status).toBe(200)
  expect(
    (
      await request(
        url,
        { ...update, workingDirectory: project.directory },
        'PUT',
      )
    ).status,
  ).toBe(400)
  expect(await (await request(url)).json()).toMatchObject({
    projectId: project.id,
    workingDirectory: chosen,
    revision: 2,
  })
  const nextEvent = store.enqueueEvent({
    userId: 'owner',
    source: 'web',
    type: 'user.message',
    authenticatedActor: 'human',
    payload: { text: 'Continue', taskId: first.task.id },
  }).event
  const next = store.applyRoutingDecision(
    nextEvent,
    {
      kind: 'continue_task',
      taskId: first.task.id,
      input: 'Continue',
      reason: 'Explicit',
    },
    'echo',
    { executor: 'echo' },
  )
  expect(next.run.executionContext.workspace).toBe(chosen)
  expect(next.run.resumeFromRef).toBeUndefined()
  expect(
    sameExecutionContext(
      first.run.executionContext,
      JSON.parse(
        JSON.stringify(first.run.executionContext),
      ) as ExecutionContext,
    ),
  ).toBe(true)
  expect(
    sameExecutionContext(first.run.executionContext, next.run.executionContext),
  ).toBe(false)
})

it('fails before launching a model when the selected directory is missing or has changed to a symlink', async () => {
  const { root, project } = await fixture()
  const link = join(root, 'alias')
  symlinkSync(project.directory, link)
  for (const workspace of [link, join(root, 'missing')]) {
    const executor = new DshCliExecutor({ command: '/must-not-launch' })
    await expect(
      executor.execute({
        taskId: 'task',
        runId: 'run',
        prompt: 'Work',
        workingDirectory: workspace,
        executionContext: {
          executor: 'dsh-headless',
          nodeId: 'local',
          workspace,
          workspaceBinding: { revision: 1 },
        },
      }),
    ).rejects.toThrow(/canonical|ENOENT/)
  }
})

it('blocks rollback of pending directory inputs even before a Task exists', async () => {
  const { store, root, project } = await fixture()
  store.enqueueEvent({
    userId: 'owner',
    source: 'web',
    type: 'user.message',
    authenticatedActor: 'human',
    payload: {
      text: 'Read documents',
      workspace: { directory: project.directory, nodeId: 'local' },
    },
  })
  expect(() =>
    assertRollbackCompatible(join(root, 'store.sqlite'), 60, 1),
  ).toThrow(/workspace contract/)
  expect(() =>
    assertRollbackCompatible(join(root, 'store.sqlite'), 61, 1),
  ).not.toThrow()
})

it('restores project membership and directory state after reopening the database', async () => {
  const { store, root, project } = await fixture()
  store.createProject(project)
  const event = store.enqueueEvent({
    userId: 'owner',
    source: 'web',
    type: 'user.message',
    authenticatedActor: 'human',
    payload: { text: 'Read', projectId: project.id },
  }).event
  const created = store.applyRoutingDecision(
    event,
    {
      kind: 'create_task',
      title: 'Read',
      goal: 'Read',
      input: 'Read',
      reason: 'Project',
    },
    'echo',
    { executor: 'echo' },
  )
  const recovered = new PegasStore(join(root, 'store.sqlite'))
  try {
    expect(
      recovered.taskProjectBinding(created.task.id, 'owner'),
    ).toMatchObject({
      projectId: project.id,
      workingDirectory: project.directory,
      nodeId: 'local',
      revision: 1,
    })
    expect(recovered.listRuns(created.task.id)[0]?.executionContext).toEqual(
      created.run.executionContext,
    )
  } finally {
    recovered.close()
  }
})
