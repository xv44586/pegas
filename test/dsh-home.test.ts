import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createDshModelConfiguration,
  ensureDshProfileHome,
  modelKeyEnvironmentName,
} from '../src/executor/dsh-home.js'
import { ModelCredentialVault } from '../src/model/model-credential-vault.js'
import type { ModelProviderConnection } from '../src/settings/runtime-settings.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function connection(
  overrides: Partial<ModelProviderConnection> = {},
): ModelProviderConnection {
  return {
    id: 'magpie',
    name: 'Magpie',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:3425/v1',
    updatedAt: '2026-11-22T00:00:00.000Z',
    ...overrides,
  }
}

describe('ensureDshProfileHome', () => {
  it('initializes an isolated headless profile skeleton', () => {
    const home = join(temporaryDirectory('pegas-dsh-home-'), 'dsh')
    ensureDshProfileHome(home, 'headless')
    const profileDirectory = join(home, 'profiles', 'headless')
    const manifest = JSON.parse(
      readFileSync(join(profileDirectory, 'package.json'), 'utf8'),
    ) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-headless',
    ])
    expect(readFileSync(join(profileDirectory, 'cordis.yml'), 'utf8')).toBe(
      '[]\n',
    )
    expect(
      readFileSync(join(profileDirectory, 'cordis.patch.yml'), 'utf8'),
    ).toBe('[]\n')
    expect(
      readFileSync(join(profileDirectory, 'pnpm-workspace.yaml'), 'utf8'),
    ).toContain('nodeLinker: hoisted')
    expect(statSync(join(profileDirectory, 'package.json')).mode & 0o777).toBe(
      0o600,
    )
  })

  it('is idempotent and never rewrites an existing profile', () => {
    const home = join(temporaryDirectory('pegas-dsh-home-'), 'dsh')
    ensureDshProfileHome(home, 'headless')
    const patchPath = join(home, 'profiles', 'headless', 'cordis.patch.yml')
    writeFileSync(patchPath, '- id: user-own-patch\n')
    ensureDshProfileHome(home, 'headless')
    expect(readFileSync(patchPath, 'utf8')).toBe('- id: user-own-patch\n')
  })
})

describe('createDshModelConfiguration', () => {
  const vault = new ModelCredentialVault(Buffer.alloc(32, 7))

  it('builds provider directory and default model from Pegas connections', () => {
    const configuration = createDshModelConfiguration({
      connections: [
        connection({ apiKeyCiphertext: vault.encrypt('magpie-secret') }),
        connection({
          id: 'anthropic',
          name: 'Anthropic',
          protocol: 'anthropic-messages',
          baseUrl: 'https://api.anthropic.com',
          apiKeyCiphertext: vault.encrypt('anthropic-secret'),
        }),
      ],
      vault,
      agentModel: { provider: 'magpie', model: 'gateway/model-a' },
    })
    try {
      const entries = JSON.parse(
        readFileSync(configuration.patchPath, 'utf8'),
      ) as { id: string; config: Record<string, unknown> }[]
      expect(entries.map(entry => entry.id)).toEqual([
        'llm-pi-ai',
        'agent-default-model',
      ])
      expect(entries[1]?.config).toEqual({
        provider: 'magpie',
        model: 'gateway/model-a',
      })
      const providers = (entries[0]?.config.providers ?? {}) as Record<
        string,
        {
          api: string
          baseURL: string
          apiKeyEnv: string
          models: { id: string }[]
        }
      >
      expect(providers.magpie).toMatchObject({
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:3425/v1',
        apiKeyEnv: 'PEGAS_DSH_MODEL_KEY_MAGPIE',
        models: [{ id: 'gateway/model-a', input: ['text', 'image'] }],
      })
      expect(providers.anthropic).toMatchObject({
        api: 'anthropic-messages',
        baseURL: 'https://api.anthropic.com',
        apiKeyEnv: 'PEGAS_DSH_MODEL_KEY_ANTHROPIC',
      })
      expect(configuration.environment).toEqual({
        PEGAS_DSH_MODEL_KEY_MAGPIE: 'magpie-secret',
        PEGAS_DSH_MODEL_KEY_ANTHROPIC: 'anthropic-secret',
      })
      expect(readFileSync(configuration.patchPath, 'utf8')).not.toContain(
        'magpie-secret',
      )
      expect(statSync(configuration.patchPath).mode & 0o777).toBe(0o600)
    } finally {
      configuration.remove()
    }
    expect(existsSync(configuration.patchPath)).toBe(false)
  })

  it('fails closed when the selected provider has no Pegas connection', () => {
    expect(() =>
      createDshModelConfiguration({
        connections: [connection()],
        vault,
        agentModel: { provider: 'openai', model: 'gpt-5-mini' },
      }),
    ).toThrow('尚未配置模型服务「openai」')
  })

  it('omits key environment entries for connections without credentials', () => {
    const configuration = createDshModelConfiguration({
      connections: [connection()],
      vault,
      agentModel: { provider: 'magpie', model: 'gateway/model-a' },
    })
    try {
      expect(configuration.environment).toEqual({})
      const entries = JSON.parse(
        readFileSync(configuration.patchPath, 'utf8'),
      ) as { id: string; config: Record<string, unknown> }[]
      const providers = (entries[0]?.config.providers ?? {}) as Record<
        string,
        Record<string, unknown>
      >
      expect(providers.magpie).not.toHaveProperty('apiKeyEnv')
      expect(providers.magpie).toMatchObject({
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:3425/v1',
      })
    } finally {
      configuration.remove()
    }
  })

  it('normalizes provider ids into environment-safe key names', () => {
    expect(modelKeyEnvironmentName('magpie')).toBe('PEGAS_DSH_MODEL_KEY_MAGPIE')
    expect(modelKeyEnvironmentName('openai-compatible.custom')).toBe(
      'PEGAS_DSH_MODEL_KEY_OPENAI_COMPATIBLE_CUSTOM',
    )
  })
})
