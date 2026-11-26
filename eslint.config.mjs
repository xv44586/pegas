import eslint from '@eslint/js'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'data/**',
      'dist/**',
      'node_modules/**',
      'releases/**',
      'research/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: false },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['web/src/bui/components/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
    },
  },
  {
    files: ['web/vite.config.ts'],
    languageOptions: {
      parserOptions: {
        project: './web/tsconfig.node.json',
        projectService: false,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/desktop/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './desktop/tsconfig.json',
        projectService: false,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/executor/**/*.ts'],
    ignores: ['src/executor/dsh-node-runtime.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name='process'][property.name='execPath']",
          message:
            'EXEC-007: Use dshLaunch; the host executable may be Electron.',
        },
        {
          selector:
            "MemberExpression[object.name='process'][property.value='execPath']",
          message:
            'EXEC-007: Use dshLaunch; the host executable may be Electron.',
        },
        {
          selector:
            "CallExpression[callee.name=/^(spawn|spawnSync|execFile|execFileSync)$/] > Literal[value='dsh']",
          message: 'EXEC-007: Resolve DSH through dshLaunch before spawning.',
        },
      ],
    },
  },
  prettier,
)
