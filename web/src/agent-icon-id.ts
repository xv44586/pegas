import type { WorkerIconId } from './types'

const workerIconIds: readonly WorkerIconId[] = [
  'car',
  'camera',
  'computer',
  'phone',
]

export function fallbackWorkerIconId(taskId: string): WorkerIconId {
  let hash = 2_166_136_261
  for (let index = 0; index < taskId.length; index += 1) {
    hash ^= taskId.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return workerIconIds[(hash >>> 0) % workerIconIds.length] ?? 'computer'
}

export function isWorkerIconId(value: unknown): value is WorkerIconId {
  return (
    typeof value === 'string' && workerIconIds.some(iconId => iconId === value)
  )
}
