import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

/** Shared by builders, dependency materialization, staging and retention. */
export function acquireReleaseDirectoryLock(root: string): () => void {
  mkdirSync(root, { recursive: true })
  const path = join(resolve(root), '.release-directory.lock')
  const owner = JSON.stringify({
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  })
  let descriptor: number
  try {
    descriptor = openSync(path, 'wx', 0o600)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error(
        'Release maintenance or cleanup is running; an abandoned lock requires explicit recovery',
        { cause: error },
      )
    throw error
  }
  try {
    writeFileSync(descriptor, owner)
  } finally {
    closeSync(descriptor)
  }
  const inode = lstatSync(path).ino
  return () => {
    if (
      existsSync(path) &&
      lstatSync(path).ino === inode &&
      readFileSync(path, 'utf8') === owner
    )
      unlinkSync(path)
  }
}
export async function withReleaseDirectoryLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = acquireReleaseDirectoryLock(root)
  try {
    return await operation()
  } finally {
    release()
  }
}
