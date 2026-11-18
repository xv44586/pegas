import type { ModelProviderProtocol } from './provider-catalog.js'
import type { JsonModelProvider } from './provider.js'

export interface ModelCatalogConnection {
  protocol: ModelProviderProtocol
  baseUrl: string
  apiKey?: string
  timeoutMs?: number
}

export interface ModelCatalogItem {
  id: string
  name: string
}

type Fetcher = (input: URL, init: RequestInit) => Promise<Response>

export async function discoverModelCatalog(
  connection: ModelCatalogConnection,
  fetcher: Fetcher = fetch,
): Promise<ModelCatalogItem[]> {
  const anthropic = connection.protocol === 'anthropic-messages'
  const endpoint = new URL(
    anthropic ? 'v1/models' : 'models',
    `${connection.baseUrl.replace(/\/+$/, '')}/`,
  )
  const response = await fetcher(endpoint, {
    method: 'GET',
    headers: anthropic
      ? {
          ...(connection.apiKey ? { 'x-api-key': connection.apiKey } : {}),
          'anthropic-version': '2023-06-01',
        }
      : {
          ...(connection.apiKey
            ? { authorization: `Bearer ${connection.apiKey}` }
            : {}),
        },
    signal: AbortSignal.timeout(connection.timeoutMs ?? 15_000),
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2048)
    throw new Error(
      `模型目录返回 ${String(response.status)}${detail ? `: ${detail}` : ''}`,
    )
  }
  const body: unknown = await response.json()
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error('模型目录返回了无效响应')
  }
  const byId = new Map<string, ModelCatalogItem>()
  for (const candidate of body.data.slice(0, 1000)) {
    if (!isRecord(candidate)) continue
    const id = normalizedString(candidate.id, 240)
    if (!id) continue
    const name =
      normalizedString(candidate.display_name, 240) ??
      normalizedString(candidate.name, 240) ??
      id
    const existing = byId.get(id)
    if (!existing || existing.name === id) byId.set(id, { id, name })
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function testModelConnection(
  provider: JsonModelProvider,
  now: () => number = performance.now.bind(performance),
): Promise<{ ok: true; latencyMs: number }> {
  const startedAt = now()
  const result = await provider.generateJson({
    system: 'Return the requested connectivity result as JSON.',
    input: 'Return {"ok":true} to confirm connectivity.',
    schema: {
      type: 'object',
      properties: { ok: { const: true } },
      required: ['ok'],
      additionalProperties: false,
    },
  })
  if (!isRecord(result) || result.ok !== true) {
    throw new Error('模型测试返回了无效结果')
  }
  return { ok: true, latencyMs: Math.max(0, Math.round(now() - startedAt)) }
}

function normalizedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) return undefined
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
