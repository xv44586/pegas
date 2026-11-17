import { describe, expect, it } from 'vitest'

import { DeterministicPrivacyMasker } from '../src/privacy/masker.js'

const hmacKey = ['privacy', 'test', 'key', 'value', '2026'].join('-')

describe('DeterministicPrivacyMasker', () => {
  it('masks high-confidence values, restores them, and exposes no raw hits', () => {
    const masker = new DeterministicPrivacyMasker({ hmacKey })
    const apiKey = ['sk', 'proj', 'A'.repeat(24)].join('-')
    const password = ['correct', 'horse', 'battery', 'staple'].join('-')
    const email = ['ming', 'pegas.dev'].join('@')
    const phone = ['138', '0013', '8000'].join('')
    const original = [
      `api_key=${apiKey}`,
      `password=${password}`,
      `contact=${email}`,
      `phone=${phone}`,
    ].join('\n')

    const masked = masker.mask(original)

    expect(masked.text).not.toContain(apiKey)
    expect(masked.text).not.toContain(password)
    expect(masked.text).not.toContain(email)
    expect(masked.text).not.toContain(phone)
    expect(masked.hits.map(hit => hit.kind)).toEqual([
      'API_KEY',
      'PASSWORD',
      'EMAIL',
      'PHONE',
    ])
    expect(JSON.stringify(masked.hits)).not.toContain(password)
    expect(masker.restore(masked.text)).toBe(original)
  })

  it('keeps placeholders stable and masks a known value in later context', () => {
    const value = ['ghp', 'B'.repeat(32)].join('_')
    const first = new DeterministicPrivacyMasker({ hmacKey })
    const second = new DeterministicPrivacyMasker({ hmacKey })
    const firstMask = first.mask(value).text

    expect(second.mask(value).text).toBe(firstMask)
    expect(first.mask(`Use it again: ${value}`).text).toBe(
      `Use it again: ${firstMask}`,
    )
  })

  it('leaves documentation emails and unknown placeholders unchanged', () => {
    const masker = new DeterministicPrivacyMasker({ hmacKey })
    const text = 'docs@example.com and {{EMAIL_unknownvalue}}'

    expect(masker.mask(text)).toEqual({ text, hits: [] })
    expect(masker.restore(text)).toBe(text)
  })

  it('requires a sufficiently long HMAC key', () => {
    expect(() => new DeterministicPrivacyMasker({ hmacKey: 'short' })).toThrow(
      'at least 16 characters',
    )
  })
})
