import { defineConfig } from 'vitest/config'
import { liveTestInclude } from './test/support/test-suites.js'

// Do not inherit the ordinary test setup or its coverage gate.
export default defineConfig({
  test: {
    include: [...liveTestInclude],
    fileParallelism: false,
    retry: 0,
  },
})
