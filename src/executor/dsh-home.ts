import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ModelCredentialVault } from '../model/model-credential-vault.js'
import { modelProviderPresets } from '../model/provider-catalog.js'
import type { ModelProviderConnection } from '../settings/runtime-settings.js'

export interface DshAgentModel {
  provider: string
  model: string
}

export interface DshModelConfiguration {
  patchPath: string
  environment: NodeJS.ProcessEnv
  remove: () => void
}

export function ensureDshProfileHome(home: string, profile: string): void {
  const profileDirectory = join(home, 'profiles', profile)
  const packagePath = join(profileDirectory, 'package.json')
  if (existsSync(packagePath)) return
  mkdirSync(profileDirectory, { recursive: true, mode: 0o700 })
  writeFileSync(
    packagePath,
    `${JSON.stringify(
      {
        name: `pegas-dsh-profile-${profile}`,
        private: true,
        dependencies: {},
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  writeFileSync(
    join(profileDirectory, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    { mode: 0o600 },
  )
  writeFileSync(join(profileDirectory, 'cordis.yml'), '[]\n', { mode: 0o600 })
  writeFileSync(join(profileDirectory, 'cordis.patch.yml'), '[]\n', {
    mode: 0o600,
  })
}

export function createDshModelConfiguration(options: {
  connections: readonly ModelProviderConnection[]
  vault: Pick<ModelCredentialVault, 'decrypt'>
  agentModel: DshAgentModel
}): DshModelConfiguration {
  const selected = options.connections.find(
    connection => connection.id === options.agentModel.provider,
  )
  if (!selected) {
    throw new Error(
      `Pegas 尚未配置模型服务「${options.agentModel.provider}」的连接，请先在设置中保存该服务的地址与凭证`,
    )
  }
  const environment: NodeJS.ProcessEnv = {}
  const providers: Record<string, unknown> = {}
  for (const connection of options.connections) {
    const keyEnvironment = modelKeyEnvironmentName(connection.id)
    const apiKey = connection.apiKeyCiphertext
      ? options.vault.decrypt(connection.apiKeyCiphertext)
      : undefined
    if (apiKey) environment[keyEnvironment] = apiKey
    const catalogModel =
      connection.id === options.agentModel.provider
        ? options.agentModel.model
        : (modelProviderPresets.find(entry => entry.id === connection.id)
            ?.defaultModel ?? options.agentModel.model)
    providers[connection.id] = {
      api:
        connection.protocol === 'anthropic-messages'
          ? 'anthropic-messages'
          : 'openai-completions',
      baseURL: connection.baseUrl,
      ...(apiKey ? { apiKeyEnv: keyEnvironment } : {}),
      models: [{ id: catalogModel, name: catalogModel }],
    }
  }
  const directory = mkdtempSync(join(tmpdir(), 'pegas-dsh-config-'))
  const patchPath = join(directory, 'model-configuration.json')
  writeFileSync(
    patchPath,
    JSON.stringify([
      { id: 'llm-pi-ai', config: { providers } },
      {
        id: 'agent-default-model',
        config: {
          provider: options.agentModel.provider,
          model: options.agentModel.model,
        },
      },
    ]),
    { mode: 0o600 },
  )
  return {
    patchPath,
    environment,
    remove: () => rmSync(directory, { recursive: true, force: true }),
  }
}

export function modelKeyEnvironmentName(provider: string): string {
  const normalized = provider.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')
  return `PEGAS_DSH_MODEL_KEY_${normalized}`
}
