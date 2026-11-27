import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { runtimePrivateRoot } from './runtime-private-root.js'
import { join } from 'node:path'

import type { ModelCredentialVault } from '../model/model-credential-vault.js'
import type { ModelCatalogItem } from '../model/model-catalog.js'
import { modelProviderPreset } from '../model/provider-catalog.js'
import type { ModelProviderConnection } from '../settings/runtime-settings.js'

// Pi AI requires a nonempty string even for gateways that allow anonymous
// requests. This value is public and is only supplied for optional-key routes.
const anonymousDshApiKey = 'pegas-anonymous'

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

/**
 * EXEC-006 P2a: the selected agent model declares image input so DSH's
 * read_image capability gate reflects the gateway's actual multimodal
 * routing. Pegas connections are OpenAI-compatible gateways whose models
 * accept image parts; without this declaration the installed DSH catalog
 * defaults to text-only and read_image fails before touching the file.
 */
export function createDshModelConfiguration(options: {
  connections: readonly ModelProviderConnection[]
  vault: Pick<ModelCredentialVault, 'decrypt'>
  agentModel: DshAgentModel
  modelCatalog?: Readonly<Record<string, readonly ModelCatalogItem[]>>
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
    const preset = modelProviderPreset(connection.id)
    const apiKey = connection.apiKeyCiphertext
      ? options.vault.decrypt(connection.apiKeyCiphertext)
      : undefined
    if (apiKey) environment[keyEnvironment] = apiKey
    else if (preset?.requiresApiKey === false)
      environment[keyEnvironment] = anonymousDshApiKey
    const catalogModel =
      connection.id === options.agentModel.provider
        ? options.agentModel.model
        : (preset?.defaultModel ?? options.agentModel.model)
    const isSelectedProvider = connection.id === options.agentModel.provider
    const discovered = options.modelCatalog?.[connection.id] ?? []
    const models: { id: string; name: string; input?: string[] }[] = []
    const seen = new Set<string>()
    const pushModel = (id: string, name: string) => {
      if (seen.has(id)) return
      seen.add(id)
      models.push({
        id,
        name,
        ...(isSelectedProvider && id === options.agentModel.model
          ? { input: ['text', 'image'] }
          : {}),
      })
    }
    if (isSelectedProvider) {
      pushModel(
        catalogModel,
        discovered.find(item => item.id === catalogModel)?.name ?? catalogModel,
      )
    }
    for (const item of discovered) pushModel(item.id, item.name)
    if (!models.length) pushModel(catalogModel, catalogModel)
    providers[connection.id] = {
      api:
        connection.protocol === 'anthropic-messages'
          ? 'anthropic-messages'
          : 'openai-completions',
      baseURL: connection.baseUrl,
      // A missing required key must fail through this scoped reference.
      // Omitting it would allow an unrelated ambient provider key.
      apiKeyEnv: keyEnvironment,
      models,
    }
  }
  const directory = mkdtempSync(join(runtimePrivateRoot(), 'pegas-dsh-config-'))
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
