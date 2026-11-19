export const workerIconIds = ['car', 'camera', 'computer', 'phone'] as const

export type WorkerIconId = (typeof workerIconIds)[number]

/**
 * Assigns a stable visual identity when a Channel is created.
 *
 * The selected ID is persisted on the Task. Expanding the registry therefore
 * affects only newly created Channels and never changes an existing identity.
 */
export function assignWorkerIconId(taskId: string): WorkerIconId {
  let hash = 2_166_136_261
  for (let index = 0; index < taskId.length; index += 1) {
    hash ^= taskId.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return workerIconIds[(hash >>> 0) % workerIconIds.length] ?? 'computer'
}

export function isWorkerIconId(value: string): value is WorkerIconId {
  return workerIconIds.some(iconId => iconId === value)
}
