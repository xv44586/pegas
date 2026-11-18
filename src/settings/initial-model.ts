import type { PegasConfig } from '../core/config.js'
import {
  discoverModelCatalog,
  type ModelCatalogConnection,
  type ModelCatalogItem,
} from '../model/model-catalog.js'
import { modelProviderPreset } from '../model/provider-catalog.js'

type DiscoverModels = (
  connection: ModelCatalogConnection,
) => Promise<ModelCatalogItem[]>

export async function resolveInitialModelName(
  config: PegasConfig,
  options: {
    hasRuntimeSettings: boolean
    modelNameExplicit: boolean
    discover?: DiscoverModels
  },
): Promise<string> {
  if (
    options.hasRuntimeSettings ||
    options.modelNameExplicit ||
    config.modelProvider !== 'magpie'
  ) {
    return config.modelName
  }
  const preset = modelProviderPreset(config.modelProvider)
  if (!preset) return config.modelName
  try {
    const models = await (options.discover ?? discoverModelCatalog)({
      protocol: preset.protocol,
      baseUrl: config.modelBaseUrl ?? preset.baseUrl,
      ...(config.modelApiKey ? { apiKey: config.modelApiKey } : {}),
      timeoutMs: 2_000,
    })
    return models[0]?.id ?? config.modelName
  } catch {
    return config.modelName
  }
}
