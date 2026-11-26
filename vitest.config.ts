import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
import { liveTestInclude } from './test/support/test-suites.js'

export const testInclude = [
  'test/**/*.test.ts',
  'web/src/**/*.test.{ts,tsx}',
] as const

export default defineConfig({
  resolve: {
    alias: {
      '@bui': fileURLToPath(new URL('./web/src/bui', import.meta.url)),
    },
  },
  test: {
    include: [...testInclude],
    exclude: [...configDefaults.exclude, ...liveTestInclude],
    setupFiles: ['./test/support/offline-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts', 'web/src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/main.ts',
        'src/core/domain.ts',
        'src/executor/executor.ts',
        'src/model/provider.ts',
        'src/notification/channel.ts',
        'web/src/main.tsx',
        'web/src/types.ts',
      ],
      thresholds: {
        statements: 60,
        branches: 55,
        functions: 60,
        lines: 65,
      },
    },
  },
})
