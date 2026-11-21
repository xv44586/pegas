import { describe, expect, it, vi } from 'vitest'

import { performRollbackTransition } from '../src/supervisor/rollback-transition.js'

describe('rollback transition', () => {
  it('stops writers before the final compatibility check and release switch', async () => {
    const order: string[] = []
    const result = await performRollbackTransition({
      stopChildren: () => {
        order.push('stop')
        return Promise.resolve()
      },
      assertRollbackAllowed: () => {
        order.push('check')
      },
      rollback: () => {
        order.push('rollback')
        return 'previous-release'
      },
      requestRestart: () => {
        order.push('restart')
      },
    })

    expect(result).toBe('previous-release')
    expect(order).toEqual(['restart', 'stop', 'check', 'rollback'])
  })

  it('restarts the unchanged release when the post-quiescence check fails', async () => {
    const order: string[] = []
    const rollback = vi.fn()
    await expect(
      performRollbackTransition({
        stopChildren: () => {
          order.push('stop')
          return Promise.resolve()
        },
        assertRollbackAllowed: () => {
          order.push('check')
          throw new Error('live state appeared before quiescence')
        },
        rollback,
        requestRestart: () => {
          order.push('restart')
        },
      }),
    ).rejects.toThrow('live state appeared before quiescence')

    expect(rollback).not.toHaveBeenCalled()
    expect(order).toEqual(['restart', 'stop', 'check'])
  })
})
