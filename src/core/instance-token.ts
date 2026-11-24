import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export function ensureInstanceBearer({
  dataDir,
  environment,
}: {
  dataDir: string
  environment: NodeJS.ProcessEnv
}): string {
  const configured = environment.PEGAS_API_TOKEN?.trim()
  if (configured) return configured
  const tokenPath = join(dataDir, 'api-token')
  mkdirSync(dataDir, { recursive: true })
  const existing = readPersistedToken(tokenPath)
  if (existing) {
    environment.PEGAS_API_TOKEN = existing
    return existing
  }
  const generated = randomBytes(32).toString('base64url')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(tokenPath, `${generated}\n`, { flag: 'wx', mode: 0o600 })
      environment.PEGAS_API_TOKEN = generated
      return generated
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const winner = readPersistedToken(tokenPath)
      if (winner) {
        environment.PEGAS_API_TOKEN = winner
        return winner
      }
      unlinkSync(tokenPath)
    }
  }
  throw new Error(`Instance bearer file ${tokenPath} could not be initialized`)
}

function readPersistedToken(tokenPath: string): string | undefined {
  let contents: string
  try {
    contents = readFileSync(tokenPath, 'utf8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!contents) return undefined
  if ((statSync(tokenPath).mode & 0o777) !== 0o600) {
    chmodSync(tokenPath, 0o600)
  }
  return contents
}
