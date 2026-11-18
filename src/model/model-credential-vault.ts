import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const version = 'v1'
const algorithm = 'aes-256-gcm'

export class ModelCredentialVault {
  readonly #key: Buffer

  constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new Error('Model credential key must contain exactly 32 bytes')
    }
    this.#key = Buffer.from(key)
  }

  encrypt(value: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv(algorithm, this.#key, iv)
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()
    return [version, iv, tag, encrypted]
      .map(part =>
        typeof part === 'string' ? part : part.toString('base64url'),
      )
      .join('.')
  }

  decrypt(value: string): string {
    const [storedVersion, encodedIv, encodedTag, encodedValue, extra] =
      value.split('.')
    if (
      storedVersion !== version ||
      !encodedIv ||
      !encodedTag ||
      !encodedValue ||
      extra
    ) {
      throw new Error('Unsupported or malformed model credential')
    }
    const decipher = createDecipheriv(
      algorithm,
      this.#key,
      Buffer.from(encodedIv, 'base64url'),
    )
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(encodedValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  }
}

export function loadModelCredentialVault(path: string): ModelCredentialVault {
  mkdirSync(dirname(path), { recursive: true })
  let key: Buffer
  try {
    key = readFileSync(path)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    key = randomBytes(32)
    try {
      writeFileSync(path, key, { flag: 'wx', mode: 0o600 })
    } catch (writeError) {
      if (!isNodeError(writeError) || writeError.code !== 'EEXIST') {
        throw writeError
      }
      key = readFileSync(path)
    }
  }
  return new ModelCredentialVault(key)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
