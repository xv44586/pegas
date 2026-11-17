import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
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
