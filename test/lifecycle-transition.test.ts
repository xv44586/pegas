import { describe, expect, it, vi } from 'vitest'

import { LifecycleTransitionBarrier } from '../src/supervisor/lifecycle-transition.js'

describe('supervisor lifecycle transition barrier', () => {
  it('blocks the main loop and rejects overlapping transitions until quiescence completes', async () => {
    const barrier = new LifecycleTransitionBarrier()
    let release: (() => void) | undefined
    const action = vi.fn(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        }),
    )

    const transition = barrier.begin(action)
    const waiting = barrier.wait()
    let mainLoopReleased = false
    void waiting.then(() => {
      mainLoopReleased = true
    })
    await Promise.resolve()

    expect(action).toHaveBeenCalledOnce()
    expect(mainLoopReleased).toBe(false)
    await expect(barrier.begin(() => Promise.resolve())).rejects.toThrow(
      'already in progress',
    )

    release?.()
    await Promise.all([transition, waiting])
    expect(mainLoopReleased).toBe(true)
    await expect(
      barrier.begin(() => Promise.resolve()),
    ).resolves.toBeUndefined()
  })

  it('releases the main loop after a failed transition without hiding it from the caller', async () => {
    const barrier = new LifecycleTransitionBarrier()
    const transition = barrier.begin(() =>
      Promise.reject(new Error('rollback incompatible')),
    )

    await barrier.wait()
    await expect(transition).rejects.toThrow('rollback incompatible')
    await expect(
      barrier.begin(() => Promise.resolve()),
    ).resolves.toBeUndefined()
  })
})
