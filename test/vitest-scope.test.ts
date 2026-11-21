import { describe, expect, it } from 'vitest'

import { testInclude } from '../vitest.config.js'

describe('Vitest workspace scope', () => {
  it('only discovers Pegas-owned test suites', () => {
    expect(testInclude).toEqual([
      'test/**/*.test.ts',
      'web/src/**/*.test.{ts,tsx}',
    ])
  })
})
