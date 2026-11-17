import { describe, expect, it } from 'vitest'

import type { InboxEvent, Task } from '../src/core/domain.js'
import type { JsonModelProvider } from '../src/model/provider.js'
import { ModelTaskRouter } from '../src/router/router.js'

describe('ModelTaskRouter', () => {
  it('uses the model for the first message even without candidate tasks', async () => {
    const provider = new StubProvider({
      kind: 'create_task',
      taskId: '',
      title: 'First model task',
      goal: 'Create the first task through the model router.',
      reason: 'This is a new goal.',
    })
    const router = new ModelTaskRouter({ provider })

    const decision = await router.route(message('Start something new'), [])

    expect(decision).toMatchObject({
      kind: 'create_task',
      title: 'First model task',
    })
    expect(provider.calls).toBe(1)
  })

  it('continues a model-selected active task', async () => {
    const provider = new StubProvider({
      kind: 'continue_task',
      taskId: 'task-1',
      reason: 'It adds to the recovery work.',
    })
    const router = new ModelTaskRouter({ provider })

    const decision = await router.route(message('Add a rollback test'), [
      task('task-1', 'Build self recovery'),
    ])

    expect(decision).toEqual({
      kind: 'continue_task',
      taskId: 'task-1',
      input: 'Add a rollback test',
      reason: 'It adds to the recovery work.',
    })
    expect(provider.calls).toBe(1)
  })

  it('falls back to a new task when the model selects an unknown task', async () => {
    const provider = new StubProvider({
      kind: 'continue_task',
      taskId: 'invented',
      reason: 'guess',
    })
    const router = new ModelTaskRouter({ provider })

    const decision = await router.route(message('Research a new idea'), [
      task('task-1', 'Build self recovery'),
    ])

    expect(decision).toMatchObject({
      kind: 'create_task',
      title: 'Research a new idea',
      goal: 'Research a new idea',
    })
  })

  it('honors an explicit task without calling the model', async () => {
    const provider = new StubProvider({})
    const router = new ModelTaskRouter({ provider })

    const decision = await router.route(
      message('Continue here', { taskId: 'task-1' }),
      [task('task-1', 'Existing task')],
    )

    expect(decision).toMatchObject({
      kind: 'continue_task',
      taskId: 'task-1',
    })
    expect(provider.calls).toBe(0)
  })
})

class StubProvider implements JsonModelProvider {
  readonly name = 'stub'
  calls = 0
  readonly #answer: unknown

  constructor(answer: unknown) {
    this.#answer = answer
  }

  generateJson(): Promise<unknown> {
    this.calls += 1
    return Promise.resolve(this.#answer)
  }
}

function message(
  text: string,
  extra: Record<string, unknown> = {},
): InboxEvent {
  return {
    id: 'event-1',
    userId: 'user-1',
    type: 'user.message',
    source: 'web',
    payload: { text, ...extra },
    status: 'pending',
    attempts: 0,
    createdAt: '2026-11-17T00:00:00.000Z',
  }
}

function task(id: string, title: string): Task {
  return {
    id,
    userId: 'user-1',
    originEventId: 'origin-1',
    title,
    goal: title,
    status: 'waiting',
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
  }
}
