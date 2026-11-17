import { describe, expect, it } from 'vitest'

import {
  assertRuntimeSettingsAvailable,
  parseRuntimeSettingsUpdate,
} from '../src/settings/runtime-settings.js'

const defaults = {
  routerMode: 'model' as const,
  modelProvider: 'codex-cli' as const,
  modelName: 'gpt-test',
  privacyMode: 'disabled' as const,
  rewriteMode: 'disabled' as const,
}

describe('runtime settings validation', () => {
  it('rejects unavailable providers and privacy before persistence', () => {
    const capabilities = {
      providers: [
        { id: 'codex-cli' as const, available: true },
        {
          id: 'openai-compatible' as const,
          available: false,
          reason: 'Provider is not configured',
        },
      ],
      privacyAvailable: false,
    }

    expect(() =>
      parseRuntimeSettingsUpdate(
        {
          ...defaults,
          expectedRevision: 1,
          modelProvider: 'openai-compatible',
        },
        capabilities,
      ),
    ).toThrow('Provider is not configured')
    expect(() =>
      assertRuntimeSettingsAvailable(
        { ...defaults, privacyMode: 'mask' },
        capabilities,
      ),
    ).toThrow('隐私 HMAC key')
  })

  it('accepts a complete selection when server capabilities are present', () => {
    const capabilities = {
      providers: [{ id: 'codex-cli' as const, available: true }],
      privacyAvailable: true,
    }

    expect(
      parseRuntimeSettingsUpdate(
        {
          ...defaults,
          expectedRevision: 2,
          privacyMode: 'mask',
          rewriteMode: 'light',
        },
        capabilities,
      ),
    ).toEqual({
      expectedRevision: 2,
      settings: { ...defaults, privacyMode: 'mask', rewriteMode: 'light' },
    })
  })
})
