import { describe, expect, it } from 'vitest'

import {
  assignWorkerIconId,
  isWorkerIconId,
  workerIconIds,
} from '../src/brand/agent-icon.js'

describe('worker icon assignment', () => {
  it('assigns only Pegas worker icons deterministically', () => {
    const first = assignWorkerIconId('task-stable')

    expect(workerIconIds).toContain(first)
    expect(assignWorkerIconId('task-stable')).toBe(first)
    expect(isWorkerIconId(first)).toBe(true)
    expect(isWorkerIconId('bot')).toBe(false)
    expect(isWorkerIconId('whale')).toBe(false)
  })

  it('distributes a growing channel list across the available icon set', () => {
    const assigned = new Set(
      Array.from({ length: 64 }, (_, index) =>
        assignWorkerIconId(`channel-${String(index)}`),
      ),
    )

    expect(assigned).toEqual(new Set(workerIconIds))
  })
})
