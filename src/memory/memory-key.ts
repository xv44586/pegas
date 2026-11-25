import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * MEMORY-001 M2: the local provider needs a stable owner/workspace HMAC key
 * but must not require user configuration. Follows the credential-vault
 * pattern: explicit environment key wins; otherwise a random key is created
 * once under the data directory (0600) and reused across restarts. The key
 * never leaves the machine in local mode.
 */
export function loadMemoryKey(
  path: string,
  explicitKey: string | undefined,
): string {
  if (explicitKey?.trim()) return explicitKey
  mkdirSync(dirname(path), { recursive: true })
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing) return existing
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  }
  const key = randomBytes(32).toString('hex')
  try {
    writeFileSync(path, key, { flag: 'wx', mode: 0o600 })
    return key
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error
    return readFileSync(path, 'utf8').trim()
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
