import {
  discoverModelCatalog,
  type ModelCatalogConnection,
  type ModelCatalogItem,
} from '../model/model-catalog.js'
import type { ModelCredentialVault } from '../model/model-credential-vault.js'
import type { ModelProviderConnection } from './runtime-settings.js'

export async function discoverConnectionCatalogs(
  connections: readonly ModelProviderConnection[],
  vault: Pick<ModelCredentialVault, 'decrypt'>,
  options: {
    timeoutMs: number
    discover?: (
      connection: ModelCatalogConnection,
    ) => Promise<ModelCatalogItem[]>
  },
): Promise<Record<string, ModelCatalogItem[]>> {
  const discover: (
    connection: ModelCatalogConnection,
  ) => Promise<ModelCatalogItem[]> = options.discover ?? discoverModelCatalog
  const entries = await Promise.all(
    connections.map(async connection => {
      try {
        const apiKey = connection.apiKeyCiphertext
          ? vault.decrypt(connection.apiKeyCiphertext)
          : undefined
        const models = await discover({
          protocol: connection.protocol,
          baseUrl: connection.baseUrl,
          ...(apiKey ? { apiKey } : {}),
          timeoutMs: options.timeoutMs,
        })
        return [connection.id, models] as const
      } catch {
        return [connection.id, [] as ModelCatalogItem[]] as const
      }
    }),
  )
  const catalogs: Record<string, ModelCatalogItem[]> = {}
  for (const [id, models] of entries) catalogs[id] = models
  return catalogs
}
