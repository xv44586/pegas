import { describe, expect, it } from 'vitest'

import { ModelCredentialVault } from '../src/model/model-credential-vault.js'

describe('ModelCredentialVault', () => {
  it('encrypts provider keys with authenticated encryption', () => {
    const vault = new ModelCredentialVault(Buffer.alloc(32, 7))
    const encrypted = vault.encrypt('provider-secret')

    expect(encrypted).not.toContain('provider-secret')
    expect(vault.decrypt(encrypted)).toBe('provider-secret')
    expect(() => vault.decrypt(`${encrypted.slice(0, -1)}x`)).toThrow()
  })
})
