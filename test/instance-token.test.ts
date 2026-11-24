import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../src/core/config.js'
import { ensureInstanceBearer } from '../src/core/instance-token.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function dataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pegas-instance-token-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('instance bearer bootstrap', () => {
  it('generates a persistent 0600 bearer when no token is configured', () => {
    const dataDir = dataDirectory()
    const environment: NodeJS.ProcessEnv = { PEGAS_DATA_DIR: dataDir }
    const token = ensureInstanceBearer({ dataDir, environment })
    expect(token).toMatch(/^[\w-]{43}$/)
    expect(environment.PEGAS_API_TOKEN).toBe(token)
    const tokenPath = join(dataDir, 'api-token')
    expect(readFileSync(tokenPath, 'utf8').trim()).toBe(token)
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
    expect(loadConfig(environment).apiToken).toBe(token)
  })

  it('reuses the persisted bearer across restarts', () => {
    const dataDir = dataDirectory()
    const first = ensureInstanceBearer({
      dataDir,
      environment: { PEGAS_DATA_DIR: dataDir },
    })
    const secondEnvironment: NodeJS.ProcessEnv = { PEGAS_DATA_DIR: dataDir }
    const second = ensureInstanceBearer({
      dataDir,
      environment: secondEnvironment,
    })
    expect(second).toBe(first)
    expect(secondEnvironment.PEGAS_API_TOKEN).toBe(first)
  })

  it('keeps an explicitly configured token and never overwrites it', () => {
    const dataDir = dataDirectory()
    const environment: NodeJS.ProcessEnv = {
      PEGAS_DATA_DIR: dataDir,
      PEGAS_API_TOKEN: 'explicit-operator-token',
    }
    const token = ensureInstanceBearer({ dataDir, environment })
    expect(token).toBe('explicit-operator-token')
    expect(environment.PEGAS_API_TOKEN).toBe('explicit-operator-token')
    expect(() => readFileSync(join(dataDir, 'api-token'))).toThrow()
  })

  it('replaces an empty or corrupted token file instead of failing open', () => {
    const dataDir = dataDirectory()
    const tokenPath = join(dataDir, 'api-token')
    writeFileSync(tokenPath, '   \n', { mode: 0o600 })
    const token = ensureInstanceBearer({
      dataDir,
      environment: { PEGAS_DATA_DIR: dataDir },
    })
    expect(token).toMatch(/^[\w-]{43}$/)
    expect(readFileSync(tokenPath, 'utf8').trim()).toBe(token)
    chmodSync(tokenPath, 0o644)
    ensureInstanceBearer({
      dataDir,
      environment: { PEGAS_DATA_DIR: dataDir },
    })
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
  })

  it('fails loudly when the token file cannot be written', () => {
    const dataDir = dataDirectory()
    chmodSync(dataDir, 0o555)
    try {
      expect(() =>
        ensureInstanceBearer({
          dataDir,
          environment: { PEGAS_DATA_DIR: dataDir },
        }),
      ).toThrow()
    } finally {
      chmodSync(dataDir, 0o755)
    }
  })

  it.skipIf(!existsSync(resolve('dist/control-plane/main.js')))(
    'bootstraps a usable bearer in a bare control-plane process without PEGAS_API_TOKEN',
    async () => {
      const dataDir = dataDirectory()
      const port = 40000 + Math.floor(Math.random() * 20000)
      const environment = { ...process.env }
      delete environment.PEGAS_API_TOKEN
      const child: ChildProcess = spawn(
        process.execPath,
        [resolve('dist/control-plane/main.js')],
        {
          env: {
            ...environment,
            PEGAS_API_HOST: '127.0.0.1',
            PEGAS_API_PORT: String(port),
            PEGAS_DATA_DIR: dataDir,
            PEGAS_EXECUTOR: 'echo',
            PEGAS_SPEECH_PROVIDER: 'disabled',
            PEGAS_PUSH_MODE: 'disabled',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      const baseUrl = `http://127.0.0.1:${String(port)}`
      let stderrText = ''
      child.stderr?.on('data', chunk => {
        stderrText += String(chunk)
      })
      try {
        let ready = false
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            const response = await fetch(`${baseUrl}/readyz`)
            if (response.ok) {
              ready = true
              break
            }
          } catch {
            // not listening yet
          }
          await new Promise(resolveSleep => setTimeout(resolveSleep, 100))
        }
        if (!ready) throw new Error(`not ready: ${stderrText}`)
        expect(ready).toBe(true)
        const token = readFileSync(join(dataDir, 'api-token'), 'utf8').trim()
        expect(token).toMatch(/^[\w-]{43}$/)
        const noCredential = await fetch(
          `${baseUrl}/v1/approvals?userId=owner&limit=1`,
        )
        expect(noCredential.status).toBe(401)
        const withToken = await fetch(
          `${baseUrl}/v1/approvals?userId=owner&limit=1`,
          { headers: { authorization: `Bearer ${token}` } },
        )
        expect(withToken.status).toBe(200)
        const tasksWithoutCredential = await fetch(
          `${baseUrl}/v1/tasks?userId=owner`,
        )
        expect(tasksWithoutCredential.status).toBe(401)
        const tasksWithToken = await fetch(`${baseUrl}/v1/tasks?userId=owner`, {
          headers: { authorization: `Bearer ${token}` },
        })
        expect(tasksWithToken.status).toBe(200)
      } finally {
        child.kill('SIGTERM')
        await new Promise(resolveExit => child.once('exit', resolveExit))
      }
    },
    30_000,
  )
})
