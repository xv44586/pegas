import { describe, expect, it } from 'vitest'

import { ModelCredentialVault } from '../src/model/model-credential-vault.js'

describe('ModelCredentialVault', () => {
  it('encrypts provider keys with authenticated encryption', () => {
    const vault = new ModelCredentialVault(Buffer.alloc(32, 7))
    const encrypted = vault.encrypt('provider-secret')

    expect(encrypted).not.toContain('provider-secret')
    expect(vault.decrypt(encrypted)).toBe('provider-secret')
    const parts = encrypted.split('.')
    const encodedTag = parts[2]
    if (!encodedTag) throw new Error('Encrypted credential has no auth tag')
    const tag = Buffer.from(encodedTag, 'base64url')
    tag.writeUInt8(tag.readUInt8(0) ^ 1, 0)
    parts[2] = tag.toString('base64url')
    expect(() => vault.decrypt(parts.join('.'))).toThrow()
  })
})
